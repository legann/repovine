import { asRepoRelPath } from '@repovine/plugin-sdk';
import { asHostPath, asPkgRelPath } from '@repovine/plugin-sdk';
import { describe, it, expect } from '@jest/globals';
import { contributeStructural } from '../../../src/interpreters/code-structure/graph.js';
import { createEmptyGraph } from '../../../src/graph/index.js';
import { analyzeImpact } from '../../../src/mcp/lib/dependencies/impact.js';
import type { ModuleInfo, RepositoryFactsSnapshot, RepositoryGraph } from '../../../src/types.js';
import type { McpToolRuntime } from '../../../src/mcp/types.js';
import { deliveredValue } from '../../../src/response/refusal.js';

function snapshot(): RepositoryFactsSnapshot {
  const barrel: ModuleInfo = {
    id: 'mod:@shared/index', packageName: '@shared', absPath: asHostPath('/repo/shared/index.ts'), pkgRelPath: asPkgRelPath('index.ts'),
    contentHash: 'h1', imports: [], exports: [],
    reExports: [{ moduleSpecifier: './utils', resolvedModuleId: 'mod:@shared/utils', isStar: true, isExternal: false }],
  };
  const leaf: ModuleInfo = {
    id: 'mod:@shared/utils', packageName: '@shared', absPath: asHostPath('/repo/shared/utils.ts'), pkgRelPath: asPkgRelPath('utils.ts'),
    contentHash: 'h2', imports: [],
    exports: [{ name: 'slugify', kind: 'function', lineRange: { start: 1, end: 3 }, isDefault: false }],
  };
  // Cross-package consumer: imports { slugify } from '@shared' → resolves to the barrel entry.
  const consumer: ModuleInfo = {
    id: 'mod:@web/tool', packageName: '@web', absPath: asHostPath('/repo/web/tool.ts'), pkgRelPath: asPkgRelPath('tool.ts'),
    contentHash: 'h3',
    imports: [{ moduleSpecifier: '@shared', resolvedModuleId: 'mod:@shared/index', importedNames: ['slugify'], isTypeOnly: false, isExternal: false }],
    exports: [{ name: 'run', kind: 'function', lineRange: { start: 1, end: 3 }, isDefault: false, calls: ['slugify'] }],
  };
  return {
    repoRoot: '/repo', timestamp: '2024-01-01',
    packages: [{ name: '@shared', repoRelDir: asRepoRelPath('shared') }, { name: '@web', repoRelDir: asRepoRelPath('web') }],
    modules: [barrel, leaf, consumer],
  };
}

function build(): { graph: RepositoryGraph; modulesById: Map<string, ModuleInfo> } {
  const snap = snapshot();
  const graph = createEmptyGraph();
  contributeStructural(graph, snap);
  return { graph, modulesById: new Map(snap.modules.map(m => [m.id, m])) };
}

function runtime(graph: RepositoryGraph, modulesById: Map<string, ModuleInfo>): McpToolRuntime {
  return { getState: () => ({ graph, modulesById }) } as unknown as McpToolRuntime;
}

describe('Part 4 — cross-package barrel → leaf linking', () => {
  it('materializes a reexports edge barrel → leaf', () => {
    const { graph } = build();
    const hasReexport = graph.edges.some(e => e.from === 'mod:@shared/index' && e.to === 'mod:@shared/utils' && e.kind === 'reexports');
    expect(hasReexport).toBe(true);
  });

  it('redirects the barrel-routed import to the defining leaf with the imported name', () => {
    const { graph } = build();
    const edge = graph.edges.find(e => e.from === 'mod:@web/tool' && e.to === 'mod:@shared/utils' && e.kind === 'imports');
    expect(edge).toBeDefined();
    expect(edge?.metadata?.usedNames).toEqual(['slugify']);
  });

  it('flags the barrel-redirected edge isTypeOnly when the routed import is type-only', () => {
    const snap = snapshot();
    const consumer = snap.modules.find(m => m.id === 'mod:@web/tool');
    // Reroute the same barrel import as a type-only import; no value import reaches the leaf.
    consumer!.imports = [
      { moduleSpecifier: '@shared', resolvedModuleId: 'mod:@shared/index', importedNames: ['slugify'], isTypeOnly: true, isExternal: false },
    ];
    consumer!.exports = [{ name: 'run', kind: 'function', lineRange: { start: 1, end: 3 }, isDefault: false }];
    const graph = createEmptyGraph();
    contributeStructural(graph, snap);
    const edge = graph.edges.find(e => e.from === 'mod:@web/tool' && e.to === 'mod:@shared/utils' && e.kind === 'imports');
    expect(edge).toBeDefined();
    expect(edge?.metadata?.usedNames).toEqual(['slugify']);
    expect(edge?.metadata?.isTypeOnly).toBe(true);
  });

  it('does not flag the barrel-redirected edge isTypeOnly when a value import reaches the leaf', () => {
    const { graph } = build();
    const edge = graph.edges.find(e => e.from === 'mod:@web/tool' && e.to === 'mod:@shared/utils' && e.kind === 'imports');
    expect(edge).toBeDefined();
    expect(edge?.metadata?.isTypeOnly).toBeUndefined();
  });

  it('reverse query on the leaf export resolves the cross-package consumer (not name-only)', () => {
    const { graph, modulesById } = build();
    const result = deliveredValue(analyzeImpact(runtime(graph, modulesById), { nodeId: 'export:@shared/utils/slugify' })) as {
      downstream: Array<{ id: string; uses?: string[]; provenance?: { basis: string; method: string } }>;
    };
    const consumer = result.downstream.find(e => e.id === 'mod:@web/tool');
    expect(consumer).toBeDefined();
    expect(consumer?.uses).toContain('slugify');
    expect(consumer?.provenance).toBeUndefined();
  });
});
