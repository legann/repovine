/**
 * Tracked child spawner + liveness probe for integration tests.
 *
 * Replaces external `ps --ppid` scans (GNU-only; absent/incompatible on
 * win32 and BSD ps). Liveness (`isAlive` / `livePids`) uses
 * `process.kill(pid, 0)` — no external tools. `listChildProcesses` uses one
 * adapter per OS: /proc on linux, POSIX `ps` on darwin/BSD, and a registered
 * PowerShell adapter on win32 (allowlisted by the shell-spawn guard).
 */
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';

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

export interface ChildProcessInfo {
  pid: number;
  command: string;
}

/** Direct children of `ppid` with their command lines. Replaces GNU-only
 * `ps --ppid`: /proc on linux, POSIX `ps` on darwin/BSD, a registered
 * PowerShell adapter on win32 (allowlisted by the shell-spawn guard). */
export function listChildProcesses(ppid: number = process.pid): ChildProcessInfo[] {
  if (process.platform === 'linux') {
    const out: ChildProcessInfo[] = [];
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf-8');
        // Format: pid (comm) state ppid ... — comm may contain spaces; parse after the last ')'.
        const close = stat.lastIndexOf(')');
        const parent = Number(stat.slice(close + 2).split(' ')[1]);
        if (parent !== ppid) continue;
        const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf-8').split('\0').join(' ').trim();
        out.push({ pid: Number(entry), command: cmdline || stat.slice(stat.indexOf('(') + 1, close) });
      } catch {
        /* child exited during the scan */
      }
    }
    return out;
  }
  if (process.platform === 'win32') {
    // Name is emitted alongside CommandLine: CommandLine can be null
    // (access-denied/transitional), and a leak check must still see the child.
    const r = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "ParentProcessId=${Math.trunc(ppid)}" | ForEach-Object { "$($_.ProcessId)\`t$($_.Name) $($_.CommandLine)" }`,
      ],
      { encoding: 'utf-8', timeout: 10_000 },
    );
    if (r.error || r.status !== 0) {
      // Fail loudly: an empty list from a broken probe would read as "no leaked children".
      throw new Error(`process probe (powershell) failed: ${r.error?.message ?? `exit ${r.status}`}\n${r.stderr ?? ''}`);
    }
    return (r.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        return { pid: Number(line.slice(0, tab < 0 ? undefined : tab)), command: tab < 0 ? '' : line.slice(tab + 1).trim() };
      })
      .filter((c) => Number.isFinite(c.pid));
  }
  // darwin and other POSIX: portable ps columns only (no GNU --ppid).
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf-8', timeout: 5_000 });
  if (r.error || r.status !== 0) {
    throw new Error(`process probe (ps) failed: ${r.error?.message ?? `exit ${r.status}`}\n${r.stderr ?? ''}`);
  }
  return (r.stdout ?? '')
    .split('\n')
    // args= may be empty for a defunct child; keep the row, not drop it.
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)(?:\s+(.*))?$/))
    .filter((m): m is RegExpMatchArray => m !== null && Number(m[2]) === ppid)
    .map((m) => ({ pid: Number(m[1]), command: m[3] ?? '' }));
}

/** Resolves when a `spawnTracked` child emits `close` (fully reaped, stdio
 * drained, tracked pid removed). `exit` alone does not resolve it. */
export function onceClosed(child: ChildProcess): Promise<void> {
  if (closedChildren.has(child)) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('close', () => resolve());
  });
}
