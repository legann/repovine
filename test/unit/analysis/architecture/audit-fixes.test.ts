/**
 * Regression locks for two analyze_architecture detector fixes:
 *  - graph-edge detectors ignore build-erased `import type` edges (metadata.isTypeOnly);
 *  - the server-client-boundary storage gate honors allowGenericStorageName under `strict`.
 */
import { describe, expect, it } from '@jest/globals';
import { detectBoundary, detectServerClientBoundary } from '../../../../src/analysis/architecture/detectors.js';
import { AnnotationStore } from '../../../../src/annotations/store.js';
import type { RefactoringScope } from '../../../../src/analysis/architecture/types.js';
import type { RepositoryGraph, GraphNode, GraphEdge, ModuleInfo } from '../../../../src/types.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function makeGraph(nodes: GraphNode[], edges: GraphEdge[]): RepositoryGraph {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of nodes) nodeMap.set(n.id, n);
  const outEdges = new Map<string, GraphEdge[]>();
  const inEdges = new Map<string, GraphEdge[]>();
  const byType = new Map<GraphNode['type'], Set<string>>();
  for (const e of edges) {
    (outEdges.get(e.from) ?? outEdges.set(e.from, []).get(e.from)!).push(e);
    (inEdges.get(e.to) ?? inEdges.set(e.to, []).get(e.to)!).push(e);
  }
  for (const n of nodes) (byType.get(n.type) ?? byType.set(n.type, new Set()).get(n.type)!).add(n.id);
  return { nodes: nodeMap, edges, outEdges, inEdges, byType };
}

function mod(id: string, relPath: string, imports: ModuleInfo['imports'] = []): ModuleInfo {
  return {
    id, packageName: id.split('/')[0]!.replace(/^mod:/, ''),
    filePath: `/abs/${relPath}`, relativeFilePath: relPath, contentHash: 'h',
    imports, exports: [], semanticHints: {},
  };
}

function emptyStore(): AnnotationStore {
  return AnnotationStore.createSync(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fixes-')));
}

function scopeOf(moduleIds: string[], kind: RefactoringScope['kind'] = 'all'): RefactoringScope {
  return { kind, scope: 'all', moduleIds: new Set(moduleIds), serviceIds: new Set(), domainIds: new Set() };
}

describe('detectBoundary ignores type-only import edges', () => {
  // pkg:a/importer imports pkg:b/target directly (bypassing pkg:b's index barrel).
  const nodes: GraphNode[] = [
    { id: 'pkg:a', type: 'package', label: 'a', description: '' },
    { id: 'pkg:b', type: 'package', label: 'b', description: '' },
    { id: 'mod:a/importer', type: 'module', label: 'a/importer', description: '' },
    { id: 'mod:b/target', type: 'module', label: 'b/target', description: '' },
    { id: 'mod:b/index', type: 'module', label: 'b/index', description: '' },
  ];
  const containment: GraphEdge[] = [
    { from: 'pkg:a', to: 'mod:a/importer', kind: 'contains' },
    { from: 'pkg:b', to: 'mod:b/target', kind: 'contains' },
    { from: 'pkg:b', to: 'mod:b/index', kind: 'contains' },
  ];
  const importer = mod('mod:a/importer', 'a/importer.ts', [
    { moduleSpecifier: '../b/target', resolvedModuleId: 'mod:b/target', importedNames: ['Thing'], isTypeOnly: false, isExternal: false },
  ]);
  const modulesById = new Map([['mod:a/importer', importer]]);

  it('emits a boundary finding for a runtime (value) cross-package import', () => {
    const graph = makeGraph(nodes, [...containment, { from: 'mod:a/importer', to: 'mod:b/target', kind: 'imports' }]);
    const findings = detectBoundary(graph, modulesById, emptyStore(), scopeOf(['mod:a/importer']));
    expect(findings.map(f => f.id)).toContain('boundary:mod:b/target');
  });

  it('emits nothing when the only cross-package edge is `import type` (metadata.isTypeOnly)', () => {
    const graph = makeGraph(nodes, [
      ...containment,
      { from: 'mod:a/importer', to: 'mod:b/target', kind: 'imports', metadata: { isTypeOnly: true } },
    ]);
    const findings = detectBoundary(graph, modulesById, emptyStore(), scopeOf(['mod:a/importer']));
    expect(findings).toHaveLength(0);
  });
});

describe('server-client-boundary storage gate honors allowGenericStorageName', () => {
  const strict = { thresholds: { minTargets: 1, allowGenericStorageName: false } };

  function run(clientImports: ModuleInfo['imports'], targets: ModuleInfo[]) {
    const client = mod('mod:app/widget', 'src/features/dashboard/widget.tsx', clientImports);
    const modulesById = new Map<string, ModuleInfo>([['mod:app/widget', client]]);
    const nodes: GraphNode[] = [{ id: 'mod:app/widget', type: 'module', label: 'app/widget', description: '' }];
    for (const t of targets) {
      modulesById.set(t.id, t);
      nodes.push({ id: t.id, type: 'module', label: t.id.replace(/^mod:/, ''), description: '' });
    }
    return detectServerClientBoundary(makeGraph(nodes, []), modulesById, emptyStore(), scopeOf(['mod:app/widget']), strict);
  }

  it('does NOT flag a frontend generic-storage import (features/.../db) under strict', () => {
    const findings = run(
      [{ moduleSpecifier: './db/cache', resolvedModuleId: 'mod:app/db-cache', importedNames: ['cache'], isTypeOnly: false, isExternal: false }],
      [mod('mod:app/db-cache', 'src/features/dashboard/db/cache.ts')],
    );
    expect(findings).toHaveLength(0);
  });

  it('still flags a genuine server-only import (server/db/pool)', () => {
    const findings = run(
      [{ moduleSpecifier: '../../server/db/pool', resolvedModuleId: 'mod:app/server-pool', importedNames: ['pool'], isTypeOnly: false, isExternal: false }],
      [mod('mod:app/server-pool', 'src/server/db/pool.ts')],
    );
    expect(findings.map(f => f.id)).toContain('server-client-boundary:mod:app/widget');
  });
});
