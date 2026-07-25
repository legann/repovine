import { jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { writeFileAtomic, writeFileAtomicSync, writeJsonObjectStreamed } from '../../../src/fs/atomic.js';

function tempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `repovine-${label}-`));
}

function strayTempEntries(dir: string): string[] {
  return fs.readdirSync(dir).filter(name => name.includes('.tmp.'));
}

describe('writeFileAtomic', () => {
  it('creates missing parent directories and writes the content', async () => {
    const root = tempDir('atomic');
    const target = path.join(root, 'nested', 'deep', 'out.json');
    await writeFileAtomic(target, '{"a":1}');
    expect(fs.readFileSync(target, 'utf-8')).toBe('{"a":1}');
  });

  it('overwrites an existing file and leaves no temp file behind', async () => {
    const root = tempDir('atomic');
    const target = path.join(root, 'out.json');
    fs.writeFileSync(target, 'OLD');
    await writeFileAtomic(target, 'NEW');
    expect(fs.readFileSync(target, 'utf-8')).toBe('NEW');
    expect(strayTempEntries(root)).toEqual([]);
  });

  it('uses distinct temp files for concurrent writes to the same target', async () => {
    const root = tempDir('atomic-concurrent');
    const target = path.join(root, 'out.json');
    const payloads = Array.from({ length: 8 }, (_, i) => `${i}:${'x'.repeat(1024 + i)}`);

    await Promise.all(payloads.map(payload => writeFileAtomic(target, payload)));

    expect(payloads).toContain(fs.readFileSync(target, 'utf-8'));
    expect(strayTempEntries(root)).toEqual([]);
  });

  it('removes the temp file and preserves the target when the rename fails', async () => {
    const root = tempDir('atomic');
    // Target is an existing directory: renaming a file over it fails, exercising the catch path.
    const target = path.join(root, 'occupied');
    fs.mkdirSync(target);
    await expect(writeFileAtomic(target, 'data')).rejects.toBeTruthy();
    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(strayTempEntries(root)).toEqual([]);
  });

  it('writeFileAtomicSync writes and leaves no temp file behind', () => {
    const root = tempDir('atomic');
    const target = path.join(root, 'sub', 'sync.json');
    writeFileAtomicSync(target, 'SYNC');
    expect(fs.readFileSync(target, 'utf-8')).toBe('SYNC');
    expect(strayTempEntries(path.dirname(target))).toEqual([]);
  });

  it('writeFileAtomicSync removes the temp file when the rename fails', () => {
    const root = tempDir('atomic');
    const target = path.join(root, 'occupied');
    fs.mkdirSync(target);
    expect(() => writeFileAtomicSync(target, 'data')).toThrow();
    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(strayTempEntries(root)).toEqual([]);
  });
});

