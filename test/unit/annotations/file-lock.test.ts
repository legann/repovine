import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { jest } from '@jest/globals';
import {
  AnnotationFileLockTimeoutError,
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
      .mockReturnValue(startedAt + 5_000);
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
      .mockReturnValue(now + 5_000);
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

    await withAnnotationFileLockAsync(filePath, async () => {
      expect(await fs.promises.readFile(lockPath, 'utf-8')).toBe(String(process.pid));
      expect(takeoverArtifacts()).toEqual([]);
    });

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(takeoverArtifacts()).toEqual([]);
  });

  it('serializes two stale-lock contenders so only one critical section is active', async () => {
    fs.writeFileSync(lockPath, '987654327');
    const staleTime = new Date(Date.now() - 15_000);
    fs.utimesSync(lockPath, staleTime, staleTime);
    let active = 0;
    let maxActive = 0;
    const visits: string[] = [];

    const contender = async (name: string): Promise<void> => {
      await withAnnotationFileLockAsync(filePath, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        visits.push(name);
        await new Promise(resolve => setTimeout(resolve, 40));
        active--;
      });
    };

    await Promise.all([contender('first'), contender('second')]);

    expect(visits.sort()).toEqual(['first', 'second']);
    expect(maxActive).toBe(1);
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
    jest.spyOn(Date, 'now')
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(now)
      .mockReturnValue(now + 5_000);

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
