import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { RepositoryFactsSnapshot } from '../../../src/types.js';

// Under REPOVINE_STAGE2_WORKER_STRICT a worker RUNTIME failure is a hard error — no silent inline
// fallback that would let the parity suite pass without ever crossing the worker boundary. Without
// strict, the same failure falls back to inline compose (production resilience unchanged).

/** Worker whose spawn immediately fails — models a broken/stale isolate at runtime, not a missing file. */
class FailingWorker {
  private readonly listeners = new Map<string, Array<(v: unknown) => void>>();
  constructor() {
    queueMicrotask(() => {
      for (const l of this.listeners.get('error') ?? []) l(new Error('worker exploded'));
    });
  }
  once(event: string, listener: (v: unknown) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }
  async terminate(): Promise<number> { return 0; }
}

function minimalSnapshot(): RepositoryFactsSnapshot {
  return {
    repoRoot: '/tmp/strict-offload-nonexistent',
    packages: [],
    modules: [],
    infraModules: [],
    templates: [],
  } as unknown as RepositoryFactsSnapshot;
}

describe('composeRepositoryGraphAsync strict worker mode', () => {
  const priorInline = process.env.REPOVINE_STAGE2_INLINE;
  const priorStrict = process.env.REPOVINE_STAGE2_WORKER_STRICT;

  afterEach(() => {
    jest.unstable_unmockModule('node:worker_threads');
    jest.resetModules();
    if (priorInline === undefined) delete process.env.REPOVINE_STAGE2_INLINE;
    else process.env.REPOVINE_STAGE2_INLINE = priorInline;
    if (priorStrict === undefined) delete process.env.REPOVINE_STAGE2_WORKER_STRICT;
    else process.env.REPOVINE_STAGE2_WORKER_STRICT = priorStrict;
  });

  async function importWithFailingWorker(): Promise<typeof import('../../../src/stage2/index.js')> {
    jest.resetModules();
    jest.unstable_mockModule('node:worker_threads', () => ({ Worker: FailingWorker, isMainThread: true }));
    return import('../../../src/stage2/index.js');
  }

  it('strict: a worker runtime failure rejects instead of silently composing inline', async () => {
    delete process.env.REPOVINE_STAGE2_INLINE; // jest.setup defaults to inline; exercise the worker path
    process.env.REPOVINE_STAGE2_WORKER_STRICT = '1';
    const { composeRepositoryGraphAsync } = await importWithFailingWorker();

    await expect(composeRepositoryGraphAsync(minimalSnapshot())).rejects.toThrow('worker exploded');
  });

  it('non-strict: the same failure falls back to inline compose and resolves', async () => {
    delete process.env.REPOVINE_STAGE2_INLINE;
    delete process.env.REPOVINE_STAGE2_WORKER_STRICT;
    const { composeRepositoryGraphAsync } = await importWithFailingWorker();

    const graph = await composeRepositoryGraphAsync(minimalSnapshot());
    expect(graph.nodes).toBeInstanceOf(Map); // the fallback composed a real graph inline instead of rejecting
  });
});