describe('writeJsonObjectStreamed', () => {
  it('reproduces JSON.stringify byte-for-byte with an array field in the middle', async () => {
    const target = path.join(tempDir('stream'), 'obj.json');
    const obj = { a: 1, items: [{ x: 1 }, { y: 'two' }, { z: [3, 4] }], b: { nested: true }, c: 'tail' };
    const members = obj.items.map(it => JSON.stringify(it));
    await writeJsonObjectStreamed(target, obj, { key: 'items', kind: 'array', members });
    expect(fs.readFileSync(target, 'utf-8')).toBe(JSON.stringify(obj));
  });

  it('reproduces JSON.stringify byte-for-byte with a record field', async () => {
    const target = path.join(tempDir('stream'), 'obj.json');
    const entries = { foo: { h: 'a' }, bar: { h: 'b' } };
    const members = Object.entries(entries).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`);
    await writeJsonObjectStreamed(
      target,
      { version: 1, entries: undefined, dims: 7 },
      { key: 'entries', kind: 'record', members },
    );
    expect(fs.readFileSync(target, 'utf-8')).toBe(JSON.stringify({ version: 1, entries, dims: 7 }));
  });

  it('emits empty brackets for an empty streamed array and record', async () => {
    const dir = tempDir('stream');
    const arr = path.join(dir, 'arr.json');
    const rec = path.join(dir, 'rec.json');
    await writeJsonObjectStreamed(arr, { a: 1, items: undefined }, { key: 'items', kind: 'array', members: [] });
    await writeJsonObjectStreamed(rec, { a: 1, items: undefined }, { key: 'items', kind: 'record', members: [] });
    expect(fs.readFileSync(arr, 'utf-8')).toBe(JSON.stringify({ a: 1, items: [] }));
    expect(fs.readFileSync(rec, 'utf-8')).toBe(JSON.stringify({ a: 1, items: {} }));
  });

  it('omits non-streamed keys whose value serializes to undefined, like JSON.stringify', async () => {
    const target = path.join(tempDir('stream'), 'obj.json');
    const obj = { a: 1, skip: undefined, items: undefined, b: 2 };
    await writeJsonObjectStreamed(target, obj, { key: 'items', kind: 'array', members: ['1', '2'] });
    expect(fs.readFileSync(target, 'utf-8')).toBe('{"a":1,"items":[1,2],"b":2}');
  });

  it('yields the event loop by flushing each batch through a separate awaited async write', async () => {
    const dir = tempDir('stream');
    const target = path.join(dir, 'big.json');
    // The loop yields via `await handle.write(chunk)` per flushed batch. Spy on FileHandle.prototype.write
    // (an ordinary object method) and count the batches deterministically instead of racing a wall-clock timer.
    const probe = await fsPromises.open(path.join(dir, 'probe'), 'w');
    const proto = Object.getPrototypeOf(probe) as Record<string, (...args: unknown[]) => Promise<unknown>>;
    await probe.close();
    const writeSpy = jest.spyOn(proto, 'write');
    const members = (function* () {
      for (let i = 0; i < 8000; i++) yield JSON.stringify({ i, pad: 'x'.repeat(40) });
    })();
    try {
      await writeJsonObjectStreamed(target, { items: undefined }, { key: 'items', kind: 'array', members }, { batchBytes: 2048 });
      // ~480 KB of members flushed at a 2 KB batch cap → hundreds of awaited writes. Without the
      // in-loop `if (buf.length >= batchBytes) await flush()` the whole document goes out in one write.
      expect(writeSpy.mock.calls.length).toBeGreaterThan(50);
    } finally {
      writeSpy.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(target, 'utf-8')).items).toHaveLength(8000);
  });

  it('removes the temp file when the streamed write cannot rename over the target', async () => {
    const root = tempDir('stream');
    const target = path.join(root, 'occupied');
    fs.mkdirSync(target);
    await expect(
      writeJsonObjectStreamed(target, { items: undefined }, { key: 'items', kind: 'array', members: ['1'] }),
    ).rejects.toBeTruthy();
    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(strayTempEntries(root)).toEqual([]);
  });

  it('returns the number of bytes written', async () => {
    const target = path.join(tempDir('stream'), 'obj.json');
    const bytes = await writeJsonObjectStreamed(
      target,
      { a: 1, items: undefined },
      { key: 'items', kind: 'array', members: ['1', '2', '3'] },
    );
    expect(bytes).toBe(fs.statSync(target).size);
  });

  it('completes a short write instead of publishing truncated JSON', async () => {
    // write(2) may persist fewer bytes than requested. Inject one short write on the flush and
    // assert the rename still publishes the whole document. Red without the in-loop retry.
    const dir = tempDir('short-write');
    const probe = await fsPromises.open(path.join(dir, 'probe'), 'w');
    const proto = Object.getPrototypeOf(probe) as Record<string, (...args: unknown[]) => Promise<{ bytesWritten: number }>>;
    await probe.close();
    const realWrite = proto.write;
    let shorted = false;
    const writeSpy = jest.spyOn(proto, 'write').mockImplementation(async function (this: unknown, data: unknown, offset?: unknown, length?: unknown, position?: unknown) {
      if (!shorted && Buffer.isBuffer(data)) {
        shorted = true;
        const off = typeof offset === 'number' ? offset : 0;
        const len = typeof length === 'number' ? length : data.length - off;
        const half = Math.max(1, Math.floor(len / 2));
        return realWrite.call(this, data, off, half, position); // persist half, report the short count
      }
      if (!shorted && typeof data === 'string') {
        shorted = true; // pre-fix code path passed a string — short it too so a regression is caught
        const half = Math.max(1, Math.floor(data.length / 2));
        return realWrite.call(this, data.slice(0, half));
      }
      return realWrite.call(this, data, offset, length, position);
    });
    try {
      const target = path.join(dir, 'out.json');
      const members = Array.from({ length: 200 }, (_, i) => JSON.stringify({ i, pad: 'y'.repeat(20) }));
      await writeJsonObjectStreamed(target, { items: undefined }, { key: 'items', kind: 'array', members });
      expect(shorted).toBe(true); // the injection actually fired
      expect(JSON.parse(fs.readFileSync(target, 'utf-8')).items).toHaveLength(200);
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe('fsync durability (P3)', () => {
  // Spy on FileHandle.prototype.sync (an ordinary object method, unlike the frozen fs namespace).
  // Both helpers fsync the temp file before rename and the parent directory after — two sync() calls.
  // The prototype is shared process-wide and Jest runs several test files per worker, so a sync()
  // leaked from another test's still-open handle can be observed on this spy too; the count assertions
  // below check "at least two" rather than an exact total to stay immune to that.
  async function spyOnFileHandleSync(dir: string) {
    const probe = await fsPromises.open(path.join(dir, 'probe'), 'w');
    const proto = Object.getPrototypeOf(probe) as Record<string, (this: unknown) => Promise<void>>;
    await probe.close();
    const realSync = proto.sync;
    // TEMP DIAGNOSTIC (remove after locating the leaker): log where each sync() originates during the
    // durability tests. A [SYNC] line whose stack is the writer runs through writeJsonObjectStreamed /
    // writeFileAtomic in fs/atomic.ts; any other origin is a sync leaked from another test in the same
    // Jest worker — that stack names the leaker.
    return jest.spyOn(proto, 'sync').mockImplementation(function (this: unknown): Promise<void> {
      const state = (expect as unknown as { getState(): { currentTestName?: string } }).getState();
      const frames = (new Error().stack ?? '').split('\n').slice(1, 12)
        .map(f => f.trim()).filter(f => !/node:internal|node_modules[\\/]/.test(f));
      process.stderr.write(`[SYNC] test=${JSON.stringify(state.currentTestName ?? '')}  ${frames.join('  <-  ')}\n`);
      return realSync.call(this);
    });
  }

  it('writeFileAtomic fsyncs the file then the directory', async () => {
    const dir = tempDir('fsync');
    const syncSpy = await spyOnFileHandleSync(dir);
    try {
      await writeFileAtomic(path.join(dir, 'out.json'), 'data');
      expect(syncSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('writeJsonObjectStreamed fsyncs the file then the directory', async () => {
    const dir = tempDir('fsync');
    const syncSpy = await spyOnFileHandleSync(dir);
    try {
      await writeJsonObjectStreamed(
        path.join(dir, 'out.json'),
        { items: undefined },
        { key: 'items', kind: 'array', members: ['1', '2'] },
      );
      expect(syncSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      syncSpy.mockRestore();
    }
  });

  // The directory fsync (2nd sync call) is best-effort for "unsupported on this platform" but must
  // not swallow a real disk error, or the writer silently breaks its durability promise.
  function injectDirSyncError(syncSpy: ReturnType<typeof jest.spyOn>, code: string): void {
    let call = 0;
    (syncSpy as unknown as { mockImplementation: (fn: () => Promise<void>) => void }).mockImplementation(async () => {
      call++;
      if (call >= 2) {
        const err = new Error(`simulated directory fsync ${code}`) as NodeJS.ErrnoException;
        err.code = code;
        throw err;
      }
      // 1st call = temp-file fsync: no-op resolve (content is already written by handle.write).
    });
  }

  it('surfaces a real directory-fsync error (EIO) instead of swallowing it', async () => {
    const dir = tempDir('fsync-eio');
    const syncSpy = await spyOnFileHandleSync(dir);
    injectDirSyncError(syncSpy, 'EIO');
    try {
      await expect(writeFileAtomic(path.join(dir, 'out.json'), 'data')).rejects.toMatchObject({ code: 'EIO' });
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('tolerates a not-supported directory-fsync errno (EINVAL)', async () => {
    const dir = tempDir('fsync-einval');
    const syncSpy = await spyOnFileHandleSync(dir);
    injectDirSyncError(syncSpy, 'EINVAL');
    try {
      const target = path.join(dir, 'out.json');
      await expect(writeFileAtomic(target, 'data')).resolves.toBeUndefined();
      expect(fs.readFileSync(target, 'utf-8')).toBe('data');
    } finally {
      syncSpy.mockRestore();
    }
  });
});
