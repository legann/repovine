/**
 * Tests for staleness mechanics: domain contentHash roll-ups and importBaseline derived-stale.
 */
import {
  buildDomainContentHashLookup,
  computeDomainContentHash,
  computeDomainContentHashForPathOnly,
  resolveDomainContentHash,
  isPackageOnlyDomain,
  computeImportBaseline,
  getImportBaselineStaleUpstream,
  isDerivedStaleModule,
  classifyStale,
  isPropagationStaleItem,
} from '../../../src/annotations/store.js';
import { DEFAULT_PROPAGATION_CONFIG } from '../../../src/config.js';
import type {
  RepositoryGraph,
  RepositoryFactsSnapshot,
  GraphNode,
  GraphEdge,
  ModuleInfo,
  StoredAnnotation,
  InfraModuleInfo,
} from '../../../src/types.js';

function makeGraph(nodes: GraphNode[], edges: GraphEdge[]): RepositoryGraph {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of nodes) nodeMap.set(n.id, n);
  const outEdges = new Map<string, GraphEdge[]>();
  const inEdges = new Map<string, GraphEdge[]>();
  const byType = new Map<GraphNode['type'], Set<string>>();
  for (const e of edges) {
    if (!outEdges.has(e.from)) outEdges.set(e.from, []);
    outEdges.get(e.from)!.push(e);
    if (!inEdges.has(e.to)) inEdges.set(e.to, []);
    inEdges.get(e.to)!.push(e);
  }
  for (const n of nodes) {
    if (!byType.has(n.type)) byType.set(n.type, new Set());
    byType.get(n.type)!.add(n.id);
  }
  return { nodes: nodeMap, edges, outEdges, inEdges, byType };
}

function makeMod(id: string, contentHash: string, relativeFilePath = `${id}.ts`): ModuleInfo {
  return {
    id,
    packageName: 'test',
    filePath: `/abs/${relativeFilePath}`,
    relativeFilePath,
    contentHash,
    imports: [],
    exports: [],
  };
}

function makeSnapshot(
  modules: ModuleInfo[],
  extras: Partial<Pick<RepositoryFactsSnapshot, 'infraModules' | 'templates'>> = {},
): RepositoryFactsSnapshot {
  return {
    repoRoot: '/abs',
    timestamp: new Date().toISOString(),
    packages: [],
    modules,
    ...extras,
  };
}

function makeAnn(
  nodeId: string,
  contentHash: string,
  importBaseline?: Record<string, string>,
): StoredAnnotation {
  return {
    nodeId,
    nodeType: 'module',
    contentHash,
    pass: 1,
    updatedAt: new Date().toISOString(),
    annotation: { summary: 'Test module annotation for staleness checks.' },
    ...(importBaseline ? { importBaseline } : {}),
    schemaVersion: 1,
  };
}

describe('computeDomainContentHash', () => {
  it('returns undefined for non-domain node', () => {
    const graph = makeGraph(
      [{ id: 'mod:foo', type: 'module', label: 'foo', description: '' }],
      [],
    );
    expect(computeDomainContentHash(graph, makeSnapshot([]), 'mod:foo')).toBeUndefined();
  });

  it('returns "empty" for domain with no tagged members', () => {
    const graph = makeGraph(
      [{ id: 'domain:auth', type: 'domain', label: 'auth', description: '' }],
      [],
    );
    expect(computeDomainContentHash(graph, makeSnapshot([]), 'domain:auth')).toBe('empty');
  });

  it('hash changes when a member contentHash changes', () => {
    const nodes: GraphNode[] = [
      { id: 'domain:auth', type: 'domain', label: 'auth', description: '' },
      { id: 'mod:a', type: 'module', label: 'a', description: '' },
    ];
    const edges: GraphEdge[] = [{ from: 'mod:a', to: 'domain:auth', kind: 'tagged' }];
    const graph = makeGraph(nodes, edges);

    const before = computeDomainContentHash(graph, makeSnapshot([makeMod('mod:a', 'h_a_v1')]), 'domain:auth');
    const after = computeDomainContentHash(graph, makeSnapshot([makeMod('mod:a', 'h_a_v2')]), 'domain:auth');
    expect(before).not.toEqual(after);
  });

  it('shared lookup preserves runtime-resource domain hashing', () => {
    const runtimeId = 'resource:aws-lambda:Worker';
    const infra: InfraModuleInfo = {
      id: 'infra:sam:template.yaml',
      kind: 'sam',
      filePath: '/abs/template.yaml',
      relativeFilePath: 'template.yaml',
      contentHash: 'template-v1',
      resources: [{
        id: 'Worker',
        kind: 'lambda',
        provider: 'aws',
        contentHash: 'worker-v1',
        attributes: { handler: 'src/worker.handler' },
      }],
    };
    const graph = makeGraph([
      { id: 'domain:infra', type: 'domain', label: 'infra', description: '' },
      {
        id: runtimeId,
        type: 'runtime-resource',
        label: 'Worker',
        description: '',
        data: { kind: 'lambda', provider: 'aws', contentHash: 'fallback-hash' },
      },
    ], [
      { from: runtimeId, to: 'domain:infra', kind: 'tagged' },
    ]);
    const snapshot = makeSnapshot([], { infraModules: [infra] });
    const lookup = buildDomainContentHashLookup(snapshot);

    const direct = computeDomainContentHash(graph, snapshot, 'domain:infra');
    const viaLookup = computeDomainContentHash(graph, snapshot, 'domain:infra', lookup);

    expect(viaLookup).toBe(direct);

    const changedSnapshot = makeSnapshot([], {
      infraModules: [{
        ...infra,
        resources: [{ ...infra.resources[0]!, contentHash: 'worker-v2' }],
      }],
    });
    expect(computeDomainContentHash(
      graph,
      changedSnapshot,
      'domain:infra',
      buildDomainContentHashLookup(changedSnapshot),
    )).not.toBe(viaLookup);
  });
});

