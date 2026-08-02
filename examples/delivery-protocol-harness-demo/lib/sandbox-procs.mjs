// Sandbox process reconciliation — observe (and optionally reap) the processes,
// ports, and containers a worker subAgents running after a sub-agent/run.
//
// WHY: worker agents verify their work by starting dev servers / `docker compose
// up` and routinely leave them running — a spawned background process can keep
// file descriptors open after the run call returns.
// Those daemons outlive the run and leak ports + memory. This module snapshots
// the sandbox's running state around a worker call so the harness can:
//   - LOG leftovers always (observability), and
//   - REAP them after each sub-agent (always) and on /reset (unconditional).
//
// Attribution is by SANDBOX PATH: a process is "ours" when its cwd is under
// repoRoot or its argv references repoRoot. Linux-only (reads /proc); degrades to
// a no-op on other platforms. Containers are daemon-managed (process-kill does
// nothing), so they are torn down semantically with `docker compose down`; the
// per-sub-agent diff additionally `docker rm -f`s containers that are NEW since the
// sub-agent's baseline (almost certainly the agent's, given the serial run model).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logLine } from './log.mjs';

const VERBOSE = process.env.GRAPH_VERBOSE !== '0';
const log = (msg) => logLine('reaper', msg, { enabled: VERBOSE, indent: '  ' });
const isLinux = process.platform === 'linux';
const PID_RE = /^\d+$/;
const MAX_DESC = 12;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Per-sub-agent reaper is always on (write-only workers should not leave daemons, but reap anyway). */
export function harnessReapEnabled() {
  return true;
}

function realpath(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}
function safeKill(pid, sig) {
  try { process.kill(pid, sig); return true; } catch { return false; }
}
function alive(pid) {
  return safeKill(pid, 0);
}
function docker(args, opts = {}) {
  return spawnSync('docker', args, { encoding: 'utf-8', timeout: 60000, ...opts });
}

/**
 * True if the process has a controlling terminal — i.e. an interactive shell or
 * other operator-owned process, NOT an agent-spawned daemon (the SDK gives those
 * piped stdio, so they have no tty). We use this to NEVER reap the operator's own
 * terminal even when its cwd happens to be inside the sandbox.
 */
function hasControllingTty(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    // After the "(comm)" field: state ppid pgrp session tty_nr ...
    const after = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    return Number(after[4]) !== 0; // tty_nr 0 = no controlling terminal
  } catch {
    return false;
  }
}

