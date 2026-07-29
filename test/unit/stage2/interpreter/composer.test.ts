import { asRepoRelPath } from '@repovine/plugin-sdk';
import { asHostPath, asPkgRelPath } from '@repovine/plugin-sdk';
import { describe, expect, it } from '@jest/globals';
import { createEmptyGraph, emptyGraphDelta } from '../../../../src/graph/index.js';
import type { Interpreter } from '../../../../src/interpreter/types.js';
import { composeInterpreters } from '../../../../src/stage2/interpreter/composer.js';
import type { ModuleInfo, RepositoryFactsSnapshot, TemplateFileInfo } from '../../../../src/types.js';

function moduleInfo(
  id: string,
  sourcePluginId: string,
  semanticHints?: ModuleInfo['semanticHints'],
): ModuleInfo {
  return {
    id,
    packageName: 'pkg',
    absPath: asHostPath(`/repo/${id}.ts`),
    pkgRelPath: asPkgRelPath(`${id}.ts`),
    contentHash: id,
    imports: [],
    exports: [],
    sourcePluginId,
    semanticHints,
  };
}

function snapshot(modules: ModuleInfo[], templates?: TemplateFileInfo[]): RepositoryFactsSnapshot {
  return {
    repoRoot: '/repo',
    timestamp: '2026-06-13T00:00:00.000Z',
    packages: [{ name: 'pkg', repoRelDir: asRepoRelPath('.'), sourcePluginId: modules[0]?.sourcePluginId }],
    modules,
    ...(templates ? { templates } : {}),
  };
}

function runInterpreters(
  interpreters: Interpreter[],
  modules: ModuleInfo[] = [moduleInfo('a', 'typescript')],
  warnings: string[] = [],
  templates?: TemplateFileInfo[],
) {
  const snap = snapshot(modules, templates);
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
  it('applies the node phase before the link phase, whatever the input order', () => {
    const ran: string[] = [];
    const nodes: Interpreter = {
      id: 'nodes',
      phase: 'nodes',
      contributeGraph: () => { ran.push('nodes'); return emptyGraphDelta(); },
    };
    const links: Interpreter = {
      id: 'links',
      phase: 'links',
      contributeGraph: () => { ran.push('links'); return emptyGraphDelta(); },
    };

    const result = runInterpreters([links, nodes]);

    expect(result.appliedInterpreterIds).toEqual(['nodes', 'links']);
    expect(ran).toEqual(['nodes', 'links']);
  });

  it('rejects a duplicate interpreter id', () => {
    const first: Interpreter = { id: 'same', phase: 'nodes', contributeGraph: () => emptyGraphDelta() };
    const second: Interpreter = { id: 'same', phase: 'links', contributeGraph: () => emptyGraphDelta() };

    expect(() => runInterpreters([first, second])).toThrow(/Duplicate interpreter id "same"/);
  });

  it('propagates a contributeGraph() failure (interpreters are first-party, not swallowed)', () => {
    const layer: Interpreter = {
      id: 'boom',
      phase: 'nodes',
      contributeGraph: () => { throw new Error('contributeGraph boom'); },
    };

    expect(() => runInterpreters([layer])).toThrow(/contributeGraph boom/);
  });

  it('gates on the fact, not on the producer that published it', () => {
    const ran: string[] = [];
    const routesLayer: Interpreter = {
      id: 'routes',
      phase: 'links',
      requiresSemanticHints: ['routes'],
      contributeGraph: () => { ran.push('routes'); return emptyGraphDelta(); },
    };
    const hints: ModuleInfo['semanticHints'] = { routes: [] };

    // The same normalized hint under three different producer ids — including one the engine has
    // never heard of — enables the interpreter identically.
    for (const producer of ['typescript', 'python', 'not-a-built-in']) {
      const applied = runInterpreters([routesLayer], [moduleInfo('a', producer, hints)]);
      expect(applied.appliedInterpreterIds).toEqual(['routes']);
      expect(applied.skippedInterpreterIds).toEqual([]);
    }
    expect(ran).toEqual(['routes', 'routes', 'routes']);
  });

  it('short-circuits requiresSemanticHints when no module has a requested semanticHints key', () => {
    const ran: string[] = [];
    const routesLayer: Interpreter = {
      id: 'routes',
      phase: 'links',
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

  it('short-circuits requiresSnapshotFacts when the declared slot is empty', () => {
    const ran: string[] = [];
    const templatesLayer: Interpreter = {
      id: 'templates',
      phase: 'links',
      requiresSnapshotFacts: ['templates'],
      contributeGraph: () => { ran.push('templates'); return emptyGraphDelta(); },
    };
    const template: TemplateFileInfo = {
      id: 'template:index.html',
      relPath: 'index.html',
      contentHash: 'deadbeef',
    };

    const skipped = runInterpreters([templatesLayer]);
    const applied = runInterpreters([templatesLayer], undefined, undefined, [template]);

    expect(skipped.skippedInterpreterIds).toEqual(['templates']);
    expect(applied.appliedInterpreterIds).toEqual(['templates']);
    expect(ran).toEqual(['templates']);
  });

  it('merges collectEntrypoints fragments in stable phase order', () => {
    const nodes: Interpreter = {
      id: 'nodes',
      phase: 'nodes',
      collectEntrypoints: () => [{ kind: 'api', id: 'a' }],
    };
    const links: Interpreter = {
      id: 'links',
      phase: 'links',
      collectEntrypoints: () => [{ kind: 'api', id: 'b' }],
    };

    const first = runInterpreters([links, nodes]).entrypoints;
    const second = runInterpreters([links, nodes]).entrypoints;

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
