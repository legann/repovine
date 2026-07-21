import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 50;
const LOCK_MAX_WAIT_MS = 5_000;

export class AnnotationFileLockTimeoutError extends Error {
  readonly code = 'ANNOTATION_FILE_LOCK_TIMEOUT';

  constructor(readonly lockPath: string) {
    super(`Timed out after ${LOCK_MAX_WAIT_MS}ms waiting for annotation file lock: ${lockPath}`);
    this.name = 'AnnotationFileLockTimeoutError';
  }
}

export function lockPathForAnnotationFile(filePath: string): string {
  return `${filePath}.lock`;
}

function takeoverTempPath(lockPath: string, token: string): string {
  return `${lockPath}.${process.pid}.${token}.tmp`;
}

function takeoverClaimPath(lockPath: string): string {
  // A fixed O_EXCL claim serializes stale replacements. Claims are reclaimed only after they are
  // themselves stale and their recorded pid is no longer alive.
  return `${lockPath}.takeover`;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

function ownerPid(content: string): number | undefined {
  const match = /^(\d+)(?::|$)/.exec(content.trim());
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function processIsAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still proves that the process exists; only ESRCH/invalid pids are reclaimable.
    return isErrno(error, 'EPERM');
  }
}

function lockOwnerIsAliveSync(lockPath: string): boolean {
  return processIsAlive(ownerPid(fs.readFileSync(lockPath, 'utf-8')));
}

async function lockOwnerIsAliveAsync(lockPath: string): Promise<boolean> {
  return processIsAlive(ownerPid(await fsPromises.readFile(lockPath, 'utf-8')));
}

function removeOwnedFileSync(filePath: string, expectedContent: string): void {
  try {
    if (fs.readFileSync(filePath, 'utf-8') === expectedContent) fs.unlinkSync(filePath);
  } catch {
    // Best-effort ownership-checked cleanup.
  }
}

async function removeOwnedFileAsync(filePath: string, expectedContent: string): Promise<void> {
  try {
    if (await fsPromises.readFile(filePath, 'utf-8') === expectedContent) await fsPromises.unlink(filePath);
  } catch {
    // Best-effort ownership-checked cleanup.
  }
}

function reclaimOrphanedTakeoverClaimSync(claimPath: string): boolean {
  try {
    const stat = fs.statSync(claimPath);
    if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return false;
    const content = fs.readFileSync(claimPath, 'utf-8');
    if (processIsAlive(ownerPid(content))) return false;
    removeOwnedFileSync(claimPath, content);
    return !fs.existsSync(claimPath);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return true;
    throw error;
  }
}

async function reclaimOrphanedTakeoverClaimAsync(claimPath: string): Promise<boolean> {
  try {
    const stat = await fsPromises.stat(claimPath);
    if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return false;
    const content = await fsPromises.readFile(claimPath, 'utf-8');
    if (processIsAlive(ownerPid(content))) return false;
    await removeOwnedFileAsync(claimPath, content);
    try {
      await fsPromises.access(claimPath);
      return false;
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return true;
      throw error;
    }
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return true;
    throw error;
  }
}

function tryTakeOverStaleLockSync(lockPath: string): boolean {
  const owner = String(process.pid);
  const token = randomUUID();
  const tempPath = takeoverTempPath(lockPath, token);
  const claimPath = takeoverClaimPath(lockPath);
  const claimContent = `${owner}:${token}`;
  let ownsClaim = false;
  try {
    fs.writeFileSync(tempPath, owner, { flag: 'wx' });
    try {
      fs.writeFileSync(claimPath, claimContent, { flag: 'wx' });
      ownsClaim = true;
    } catch (error) {
      if (isErrno(error, 'EEXIST')) {
        reclaimOrphanedTakeoverClaimSync(claimPath);
        return false;
      }
      throw error;
    }

    const current = fs.statSync(lockPath);
    if (Date.now() - current.mtimeMs <= LOCK_STALE_MS) return false;
    if (lockOwnerIsAliveSync(lockPath)) return false;
    if (fs.readFileSync(claimPath, 'utf-8') !== claimContent) return false;
    fs.renameSync(tempPath, lockPath);
    return fs.readFileSync(claimPath, 'utf-8') === claimContent
      && fs.readFileSync(lockPath, 'utf-8') === owner;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  } finally {
    if (ownsClaim) removeOwnedFileSync(claimPath, claimContent);
    removeOwnedFileSync(tempPath, owner);
  }
}

async function tryTakeOverStaleLockAsync(lockPath: string): Promise<boolean> {
  const owner = String(process.pid);
  const token = randomUUID();
  const tempPath = takeoverTempPath(lockPath, token);
  const claimPath = takeoverClaimPath(lockPath);
  const claimContent = `${owner}:${token}`;
  let ownsClaim = false;
  try {
    await fsPromises.writeFile(tempPath, owner, { flag: 'wx' });
    try {
      await fsPromises.writeFile(claimPath, claimContent, { flag: 'wx' });
      ownsClaim = true;
    } catch (error) {
      if (isErrno(error, 'EEXIST')) {
        await reclaimOrphanedTakeoverClaimAsync(claimPath);
        return false;
      }
      throw error;
    }

    const current = await fsPromises.stat(lockPath);
    if (Date.now() - current.mtimeMs <= LOCK_STALE_MS) return false;
    if (await lockOwnerIsAliveAsync(lockPath)) return false;
    if (await fsPromises.readFile(claimPath, 'utf-8') !== claimContent) return false;
    await fsPromises.rename(tempPath, lockPath);
    return await fsPromises.readFile(claimPath, 'utf-8') === claimContent
      && await fsPromises.readFile(lockPath, 'utf-8') === owner;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  } finally {
    if (ownsClaim) await removeOwnedFileAsync(claimPath, claimContent);
    await removeOwnedFileAsync(tempPath, owner);
  }
}

function acquireLockSync(lockPath: string): void {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          if (!lockOwnerIsAliveSync(lockPath) && tryTakeOverStaleLockSync(lockPath)) return;
        }
      } catch (error) {
        if (isErrno(error, 'ENOENT')) continue;
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new AnnotationFileLockTimeoutError(lockPath);
      }
      const wait = Math.min(LOCK_RETRY_MS, deadline - Date.now());
      if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
}

async function acquireLockAsync(lockPath: string): Promise<void> {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      await fsPromises.writeFile(lockPath, String(process.pid), { flag: 'wx' });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        const stat = await fsPromises.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          if (!(await lockOwnerIsAliveAsync(lockPath)) && await tryTakeOverStaleLockAsync(lockPath)) return;
        }
      } catch (error) {
        if (isErrno(error, 'ENOENT')) continue;
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new AnnotationFileLockTimeoutError(lockPath);
      }
      const wait = Math.min(LOCK_RETRY_MS, deadline - Date.now());
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
    }
  }
}

function releaseLock(lockPath: string): void {
  removeOwnedFileSync(lockPath, String(process.pid));
}

export function withAnnotationFileLockSync<T>(filePath: string, fn: () => T): T {
  const lockPath = lockPathForAnnotationFile(filePath);
  acquireLockSync(lockPath);
  try {
    return fn();
  } finally {
    releaseLock(lockPath);
  }
}

export async function withAnnotationFileLockAsync<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = lockPathForAnnotationFile(filePath);
  await acquireLockAsync(lockPath);
  try {
    return await fn();
  } finally {
    releaseLock(lockPath);
  }
}
