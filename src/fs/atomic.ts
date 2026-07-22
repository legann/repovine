import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Crash-atomic, power-loss-durable file write. Writes to a pid-scoped temp file in the destination
 * directory, fsyncs it, then renames it over the target and fsyncs the parent directory. A concurrent
 * reader sees either the old file or the new file, never a truncated one (rename atomicity); after the
 * call resolves the new contents and the directory entry survive a power loss (the fsync pair). The
 * temp and the target share a directory (same filesystem) so the rename is atomic. On any failure the
 * temp is removed and the original target is left untouched.
 */
function tempPathFor(filePath: string): string {
  return `${filePath}.tmp.${process.pid}.${randomUUID()}`;
}

/**
 * Directory-fsync errnos tolerated as "not supported on this platform". A directory that opened but
 * whose fsync fails with a real durability error (EIO, ENOSPC, EROFS, ...) must surface — the writer
 * promises power-loss durability. Windows, where opening a directory fails outright, is handled
 * separately by tolerating the open() failure.
 */
const DIR_FSYNC_UNSUPPORTED = new Set(['EISDIR', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS']);

/**
 * Windows does not support opening a directory as the fd used for directory fsync. Node has surfaced
 * that limitation as EISDIR or EPERM across supported Windows versions. Keep this list deliberately
 * narrow and platform-gated: on POSIX the same errno is a real failure, while EINVAL/ENOTSUP/ENOSYS
 * are not evidence that this specific operation is unsupported.
 */
const WINDOWS_DIR_OPEN_UNSUPPORTED = new Set(['EISDIR', 'EPERM']);

function isUnsupportedDirectoryOpen(code: string | undefined): boolean {
  return process.platform === 'win32' && code !== undefined && WINDOWS_DIR_OPEN_UNSUPPORTED.has(code);
}

/** fsync a directory so a rename inside it survives power loss. A failed open() is tolerated only for
 * platforms that cannot open a directory (Windows-like allowlist); a not-supported fsync errno is
 * tolerated too. Any other open/fsync error is rethrown — fail-closed for durability. */
async function fsyncDir(dir: string): Promise<void> {
  let handle: fsPromises.FileHandle;
  try {
    handle = await fsPromises.open(dir, 'r');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!isUnsupportedDirectoryOpen(code)) throw err;
    return; // Windows cannot open a directory for fsync — best-effort, skip.
  }
  try {
    await handle.sync();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!code || !DIR_FSYNC_UNSUPPORTED.has(code)) throw err;
    // directory fsync reported "not supported" on this platform — tolerate.
  } finally {
    await handle.close().catch(() => {});
  }
}

function fsyncDirSync(dir: string): void {
  let dfd: number;
  try {
    dfd = fs.openSync(dir, 'r');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!isUnsupportedDirectoryOpen(code)) throw err;
    return; // Windows cannot open a directory for fsync — best-effort, skip.
  }
  try {
    fs.fsyncSync(dfd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!code || !DIR_FSYNC_UNSUPPORTED.has(code)) throw err;
    // directory fsync reported "not supported" on this platform — tolerate.
  } finally {
    try {
      fs.closeSync(dfd);
    } catch {
      // ignore close error
    }
  }
}

// Transient win32 replace-rename failures: NTFS rejects a rename onto a target
// another handle briefly holds (AV/indexer scan, a concurrent replace of the
// same file) with EPERM/EACCES/EBUSY. Bounded retry with linear backoff; the
// codes are confirmed by native CI runs, and EXDEV is deliberately absent —
// the temp file lives in the target's directory, so cross-device rename
// cannot occur. On POSIX these codes are real permission errors: no retry.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_ATTEMPTS = 10;
const RENAME_RETRY_STEP_MS = 15;

function isTransientRenameError(err: unknown): boolean {
  return process.platform === 'win32'
    && RENAME_RETRY_CODES.has((err as NodeJS.ErrnoException).code ?? '');
}

async function renameWithRetry(tmpPath: string, filePath: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fsPromises.rename(tmpPath, filePath);
      return;
    } catch (err) {
      if (attempt >= RENAME_RETRY_ATTEMPTS || !isTransientRenameError(err)) throw err;
      await new Promise(resolve => setTimeout(resolve, RENAME_RETRY_STEP_MS * attempt));
    }
  }
}

function renameWithRetrySync(tmpPath: string, filePath: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      if (attempt >= RENAME_RETRY_ATTEMPTS || !isTransientRenameError(err)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_STEP_MS * attempt);
    }
  }
}

