import { describe, expect, it, afterEach, beforeAll, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectRepositoryFactsAsync, mergeResults, packageJobKey } from '../../../src/stage1/index.js';
import { loadCalibration } from '../../../src/stage1/calibration.js';
import { composeRepositoryGraph } from '../../../src/stage2/index.js';
import { chooseWorkerCount, effectiveTotalMemBytes } from '../../../src/stage1/worker-pool.js';
import { spawn } from 'node:child_process';
import { terminateLivePythonChildren, __trackLivePythonChildForTest } from '../../../packages/plugins/source-python/src/extract.js';
import pythonSourcePlugin from '../../../packages/plugins/source-python/src/plugin.js';
import { findFixturesRoot, normalizeGraph } from '../../laws/graph-law-helpers.js';
import type { ModuleInfo, PackageInfo, PendingModule, RepositoryFactsSnapshot } from '../../../src/types.js';
import type { PackageJob, PackageJobResult, PackageWorkerPoolOptions } from '../../../src/stage1/worker-pool.js';

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function copyFixture(name: string): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `repovine-${name}-`));
  const dest = path.join(parent, name);
  fs.cpSync(path.join(findFixturesRoot(), name), dest, { recursive: true });
  tempRoots.push(parent);
  return dest;
}

async function collectSilently(repoRoot: string, options: Parameters<typeof collectRepositoryFactsAsync>[1]): Promise<RepositoryFactsSnapshot> {
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    return await collectRepositoryFactsAsync(repoRoot, options);
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
}

function normalizeSnapshotContract(snapshot: RepositoryFactsSnapshot): Record<string, unknown> {
  return {
    packages: sortStable(snapshot.packages.map(stableValue)),
    modules: sortStable(snapshot.modules.map(stableValue)),
    infraModules: sortStable((snapshot.infraModules ?? []).map(stableValue)),
    templates: sortStable((snapshot.templates ?? []).map(stableValue)),
    bundleOutputHandlerMap: stableValue(snapshot.bundleOutputHandlerMap ?? null),
    linkingConfig: stableValue(snapshot.linkingConfig ?? null),
  };
}

function sortStable(values: unknown[]): unknown[] {
  return values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = stableValue((value as Record<string, unknown>)[key]);
  return out;
}

describe('collectRepositoryFactsAsync worker-pool parity', () => {
  it('matches inline snapshot and graph contracts on a multi-package fixture', async () => {
    const repoRoot = copyFixture('hybrid-monorepo');

    const inline = await collectSilently(repoRoot, { maxPackageWorkers: 1 });
    const pooled = await collectSilently(repoRoot, { maxPackageWorkers: 2 });

    expect(normalizeSnapshotContract(pooled)).toEqual(normalizeSnapshotContract(inline));
    expect(normalizeGraph(composeRepositoryGraph(pooled))).toEqual(
      normalizeGraph(composeRepositoryGraph(inline)),
    );
  });

  it('unions sharded pooled results to the same contract as an unsharded pooled run', async () => {
    const repoRoot = copyFixture('tsconfig-references-monorepo');

    const unsharded = await collectSilently(repoRoot, {
      maxPackageWorkers: 2,
      shardTargetSize: 1000,
    });
    const sharded = await collectSilently(repoRoot, {
      maxPackageWorkers: 2,
      shardTargetSize: 1,
    });

    expect(normalizeSnapshotContract(sharded)).toEqual(normalizeSnapshotContract(unsharded));
    expect(normalizeGraph(composeRepositoryGraph(sharded))).toEqual(
      normalizeGraph(composeRepositoryGraph(unsharded)),
    );
  });

  it('emits the same graph across the worker-count × sharding matrix', async () => {
    const repoRoot = copyFixture('tsconfig-references-monorepo');
    const variants: RepositoryFactsSnapshot[] = [];
    for (const options of [
      { maxPackageWorkers: 1, shardTargetSize: 1000 },
      { maxPackageWorkers: 1, shardTargetSize: 1 },
      { maxPackageWorkers: 2, shardTargetSize: 1000 },
      { maxPackageWorkers: 2, shardTargetSize: 1 },
    ]) {
      variants.push(await collectSilently(repoRoot, options));
    }
    const referenceSnapshot = normalizeSnapshotContract(variants[0]);
    const referenceGraph = normalizeGraph(composeRepositoryGraph(variants[0]));

    for (const variant of variants.slice(1)) {
      expect(normalizeSnapshotContract(variant)).toEqual(referenceSnapshot);
      expect(normalizeGraph(composeRepositoryGraph(variant))).toEqual(referenceGraph);
    }
  });

  it('keeps the last cold calibration across a warm increment and replaces it on the next cold run', async () => {
    const repoRoot = copyFixture('tsconfig-references-monorepo');
    const options = { maxPackageWorkers: 2, shardTargetSize: 1 };
    const cacheDir = path.join(repoRoot, '.repovine', '.cache');

    const firstCold = await collectSilently(repoRoot, options);
    const firstCalibration = loadCalibration(cacheDir);
    expect(firstCalibration?.lastRun.observed).toMatchObject({
      runKind: 'cold',
      reusedModules: 0,
      rescannedModules: firstCold.modules.length,
    });

    fs.appendFileSync(
      path.join(repoRoot, 'packages', 'api', 'src', 'handler.ts'),
      '\nexport const calibrationProbe = true;\n',
    );
    await collectSilently(repoRoot, { ...options, previousSnapshot: firstCold });
    expect(loadCalibration(cacheDir)).toEqual(firstCalibration);

    await new Promise(resolve => setTimeout(resolve, 2));
    const secondCold = await collectSilently(repoRoot, options);
    const secondCalibration = loadCalibration(cacheDir);
    expect(secondCalibration?.lastRun.observed).toMatchObject({
      runKind: 'cold',
      reusedModules: 0,
      rescannedModules: secondCold.modules.length,
    });
    expect(secondCalibration?.lastRun.at).not.toBe(firstCalibration?.lastRun.at);
  });
});