describe('importBaseline derived-stale', () => {
  function makeChainGraph(aHash: string, bHash: string): { graph: RepositoryGraph; snapshot: RepositoryFactsSnapshot } {
    const nodes: GraphNode[] = ['a', 'b', 'c'].map(id => ({
      id: `mod:${id}`, type: 'module' as const, label: id, description: '',
    }));
    const edges: GraphEdge[] = [
      { from: 'mod:b', to: 'mod:a', kind: 'imports' },
      { from: 'mod:c', to: 'mod:b', kind: 'imports' },
    ];
    return {
      graph: makeGraph(nodes, edges),
      snapshot: makeSnapshot([makeMod('mod:a', aHash), makeMod('mod:b', bHash), makeMod('mod:c', 'h_c')]),
    };
  }

  it('computeImportBaseline captures direct import hashes', () => {
    const { graph, snapshot } = makeChainGraph('h_a', 'h_b');
    expect(computeImportBaseline(graph, snapshot, 'mod:b')).toEqual({ 'mod:a': 'h_a' });
  });

  it('flags derived when upstream hash differs from importBaseline', () => {
    const { graph, snapshot } = makeChainGraph('h_a_new', 'h_b');
    const ann = makeAnn('mod:b', 'h_b', { 'mod:a': 'h_a_old' });
    expect(isDerivedStaleModule(ann, snapshot.modules[1]!, graph, snapshot)).toBe(true);
    expect(getImportBaselineStaleUpstream(ann, graph, snapshot, 'mod:b')).toEqual(['mod:a']);
  });

  it('clears derived after baseline matches even when upstream was previously stale', () => {
    const { graph, snapshot } = makeChainGraph('h_a_v2', 'h_b');
    const ann = makeAnn('mod:b', 'h_b', { 'mod:a': 'h_a_v2' });
    expect(isDerivedStaleModule(ann, snapshot.modules[1]!, graph, snapshot)).toBe(false);
  });

  it('missing importBaseline treats all direct imports as stale', () => {
    const { graph, snapshot } = makeChainGraph('h_a', 'h_b');
    const ann = makeAnn('mod:b', 'h_b');
    expect(isDerivedStaleModule(ann, snapshot.modules[1]!, graph, snapshot)).toBe(true);
  });

  it('persists derived on B after A hard-stale is fixed (baseline not refreshed)', () => {
    const { graph, snapshot } = makeChainGraph('h_a_fixed', 'h_b');
    const ann = makeAnn('mod:b', 'h_b', { 'mod:a': 'h_a_before_change' });
    expect(isDerivedStaleModule(ann, snapshot.modules[1]!, graph, snapshot)).toBe(true);
  });

  it('C becomes derived when B baseline stale (transitive via import chain)', () => {
    const { graph, snapshot } = makeChainGraph('h_a', 'h_b_new');
    const annC = makeAnn('mod:c', 'h_c', { 'mod:b': 'h_b_old' });
    expect(isDerivedStaleModule(annC, snapshot.modules[2]!, graph, snapshot)).toBe(true);
  });

  it('content-stale module is not derived-stale', () => {
    const { graph, snapshot } = makeChainGraph('h_a_new', 'h_b_old');
    const ann = makeAnn('mod:b', 'h_b_stored', { 'mod:a': 'h_a_old' });
    expect(isDerivedStaleModule(ann, snapshot.modules[1]!, graph, snapshot)).toBe(false);
  });

  it('comment-only style contentHash change marks hard stale on edited module only when no baseline drift on importers', () => {
    const nodes: GraphNode[] = [{ id: 'mod:leaf', type: 'module', label: 'leaf', description: '' }];
    const graph = makeGraph(nodes, []);
    const snapshot = makeSnapshot([makeMod('mod:leaf', 'h_comment_v2')]);
    const ann = makeAnn('mod:leaf', 'h_comment_v1');
    expect(ann.contentHash).not.toEqual(snapshot.modules[0]!.contentHash);
    expect(isDerivedStaleModule(ann, snapshot.modules[0]!, graph, snapshot)).toBe(false);
  });
});

