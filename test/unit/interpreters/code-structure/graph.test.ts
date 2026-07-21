import { describe, expect, it } from '@jest/globals';
import { createEmptyGraph } from '../../../../src/graph/index.js';
import { contributeStructural } from '../../../../src/interpreters/code-structure/graph.js';
import type { ModuleInfo, RepositoryFactsSnapshot } from '../../../../src/types.js';

function snapshotOf(modules: ModuleInfo[]): RepositoryFactsSnapshot {
  return {
    repoRoot: '/repo',
    timestamp: '2026-06-13T00:00:00.000Z',
    packages: [{ name: 'app', path: 'packages/app', sourcePluginId: 'typescript' }],
    modules,
  };
}

describe('code-structure graph contribution', () => {
  it('builds root/package/module/import/export-symbol nodes and edges', () => {
    const alpha: ModuleInfo = {
      id: 'mod:app/alpha',
      packageName: 'app',
      filePath: '/repo/packages/app/alpha.ts',
      relativeFilePath: 'alpha.ts',
      contentHash: 'a',
      imports: [],
      exports: [{ name: 'Foo', kind: 'function', signature: 'function Foo(): void', lineRange: { start: 1, end: 3 }, isDefault: false }],
      sourcePluginId: 'typescript',
    };
    const beta: ModuleInfo = {
      id: 'mod:app/beta',
      packageName: 'app',
      filePath: '/repo/packages/app/beta.ts',
      relativeFilePath: 'beta.ts',
      contentHash: 'b',
      imports: [{ moduleSpecifier: './alpha', resolvedModuleId: 'mod:app/alpha', importedNames: ['Foo'], isTypeOnly: false, isExternal: false }],
      exports: [],
      sourcePluginId: 'typescript',
    };

    const graph = createEmptyGraph();
    contributeStructural(graph, snapshotOf([alpha, beta]));

    expect([...graph.byType.get('package') ?? []]).toEqual(['pkg:app']);
    expect([...graph.byType.get('module') ?? []]).toEqual(['mod:app/alpha', 'mod:app/beta']);
    expect([...graph.byType.get('export-symbol') ?? []]).toEqual(['export:app/alpha/Foo']);

    // root -> pkg, pkg -> modules, and module -> export-symbol are contains edges; beta -> alpha is imports.
    expect(graph.edges).toEqual(expect.arrayContaining([
      { from: 'root', to: 'pkg:app', kind: 'contains' },
      { from: 'pkg:app', to: 'mod:app/alpha', kind: 'contains' },
      { from: 'pkg:app', to: 'mod:app/beta', kind: 'contains' },
      { from: 'mod:app/alpha', to: 'export:app/alpha/Foo', kind: 'contains' },
      { from: 'mod:app/beta', to: 'mod:app/alpha', kind: 'imports' },
    ]));

    // Module node preserves the data fields the handoff requires to stay byte-identical.
    expect(graph.nodes.get('mod:app/alpha')?.data).toMatchObject({
      filePath: '/repo/packages/app/alpha.ts',
      relativeFilePath: 'alpha.ts',
      sourcePluginId: 'typescript',
    });
  });

  it('flags a pure `import type` edge with metadata.isTypeOnly; a mixed value+type edge stays runtime', () => {
    const target: ModuleInfo = {
      id: 'mod:app/target', packageName: 'app', filePath: '/repo/packages/app/target.ts',
      relativeFilePath: 'target.ts', contentHash: 't', imports: [],
      exports: [
        { name: 'TVal', kind: 'function', signature: 'function TVal(): void', lineRange: { start: 1, end: 3 }, isDefault: false },
        { name: 'TType', kind: 'type', signature: 'type TType = number', lineRange: { start: 5, end: 5 }, isDefault: false },
      ],
      sourcePluginId: 'typescript',
    };
    const typeOnly: ModuleInfo = {
      id: 'mod:app/type-only', packageName: 'app', filePath: '/repo/packages/app/type-only.ts',
      relativeFilePath: 'type-only.ts', contentHash: 'to',
      imports: [{ moduleSpecifier: './target', resolvedModuleId: 'mod:app/target', importedNames: ['TType'], isTypeOnly: true, isExternal: false }],
      exports: [], sourcePluginId: 'typescript',
    };
    const mixed: ModuleInfo = {
      id: 'mod:app/mixed', packageName: 'app', filePath: '/repo/packages/app/mixed.ts',
      relativeFilePath: 'mixed.ts', contentHash: 'mx',
      imports: [
        { moduleSpecifier: './target', resolvedModuleId: 'mod:app/target', importedNames: ['TType'], isTypeOnly: true, isExternal: false },
        { moduleSpecifier: './target', resolvedModuleId: 'mod:app/target', importedNames: ['TVal'], isTypeOnly: false, isExternal: false },
      ],
      exports: [], sourcePluginId: 'typescript',
    };

    const graph = createEmptyGraph();
    contributeStructural(graph, snapshotOf([target, typeOnly, mixed]));

    const edgeFrom = (from: string) =>
      graph.edges.find(e => e.kind === 'imports' && e.from === from && e.to === 'mod:app/target');
    // Pure `import type` → one edge, flagged type-only.
    expect(edgeFrom('mod:app/type-only')?.metadata?.isTypeOnly).toBe(true);
    // Mixed value+type to the same target → a single runtime edge (all-type-only aggregation is false).
    expect(edgeFrom('mod:app/mixed')?.metadata?.isTypeOnly).toBeUndefined();
  });

  it('emits implements edges via the neutral resolver (same-module, imported, external/alias skip, dedup)', () => {
    const ports: ModuleInfo = {
      id: 'mod:app/ports',
      packageName: 'app',
      filePath: '/repo/packages/app/ports.ts',
      relativeFilePath: 'ports.ts',
      contentHash: 'p',
      imports: [],
      exports: [
        { name: 'IRepo', kind: 'interface', signature: 'interface IRepo', lineRange: { start: 1, end: 3 }, isDefault: false },
      ],
      sourcePluginId: 'typescript',
    };
    const repo: ModuleInfo = {
      id: 'mod:app/repo',
      packageName: 'app',
      filePath: '/repo/packages/app/repo.ts',
      relativeFilePath: 'repo.ts',
      contentHash: 'r',
      imports: [
        { moduleSpecifier: './ports', resolvedModuleId: 'mod:app/ports', importedNames: ['IRepo'], isTypeOnly: false, isExternal: false },
        { moduleSpecifier: 'ext-lib', importedNames: ['IExternal'], isTypeOnly: false, isExternal: true },
        // Aliased import keeps only the local binding name (`IRepo as IAliased`); the original
        // export name is lost, so the alias is an honest under-capture (no edge).
        { moduleSpecifier: './ports', resolvedModuleId: 'mod:app/ports', importedNames: ['IAliased'], isTypeOnly: false, isExternal: false },
      ],
      exports: [
        { name: 'ILocal', kind: 'interface', signature: 'interface ILocal', lineRange: { start: 1, end: 3 }, isDefault: false },
        // Names a same-module interface, an imported one, and an external one (skipped).
        { name: 'SqlRepo', kind: 'class', signature: 'class SqlRepo', implementsInterfaces: ['IRepo', 'ILocal', 'IExternal'], lineRange: { start: 5, end: 20 }, isDefault: false },
        // Alias local name resolves no declaring node → skip.
        { name: 'AliasUser', kind: 'class', signature: 'class AliasUser', implementsInterfaces: ['IAliased'], lineRange: { start: 22, end: 30 }, isDefault: false },
        // Same interface named twice → single edge (per-class dedup).
        { name: 'DupImpl', kind: 'class', signature: 'class DupImpl', implementsInterfaces: ['IRepo', 'IRepo'], lineRange: { start: 32, end: 40 }, isDefault: false },
      ],
      sourcePluginId: 'typescript',
    };

    const graph = createEmptyGraph();
    contributeStructural(graph, snapshotOf([ports, repo]));

    const implementsEdges = graph.edges.filter(e => e.kind === 'implements');
    expect(implementsEdges).toEqual(expect.arrayContaining([
      { from: 'export:app/repo/SqlRepo', to: 'export:app/ports/IRepo', kind: 'implements' },
      { from: 'export:app/repo/SqlRepo', to: 'export:app/repo/ILocal', kind: 'implements' },
      { from: 'export:app/repo/DupImpl', to: 'export:app/ports/IRepo', kind: 'implements' },
    ]));
    // External interface has no node → no edge; alias local name resolves nothing → no edge.
    expect(implementsEdges.some(e => e.from === 'export:app/repo/AliasUser')).toBe(false);
    expect(implementsEdges.some(e => e.to.endsWith('/IExternal'))).toBe(false);
    // DupImpl lists IRepo twice but only one edge is emitted.
    expect(implementsEdges.filter(e => e.from === 'export:app/repo/DupImpl')).toHaveLength(1);
    expect(implementsEdges).toHaveLength(3);
  });
});
