import { describe, it, expect, beforeAll, beforeEach, afterAll, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RepovineRuntime } from '../../../src/mcp/context.js';
import { IndexBuildController } from '../../../src/mcp/build-controller.js';
import { readBoundaryIndex } from '../../../src/mcp/boundary-index.js';
import { CONFIG_DEFAULTS } from '../../../src/config.js';
import { copyFixtureDirSync } from '../../helpers/fixture-copy.js';

/** RepovineRuntime integration tests focus on graph refresh/cache — not semantic search. */
const TEST_APP_CONFIG = { ...CONFIG_DEFAULTS, semanticSearchEmbeddings: false };

function resolveEngineRoot(): string {
  const candidates = [
    process.cwd(),
    path.resolve(process.cwd(), 'repovine'),
  ];
  const found = candidates.find((root) =>
    fs.existsSync(path.join(root, 'src', 'stage1', 'index.ts')),
  );
  if (!found) throw new Error('repovine engine root not found from test cwd');
  return found;
}

function findFixtureSrc(): string {
  const candidates = [
    path.resolve(process.cwd(), 'test', 'fixtures', 'basic-typescript'),
    path.resolve(process.cwd(), 'repovine', 'test', 'fixtures', 'basic-typescript'),
  ];
  const root = candidates.find(candidate => fs.existsSync(candidate));
  if (!root) throw new Error(`Could not find basic-typescript fixture. Tried: ${candidates.join(', ')}`);
  return root;
}

