import { describe, expect, it } from '@jest/globals';
import { createEmptyGraph, emptyGraphDelta } from '../../../../src/graph/index.js';
import type { Interpreter } from '../../../../src/interpreter/types.js';
import { composeInterpreters } from '../../../../src/stage2/interpreter/composer.js';
import type { ModuleInfo, RepositoryFactsSnapshot } from '../../../../src/types.js';

function moduleInfo(
  id: string,
  sourcePluginId: string,
  semanticHints?: ModuleInfo['semanticHints'],
): ModuleInfo {
  return {
    id,
    packageName: 'pkg',
    filePath: `/repo/${id}.ts`,
    relativeFilePath: `${id}.ts`,
    contentHash: id,
    imports: [],
    exports: [],
    sourcePluginId,
    semanticHints,
  };
}

function snapshot(modules: ModuleInfo[]): RepositoryFactsSnapshot {
  return {
    repoRoot: '/repo',
    timestamp: '2026-06-13T00:00:00.000Z',
    packages: [{ name: 'pkg', path: '.', sourcePluginId: modules[0]?.sourcePluginId }],
    modules,
  };
}

function runInterpreters(
  interpreters: Interpreter[],
  modules: ModuleInfo[] = [moduleInfo('a', 'typescript')],
  warnings: string[] = [],
) {
  const snap = snapshot(modules);
  return composeInterpreters({
    graph: createEmptyGraph(),
    snapshot: snap,
    modulesById: new Map(modules.map(mod => [mod.id, mod])),
    interpreters,
    logger: (level, message) => {
      if (level === 'warn' || level === 'error') warnings.push(message);
    },
  });
}

describe('stage2 interpreter composer', () => {
  it('topo-sorts enabled interpreters by requiresInterpreters[]', () => {
    const ran: string[] = [];
    const a: Interpreter = {
      id: 'a',
      sourceAdapterIds: '*',
      contributeGraph: () => { ran.push('a'); return emptyGraphDelta(); },
    };
    const b: Interpreter = {
      id: 'b',
      sourceAdapterIds: '*',
      requiresInterpreters: ['a'],
      contributeGraph: () => { ran.push('b'); return emptyGraphDelta(); },
    };

    const result = runInterpreters([b, a]);

    expect(result.appliedInterpreterIds).toEqual(['a', 'b']);
    expect(ran).toEqual(['a', 'b']);
  });

  it('throws a clear error for requiresInterpreters[] cycles', () => {
    const a: Interpreter = { id: 'a', sourceAdapterIds: '*', requiresInterpreters: ['b'] };
    const b: Interpreter = { id: 'b', sourceAdapterIds: '*', requiresInterpreters: ['a'] };

    expect(() => runInterpreters([a, b])).toThrow(/cycle/i);
  });

  it('throws for a missing requiresInterpreters[] dependency', () => {
    const layer: Interpreter = {
      id: 'needs-missing',
      sourceAdapterIds: '*',
      requiresInterpreters: ['missing-interpreter'],
      contributeGraph: () => emptyGraphDelta(),
    };

    expect(() => runInterpreters([layer])).toThrow(/missing-interpreter/);
  });

  it('propagates a contributeGraph() failure (interpreters are first-party, not swallowed)', () => {
    const layer: Interpreter = {
      id: 'boom',
      sourceAdapterIds: '*',
      contributeGraph: () => { throw new Error('contributeGraph boom'); },
    };

    expect(() => runInterpreters([layer])).toThrow(/contributeGraph boom/);
  });

  it('filters interpreters by sourceAdapterIds sourcePluginId', () => {
    const ran: string[] = [];
    const ts: Interpreter = {
      id: 'ts',
      sourceAdapterIds: ['typescript'],
      contributeGraph: () => { ran.push('ts'); return emptyGraphDelta(); },
    };
    const py: Interpreter = {
      id: 'py',
      sourceAdapterIds: ['python'],
      contributeGraph: () => { ran.push('py'); return emptyGraphDelta(); },
    };

    const result = runInterpreters([ts, py], [moduleInfo('a', 'typescript')]);

    expect(result.appliedInterpreterIds).toEqual(['ts']);
    expect(result.skippedInterpreterIds).toEqual(['py']);
    expect(ran).toEqual(['ts']);
  });

  it('short-circuits requiresSemanticHints when no module has a requested semanticHints key', () => {
    const ran: string[] = [];
    const routesLayer: Interpreter = {
      id: 'routes',
      sourceAdapterIds: '*',
      requiresSemanticHints: ['routes'],
      contributeGraph: () => { ran.push('routes'); return emptyGraphDelta(); },
    };

    const skipped = runInterpreters([routesLayer], [moduleInfo('a', 'typescript')]);
    const applied = runInterpreters([routesLayer], [moduleInfo('a', 'typescript', { routes: [] })]);

    expect(skipped.appliedInterpreterIds).toEqual([]);
    expect(skipped.skippedInterpreterIds).toEqual(['routes']);
    expect(applied.appliedInterpreterIds).toEqual(['routes']);
    expect(ran).toEqual(['routes']);
  });

  it('merges collectEntrypoints fragments in stable topo order', () => {
    const a: Interpreter = {
      id: 'a',
      sourceAdapterIds: '*',
      collectEntrypoints: () => [{ kind: 'api', id: 'a' }],
    };
    const b: Interpreter = {
      id: 'b',
      sourceAdapterIds: '*',
      requiresInterpreters: ['a'],
      collectEntrypoints: () => [{ kind: 'api', id: 'b' }],
    };

    const first = runInterpreters([b, a]).entrypoints;
    const second = runInterpreters([b, a]).entrypoints;

    expect(first).toEqual([{ kind: 'api', id: 'a' }, { kind: 'api', id: 'b' }]);
    expect(second).toEqual(first);
  });

  it('is a no-op with an empty interpreter set', () => {
    const graph = createEmptyGraph();
    const modules = [moduleInfo('a', 'typescript')];
    const snap = snapshot(modules);
    const before = JSON.stringify({ nodes: [...graph.nodes], edges: graph.edges });

    const result = composeInterpreters({
      graph,
      snapshot: snap,
      modulesById: new Map(modules.map(mod => [mod.id, mod])),
      interpreters: [],
    });

    expect(result).toEqual({ appliedInterpreterIds: [], skippedInterpreterIds: [], entrypoints: [] });
    expect(JSON.stringify({ nodes: [...graph.nodes], edges: graph.edges })).toBe(before);
  });
});