describe('chooseWorkerCount', () => {
  it('balances CPU, RAM, and explicit worker overrides', () => {
    expect(chooseWorkerCount(undefined, 8, 16 * 1024 * 1024 * 1024)).toBe(2);
    expect(chooseWorkerCount(3.9, 8, 16 * 1024 * 1024 * 1024)).toBe(3);
    expect(chooseWorkerCount(0, 8, 16 * 1024 * 1024 * 1024)).toBe(1);
  });

  it('falls back to the safe default for non-finite overrides', () => {
    expect(chooseWorkerCount(Number.POSITIVE_INFINITY, 8, 16 * 1024 * 1024 * 1024)).toBe(1);
    expect(chooseWorkerCount(Number.NaN, 8, 16 * 1024 * 1024 * 1024)).toBe(1);
  });
});

describe('effectiveTotalMemBytes', () => {
  const HOST = 64 * 1024 * 1024 * 1024;

  it('honors a container/cgroup limit smaller than host RAM', () => {
    const limit = 2 * 1024 * 1024 * 1024;
    expect(effectiveTotalMemBytes(HOST, limit)).toBe(limit);
  });

  it('returns host RAM when unconstrained (0 sentinel)', () => {
    expect(effectiveTotalMemBytes(HOST, 0)).toBe(HOST);
  });

  it('returns host RAM under the cgroup-v2 "max" sentinel (~2^64)', () => {
    expect(effectiveTotalMemBytes(HOST, 2 ** 64)).toBe(HOST);
  });

  it('returns host RAM when the reported constraint exceeds it', () => {
    expect(effectiveTotalMemBytes(HOST, HOST * 2)).toBe(HOST);
  });

  it('undersizes worker RAM budget in a limited container vs sizing off host RAM', () => {
    // 64 GiB host, 3 GiB container: host-based sizing picks many 3-GiB-budget workers; the
    // constrained value picks 1. Guards the OOM-in-container regression.
    const containerBytes = 3 * 1024 * 1024 * 1024;
    expect(chooseWorkerCount(undefined, 32, effectiveTotalMemBytes(HOST, containerBytes)))
      .toBeLessThan(chooseWorkerCount(undefined, 32, effectiveTotalMemBytes(HOST, 0)));
  });
});

describe('pooled extraction failures', () => {
  it('refuses to finalize a snapshot when any shard reports an extraction error', () => {
    const pkg: PackageInfo = { name: 'broken', path: 'packages/broken', sourcePluginId: 'typescript' };
    const failed: PackageJobResult = {
      pkgName: pkg.name,
      jobKey: packageJobKey(pkg),
      shardIndex: 0,
      modules: [],
      reused: 0,
      rescanned: 0,
      error: 'plugin extract exploded',
    };
    const modules: ModuleInfo[] = [];

    expect(() => mergeResults(new Map([[failed.jobKey, [failed]]]), [pkg], modules))
      .toThrow('Package broken shard 0 extraction failed: plugin extract exploded');
    expect(modules).toEqual([]);
  });
});

interface PostedJobMessage {
  type: 'job';
  jobId: number;
  pkg: PackageInfo;
}