/** pid -> { cmd } for processes attributable to repoRoot (cwd under it or argv mentions it). */
function sandboxProcs(repoRoot) {
  const out = new Map();
  if (!isLinux) return out;
  const root = realpath(repoRoot);
  let pids;
  try { pids = fs.readdirSync('/proc').filter((d) => PID_RE.test(d)); } catch { return out; }
  for (const pid of pids) {
    if (pid === String(process.pid)) continue; // never reap the harness itself
    let cwd = '';
    try { cwd = realpath(fs.readlinkSync(`/proc/${pid}/cwd`)); } catch { /* gone / no perm */ }
    let cmd = '';
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`).toString().replace(/\0/g, ' ').trim(); } catch { /* race */ }
    const underRoot = cwd && (cwd === root || cwd.startsWith(`${root}/`));
    const mentions = cmd && cmd.includes(root);
    if (!(underRoot || mentions)) continue;
    if (hasControllingTty(pid)) continue; // operator's own interactive shell — never reap
    out.set(Number(pid), { cmd: cmd.slice(0, 200) || '(unknown)' });
  }
  return out;
}

/** Listening TCP port -> owning pid, for ports owned by the given pid set (needs `ss`). */
function listeningPorts(pidSet) {
  const ports = new Map();
  if (!isLinux || pidSet.size === 0) return ports;
  const res = spawnSync('ss', ['-ltnpH'], { encoding: 'utf-8' });
  if (res.status !== 0 || !res.stdout) return ports;
  for (const line of res.stdout.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const local = fields[3]; // State Recv-Q Send-Q Local:Port ...
    const port = Number(local.slice(local.lastIndexOf(':') + 1));
    const pidM = /pid=(\d+)/.exec(line);
    if (port && pidM && pidSet.has(Number(pidM[1]))) ports.set(port, Number(pidM[1]));
  }
  return ports;
}

/**
 * Running container ids attributable to this sandbox (best-effort; empty when docker
 * is absent). Scoped by the compose project working_dir label so a concurrent sibling
 * subAgent's containers (a different worktree) are not attributed to — and reaped by —
 * this one. Without repoRoot it lists all (used only by the /reset sweep).
 */
function containerIds(repoRoot) {
  const set = new Set();
  const args = repoRoot
    ? ['ps', '-q', '--filter', `label=com.docker.compose.project.working_dir=${realpath(repoRoot)}`]
    : ['ps', '-q'];
  const res = docker(args);
  if (res.status === 0 && res.stdout) for (const id of res.stdout.split('\n')) if (id.trim()) set.add(id.trim());
  return set;
}

/** Snapshot of sandbox-attributable running state. Cheap; safe to call per sub-agent. */
export function snapshot(repoRoot) {
  const procs = sandboxProcs(repoRoot);
  return { procs, ports: listeningPorts(new Set(procs.keys())), containers: containerIds(repoRoot) };
}

const shortCmd = (cmd) => cmd.split(' ').slice(0, 4).join(' ');

/** `docker compose down` for the sandbox's own compose project (scoped, never blanket). */
function composeDown(repoRoot) {
  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const file = path.join(repoRoot, name);
    if (fs.existsSync(file)) {
      docker(['compose', '-f', file, 'down', '-v'], { cwd: repoRoot });
      return true;
    }
  }
  return false;
}

async function killProcs(pids) {
  if (!pids.length) return;
  for (const pid of pids) safeKill(pid, 'SIGTERM');
  await delay(1500); // grace period for clean shutdown
  for (const pid of pids) if (alive(pid)) safeKill(pid, 'SIGKILL');
}

/**
 * Diff `before` against the current state, LOG what the worker left running, and
 * (when reap) terminate it. Returns { leftRunning: string[], reaped } for the reply.
 * Never throws — reaping is best-effort.
 */
export async function reconcile(repoRoot, before, { label = 'sub-agent', reap = false } = {}) {
  const after = snapshot(repoRoot);
  const newPids = [...after.procs].filter(([pid]) => !before.procs.has(pid));
  const newPorts = [...after.ports.keys()].filter((p) => !before.ports.has(p));
  const newContainers = [...after.containers].filter((id) => !before.containers.has(id));

  const desc = [
    ...newPids.map(([pid, info]) => `pid ${pid} ${shortCmd(info.cmd)}`),
    ...newPorts.map((p) => `:${p}`),
    ...newContainers.map((id) => `container ${id.slice(0, 12)}`),
  ].slice(0, MAX_DESC);
  if (!desc.length) return { leftRunning: [], reaped: false };

  log(`${label} left running: ${desc.join(', ')}`);
  if (!reap) return { leftRunning: desc, reaped: false };

  if (newContainers.length) {
    composeDown(repoRoot); // daemon-managed: a process-kill would not stop containers
    for (const id of newContainers) docker(['rm', '-f', id]);
  }
  await killProcs(newPids.map(([pid]) => pid));
  log(`${label} reaped ${desc.length} item(s)`);
  return { leftRunning: desc, reaped: true };
}

/**
 * Unconditional sweep: terminate every sandbox-attributable process and bring the
 * sandbox's compose project down. Used on /reset, where the sandbox is about to be
 * wiped (leftover servers would point at deleted files). Never blanket-removes
 * containers — only the scoped `docker compose down`.
 */
export async function reapAll(repoRoot, { label = 'reset' } = {}) {
  const snap = snapshot(repoRoot);
  const pids = [...snap.procs.keys()];
  composeDown(repoRoot);
  await killProcs(pids);
  if (pids.length) log(`${label} reaped ${pids.length} sandbox process(es)`);
  return { reaped: pids.length };
}
