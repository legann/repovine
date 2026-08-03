import * as fs from 'node:fs';
import * as path from 'node:path';
import { isMainThread } from 'node:worker_threads';

export interface MemorySnapshot {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
}

export interface PhaseRecord extends MemorySnapshot {
  label: string;
  elapsedMs: number;
  deltaRssMb: number;
  deltaHeapMb: number;
}

export interface PerfCounters {
  packagesScanned: number;
  sourceFilesDiscovered: number;
  uniqueModules: number;
  modulesReused: number;
  modulesRescanned: number;
  totalImports: number;
  totalExports: number;
  infraModules: number;
  infraResources: number;
  templates: number;
  graphNodes: number;
  graphEdges: number;
  searchIndexTokens: number;
  snapshotJsonBytes: number;
  snapshotCacheJsonBytes: number;
}

function emptyCounters(): PerfCounters {
  return {
    packagesScanned: 0,
    sourceFilesDiscovered: 0,
    uniqueModules: 0,
    modulesReused: 0,
    modulesRescanned: 0,
    totalImports: 0,
    totalExports: 0,
    infraModules: 0,
    infraResources: 0,
    templates: 0,
    graphNodes: 0,
    graphEdges: 0,
    searchIndexTokens: 0,
    snapshotJsonBytes: 0,
    snapshotCacheJsonBytes: 0,
  };
}

function readMemory(): MemorySnapshot {
  const m = process.memoryUsage();
  const toMb = (n: number) => Math.round(n / 1024 / 1024);
  return {
    rssMb: toMb(m.rss),
    heapUsedMb: toMb(m.heapUsed),
    heapTotalMb: toMb(m.heapTotal),
    externalMb: toMb(m.external),
    arrayBuffersMb: toMb(m.arrayBuffers),
  };
}

function envEnabled(name: string): boolean {
  const value = process.env[name];
  return value === '1' || value === 'true';
}

export function isProfileEnabled(): boolean {
  return envEnabled('REPOVINE_PROFILE');
}

export function isProfileGcEnabled(): boolean {
  return envEnabled('REPOVINE_PROFILE_GC');
}

export class MemoryProfiler {
  readonly enabled: boolean;
  readonly gcEnabled: boolean;
  readonly counters: PerfCounters;

  private readonly phases: PhaseRecord[] = [];
  private phaseStartedAt = Date.now();
  private lastMemory = readMemory();
  /** When profiling, also append each phase line here so an OOM/crash leaves a readable trail. */
  private readonly profileFile: string | undefined;

  constructor(enabled = isProfileEnabled(), gcEnabled = isProfileGcEnabled()) {
    this.enabled = enabled;
    this.gcEnabled = gcEnabled;
    this.counters = emptyCounters();
    // Only the main thread owns the crash-trail file. A Stage 2 worker isolate builds its own profiler;
    // truncating here would wipe the main thread's Stage 1 trail, and concurrent appends would interleave.
    // Off the main thread profileFile stays undefined, so the worker's profiler never touches the trail.
    if (enabled && isMainThread) {
      this.profileFile = process.env.REPOVINE_PROFILE_FILE
        ?? path.join(process.cwd(), '.repovine-build-profile.log');
      try {
        // Truncate at start so each build's trail stands alone; record the start time + pid.
        fs.writeFileSync(this.profileFile, `# repovine build profile  pid=${process.pid}  ${new Date().toISOString()}  cwd=${process.cwd()}\n`);
      } catch { this.profileFile = undefined; }
    }
  }

  static active(): MemoryProfiler {
    return globalThis.__repovineProfiler ?? new MemoryProfiler(false);
  }

  static ensure(): MemoryProfiler {
    if (!globalThis.__repovineProfiler) {
      globalThis.__repovineProfiler = new MemoryProfiler();
    }
    return globalThis.__repovineProfiler;
  }

  setCounter<K extends keyof PerfCounters>(key: K, value: PerfCounters[K]): void {
    if (!this.enabled) return;
    this.counters[key] = value;
  }

  addCounter<K extends keyof PerfCounters>(key: K, delta: number): void {
    if (!this.enabled) return;
    this.counters[key] = (this.counters[key] as number) + delta;
  }

