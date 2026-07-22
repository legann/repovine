/**
 * Tracked child spawner + liveness probe for integration tests.
 *
 * Replaces external `ps --ppid` scans (Unix-only; absent/incompatible on
 * win32 and BSD ps): tests spawn children through `spawnTracked` and assert
 * liveness through `isAlive` / `livePids`, which use `process.kill(pid, 0)`
 * and work on linux, darwin, and win32 without external tools.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

const tracked = new Set<number>();
const closedChildren = new WeakSet<ChildProcess>();

/** Spawn a child and register its pid until the process is reaped. */
export function spawnTracked(command: string, args: readonly string[] = [], options: SpawnOptions = {}): ChildProcess {
  const child = spawn(command, args, options);
  const pid = child.pid;
  if (typeof pid === 'number') tracked.add(pid);
  child.once('close', () => {
    if (typeof pid === 'number') tracked.delete(pid);
    closedChildren.add(child);
  });
  return child;
}

/** True while the OS still knows the pid. EPERM counts as alive (exists,
 * owned by another user); ESRCH means reaped. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Tracked pids that are still alive. Empty after every child is reaped. */
export function livePids(): number[] {
  return [...tracked].filter(isAlive);
}

/** Resolves when a `spawnTracked` child emits `close` (fully reaped, stdio
 * drained, tracked pid removed). `exit` alone does not resolve it. */
export function onceClosed(child: ChildProcess): Promise<void> {
  if (closedChildren.has(child)) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('close', () => resolve());
  });
}
