import * as fs from 'node:fs';
import * as path from 'node:path';
import { totalmem } from 'node:os';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ModuleInfo, PackageInfo, PendingModule } from '../types.js';
import type { HostPath, ReadonlyFactRecord } from '@repovine/plugin-sdk';
import { packageJobKey } from './utils.js';
import type { PluginLoadSpec } from '../plugin-host/load.js';

/** Grace period for a worker to kill+reap its in-flight subprocesses and exit on its own after a
 * shutdown message, before the pool force-terminates it. Force-termination races the shutdown and
 * would orphan a plugin's child process (python AST), so the pool waits for a clean exit first. */
const SHUTDOWN_GRACE_MS = 3000;

export interface PackageJob {
  pkg: PackageInfo;
  /** Source plugin that owns this package's files; selects the extractor in the worker. */
  sourcePluginId: string;
  pendingModules: PendingModule[];
  prevModuleEntries: [HostPath, ModuleInfo][];
  /** Sharding metadata: which slice of `pkg`'s pendingModules this job processes. */
  shardIndex: number;
  totalShards: number;
  /** Kept for backwards compatibility with progress logs; sharding makes it irrelevant. */
  solo?: boolean;
}

export interface PackageJobResult {
  pkgName: string;
  /** `${sourcePluginId}\0${name}\0${path}` — disambiguates same-name packages across plugins. */
  jobKey: string;
  shardIndex: number;
  modules: ModuleInfo[];
  reused: number;
  rescanned: number;
  /** Facts this shard's producer published and the Stage 1 boundary took. */
  facts?: ReadonlyFactRecord[];
  /** What that boundary refused, one line per refused fact. */
  factRefusals?: string[];
  error?: string;
}

export interface PackageWorkerPoolOptions {
  /** Number of worker threads. >= 1. */
  size: number;
  packages: PackageInfo[];
  absPathToId: Map<HostPath, string>;
  /** Repo root, forwarded to workers for string-based specifier resolution. */
  repoRoot: HostPath;
  /** Opaque per-plugin extractContext (e.g. parsed compilerOptions), forwarded via workerData.
   * Values must be structured-clone-safe so they survive the worker boundary. */
  extractContextByPlugin: Map<string, unknown>;
  /** STAGE1_ANALYSIS_VERSION of the current run, forwarded to plugin extract(). */
  analysisVersion: number;
  /** The plugin set this build resolved. Each worker loads it through the one loading path before
   *  it takes a job, so an isolate runs the same extractors the control plane loaded. */
  pluginSpec: PluginLoadSpec;
  /** Packages with >= this many pending modules consume a solo slot (no concurrency). */
  soloThreshold: number;
  /** Grace period (ms) a worker gets to exit on its own after a shutdown message before the pool
   *  force-terminates it. Defaults to SHUTDOWN_GRACE_MS; overridable for tests. */
  shutdownGraceMs?: number;
}

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  /** When true, this slot is currently running a solo job; other slots are paused. */
  runningSolo: boolean;
  /** Set after a worker 'error'/'exit'/'messageerror': the slot must never receive another job. */
  dead: boolean;
  /** The job dispatched to this worker (one at a time), or undefined when idle. Gives the crash/exit
   *  handlers a precise job→slot mapping so they reject only this slot's job and free exactly this slot. */
  currentJobId: number | undefined;
}

interface InternalJob extends PackageJob {
  jobId: number;
  resolve(result: PackageJobResult): void;
  reject(err: Error): void;
}

function resolveWorkerScriptUrl(): URL {
  const adjacent = fileURLToPath(new URL('./worker.js', import.meta.url));
  if (fs.existsSync(adjacent)) return new URL('./worker.js', import.meta.url);
  const distFromAdjacent = adjacent.replace(`${path.sep}src${path.sep}`, `${path.sep}dist${path.sep}`);
  if (fs.existsSync(distFromAdjacent)) return pathToFileURL(distFromAdjacent);
  const cwdDist = path.resolve(process.cwd(), 'dist', 'stage1', 'worker.js');
  if (fs.existsSync(cwdDist)) return pathToFileURL(cwdDist);
  const nestedCwdDist = path.resolve(process.cwd(), 'repovine', 'dist', 'stage1', 'worker.js');
  if (fs.existsSync(nestedCwdDist)) return pathToFileURL(nestedCwdDist);
  throw new Error('stage1/worker.js not found; run npm run build');
}

const WORKER_URL = resolveWorkerScriptUrl();

export class PackageWorkerPool {
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: InternalJob[] = [];
  private nextJobId = 1;
  private pendingByJobId = new Map<number, InternalJob>();
  private soloInFlight = false;
  private destroyed = false;