type WorkerListener = (value: unknown) => void;

let workers: MockWorker[] = [];

class MockWorker {
  readonly posted: unknown[] = [];
  terminateCalls = 0;
  /** When true, a shutdown message does NOT auto-emit 'exit' — models a worker that overruns the
   *  grace period, so destroy() must force-terminate it. */
  suppressExitOnShutdown = false;
  /** When true, postMessage of a job throws — models a worker that died between the pool's liveness
   *  check and the actual post, exercising the postMessage-rollback path. */
  throwOnPost = false;
  private readonly listeners = new Map<string, WorkerListener[]>();

  constructor() {
    workers.push(this);
  }

  on(event: string, listener: WorkerListener): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  once(event: string, listener: WorkerListener): this {
    return this.on(event, listener);
  }

  postMessage(message: unknown): void {
    if (this.throwOnPost && isJobMessage(message)) throw new Error('worker gone');
    this.posted.push(message);
    if (!this.suppressExitOnShutdown && message && typeof message === 'object' && (message as { type?: string }).type === 'shutdown') {
      // Model a graceful worker: its shutdown handler drains the loop and the thread exits.
      queueMicrotask(() => this.emit('exit', 0));
    }
  }

  async terminate(): Promise<number> {
    this.terminateCalls++;
    return 0;
  }

  private emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }

  emitMessage(message: unknown): void {
    this.emit('message', message);
  }

  emitError(error: Error): void {
    this.emit('error', error);
  }

  emitExit(code = 0): void {
    this.emit('exit', code);
  }

  emitMessageError(error: Error): void {
    this.emit('messageerror', error);
  }
}

function isJobMessage(message: unknown): message is PostedJobMessage {
  return Boolean(message && typeof message === 'object' && (message as PostedJobMessage).type === 'job');
}

function jobMessages(worker: MockWorker): PostedJobMessage[] {
  return worker.posted.filter(isJobMessage);
}

function jobNames(worker: MockWorker): string[] {
  return jobMessages(worker).map(message => message.pkg.name);
}

function resultFor(worker: MockWorker, index: number): Record<string, unknown> {
  const message = jobMessages(worker)[index];
  if (!message) throw new Error(`No job message at index ${index}`);
  return {
    type: 'result',
    jobId: message.jobId,
    pkgName: message.pkg.name,
    modules: [],
    reused: 0,
    rescanned: 1,
  };
}

function poolOptions(size = 2): PackageWorkerPoolOptions {
  return {
    size,
    packages: [],
    absPathToId: new Map(),
    repoRoot: '/repo',
    extractContextByPlugin: new Map(),
    analysisVersion: 1,
    soloThreshold: 1,
  };
}

function poolJob(name: string, solo = false): PackageJob {
  const pkg: PackageInfo = { name, path: `packages/${name}`, sourcePluginId: 'typescript' };
  const pending: PendingModule = {
    filePath: `/repo/packages/${name}/src/index.ts`,
    relPath: 'src/index.ts',
    moduleId: `mod:${name}/src/index`,
    pkg,
    sourcePluginId: 'typescript',
  };
  return {
    pkg,
    sourcePluginId: 'typescript',
    pendingModules: [pending],
    prevModuleEntries: [] as [string, ModuleInfo][],
    shardIndex: 0,
    totalShards: 1,
    ...(solo ? { solo: true } : {}),
  };
}