describe('RepovineRuntime.refresh with IndexBuildController hooks', () => {
  let tmpRoot: string;
  let fixtureRoot: string;
  let artifactsDir: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-refresh-hooks-'));
    fixtureRoot = path.join(tmpRoot, 'basic-typescript');
    copyFixtureDirSync(findFixtureSrc(), fixtureRoot);
    artifactsDir = path.join(tmpRoot, '.repovine');
    fs.mkdirSync(artifactsDir, { recursive: true });
  });

  // Re-copy the fixture fresh per test so a test that mutates source in place
  // (dirty-skip appends to utils.ts) does not leak state into sibling tests.
  beforeEach(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    copyFixtureDirSync(findFixtureSrc(), fixtureRoot);
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('does not regress IndexBuildController from ready back to stage3', async () => {
    const controller = new IndexBuildController();
    const ctx = await controller.start(() =>
      RepovineRuntime.create(fixtureRoot, artifactsDir, TEST_APP_CONFIG, { hooks: controller }),
    );

    expect(controller.isReady()).toBe(true);
    expect(controller.snapshot().stage).toBe('ready');

    await ctx.refresh();

    expect(controller.isReady()).toBe(true);
    expect(controller.snapshot().stage).toBe('ready');
  });

  it('shares one in-flight rebuild across concurrent refresh calls', async () => {
    const controller = new IndexBuildController();
    const ctx = await controller.start(() =>
      RepovineRuntime.create(fixtureRoot, artifactsDir, TEST_APP_CONFIG, { hooks: controller }),
    );
    let refreshCallbacks = 0;
    ctx.onRefresh(() => { refreshCallbacks++; });

    const first = ctx.refresh();
    const second = ctx.refresh();

    expect(second).toBe(first);
    const [firstStats, secondStats] = await Promise.all([first, second]);
    expect(secondStats).toEqual(firstStats);
    expect(refreshCallbacks).toBe(1);
    expect(controller.isReady()).toBe(true);
    expect(controller.snapshot().stage).toBe('ready');
  });

  it('reuses the annotation store across refresh so an in-flight write is not orphaned', async () => {
    const ctx = await RepovineRuntime.create(fixtureRoot, artifactsDir, TEST_APP_CONFIG);
    const storeBefore = ctx.getState().annotations;
    const nodeId = [...ctx.getState().graph.nodes.keys()].find(id => id.startsWith('mod:'));
    expect(nodeId).toBeDefined();

    // Write, but leave it in memory (debounced — not flushed to disk yet).
    storeBefore.set(nodeId!, {
      nodeId: nodeId!,
      nodeType: 'module',
      contentHash: 'reuse-test-hash',
      pass: 1,
      updatedAt: new Date().toISOString(),
      annotation: { summary: 'reuse-test annotation held only in memory' },
      schemaVersion: 2,
    } as unknown as Parameters<typeof storeBefore.set>[1]);

    await ctx.refresh();

    const storeAfter = ctx.getState().annotations;
    // Same instance — the old store (and its debounce timer) is not discarded on the swap.
    expect(storeAfter).toBe(storeBefore);
    // The write held only in memory survives the reload-from-disk (no disk/active divergence).
    expect(storeAfter.get(nodeId!)?.annotation.summary).toBe('reuse-test annotation held only in memory');

    await storeAfter.drain();
  });

  it('emits a path-keyed boundary index alongside the build', async () => {
    await RepovineRuntime.create(fixtureRoot, artifactsDir, TEST_APP_CONFIG);
    // Build emission lands under <repoRoot>/.repovine, same convention as onboarding-state.
    const index = readBoundaryIndex(fixtureRoot);
    expect(index?.version).toBe(1);
    expect(typeof index?.entries).toBe('object');
    // The basic-typescript fixture declares no scope:"boundary" risks, so the map is empty but present.
    expect(index?.entries).toEqual({});
  });

  it('writes the snapshot cache to the context artifactsDir, not the process workspace (no cache clobber)', async () => {
    const controller = new IndexBuildController();
    await controller.start(() =>
      RepovineRuntime.create(fixtureRoot, artifactsDir, TEST_APP_CONFIG, { hooks: controller }),
    );

    // The cache must land under THIS context's artifactsDir, scoped to its own repoRoot — not the
    // global paths.cacheDir (which would overwrite the workspace's real snapshot cache).
    const cacheFile = path.join(artifactsDir, '.cache', 'repository-facts-snapshot.json');
    expect(fs.existsSync(cacheFile)).toBe(true);
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as { repoRoot?: string };
    expect(cached.repoRoot).toBe(fixtureRoot);
  });

  it('refresh uses async-first path (no collect-sync-bridge)', async () => {
    const bridgeAdjacent = path.join(resolveEngineRoot(), 'src', 'stage1', 'collect-sync-bridge.js');
    expect(fs.existsSync(bridgeAdjacent)).toBe(false);

    const controller = new IndexBuildController();
    const ctx = await controller.start(() =>
      RepovineRuntime.create(fixtureRoot, artifactsDir, TEST_APP_CONFIG, { hooks: controller }),
    );

    const { after } = await ctx.refresh();
    expect(after.totalNodes).toBeGreaterThan(0);
  });

  it('dirty-skip: a no-op refresh rebuilds the same graph; a content change grows it', async () => {
    const ad = path.join(tmpRoot, '.repovine-dirtyskip');
    fs.rmSync(ad, { recursive: true, force: true });
    const ctx = await RepovineRuntime.create(fixtureRoot, ad, TEST_APP_CONFIG);
    const cacheFile = path.join(ad, '.cache', 'repository-facts-snapshot.json');
    expect(fs.existsSync(cacheFile)).toBe(true);

    // No source changed → the rebuild yields the identical graph. Observe this
    // structurally (node/edge counts + byte-identical snapshot), not via wall-clock mtime.
    const snapshotBefore = fs.readFileSync(cacheFile, 'utf-8');
    const noop = await ctx.refresh();
    expect(noop.after.totalNodes).toBe(noop.before.totalNodes);
    expect(noop.after.totalEdges).toBe(noop.before.totalEdges);
    expect(fs.readFileSync(cacheFile, 'utf-8')).toBe(snapshotBefore);

    // A content change adds a new exported symbol → the graph grows and the
    // persisted snapshot is rewritten with different bytes.
    fs.appendFileSync(path.join(fixtureRoot, 'src', 'utils.ts'), '\nexport const __dirtySkipProbe = 1;\n');
    const changed = await ctx.refresh();
    expect(changed.after.totalNodes).toBeGreaterThan(changed.before.totalNodes);
    expect(fs.readFileSync(cacheFile, 'utf-8')).not.toBe(snapshotBefore);
  });

  it('can replace the ready runtime after a config reload rebuild', async () => {
    const controller = new IndexBuildController();
    const ctx = await controller.start(() =>
      RepovineRuntime.create(fixtureRoot, artifactsDir, TEST_APP_CONFIG, { hooks: controller }),
    );
    const reloadedArtifactsDir = path.join(tmpRoot, '.repovine-reloaded');
    const reloaded = await RepovineRuntime.create(fixtureRoot, reloadedArtifactsDir, {
      ...TEST_APP_CONFIG,
      build: {
        ...TEST_APP_CONFIG.build,
        scan: {
          ...TEST_APP_CONFIG.build.scan,
          exclude: ['**/*.ts'],
        },
      },
    });

    expect(controller.getCtx()).toBe(ctx);
    controller.replaceReadyContext(reloaded);

    expect(controller.isReady()).toBe(true);
    expect(controller.snapshot().stage).toBe('ready');
    expect(controller.getCtx()).toBe(reloaded);
  });
});