  constructor(private readonly opts: PackageWorkerPoolOptions) {
    const absPathToIdEntries = Array.from(opts.absPathToId.entries());
    const extractContextEntries = Array.from(opts.extractContextByPlugin.entries());
    for (let i = 0; i < opts.size; i++) {
      const worker = new Worker(WORKER_URL, {
        workerData: {
          packages: opts.packages,
          absPathToIdEntries,
          repoRoot: opts.repoRoot,
          extractContextEntries,
          analysisVersion: opts.analysisVersion,
          pluginSpec: opts.pluginSpec,
        },
      });
      const slot: WorkerSlot = { worker, busy: false, runningSolo: false, dead: false, currentJobId: undefined };
      worker.on('message', (msg: { type: string; jobId: number; pkgName?: string; modules?: ModuleInfo[]; reused?: number; rescanned?: number; facts?: ReadonlyFactRecord[]; factRefusals?: string[]; message?: string; stack?: string }) => {
        // Free the slot only when this reply is for the job this worker is running. A stray/duplicate
        // reply for a different jobId must not free a slot busy with another job (one-job-per-slot). The
        // current job may already be gone from pendingByJobId (swept by a crash elsewhere) — the
        // currentJobId match still frees the slot, it just has nothing to resolve. Skipping the free in
        // that case would leak the slot: it would stay marked busy forever and the pool would run one
        // worker short for the rest of the build.
        if (slot.currentJobId === msg.jobId) this.clearSlot(slot);
        const job = this.pendingByJobId.get(msg.jobId);
        if (job) {
          this.pendingByJobId.delete(msg.jobId);
          if (msg.type === 'result') {
            job.resolve({
              pkgName: msg.pkgName ?? job.pkg.name,
              jobKey: packageJobKey(job.pkg),
              shardIndex: job.shardIndex,
              modules: msg.modules ?? [],
              reused: msg.reused ?? 0,
              rescanned: msg.rescanned ?? 0,
              facts: msg.facts ?? [],
              factRefusals: msg.factRefusals ?? [],
            });
          } else {
            const error = new Error(msg.message ?? 'unknown worker error');
            if (msg.stack) error.stack = msg.stack;
            job.reject(error);
          }
        }
        this.drainQueue();
      });
      // A worker 'error' crashes the thread; its exit follows. Reject only THIS slot's in-flight job —
      // other slots' jobs are unaffected — and mark the slot dead so drainQueue never dispatches to it
      // (postMessage to an exited thread is a silent no-op that would hang the job).
      worker.on('error', err => this.failSlot(slot, err));
      // Unexpected exit with no preceding 'error' (OOM SIGKILL, process.exit inside the worker) would
      // otherwise strand the in-flight job. Ignore expected exits during shutdown (destroy handles those).
      worker.on('exit', code => {
        if (this.destroyed) return;
        this.failSlot(slot, new Error(`stage1 worker exited unexpectedly (code ${code})`));
      });
      // A result that fails to deserialize is lost; the job would hang. Treat it as a slot failure.
      worker.on('messageerror', err => {
        if (this.destroyed) return;
        this.failSlot(slot, err instanceof Error ? err : new Error(`stage1 worker messageerror: ${String(err)}`));
      });
      this.slots.push(slot);
    }
  }

  /** Return a slot to idle: clears busy + solo bookkeeping + its job reference. */
  private clearSlot(slot: WorkerSlot): void {
    slot.busy = false;
    slot.currentJobId = undefined;
    if (slot.runningSolo) {
      slot.runningSolo = false;
      this.soloInFlight = false;
    }
  }

  /** Handle a slot going down (error / unexpected exit / messageerror). Idempotent across the
   *  error→exit sequence via the `dead` guard: rejects this slot's in-flight job once, frees the slot,
   *  then re-drains — or, if no live worker remains, fails the whole backlog so no promise hangs. */
  private failSlot(slot: WorkerSlot, err: Error): void {
    if (slot.dead) return;
    slot.dead = true;
    const jobId = slot.currentJobId;
    this.clearSlot(slot);
    if (jobId !== undefined) {
      const job = this.pendingByJobId.get(jobId);
      if (job) { this.pendingByJobId.delete(jobId); job.reject(err); }
    }
    if (this.destroyed) return;
    if (this.slots.every(s => s.dead)) {
      for (const [id, job] of this.pendingByJobId) { this.pendingByJobId.delete(id); job.reject(err); }
      const queued = this.queue.splice(0, this.queue.length);
      for (const job of queued) job.reject(err);
      return;
    }
    this.drainQueue();
  }

  submit(job: PackageJob): Promise<PackageJobResult> {
    if (this.destroyed) {
      return Promise.reject(new Error('worker pool destroyed'));
    }
    // Terminal-failed: every worker has crashed/exited. drainQueue only assigns to a live slot, so a
    // job queued now would hang forever — reject instead. (The pool has no self-healing respawn.)
    if (this.slots.length > 0 && this.slots.every(s => s.dead)) {
      return Promise.reject(new Error('worker pool has no live workers'));
    }
    return new Promise((resolve, reject) => {
      const internal: InternalJob = {
        ...job,
        jobId: this.nextJobId++,
        resolve,
        reject,
      };
      this.queue.push(internal);
      this.drainQueue();
    });
  }