describe('classifyStale', () => {
  it('maps content drift to stale+content', () => {
    expect(classifyStale({
      annotated: true,
      contentStale: true,
      schemaOutdated: false,
      isDerivedStale: false,
    })).toEqual({ status: 'stale', staleKind: 'content' });
  });

  it('maps importBaseline drift to stale+propagation', () => {
    expect(classifyStale({
      annotated: true,
      contentStale: false,
      schemaOutdated: false,
      isDerivedStale: true,
    })).toEqual({ status: 'stale', staleKind: 'propagation' });
  });

  it('isPropagationStaleItem recognizes propagation-stale queue items', () => {
    expect(isPropagationStaleItem({ status: 'stale', staleKind: 'propagation' })).toBe(true);
    expect(isPropagationStaleItem({ status: 'stale', staleKind: 'content' })).toBe(false);
  });
});

// Characterization: the two domain content-hash scopes are intentionally different and dispatched by
// policy. Pins current behavior so a future edit that unified them (mass-re-flagging path-only domains
// against persisted hashes) fails loudly instead of silently churning annotations.
describe('domain content-hash two-scope policy (characterization)', () => {
  function mixedGraph(): RepositoryGraph {
    const nodes: GraphNode[] = [
      { id: 'domain:auth', type: 'domain', label: 'auth', description: '' },
      { id: 'mod:a', type: 'module', label: 'a', description: '' },
      { id: 'mod:b', type: 'module', label: 'b', description: '' },
      { id: 'mod:c', type: 'module', label: 'c', description: '' },
    ];
    const edges: GraphEdge[] = [
      { from: 'mod:a', to: 'domain:auth', kind: 'tagged', metadata: { tagSource: 'path' } },
      { from: 'mod:b', to: 'domain:auth', kind: 'tagged', metadata: { tagSource: 'cluster' } },
      { from: 'mod:c', to: 'domain:auth', kind: 'tagged', metadata: { tagSource: 'package' } },
    ];
    return makeGraph(nodes, edges);
  }
  const mixedSnap = () => makeSnapshot([makeMod('mod:a', 'ha'), makeMod('mod:b', 'hb'), makeMod('mod:c', 'hc')]);

  function packageOnlyGraph(): RepositoryGraph {
    return makeGraph(
      [
        { id: 'domain:pkgdom', type: 'domain', label: 'pkgdom', description: '' },
        { id: 'mod:p', type: 'module', label: 'p', description: '' },
      ],
      [{ from: 'mod:p', to: 'domain:pkgdom', kind: 'tagged', metadata: { tagSource: 'package' } }],
    );
  }
  const pkgSnap = () => makeSnapshot([makeMod('mod:p', 'hp')]);

  it('full rollup and path-only produce different hashes for a mixed-tagged domain', () => {
    const g = mixedGraph();
    const full = computeDomainContentHash(g, mixedSnap(), 'domain:auth');
    const pathOnly = computeDomainContentHashForPathOnly(g, mixedSnap(), 'domain:auth');
    expect(full).toBeDefined();
    expect(pathOnly).toBeDefined();
    expect(full).not.toEqual(pathOnly);
  });

  it('path-only ignores cluster/package-sourced members (returns "empty" when none are path/pattern)', () => {
    const g = packageOnlyGraph();
    expect(computeDomainContentHashForPathOnly(g, pkgSnap(), 'domain:pkgdom')).toBe('empty');
    expect(computeDomainContentHash(g, pkgSnap(), 'domain:pkgdom')).not.toBe('empty');
  });

  it('isPackageOnlyDomain is true only when every tagged edge is package-sourced', () => {
    expect(isPackageOnlyDomain(packageOnlyGraph(), 'domain:pkgdom')).toBe(true);
    expect(isPackageOnlyDomain(mixedGraph(), 'domain:auth')).toBe(false);
  });

  it('resolveDomainContentHash: all-tags policy selects the full rollup', () => {
    const g = mixedGraph();
    expect(resolveDomainContentHash(g, mixedSnap(), 'domain:auth', { ...DEFAULT_PROPAGATION_CONFIG, domainStalePolicy: 'all-tags' }))
      .toEqual(computeDomainContentHash(g, mixedSnap(), 'domain:auth'));
  });

  it('resolveDomainContentHash: path-only policy selects path-only for a non-package-only domain', () => {
    const g = mixedGraph();
    const resolved = resolveDomainContentHash(g, mixedSnap(), 'domain:auth', { ...DEFAULT_PROPAGATION_CONFIG, domainStalePolicy: 'path-only' });
    expect(resolved).toEqual(computeDomainContentHashForPathOnly(g, mixedSnap(), 'domain:auth'));
    expect(resolved).not.toEqual(computeDomainContentHash(g, mixedSnap(), 'domain:auth'));
  });

  it('resolveDomainContentHash: path-only policy falls back to the full rollup for a package-only domain', () => {
    const g = packageOnlyGraph();
    expect(resolveDomainContentHash(g, pkgSnap(), 'domain:pkgdom', { ...DEFAULT_PROPAGATION_CONFIG, domainStalePolicy: 'path-only' }))
      .toEqual(computeDomainContentHash(g, pkgSnap(), 'domain:pkgdom'));
  });
});
