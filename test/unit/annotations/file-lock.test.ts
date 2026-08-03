import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { jest } from '@jest/globals';
import {
  AnnotationFileLockTimeoutError,
  LOCK_MAX_WAIT_MS,
  LOCK_STALE_MS,
  lockPathForAnnotationFile,
  withAnnotationFileLockAsync,
  withAnnotationFileLockSync,
} from '../../../src/annotations/file-lock.js';

describe('annotation file lock ownership', () => {
  let tmpDir: string;
  let filePath: string;
  let lockPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'annotation-file-lock-'));
    filePath = path.join(tmpDir, 'repovine.annots.json');
    lockPath = lockPathForAnnotationFile(filePath);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function forceDeadlineAfterFreshnessCheck(): void {
    const startedAt = fs.statSync(lockPath).mtimeMs;
    jest.spyOn(Date, 'now')
      .mockReturnValueOnce(startedAt)
      .mockReturnValueOnce(startedAt)
      .mockReturnValue(startedAt + LOCK_MAX_WAIT_MS);
  }

  function takeoverArtifacts(): string[] {
    const prefix = path.basename(lockPath);
    return fs.readdirSync(tmpDir).filter(name => (
      name.startsWith(`${prefix}.`) && (name.endsWith('.tmp') || name.endsWith('.takeover'))
    ));
  }

  it('sync contention throws without entering unlocked or deleting a foreign live lock', () => {
    const foreignOwner = '987654321';
    fs.writeFileSync(lockPath, foreignOwner);
    forceDeadlineAfterFreshnessCheck();
    const criticalSection = jest.fn();

    expect(() => withAnnotationFileLockSync(filePath, criticalSection))
      .toThrow(AnnotationFileLockTimeoutError);

    expect(criticalSection).not.toHaveBeenCalled();
    expect(fs.readFileSync(lockPath, 'utf-8')).toBe(foreignOwner);
  });

  it('async contention rejects without entering unlocked or deleting a foreign live lock', async () => {
    const foreignOwner = '987654322';
    fs.writeFileSync(lockPath, foreignOwner);
    forceDeadlineAfterFreshnessCheck();
    const criticalSection = jest.fn(async () => undefined);

    await expect(withAnnotationFileLockAsync(filePath, criticalSection))
      .rejects.toBeInstanceOf(AnnotationFileLockTimeoutError);

    expect(criticalSection).not.toHaveBeenCalled();
    expect(fs.readFileSync(lockPath, 'utf-8')).toBe(foreignOwner);
  });

  it('outlasts the staleness window, so a dead owner with a fresh lock file is reclaimed', () => {
    // The regression this pins. A lock is reclaimable only once it is older than LOCK_STALE_MS, and
    // the owner's liveness is read only at that moment — so a deadline shorter than the staleness
    // window made a dead owner with a FRESH mtime time out every caller forever. A fixture tree
    // copied into place produces exactly that file, which is how it reached the MCP refresh suite.
    fs.writeFileSync(lockPath, '987654399'); // a pid no process has
    const startedAt = fs.statSync(lockPath).mtimeMs;

    // Virtual time advances a fixed step per observation, sized so the lock crosses the staleness
    // window on the second attempt. Under the old deadline the loop gave up before that attempt.
    const step = 4_000;
    let clock = startedAt;
    jest.spyOn(Date, 'now').mockImplementation(() => {
      const observed = clock;
      clock += step;
      return observed;
    });

    const criticalSection = jest.fn();
    withAnnotationFileLockSync(filePath, criticalSection);

    expect(criticalSection).toHaveBeenCalledTimes(1);
    expect(takeoverArtifacts()).toEqual([]);
  });

  it('waits longer than a lock takes to go stale', () => {
    // Stated as a relation, not as two numbers: the ordering is what makes reclaim reachable, and
    // two independent literals are what let it drift apart in the first place.
    expect(LOCK_MAX_WAIT_MS).toBeGreaterThan(LOCK_STALE_MS);
  });

  it('release preserves a lock that changed to a foreign owner', () => {
    const foreignOwner = '987654323';

    withAnnotationFileLockSync(filePath, () => {
      expect(fs.readFileSync(lockPath, 'utf-8')).toBe(String(process.pid));
      fs.writeFileSync(lockPath, foreignOwner);
    });

    expect(fs.readFileSync(lockPath, 'utf-8')).toBe(foreignOwner);
  });

  it('takes over a stale lock through the pid temp and cleans the temp file', () => {
    fs.writeFileSync(lockPath, '987654324');
    const staleTime = new Date(Date.now() - 15_000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    withAnnotationFileLockSync(filePath, () => {
      expect(fs.readFileSync(lockPath, 'utf-8')).toBe(String(process.pid));
      expect(takeoverArtifacts()).toEqual([]);
    });

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(takeoverArtifacts()).toEqual([]);
  });

  it('does not take over an old lock while its owning process is still alive', () => {
    const now = Date.now();
    fs.writeFileSync(lockPath, String(process.pid));
    const staleTime = new Date(now - 15_000);
    fs.utimesSync(lockPath, staleTime, staleTime);
    jest.spyOn(Date, 'now')
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(now)
      .mockReturnValue(now + LOCK_MAX_WAIT_MS);
    const criticalSection = jest.fn();

    expect(() => withAnnotationFileLockSync(filePath, criticalSection))
      .toThrow(AnnotationFileLockTimeoutError);

    expect(criticalSection).not.toHaveBeenCalled();
    expect(fs.readFileSync(lockPath, 'utf-8')).toBe(String(process.pid));
  });

  it('takes over a stale lock asynchronously and cleans the temp file', async () => {
    fs.writeFileSync(lockPath, '987654325');
    const staleTime = new Date(Date.now() - 15_000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    // The transaction is synchronous by contract now: the lock is released as soon as it returns, so
    // awaited work inside it would run unlocked. Reading the lock file is the same assertion.
    await withAnnotationFileLockAsync(filePath, () => {
      expect(fs.readFileSync(lockPath, 'utf-8')).toBe(String(process.pid));
      expect(takeoverArtifacts()).toEqual([]);
    });

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(takeoverArtifacts()).toEqual([]);
  });

  it('serializes two stale-lock contenders so only one critical section is active', async () => {
    fs.writeFileSync(lockPath, '987654327');
    const staleTime = new Date(Date.now() - 15_000);
    fs.utimesSync(lockPath, staleTime, staleTime);
    const visits: string[] = [];

    // Mutual exclusion is asserted through the file rather than through a counter. A synchronous
    // transaction cannot observe a second one running inside it — the runtime is single-threaded, so
    // a counter would read 1 whether the lock worked or not. A read-modify-write does carry the
    // property: if both contenders read the same base, one append is lost.
    const contender = async (name: string): Promise<void> => {
      await withAnnotationFileLockAsync(filePath, () => {
        visits.push(name);
        const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
        fs.writeFileSync(filePath, `${current}${name}\n`);
      });
    };

    await Promise.all([contender('first'), contender('second')]);

    expect(visits.sort()).toEqual(['first', 'second']);
    // Both appends survived, so neither contender overwrote the other's base.
    expect(fs.readFileSync(filePath, 'utf-8').trim().split('\n').sort()).toEqual(['first', 'second']);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(takeoverArtifacts()).toEqual([]);
  });

  it('fails closed on a fresh takeover claim without deleting the stale lock', () => {
    const owner = '987654328';
    const claimPath = `${lockPath}.takeover`;
    const now = Date.now();
    fs.writeFileSync(lockPath, owner);
    fs.writeFileSync(claimPath, 'orphaned-claim');
    const staleTime = new Date(now - 15_000);
    fs.utimesSync(lockPath, staleTime, staleTime);
    // The case is a claim that is still FRESH when this waiter gives up, so its mtime is placed
    // against the virtual clock rather than the real one: the deadline now outlasts the staleness
    // window, and a claim stamped at real `now` would have aged out of it by then. A stale claim is
    // the next test's case, and it ends the other way.
    const freshWhenTheDeadlineExpires = new Date(now + LOCK_MAX_WAIT_MS - LOCK_STALE_MS + 1_000);
    fs.utimesSync(claimPath, freshWhenTheDeadlineExpires, freshWhenTheDeadlineExpires);
    jest.spyOn(Date, 'now')
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(now)
      .mockReturnValue(now + LOCK_MAX_WAIT_MS);

    expect(() => withAnnotationFileLockSync(filePath, () => undefined))
      .toThrow(AnnotationFileLockTimeoutError);

    expect(fs.readFileSync(lockPath, 'utf-8')).toBe(owner);
    expect(fs.readFileSync(claimPath, 'utf-8')).toBe('orphaned-claim');
    expect(fs.readdirSync(tmpDir).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('reclaims a stale takeover claim whose owner is no longer alive', () => {
    const owner = '987654329';
    const claimPath = `${lockPath}.takeover`;
    fs.writeFileSync(lockPath, owner);
    fs.writeFileSync(claimPath, `${owner}:orphaned-token`);
    const staleTime = new Date(Date.now() - 15_000);
    fs.utimesSync(lockPath, staleTime, staleTime);
    fs.utimesSync(claimPath, staleTime, staleTime);

    withAnnotationFileLockSync(filePath, () => {
      expect(fs.readFileSync(lockPath, 'utf-8')).toBe(String(process.pid));
    });

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(claimPath)).toBe(false);
    expect(takeoverArtifacts()).toEqual([]);
  });
});