  private drainQueue(): void {
    if (this.destroyed) return;
    for (;;) {
      if (this.queue.length === 0) return;
      const slot = this.slots.find(s => !s.busy && !s.dead);
      if (!slot) return;

      // Solo semantics: solo blocks only OTHER solo jobs (mutex on solo class),
      // not non-solo jobs. This bounds peak RAM to one giant-package AST in flight,
      // while letting the rest of the pool stay hot on the long tail.
      let pickIdx = -1;
      for (let i = 0; i < this.queue.length; i++) {
        if (this.queue[i]!.solo && this.soloInFlight) continue;
        pickIdx = i;
        break;
      }
      if (pickIdx < 0) return;
      const [picked] = this.queue.splice(pickIdx, 1);
      this.dispatch(slot, picked!, picked!.solo === true);
    }
  }

  private dispatch(slot: WorkerSlot, job: InternalJob, solo: boolean): void {
    slot.busy = true;
    slot.runningSolo = solo;
    slot.currentJobId = job.jobId;
    if (solo) this.soloInFlight = true;
    this.pendingByJobId.set(job.jobId, job);
    try {
      slot.worker.postMessage({
        type: 'job',
        jobId: job.jobId,
        pkg: job.pkg,
        sourcePluginId: job.sourcePluginId,
        pendingModules: job.pendingModules,
        prevModuleEntries: job.prevModuleEntries,
      });
    } catch (e) {
      // postMessage to a dead/exiting worker (or a non-cloneable payload) throws: roll back so the job is
      // not stranded pending on a busy slot. Reject it, then fail the slot (which re-drains the backlog).
      const err = e instanceof Error ? e : new Error(String(e));
      this.pendingByJobId.delete(job.jobId);
      job.reject(err);
      this.failSlot(slot, err);
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    // Sweep any still-outstanding work so no caller's promise hangs after teardown. In the normal flow
    // the pool is destroyed after all jobs settle (nothing to sweep); on an aborted build in-flight and
    // queued jobs are still here, and their workers are about to be terminated without replying.
    const err = new Error('worker pool destroyed');
    for (const [jobId, job] of this.pendingByJobId) { this.pendingByJobId.delete(jobId); job.reject(err); }
    const queued = this.queue.splice(0, this.queue.length);
    for (const job of queued) job.reject(err);
    await Promise.all(this.slots.map(slot => this.shutdownSlot(slot)));
  }

  /** Ask a worker to shut down, then give it a grace period to kill+reap its in-flight subprocesses
   * and exit on its own (its shutdown handler closes parentPort, draining the loop). Force-terminate
   * only on overrun, so a plugin's child process (python AST) is reaped rather than orphaned. */
  private async shutdownSlot(slot: WorkerSlot): Promise<void> {
    if (slot.dead) { await slot.worker.terminate().catch(() => undefined); return; }
    try {
      slot.worker.postMessage({ type: 'shutdown' });
    } catch {
      await slot.worker.terminate().catch(() => undefined);
      return;
    }
    const exited = await this.waitForWorkerExit(slot.worker, this.opts.shutdownGraceMs ?? SHUTDOWN_GRACE_MS);
    if (!exited) await slot.worker.terminate().catch(() => undefined);
  }

  private waitForWorkerExit(worker: Worker, ms: number): Promise<boolean> {
    return new Promise(resolve => {
      let settled = false;
      const done = (value: boolean): void => { if (!settled) { settled = true; resolve(value); } };
      worker.once('exit', () => done(true));
      const timer = setTimeout(() => done(false), ms);
      timer.unref();
    });
  }
}

const WORKER_RAM_BYTES = 3 * 1024 * 1024 * 1024;

/** Heuristic: pick worker count based on CPU, RAM, and explicit override. */
export function chooseWorkerCount(maxPackageWorkers: number | undefined, cpus: number, totalRamBytes: number): number {
  if (maxPackageWorkers === undefined) {
    // Default: cap by half of CPUs and half of RAM (3 GiB per worker), at least 1.
    const cpuCap = Math.max(1, Math.floor(cpus / 2));
    const ramBudgetBytes = Math.floor(totalRamBytes / 2);
    const ramCap = Math.max(1, Math.floor(ramBudgetBytes / WORKER_RAM_BYTES));
    return Math.max(1, Math.min(cpuCap, ramCap));
  }
  if (!Number.isFinite(maxPackageWorkers) || maxPackageWorkers < 1) return 1;
  return Math.floor(maxPackageWorkers);
}

/**
 * Total memory to size worker allocation against: the container/cgroup limit when it is smaller than
 * host RAM, else host RAM. `process.constrainedMemory()` reports the cgroup cap or an "unconstrained"
 * sentinel — 0 (undeterminable) or a ~2^64 value under cgroup v2 "max"; `Math.min` ignores both.
 * Sizing off host RAM in a memory-limited container over-provisions workers and invites an OOM kill.
 * Args are injectable for tests; production calls read the live host/cgroup values.
 */
export function effectiveTotalMemBytes(
  hostBytes: number = totalmem(),
  constrainedBytes: number = typeof process.constrainedMemory === 'function' ? (process.constrainedMemory() ?? 0) : 0,
): number {
  const cap = constrainedBytes > 0 ? constrainedBytes : Number.POSITIVE_INFINITY;
  return Math.min(hostBytes, cap);
}
