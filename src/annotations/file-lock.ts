import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';

/** How old a lock file must be before its owner may be checked and the lock reclaimed. */
export const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 50;

/**
 * How long a caller waits for the lock before giving up.
 *
 * Strictly longer than {@link LOCK_STALE_MS}, and the ordering is the whole point. A lock becomes
 * reclaimable only once it is older than the staleness window, and the owner's liveness is read only
 * at that moment — so a waiter whose deadline expired first can never reclaim anything. With the
 * shorter deadline a dead owner whose lock file carries a FRESH mtime timed out every caller for as
 * long as the file existed: a fixture tree copied into place, or a process killed between writing
 * the lock and releasing it, both produce exactly that file.
 *
 * The extra margin covers the worst arrival: a waiter that shows up one millisecond after the lock
 * was written still has to sit through the whole staleness window plus a few retries.
 */
export const LOCK_MAX_WAIT_MS = LOCK_STALE_MS + 5_000;

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

function removeOwnedFileSync(filePath: string, expectedContent: string): void {
  try {
    if (fs.readFileSync(filePath, 'utf-8') === expectedContent) fs.unlinkSync(filePath);
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

/** What one acquisition attempt concluded. */
type AttemptOutcome = 'acquired' | 'retry' | 'expired';

/**
 * One attempt to take the lock, made entirely of synchronous syscalls.
 *
 * Being synchronous is the invariant, not an optimization. `fsPromises.writeFile(…, 'wx')` is an
 * open followed by a write, and the step between them resolves on the event loop — so an async
 * acquirer that gets blocked mid-acquisition leaves the lock file **existing and empty**. A waiter
 * then reads no owner pid out of it, concludes the owner is dead, and reclaims a lock that is very
 * much held. That is not a hypothetical: it is what the 10-second stall in this file measured.
 *
 * As one `writeFileSync` the attempt either creates a complete lock file or does not create one.
 * Waiting is the caller's business, and only the waiting differs between the sync and async paths.
 */
function attemptAcquire(lockPath: string, deadline: number): AttemptOutcome {
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return 'acquired';
  } catch (e) {
    if (!isErrno(e, 'EEXIST')) throw e;
  }
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      if (!lockOwnerIsAliveSync(lockPath) && tryTakeOverStaleLockSync(lockPath)) return 'acquired';
    }
  } catch (error) {
    // The holder released between the failed write and the stat: try again immediately.
    if (isErrno(error, 'ENOENT')) return 'retry';
    throw error;
  }
  return Date.now() >= deadline ? 'expired' : 'retry';
}

function retryDelay(deadline: number): number {
  return Math.min(LOCK_RETRY_MS, deadline - Date.now());
}

function acquireLockSync(lockPath: string): void {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    const outcome = attemptAcquire(lockPath, deadline);
    if (outcome === 'acquired') return;
    if (outcome === 'expired') throw new AnnotationFileLockTimeoutError(lockPath);
    const wait = retryDelay(deadline);
    // Blocks the thread, so nothing else in this process runs while a sync caller waits. That is why
    // a holder must never need the event loop to finish and release.
    if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  }
}

function releaseLock(lockPath: string): void {
  removeOwnedFileSync(lockPath, String(process.pid));
}

/**
 * Thrown when a locked transaction returns a promise.
 *
 * Neither wrapper awaits `fn`, so a promise-returning callback would have the lock released while its
 * work was still running — mutual exclusion silently gone, which is worse than the stall this design
 * removed. The check turns that into a named failure at the first call instead of a data race later.
 */
export class AnnotationLockAsyncTransactionError extends Error {
  constructor(lockPath: string) {
    super(
      `Annotation lock transaction for ${lockPath} returned a promise. The critical section must be `
      + 'synchronous: the lock is released as soon as it returns, so awaited work would run unlocked. '
      + 'Do the read/write synchronously (writeFileAtomicSync, readFileSync) inside the lock.',
    );
    this.name = 'AnnotationLockAsyncTransactionError';
  }
}

function assertSyncResult<T>(value: T, lockPath: string): T {
  if (typeof (value as { then?: unknown } | null | undefined)?.then === 'function') {
    throw new AnnotationLockAsyncTransactionError(lockPath);
  }
  return value;
}

export function withAnnotationFileLockSync<T>(filePath: string, fn: () => T): T {
  const lockPath = lockPathForAnnotationFile(filePath);
  acquireLockSync(lockPath);
  try {
    return assertSyncResult(fn(), lockPath);
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Wait for the lock without blocking the event loop, then run a **synchronous** transaction under it.
 *
 * The split is the point, and it is exact: only *waiting* is asynchronous. From the syscall that
 * creates the lock file to the one that removes it there is no suspension point at all, so the lock
 * is never held across a turn of the event loop. Anything less than that leaves a window in which the
 * file exists, no transaction has run, and the owner recorded in it is this very process — a sync
 * caller landing there blocks the only thread, the parked holder cannot resume to release, and the
 * staleness takeover refuses to reclaim a live owner. Both sides then wait out the deadline.
 *
 * `fn` is typed as returning `T` rather than `Promise<T>` so an `async` callback stands out as a
 * promise-valued return; `test/laws/annotation-lock-holds-no-await.test.ts` rejects that shape.
 */
export async function withAnnotationFileLockAsync<T>(filePath: string, fn: () => T): Promise<T> {
  const lockPath = lockPathForAnnotationFile(filePath);
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    // The attempt, the transaction and the release are one synchronous stretch, and the loop is
    // written out here rather than delegated for exactly that reason. `await acquireLockAsync(…)`
    // returned a lock this process already held — the attempt creates the file synchronously — and
    // then yielded a microtask before the transaction. In that window the lock file existed with
    // this process's own pid and no transaction had run. A sync caller landing there blocks the only
    // thread for the whole deadline: the parked holder cannot resume to release, and the staleness
    // takeover refuses to reclaim a lock whose owner is alive. Measured at exactly 15000 ms, which
    // is the stall `context-refresh` reported.
    const outcome = attemptAcquire(lockPath, deadline);
    if (outcome === 'acquired') {
      try {
        return assertSyncResult(fn(), lockPath);
      } finally {
        releaseLock(lockPath);
      }
    }
    if (outcome === 'expired') throw new AnnotationFileLockTimeoutError(lockPath);
    // The one difference from the sync path: a waiter yields instead of blocking. Suspending here is
    // safe because nothing is held — the lock is only ever held by the branch above.
    const wait = retryDelay(deadline);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
}
