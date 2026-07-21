import { describe, expect, it, jest } from '@jest/globals';
import { ReloadConfigRunner, type ReloadConfigDeps } from '../../../src/mcp/reload-config.js';

// H3 / R6c: the reloadConfig lifecycle — single-flight coalescing, cancellation checkpoints after the
// runtime build and (final) immediately before the swap, and the shutdown abortActive() handle.

type Cfg = { name: string };
type Ctx = { id: number };

interface Fakes {
  deps: ReloadConfigDeps<Cfg, Ctx>;
  calls: string[];
  buildCount: () => number;
  publishCount: () => number;
}

function makeFakes(overrides: Partial<ReloadConfigDeps<Cfg, Ctx>> = {}): Fakes {
  const calls: string[] = [];
  let builds = 0;
  let publishes = 0;
  const deps: ReloadConfigDeps<Cfg, Ctx> = {
    loadNextConfig: () => { calls.push('loadNextConfig'); return { name: 'next' }; },
    buildRuntime: async () => { calls.push('buildRuntime'); builds++; return { id: builds }; },
    drainOutgoing: async () => { calls.push('drainOutgoing'); return undefined; },
    reloadIncoming: async () => { calls.push('reloadIncoming'); },
    publish: () => { calls.push('publish'); publishes++; },
    ...overrides,
  };
  return { deps, calls, buildCount: () => builds, publishCount: () => publishes };
}

describe('ReloadConfigRunner (H3 / R6c)', () => {
  it('runs load → build → drain → reload → publish and reports configReloaded', async () => {
    const f = makeFakes();
    const runner = new ReloadConfigRunner(f.deps);

    await expect(runner.run()).resolves.toEqual({ configReloaded: true });
    expect(f.calls).toEqual(['loadNextConfig', 'buildRuntime', 'drainOutgoing', 'reloadIncoming', 'publish']);
    expect(runner.isInFlight).toBe(false); // cleared after settle — the runner is reusable
  });

  it('coalesces concurrent calls onto one in-flight swap (single-flight)', async () => {
    const f = makeFakes();
    const runner = new ReloadConfigRunner(f.deps);

    const first = runner.run();
    const second = runner.run();
    expect(second).toBe(first);
    await first;
    expect(f.buildCount()).toBe(1);
  });

  it('propagates a drain warning into the result and the observer', async () => {
    const onDrainWarning = jest.fn();
    const f = makeFakes({ drainOutgoing: async () => 'disk full', onDrainWarning });
    const runner = new ReloadConfigRunner(f.deps);

    await expect(runner.run()).resolves.toEqual({ configReloaded: true, drainWarning: 'disk full' });
    expect(onDrainWarning).toHaveBeenCalledWith('disk full');
  });

  it('H3: a cancel landing during drain/reload rejects BEFORE the swap — publish is never called', async () => {
    const ac = new AbortController();
    // The abort lands while the incoming store reloads: the final pre-swap checkpoint must catch it.
    const f = makeFakes({ reloadIncoming: async () => { ac.abort(); } });
    const runner = new ReloadConfigRunner(f.deps);

    await expect(runner.run(ac.signal)).rejects.toThrow();
    expect(f.publishCount()).toBe(0); // the ready runtime was preserved
    expect(runner.isInFlight).toBe(false);
  });

  it('a cancel landing during the runtime build rejects before the outgoing store is drained', async () => {
    const ac = new AbortController();
    // The fake build ignores the signal and resolves anyway — the post-build checkpoint must catch it.
    const f = makeFakes({ buildRuntime: async () => { ac.abort(); return { id: 99 }; } });
    const runner = new ReloadConfigRunner(f.deps);

    await expect(runner.run(ac.signal)).rejects.toThrow();
    expect(f.calls).not.toContain('drainOutgoing');
    expect(f.publishCount()).toBe(0);
  });

  it('abortActive() aborts the in-flight build signal and resolves once the run settles', async () => {
    let releaseBuild: (() => void) | undefined;
    let buildSignal: AbortSignal | undefined;
    const f = makeFakes({
      buildRuntime: (_cfg, signal) => new Promise((resolve) => {
        buildSignal = signal;
        releaseBuild = () => resolve({ id: 1 });
      }),
    });
    const runner = new ReloadConfigRunner(f.deps);

    const run = runner.run();
    const rejected = run.catch(err => err as Error);
    const abort = runner.abortActive();
    expect(buildSignal?.aborted).toBe(true); // shutdown reaches the build even with no request signal

    releaseBuild!(); // the build settles; the post-build checkpoint rejects the run
    await abort; // abortActive resolves only after the run settles (pool teardown has finished)
    expect((await rejected as Error).name).toBe('AbortError'); // DOMException from throwIfAborted
    expect(f.publishCount()).toBe(0);
  });

  it('abortActive() on an idle runner is a no-op', async () => {
    const runner = new ReloadConfigRunner(makeFakes().deps);
    await expect(runner.abortActive()).resolves.toBeUndefined();
  });

  it('the runner is reusable after a cancelled run', async () => {
    const ac = new AbortController();
    const f = makeFakes({ reloadIncoming: async () => { ac.abort(); } });
    const runner = new ReloadConfigRunner(f.deps);
    await expect(runner.run(ac.signal)).rejects.toThrow();

    // Reuse the SAME runner with no request signal: the cancelled flight must have cleared both its
    // shared promise and owned controller, so a fresh full sequence can publish normally.
    await expect(runner.run()).resolves.toEqual({ configReloaded: true });
    expect(f.buildCount()).toBe(2);
    expect(f.publishCount()).toBe(1);
  });
});