  phase(label: string): void {
    if (!this.enabled) return;

    if (this.gcEnabled) {
      (globalThis as { gc?: () => void }).gc?.();
    }

    const now = Date.now();
    const memory = readMemory();
    const record: PhaseRecord = {
      label,
      elapsedMs: now - this.phaseStartedAt,
      deltaRssMb: memory.rssMb - this.lastMemory.rssMb,
      deltaHeapMb: memory.heapUsedMb - this.lastMemory.heapUsedMb,
      ...memory,
    };
    this.phases.push(record);
    // Emit the per-phase RSS in real time so a build that OOMs/crashes still leaves the trail showing
    // which phase the memory blew up in. STDERR (stdout is the MCP JSON-RPC channel) + a sync file
    // append (client-launched servers swallow stderr; the file survives the crash for offline reading).
    const line = `${label.padEnd(30)} ${String(record.elapsedMs).padStart(6)}ms  rss=${String(memory.rssMb).padStart(6)}MB (${record.deltaRssMb >= 0 ? '+' : ''}${record.deltaRssMb})  heap=${memory.heapUsedMb}MB  ext=${memory.externalMb}MB  arrayBuffers=${memory.arrayBuffersMb}MB`;
    console.error(`[repovine:profile] ${line}`);
    if (this.profileFile) {
      try { fs.appendFileSync(this.profileFile, line + '\n'); } catch { /* best-effort trail */ }
    }
    this.lastMemory = memory;
    this.phaseStartedAt = now;
  }

  measureJsonBytes(value: unknown): number {
    if (!this.enabled) return 0;
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  }

  summaryLines(): string[] {
    if (!this.enabled) return [];

    const peak = this.phases.reduce(
      (best, phase) => (phase.rssMb > best.rssMb ? phase : best),
      this.phases[0] ?? { label: 'n/a', rssMb: 0, heapUsedMb: 0 },
    );

    const lines = [
      '── repovine memory profile ──',
      ...this.phases.map(phase =>
        `${phase.label.padEnd(28)} ${String(phase.elapsedMs).padStart(6)}ms  rss=${String(phase.rssMb).padStart(4)}MB (+${phase.deltaRssMb})  heap=${String(phase.heapUsedMb).padStart(4)}MB (+${phase.deltaHeapMb})`,
      ),
      '',
      `Peak RSS: ${peak.rssMb} MB at "${peak.label}"`,
      // reduce, not Math.max(...spread): the singleton accumulates a phase per shard, so spreading a
      // large array over a call would throw RangeError past V8's argument-count limit.
      `Peak heap: ${this.phases.reduce((max, p) => (p.heapUsedMb > max ? p.heapUsedMb : max), 0)} MB`,
      '',
      'Counters:',
      `  packagesScanned=${this.counters.packagesScanned}`,
      `  sourceFilesDiscovered=${this.counters.sourceFilesDiscovered}`,
      `  uniqueModules=${this.counters.uniqueModules}`,
      `  modulesReused=${this.counters.modulesReused}`,
      `  modulesRescanned=${this.counters.modulesRescanned}`,
      `  totalImports=${this.counters.totalImports}`,
      `  totalExports=${this.counters.totalExports}`,
      `  infraModules=${this.counters.infraModules}`,
      `  infraResources=${this.counters.infraResources}`,
      `  graphNodes=${this.counters.graphNodes}`,
      `  graphEdges=${this.counters.graphEdges}`,
      `  searchIndexTokens=${this.counters.searchIndexTokens}`,
      `  snapshotJsonBytes=${this.counters.snapshotJsonBytes}`,
      `  snapshotCacheJsonBytes=${this.counters.snapshotCacheJsonBytes}`,
    ];

    return lines;
  }

  logSummary(): void {
    if (!this.enabled) return;
    for (const line of this.summaryLines()) {
      console.log(line);
    }
  }

  /**
   * Drop accumulated phases so a build's summary stands alone and the process-global singleton stays
   * bounded across refreshes (each build appends a phase per package shard). Called at pipeline start.
   * Truncates the crash-trail file like the constructor so each build's trail is self-contained.
   */
  reset(): void {
    if (!this.enabled) return;
    this.phases.length = 0;
    // Clear counters too: a build that never sets a given counter must report 0, not the prior build's
    // value carried on the process-global singleton (e.g. searchIndexTokens leaking across refreshes).
    Object.assign(this.counters, emptyCounters());
    this.phaseStartedAt = Date.now();
    this.lastMemory = readMemory();
    if (this.profileFile) {
      try {
        fs.writeFileSync(this.profileFile, `# repovine build profile  pid=${process.pid}  ${new Date().toISOString()}  cwd=${process.cwd()}\n`);
      } catch { /* best-effort trail */ }
    }
  }
}

declare global {
  var __repovineProfiler: MemoryProfiler | undefined;
}

export function profilePhase<T>(label: string, fn: () => T): T {
  const profiler = MemoryProfiler.ensure();
  profiler.phase(label);
  return fn();
}

export async function profilePhaseAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const profiler = MemoryProfiler.ensure();
  profiler.phase(label);
  return fn();
}
