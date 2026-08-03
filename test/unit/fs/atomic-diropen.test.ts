import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as os from 'node:os';
import * as path from 'node:path';
import * as realFs from 'node:fs';
import * as realFsPromises from 'node:fs/promises';

// The writer surfaces every directory-open failure of the fsync step, except the narrow Windows-only
// "a directory cannot be opened" policy, which it tolerates. That fsync runs after the rename, so a
// surfaced failure still leaves the new contents in the target; every case below asserts that disk
// state next to the error, which by itself says nothing about what reached the target.
// The fs namespace is frozen (can't jest.spyOn it), so inject the error via a module mock and override
// process.platform (a configurable property) to exercise both sides of the platform gate.
describe('atomic writer directory-open errno', () => {
  let root = '';
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  afterEach(() => {
    jest.unstable_unmockModule('node:fs/promises');
    jest.unstable_unmockModule('node:fs');
    jest.resetModules();
    if (root) realFs.rmSync(root, { recursive: true, force: true });
    root = '';
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform });
  }

  function mockDirOpen(errno: string | null): void {
    root = realFs.mkdtempSync(path.join(os.tmpdir(), 'atomic-diropen-'));
    jest.resetModules();
    // The directory fsync opens the parent dir read-only (`open(root, 'r')`); inject there and pass every
    // other open (the temp-file write) through to the real implementation. `errno: null` injects an
    // exception WITHOUT a `code` (fail-closed must rethrow it too).
    const injected = (p: unknown, flags: unknown): NodeJS.ErrnoException | null => {
      if (String(p) === root && flags === 'r') {
        const err = new Error(`injected ${errno ?? 'codeless failure'}`) as NodeJS.ErrnoException;
        if (errno !== null) err.code = errno;
        return err;
      }
      return null;
    };
    jest.unstable_mockModule('node:fs/promises', () => ({
      ...realFsPromises,
      open: async (p: unknown, flags: unknown, ...rest: unknown[]) => {
        const e = injected(p, flags);
        if (e) throw e;
        return (realFsPromises.open as (...a: unknown[]) => unknown)(p, flags, ...rest);
      },
    }));
    jest.unstable_mockModule('node:fs', () => ({
      ...realFs,
      openSync: (p: unknown, flags: unknown, ...rest: unknown[]) => {
        const e = injected(p, flags);
        if (e) throw e;
        return (realFs.openSync as (...a: unknown[]) => number)(p, flags, ...rest);
      },
    }));
  }

  type WriterKind = 'async' | 'sync';

  async function expectOpenFailure(kind: WriterKind, errno: string | null): Promise<void> {
    mockDirOpen(errno);
    const atomic = await import('../../../src/fs/atomic.js');
    const target = path.join(root, 'out.json');
    if (kind === 'async') {
      await expect(atomic.writeFileAtomic(target, 'data')).rejects.toThrow(errno ?? 'codeless failure');
    } else {
      expect(() => atomic.writeFileAtomicSync(target, 'data')).toThrow(errno ?? 'codeless failure');
    }
    // The rename happens before the directory fsync, so the write the caller saw fail is on disk.
    expect(realFs.readFileSync(target, 'utf-8')).toBe('data');
  }

  async function expectOpenUnsupported(kind: WriterKind, errno: string): Promise<void> {
    mockDirOpen(errno);
    const atomic = await import('../../../src/fs/atomic.js');
    const target = path.join(root, 'out.json');
    if (kind === 'async') {
      await expect(atomic.writeFileAtomic(target, 'data')).resolves.toBeUndefined();
    } else {
      expect(() => atomic.writeFileAtomicSync(target, 'data')).not.toThrow();
    }
    expect(realFs.readFileSync(target, 'utf-8')).toBe('data');
  }

  describe.each<WriterKind>(['async', 'sync'])('%s writer', kind => {
    describe.each<NodeJS.Platform>(['linux', 'win32'])('%s fail-closed cases', platform => {
      it.each(['EIO', 'EMFILE', 'EACCES', 'EINVAL', 'EWHATEVER'])('surfaces %s', async errno => {
        setPlatform(platform);
        await expectOpenFailure(kind, errno);
      });

      it('surfaces an exception without an errno code', async () => {
        setPlatform(platform);
        await expectOpenFailure(kind, null);
      });
    });

    it.each(['EISDIR', 'EPERM'])('surfaces %s on Linux even though Windows tolerates it', async errno => {
      setPlatform('linux');
      await expectOpenFailure(kind, errno);
    });

    it.each(['EISDIR', 'EPERM'])('tolerates Windows directory-open limitation %s', async errno => {
      setPlatform('win32');
      await expectOpenUnsupported(kind, errno);
    });
  });
});
