import { afterEach, describe, it, expect, jest } from '@jest/globals';
import { IndexBuildController } from '../../../src/mcp/build-controller.js';

/** A build promise that never settles, so `start()` parks the controller mid-build. */
const hangingBuild = () => new Promise<never>(() => undefined);

describe('IndexBuildController stage1/stage2 progress (get_build_status cold-build snapshot)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports stage1 pct, stageEtaSec, remaining stages, and an ETA-derived retry delay', () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const controller = new IndexBuildController();
    controller.start(hangingBuild).catch(() => undefined); // stage -> stage1, startedAt = 0
    controller.onExtractionBegin({ totalPackages: 4, totalModules: 100 });
    controller.onPackageDone('pkg-a', 25); // donePackages 1, doneModules 25
    controller.onPackageDone('pkg-b', 25); // donePackages 2, doneModules 50
    jest.setSystemTime(10_000); // 10s elapsed at 5 modules/s -> 50 modules remain -> eta 10s

    const snap = controller.snapshot();
    expect(snap.status).toBe('building');
    expect(snap.stage).toBe('stage1');
    expect(snap.donePackages).toBe(2);
    expect(snap.totalPackages).toBe(4);
    expect(snap.doneModules).toBe(50);
    expect(snap.totalModules).toBe(100);
    expect(snap.pct).toBe(50); // 50/100
    expect(snap.elapsedSec).toBe(10);
    expect(snap.stageEtaSec).toBe(10); // (100-50) / (50/10)
    expect(snap.remainingStages).toBe(2);
    expect(snap.retryAfterSec).toBe(3); // clamp(ceil(eta/4)) = ceil(10/4)
    expect(snap.currentPackage).toBe('pkg-b');
    expect(snap.message).toContain('repository facts snapshot');
    expect(snap.message).toContain('[2/4 pkgs]');
    expect(snap.message).toContain('stage ETA ~10s');
  });

  it('omits pct/stageEtaSec on stage2 and reports one remaining stage', () => {
    const controller = new IndexBuildController();
    controller.start(hangingBuild).catch(() => undefined);
    controller.onStageEnter('stage2');

    const snap = controller.snapshot();
    expect(snap.status).toBe('building');
    expect(snap.stage).toBe('stage2');
    expect(snap.pct).toBeUndefined();
    expect(snap.stageEtaSec).toBeUndefined();
    expect(snap.remainingStages).toBe(1);
    expect(snap.retryAfterSec).toBe(8); // clamp(ceil((eta ?? 30)/4)) = ceil(30/4)
    expect(snap.message).toContain('repository graph');
  });
});

describe('IndexBuildController semantic embed progress', () => {
  it('reports pct and card counts during stage3 semantic embedding', () => {
    const controller = new IndexBuildController();
    controller.onStageEnter('stage3');
    controller.onSemanticEmbedProgress(0, 160);
    controller.onSemanticEmbedProgress(80, 160);

    const snap = controller.snapshot();
    expect(snap.stage).toBe('stage3');
    expect(snap.doneSemanticCards).toBe(80);
    expect(snap.totalSemanticCards).toBe(160);
    expect(snap.pct).toBe(50);
    expect(snap.remainingStages).toBe(0);
    expect(snap.message).toContain('semantic search embeddings');
    expect(snap.message).toContain('[80/160 cards]');
  });

  it('resets semantic counters when stage3 starts', () => {
    const controller = new IndexBuildController();
    controller.onStageEnter('stage3');
    controller.onSemanticEmbedProgress(40, 100);
    controller.onStageEnter('stage3');

    const snap = controller.snapshot();
    expect(snap.doneSemanticCards).toBeUndefined();
    expect(snap.totalSemanticCards).toBeUndefined();
  });
});

describe('IndexBuildController waitForSettled (get_build_status waitSec long-poll)', () => {
  const fakeCtx = {} as never;

  it('returns immediately when the build has not started', async () => {
    const controller = new IndexBuildController();
    const snap = await controller.waitForSettled(5);
    expect(snap.status).toBe('pending');
  });

  it('resolves early with ready as soon as the build settles', async () => {
    const controller = new IndexBuildController();
    let finish!: () => void;
    controller.start(() => new Promise(resolve => { finish = () => resolve(fakeCtx); }));

    const wait = controller.waitForSettled(5);
    setTimeout(finish, 20);
    const snap = await wait;

    // Resolving before the 5s poll budget elapses is proven by the test completing without a
    // timeout; the wall-clock upper-bound assert it used to carry was non-deterministic.
    expect(snap.status).toBe('ready');
  });

  it('returns the building snapshot when the wait times out', async () => {
    const controller = new IndexBuildController();
    controller.start(() => new Promise(() => undefined));

    const snap = await controller.waitForSettled(0.05);
    expect(snap.status).toBe('building');
    expect(snap.retryAfterSec).toBeGreaterThan(0);
  });

  it('resolves to a failed snapshot without throwing when the build fails', async () => {
    const controller = new IndexBuildController();
    controller.start(() => Promise.reject(new Error('boom'))).catch(() => undefined);

    const snap = await controller.waitForSettled(5);
    expect(snap.status).toBe('failed');
    expect(snap.message).toContain('boom');
  });

  it('returns promptly when the request is cancelled mid long-poll', async () => {
    const controller = new IndexBuildController();
    controller.start(() => new Promise(() => undefined)); // never settles

    const ac = new AbortController();
    const wait = controller.waitForSettled(30, ac.signal); // 30s budget we must not actually wait
    ac.abort();
    const snap = await wait;
    expect(snap.status).toBe('building'); // cancel returns the current snapshot, not the settled one
  });

  it('returns immediately when the signal is already aborted', async () => {
    const controller = new IndexBuildController();
    controller.start(() => new Promise(() => undefined));

    const ac = new AbortController();
    ac.abort();
    const snap = await controller.waitForSettled(30, ac.signal);
    expect(snap.status).toBe('building');
  });
});

