import { asHostPath, asPkgRelPath } from '@repovine/plugin-sdk';
/**
 * Tests for annotation propagation v2 (entrypoint-bounded derived, path-only domains).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { rememberInterpreterEntrypoints } from '../../../src/stage2/interpreter/entrypoint-store.js';
import {
  collectEntrypointRoots,
  collectEntrypointRootsDiagnostics,
  computeDepCone,
  computeEntrypointBoundedDerived,
  computePropagationPreview,
  reachesEntrypoint,
  buildPropagationSlice,
  isHubContractDrift,
  discoverContractHubs,
} from '../../../src/annotations/propagation.js';
import { AnnotationStore } from '../../../src/annotations/store.js';
import {
  computeDomainContentHash,
  computeDomainContentHashForPathOnly,
  resolveDomainContentHash,
} from '../../../src/annotations/content-hash.js';
import { DEFAULT_PROPAGATION_CONFIG } from '../../../src/config.js';
import type {
  ExportInfo,
  GraphEdge,
  GraphNode,
  ModuleInfo,
  RepositoryFactsSnapshot,
  RepositoryGraph,
  StoredAnnotation,
} from '../../../src/types.js';

const HUB_EXPORTS: ExportInfo[] = [
  { name: 'plans', kind: 'const', lineRange: { start: 1, end: 2 }, isDefault: false },
];

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

function makeMod(id: string, contentHash: string): ModuleInfo {
  return {
    id,
    packageName: 'test',
    absPath: asHostPath(`/abs/${id}.ts`),
    pkgRelPath: asPkgRelPath(`${id.replace(/^mod:/, '')}.ts`),
    contentHash,
    imports: [],
    exports: [],
  };
}

function makeSnapshot(modules: ModuleInfo[]): RepositoryFactsSnapshot {
  return {
    repoRoot: '/abs',
    timestamp: new Date().toISOString(),
    packages: [],
    modules,
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
    annotation: { summary: 'Test annotation for propagation checks.' },
    ...(importBaseline ? { importBaseline } : {}),
    schemaVersion: 1,
  };
}

describe('entrypoint-bounded derived', () => {
  function chainFixture() {
    const nodes: GraphNode[] = ['a', 'b', 'c', 'side'].map(id => ({
      id: `mod:${id}`, type: 'module' as const, label: id, description: '',
    }));
    const edges: GraphEdge[] = [
      { from: 'mod:b', to: 'mod:c', kind: 'imports' },
      { from: 'mod:a', to: 'mod:b', kind: 'imports' },
      { from: 'mod:side', to: 'mod:c', kind: 'imports' },
    ];
    const graph = makeGraph(nodes, edges);
    const snapshot = makeSnapshot([
      makeMod('mod:a', 'h_a'),
      makeMod('mod:b', 'h_b'),
      makeMod('mod:c', 'h_c_new'),
      makeMod('mod:side', 'h_side'),
    ]);
    rememberInterpreterEntrypoints(graph, [{ kind: 'route', moduleId: 'mod:a', id: 'ep:a' }]);
    const entrypoints = [{ kind: 'route', moduleId: 'mod:a', id: 'ep:a' }];
    return { graph, snapshot, entrypoints };
  }

  it('narrow derived includes B but excludes sideBranch when C changes', () => {
    const { graph, snapshot, entrypoints } = chainFixture();
    const annotations = {
      'mod:b': makeAnn('mod:b', 'h_b', { 'mod:c': 'h_c_old' }),
      'mod:side': makeAnn('mod:side', 'h_side', { 'mod:c': 'h_c_old' }),
    };
    const propagation = { ...DEFAULT_PROPAGATION_CONFIG };
    const preview = computePropagationPreview({
      graph,
      snapshot,
      annotations,
      entrypoints,
      propagation,
      from: 'mod:c',
    });
    expect(preview.hard).toEqual(['mod:c']);
    expect(preview.derived).toEqual(['mod:b']);
    expect(preview.derived).not.toContain('mod:side');

    const narrow = computeEntrypointBoundedDerived({
      graph,
      snapshot,
      annotations,
      entrypoints,
      propagation,
    });
    expect(narrow.has('mod:b')).toBe(true);
    expect(narrow.has('mod:side')).toBe(false);
  });

  it('reachesEntrypoint follows importer chain to entrypoint', () => {
    const { graph, entrypoints } = chainFixture();
    const entryIds = collectEntrypointRoots(entrypoints);
    expect(reachesEntrypoint(graph, 'mod:b', entryIds, 32)).toBe(true);
    expect(reachesEntrypoint(graph, 'mod:side', entryIds, 32)).toBe(false);
  });

  it('collectEntrypointRoots includes handlerModule backend roots', () => {
    const entrypoints = [
      { kind: 'route', moduleId: 'mod:fe/page', id: 'ep:fe' },
      { kind: 'api', handlerModule: 'mod:be/handler', id: 'ep:be', layer: 'backend' },
    ];
    const roots = collectEntrypointRoots(entrypoints);
    expect(roots.has('mod:fe/page')).toBe(true);
    expect(roots.has('mod:be/handler')).toBe(true);
    const diag = collectEntrypointRootsDiagnostics(entrypoints);
    expect(diag.moduleRoots).toEqual(['mod:fe/page']);
    expect(diag.handlerRoots).toEqual(['mod:be/handler']);
    expect(diag.total).toBe(2);
  });

  it('computeDepCone includes downstream imports from entrypoint', () => {
    const { graph, entrypoints } = chainFixture();
    const cone = computeDepCone(graph, collectEntrypointRoots(entrypoints));
    expect(cone.has('mod:a')).toBe(true);
    expect(cone.has('mod:b')).toBe(true);
    expect(cone.has('mod:c')).toBe(true);
    expect(cone.has('mod:side')).toBe(false);
  });

  it('comment-only hub drift does not widen off-path backend importers', () => {
    const nodes: GraphNode[] = ['fe', 'be', 'hub'].map(id => ({
      id: `mod:${id}`, type: 'module' as const, label: id, description: '',
    }));
    const edges: GraphEdge[] = [
      { from: 'mod:fe', to: 'mod:hub', kind: 'imports' },
      { from: 'mod:be', to: 'mod:hub', kind: 'imports' },
    ];
    const graph = makeGraph(nodes, edges);
    const hubMod: ModuleInfo = { ...makeMod('mod:hub', 'h_hub_v2'), exports: HUB_EXPORTS };
    const snapshot = makeSnapshot([
      makeMod('mod:fe', 'h_fe'),
      makeMod('mod:be', 'h_be'),
      hubMod,
    ]);
    rememberInterpreterEntrypoints(graph, [{ kind: 'route', moduleId: 'mod:fe', id: 'ep:fe' }]);
    const entrypoints = [{ kind: 'route', moduleId: 'mod:fe', id: 'ep:fe' }];
    const annotations = {
      'mod:hub': {
        ...makeAnn('mod:hub', 'h_hub_v1'),
        annotation: {
          summary: 'Shared subscription plans contract module.',
          keyExports: { plans: 'subscription plan types' },
        },
      },
      'mod:fe': makeAnn('mod:fe', 'h_fe', { 'mod:hub': 'h_hub_v1' }),
      'mod:be': makeAnn('mod:be', 'h_be', { 'mod:hub': 'h_hub_v1' }),
    };
    expect(isHubContractDrift(hubMod, annotations['mod:hub'])).toBe(false);

    const propagation = { ...DEFAULT_PROPAGATION_CONFIG };
    const narrow = computeEntrypointBoundedDerived({
      graph,
      snapshot,
      annotations,
      entrypoints,
      propagation,
    });
    expect(narrow.has('mod:fe')).toBe(true);
    expect(narrow.has('mod:be')).toBe(false);
  });

  it('hub contract drift widens all direct importers with baseline drift', () => {
    const nodes: GraphNode[] = ['fe', 'be', 'hub'].map(id => ({
      id: `mod:${id}`, type: 'module' as const, label: id, description: '',
    }));
    const edges: GraphEdge[] = [
      { from: 'mod:fe', to: 'mod:hub', kind: 'imports' },
      { from: 'mod:be', to: 'mod:hub', kind: 'imports' },
    ];
    const graph = makeGraph(nodes, edges);
    const snapshot = makeSnapshot([
      makeMod('mod:fe', 'h_fe'),
      makeMod('mod:be', 'h_be'),
      { ...makeMod('mod:hub', 'h_hub_v2'), exports: HUB_EXPORTS },
    ]);
    rememberInterpreterEntrypoints(graph, [{ kind: 'route', moduleId: 'mod:fe', id: 'ep:fe' }]);
    const entrypoints = [{ kind: 'route', moduleId: 'mod:fe', id: 'ep:fe' }];
    const annotations = {
      'mod:hub': {
        ...makeAnn('mod:hub', 'h_hub_v1'),
        annotation: {
          summary: 'Shared subscription plans contract module.',
          keyExports: { plans: 'subscription plan types', newExport: 'added later' },
        },
      },
      'mod:fe': makeAnn('mod:fe', 'h_fe', { 'mod:hub': 'h_hub_v1' }),
      'mod:be': makeAnn('mod:be', 'h_be', { 'mod:hub': 'h_hub_v1' }),
    };
    expect(isHubContractDrift(snapshot.modules.find(m => m.id === 'mod:hub')!, annotations['mod:hub'])).toBe(true);

    const propagation = { ...DEFAULT_PROPAGATION_CONFIG };
    const narrow = computeEntrypointBoundedDerived({
      graph,
      snapshot,
      annotations,
      entrypoints,
      propagation,
    });
    expect(narrow.has('mod:fe')).toBe(true);
    expect(narrow.has('mod:be')).toBe(true);
  });

  it('backend-hub-fixture: handlerModule root reaches trigger, excludes side branch', () => {
    const nodes: GraphNode[] = ['handler', 'trigger', 'hub', 'side'].map(id => ({
      id: `mod:${id}`, type: 'module' as const, label: id, description: '',
    }));
    const edges: GraphEdge[] = [
      { from: 'mod:handler', to: 'mod:trigger', kind: 'imports' },
      { from: 'mod:trigger', to: 'mod:hub', kind: 'imports' },
      { from: 'mod:side', to: 'mod:hub', kind: 'imports' },
    ];
    const graph = makeGraph(nodes, edges);
    const hubMod: ModuleInfo = { ...makeMod('mod:hub', 'h_hub_v2'), exports: HUB_EXPORTS };
    const snapshot = makeSnapshot([
      makeMod('mod:handler', 'h_handler'),
      makeMod('mod:trigger', 'h_trigger'),
      hubMod,
      makeMod('mod:side', 'h_side'),
    ]);
    const entrypoints = [{
      kind: 'api',
      handlerModule: 'mod:handler',
      id: 'entrypoint:api:svc:trigger',
      layer: 'backend',
    }];
    rememberInterpreterEntrypoints(graph, entrypoints);
    const annotations = {
      'mod:hub': {
        ...makeAnn('mod:hub', 'h_hub_v1'),
        annotation: {
          summary: 'Hub contract module for backend usage.',
          keyExports: { plans: 'plans export' },
        },
      },
      'mod:trigger': makeAnn('mod:trigger', 'h_trigger', { 'mod:hub': 'h_hub_v1' }),
      'mod:side': makeAnn('mod:side', 'h_side', { 'mod:hub': 'h_hub_v1' }),
    };
    expect(isHubContractDrift(hubMod, annotations['mod:hub'])).toBe(false);
    const propagation = { ...DEFAULT_PROPAGATION_CONFIG };

    const preview = computePropagationPreview({
      graph,
      snapshot,
      annotations,
      entrypoints,
      propagation,
      from: 'mod:hub',
    });
    expect(preview.derived).toContain('mod:trigger');
    expect(preview.derived).not.toContain('mod:side');
    expect(preview.entrypointRoots?.handlerRoots).toEqual(['mod:handler']);

    const narrow = computeEntrypointBoundedDerived({
      graph,
      snapshot,
      annotations,
      entrypoints,
      propagation,
    });
    expect(narrow.has('mod:trigger')).toBe(true);
    expect(narrow.has('mod:side')).toBe(false);
  });

  it('buildPropagationSlice returns path from anchor to entrypoint', () => {
    const { graph, entrypoints } = chainFixture();
    const slice = buildPropagationSlice({ graph, from: 'mod:c', entrypoints });
    expect(slice?.anchor).toBe('mod:c');
    expect(slice?.path[0]).toBe('mod:c');
    expect(slice?.path.at(-1)).toBe('mod:a');
  });
});

describe('path-only domain staleness', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-propagation-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('path domain hash changes when path-tagged member changes; package domain skipped from queue', () => {
    const nodes: GraphNode[] = [
      { id: 'domain:client-ui', type: 'domain', label: 'client-ui', description: '' },
      { id: 'domain:client-ui/profile', type: 'domain', label: 'client-ui/profile', description: '' },
      { id: 'mod:UserStats', type: 'module', label: 'UserStats', description: '' },
    ];
    const edges: GraphEdge[] = [
      { from: 'mod:UserStats', to: 'domain:client-ui', kind: 'tagged', metadata: { tagSource: 'package' } },
      { from: 'mod:UserStats', to: 'domain:client-ui/profile', kind: 'tagged', metadata: { tagSource: 'path' } },
    ];
    const graph = makeGraph(nodes, edges);
    const before = makeSnapshot([makeMod('mod:UserStats', 'h_v1')]);
    const after = makeSnapshot([makeMod('mod:UserStats', 'h_v2')]);

    const pkgHashBefore = computeDomainContentHash(graph, before, 'domain:client-ui');
    const pkgHashAfter = computeDomainContentHash(graph, after, 'domain:client-ui');
    expect(pkgHashBefore).not.toEqual(pkgHashAfter);

    const pathHashBefore = computeDomainContentHashForPathOnly(graph, before, 'domain:client-ui/profile');
    const pathHashAfter = computeDomainContentHashForPathOnly(graph, after, 'domain:client-ui/profile');
    expect(pathHashBefore).not.toEqual(pathHashAfter);

    const pathOnlyPkgHash = computeDomainContentHashForPathOnly(graph, after, 'domain:client-ui');
    expect(pathOnlyPkgHash).toBe('empty');

    const store = AnnotationStore.createSync(tmpDir);
    store.set('domain:client-ui', {
      nodeId: 'domain:client-ui',
      nodeType: 'domain',
      contentHash: pkgHashBefore!,
      pass: 1,
      updatedAt: new Date().toISOString(),
      annotation: { summary: 'Package domain rollup for client-ui components.' },
      schemaVersion: 1,
    });
    store.set('domain:client-ui/profile', {
      nodeId: 'domain:client-ui/profile',
      nodeType: 'domain',
      contentHash: pathHashBefore!,
      pass: 1,
      updatedAt: new Date().toISOString(),
      annotation: { summary: 'Profile feature domain for client-ui.' },
      schemaVersion: 1,
    });
    store.flush();

    const propagation = { ...DEFAULT_PROPAGATION_CONFIG };
    const queue = store.getQueue(graph, after, { limit: 100, propagation, entrypoints: [] });
    const domainIds = queue.filter(q => q.nodeId.startsWith('domain:')).map(q => q.nodeId);
    expect(domainIds).toContain('domain:client-ui/profile');
    expect(domainIds).not.toContain('domain:client-ui');
  });

  it('getStats domain freshness matches getQueue under path-only policy', () => {
    const nodes: GraphNode[] = [
      { id: 'domain:client-ui/profile', type: 'domain', label: 'client-ui/profile', description: '' },
      { id: 'mod:UserStats', type: 'module', label: 'UserStats', description: '' },
    ];
    const edges: GraphEdge[] = [
      { from: 'mod:UserStats', to: 'domain:client-ui/profile', kind: 'tagged', metadata: { tagSource: 'path' } },
    ];
    const graph = makeGraph(nodes, edges);
    const snapshot = makeSnapshot([makeMod('mod:UserStats', 'h_v1')]);
    const propagation = { ...DEFAULT_PROPAGATION_CONFIG };
    const pathHash = resolveDomainContentHash(graph, snapshot, 'domain:client-ui/profile', propagation)!;

    const store = AnnotationStore.createSync(tmpDir);
    store.set('domain:client-ui/profile', {
      nodeId: 'domain:client-ui/profile',
      nodeType: 'domain',
      contentHash: pathHash,
      pass: 1,
      updatedAt: new Date().toISOString(),
      annotation: { summary: 'Profile feature domain for client-ui.' },
      schemaVersion: 1,
    });
    store.flush();

    const stats = store.getStats(graph, snapshot, { propagation, entrypoints: [] });
    expect(stats.domains.fresh).toBe(1);
    expect(stats.domains.stale).toBe(0);

    const queue = store.getQueue(graph, snapshot, { limit: 100, propagation, entrypoints: [] });
    const pathDomainQueue = queue.filter(q => q.nodeId === 'domain:client-ui/profile');
    expect(pathDomainQueue).toHaveLength(0);
  });

  it('legacy full domain hash is stale in both getStats and getQueue under path-only', () => {
    const nodes: GraphNode[] = [
      { id: 'domain:client-ui/profile', type: 'domain', label: 'client-ui/profile', description: '' },
      { id: 'mod:PathMod', type: 'module', label: 'PathMod', description: '' },
      { id: 'mod:PkgMod', type: 'module', label: 'PkgMod', description: '' },
    ];
    const edges: GraphEdge[] = [
      { from: 'mod:PathMod', to: 'domain:client-ui/profile', kind: 'tagged', metadata: { tagSource: 'path' } },
      { from: 'mod:PkgMod', to: 'domain:client-ui/profile', kind: 'tagged', metadata: { tagSource: 'package' } },
    ];
    const graph = makeGraph(nodes, edges);
    const snapshot = makeSnapshot([makeMod('mod:PathMod', 'h_path'), makeMod('mod:PkgMod', 'h_pkg')]);
    const propagation = { ...DEFAULT_PROPAGATION_CONFIG };
    const fullHash = computeDomainContentHash(graph, snapshot, 'domain:client-ui/profile')!;
    const pathHash = resolveDomainContentHash(graph, snapshot, 'domain:client-ui/profile', propagation)!;
    expect(fullHash).not.toEqual(pathHash);

    const store = AnnotationStore.createSync(tmpDir);
    store.set('domain:client-ui/profile', {
      nodeId: 'domain:client-ui/profile',
      nodeType: 'domain',
      contentHash: fullHash,
      pass: 1,
      updatedAt: new Date().toISOString(),
      annotation: { summary: 'Profile feature domain for client-ui.' },
      schemaVersion: 1,
    });
    store.flush();

    const stats = store.getStats(graph, snapshot, { propagation, entrypoints: [] });
    expect(stats.domains.stale).toBe(1);
    expect(stats.domains.fresh).toBe(0);

    const queue = store.getQueue(graph, snapshot, { limit: 100, propagation, entrypoints: [] });
    expect(queue.some(q => q.nodeId === 'domain:client-ui/profile')).toBe(true);
  });
});

describe('discoverContractHubs', () => {
  it('detects hub via keyExports annotation', () => {
    const nodes: GraphNode[] = ['fe', 'hub'].map(id => ({
      id: `mod:${id}`, type: 'module' as const, label: id, description: '',
    }));
    const edges: GraphEdge[] = [{ from: 'mod:fe', to: 'mod:hub', kind: 'imports' }];
    const graph = makeGraph(nodes, edges);
    const snapshot = makeSnapshot([makeMod('mod:fe', 'h_fe'), makeMod('mod:hub', 'h_hub')]);
    const annotations = {
      'mod:hub': {
        ...makeAnn('mod:hub', 'h_hub'),
        annotation: { summary: 'Contract hub.', keyExports: { plans: 'plans' } },
      },
    };
    const hubs = discoverContractHubs({
      graph,
      snapshot,
      annotations,
      propagation: DEFAULT_PROPAGATION_CONFIG,
    });
    expect(hubs.has('mod:hub')).toBe(true);
  });

  it('hubModulesDeny suppresses auto-detected hub', () => {
    const nodes: GraphNode[] = [{ id: 'mod:hub', type: 'module' as const, label: 'hub', description: '' }];
    const graph = makeGraph(nodes, []);
    const snapshot = makeSnapshot([makeMod('mod:hub', 'h_hub')]);
    const annotations = {
      'mod:hub': {
        ...makeAnn('mod:hub', 'h_hub'),
        annotation: { summary: 'Contract hub.', keyExports: { x: 'x' } },
      },
    };
    const hubs = discoverContractHubs({
      graph,
      snapshot,
      annotations,
      propagation: { ...DEFAULT_PROPAGATION_CONFIG, hubModulesDeny: ['mod:hub'] },
    });
    expect(hubs.has('mod:hub')).toBe(false);
  });

  it('hubModulesExtra force-includes non-candidate module', () => {
    const nodes: GraphNode[] = [{ id: 'mod:util', type: 'module' as const, label: 'util', description: '' }];
    const graph = makeGraph(nodes, []);
    const snapshot = makeSnapshot([makeMod('mod:util', 'h_util')]);
    const hubs = discoverContractHubs({
      graph,
      snapshot,
      annotations: {},
      propagation: { ...DEFAULT_PROPAGATION_CONFIG, hubModulesExtra: ['mod:util'] },
    });
    expect(hubs.has('mod:util')).toBe(true);
  });

  it('comment-only drift with empty keyExports does not count as contract drift', () => {
    const hubMod = makeMod('mod:hub', 'h_v2');
    const ann = makeAnn('mod:hub', 'h_v1');
    expect(isHubContractDrift(hubMod, ann)).toBe(false);
  });
});