describe('RepovineRuntime.create cooperative cancel', () => {
  let tmpRoot: string;
  let fixtureRoot: string;
  let artifactsDir: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-cancel-'));
    fixtureRoot = path.join(tmpRoot, 'basic-typescript');
    copyFixtureDirSync(findFixtureSrc(), fixtureRoot);
    artifactsDir = path.join(tmpRoot, '.repovine');
    fs.mkdirSync(artifactsDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('aborts between Stage 1 and Stage 2 (before composeRepositoryGraph) when the signal fires', async () => {
    const ac = new AbortController();

    // basic-typescript is a single package: Stage 1 completes after its one package, then the
    // between-stage checkpoint sees the aborted signal and throws before Stage 2 runs.
    await expect(
      RepovineRuntime.create(fixtureRoot, artifactsDir, TEST_APP_CONFIG, {
        signal: ac.signal,
        hooks: { onPackageDone: () => ac.abort() },
      }),
    ).rejects.toThrow();

    // Cancel discards Stage 1 output: no snapshot cache is written on the aborted path.
    const cacheFile = path.join(artifactsDir, '.cache', 'repository-facts-snapshot.json');
    expect(fs.existsSync(cacheFile)).toBe(false);
  });
});

describe('RepovineRuntime.refresh per-request cancellation (refcounted)', () => {
  let tmpRoot: string;
  let fixtureRoot: string;
  let artifactsDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-refresh-cancel-'));
    fixtureRoot = path.join(tmpRoot, 'basic-typescript');
    copyFixtureDirSync(findFixtureSrc(), fixtureRoot);
    artifactsDir = path.join(tmpRoot, '.repovine');
    fs.mkdirSync(artifactsDir, { recursive: true });
  });

  afterAll(() => {
    // beforeEach makes a fresh tmpRoot per test; clean the last one.
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('a cancelled refresh rejects and preserves the ready graph (no partial swap)', async () => {
    const ctx = await RepovineRuntime.create(fixtureRoot, artifactsDir, TEST_APP_CONFIG);
    const stateBefore = ctx.getState();
    const nodesBefore = stateBefore.graph.nodes.size;

    const ac = new AbortController();
    const p = ctx.refresh(ac.signal);
    ac.abort(); // cancel before the build's first checkpoint (build runs on the microtask queue)

    await expect(p).rejects.toThrow();
    // The ready state is untouched: the assignment happens only if the build resolves.
    expect(ctx.getState()).toBe(stateBefore);
    expect(ctx.getState().graph.nodes.size).toBe(nodesBefore);
  });

  it('does not abort a shared refresh when only one of two attached callers cancels', async () => {
    const ctx = await RepovineRuntime.create(fixtureRoot, artifactsDir, TEST_APP_CONFIG);
    const ac1 = new AbortController();
    const ac2 = new AbortController();

    const p1 = ctx.refresh(ac1.signal);
    const p2 = ctx.refresh(ac2.signal); // joins the same in-flight build
    expect(p2).toBe(p1);

    ac1.abort(); // one caller cancels; ac2 still wants the rebuild → it must complete

    await expect(p1).resolves.toEqual(expect.objectContaining({ after: expect.anything() }));
  });

  it('aborts a shared refresh once every attached caller has cancelled', async () => {
    const ctx = await RepovineRuntime.create(fixtureRoot, artifactsDir, TEST_APP_CONFIG);
    const ac1 = new AbortController();
    const ac2 = new AbortController();

    const p1 = ctx.refresh(ac1.signal);
    ctx.refresh(ac2.signal);

    ac1.abort();
    ac2.abort(); // now nobody wants it → the build aborts

    await expect(p1).rejects.toThrow();
  });

  it('an unconditional (signal-less) caller keeps the rebuild alive despite a cancel', async () => {
    const ctx = await RepovineRuntime.create(fixtureRoot, artifactsDir, TEST_APP_CONFIG);
    const ac = new AbortController();

    const p1 = ctx.refresh(ac.signal);
    const p2 = ctx.refresh(); // no signal → uncancellable
    expect(p2).toBe(p1);

    ac.abort(); // the only signalled caller cancels, but an unconditional caller remains

    await expect(p1).resolves.toEqual(expect.objectContaining({ after: expect.anything() }));
  });

  // At shutdown nobody consumes the refresh result, so the force-abort must bypass the refcount —
  // an UNCONDITIONAL caller (which the refcount protects forever) must not keep the worker pool alive.
  it('abortActiveRefresh() force-aborts an unconditional refresh and preserves the ready state', async () => {
    const ctx = await RepovineRuntime.create(fixtureRoot, artifactsDir, TEST_APP_CONFIG);
    const stateBefore = ctx.getState();

    const p = ctx.refresh(); // signal-less: the refcount would never abort this build
    await ctx.abortActiveRefresh(); // resolves only after the build settled

    await expect(p).rejects.toThrow();
    expect(ctx.getState()).toBe(stateBefore); // no partial swap
  });

  it('abortActiveRefresh() on an idle runtime is a no-op', async () => {
    const ctx = await RepovineRuntime.create(fixtureRoot, artifactsDir, TEST_APP_CONFIG);
    await expect(ctx.abortActiveRefresh()).resolves.toBeUndefined();
    // The runtime still refreshes normally afterwards.
    await expect(ctx.refresh()).resolves.toEqual(expect.objectContaining({ after: expect.anything() }));
  });
});

describe('Stage 3 cancel checkpoint after annotation load', () => {
  let tmpRoot: string;
  let fixtureRoot: string;
  let artifactsDir: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-stage3-cancel-'));
    fixtureRoot = path.join(tmpRoot, 'basic-typescript');
    copyFixtureDirSync(findFixtureSrc(), fixtureRoot);
    artifactsDir = path.join(tmpRoot, '.repovine');
    fs.mkdirSync(artifactsDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('an abort during ready-runtime reload preserves the published state and shared store', async () => {
    const ctx = await RepovineRuntime.create(fixtureRoot, artifactsDir, TEST_APP_CONFIG);
    const stateBefore = ctx.getState();
    const store = stateBefore.annotations;
    const ac = new AbortController();
    const externalNodeId = 'mod:external-during-cancelled-refresh';
    const annotationPath = path.join(fixtureRoot, 'repovine.annots.json');
    const externalContent = JSON.stringify({
      version: 1,
      annotations: { [externalNodeId]: {
        nodeId: externalNodeId,
        nodeType: 'module',
        contentHash: 'external-hash',
        pass: 1,
        updatedAt: new Date().toISOString(),
        annotation: { summary: 'must not surface through a cancelled refresh' },
        schemaVersion: 2,
      } },
    }, null, 2);
    fs.writeFileSync(annotationPath, externalContent);

    // The lock is taken from outside first, so the reload is genuinely waiting for it when the abort
    // lands. Aborting right after the call would not test anything any more: the lock's transaction is
    // now one synchronous stretch, so an uncontended reload has already committed by the time control
    // returns — there is no window between taking the lock and reading, which is the point of the fix
    // in `withAnnotationFileLockAsync`. Contention is the window that legitimately remains, and the
    // checkpoint inside the transaction is what has to hold there.
    const lockPath = `${annotationPath}.lock`;
    fs.writeFileSync(lockPath, String(process.pid));

    const realReload = store.reloadFromDisk.bind(store);
    const reloadSpy = jest.spyOn(store, 'reloadFromDisk').mockImplementation(async options => {
      expect(options?.signal).toBeDefined(); // active refresh signal is threaded into the shared store
      const reload = realReload(options);
      // A later turn: the reload is parked in the acquisition retry, holding nothing.
      setTimeout(() => {
        ac.abort();
        fs.rmSync(lockPath, { force: true }); // let the acquisition proceed, so the checkpoint decides
      }, 10);
      return reload;
    });
    try {
      await expect(ctx.refresh(ac.signal)).rejects.toThrow();
      expect(reloadSpy).toHaveBeenCalledTimes(1);
      expect(ctx.getState()).toBe(stateBefore); // ready graph/state was not swapped
      expect(ctx.getState().annotations).toBe(store); // refresh still owns the original shared store
      expect(store.get(externalNodeId)).toBeUndefined(); // reload made no cancelled mutation visible
      expect(fs.readFileSync(annotationPath, 'utf-8')).toBe(externalContent);
    } finally {
      fs.rmSync(lockPath, { force: true });
      reloadSpy.mockRestore();
    }
  });
});