describe('PackageWorkerPool scheduling', () => {
  let PackageWorkerPoolCtor: typeof import('../../../src/stage1/worker-pool.js').PackageWorkerPool;

  beforeAll(async () => {
    jest.resetModules();
    jest.unstable_mockModule('node:worker_threads', () => ({ Worker: MockWorker }));
    ({ PackageWorkerPool: PackageWorkerPoolCtor } = await import('../../../src/stage1/worker-pool.js'));
  });

  afterEach(() => {
    workers = [];
  });

  it('lets non-solo jobs run while another solo job holds the solo mutex', async () => {
    const pool = new PackageWorkerPoolCtor(poolOptions());

    const soloA = pool.submit(poolJob('solo-a', true));
    const soloB = pool.submit(poolJob('solo-b', true));
    const normal = pool.submit(poolJob('normal'));

    expect(jobNames(workers[0]!)).toEqual(['solo-a']);
    expect(jobNames(workers[1]!)).toEqual(['normal']);

    workers[1]!.emitMessage(resultFor(workers[1]!, 0));
    await expect(normal).resolves.toMatchObject({ pkgName: 'normal' });
    expect(jobNames(workers[1]!)).toEqual(['normal']);

    workers[0]!.emitMessage(resultFor(workers[0]!, 0));
    await expect(soloA).resolves.toMatchObject({ pkgName: 'solo-a' });
    expect(jobNames(workers[0]!)).toEqual(['solo-a', 'solo-b']);

    workers[0]!.emitMessage(resultFor(workers[0]!, 1));
    await expect(soloB).resolves.toMatchObject({ pkgName: 'solo-b' });

    await pool.destroy();
  });

  it('marks an errored slot dead and drains queued jobs through a surviving slot', async () => {
    const pool = new PackageWorkerPoolCtor(poolOptions());

    const first = pool.submit(poolJob('solo-a', true));
    const firstError = first.catch(err => err as Error);
    const queued = pool.submit(poolJob('solo-b', true));

    expect(jobNames(workers[0]!)).toEqual(['solo-a']);
    expect(jobNames(workers[1]!)).toEqual([]);

    workers[0]!.emitError(new Error('boom'));

    expect(await firstError).toMatchObject({ message: 'boom' });
    expect(jobNames(workers[0]!)).toEqual(['solo-a']);
    expect(jobNames(workers[1]!)).toEqual(['solo-b']);

    workers[1]!.emitMessage(resultFor(workers[1]!, 0));
    await expect(queued).resolves.toMatchObject({ pkgName: 'solo-b' });

    await pool.destroy();
  });

  it('rejects worker extraction errors and preserves the serialized worker stack', async () => {
    const pool = new PackageWorkerPoolCtor(poolOptions(1));
    const result = pool.submit(poolJob('broken'));
    const rejected: Promise<Error> = result.then(
      () => { throw new Error('Expected the worker extraction to reject'); },
      error => error as Error,
    );
    const message = jobMessages(workers[0]!)[0]!;

    workers[0]!.emitMessage({
      type: 'error',
      jobId: message.jobId,
      pkgName: message.pkg.name,
      message: 'plugin extract exploded',
      stack: 'Error: plugin extract exploded\n    at plugin.extract (plugin.ts:10:3)',
    });

    const error = await rejected;
    expect(error.message).toBe('plugin extract exploded');
    expect(error.stack).toContain('at plugin.extract (plugin.ts:10:3)');

    await pool.destroy();
  });

  it('shuts down gracefully without force-terminating a worker that exits on its own', async () => {
    const pool = new PackageWorkerPoolCtor(poolOptions());
    await pool.destroy();
    for (const worker of workers) {
      expect(worker.posted).toContainEqual({ type: 'shutdown' });
      // Graceful exit within the grace period → no terminate() racing the worker's child cleanup.
      expect(worker.terminateCalls).toBe(0);
    }
  });

  it('force-terminates a worker that overruns the shutdown grace period', async () => {
    const pool = new PackageWorkerPoolCtor({ ...poolOptions(1), shutdownGraceMs: 20 });
    workers[0]!.suppressExitOnShutdown = true;
    await pool.destroy();
    expect(workers[0]!.posted).toContainEqual({ type: 'shutdown' });
    expect(workers[0]!.terminateCalls).toBe(1); // no clean exit within grace → force-terminate backstop
  });

  // ── crash/hang hardening: a dead or misbehaving worker must never hang a caller promise ──

  it('a worker error rejects only that slot\'s job, not another slot\'s in-flight job', async () => {
    const pool = new PackageWorkerPoolCtor(poolOptions(2));
    const a = pool.submit(poolJob('a')); // → slot 0
    const b = pool.submit(poolJob('b')); // → slot 1
    const aCaught = a.catch(err => err as Error);
    expect(jobNames(workers[0]!)).toEqual(['a']);
    expect(jobNames(workers[1]!)).toEqual(['b']);

    workers[0]!.emitError(new Error('slot0 crashed'));

    expect(await aCaught).toMatchObject({ message: 'slot0 crashed' });
    // The other slot's job is unaffected — the old handler rejected ALL in-flight jobs.
    workers[1]!.emitMessage(resultFor(workers[1]!, 0));
    await expect(b).resolves.toMatchObject({ pkgName: 'b' });

    await pool.destroy();
  });

  it('postMessage failure while dispatching a queued job rejects it instead of hanging it', async () => {
    const pool = new PackageWorkerPoolCtor(poolOptions(1));
    const a = pool.submit(poolJob('a')); // → slot 0
    const b = pool.submit(poolJob('b')); // queued behind slot 0
    const bCaught = b.catch(err => err as Error);

    // The worker dies mid-run: its NEXT post (dispatching 'b' from inside 'a's message handler) throws.
    // There the submit-executor throw path does not exist, so without rollback 'b' never settles.
    workers[0]!.throwOnPost = true;
    workers[0]!.emitMessage(resultFor(workers[0]!, 0)); // 'a' done → drainQueue dispatches 'b' → throws

    await expect(a).resolves.toMatchObject({ pkgName: 'a' });
    expect(await bCaught).toMatchObject({ message: 'worker gone' }); // rolled back, not stranded pending

    await pool.destroy();
  });

  it('an unexpected worker exit (no preceding error) rejects its in-flight job', async () => {
    const pool = new PackageWorkerPoolCtor(poolOptions(1));
    const a = pool.submit(poolJob('a'));
    const aCaught = a.catch(err => err as Error);

    workers[0]!.emitExit(1); // OOM SIGKILL / process.exit inside the worker — no 'error' event

    expect(await aCaught).toMatchObject({ message: expect.stringContaining('exited unexpectedly') });
    await pool.destroy();
  });

  it('a messageerror (undeserializable reply) rejects the in-flight job instead of hanging it', async () => {
    const pool = new PackageWorkerPoolCtor(poolOptions(1));
    const a = pool.submit(poolJob('a'));
    const aCaught = a.catch(err => err as Error);

    workers[0]!.emitMessageError(new Error('DataCloneError'));

    expect(await aCaught).toMatchObject({ message: expect.stringContaining('DataCloneError') });
    await pool.destroy();
  });

  it('destroy() sweeps still-in-flight jobs so no caller promise hangs after teardown', async () => {
    const pool = new PackageWorkerPoolCtor(poolOptions(1));
    const a = pool.submit(poolJob('a'));
    const aCaught = a.catch(err => err as Error);

    await pool.destroy(); // worker terminated without replying — the in-flight job must be rejected, not left pending

    expect(await aCaught).toMatchObject({ message: 'worker pool destroyed' });
  });

  it('a stray reply for a non-current jobId does not free a busy slot (one-job-per-slot)', async () => {
    const pool = new PackageWorkerPoolCtor(poolOptions(1));
    const a = pool.submit(poolJob('a')); // → slot 0, currentJobId = 'a'
    const b = pool.submit(poolJob('b')); // queued behind slot 0

    // A stray/duplicate reply for a jobId the slot is NOT running must be ignored — freeing the slot here
    // would dispatch 'b' to a worker still busy with 'a' (two jobs, one worker).
    workers[0]!.emitMessage({ type: 'result', jobId: 999_999, modules: [], reused: 0, rescanned: 0 });
    expect(jobNames(workers[0]!)).toEqual(['a']); // 'b' NOT dispatched — the slot is still busy with 'a'

    // The real completion of 'a' frees the slot; 'b' then dispatches.
    workers[0]!.emitMessage(resultFor(workers[0]!, 0));
    await expect(a).resolves.toMatchObject({ pkgName: 'a' });
    expect(jobNames(workers[0]!)).toEqual(['a', 'b']);
    workers[0]!.emitMessage(resultFor(workers[0]!, 1));
    await expect(b).resolves.toMatchObject({ pkgName: 'b' });

    await pool.destroy();
  });

  it('submit() after every worker died rejects instead of queueing a job that can never run', async () => {
    const pool = new PackageWorkerPoolCtor(poolOptions(1));
    const a = pool.submit(poolJob('a'));
    const aCaught = a.catch(err => err as Error);
    workers[0]!.emitMessageError(new Error('DataCloneError')); // kills the only slot

    expect(await aCaught).toMatchObject({ message: expect.stringContaining('DataCloneError') });
    // Terminal-failed pool: a new submit must reject, not hang in a queue no live worker can drain.
    await expect(pool.submit(poolJob('b'))).rejects.toThrow('no live workers');

    await pool.destroy();
  });
});

describe('python subprocess teardown', () => {
  it('terminateLivePythonChildren SIGKILLs and reaps a tracked child (no orphan/zombie)', async () => {
    // A real long-lived child stands in for the `python -c` AST subprocess.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', reject);
    });
    __trackLivePythonChildForTest(child);
    expect(child.exitCode).toBeNull(); // alive before teardown

    await terminateLivePythonChildren();

    expect(child.killed).toBe(true);
    // 'exit' fired (awaited) → the child was reaped, not left as a zombie.
    expect(child.signalCode === 'SIGKILL' || child.exitCode !== null).toBe(true);
  });

  it('the python source plugin exposes terminateInFlight so the worker can kill children on shutdown', () => {
    expect(typeof pythonSourcePlugin.terminateInFlight).toBe('function');
  });
});