export async function writeFileAtomic(filePath: string, data: string | Buffer): Promise<void> {
  const dir = path.dirname(filePath);
  await fsPromises.mkdir(dir, { recursive: true });
  const tmpPath = tempPathFor(filePath);
  let handle: fsPromises.FileHandle | undefined;
  try {
    handle = await fsPromises.open(tmpPath, 'w');
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithRetry(tmpPath, filePath);
    await fsyncDir(dir);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fsPromises.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

/** Synchronous variant for CLI and process-exit paths where the event loop is not a concern. */
export function writeFileAtomicSync(filePath: string, data: string | Buffer): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = tempPathFor(filePath);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    renameWithRetrySync(tmpPath, filePath);
    fsyncDirSync(dir);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close error
      }
    }
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort temp cleanup; surface the original write error
    }
    throw err;
  }
}

export interface StreamedJsonField {
  /** Object key whose large value is streamed in place rather than held as one string. */
  key: string;
  /** Bracketing for the streamed value: 'array' → `[ ]`, 'record' → `{ }` with `"k":v` members. */
  kind: 'array' | 'record';
  /** Pre-serialized members without separators: one array element, or one `"key":value` pair. */
  members: Iterable<string>;
}

/**
 * Write `obj` to `filePath` as JSON, streaming one large field instead of building the whole
 * document as a single string. The output is byte-for-byte `JSON.stringify(obj)` with `field.key`'s
 * value supplied by `field.members`: head/tail keys serialize inline in `Object.keys(obj)` order,
 * and the streamed key keeps its original position. The event loop yields between write batches, so a
 * concurrent tool call or `get_build_status` long-poll progresses while a large artifact persists.
 * Crash-atomic and power-loss-durable via pid-scoped temp + fsync + rename + directory fsync. No
 * single string exceeds `batchBytes`, so V8's ~512 MB string cap never applies. Returns bytes written.
 */
export async function writeJsonObjectStreamed(
  filePath: string,
  obj: object,
  field: StreamedJsonField,
  opts?: { batchBytes?: number },
): Promise<number> {
  const record = obj as Record<string, unknown>;
  const batchBytes = opts?.batchBytes ?? 256 * 1024;
  const dir = path.dirname(filePath);
  await fsPromises.mkdir(dir, { recursive: true });
  const tmpPath = tempPathFor(filePath);
  const handle = await fsPromises.open(tmpPath, 'w');
  let bytesWritten = 0;
  let buf = '';
  let closed = false;
  const flush = async (): Promise<void> => {
    if (!buf) return;
    const chunk = Buffer.from(buf, 'utf8');
    buf = '';
    // write(2) may persist fewer bytes than requested (ENOSPC mid-chunk, interrupted transfer,
    // network/FUSE filesystems); the returned count is authoritative. Loop until the whole chunk
    // lands, or the rename below would publish a truncated file. The no-progress guard bars an
    // infinite loop on a pathological writer.
    let off = 0;
    while (off < chunk.length) {
      const { bytesWritten: n } = await handle.write(chunk, off, chunk.length - off);
      if (n <= 0) throw new Error(`atomic streamed write stalled at ${off}/${chunk.length} bytes`);
      off += n;
    }
    bytesWritten += chunk.length;
  };
  try {
    buf = '{';
    let firstKey = true;
    for (const key of Object.keys(obj)) {
      if (key === field.key) {
        if (!firstKey) buf += ',';
        firstKey = false;
        buf += `${JSON.stringify(key)}:${field.kind === 'array' ? '[' : '{'}`;
        let firstMember = true;
        for (const member of field.members) {
          buf += firstMember ? member : `,${member}`;
          firstMember = false;
          if (buf.length >= batchBytes) await flush();
        }
        buf += field.kind === 'array' ? ']' : '}';
      } else {
        const serialized = JSON.stringify(record[key]);
        if (serialized === undefined) continue; // JSON.stringify drops undefined/function/symbol keys
        if (!firstKey) buf += ',';
        firstKey = false;
        buf += `${JSON.stringify(key)}:${serialized}`;
        if (buf.length >= batchBytes) await flush();
      }
    }
    buf += '}';
    await flush();
    await handle.sync();
    await handle.close();
    closed = true;
    await fsPromises.rename(tmpPath, filePath);
    await fsyncDir(dir);
  } catch (err) {
    if (!closed) await handle.close().catch(() => {});
    await fsPromises.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
  return bytesWritten;
}