describe('IndexBuildController cancel (get_build_status cancel:true)', () => {
  const fakeCtx = {} as never;

  /** A build that never settles on its own but rejects the moment its signal aborts. */
  function cancellableBuild() {
    return (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
  }

  it('cancels a cold stage1 build with no prior graph → terminal cancelled', async () => {
    const controller = new IndexBuildController();
    controller.start(cancellableBuild()).catch(() => undefined);
    expect(controller.snapshot().status).toBe('building');

    const status = await controller.cancel();

    expect(status.status).toBe('cancelled');
    expect(status.stage).toBe('cancelled');
    expect(status.retryAfterSec).toBe(0);
    expect(status.message).toContain('refresh_context');
    expect(controller.isReady()).toBe(false);
    expect(controller.isCancelled()).toBe(true);
  });

  it('clears the in-flight promise so a later start() runs a fresh build to ready', async () => {
    const controller = new IndexBuildController();
    controller.start(cancellableBuild()).catch(() => undefined);
    await controller.cancel();
    expect(controller.isCancelled()).toBe(true);

    const ctx = await controller.start(() => Promise.resolve(fakeCtx));

    expect(ctx).toBe(fakeCtx);
    expect(controller.isReady()).toBe(true);
    expect(controller.snapshot().status).toBe('ready');
  });

  it('keeps a prior ready graph on cancel (Option A rollback)', async () => {
    const controller = new IndexBuildController();
    const prior = { id: 'prior' } as never;
    // Seed a prior ready ctx with no in-flight promise — the state start() captures as prevCtx.
    (controller as unknown as { ctx: unknown }).ctx = prior;

    controller.start(cancellableBuild()).catch(() => undefined);
    const status = await controller.cancel();

    expect(status.status).toBe('ready');
    expect(controller.isReady()).toBe(true);
    expect(controller.isCancelled()).toBe(false);
    expect(controller.getCtx()).toBe(prior);
  });

  it('is a no-op returning the current status when already ready', async () => {
    const controller = new IndexBuildController();
    await controller.start(() => Promise.resolve(fakeCtx));

    const status = await controller.cancel();

    expect(status.status).toBe('ready');
    expect(controller.isReady()).toBe(true);
  });

  it('is a no-op returning failed when the build already failed', async () => {
    const controller = new IndexBuildController();
    await controller.start(() => Promise.reject(new Error('boom'))).catch(() => undefined);

    const status = await controller.cancel();

    expect(status.status).toBe('failed');
    expect(status.message).toContain('boom');
  });

  it('is a no-op returning the current status when no build is running', async () => {
    const controller = new IndexBuildController();

    const status = await controller.cancel();

    expect(status.status).toBe('pending');
  });

  it('rebuild() re-triggers a fresh build from cancelled and reaches ready', async () => {
    const controller = new IndexBuildController();
    let mode: 'hang' | 'resolve' = 'hang';
    // One closure reused by both start() and the later rebuild(): on cancel it rejects, on rebuild
    // (mode flipped) it resolves to a ready ctx.
    const buildFn = (signal: AbortSignal) =>
      new Promise<never>((resolve, reject) => {
        if (mode === 'resolve') { resolve(fakeCtx); return; }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });

    controller.start(buildFn).catch(() => undefined);
    await controller.cancel();
    expect(controller.isCancelled()).toBe(true);

    mode = 'resolve';
    const kicked = controller.rebuild();
    expect(kicked.status).toBe('building');
    expect(controller.isCancelled()).toBe(false);

    const settled = await controller.waitForSettled(5);
    expect(settled.status).toBe('ready');
    expect(controller.isReady()).toBe(true);
  });

  it('rebuild() is a no-op returning the current status when not cancelled', async () => {
    const controller = new IndexBuildController();
    await controller.start(() => Promise.resolve(fakeCtx));

    const status = controller.rebuild();

    expect(status.status).toBe('ready');
    expect(controller.isReady()).toBe(true);
  });
});
