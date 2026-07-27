/**
 * Unit tests for MCP handlers. Uses a small in-memory fixture graph + snapshot,
 * mocks fs for includeBody/grepBody, so no file I/O occurs.
 */
import { jest } from '@jest/globals';
import { backlogCoverage, fakeQueuePage, kindCoverage, type FakeQueueRow } from '../../helpers/backlog.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

jest.unstable_mockModule('node:fs/promises', () => ({
  readFile: jest.fn(),
}));

import { ToolResponseSchema, type ToolResponse } from '../../../src/mcp/response/envelope.js';
import type { ToolHandler, McpToolRuntime, RepovineState } from '../../../src/mcp/types.js';
import { CONFIG_DEFAULTS, DEFAULT_PROPAGATION_CONFIG } from '../../../src/config.js';
import { resolveScope } from '../../../src/mcp/scope/resolve.js';
import { resolveDomainContentHash } from '../../../src/annotations/content-hash.js';
import { searchGraph } from '../../../src/mcp/lib/search-graph.js';
import { analyzeImpact } from '../../../src/mcp/lib/dependencies/impact.js';
import { toCallToolMcpResult } from '../../../src/mcp/response-format.js';
import { buildDomainContext, buildDomainModulesSlice } from '../../../src/mcp/lib/domain-map.js';
import { projectRuntimeTopology } from '../../../src/mcp/lib/topology.js';
import { handleTraceFlow } from '../../../src/mcp/tools/trace-flow.js';
import { analyzePackageBoundaries } from '../../../src/mcp/lib/dependencies/package-boundaries.js';
import { inferFileBasedRoutes } from '../../../src/stage2/routes/file-based.js';
import { createEmptyGraph, addNode, addEdge } from '../../../src/graph/index.js';
import {
  SEARCH_ANNOTATION_ESCALATION_GAP,
  SEARCH_ANNOTATION_ESCALATION_NAV_REASON,
} from '../../../src/mcp/lib/search-annotation-escalation.js';
import { collectBackendRouteEntrypoints } from '../../../src/interpreters/server-entrypoints/entrypoints.js';
import { collectUiRouteEntrypoints } from '../../../src/interpreters/ui-entrypoints/entrypoints.js';
import { collectServiceTriggerEntrypoints } from '../../../src/interpreters/infra-runtime-links/entrypoints.js';
import { rememberInterpreterEntrypoints } from '../../../src/stage2/interpreter/entrypoint-store.js';
import type { InterpreterEntrypointContext } from '../../../src/interpreter/types.js';
import type { InfraModuleInfo, RepositoryFactsSnapshot, RepositoryGraph, ModuleInfo, StoredAnnotation } from '../../../src/types.js';
import { buildRuntimeResourceContentHashLookup } from '../../../src/annotations/service-resource-hash.js';

let fsPromises: typeof import('node:fs/promises');
let toolHandlers: Record<string, ToolHandler>;
let buildInspectNodeDetail: (
  ctx: McpToolRuntime,
  args: Record<string, unknown>,
) => Promise<unknown>;

async function architectureResult(ctx: McpToolRuntime, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const envelope = await toolHandlers['analyze_architecture'](ctx, args);
  return envelope.result as Record<string, unknown>;
}

beforeAll(async () => {
  fsPromises = await import('node:fs/promises');
  const { toolHandlers: publicHandlers } = await import('../../../src/mcp/tools/registry.js');
  ({ buildInspectNodeDetail } = await import('../../../src/mcp/lib/inspect-node-core.js'));
  toolHandlers = publicHandlers;
});

// ── Fixture builders ──

function makeSnapshot(modules: ModuleInfo[] = []): RepositoryFactsSnapshot {
  return { repoRoot: '/repo', timestamp: '2024-01-01', packages: [], modules };
}

function makeModuleInfo(id: string, filePath = `/repo/${id}.ts`): ModuleInfo {
  return {
    id,
    packageName: 'test',
    filePath,
    relativeFilePath: `${id}.ts`,
    contentHash: 'abc123',
    imports: [],
    exports: [],
  };
}

function tokenizeSearchText(s: string): string[] {
  const splitCamel = (value: string): string =>
    value
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const splitPlain = (value: string): string[] =>
    value.toLowerCase().replace(/[/\-_.:]/g, ' ').split(/\s+/).filter(Boolean);
  return [...new Set([...splitPlain(s), ...splitPlain(splitCamel(s))])];
}

function buildTestSearchIndex(graph: RepositoryGraph): RepovineState['searchIndex'] {
  const index: RepovineState['searchIndex'] = { tokens: new Map(), annotationText: new Map() };
  const add = (token: string, nodeId: string) => {
    if (!token) return;
    let set = index.tokens.get(token);
    if (!set) { set = new Set(); index.tokens.set(token, set); }
    set.add(nodeId);
  };
  for (const node of graph.nodes.values()) {
    for (const t of tokenizeSearchText(node.id)) add(t, node.id);
    for (const t of tokenizeSearchText(node.label)) add(t, node.id);
    if (node.type === 'export-symbol' && node.data) {
      if (node.data.signature) for (const t of tokenizeSearchText(node.data.signature)) add(t, node.id);
      if (node.data.typeValue) for (const t of tokenizeSearchText(node.data.typeValue)) add(t, node.id);
      for (const iface of node.data.implementsInterfaces ?? []) {
        for (const t of tokenizeSearchText(iface)) add(t, node.id);
      }
    }
  }
  return index;
}

function buildAnnotatedSearchIndex(
  graph: RepositoryGraph,
  annotationTextByNodeId: Record<string, string>,
): RepovineState['searchIndex'] {
  const index = buildTestSearchIndex(graph);
  const add = (token: string, nodeId: string) => {
    if (!token) return;
    let set = index.tokens.get(token);
    if (!set) { set = new Set(); index.tokens.set(token, set); }
    set.add(nodeId);
  };
  for (const [nodeId, text] of Object.entries(annotationTextByNodeId)) {
    index.annotationText.set(nodeId, text.toLowerCase());
    for (const token of tokenizeSearchText(text)) add(token, nodeId);
  }
  return index;
}

function buildFixtureGraph(): { graph: RepositoryGraph; modulesById: Map<string, ModuleInfo> } {
  const g = createEmptyGraph();
  addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
  addNode(g, { id: 'pkg:test', type: 'package', label: 'test', description: '' });
  addNode(g, { id: 'mod:test/alpha', type: 'module', label: 'alpha', description: '',
    data: { filePath: '/repo/alpha.ts', relativeFilePath: 'alpha.ts' } });
  addNode(g, { id: 'mod:test/beta', type: 'module', label: 'beta', description: '',
    data: { filePath: '/repo/beta.ts', relativeFilePath: 'beta.ts' } });
  addNode(g, { id: 'export:test/alpha/Foo', type: 'export-symbol', label: 'Foo', description: '',
    data: { signature: 'function Foo(): void', symbolKind: 'function', lineRange: { start: 1, end: 5 } } });

  addEdge(g, 'root', 'pkg:test', 'contains');
  addEdge(g, 'pkg:test', 'mod:test/alpha', 'contains');
  addEdge(g, 'pkg:test', 'mod:test/beta', 'contains');
  addEdge(g, 'mod:test/alpha', 'export:test/alpha/Foo', 'contains');
  addEdge(g, 'mod:test/beta', 'mod:test/alpha', 'imports');

  const alphaInfo = makeModuleInfo('mod:test/alpha', '/repo/alpha.ts');
  alphaInfo.imports = [{ moduleSpecifier: './alpha', resolvedModuleId: 'mod:test/alpha', importedNames: ['Foo'], isTypeOnly: false, isExternal: false }];
  const betaInfo = makeModuleInfo('mod:test/beta', '/repo/beta.ts');
  betaInfo.imports = [{ moduleSpecifier: './alpha', resolvedModuleId: 'mod:test/alpha', importedNames: ['Foo'], isTypeOnly: false, isExternal: false }];

  const modulesById = new Map<string, ModuleInfo>([
    ['mod:test/alpha', alphaInfo],
    ['mod:test/beta', betaInfo],
  ]);

  return { graph: g, modulesById };
}

function buildSearchModeFixture(): { graph: RepositoryGraph; modulesById: Map<string, ModuleInfo> } {
  const g = createEmptyGraph();
  addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
  addNode(g, { id: 'pkg:app', type: 'package', label: 'app', description: '' });
  addNode(g, { id: 'domain:order', type: 'domain', label: 'order', description: '', data: { tier: 'feature' } });
  addNode(g, { id: 'domain:route', type: 'domain', label: 'route', description: '', data: { tier: 'technical' } });

  const modules = [
    {
      id: 'mod:app/src/features/order/OrderRoute',
      label: 'src/features/order/OrderRoute',
      filePath: '/repo/packages/app/src/features/order/OrderRoute.tsx',
      relativeFilePath: 'src/features/order/OrderRoute.tsx',
      tags: ['domain:order', 'domain:route'],
    },
    {
      id: 'mod:app/src/features/order/OrderService',
      label: 'src/features/order/OrderService',
      filePath: '/repo/packages/app/src/features/order/OrderService.ts',
      relativeFilePath: 'src/features/order/OrderService.ts',
      tags: ['domain:order'],
    },
    {
      id: 'mod:app/src/features/report/ReportRoute',
      label: 'src/features/report/ReportRoute',
      filePath: '/repo/packages/app/src/features/report/ReportRoute.tsx',
      relativeFilePath: 'src/features/report/ReportRoute.tsx',
      tags: ['domain:route'],
    },
  ];

  addEdge(g, 'root', 'pkg:app', 'contains');
  const modulesById = new Map<string, ModuleInfo>();
  for (const mod of modules) {
    addNode(g, {
      id: mod.id,
      type: 'module',
      label: mod.label,
      description: '',
      data: { filePath: mod.filePath, relativeFilePath: mod.relativeFilePath },
    });
    addEdge(g, 'pkg:app', mod.id, 'contains');
    for (const tag of mod.tags) addEdge(g, mod.id, tag, 'tagged');
    const info = makeModuleInfo(mod.id, mod.filePath);
    info.packageName = 'app';
    info.relativeFilePath = mod.relativeFilePath;
    modulesById.set(mod.id, info);
  }

  return { graph: g, modulesById };
}

function buildAnnotationEscalationFixture(): { graph: RepositoryGraph; modulesById: Map<string, ModuleInfo> } {
  const g = createEmptyGraph();
  addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
  addNode(g, { id: 'pkg:app', type: 'package', label: 'app', description: '' });
  addEdge(g, 'root', 'pkg:app', 'contains');

  const modules = [
    {
      id: 'mod:app/src/AlphaAnchor',
      label: 'AlphaAnchor',
      filePath: '/repo/packages/app/src/AlphaAnchor.ts',
      relativeFilePath: 'src/AlphaAnchor.ts',
    },
    {
      id: 'mod:app/src/BetaNeedle',
      label: 'BetaNeedle',
      filePath: '/repo/packages/app/src/BetaNeedle.ts',
      relativeFilePath: 'src/BetaNeedle.ts',
    },
  ];
  const modulesById = new Map<string, ModuleInfo>();
  for (const mod of modules) {
    addNode(g, {
      id: mod.id,
      type: 'module',
      label: mod.label,
      description: '',
      data: { filePath: mod.filePath, relativeFilePath: mod.relativeFilePath },
    });
    addEdge(g, 'pkg:app', mod.id, 'contains');
    const info = makeModuleInfo(mod.id, mod.filePath);
    info.packageName = 'app';
    info.relativeFilePath = mod.relativeFilePath;
    modulesById.set(mod.id, info);
  }

  return { graph: g, modulesById };
}

/** Default "normal" profile thresholds; tests can override via overrides.refactoringThresholds. */
function defaultRefactoringThresholds(): RepovineState['refactoringThresholds'] {
  return {
    duplicateLike:        { minGroupSize: 3, minPackages: 2 },
    godModule:            { minScore: 18, linesPerScorePoint: 150 },
    godDomain:            { minModules: 50, minSubdomains: 5 },
    lowCohesion:          { minDomainSize: 8 },
    flowConvergence:      { maxBfsDepth: 5 },
    effectSpaghetti:      { minEffects: 3, minNestedSideEffects: 3, minSideEffectKinds: 2 },
    propDrillingOrchestration: { minProps: 8, minCallbackProps: 3, minChildComponents: 3, minForwardedRatio: 0.45, minForwardedProps: 4, minTunnelDepth: 2, minWorkflowSignals: 2 },
    serviceWrapperExplosion: { minGroupSize: 4, maxFanIn: 1, maxLineCount: 140 },
    uiDomainCoupling:     { minCoupledImports: 1 },
    routeConvergence:     { maxBfsDepth: 5, minEntrypoints: 2 },
    annotationRisk:       { minImportance: 8, minQualityScore: 3, derivedStalePenalty: 2, derivedStaleHopLimit: 2 },
    unclearArchitecture:  { minDomainTags: 5 },
    secretConfigBoundary: { minEvidenceScore: 1, flagGenericPublicAuthEnv: true },
    authorizationPolicyDrift: { minModules: 2, minFeatureGroups: 2, allowGeneralSubject: true, requireAuthzSignal: false },
    trustBoundaryValidation: { minEvidenceScore: 1, requireRouteOrSideEffect: false },
    privilegedClientSideEffect: { minEvidenceScore: 1, includeMutationOnly: true, allowGenericStorageName: true },
    sensitiveBrowserStorage: { requireSensitiveKey: false, minAnnotationStorageSignals: 1 },
    serverClientBoundary: { minTargets: 1, allowGenericStorageName: true },
    sourceDisclosureSurface: { minEvidenceScore: 1 },
    annotationSecretHygiene: { enabled: true },
  };
}

function defaultDomainsSuggestions(): RepovineState['domainsSuggestions'] {
  return { additions: [], count: 0, axes: [], declinedHidden: 0, mergedConfig: {}, keepConfig: {} };
}

function wrapTestRuntime(state: RepovineState, repoRoot = '/repo'): McpToolRuntime {
  return {
    getState: () => state,
    getConfig: () => CONFIG_DEFAULTS,
    refreshRepoState: () => {},
    repoRoot,
  };
}

function makeCtx(overrides?: Partial<RepovineState>): McpToolRuntime {
  const { graph, modulesById } = buildFixtureGraph();
  const annotations = {
    get: () => undefined,
    set: jest.fn(),
    isFresh: () => true,
    getQueue: () => [],
    getStats: () => backlogCoverage({
      byTier: {
        business: { domains: [], totalModules: 0 },
        feature: { domains: [], totalModules: 0 },
        layer: { domains: [], totalModules: 0 },
        technical: { domains: [], totalModules: 0 },
      },
    }),
    getAll: () => ({}),
    flushAsync: jest.fn(async () => {}),
    lastSaveError: null,
  } as unknown as RepovineState['annotations'];

  const stateGraph = overrides?.graph ?? graph;
  const stateModulesById = overrides?.modulesById ?? modulesById;

  const state: RepovineState = {
    graph: stateGraph,
    snapshot: makeSnapshot([...stateModulesById.values()]),
    modulesById: stateModulesById,
    searchIndex: buildTestSearchIndex(stateGraph),
    semanticIndex: null,
    semanticSearchRefresh: { status: 'disabled' },
    annotations,
    domainsConfig: null,
    domainsSuggestions: defaultDomainsSuggestions(),
    refactoringThresholds: defaultRefactoringThresholds(),
    builtAt: '2024-01-01',
    ...overrides,
  };

  // Mirror composeRepositoryGraph's composer step: populate the layer entrypoint store so the MCP
  // shell can replay layer-owned entrypoints (jsx/file-page/python-api/file-api/service triggers).
  const layerCtx: InterpreterEntrypointContext = {
    graph: state.graph,
    snapshot: state.snapshot,
    modulesById: state.modulesById,
    sourcePluginIds: [],
    log: () => undefined,
  };
  rememberInterpreterEntrypoints(state.graph, [
    ...collectBackendRouteEntrypoints(layerCtx),
    ...collectUiRouteEntrypoints(layerCtx),
    ...collectServiceTriggerEntrypoints(layerCtx),
  ]);

  return wrapTestRuntime(state);
}

function makeEmptyCtx(): McpToolRuntime {
  const graph = createEmptyGraph();
  return makeCtx({
    graph,
    modulesById: new Map(),
    snapshot: makeSnapshot([]),
    searchIndex: buildTestSearchIndex(graph),
  });
}

function expectFinding<T extends { id?: string }>(findings: T[], id: string): T {
  const finding = findings.find(f => f.id === id);
  expect(finding).toBeDefined();
  return finding!;
}

// ── inspect_node investigate tags ──

describe('inspect_node investigate tags', () => {
  it('tags links with investigate:["risk"] when the target carries a consumer-scoped risk', async () => {
    const { graph, modulesById } = buildFixtureGraph();
    const annotations = {
      get: (id: string) => {
        if (id === 'mod:test/alpha') {
          return {
            nodeId: 'mod:test/alpha',
            nodeType: 'module',
            contentHash: 'abc123',
            pass: 1,
            updatedAt: '2024-01-01',
            annotation: {
              summary: 'Alpha module',
              risks: [{ text: 'importers must verify gate', scope: 'consumer' }],
            },
          };
        }
        return undefined;
      },
      isFresh: () => true,
    } as unknown as RepovineState['annotations'];

    const ctx = makeCtx({ graph, modulesById, annotations });
    const view = (await buildInspectNodeDetail(ctx, { nodeId: 'mod:test/beta' })) as {
      links?: Array<{ targetId: string; investigate?: string[] }>;
    };

    const alphaLink = view.links?.find((link) => link.targetId === 'mod:test/alpha');
    expect(alphaLink?.investigate).toEqual(['risk']);
  });

  it('does not tag investigate for local-only or absent risks', async () => {
    const { graph, modulesById } = buildFixtureGraph();
    const annotations = {
      get: (id: string) => {
        if (id === 'mod:test/alpha') {
          return {
            nodeId: 'mod:test/alpha',
            nodeType: 'module',
            contentHash: 'abc123',
            pass: 1,
            updatedAt: '2024-01-01',
            annotation: {
              summary: 'Alpha module',
              risks: ['local-only risk'],
            },
          };
        }
        return undefined;
      },
      isFresh: () => true,
    } as unknown as RepovineState['annotations'];

    const ctx = makeCtx({ graph, modulesById, annotations });
    const view = (await buildInspectNodeDetail(ctx, { nodeId: 'mod:test/beta' })) as {
      links?: Array<{ targetId: string; investigate?: string[] }>;
    };

    const alphaLink = view.links?.find((link) => link.targetId === 'mod:test/alpha');
    expect(alphaLink?.investigate).toBeUndefined();
  });

  it('surfaces a transitive dependency named in integrationPoints as a hop-1 investigate pointer', async () => {
    // gamma → beta → alpha. alpha (2 hops, consumer risk) is named in gamma.integrationPoints but
    // is not a structural link of gamma; the integrationPoints channel must reach it.
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'pkg:test', type: 'package', label: 'test', description: '' });
    for (const name of ['alpha', 'beta', 'gamma']) {
      addNode(g, { id: `mod:test/${name}`, type: 'module', label: name, description: '',
        data: { filePath: `/repo/${name}.ts`, relativeFilePath: `${name}.ts` } });
      addEdge(g, 'pkg:test', `mod:test/${name}`, 'contains');
    }
    addEdge(g, 'root', 'pkg:test', 'contains');
    addEdge(g, 'mod:test/gamma', 'mod:test/beta', 'imports');
    addEdge(g, 'mod:test/beta', 'mod:test/alpha', 'imports');

    const modulesById = new Map<string, ModuleInfo>([
      ['mod:test/gamma', makeModuleInfo('mod:test/gamma', '/repo/gamma.ts')],
      ['mod:test/beta', makeModuleInfo('mod:test/beta', '/repo/beta.ts')],
      ['mod:test/alpha', makeModuleInfo('mod:test/alpha', '/repo/alpha.ts')],
    ]);

    const annotations = {
      get: (id: string) => {
        if (id === 'mod:test/gamma') {
          return {
            nodeId: id, nodeType: 'module', contentHash: 'g', pass: 1, updatedAt: '2024-01-01',
            annotation: { summary: 'Gamma', integrationPoints: 'authoritative gate lives in mod:test/alpha' },
          };
        }
        if (id === 'mod:test/alpha') {
          return {
            nodeId: id, nodeType: 'module', contentHash: 'a', pass: 1, updatedAt: '2024-01-01',
            annotation: { summary: 'Alpha', risks: [{ text: 'importers must verify gate', scope: 'consumer' }] },
          };
        }
        return undefined;
      },
      isFresh: () => true,
    } as unknown as RepovineState['annotations'];

    const ctx = makeCtx({ graph: g, modulesById, annotations });
    const view = (await buildInspectNodeDetail(ctx, { nodeId: 'mod:test/gamma' })) as {
      links?: Array<{ targetId: string; investigate?: string[] }>;
      investigatePointers?: Array<{ id: string; investigate: string[]; via: string }>;
    };

    // beta is the 1-hop structural link and carries no risk; alpha arrives via the integrationPoints channel.
    expect(view.links?.find((l) => l.targetId === 'mod:test/beta')?.investigate).toBeUndefined();
    expect(view.investigatePointers).toEqual([
      { id: 'mod:test/alpha', investigate: ['risk'], via: 'integrationPoints' },
    ]);

    // the pointer is also surfaced as a must-inspect navigation hint via the full handler.
    const envelope = await toolHandlers['inspect_node'](ctx, { nodeId: 'mod:test/gamma' });
    const navigation = envelope.navigation as Record<string, Array<{ tool: string; args: Record<string, unknown> }>>;
    expect(navigation.deeper).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'inspect_node', args: { nodeId: 'mod:test/alpha' } }),
    ]));
  });
});

describe('inspect_node salience ordering + attention', () => {
  /** alpha with 4 export children; the last one (Qux) carries a consumer-scoped risk. */
  function fixtureWithTaggedLastChild() {
    const { graph, modulesById } = buildFixtureGraph();
    for (const [name, start] of [['Bar', 6], ['Baz', 11], ['Qux', 16]] as const) {
      addNode(graph, { id: `export:test/alpha/${name}`, type: 'export-symbol', label: name, description: '',
        data: { signature: `function ${name}(): void`, symbolKind: 'function', lineRange: { start, end: start + 4 } } });
      addEdge(graph, 'mod:test/alpha', `export:test/alpha/${name}`, 'contains');
    }
    const annotations = {
      get: (id: string) =>
        id === 'export:test/alpha/Qux'
          ? {
              nodeId: id, nodeType: 'export-symbol', contentHash: 'abc123', pass: 1, updatedAt: '2024-01-01',
              annotation: { summary: 'Qux', risks: [{ text: 'importers must verify gate', scope: 'consumer' }] },
            }
          : undefined,
      isFresh: () => true,
    } as unknown as RepovineState['annotations'];
    return { graph, modulesById, annotations };
  }

  it('floats a tagged child past exportLimit onto page 1 without changing affordanceCount', async () => {
    const { graph, modulesById, annotations } = fixtureWithTaggedLastChild();
    const ctx = makeCtx({ graph, modulesById, annotations });

    const result = await toolHandlers['inspect_node'](ctx, { nodeId: 'mod:test/alpha', exportLimit: 2 });
    const detail = result.result as { drillDown: Array<{ id: string; investigate?: string[] }>; truncation: { children: { total: number } }; affordanceCount: number };

    // Qux sits at source index 3 (past exportLimit 2); the partition surfaces it on page 1.
    expect(detail.drillDown[0].id).toBe('export:test/alpha/Qux');
    expect(detail.drillDown[0].investigate).toEqual(['risk']);
    expect(detail.drillDown).toHaveLength(2);
    expect(detail.truncation.children.total).toBe(4); // counting unchanged by ordering
    expect(detail.affordanceCount).toBe(4);
  });

  it('hoists the tagged child into a top-level attention block (≤3 items)', async () => {
    const { graph, modulesById, annotations } = fixtureWithTaggedLastChild();
    const ctx = makeCtx({ graph, modulesById, annotations });

    const result = await toolHandlers['inspect_node'](ctx, { nodeId: 'mod:test/alpha', exportLimit: 2 });
    const attention = result.attention as Array<{ nodeId: string; investigate: string[]; note: string; next: { tool: string; args: Record<string, unknown>; reason: string } }>;

    expect(Array.isArray(attention)).toBe(true);
    expect(attention.length).toBeGreaterThan(0);
    expect(attention.length).toBeLessThanOrEqual(3);
    const item = attention.find((a) => a.nodeId === 'export:test/alpha/Qux');
    expect(item).toBeDefined();
    expect(item!.investigate).toEqual(['risk']);
    expect(item!.next).toEqual({ tool: 'inspect_node', args: { nodeId: 'export:test/alpha/Qux' }, reason: expect.any(String) });
    expect(typeof item!.note).toBe('string');
  });

  it('omits the attention block when no obligation exists', async () => {
    const ctx = makeCtx(); // default annotations resolve to undefined → no tags
    const result = await toolHandlers['inspect_node'](ctx, { nodeId: 'mod:test/alpha' });
    expect(result.attention).toBeUndefined();
  });

  it('keeps `hub` out of the attention block while it stays an inline ref tag', async () => {
    // alpha: consumer risk + 8 importers (risk + hub). shared: 8 importers, no annotation (hub only).
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'pkg:test', type: 'package', label: 'test', description: '' });
    addEdge(g, 'root', 'pkg:test', 'contains');
    for (const name of ['alpha', 'shared', 'beta']) {
      addNode(g, { id: `mod:test/${name}`, type: 'module', label: name, description: '',
        data: { filePath: `/repo/${name}.ts`, relativeFilePath: `${name}.ts` } });
      addEdge(g, 'pkg:test', `mod:test/${name}`, 'contains');
    }
    for (let i = 0; i < 8; i++) {
      addNode(g, { id: `mod:test/imp${i}`, type: 'module', label: `imp${i}`, description: '',
        data: { filePath: `/repo/imp${i}.ts`, relativeFilePath: `imp${i}.ts` } });
      addEdge(g, `mod:test/imp${i}`, 'mod:test/alpha', 'imports');
      addEdge(g, `mod:test/imp${i}`, 'mod:test/shared', 'imports');
    }
    addEdge(g, 'mod:test/beta', 'mod:test/alpha', 'imports');
    addEdge(g, 'mod:test/beta', 'mod:test/shared', 'imports');

    const modulesById = new Map<string, ModuleInfo>([
      ['mod:test/beta', makeModuleInfo('mod:test/beta', '/repo/beta.ts')],
      ['mod:test/alpha', makeModuleInfo('mod:test/alpha', '/repo/alpha.ts')],
      ['mod:test/shared', makeModuleInfo('mod:test/shared', '/repo/shared.ts')],
    ]);
    const annotations = {
      get: (id: string) =>
        id === 'mod:test/alpha'
          ? { nodeId: id, nodeType: 'module', contentHash: 'abc123', pass: 1, updatedAt: '2024-01-01',
              annotation: { summary: 'Alpha', risks: [{ text: 'importers must verify gate', scope: 'consumer' }] } }
          : undefined,
      isFresh: () => true,
    } as unknown as RepovineState['annotations'];

    const ctx = makeCtx({ graph: g, modulesById, annotations });
    const env = await toolHandlers['inspect_node'](ctx, { nodeId: 'mod:test/beta' });

    // inline ref tags still carry hub (alpha = risk+hub, shared = hub)
    const links = (env.result as { links: Array<{ targetId: string; investigate?: string[] }> }).links;
    expect(links.find((l) => l.targetId === 'mod:test/alpha')?.investigate).toEqual(expect.arrayContaining(['risk', 'hub']));
    expect(links.find((l) => l.targetId === 'mod:test/shared')?.investigate).toEqual(['hub']);

    // attention: alpha present as risk-only (hub stripped); shared (hub-only) absent; no item carries hub
    const attention = env.attention as Array<{ nodeId: string; investigate: string[] }>;
    const alpha = attention.find((a) => a.nodeId === 'mod:test/alpha');
    expect(alpha?.investigate).toEqual(['risk']);
    expect(attention.some((a) => a.nodeId === 'mod:test/shared')).toBe(false);
    expect(attention.every((a) => !a.investigate.includes('hub'))).toBe(true);
  });

  /** beta imports alpha; a lambda resource dispatches into alpha via an `infra` edge. */
  function wiredFixture() {
    const { graph, modulesById } = buildFixtureGraph();
    addNode(graph, { id: 'resource:aws/lambda/AlphaFn', type: 'runtime-resource', label: 'AlphaFn', description: '' });
    addEdge(graph, 'resource:aws/lambda/AlphaFn', 'mod:test/alpha', 'infra');
    return { graph, modulesById };
  }

  it('keeps `wiring` inline-only on refs: the wired target is tagged but never hoisted to attention', async () => {
    const { graph, modulesById } = wiredFixture();
    const ctx = makeCtx({ graph, modulesById });

    const env = await toolHandlers['inspect_node'](ctx, { nodeId: 'mod:test/beta' });
    const links = (env.result as { links: Array<{ targetId: string; investigate?: string[] }> }).links;
    expect(links.find((l) => l.targetId === 'mod:test/alpha')?.investigate).toEqual(['wiring']);
    // beta itself is unwired and alpha's wiring is advisory → no attention block at all.
    expect(env.attention).toBeUndefined();
  });

  it('leads with the self wiring item on a wired module: resource named, trace_flow next', async () => {
    const { graph, modulesById } = wiredFixture();
    const ctx = makeCtx({ graph, modulesById });

    const env = await toolHandlers['inspect_node'](ctx, { nodeId: 'mod:test/alpha' });
    const attention = env.attention as Array<{ nodeId: string; investigate: string[]; note: string; next: { tool: string; args: Record<string, unknown>; reason: string } }>;
    expect(attention[0].nodeId).toBe('mod:test/alpha');
    expect(attention[0].investigate).toEqual(['wiring']);
    expect(attention[0].note).toContain('AlphaFn');
    expect(attention[0].next).toEqual({ tool: 'trace_flow', args: { scope: 'mod:test/alpha' }, reason: expect.any(String) });
  });

  it('orders self attention [boundary, wiring, ...] when both fire on the inspected node', async () => {
    const { graph, modulesById } = wiredFixture();
    const annotations = {
      get: (id: string) =>
        id === 'mod:test/alpha'
          ? { nodeId: id, nodeType: 'module', contentHash: 'abc123', pass: 1, updatedAt: '2024-01-01',
              annotation: { summary: 'Alpha', risks: [{ text: 'frozen contract', scope: 'boundary' }] } }
          : undefined,
      isFresh: () => true,
    } as unknown as RepovineState['annotations'];
    const ctx = makeCtx({ graph, modulesById, annotations });

    const env = await toolHandlers['inspect_node'](ctx, { nodeId: 'mod:test/alpha' });
    const attention = env.attention as Array<{ nodeId: string; investigate: string[] }>;
    expect(attention[0].investigate).toEqual(['boundary']);
    expect(attention[1].investigate).toEqual(['wiring']);
    expect(attention[0].nodeId).toBe('mod:test/alpha');
    expect(attention[1].nodeId).toBe('mod:test/alpha');
    expect(attention.length).toBeLessThanOrEqual(3);
  });

  it('caps attention at 3 with self items leading: [boundary, wiring, best ref]; weaker refs yield', async () => {
    const { graph, modulesById } = wiredFixture();
    // Two children of alpha carry consumer risks — two ref obligations compete for the last slot.
    for (const [name, start] of [['Qux1', 6], ['Qux2', 11]] as const) {
      addNode(graph, { id: `export:test/alpha/${name}`, type: 'export-symbol', label: name, description: '',
        data: { signature: `function ${name}(): void`, symbolKind: 'function', lineRange: { start, end: start + 4 } } });
      addEdge(graph, 'mod:test/alpha', `export:test/alpha/${name}`, 'contains');
    }
    const annotations = {
      get: (id: string) => {
        if (id === 'mod:test/alpha') {
          return { nodeId: id, nodeType: 'module', contentHash: 'abc123', pass: 1, updatedAt: '2024-01-01',
            annotation: { summary: 'Alpha', risks: [{ text: 'frozen contract', scope: 'boundary' }] } };
        }
        if (id.startsWith('export:test/alpha/Qux')) {
          return { nodeId: id, nodeType: 'export-symbol', contentHash: 'abc123', pass: 1, updatedAt: '2024-01-01',
            annotation: { summary: id, risks: [{ text: 'importers must verify gate', scope: 'consumer' }] } };
        }
        return undefined;
      },
      isFresh: () => true,
    } as unknown as RepovineState['annotations'];
    const ctx = makeCtx({ graph, modulesById, annotations });

    const env = await toolHandlers['inspect_node'](ctx, { nodeId: 'mod:test/alpha' });
    const attention = env.attention as Array<{ nodeId: string; investigate: string[] }>;
    expect(attention).toHaveLength(3);
    expect(attention[0].investigate).toEqual(['boundary']);
    expect(attention[1].investigate).toEqual(['wiring']);
    expect(attention[2].nodeId).toMatch(/^export:test\/alpha\/Qux/);
    expect(attention[2].investigate).toEqual(['risk']);
  });

  it('does not emit a must-inspect navigation line for an advisory-only integrationPoints pointer', async () => {
    // gamma → beta → alpha; alpha is runtime-wired but carries no annotation risk. gamma names alpha
    // in integrationPoints → the pointer materializes inline with ['wiring'] but is not must-inspect.
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'pkg:test', type: 'package', label: 'test', description: '' });
    addEdge(g, 'root', 'pkg:test', 'contains');
    for (const name of ['alpha', 'beta', 'gamma']) {
      addNode(g, { id: `mod:test/${name}`, type: 'module', label: name, description: '',
        data: { filePath: `/repo/${name}.ts`, relativeFilePath: `${name}.ts` } });
      addEdge(g, 'pkg:test', `mod:test/${name}`, 'contains');
    }
    addEdge(g, 'mod:test/gamma', 'mod:test/beta', 'imports');
    addEdge(g, 'mod:test/beta', 'mod:test/alpha', 'imports');
    addNode(g, { id: 'resource:aws/lambda/AlphaFn', type: 'runtime-resource', label: 'AlphaFn', description: '' });
    addEdge(g, 'resource:aws/lambda/AlphaFn', 'mod:test/alpha', 'infra');

    const modulesById = new Map<string, ModuleInfo>([
      ['mod:test/gamma', makeModuleInfo('mod:test/gamma', '/repo/gamma.ts')],
      ['mod:test/beta', makeModuleInfo('mod:test/beta', '/repo/beta.ts')],
      ['mod:test/alpha', makeModuleInfo('mod:test/alpha', '/repo/alpha.ts')],
    ]);
    const annotations = {
      get: (id: string) =>
        id === 'mod:test/gamma'
          ? { nodeId: id, nodeType: 'module', contentHash: 'g', pass: 1, updatedAt: '2024-01-01',
              annotation: { summary: 'Gamma', integrationPoints: 'runtime handler lives in mod:test/alpha' } }
          : undefined,
      isFresh: () => true,
    } as unknown as RepovineState['annotations'];

    const ctx = makeCtx({ graph: g, modulesById, annotations });
    const env = await toolHandlers['inspect_node'](ctx, { nodeId: 'mod:test/gamma' });

    const pointers = (env.result as { investigatePointers?: Array<{ id: string; investigate: string[] }> }).investigatePointers;
    expect(pointers).toEqual([
      { id: 'mod:test/alpha', investigate: ['wiring'], via: 'integrationPoints' },
    ]);
    const navigation = env.navigation as Record<string, Array<{ reason?: string; args: Record<string, unknown> }>>;
    const mustInspect = navigation.deeper.filter((n) => (n.reason ?? '').includes('must-inspect'));
    expect(mustInspect).toEqual([]);
    // advisory-only pointer also stays out of attention
    const attention = env.attention as Array<{ nodeId: string }> | undefined;
    expect(attention?.some((a) => a.nodeId === 'mod:test/alpha') ?? false).toBe(false);
  });

  it('keeps `co-change` inline-only: an implementing child is tagged but never hoisted to attention', async () => {
    const { graph, modulesById } = buildFixtureGraph();
    addNode(graph, { id: 'export:test/beta/Iface', type: 'export-symbol', label: 'Iface', description: '',
      data: { signature: 'interface Iface', symbolKind: 'interface', lineRange: { start: 1, end: 3 } } });
    addEdge(graph, 'mod:test/beta', 'export:test/beta/Iface', 'contains');
    addEdge(graph, 'export:test/alpha/Foo', 'export:test/beta/Iface', 'implements');
    const ctx = makeCtx({ graph, modulesById });

    const env = await toolHandlers['inspect_node'](ctx, { nodeId: 'mod:test/alpha' });
    const detail = env.result as { drillDown: Array<{ id: string; investigate?: string[] }> };
    expect(detail.drillDown.find((c) => c.id === 'export:test/alpha/Foo')?.investigate).toEqual(['co-change']);
    expect(env.attention).toBeUndefined();
  });
});

// ── inspect_node domain freshness (regression) ──

describe('inspect_node domain freshness', () => {
  // Regression: domain nodes fell through inspect-node-core's `else { fresh = true }` default, so
  // annotationMeta.fresh was hardcoded true even when get_annotation_status reported the domain as
  // staleKind:content. inspect_node must mirror the queue/coverage resolveDomainContentHash check.
  const domainAnnotations = (storedHash: string) =>
    ({
      get: (id: string) =>
        id === 'domain:order'
          ? {
              nodeId: 'domain:order',
              nodeType: 'domain',
              contentHash: storedHash,
              pass: 1,
              updatedAt: '2024-01-01',
              schemaVersion: 1,
              annotation: { summary: 'Order domain rollup' },
            }
          : undefined,
    }) as unknown as RepovineState['annotations'];

  it('reports a content-stale domain as fresh:false (consistent with the queue/coverage)', async () => {
    const { graph, modulesById } = buildSearchModeFixture();
    const snapshot = makeSnapshot([...modulesById.values()]);
    const ctx = makeCtx({
      graph,
      modulesById,
      snapshot,
      annotations: domainAnnotations('stale-deliberately-wrong-hash'),
    });
    const view = (await buildInspectNodeDetail(ctx, { nodeId: 'domain:order' })) as {
      annotationMeta?: { fresh?: boolean };
    };
    expect(view.annotationMeta).toBeDefined();
    expect(view.annotationMeta!.fresh).toBe(false);
  });

  it('reports an up-to-date domain as fresh:true', async () => {
    const { graph, modulesById } = buildSearchModeFixture();
    const snapshot = makeSnapshot([...modulesById.values()]);
    const propagation = CONFIG_DEFAULTS.annotations.propagation ?? DEFAULT_PROPAGATION_CONFIG;
    const currentHash = resolveDomainContentHash(graph, snapshot, 'domain:order', propagation);
    expect(currentHash).toBeDefined();
    const ctx = makeCtx({
      graph,
      modulesById,
      snapshot,
      annotations: domainAnnotations(currentHash!),
    });
    const view = (await buildInspectNodeDetail(ctx, { nodeId: 'domain:order' })) as {
      annotationMeta?: { fresh?: boolean };
    };
    expect(view.annotationMeta!.fresh).toBe(true);
  });

  // write_annotation stores `contentHash: 'unknown'` for node types it cannot hash (export symbols,
  // packages, root). On a node that does hash, such a note is unconfirmed — the annotation queue
  // ranks it for rewrite — and `provenance` says no comparison stands behind that.
  it('reports no-baseline when the stored hash is unknown on a hashable node', async () => {
    const { graph, modulesById } = buildSearchModeFixture();
    const snapshot = makeSnapshot([...modulesById.values()]);
    const ctx = makeCtx({
      graph,
      modulesById,
      snapshot,
      annotations: domainAnnotations('unknown'),
    });
    const view = (await buildInspectNodeDetail(ctx, { nodeId: 'domain:order' })) as {
      annotationMeta?: { fresh?: boolean; staleReason?: string; provenance?: { basis: string; method: string } };
    };
    expect(view.annotationMeta).toBeDefined();
    expect(view.annotationMeta!.fresh).toBe(false);
    expect(view.annotationMeta!.staleReason).toBe('no-baseline');
    expect(view.annotationMeta!.provenance).toEqual({ basis: 'absent', method: 'not-comparable' });
  });

  it('names content-hash as the source when a comparison did run', async () => {
    const { graph, modulesById } = buildSearchModeFixture();
    const snapshot = makeSnapshot([...modulesById.values()]);
    const ctx = makeCtx({
      graph,
      modulesById,
      snapshot,
      annotations: domainAnnotations('stale-deliberately-wrong-hash'),
    });
    const view = (await buildInspectNodeDetail(ctx, { nodeId: 'domain:order' })) as {
      annotationMeta?: { provenance?: { basis: string; method: string } };
    };
    expect(view.annotationMeta!.provenance).toEqual({ basis: 'computed', method: 'content-hash' });
  });
});

// ── inspect_node runtime-resource freshness (multi-declaration) ──

describe('inspect_node runtime-resource freshness', () => {
  // inspect_node resolves the resource hash without the queue's prebuilt lookup; both sides must
  // agree on an id declared in several infra files. The stored value below is the queue's lookup
  // value — inspect reporting it fresh is the inspect↔queue agreement the set-hash resolver
  // guarantees, independent of infra file-scan order.
  const gatewayId = 'resource:aws-lambda:Gateway';
  const makeStack = (id: string, fileHash: string, resourceHash: string): InfraModuleInfo => ({
    id,
    kind: 'sam',
    filePath: `/repo/${id}.yaml`,
    relativeFilePath: `${id}.yaml`,
    contentHash: fileHash,
    resources: [{
      id: 'Gateway',
      kind: 'lambda',
      provider: 'aws',
      contentHash: resourceHash,
      attributes: { handler: 'src/gateway.handler' },
    }],
  });
  const resourceAnnotations = (storedHash: string) =>
    ({
      get: (id: string) =>
        id === gatewayId
          ? {
              nodeId: gatewayId,
              nodeType: 'runtime-resource',
              contentHash: storedHash,
              pass: 1,
              updatedAt: '2024-01-01',
              schemaVersion: 1,
              annotation: { summary: 'Gateway resource' },
            }
          : undefined,
    }) as unknown as RepovineState['annotations'];

  function makeResourceCtx(storedHash: string, infraModules: InfraModuleInfo[]): McpToolRuntime {
    const { graph, modulesById } = buildFixtureGraph();
    addNode(graph, {
      id: gatewayId,
      type: 'runtime-resource',
      label: 'Gateway',
      description: 'Lambda',
      data: { kind: 'lambda' },
    });
    const snapshot = makeSnapshot([...modulesById.values()]);
    snapshot.infraModules = infraModules;
    return makeCtx({ graph, modulesById, snapshot, annotations: resourceAnnotations(storedHash) });
  }

  const stacks = [
    makeStack('infra:sam:stack-a.yaml', 'file-a', 'decl-a'),
    makeStack('infra:sam:stack-b.yaml', 'file-b', 'decl-b'),
  ];

  it('reports fresh:true for a multi-declared resource stored with the queue lookup value, under both scan orders', async () => {
    const snapshot = makeSnapshot([]);
    snapshot.infraModules = stacks;
    const queueValue = buildRuntimeResourceContentHashLookup(snapshot).resourceHashByServiceId.get(gatewayId);
    expect(queueValue).toBeDefined();

    for (const infraModules of [stacks, [...stacks].reverse()]) {
      const view = (await buildInspectNodeDetail(makeResourceCtx(queueValue!, infraModules), { nodeId: gatewayId })) as {
        annotationMeta?: { fresh?: boolean };
      };
      expect(view.annotationMeta).toBeDefined();
      expect(view.annotationMeta!.fresh).toBe(true);
    }
  });

  it('reports fresh:false for a stored single-declaration fragment hash', async () => {
    const view = (await buildInspectNodeDetail(makeResourceCtx('decl-a', stacks), { nodeId: gatewayId })) as {
      annotationMeta?: { fresh?: boolean };
    };
    expect(view.annotationMeta!.fresh).toBe(false);
  });
});

// ── node id resolution (the ladder's exact-id rung, reached through its only entry point) ──

describe('resolveScope on a node id', () => {
  it('returns the id as-is when it exists exactly', () => {
    expect(resolveScope(makeCtx(), 'mod:test/alpha').nodeId).toBe('mod:test/alpha');
  });

  it('strips a .ts extension', () => {
    expect(resolveScope(makeCtx(), 'mod:test/alpha.ts').nodeId).toBe('mod:test/alpha');
  });

  it('strips an /index suffix', () => {
    const g = createEmptyGraph();
    addNode(g, { id: 'mod:pkg/utils', type: 'module', label: 'utils', description: '' });
    expect(resolveScope(makeCtx({ graph: g, modulesById: new Map() }), 'mod:pkg/utils/index').nodeId)
      .toBe('mod:pkg/utils');
  });

  it('leaves an unknown node unresolved rather than guessing', () => {
    const scope = resolveScope(makeCtx(), 'mod:test/nonexistent');
    expect(scope.nodeId).toBeUndefined();
    expect(scope.kind).toBe('unknown');
  });
});

// ── public v1 tools ──

function expectEnvelope(result: ToolResponse) {
  // The declared shape, not a hand-listed subset: a field added beside `result` fails here.
  const parsed = ToolResponseSchema.safeParse(result);
  expect(parsed.success ? [] : parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`)).toEqual([]);
}

describe('public v1 context tools', () => {
  it('records declined domains suggestions in local cache without writing committed config', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-domains-'));
    const addition = {
      id: 'infra.excludeSuffixes:LogGroup',
      axis: 'infra.excludeSuffixes' as const,
      value: 'LogGroup',
      count: 2,
      labels: ['OrdersLogGroup', 'UsersLogGroup'],
      reason: '2 infra resource label(s) end with LogGroup: OrdersLogGroup, UsersLogGroup',
    };
    const ctx = makeCtx({
      snapshot: { ...makeSnapshot([]), repoRoot },
      domainsSuggestions: {
        additions: [addition],
        count: 1,
        axes: ['infra.excludeSuffixes'],
        declinedHidden: 0,
        mergedConfig: { infra: { excludeSuffixes: ['LogGroup'] } },
        keepConfig: {},
      },
    });
    ctx.repoRoot = repoRoot;

    try {
      const result = await toolHandlers['decline_advisory'](ctx, {
        kind: 'domains-config',
        ids: [addition.id],
      });

      expectEnvelope(result);
      expect(result.summary).toContain('Declined 1');
      expect(result.result).toEqual(expect.objectContaining({
        declined: [addition.id],
        declinedTotal: 1,
        domainsSuggestions: expect.objectContaining({ count: 0, declinedHidden: 0 }),
      }));
      expect(JSON.parse(fs.readFileSync(path.join(repoRoot, '.repovine', 'onboarding-state.json'), 'utf-8'))).toEqual(
        expect.objectContaining({
          version: 1,
          graph: expect.objectContaining({ status: 'ready' }),
          onboarding: expect.objectContaining({
            domains: expect.objectContaining({
              suggestions: 0,
              declined: [addition.id],
            }),
          }),
        }),
      );
      expect(fs.existsSync(path.join(repoRoot, 'repovine.domains.json'))).toBe(false);
      expect(ctx.getState().domainsSuggestions.count).toBe(0);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('wraps inspect_node results in the shared navigation envelope', async () => {
    const ctx = makeCtx();
    const result = await toolHandlers['inspect_node'](ctx, { nodeId: 'mod:test/alpha' });

    expectEnvelope(result);
    expect(result.scope).toBe('mod:test/alpha');
    expect(result.resolvedScope).toMatchObject({ kind: 'module', id: 'mod:test/alpha' });
    expect(result.result).toEqual(expect.objectContaining({ id: 'mod:test/alpha' }));
  });

  it('paginates package drill-down in map_context', async () => {
    const ctx = makeCtx();
    const result = await toolHandlers['map_context'](ctx, {
      scope: 'pkg:test',
      view: 'modules',
      limit: 1,
    });

    expectEnvelope(result);
    const focus = (result.result as { focus: Record<string, unknown> }).focus;
    expect(focus.drillDown).toHaveLength(1);
    expect((focus.truncation as Record<string, unknown>).children).toMatchObject({
      shown: 1,
      total: 2,
      more: { kind: 'page', arg: 'offset', nextOffset: 1, hint: expect.any(String) },
    });
  });

  it('returns offset_out_of_range emptyDiagnostic for map_context pagination misses', async () => {
    const ctx = makeCtx();
    const result = await toolHandlers['map_context'](ctx, {
      scope: 'pkg:test',
      offset: 999,
    });

    expectEnvelope(result);
    expect(result.confidence).toBe('low');
    const focus = (result.result as { focus: Record<string, unknown> }).focus;
    expect((focus.truncation as Record<string, unknown>).children).toMatchObject({
      shown: 0,
      total: 2,
      more: { kind: 'arg', arg: 'offset', value: 0, hint: expect.any(String) },
    });
    expect(result.result).toEqual(expect.objectContaining({
      emptyDiagnostic: expect.objectContaining({
        reason: 'offset_out_of_range',
        confidence: 'high',
        details: expect.objectContaining({ total: 2, returned: 0, offset: 999 }),
        nextActions: expect.arrayContaining([
          expect.objectContaining({
            tool: 'map_context',
            args: expect.objectContaining({ scope: 'pkg:test', offset: 0 }),
          }),
        ]),
      }),
    }));
  });

  it('explains unresolved and structurally empty map_context results', async () => {
    const ctx = makeCtx();
    const unresolved = await toolHandlers['map_context'](ctx, { scope: 'pkg:missing' });

    expectEnvelope(unresolved);
    expect(unresolved.confidence).toBe('low');
    expect(unresolved.result).toEqual(expect.objectContaining({
      error: expect.stringContaining('Could not resolve scope'),
      emptyDiagnostic: expect.objectContaining({
        reason: 'scope_unresolved',
        nextActions: expect.arrayContaining([
          expect.objectContaining({ tool: 'search_context' }),
          expect.objectContaining({ tool: 'map_context', args: expect.objectContaining({ scope: 'all' }) }),
        ]),
      }),
    }));

    const { graph, modulesById } = buildFixtureGraph();
    addNode(graph, { id: 'pkg:empty', type: 'package', label: 'empty', description: '' });
    addEdge(graph, 'root', 'pkg:empty', 'contains');
    const emptyPackage = await toolHandlers['map_context'](
      makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) }),
      { scope: 'pkg:empty' },
    );

    expectEnvelope(emptyPackage);
    expect(emptyPackage.result).toEqual(expect.objectContaining({
      emptyDiagnostic: expect.objectContaining({
        reason: 'package_has_no_modules',
        nextActions: expect.arrayContaining([
          expect.objectContaining({ tool: 'analyze_dependencies' }),
          expect.objectContaining({ tool: 'search_context' }),
        ]),
      }),
    }));
  });

  it('returns graph_empty emptyDiagnostic for map_context when no graph context exists', async () => {
    const result = await toolHandlers['map_context'](makeEmptyCtx(), { scope: 'all' });

    expectEnvelope(result);
    expect(result.result).toEqual(expect.objectContaining({
      emptyDiagnostic: expect.objectContaining({ reason: 'graph_empty' }),
    }));
  });

  it('resolves package suffix and path-like module aliases', async () => {
    const { graph, modulesById } = buildFixtureGraph();
    addNode(graph, { id: 'pkg:@acme/client-ui', type: 'package', label: '@acme/client-ui', description: '' });
    addNode(graph, {
      id: 'mod:@acme/client-ui/src/pages/TickPricingPage',
      type: 'module',
      label: '…/pages/TickPricingPage',
      description: '',
      data: { filePath: '/repo/packages/client-ui/src/pages/TickPricingPage.tsx', relativeFilePath: 'src/pages/TickPricingPage.tsx' },
    });
    addEdge(graph, 'root', 'pkg:@acme/client-ui', 'contains');
    addEdge(graph, 'pkg:@acme/client-ui', 'mod:@acme/client-ui/src/pages/TickPricingPage', 'contains');
    const page = makeModuleInfo(
      'mod:@acme/client-ui/src/pages/TickPricingPage',
      '/repo/packages/client-ui/src/pages/TickPricingPage.tsx',
    );
    page.packageName = '@acme/client-ui';
    page.relativeFilePath = 'src/pages/TickPricingPage.tsx';
    modulesById.set(page.id, page);
    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });

    const pkgResult = await toolHandlers['map_context'](ctx, { scope: 'pkg:client-ui' });
    expectEnvelope(pkgResult);
    expect(pkgResult.resolvedScope).toMatchObject({ kind: 'package', id: 'pkg:@acme/client-ui' });

    const moduleResult = await toolHandlers['map_context'](ctx, { scope: 'packages/client-ui/src/pages/TickPricingPage.tsx' });
    expectEnvelope(moduleResult);
    expect(moduleResult.resolvedScope).toMatchObject({
      kind: 'module',
      id: 'mod:@acme/client-ui/src/pages/TickPricingPage',
    });
  });

  it('relaxes multi-token search to bounded OR with matched tokens and suggested scopes', async () => {
    const { graph, modulesById } = buildFixtureGraph();
    addNode(graph, { id: 'domain:routing', type: 'domain', label: 'routing', description: '', data: { tier: 'technical' } });
    addNode(graph, { id: 'domain:tickpricingpage', type: 'domain', label: 'tickpricingpage', description: '', data: { tier: 'technical', weight: 'lightweight' } });
    addNode(graph, { id: 'pkg:@acme/client-ui', type: 'package', label: '@acme/client-ui', description: '' });
    addNode(graph, {
      id: 'mod:@acme/client-ui/src/pages/TickPricingPage',
      type: 'module',
      label: '…/pages/TickPricingPage',
      description: '',
      data: { filePath: '/repo/packages/client-ui/src/pages/TickPricingPage.tsx', relativeFilePath: 'src/pages/TickPricingPage.tsx' },
    });
    addNode(graph, {
      id: 'mod:@acme/client-ui/src/components/Navbar',
      type: 'module',
      label: '…/components/Navbar',
      description: '',
      data: { filePath: '/repo/packages/client-ui/src/components/Navbar.tsx', relativeFilePath: 'src/components/Navbar.tsx' },
    });
    addEdge(graph, 'root', 'pkg:@acme/client-ui', 'contains');
    addEdge(graph, 'pkg:@acme/client-ui', 'mod:@acme/client-ui/src/pages/TickPricingPage', 'contains');
    addEdge(graph, 'pkg:@acme/client-ui', 'mod:@acme/client-ui/src/components/Navbar', 'contains');
    addEdge(graph, 'mod:@acme/client-ui/src/pages/TickPricingPage', 'domain:tickpricingpage', 'tagged');
    addEdge(graph, 'mod:@acme/client-ui/src/components/Navbar', 'domain:routing', 'tagged');

    const page = makeModuleInfo(
      'mod:@acme/client-ui/src/pages/TickPricingPage',
      '/repo/packages/client-ui/src/pages/TickPricingPage.tsx',
    );
    page.packageName = '@acme/client-ui';
    page.relativeFilePath = 'src/pages/TickPricingPage.tsx';
    const navbar = makeModuleInfo(
      'mod:@acme/client-ui/src/components/Navbar',
      '/repo/packages/client-ui/src/components/Navbar.tsx',
    );
    navbar.packageName = '@acme/client-ui';
    navbar.relativeFilePath = 'src/components/Navbar.tsx';
    page.semanticHints = {
      routes: [{ path: '/TickPricingPage', component: '(file-route)', source: 'jsx', kind: 'frontend' }],
      hasRoutes: true,
    };
    modulesById.set(page.id, page);
    modulesById.set(navbar.id, navbar);
    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });

    const result = await toolHandlers['search_context'](ctx, {
      query: 'TickPricingPage routing navbar',
      limit: 10,
    });

    expectEnvelope(result);
    expect(result.confidence).toBe('medium');
    expect(result.gaps).toEqual(expect.arrayContaining([
      expect.stringContaining('relaxed to bounded OR'),
    ]));
    const payload = result.result as Record<string, unknown>;
    const matches = payload.matches as Record<string, unknown>;
    expect(matches.strategy).toEqual(expect.objectContaining({ used: 'or', relaxedFrom: 'and' }));
    const topResults = matches.topResults as Array<Record<string, unknown>>;
    expect(topResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'mod:@acme/client-ui/src/pages/TickPricingPage',
        matchedTokens: expect.arrayContaining(['tickpricingpage']),
      }),
      expect.objectContaining({
        id: 'mod:@acme/client-ui/src/components/Navbar',
        matchedTokens: expect.arrayContaining(['navbar']),
      }),
    ]));
    expect(payload.suggestedScopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'mod:@acme/client-ui/src/pages/TickPricingPage' }),
    ]));
    expect(payload.entrypoints).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: '/TickPricingPage',
        moduleId: 'mod:@acme/client-ui/src/pages/TickPricingPage',
      }),
    ]));

    const navigation = result.navigation as unknown as Record<string, Array<Record<string, unknown>>>;
    expect(navigation.deeper[0]).toEqual(expect.objectContaining({
      tool: 'inspect_node',
      args: { nodeId: 'mod:@acme/client-ui/src/pages/TickPricingPage' },
    }));
  });

  it('keeps match:and strict when one existing node matches every token', async () => {
    const { graph, modulesById } = buildSearchModeFixture();
    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });

    const result = await toolHandlers['search_context'](ctx, {
      query: 'order route',
      match: 'and',
      limit: 10,
    });

    expectEnvelope(result);
    expect(result.confidence).toBe('medium');
    expect(result.gaps).toEqual([]);
    const matches = (result.result as Record<string, unknown>).matches as Record<string, unknown>;
    expect(matches.strategy).toEqual(expect.objectContaining({
      requested: 'and',
      used: 'and',
      tokens: expect.arrayContaining(['order', 'route']),
    }));
    expect(matches.totalResults).toBe(1);
    expect(matches.topResults).toEqual([
      expect.objectContaining({
        id: 'mod:app/src/features/order/OrderRoute',
        matchedTokens: expect.arrayContaining(['order', 'route']),
      }),
    ]);
  });

  it('keeps match:and empty for existing tokens that live on different nodes', async () => {
    const { graph, modulesById } = buildSearchModeFixture();
    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });

    const result = await toolHandlers['search_context'](ctx, {
      query: 'order report',
      match: 'and',
      limit: 10,
    });

    expectEnvelope(result);
    expect(result.confidence).toBe('low');
    expect(result.gaps).toEqual([
      expect.stringContaining('No graph node strongly matched'),
    ]);
    const payload = result.result as Record<string, unknown>;
    const matches = payload.matches as Record<string, unknown>;
    expect(matches.strategy).toEqual(expect.objectContaining({ requested: 'and', used: 'and' }));
    expect(matches.strategy).not.toEqual(expect.objectContaining({ relaxedFrom: 'and' }));
    expect(matches.totalResults).toBe(0);
    expect(payload.suggestedScopes).toEqual([]);
  });

  it('honors explicit match:or for existing tokens on different nodes without relaxation metadata', async () => {
    const { graph, modulesById } = buildSearchModeFixture();
    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });

    const result = await toolHandlers['search_context'](ctx, {
      query: 'order report',
      match: 'or',
      limit: 10,
    });

    expectEnvelope(result);
    expect(result.confidence).toBe('medium');
    expect(result.gaps).toEqual([]);
    const matches = (result.result as Record<string, unknown>).matches as Record<string, unknown>;
    expect(matches.strategy).toEqual(expect.objectContaining({ requested: 'or', used: 'or' }));
    expect(matches.strategy).not.toEqual(expect.objectContaining({ relaxedFrom: 'and' }));
    const ids = (matches.topResults as Array<Record<string, unknown>>).map(item => item.id);
    expect(ids).toEqual(expect.arrayContaining([
      'mod:app/src/features/order/OrderRoute',
      'mod:app/src/features/order/OrderService',
      'mod:app/src/features/report/ReportRoute',
    ]));
  });

  it('auto-relaxes existing disjoint tokens from AND to bounded OR', async () => {
    const { graph, modulesById } = buildSearchModeFixture();
    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });

    const result = await toolHandlers['search_context'](ctx, {
      query: 'order report',
      limit: 10,
    });

    expectEnvelope(result);
    expect(result.confidence).toBe('low');
    expect(result.gaps).toEqual([
      expect.stringContaining('relaxed to bounded OR'),
    ]);
    const matches = (result.result as Record<string, unknown>).matches as Record<string, unknown>;
    expect(matches.strategy).toEqual(expect.objectContaining({
      requested: 'auto',
      used: 'or',
      relaxedFrom: 'and',
    }));
    const ids = (matches.topResults as Array<Record<string, unknown>>).map(item => item.id);
    expect(ids).toEqual(expect.arrayContaining([
      'mod:app/src/features/order/OrderRoute',
      'mod:app/src/features/report/ReportRoute',
    ]));
  });

  it('escalates top-1 annotated search hits to inspect_node without inlining annotation fields', async () => {
    const { graph, modulesById } = buildAnnotationEscalationFixture();
    const searchIndex = buildAnnotatedSearchIndex(graph, {
      'mod:app/src/AlphaAnchor': 'anchor extra standing obligation',
    });
    const ctx = makeCtx({ graph, modulesById, searchIndex });

    const result = await toolHandlers['search_context'](ctx, {
      query: 'anchor extra',
      limit: 10,
    });

    expectEnvelope(result);
    expect(result.confidence).toBe('medium');
    expect(result.gaps).toEqual([SEARCH_ANNOTATION_ESCALATION_GAP]);
    const payload = result.result as Record<string, unknown>;
    const matches = payload.matches as Record<string, unknown>;
    const top = (matches.topResults as Array<Record<string, unknown>>)[0];
    expect(top).toEqual(expect.objectContaining({
      id: 'mod:app/src/AlphaAnchor',
      annotationMatched: true,
    }));
    expect(JSON.stringify(payload)).not.toContain('standing obligation');
    const navigation = result.navigation as unknown as Record<string, Array<Record<string, unknown>>>;
    expect(navigation.deeper[0]).toEqual(expect.objectContaining({
      tool: 'inspect_node',
      args: { nodeId: 'mod:app/src/AlphaAnchor' },
      reason: SEARCH_ANNOTATION_ESCALATION_NAV_REASON,
    }));
  });

  it('keeps generic top-1 navigation when only lower-ranked top hits are annotated', async () => {
    const { graph, modulesById } = buildAnnotationEscalationFixture();
    addNode(graph, {
      id: 'mod:app/src/TopNeedle',
      type: 'module',
      label: 'TopNeedle',
      description: '',
      data: { filePath: '/repo/packages/app/src/TopNeedle.ts', relativeFilePath: 'src/TopNeedle.ts' },
    });
    addEdge(graph, 'pkg:app', 'mod:app/src/TopNeedle', 'contains');
    const topNeedle = makeModuleInfo('mod:app/src/TopNeedle', '/repo/packages/app/src/TopNeedle.ts');
    topNeedle.packageName = 'app';
    topNeedle.relativeFilePath = 'src/TopNeedle.ts';
    modulesById.set(topNeedle.id, topNeedle);
    const searchIndex = buildAnnotatedSearchIndex(graph, {
      'mod:app/src/BetaNeedle': 'needle standing obligation',
    });
    const ctx = makeCtx({ graph, modulesById, searchIndex });

    const result = await toolHandlers['search_context'](ctx, {
      query: 'top needle',
      match: 'or',
      limit: 10,
    });

    expectEnvelope(result);
    expect(result.confidence).toBe('medium');
    expect(result.gaps).toEqual([SEARCH_ANNOTATION_ESCALATION_GAP]);
    const matches = ((result.result as Record<string, unknown>).matches as Record<string, unknown>);
    const topResults = matches.topResults as Array<Record<string, unknown>>;
    expect(topResults[0]).toEqual(expect.objectContaining({
      id: 'mod:app/src/TopNeedle',
    }));
    expect(topResults[0].annotationMatched).toBeUndefined();
    expect(topResults[1]).toEqual(expect.objectContaining({
      id: 'mod:app/src/BetaNeedle',
      annotationMatched: true,
    }));
    const navigation = result.navigation as unknown as Record<string, Array<Record<string, unknown>>>;
    expect(navigation.deeper[0]).toEqual(expect.objectContaining({
      reason: 'Inspect the strongest matching node.',
    }));
  });

  it('lowers confidence for weak OR-relaxed top-1 annotated hits', async () => {
    const { graph, modulesById } = buildAnnotationEscalationFixture();
    const searchIndex = buildAnnotatedSearchIndex(graph, {
      'mod:app/src/AlphaAnchor': 'anchor standing obligation',
    });
    const ctx = makeCtx({ graph, modulesById, searchIndex });

    const result = await toolHandlers['search_context'](ctx, {
      query: 'anchor needle',
      limit: 10,
    });

    expectEnvelope(result);
    expect(result.confidence).toBe('low');
    expect(result.gaps).toEqual(expect.arrayContaining([
      expect.stringContaining('relaxed to bounded OR'),
      SEARCH_ANNOTATION_ESCALATION_GAP,
    ]));
    expect((result.gaps as string[]).filter(gap => gap === SEARCH_ANNOTATION_ESCALATION_GAP)).toHaveLength(1);
    const navigation = result.navigation as unknown as Record<string, Array<Record<string, unknown>>>;
    expect(navigation.deeper[0]).toEqual(expect.objectContaining({
      reason: SEARCH_ANNOTATION_ESCALATION_NAV_REASON,
    }));
  });

  it('does not add annotation escalation for unannotated search hits', async () => {
    const { graph, modulesById } = buildAnnotationEscalationFixture();
    const ctx = makeCtx({ graph, modulesById });

    const result = await toolHandlers['search_context'](ctx, {
      query: 'anchor',
      limit: 10,
    });

    expectEnvelope(result);
    expect(result.confidence).toBe('medium');
    expect(result.gaps).toEqual([]);
  });

  it('does not escalate auxiliary-only entrypoint matches', async () => {
    const { graph, modulesById } = buildFixtureGraph();
    const page = makeModuleInfo(
      'mod:test/alpha',
      '/repo/alpha.ts',
    );
    page.semanticHints = {
      routes: [{ path: '/alpha', component: '(file-route)', source: 'jsx', kind: 'frontend' }],
      hasRoutes: true,
    };
    modulesById.set(page.id, page);
    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });

    const result = await toolHandlers['search_context'](ctx, {
      query: 'alpha',
      types: ['entrypoint'],
      limit: 10,
    });

    expectEnvelope(result);
    expect(result.gaps).toEqual([]);
    const payload = result.result as Record<string, unknown>;
    expect(payload.entrypoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/alpha' }),
    ]));
  });

  it('preserves annotation escalation gaps in concise response formatting', async () => {
    const { graph, modulesById } = buildAnnotationEscalationFixture();
    const searchIndex = buildAnnotatedSearchIndex(graph, {
      'mod:app/src/AlphaAnchor': 'anchor standing obligation',
    });
    const ctx = makeCtx({ graph, modulesById, searchIndex });

    const result = await toolHandlers['search_context'](ctx, {
      query: 'anchor',
      limit: 10,
    });
    const out = toCallToolMcpResult(result, { mode: 'concise', pretty: false, maxChars: 50_000 });
    const parsed = JSON.parse(out.content[0].text) as Record<string, unknown>;

    expect(parsed.gaps).toEqual([SEARCH_ANNOTATION_ESCALATION_GAP]);
  });

  it('does not let auto fallback surface only weak common-token results when the anchor is missing', async () => {
    const { graph, modulesById } = buildSearchModeFixture();
    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });

    const result = await toolHandlers['search_context'](ctx, {
      query: 'missinganchor route',
      limit: 10,
    });

    expectEnvelope(result);
    expect(result.confidence).toBe('low');
    expect(result.gaps).toEqual(expect.arrayContaining([
      expect.stringContaining('No graph node strongly matched'),
      expect.stringContaining('relaxed to bounded OR'),
    ]));
    const payload = result.result as Record<string, unknown>;
    const matches = payload.matches as Record<string, unknown>;
    expect(matches.strategy).toEqual(expect.objectContaining({
      used: 'or',
      relaxedFrom: 'and',
      strongTokens: ['missinganchor'],
      weakTokenOnlySuppressed: true,
    }));
    expect(matches.totalResults).toBe(0);
    expect(payload.suggestedScopes).toEqual([]);
    expect(payload.emptyDiagnostic).toEqual(expect.objectContaining({
      reason: 'filtered_out',
      details: expect.objectContaining({
        narrowings: [{ by: 'match', value: 'auto', after: 0, restoreWith: { arg: 'match', value: 'or' } }],
      }),
      nextActions: expect.arrayContaining([
        expect.objectContaining({ tool: 'search_context', args: expect.objectContaining({ match: 'or' }) }),
      ]),
    }));
  });

  it('still lets explicit match:or surface weak common-token results', async () => {
    const { graph, modulesById } = buildSearchModeFixture();
    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });

    const result = await toolHandlers['search_context'](ctx, {
      query: 'missinganchor route',
      match: 'or',
      limit: 10,
    });

    expectEnvelope(result);
    expect(result.confidence).toBe('medium');
    const matches = (result.result as Record<string, unknown>).matches as Record<string, unknown>;
    expect(matches.strategy).toEqual(expect.objectContaining({ requested: 'or', used: 'or' }));
    expect(matches.totalResults).not.toBe(0);
    const ids = (matches.topResults as Array<Record<string, unknown>>).map(item => item.id);
    expect(ids).toEqual(expect.arrayContaining([
      'mod:app/src/features/order/OrderRoute',
      'mod:app/src/features/report/ReportRoute',
    ]));
  });

  it('returns a clean empty result for completely unknown multi-token queries', async () => {
    const { graph, modulesById } = buildSearchModeFixture();
    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });

    const result = await toolHandlers['search_context'](ctx, {
      query: 'missinganchor missingcontext',
      limit: 10,
    });

    expectEnvelope(result);
    expect(result.confidence).toBe('low');
    const payload = result.result as Record<string, unknown>;
    const matches = payload.matches as Record<string, unknown>;
    expect(matches.strategy).toEqual(expect.objectContaining({
      requested: 'auto',
      used: 'or',
      relaxedFrom: 'and',
    }));
    expect(matches.totalResults).toBe(0);
    expect(payload.suggestedScopes).toEqual([]);
    expect(payload.entrypoints).toEqual([]);
    expect(payload.configMatches).toEqual([]);
    expect(payload.emptyDiagnostic).toEqual(expect.objectContaining({
      reason: 'no_token_hits',
      confidence: 'high',
    }));
  });

  it('returns graph_empty emptyDiagnostic for search when the graph has no indexed context', async () => {
    const ctx = makeEmptyCtx();

    const result = await toolHandlers['search_context'](ctx, {
      query: 'anything',
      limit: 10,
    });

    expectEnvelope(result);
    const payload = result.result as Record<string, unknown>;
    expect(payload.emptyDiagnostic).toEqual(expect.objectContaining({
      reason: 'graph_empty',
      confidence: 'high',
      nextActions: expect.arrayContaining([
        expect.objectContaining({ tool: 'refresh_context' }),
      ]),
    }));
  });

  it('paginates inspect_node child/export entries', async () => {
    const { graph, modulesById } = buildFixtureGraph();
    addNode(graph, { id: 'export:test/alpha/Bar', type: 'export-symbol', label: 'Bar', description: '',
      data: { signature: 'function Bar(): void', symbolKind: 'function', lineRange: { start: 6, end: 10 } } });
    addEdge(graph, 'mod:test/alpha', 'export:test/alpha/Bar', 'contains');
    const ctx = makeCtx({
      graph,
      modulesById,
      snapshot: makeSnapshot([...modulesById.values()]),
    });

    const result = await toolHandlers['inspect_node'](ctx, {
      nodeId: 'mod:test/alpha',
      exportLimit: 1,
    });

    expectEnvelope(result);
    const detail = result.result as Record<string, unknown>;
    expect(detail.drillDown).toHaveLength(1);
    expect((detail.truncation as Record<string, unknown>).children).toMatchObject({
      shown: 1,
      total: 2,
      more: { kind: 'page', arg: 'exportOffset', nextOffset: 1, hint: expect.any(String) },
    });
    // affordanceCount reports the node's full member count, not the paginated page size,
    // so "addressed 1 of M" stays honest even when the children are paginated.
    expect(detail.affordanceCount).toBe(2);
  });

  it('surfaces affordanceCount as the full member count on inspect_node', async () => {
    const { graph, modulesById } = buildFixtureGraph();
    const ctx = makeCtx({
      graph,
      modulesById,
      snapshot: makeSnapshot([...modulesById.values()]),
    });

    const result = await toolHandlers['inspect_node'](ctx, { nodeId: 'mod:test/alpha' });

    expectEnvelope(result);
    const detail = result.result as Record<string, unknown>;
    // The fixture module owns two exports; affordanceCount is that count, not the page size — pinned
    // against the graph rather than against the response, so a page-sized value fails.
    const members = [...(ctx.getState().graph.outEdges.get('mod:test/alpha') ?? [])]
      .filter(e => e.kind === 'contains').length;
    expect(detail.affordanceCount).toBe(members);
    expect(detail.truncation).toBeUndefined();
  });

  it('rejects oversized inspect_node bodyLimit before reading source', async () => {
    const ctx = makeCtx();
    const result = await toolHandlers['inspect_node'](ctx, {
      nodeId: 'mod:test/alpha',
      includeBody: true,
      bodyLimit: 50_001,
    });

    expectEnvelope(result);
    expect(result.confidence).toBe('low');
    expect(result.result).toEqual(expect.objectContaining({
      error: expect.stringContaining('bodyLimit must be between 1 and 50000'),
    }));
    expect(fsPromises.readFile).not.toHaveBeenCalled();
  });

  it('keeps semantic coverage compact and pages includeAllDomains output', async () => {
    const ctx = makeCtx({
      annotations: {
        get: () => undefined,
        getAll: () => ({}),
        getStats: () => backlogCoverage({
          modules: kindCoverage({ total: 2, annotated: 2, fresh: 2 }),
          byDomain: {
            alpha: kindCoverage({ total: 1, annotated: 1, fresh: 1 }),
            beta: kindCoverage({ total: 1, annotated: 1, fresh: 1 }),
            gamma: kindCoverage({ total: 1, annotated: 1, fresh: 1 }),
          },
          byTier: {
            business: { domains: ['alpha', 'beta'], totalModules: 2 },
            feature: { domains: ['gamma'], totalModules: 1 },
            layer: { domains: [], totalModules: 0 },
            technical: { domains: [], totalModules: 0 },
          },
          domains: { ...kindCoverage({ total: 3, annotated: 3, fresh: 3 }), list: ['alpha', 'beta', 'gamma'] },
        }),
      } as unknown as RepovineState['annotations'],
    });

    const result = await toolHandlers['get_annotation_status'](ctx, {
      view: 'coverage',
      includeAllDomains: true,
      limit: 2,
      offset: 1,
    });

    expectEnvelope(result);
    const coverage = (result.result as { coverage: Record<string, unknown> }).coverage;
    expect(coverage.domainAnnotations).toEqual({
      totalDomains: 3,
      annotated: 3,
      fresh: 3,
      stale: 0,
      unannotated: 0,
    });
    expect(Object.keys(coverage.byDomain as Record<string, unknown>)).toEqual(['beta', 'gamma']);
    // Two of three domains, requested from offset 1 — the page reaches the end, so no bound.
    expect(coverage.truncation).toBeUndefined();
    expect(coverage.byTier).toEqual(expect.objectContaining({
      business: { domainCount: 2, totalModules: 2 },
    }));
      // Per-type buckets are summed into one allNodeTypes roll-up so the
      // agent does not read them as separate queues.
      expect(coverage.allNodeTypes).toEqual(expect.objectContaining({
        total: 5, // 2 modules + 0 templates + 0 infra + 0 services + 3 domains
        fresh: 5,
      needsWork: 0,
    }));
      expect((coverage.allNodeTypes as { note: string }).note).toMatch(/one annotation backlog, not separate queues/i);
  });

  it('queue view reports a single unified backlog with byType + totalRemaining across node phases', async () => {
    const queueItems: FakeQueueRow[] = [
      { nodeId: 'mod:a', status: 'unannotated', phase: 'module', context: { annotationPhase: 'module' } },
      { nodeId: 'mod:b', status: 'stale', staleKind: 'content', phase: 'module', context: { annotationPhase: 'module', staleKind: 'content' } },
      { nodeId: 'template:t', status: 'unannotated', phase: 'template', context: { annotationPhase: 'template' } },
      { nodeId: 'resource:s', status: 'unannotated', phase: 'runtime-resource', context: { annotationPhase: 'runtime-resource' } },
      { nodeId: 'infra:i', status: 'unannotated', phase: 'infra', context: { annotationPhase: 'infra' } },
      { nodeId: 'domain:d', status: 'stale', staleKind: 'content', phase: 'domain', context: { annotationPhase: 'domain', staleKind: 'content' } },
    ];
    const ctx = makeCtx({
      annotations: {
        get: () => undefined,
        getAll: () => ({}),
        getQueuePage: fakeQueuePage(queueItems),
      } as unknown as RepovineState['annotations'],
    });

    const result = await toolHandlers['get_annotation_status'](ctx, {
      view: 'queue',
      limit: 2,
    });

    expectEnvelope(result);
    const queue = (result.result as { queue: Record<string, unknown> }).queue;
      expect(queue.totalRemaining).toBe(6);
      expect(queue.needsWork).toBe(6);
    expect(queue.returned).toBe(2);
    expect((queue.items as unknown[]).length).toBe(2);
      expect(queue.byType).toEqual({ module: 2, template: 1, 'runtime-resource': 1, infra: 1, domain: 1 });
    expect(queue.counts).toEqual({
      stale: 2,
      staleContent: 2,
      stalePropagation: 0,
      unannotated: 4,
    });
    expect(queue.mode).toBe('queue');
    expect(queue.hint).toMatch(/ONE unified annotation queue, not separate queues/i);
    expect(queue.queueLength).toBeUndefined();
    expect(queue.offset).toBe(0);
    expect(queue.truncation).toEqual({
      items: {
        shown: 2,
        total: 6,
        unit: 'item',
        more: { kind: 'page', arg: 'offset', nextOffset: 2, hint: expect.any(String) },
      },
    });
  });

  it('includes propagation-stale in needsWork', async () => {
    const queueItems: FakeQueueRow[] = [
      { nodeId: 'mod:a', status: 'stale', staleKind: 'content', phase: 'module', context: { annotationPhase: 'module', staleKind: 'content' } },
      { nodeId: 'mod:b', status: 'stale', staleKind: 'propagation', phase: 'module', context: { annotationPhase: 'module', staleKind: 'propagation' } },
      { nodeId: 'resource:s', status: 'unannotated', phase: 'runtime-resource', context: { annotationPhase: 'runtime-resource' } },
    ];
    const baseCtx = makeCtx({
      annotations: {
        get: () => undefined,
        getAll: () => ({}),
        getQueuePage: fakeQueuePage(queueItems),
      } as unknown as RepovineState['annotations'],
    });
    const ctx: McpToolRuntime = baseCtx;

    const result = await toolHandlers['get_annotation_status'](ctx, {
      view: 'queue',
      limit: 10,
    });
    const queue = (result.result as { queue: Record<string, unknown> }).queue;

    expect(queue.mode).toBe('queue');
    expect(queue.totalRemaining).toBe(3);
    expect(queue.needsWork).toBe(3);
    expect(queue.counts).toEqual({
      stale: 2,
      staleContent: 1,
      stalePropagation: 1,
      unannotated: 1,
    });
    expect((queue.items as Array<{ nodeId: string }>).map(i => i.nodeId)).toEqual(['mod:a', 'mod:b', 'resource:s']);
    expect(queue.hint).toMatch(/content-stale before propagation-stale/i);
    expect(queue.hint).toMatch(/staleKind:"propagation"/i);
  });

  it('derived-review filters propagation-stale queue items', async () => {
    const queueItems: FakeQueueRow[] = [
      { nodeId: 'mod:a', status: 'stale', staleKind: 'content', phase: 'module', context: { annotationPhase: 'module' } },
      { nodeId: 'mod:b', status: 'stale', staleKind: 'propagation', phase: 'module', context: { annotationPhase: 'module', staleKind: 'propagation' } },
    ];
    const baseCtx = makeCtx({
      annotations: {
        get: () => undefined,
        getAll: () => ({}),
        getQueuePage: fakeQueuePage(queueItems),
      } as unknown as RepovineState['annotations'],
    });
    const ctx: McpToolRuntime = baseCtx;

    const result = await toolHandlers['get_annotation_status'](ctx, {
      view: 'derived-review',
      limit: 10,
    });
    const reviewQueue = (result.result as { derivedReview: Record<string, unknown> }).derivedReview;

    expect(reviewQueue.mode).toBe('derived-review');
    expect(reviewQueue.totalRemaining).toBe(1);
    expect((reviewQueue.items as Array<{ nodeId: string; staleKind?: string }>)[0]).toMatchObject({
      nodeId: 'mod:b',
      staleKind: 'propagation',
    });
  });

  it('propagation-preview view returns blast preview payload', async () => {
    const ctx = makeCtx();
    const result = await toolHandlers['get_annotation_status'](ctx, {
      view: 'propagation-preview',
      from: 'mod:test/alpha',
      includeDomains: true,
    });

    expectEnvelope(result);
    const preview = (result.result as { propagationPreview: Record<string, unknown> }).propagationPreview;
    expect(preview.from).toBe('mod:test/alpha');
    expect(preview).toEqual(expect.objectContaining({
      hard: expect.any(Array),
      derived: expect.any(Array),
    }));
  });

  it('propagation-preview view requires from', async () => {
    const ctx = makeCtx();
    const response = await toolHandlers['get_annotation_status'](ctx, {
      view: 'propagation-preview',
    });
    expect((response.result as Record<string, unknown>).error).toMatch(/requires from/i);
    expect(response.confidence).toBe('low');
  });

  it('queue view pages via offset', async () => {
    const queueItems: FakeQueueRow[] = [
      { nodeId: 'mod:a', status: 'unannotated', phase: 'module', context: { annotationPhase: 'module' } },
      { nodeId: 'mod:b', status: 'unannotated', phase: 'module', context: { annotationPhase: 'module' } },
      { nodeId: 'resource:s', status: 'unannotated', phase: 'runtime-resource', context: { annotationPhase: 'runtime-resource' } },
    ];
    const ctx = makeCtx({
      annotations: {
        get: () => undefined,
        getAll: () => ({}),
        getQueuePage: fakeQueuePage(queueItems),
      } as unknown as RepovineState['annotations'],
    });

    const result = await toolHandlers['get_annotation_status'](ctx, {
      view: 'queue',
      limit: 2,
      offset: 2,
    });

    const queue = (result.result as { queue: Record<string, unknown> }).queue;
    expect(queue.offset).toBe(2);
    expect(queue.returned).toBe(1); // only the 3rd item remains
    expect((queue.items as Array<{ nodeId: string }>)[0].nodeId).toBe('resource:s');
    expect(queue.totalRemaining).toBe(3);
    expect(queue.needsWork).toBe(3);
    expect(queue.nextOffset).toBeUndefined(); // last page
  });

  it('risk-scope-candidates view returns paged advisory detail', async () => {
    const ann = (nodeId: string, risks: StoredAnnotation['annotation']['risks']): StoredAnnotation => ({
      nodeId,
      nodeType: 'module',
      contentHash: 'abc123',
      pass: 1,
      updatedAt: '2024-01-01',
      annotation: { summary: 'Annotation summary for risk-scope candidates.', risks },
      schemaVersion: 1,
    });
    const ctx = makeCtx({
      annotations: {
        getAll: () => ({
          'mod:test/alpha': ann('mod:test/alpha', [
            'Published contract for external clients is frozen.',
          ]),
          'mod:test/beta': ann('mod:test/beta', [
            'Importers must verify this gate locally before changing behavior.',
          ]),
        }),
      } as unknown as RepovineState['annotations'],
    });

    const result = await toolHandlers['get_annotation_status'](ctx, {
      view: 'risk-scope-candidates',
      limit: 1,
      offset: 0,
    });

    expectEnvelope(result);
    const candidates = (result.result as { riskScopeCandidates: Record<string, unknown> }).riskScopeCandidates;
    expect(candidates).toEqual(expect.objectContaining({
      total: 2,
      consumer: 1,
      boundary: 1,
    }));
    expect(candidates.truncation).toEqual({
      items: {
        shown: 1,
        total: 2,
        unit: 'item',
        more: { kind: 'page', arg: 'offset', nextOffset: 1, hint: expect.any(String) },
      },
    });
    expect(candidates.items).toEqual([
      expect.objectContaining({
        nodeId: 'mod:test/alpha',
        suggestedScope: 'boundary',
        nodeType: 'module',
      }),
    ]);
    expect(candidates.note).toMatch(/Advisory only/i);
  });

  it('risk-scope-candidates view supports offset and empty results', async () => {
    const ann = (nodeId: string): StoredAnnotation => ({
      nodeId,
      nodeType: 'module',
      contentHash: 'abc123',
      pass: 1,
      updatedAt: '2024-01-01',
      annotation: {
        summary: 'Annotation summary for risk-scope candidates.',
        risks: ['Importers must verify this gate locally before changing behavior.'],
      },
      schemaVersion: 1,
    });
    const ctx = makeCtx({
      annotations: {
        getAll: () => ({ 'mod:test/alpha': ann('mod:test/alpha') }),
      } as unknown as RepovineState['annotations'],
    });

    const page = await toolHandlers['get_annotation_status'](ctx, {
      view: 'risk-scope-candidates',
      limit: 1,
      offset: 1,
    });
    const pageCandidates = (page.result as { riskScopeCandidates: Record<string, unknown> }).riskScopeCandidates;
    expect(pageCandidates.items).toEqual([]);
    // Offset 1 of a one-item list starts past the end, so the answer is to restart.
    expect(pageCandidates.truncation).toEqual({
      items: {
        shown: 0,
        total: 1,
        unit: 'item',
        more: { kind: 'arg', arg: 'offset', value: 0, hint: expect.any(String) },
      },
    });

    const empty = await toolHandlers['get_annotation_status'](makeCtx(), {
      view: 'risk-scope-candidates',
    });
    const emptyCandidates = (empty.result as { riskScopeCandidates: Record<string, unknown> }).riskScopeCandidates;
    expect(emptyCandidates).toEqual(expect.objectContaining({
      total: 0,
      consumer: 0,
      boundary: 0,
      items: [],
    }));
  });

  it('routes impact analysis through analyze_dependencies', async () => {
    const ctx = makeCtx();
    const result = await toolHandlers['analyze_dependencies'](ctx, {
      scope: 'mod:test/alpha',
      mode: 'impact',
      depth: 2,
    });

    expectEnvelope(result);
    expect(result.resolvedScope).toMatchObject({ kind: 'module', id: 'mod:test/alpha' });
    expect(result.result).toEqual(expect.objectContaining({
      mode: 'impact',
      analysis: expect.objectContaining({ nodeId: 'mod:test/alpha' }),
    }));
  });

  it('explains empty import-map results as no cross-package edges', async () => {
    const ctx = makeCtx();
    const result = await toolHandlers['analyze_dependencies'](ctx, {
      scope: 'pkg:test',
      mode: 'import-map',
    });

    expectEnvelope(result);
    expect(result.result).toEqual(expect.objectContaining({
      mode: 'import-map',
      analysis: expect.objectContaining({ edges: [] }),
    }));
    expect(result.gaps).toEqual(expect.arrayContaining([
      expect.stringContaining('No cross-package import edges matched'),
    ]));
    expect(result.result).toEqual(expect.objectContaining({
      emptyDiagnostic: expect.objectContaining({
        reason: 'no_cross_package_edges',
        nextActions: expect.arrayContaining([
          expect.objectContaining({ tool: 'analyze_dependencies', args: expect.objectContaining({ scope: 'all' }) }),
          expect.objectContaining({ tool: 'map_context' }),
        ]),
      }),
    }));
  });

  it('explains empty dependency modes without pushing unrelated runtime scopes', async () => {
    const { graph, modulesById } = buildFixtureGraph();
    addNode(graph, { id: 'mod:test/gamma', type: 'module', label: 'gamma', description: '',
      data: { filePath: '/repo/gamma.ts', relativeFilePath: 'gamma.ts' } });
    addEdge(graph, 'pkg:test', 'mod:test/gamma', 'contains');
    modulesById.set('mod:test/gamma', makeModuleInfo('mod:test/gamma', '/repo/gamma.ts'));
    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });

    const impact = await toolHandlers['analyze_dependencies'](ctx, {
      scope: 'mod:test/gamma',
      mode: 'impact',
    });
    expectEnvelope(impact);
    expect(impact.result).toEqual(expect.objectContaining({
      emptyDiagnostic: expect.objectContaining({
        reason: 'no_dependency_edges',
        nextActions: expect.arrayContaining([
          expect.objectContaining({ tool: 'inspect_node' }),
          expect.objectContaining({ tool: 'analyze_dependencies' }),
        ]),
      }),
    }));

    const implementations = await toolHandlers['analyze_dependencies'](ctx, {
      mode: 'interface-implementations',
      interfaceName: 'MissingInterface',
    });
    expectEnvelope(implementations);
    expect(implementations.result).toEqual(expect.objectContaining({
      emptyDiagnostic: expect.objectContaining({
        reason: 'no_interface_implementations',
      }),
    }));

    const callgraph = await toolHandlers['analyze_dependencies'](ctx, {
      scope: 'export:test/alpha/Foo',
      mode: 'callgraph',
    });
    expectEnvelope(callgraph);
    expect(callgraph.result).toEqual(expect.objectContaining({
      emptyDiagnostic: expect.objectContaining({
        reason: 'no_callgraph_edges',
      }),
    }));
  });

  it('returns graph_empty emptyDiagnostic for dependency and architecture analysis with no graph context', async () => {
    const ctx = makeEmptyCtx();

    const dependencies = await toolHandlers['analyze_dependencies'](ctx, {
      scope: 'all',
      mode: 'package-boundaries',
    });
    expectEnvelope(dependencies);
    expect(dependencies.result).toEqual(expect.objectContaining({
      emptyDiagnostic: expect.objectContaining({ reason: 'graph_empty' }),
    }));

    const architecture = await toolHandlers['analyze_architecture'](ctx, { scope: 'all' });
    expectEnvelope(architecture);
    expect(architecture.result).toEqual(expect.objectContaining({
      emptyDiagnostic: expect.objectContaining({ reason: 'graph_empty' }),
    }));
  });

  it('returns entrypoints in the shared envelope even when none are present', async () => {
    const ctx = makeCtx();
    const result = await toolHandlers['get_entrypoints'](ctx, { scope: 'all' });

    expectEnvelope(result);
    expect(result.result).toEqual(expect.objectContaining({
      items: [],
      emptyDiagnostic: expect.objectContaining({
        reason: 'no_entrypoints_indexed',
      }),
    }));
  });

  it('returns filtered_out emptyDiagnostic when entrypoint filters remove existing entries', async () => {
    const { graph, modulesById } = buildFixtureGraph();
    const alpha = modulesById.get('mod:test/alpha')!;
    alpha.semanticHints = {
      routes: [{ path: '/alpha', component: 'AlphaPage', source: 'jsx', kind: 'frontend' }],
      hasRoutes: true,
    };
    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });

    const result = await toolHandlers['get_entrypoints'](ctx, {
      scope: 'pkg:test',
      kind: 'api',
    });

    expectEnvelope(result);
    expect(result.result).toEqual(expect.objectContaining({
      total: 0,
      emptyDiagnostic: expect.objectContaining({
        reason: 'filtered_out',
        confidence: 'high',
        nextActions: expect.arrayContaining([
          expect.objectContaining({ tool: 'get_entrypoints', args: { scope: 'pkg:test' } }),
        ]),
      }),
    }));
  });

  it('returns graph_empty emptyDiagnostic for entrypoints when no graph context exists', async () => {
    const result = await toolHandlers['get_entrypoints'](makeEmptyCtx(), { scope: 'all' });

    expectEnvelope(result);
    expect(result.result).toEqual(expect.objectContaining({
      emptyDiagnostic: expect.objectContaining({ reason: 'graph_empty' }),
    }));
  });

  it('explains empty runtime results for domain scopes', async () => {
    const { graph, modulesById } = buildFixtureGraph();
    addNode(graph, { id: 'domain:auth', type: 'domain', label: 'auth', description: '' });
    const ctx = makeCtx({
      graph,
      modulesById,
      snapshot: makeSnapshot([...modulesById.values()]),
    });

    const entrypoints = await toolHandlers['get_entrypoints'](ctx, { scope: 'domain:auth' });
    // The gap is the diagnostic's own sentence now; the same fact used to be worded twice per response.
    expect(entrypoints.gaps).toEqual(expect.arrayContaining([
      expect.stringContaining('semantic/path tag'),
    ]));
    expect(entrypoints.result).toEqual(expect.objectContaining({
      emptyDiagnostic: expect.objectContaining({
        reason: 'semantic_domain_not_runtime_boundary',
        nextActions: expect.arrayContaining([
          expect.objectContaining({ reason: expect.stringContaining('runtime') }),
          expect.objectContaining({ reason: expect.stringContaining('code structure') }),
        ]),
      }),
    }));
    expect((entrypoints.navigation as unknown as Record<string, Array<Record<string, unknown>>>).sideways).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'get_entrypoints', args: expect.objectContaining({ scope: 'domain:auth' }) }),
    ]));

    const flow = await toolHandlers['trace_flow'](ctx, { scope: 'domain:auth' });
    expect(flow.gaps).toEqual(expect.arrayContaining([
      expect.stringContaining('semantic/path tag'),
    ]));
    expect(flow.result).toEqual(expect.objectContaining({
      emptyDiagnostic: expect.objectContaining({
        reason: 'semantic_domain_not_runtime_boundary',
      }),
    }));
    expect((flow.navigation as unknown as Record<string, Array<Record<string, unknown>>>).crossLayer).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'trace_flow', args: expect.objectContaining({ scope: 'domain:auth' }) }),
    ]));
  });

  it('returns graph_empty emptyDiagnostic for trace_flow when no graph context exists', async () => {
    const result = await toolHandlers['trace_flow'](makeEmptyCtx(), { scope: 'all' });

    expectEnvelope(result);
    expect(result.result).toEqual(expect.objectContaining({
      emptyDiagnostic: expect.objectContaining({ reason: 'graph_empty' }),
    }));
  });

  it('derives trace_flow service totals and truncation from the filtered scope', async () => {
    const { graph, modulesById } = buildFixtureGraph();
    for (const [id, label] of [
      ['resource:generic:needle-service', 'needle-service'],
      ['resource:generic:other-a', 'other-a'],
      ['resource:generic:other-b', 'other-b'],
    ]) {
      addNode(graph, { id, type: 'runtime-resource', label, description: 'Service' });
    }
    const ctx = makeCtx({ graph, modulesById });

    const result = await toolHandlers['trace_flow'](ctx, {
      scope: 'needle',
      include: ['services'],
      limit: 1,
      offset: 1,
    });

    expectEnvelope(result);
    expect(result.result).toEqual(expect.objectContaining({
      services: [],
      // One service in scope, requested from offset 1: the page starts past the end.
      truncation: expect.objectContaining({
        services: {
          shown: 0,
          total: 1,
          unit: 'item',
          more: { kind: 'arg', arg: 'offset', value: 0, hint: expect.any(String) },
        },
      }),
    }));
    // A page past the end is not an empty scope. Deciding emptiness off the paged slice reported
    // "no runtime topology matched" for a scope whose own truncation block says it holds one
    // service, and graded `confidence` off the unpaged list in the same response.
    expect(result.result).not.toHaveProperty('emptyDiagnostic');
    expect(result.confidence).not.toBe('low');
  });

  it('returns runtimeHandoff and prioritizes handler module navigation for runtime resources', async () => {
    const { graph, modulesById } = buildFixtureGraph();
    addNode(graph, {
      id: 'resource:aws-lambda:OrdersFunction',
      type: 'runtime-resource',
      label: 'OrdersFunction',
      description: 'Lambda',
      data: { kind: 'lambda' },
    });
    addNode(graph, {
      id: 'mod:test/orders-handler',
      type: 'module',
      label: 'orders-handler',
      description: '',
      data: { filePath: '/repo/orders-handler.ts', relativeFilePath: 'orders-handler.ts' },
    });
    addEdge(graph, 'resource:aws-lambda:OrdersFunction', 'mod:test/orders-handler', 'infra');
    modulesById.set('mod:test/orders-handler', makeModuleInfo('mod:test/orders-handler', '/repo/orders-handler.ts'));

    const handlerAnnotation: StoredAnnotation = {
      nodeId: 'mod:test/orders-handler',
      nodeType: 'module',
      contentHash: 'handler-hash',
      pass: 1,
      updatedAt: '2026-07-01T00:00:00.000Z',
      annotation: {
        summary: 'Orders handler.',
        risks: [{ text: 'Importers must verify authorization locally.', scope: 'consumer' }],
      },
    };
    const annotations = {
      get: (nodeId: string) => nodeId === handlerAnnotation.nodeId ? handlerAnnotation : undefined,
      set: jest.fn(),
      isFresh: () => true,
      getQueue: () => [],
      getStats: () => backlogCoverage(),
      getAll: () => ({ [handlerAnnotation.nodeId]: handlerAnnotation }),
    } as unknown as RepovineState['annotations'];
    const ctx = makeCtx({
      graph,
      modulesById,
      snapshot: makeSnapshot([...modulesById.values()]),
      annotations,
    });

    const result = await toolHandlers['trace_flow'](ctx, {
      scope: 'resource:aws-lambda:OrdersFunction',
    });

    expectEnvelope(result);
    expect(result.result).toEqual(expect.objectContaining({
      runtimeHandoff: {
        items: [
          expect.objectContaining({
            resourceId: 'resource:aws-lambda:OrdersFunction',
            handlerModuleId: 'mod:test/orders-handler',
            trigger: 'annotation',
          }),
        ],
      },
    }));
    const deeper = (result.navigation as unknown as Record<string, Array<Record<string, unknown>>>).deeper;
    expect(deeper[0]).toEqual(expect.objectContaining({
      tool: 'inspect_node',
      args: { nodeId: 'mod:test/orders-handler' },
      reason: expect.stringContaining('Runtime handoff'),
    }));
    expect(deeper).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'inspect_node',
        args: { nodeId: 'resource:aws-lambda:OrdersFunction' },
      }),
    ]));
  });

  it('returns runtimeHandoff when inspecting a runtime resource directly', async () => {
    const { graph, modulesById } = buildFixtureGraph();
    addNode(graph, {
      id: 'resource:aws-lambda:JobsFunction',
      type: 'runtime-resource',
      label: 'JobsFunction',
      description: 'Lambda',
      data: { kind: 'lambda' },
    });
    addNode(graph, {
      id: 'mod:test/jobs-handler',
      type: 'module',
      label: 'jobs-handler',
      description: '',
      data: { filePath: '/repo/jobs-handler.ts', relativeFilePath: 'jobs-handler.ts' },
    });
    addEdge(graph, 'resource:aws-lambda:JobsFunction', 'mod:test/jobs-handler', 'infra');
    modulesById.set('mod:test/jobs-handler', makeModuleInfo('mod:test/jobs-handler', '/repo/jobs-handler.ts'));
    const ctx = makeCtx({
      graph,
      modulesById,
      snapshot: makeSnapshot([...modulesById.values()]),
    });

    const result = await toolHandlers['inspect_node'](ctx, {
      nodeId: 'resource:aws-lambda:JobsFunction',
    });

    expectEnvelope(result);
    expect(result.result).toEqual(expect.objectContaining({
      runtimeHandoff: {
        items: [
          expect.objectContaining({
            resourceId: 'resource:aws-lambda:JobsFunction',
            handlerModuleId: 'mod:test/jobs-handler',
            trigger: 'scoped-resource',
          }),
        ],
      },
    }));
    const deeper = (result.navigation as unknown as Record<string, Array<Record<string, unknown>>>).deeper;
    expect(deeper[0]).toEqual(expect.objectContaining({
      tool: 'inspect_node',
      args: { nodeId: 'mod:test/jobs-handler' },
      reason: expect.stringContaining('Runtime handoff'),
    }));
  });

  it('returns scope_has_no_config_surface emptyDiagnostic for config surface misses', async () => {
    const ctx = makeCtx();
    const result = await toolHandlers['get_config_surface'](ctx, { scope: 'pkg:test' });

    expectEnvelope(result);
    expect(result.result).toEqual(expect.objectContaining({
      total: 0,
      emptyDiagnostic: expect.objectContaining({
        reason: 'scope_has_no_config_surface',
        nextActions: expect.arrayContaining([
          expect.objectContaining({ tool: 'map_context' }),
          expect.objectContaining({ tool: 'trace_flow' }),
        ]),
      }),
    }));
  });

  it('reports the namePattern narrowing, with the count it removed, when config filters empty a non-empty scope', async () => {
    const { graph, modulesById } = buildFixtureGraph();
    modulesById.get('mod:test/alpha')!.semanticHints = { envVars: ['API_TOKEN'] };
    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });

    const result = await toolHandlers['get_config_surface'](ctx, {
      scope: 'pkg:test',
      namePattern: 'DOES_NOT_MATCH',
    });

    expectEnvelope(result);
    expect(result.result).toEqual(expect.objectContaining({
      total: 0,
      emptyDiagnostic: expect.objectContaining({
        reason: 'filtered_out',
        confidence: 'high',
        details: expect.objectContaining({
          narrowings: [expect.objectContaining({ by: 'namePattern', value: 'DOES_NOT_MATCH', before: expect.any(Number), after: 0 })],
        }),
      }),
    }));
  });

  it('returns an error instead of the unfiltered config surface for an invalid namePattern', async () => {
    const { graph, modulesById } = buildFixtureGraph();
    modulesById.get('mod:test/alpha')!.semanticHints = { envVars: ['API_TOKEN'] };
    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });

    const result = await toolHandlers['get_config_surface'](ctx, {
      scope: 'pkg:test',
      namePattern: '[unterminated',
    });

    expectEnvelope(result);
    expect(result.result).toEqual(expect.objectContaining({
      error: expect.stringContaining('Invalid namePattern'),
      namePattern: '[unterminated',
    }));
    expect(result.result).not.toEqual(expect.objectContaining({
      items: expect.any(Array),
    }));
  });

  it('returns graph_empty emptyDiagnostic for config surface when no graph context exists', async () => {
    const result = await toolHandlers['get_config_surface'](makeEmptyCtx(), { scope: 'all' });

    expectEnvelope(result);
    expect(result.result).toEqual(expect.objectContaining({
      emptyDiagnostic: expect.objectContaining({ reason: 'graph_empty' }),
    }));
  });

  it('returns Vercel cron resources as schedule entrypoints', async () => {
    const { graph, modulesById } = buildFixtureGraph();
    addNode(graph, {
      id: 'resource:vercel:cron:/api/users',
      type: 'runtime-resource',
      label: 'cron:/api/users',
      description: 'Vercel cron',
      data: {
        kind: 'vercel-cron',
        provider: 'vercel',
        triggers: [{ name: 'cron:/api/users', type: 'schedule', path: '/api/users', schedule: '0 5 * * *' }],
      },
    });
    const ctx = makeCtx({
      graph,
      modulesById,
      snapshot: makeSnapshot([...modulesById.values()]),
    });

    const result = await toolHandlers['get_entrypoints'](ctx, { scope: 'all', kind: 'schedule' });

    expectEnvelope(result);
    const items = (result.result as { items: Array<Record<string, unknown>> }).items;
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'schedule',
        layer: 'backend',
        serviceId: 'resource:vercel:cron:/api/users',
        provider: 'vercel',
        runtimeKind: 'vercel-cron',
        path: '/api/users',
      }),
    ]);
  });

  it('keeps read-only validation errors inside the shared envelope', async () => {
    const ctx = makeCtx();
    const result = await toolHandlers['analyze_dependencies'](ctx, {
      scope: 'pkg:test',
      mode: 'impact',
    });

    expectEnvelope(result);
    expect(result.confidence).toBe('low');
    expect(result.result).toEqual(expect.objectContaining({
      error: 'mode impact requires a module or export-symbol scope',
      emptyDiagnostic: expect.objectContaining({
        reason: 'dependency_mode_scope_mismatch',
        nextActions: expect.arrayContaining([
          expect.objectContaining({ tool: 'analyze_dependencies', args: expect.objectContaining({ mode: 'import-map' }) }),
          expect.objectContaining({ tool: 'map_context' }),
        ]),
      }),
    }));
  });

  it('explains empty architecture reports and missing finding detail', async () => {
    const ctx = makeCtx();
    const report = await toolHandlers['analyze_architecture'](ctx, {
      scope: 'pkg:test',
      categories: ['god-domain'],
      minConfidence: 0.99,
    });

    expectEnvelope(report);
    expect(report.result).toEqual(expect.objectContaining({
      totalFindings: 0,
      emptyDiagnostic: expect.objectContaining({
        reason: 'no_architecture_findings',
        nextActions: expect.arrayContaining([
          expect.objectContaining({ tool: 'map_context' }),
          expect.objectContaining({ tool: 'analyze_architecture' }),
          expect.objectContaining({ tool: 'analyze_dependencies' }),
        ]),
      }),
    }));

    const detail = await toolHandlers['analyze_architecture'](ctx, {
      scope: 'pkg:test',
      detailFindingId: 'god-module:missing',
    });

    expectEnvelope(detail);
    expect(detail.result).toEqual(expect.objectContaining({
      error: expect.stringContaining('Refactoring finding not found'),
      emptyDiagnostic: expect.objectContaining({
        reason: 'finding_not_found',
        nextActions: expect.arrayContaining([
          expect.objectContaining({ tool: 'analyze_architecture' }),
        ]),
      }),
    }));
  });

  it('deduplicates navigation items with identical (tool, args)', async () => {
    const ctx = makeCtx();
    const result = await toolHandlers['inspect_node'](ctx, { nodeId: 'mod:test/alpha' });

    const navigation = result.navigation as Record<string, Array<{ tool: string; args: Record<string, unknown> }>>;
    for (const section of ['deeper', 'sideways', 'up', 'crossLayer', 'validate'] as const) {
      const keys = navigation[section].map(item => `${item.tool}|${JSON.stringify(item.args)}`);
      expect(new Set(keys).size).toBe(keys.length);
    }

    const sidewaysTools = navigation.sideways.map(item => item.tool);
    expect(sidewaysTools.filter(t => t === 'analyze_dependencies')).toHaveLength(1);
    expect(sidewaysTools.filter(t => t === 'get_config_surface')).toHaveLength(1);
  });
});

// ── get_refactoring_report ──

describe('get_refactoring_report', () => {
  function buildRefactoringFixture(): { graph: RepositoryGraph; modulesById: Map<string, ModuleInfo> } {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'pkg:app', type: 'package', label: 'app', description: '' });
    addNode(g, { id: 'pkg:shared', type: 'package', label: 'shared', description: '' });
    addNode(g, { id: 'mod:app/src/page', type: 'module', label: 'src/page', description: '', data: { relativeFilePath: 'src/page.tsx' } });
    addNode(g, { id: 'mod:shared/src/index', type: 'module', label: 'src/index', description: '', data: { relativeFilePath: 'src/index.ts' } });
    addNode(g, { id: 'mod:shared/src/internal/rules', type: 'module', label: 'src/internal/rules', description: '', data: { relativeFilePath: 'src/internal/rules.ts' } });
    addNode(g, { id: 'resource:producer', type: 'runtime-resource', label: 'ProducerFn', description: 'lambda', data: { kind: 'lambda' } });
    addNode(g, { id: 'resource:consumer', type: 'runtime-resource', label: 'ConsumerFn', description: 'lambda', data: { kind: 'lambda' } });
    addNode(g, { id: 'resource:queue:jobs', type: 'runtime-resource', label: 'JobsQueue', description: 'queue', data: { kind: 'queue' } });
    addEdge(g, 'root', 'pkg:app', 'contains');
    addEdge(g, 'root', 'pkg:shared', 'contains');
    addEdge(g, 'pkg:app', 'mod:app/src/page', 'contains');
    addEdge(g, 'pkg:shared', 'mod:shared/src/index', 'contains');
    addEdge(g, 'pkg:shared', 'mod:shared/src/internal/rules', 'contains');
    addEdge(g, 'mod:app/src/page', 'mod:shared/src/internal/rules', 'imports');
    addEdge(g, 'resource:producer', 'resource:queue:jobs', 'publishes');
    addEdge(g, 'resource:queue:jobs', 'resource:consumer', 'consumes');

    const page = makeModuleInfo('mod:app/src/page', '/repo/packages/app/src/page.tsx');
    page.packageName = 'app';
    page.relativeFilePath = 'src/page.tsx';
    page.imports = [{
      moduleSpecifier: 'shared/src/internal/rules',
      resolvedModuleId: 'mod:shared/src/internal/rules',
      importedNames: ['applyRules'],
      isTypeOnly: false,
      isExternal: false,
    }];
    const index = makeModuleInfo('mod:shared/src/index', '/repo/packages/shared/src/index.ts');
    index.packageName = 'shared';
    index.relativeFilePath = 'src/index.ts';
    const rules = makeModuleInfo('mod:shared/src/internal/rules', '/repo/packages/shared/src/internal/rules.ts');
    rules.packageName = 'shared';
    rules.relativeFilePath = 'src/internal/rules.ts';
    rules.exports = Array.from({ length: 12 }, (_, i) => ({
      name: `rule${i}`,
      kind: 'function' as const,
      lineRange: { start: i * 5 + 1, end: i * 5 + 4 },
      isDefault: false,
    }));

    return {
      graph: g,
      modulesById: new Map([
        [page.id, page],
        [index.id, index],
        [rules.id, rules],
      ]),
    };
  }

  it('reports boundary and broad-module findings from graph facts', async () => {
    const { graph, modulesById } = buildRefactoringFixture();
    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });

    const result = await architectureResult(ctx, { categories: ['boundary', 'god-module'] }) as Record<string, unknown>;
    const findings = result.findings as Array<Record<string, unknown>>;

    const boundary = expectFinding(findings, 'boundary:mod:shared/src/internal/rules');
    expect(boundary).toMatchObject({
      category: 'boundary',
      nodes: ['mod:shared/src/internal/rules', 'mod:app/src/page'],
    });
    expect(boundary).not.toHaveProperty('confidence');
    expect(boundary.evidence).toEqual(expect.arrayContaining([
      expect.stringContaining('1 importer(s) reach src/internal/rules directly'),
      expect.stringContaining('Imported symbols: applyRules'),
    ]));

    const godModule = expectFinding(findings, 'god-module:mod:shared/src/internal/rules');
    expect(godModule).toMatchObject({
      category: 'god-module',
      nodes: ['mod:shared/src/internal/rules'],
    });
    expect(godModule.evidence).toEqual(expect.arrayContaining([
      expect.stringContaining('12 export(s)'),
    ]));
    expect(godModule).not.toHaveProperty('confidence');
  });

  it('reports event-driven boundary candidates', async () => {
    const { graph, modulesById } = buildRefactoringFixture();
    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });

    const result = await architectureResult(ctx, { categories: ['event-driven-boundary'] }) as Record<string, unknown>;
    const findings = result.findings as Array<Record<string, unknown>>;

    expect(findings).toHaveLength(1);
    expect(expectFinding(findings, 'event-driven-boundary:resource:queue:jobs')).toMatchObject({
      category: 'event-driven-boundary',
      nodes: expect.arrayContaining(['resource:queue:jobs', 'resource:producer', 'resource:consumer']),
    });
  });

  it('reports frontend AI-code smell categories from normalized frontend hints', async () => {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'pkg:app', type: 'package', label: 'app', description: '' });
    addEdge(g, 'root', 'pkg:app', 'contains');

    const modulesById = new Map<string, ModuleInfo>();
    const addMod = (id: string, rel: string, exports: ModuleInfo['exports'] = []): ModuleInfo => {
      addNode(g, { id, type: 'module', label: rel, description: '', data: { relativeFilePath: rel } });
      addEdge(g, 'pkg:app', id, 'contains');
      const mod = makeModuleInfo(id, `/repo/packages/app/${rel}`);
      mod.packageName = 'app';
      mod.relativeFilePath = rel;
      mod.exports = exports;
      modulesById.set(id, mod);
      return mod;
    };
    const componentExport = (name: string): ModuleInfo['exports'][number] => ({
      name,
      kind: 'component',
      lineRange: { start: 1, end: 20 },
      isDefault: false,
    });
    const functionExport = (name: string): ModuleInfo['exports'][number] => ({
      name,
      kind: 'function',
      lineRange: { start: 1, end: 10 },
      isDefault: false,
    });
    const typeExport = (name: string): ModuleInfo['exports'][number] => ({
      name,
      kind: 'type',
      lineRange: { start: 1, end: 1 },
      isDefault: false,
    });

    const page = addMod('mod:app/src/features/orders/OrdersPage', 'src/features/orders/OrdersPage.tsx', [componentExport('OrdersPage')]);
    page.semanticHints = {
      ui: {
        framework: 'react',
        lifecycleEffects: [
          { kind: 'react-effect', name: 'useEffect', dataAccessCount: 1, navigationCount: 1, lineRange: { start: 5, end: 12 } },
          { kind: 'react-effect', name: 'useEffect', timerCount: 1, lineRange: { start: 14, end: 18 } },
          { kind: 'react-effect', name: 'useEffect', subscriptionCount: 1, lineRange: { start: 20, end: 28 } },
        ],
        dataAccess: [{ kind: 'fetch', callee: 'fetch', target: '/api/orders', lineRange: { start: 7, end: 7 } }],
        navigation: [{ kind: 'navigate', callee: 'navigate', target: '/done', lineRange: { start: 8, end: 8 } }],
        timers: [{ kind: 'timeout', callee: 'setTimeout', lineRange: { start: 16, end: 16 } }],
        subscriptions: [{ kind: 'event-listener', callee: 'window.addEventListener', lineRange: { start: 22, end: 22 } }],
        components: [{
          framework: 'react',
          name: 'OrdersPage',
          lineRange: { start: 1, end: 60 },
          props: [
            { name: 'order', kind: 'data', source: 'destructured-param' },
            { name: 'selectedOrder', kind: 'data', source: 'destructured-param' },
            { name: 'isLoading', kind: 'state-flag', source: 'destructured-param' },
            { name: 'errorMessage', kind: 'data', source: 'destructured-param' },
            { name: 'onSubmit', kind: 'callback', source: 'destructured-param' },
            { name: 'onCancel', kind: 'callback', source: 'destructured-param' },
            { name: 'onRetry', kind: 'callback', source: 'destructured-param' },
            { name: 'setDraftMode', kind: 'setter', source: 'destructured-param' },
          ],
          childComponents: [
            { componentName: 'OrderForm', passedProps: ['order', 'selectedOrder', 'onSubmit', 'setDraftMode'], passedCallbacks: ['onSubmit', 'setDraftMode'], forwardedProps: ['order', 'selectedOrder', 'onSubmit', 'setDraftMode'], spreadProps: [] },
            { componentName: 'OrderToolbar', passedProps: ['isLoading', 'onCancel', 'onRetry'], passedCallbacks: ['onCancel', 'onRetry'], forwardedProps: ['isLoading', 'onCancel', 'onRetry'], spreadProps: [] },
            { componentName: 'OrderSummary', passedProps: ['order', 'errorMessage'], passedCallbacks: [], forwardedProps: ['order', 'errorMessage'], spreadProps: [] },
          ],
          localSignals: { localState: 2, effects: 3, dataAccess: 1, navigation: 1, timers: 1, subscriptions: 1, serviceImports: 1, validationOrMapping: 1 },
        }],
      },
    };

    const domainRules = addMod('mod:app/src/domain/orders/rules', 'src/domain/orders/rules.ts', [functionExport('priceOrder')]);
    page.imports = [{ moduleSpecifier: '../../domain/orders/rules', resolvedModuleId: domainRules.id, importedNames: ['priceOrder'], isTypeOnly: false, isExternal: false }];
    addEdge(g, page.id, domainRules.id, 'imports');
    const applicationUseCase = addMod('mod:app/src/features/orders/application/use-cases/ActivateOrderUseCase', 'src/features/orders/application/use-cases/ActivateOrderUseCase.ts', [functionExport('activateOrder')]);
    applicationUseCase.imports = [{ moduleSpecifier: '../../../domain/orders/rules', resolvedModuleId: domainRules.id, importedNames: ['priceOrder'], isTypeOnly: false, isExternal: false }];
    addEdge(g, applicationUseCase.id, domainRules.id, 'imports');

    const featureHook = addMod('mod:app/src/features/orders/useOrder', 'src/features/orders/useOrder.ts', [functionExport('useOrder')]);
    const button = addMod('mod:app/src/components/ui/Button', 'src/components/ui/Button.tsx', [componentExport('Button')]);
    button.imports = [{ moduleSpecifier: '../../features/orders/useOrder', resolvedModuleId: featureHook.id, importedNames: ['useOrder'], isTypeOnly: false, isExternal: false }];
    addEdge(g, button.id, featureHook.id, 'imports');

    for (const name of ['orders.service', 'orders-client', 'api-orders', 'orders-adapter']) {
      const wrapper = addMod(`mod:app/src/services/${name}`, `src/services/${name}.ts`, [functionExport(name.replace(/[-.]/g, ''))]);
      wrapper.semanticHints = {
        ui: {
          serviceWrapper: {
            candidate: true,
            role: name.includes('client') ? 'client' : name.includes('api') ? 'api' : name.includes('adapter') ? 'adapter' : 'service',
            lineCount: 35,
            delegateCallCount: 1,
          },
        },
      };
    }
    const excludedBarrel = addMod('mod:app/src/services/index', 'src/services/index.ts');
    excludedBarrel.semanticHints = { ui: { serviceWrapper: { candidate: true, role: 'service', lineCount: 3, delegateCallCount: 0 } } };
    const excludedInterface = addMod('mod:app/src/providers/interfaces/cache', 'src/providers/interfaces/cache.ts', [typeExport('CacheProvider')]);
    excludedInterface.semanticHints = { ui: { serviceWrapper: { candidate: true, role: 'provider', lineCount: 8, delegateCallCount: 0 } } };
    const excludedTypeApi = addMod('mod:app/src/types/orders-api', 'src/types/orders-api.ts', [typeExport('OrdersApi')]);
    excludedTypeApi.semanticHints = { ui: { serviceWrapper: { candidate: true, role: 'api', lineCount: 6, delegateCallCount: 0 } } };

    const orderMutation = addMod('mod:app/src/features/orders/order-mutations', 'src/features/orders/order-mutations.ts', [functionExport('submitOrder')]);
    orderMutation.semanticHints = {
      ui: { dataAccess: [{ kind: 'mutation', callee: 'api.post', target: '/api/orders', lineRange: { start: 5, end: 5 } }] },
    };

    const routeA = addMod('mod:app/src/routes/create-order', 'src/routes/create-order.tsx', [componentExport('CreateOrderRoute')]);
    routeA.semanticHints = {
      hasRoutes: true,
      routes: [{ path: '/orders/create', component: '(file-route)', source: 'file', kind: 'frontend' }],
    };
    routeA.imports = [{ moduleSpecifier: '../features/orders/order-mutations', resolvedModuleId: orderMutation.id, importedNames: ['submitOrder'], isTypeOnly: false, isExternal: false }];
    addEdge(g, routeA.id, orderMutation.id, 'imports');
    const routeB = addMod('mod:app/src/routes/import-order', 'src/routes/import-order.tsx', [componentExport('ImportOrderRoute')]);
    routeB.semanticHints = {
      hasRoutes: true,
      routes: [{ path: '/orders/import', component: '(file-route)', source: 'file', kind: 'frontend' }],
    };
    routeB.imports = [{ moduleSpecifier: '../features/orders/order-mutations', resolvedModuleId: orderMutation.id, importedNames: ['submitOrder'], isTypeOnly: false, isExternal: false }];
    addEdge(g, routeB.id, orderMutation.id, 'imports');

    const ctx = makeCtx({ graph: g, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });
    const result = await architectureResult(ctx, {
      categories: [
        'effect-spaghetti',
        'prop-drilling-orchestration',
        'ui-domain-coupling',
        'design-system-leakage',
        'service-wrapper-explosion',
        'route-convergence',
      ],
    }) as Record<string, unknown>;
    const findings = result.findings as Array<Record<string, unknown>>;
    const ids = new Set(findings.map(f => f.id));

    const effectFinding = expectFinding(findings, `effect-spaghetti:${page.id}`);
    expect(effectFinding).toMatchObject({ category: 'effect-spaghetti', nodes: [page.id] });
    expect(effectFinding.evidence).toEqual(expect.arrayContaining([
      expect.stringContaining('3 lifecycle/effect block(s) detected'),
    ]));

    const propFinding = expectFinding(findings, `prop-drilling-orchestration:${page.id}:OrdersPage#1`);
    expect(propFinding).toMatchObject({ category: 'prop-drilling-orchestration' });
    expect(propFinding.nodes).toEqual(expect.arrayContaining([page.id]));

    const couplingFinding = expectFinding(findings, `ui-domain-coupling:${page.id}`);
    expect(couplingFinding).toMatchObject({
      category: 'ui-domain-coupling',
      nodes: expect.arrayContaining([page.id, domainRules.id]),
    });

    const leakageFinding = expectFinding(findings, `design-system-leakage:${button.id}`);
    expect(leakageFinding).toMatchObject({
      category: 'design-system-leakage',
      nodes: expect.arrayContaining([button.id, featureHook.id]),
    });

    const routeFinding = expectFinding(findings, `route-convergence:module:${orderMutation.id}`);
    expect(routeFinding).toMatchObject({
      category: 'route-convergence',
      nodes: expect.arrayContaining([orderMutation.id, routeA.id, routeB.id]),
    });

    expect(ids.has(`ui-domain-coupling:${applicationUseCase.id}`)).toBe(false);
    const wrapperFinding = expectFinding(findings, 'service-wrapper-explosion:pkg:app');
    expect(wrapperFinding).toMatchObject({ category: 'service-wrapper-explosion' });
    expect(wrapperFinding.nodes).toEqual(expect.arrayContaining([
      'mod:app/src/services/orders.service',
      'mod:app/src/services/orders-client',
      'mod:app/src/services/api-orders',
      'mod:app/src/services/orders-adapter',
    ]));
    expect(wrapperFinding.nodes).not.toEqual(expect.arrayContaining([excludedBarrel.id, excludedInterface.id, excludedTypeApi.id]));
  });

  it('respects category and confidence filters', async () => {
    const { graph, modulesById } = buildRefactoringFixture();
    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });

    const result = await architectureResult(ctx, {
      categories: ['event-driven-boundary'],
      minConfidence: 0.95,
    }) as Record<string, unknown>;

    expect(result.totalFindings).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it('reports inbound boundary issues when scoped to a package', async () => {
    const { graph, modulesById } = buildRefactoringFixture();
    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });

    const result = await architectureResult(ctx, {
      scope: 'pkg:shared',
      categories: ['boundary'],
    }) as Record<string, unknown>;
    const findings = result.findings as Array<Record<string, unknown>>;

    expect(result.totalFindings).toBe(1);
    expect(expectFinding(findings, 'boundary:mod:shared/src/internal/rules')).toMatchObject({
      category: 'boundary',
      nodes: expect.arrayContaining(['mod:shared/src/internal/rules', 'mod:app/src/page']),
    });
  });

  it('expands a refactoring finding with node summaries and category details', async () => {
    const { graph, modulesById } = buildRefactoringFixture();
    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });

    const detail = await architectureResult(ctx, {
      findingId: 'boundary:mod:shared/src/internal/rules',
      scope: 'pkg:shared',
    }) as Record<string, unknown>;

    expect(detail.findingId).toBe('boundary:mod:shared/src/internal/rules');
    expect(detail.finding).toMatchObject({ category: 'boundary' });
    expect(detail.affectedNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'mod:shared/src/internal/rules', type: 'module' }),
      expect.objectContaining({ id: 'mod:app/src/page', type: 'module' }),
    ]));
    expect(detail.categoryDetail).toMatchObject({
      targetId: 'mod:shared/src/internal/rules',
      importers: expect.arrayContaining(['mod:app/src/page']),
      importedSymbols: expect.arrayContaining(['applyRules']),
    });
    expect((detail.nextCalls as Array<{ tool?: string }>).some(call => call.tool === 'analyze_dependencies')).toBe(true);
  });

  it('returns a helpful error for an unknown refactoring finding id', async () => {
    const { graph, modulesById } = buildRefactoringFixture();
    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });

    const detail = await architectureResult(ctx, {
      findingId: 'boundary:mod:missing',
    }) as Record<string, unknown>;

    expect(detail.error).toContain('not found');
    expect(detail.sampleFindingIds).toEqual(expect.any(Array));
  });

  it('keeps total summary separate from returned summary', async () => {
    const { graph, modulesById } = buildRefactoringFixture();
    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });

    const result = await architectureResult(ctx, {
      categories: ['boundary', 'god-module'],
      limit: 1,
    }) as Record<string, unknown>;
    const summary = result.summary as Record<string, number>;
    const returnedSummary = result.returnedSummary as Record<string, number>;

    expect(summary.boundary).toBe(1);
    expect(summary['god-module']).toBe(1);
    expect(returnedSummary.boundary + returnedSummary['god-module']).toBe(1);
  });

  it('collapses parent and subdomain tags before unclear-architecture counting', async () => {
    const { graph, modulesById } = buildRefactoringFixture();
    for (const id of ['auth', 'monday', 'config', 'shared']) {
      addNode(graph, { id: `domain:${id}`, type: 'domain', label: id, description: '' });
    }
    addNode(graph, { id: 'domain:monday/auth', type: 'domain', label: 'monday/auth', description: '', data: { parent: 'monday' } });
    addNode(graph, { id: 'domain:shared/auth', type: 'domain', label: 'shared/auth', description: '', data: { parent: 'shared' } });
    for (const domainId of ['domain:auth', 'domain:monday', 'domain:config', 'domain:shared', 'domain:monday/auth', 'domain:shared/auth']) {
      addEdge(graph, 'mod:shared/src/internal/rules', domainId, 'tagged');
    }
    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });

    const result = await architectureResult(ctx, {
      scope: 'pkg:shared',
      categories: ['unclear-architecture'],
    }) as Record<string, unknown>;

    expect(result.totalFindings).toBe(0);
  });

  it('reports unclear architecture at five distinct root domains', async () => {
    const { graph, modulesById } = buildRefactoringFixture();
    for (const id of ['auth', 'billing', 'config', 'orders', 'shared']) {
      addNode(graph, { id: `domain:${id}`, type: 'domain', label: id, description: '' });
      addEdge(graph, 'mod:shared/src/internal/rules', `domain:${id}`, 'tagged');
    }
    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });

    const result = await architectureResult(ctx, {
      scope: 'pkg:shared',
      categories: ['unclear-architecture'],
    }) as Record<string, unknown>;
    const findings = result.findings as Array<Record<string, unknown>>;

    expect(result.totalFindings).toBe(1);
    expect(expectFinding(
      findings,
      'unclear-architecture:mod:shared/src/internal/rules:domains',
    )).toMatchObject({
      category: 'unclear-architecture',
      nodes: expect.arrayContaining([
        'mod:shared/src/internal/rules',
        'domain:auth',
        'domain:billing',
        'domain:config',
        'domain:orders',
        'domain:shared',
      ]),
    });
  });

  it('filters generic tooling, sdk client, and design-system modules from client-business-logic', async () => {
    const { graph, modulesById } = buildRefactoringFixture();
    const modules: ModuleInfo[] = [];
    const addUiModule = (id: string, relativeFilePath: string, exportNames: string[], options?: { envVars?: string[] }): void => {
      addNode(graph, { id, type: 'module', label: relativeFilePath.replace(/\.(tsx?|jsx?)$/, ''), description: '', data: { relativeFilePath } });
      addEdge(graph, 'pkg:app', id, 'contains');
      const mod = makeModuleInfo(id, `/repo/packages/app/${relativeFilePath}`);
      mod.packageName = 'app';
      mod.relativeFilePath = relativeFilePath;
      mod.exports = exportNames.map((name, index) => ({
        name,
        kind: /^[A-Z]/.test(name) ? 'component' as const : 'function' as const,
        lineRange: { start: index + 1, end: index + 1 },
        isDefault: false,
      }));
      if (options?.envVars) mod.semanticHints = { envVars: options.envVars };
      modulesById.set(id, mod);
      modules.push(mod);
    };
    addUiModule('mod:app/vite.config', 'vite.config.ts', ['defineConfig'], { envVars: ['VITE_API_URL'] });
    addUiModule('mod:app/src/lib/api-client', 'src/lib/api-client.ts', ['get', 'post', 'put', 'patch', 'remove', 'request'], { envVars: ['API_URL'] });
    addUiModule('mod:app/src/components/ui/select', 'src/components/ui/select.tsx', ['Select', 'SelectItem', 'SelectTrigger', 'SelectValue', 'selectVariants']);
    addUiModule('mod:app/src/features/orders/rules', 'src/features/orders/rules.ts', ['validateOrder', 'priceOrder', 'mapOrder', 'canSubmit', 'normalizeOrder']);

    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });
    const result = await architectureResult(ctx, {
      scope: 'pkg:app',
      categories: ['client-business-logic'],
      minConfidence: 0.5,
    }) as Record<string, unknown>;
    const findings = result.findings as Array<Record<string, unknown>>;
    const ids = findings.map(f => f.id);

    expect(ids).toContain('client-business-logic:mod:app/src/features/orders/rules');
    expect(ids).not.toContain('client-business-logic:mod:app/vite.config');
    expect(ids).not.toContain('client-business-logic:mod:app/src/lib/api-client');
    expect(ids).not.toContain('client-business-logic:mod:app/src/components/ui/select');
  });

  it('reports frontend flow convergence on shared/domain targets', async () => {
    const { graph, modulesById } = buildRefactoringFixture();
    const addModule = (id: string, pkg: 'app' | 'shared', relativeFilePath: string, exportNames: string[]): ModuleInfo => {
      addNode(graph, { id, type: 'module', label: relativeFilePath.replace(/\.(tsx?|jsx?)$/, ''), description: '', data: { relativeFilePath } });
      addEdge(graph, `pkg:${pkg}`, id, 'contains');
      const mod = makeModuleInfo(id, `/repo/packages/${pkg}/${relativeFilePath}`);
      mod.packageName = pkg;
      mod.relativeFilePath = relativeFilePath;
      mod.exports = exportNames.map((name, index) => ({
        name,
        kind: /^[A-Z]/.test(name) ? 'component' as const : 'function' as const,
        lineRange: { start: index + 1, end: index + 1 },
        isDefault: false,
      }));
      modulesById.set(id, mod);
      return mod;
    };

    const checkoutPage = addModule('mod:app/src/pages/checkout', 'app', 'src/pages/checkout.tsx', ['CheckoutPage']);
    const profilePage = addModule('mod:app/src/pages/profile', 'app', 'src/pages/profile.tsx', ['ProfilePage']);
    const checkoutMapper = addModule('mod:app/src/features/checkout/mapping', 'app', 'src/features/checkout/mapping.ts', ['mapCheckout']);
    const profileMapper = addModule('mod:app/src/features/profile/mapping', 'app', 'src/features/profile/mapping.ts', ['mapProfile']);

    addEdge(graph, checkoutPage.id, checkoutMapper.id, 'imports');
    addEdge(graph, profilePage.id, profileMapper.id, 'imports');
    addEdge(graph, checkoutMapper.id, 'mod:shared/src/internal/rules', 'imports');
    addEdge(graph, profileMapper.id, 'mod:shared/src/internal/rules', 'imports');

    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });
    const result = await architectureResult(ctx, {
      categories: ['flow-convergence'],
      minConfidence: 0.5,
    }) as Record<string, unknown>;
    const findings = result.findings as Array<Record<string, unknown>>;

    expect(findings).toHaveLength(1);
    const finding = expectFinding(findings, 'flow-convergence:mod:shared/src/internal/rules');
    expect(finding).toMatchObject({
      category: 'flow-convergence',
      nodes: expect.arrayContaining([
        'mod:shared/src/internal/rules',
        checkoutPage.id,
        profilePage.id,
      ]),
    });
    expect(finding.evidence).toEqual(expect.arrayContaining([
      expect.stringContaining('Repeated pre-target responsibility keys'),
    ]));
  });

  it('keeps component-only flow entrypoints opt-in', async () => {
    const { graph, modulesById } = buildRefactoringFixture();
    const addModule = (id: string, relativeFilePath: string, exportNames: string[]): ModuleInfo => {
      addNode(graph, { id, type: 'module', label: relativeFilePath.replace(/\.(tsx?|jsx?)$/, ''), description: '', data: { relativeFilePath } });
      addEdge(graph, 'pkg:app', id, 'contains');
      const mod = makeModuleInfo(id, `/repo/packages/app/${relativeFilePath}`);
      mod.packageName = 'app';
      mod.relativeFilePath = relativeFilePath;
      mod.exports = exportNames.map((name, index) => ({
        name,
        kind: /^[A-Z]/.test(name) ? 'component' as const : 'function' as const,
        lineRange: { start: index + 1, end: index + 1 },
        isDefault: false,
      }));
      modulesById.set(id, mod);
      return mod;
    };

    const card = addModule('mod:app/src/features/orders/components/OrderCard', 'src/features/orders/components/OrderCard.tsx', ['OrderCard']);
    const panel = addModule('mod:app/src/features/profile/components/ProfilePanel', 'src/features/profile/components/ProfilePanel.tsx', ['ProfilePanel']);
    addEdge(graph, card.id, 'mod:shared/src/internal/rules', 'imports');
    addEdge(graph, panel.id, 'mod:shared/src/internal/rules', 'imports');

    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });
    const defaultResult = await architectureResult(ctx, {
      categories: ['flow-convergence'],
      minConfidence: 0.5,
    }) as Record<string, unknown>;
    expect(defaultResult.findings).toHaveLength(0);

    const optInResult = await architectureResult(ctx, {
      categories: ['flow-convergence'],
      includeComponentEntrypoints: true,
      minConfidence: 0.5,
    }) as Record<string, unknown>;
    expect(optInResult.findings).toHaveLength(1);
  });

  it('groups sibling shared convergence targets and suppresses generic targets without prep overlap', async () => {
    const { graph, modulesById } = buildRefactoringFixture();
    const addModule = (id: string, pkg: 'app' | 'shared', relativeFilePath: string, exportNames: string[]): ModuleInfo => {
      addNode(graph, { id, type: 'module', label: relativeFilePath.replace(/\.(tsx?|jsx?)$/, ''), description: '', data: { relativeFilePath } });
      addEdge(graph, `pkg:${pkg}`, id, 'contains');
      const mod = makeModuleInfo(id, `/repo/packages/${pkg}/${relativeFilePath}`);
      mod.packageName = pkg;
      mod.relativeFilePath = relativeFilePath;
      mod.exports = exportNames.map((name, index) => ({
        name,
        kind: /^[A-Z]/.test(name) ? 'component' as const : 'function' as const,
        lineRange: { start: index + 1, end: index + 1 },
        isDefault: false,
      }));
      modulesById.set(id, mod);
      return mod;
    };
    const checkoutPage = addModule('mod:app/src/pages/checkout-store', 'app', 'src/pages/checkout-store.tsx', ['CheckoutPage']);
    const profilePage = addModule('mod:app/src/pages/profile-store', 'app', 'src/pages/profile-store.tsx', ['ProfilePage']);
    const checkoutMapper = addModule('mod:app/src/features/checkout/mapping-store', 'app', 'src/features/checkout/mapping-store.ts', ['mapCheckout']);
    const profileMapper = addModule('mod:app/src/features/profile/mapping-store', 'app', 'src/features/profile/mapping-store.ts', ['mapProfile']);
    const cartSlice = addModule('mod:shared/src/shared/store/slices/cart', 'shared', 'src/shared/store/slices/cart.ts', ['cartSlice']);
    const profileSlice = addModule('mod:shared/src/shared/store/slices/profile', 'shared', 'src/shared/store/slices/profile.ts', ['profileSlice']);
    const env = addModule('mod:shared/src/shared/config/env', 'shared', 'src/shared/config/env.ts', ['env']);

    addEdge(graph, checkoutPage.id, checkoutMapper.id, 'imports');
    addEdge(graph, profilePage.id, profileMapper.id, 'imports');
    addEdge(graph, checkoutMapper.id, cartSlice.id, 'imports');
    addEdge(graph, profileMapper.id, profileSlice.id, 'imports');
    addEdge(graph, checkoutPage.id, env.id, 'imports');
    addEdge(graph, profilePage.id, env.id, 'imports');

    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });
    const result = await architectureResult(ctx, {
      categories: ['flow-convergence'],
      minConfidence: 0.5,
    }) as Record<string, unknown>;
    const findings = result.findings as Array<Record<string, unknown>>;

    expect(findings).toHaveLength(1);
    const finding = expectFinding(findings, 'flow-convergence:pkg:shared:shared/store/slices/*');
    expect(finding.nodes).toEqual(expect.arrayContaining([cartSlice.id, profileSlice.id]));
    expect(finding.nodes).not.toContain(env.id);
  });

  it('reports state fragmentation across hooks stores and contexts in a feature', async () => {
    const { graph, modulesById } = buildRefactoringFixture();
    const addModule = (id: string, relativeFilePath: string, exportNames: string[]): ModuleInfo => {
      addNode(graph, { id, type: 'module', label: relativeFilePath.replace(/\.(tsx?|jsx?)$/, ''), description: '', data: { relativeFilePath } });
      addEdge(graph, 'pkg:app', id, 'contains');
      const mod = makeModuleInfo(id, `/repo/packages/app/${relativeFilePath}`);
      mod.packageName = 'app';
      mod.relativeFilePath = relativeFilePath;
      mod.exports = exportNames.map((name, index) => ({
        name,
        kind: /^[A-Z]/.test(name) ? 'component' as const : 'function' as const,
        lineRange: { start: index + 1, end: index + 1 },
        isDefault: false,
      }));
      modulesById.set(id, mod);
      return mod;
    };
    const store = addModule('mod:app/src/features/orders/store/order-store', 'src/features/orders/store/order-store.ts', ['useOrderStore']);
    const hook = addModule('mod:app/src/features/orders/hooks/useOrderDraft', 'src/features/orders/hooks/useOrderDraft.ts', ['useOrderDraft']);
    const context = addModule('mod:app/src/features/orders/contexts/OrderContext', 'src/features/orders/contexts/OrderContext.tsx', ['OrderProvider', 'useOrderContext']);

    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });
    const result = await architectureResult(ctx, {
      categories: ['state-fragmentation'],
      minConfidence: 0.5,
    }) as Record<string, unknown>;
    const findings = result.findings as Array<Record<string, unknown>>;

    expect(findings).toHaveLength(1);
    expect(expectFinding(findings, 'state-fragmentation:feature:orders')).toMatchObject({
      category: 'state-fragmentation',
      nodes: expect.arrayContaining([store.id, hook.id, context.id]),
    });
  });

  it('reports duplicated client policy across features', async () => {
    const { graph, modulesById } = buildRefactoringFixture();
    const addModule = (id: string, relativeFilePath: string, exportNames: string[]): ModuleInfo => {
      addNode(graph, { id, type: 'module', label: relativeFilePath.replace(/\.(tsx?|jsx?)$/, ''), description: '', data: { relativeFilePath } });
      addEdge(graph, 'pkg:app', id, 'contains');
      const mod = makeModuleInfo(id, `/repo/packages/app/${relativeFilePath}`);
      mod.packageName = 'app';
      mod.relativeFilePath = relativeFilePath;
      mod.exports = exportNames.map((name, index) => ({
        name,
        kind: 'function' as const,
        lineRange: { start: index + 1, end: index + 1 },
        isDefault: false,
      }));
      modulesById.set(id, mod);
      return mod;
    };
    const orderRules = addModule('mod:app/src/features/orders/policy/access-policy', 'src/features/orders/policy/access-policy.ts', ['canSubmitOrder']);
    const profileRules = addModule('mod:app/src/features/profile/policy/access-policy', 'src/features/profile/policy/access-policy.ts', ['canSubmitProfile']);
    const billingRules = addModule('mod:app/src/features/billing/policy/access-policy', 'src/features/billing/policy/access-policy.ts', ['canSubmitBilling']);

    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });
    const result = await architectureResult(ctx, {
      categories: ['duplicated-client-policy'],
      minConfidence: 0.5,
    }) as Record<string, unknown>;
    const findings = result.findings as Array<Record<string, unknown>>;

    expect(findings).toHaveLength(1);
    expect(expectFinding(findings, 'duplicated-client-policy:permissions:submit')).toMatchObject({
      category: 'duplicated-client-policy',
      nodes: expect.arrayContaining([orderRules.id, profileRules.id, billingRules.id]),
    });
  });

  it('keeps duplicated client policy focused on executable policy instead of static pages and pure types', async () => {
    const { graph, modulesById } = buildRefactoringFixture();
    const addModule = (id: string, relativeFilePath: string, exports: Array<{ name: string; kind?: ModuleInfo['exports'][number]['kind'] }>): ModuleInfo => {
      addNode(graph, { id, type: 'module', label: relativeFilePath.replace(/\.(tsx?|jsx?)$/, ''), description: '', data: { relativeFilePath } });
      addEdge(graph, 'pkg:app', id, 'contains');
      const mod = makeModuleInfo(id, `/repo/packages/app/${relativeFilePath}`);
      mod.packageName = 'app';
      mod.relativeFilePath = relativeFilePath;
      mod.exports = exports.map((exp, index) => ({
        name: exp.name,
        kind: exp.kind ?? 'function' as const,
        lineRange: { start: index + 1, end: index + 1 },
        isDefault: false,
      }));
      modulesById.set(id, mod);
      return mod;
    };
    addModule('mod:app/src/pages/TickPrivacyPage', 'src/pages/TickPrivacyPage.tsx', [{ name: 'TickPrivacyPage', kind: 'component' }]);
    addModule('mod:app/src/pages/LandingPage', 'src/pages/LandingPage.tsx', [{ name: 'LandingPage', kind: 'component' }]);
    addModule('mod:app/src/features/orders/types', 'src/features/orders/types.ts', [{ name: 'OrderConfig', kind: 'interface' }]);
    const orderPolicy = addModule('mod:app/src/features/orders/policy/access-policy', 'src/features/orders/policy/access-policy.ts', [{ name: 'canSubmitOrder' }]);
    const profilePolicy = addModule('mod:app/src/features/profile/policy/access-policy', 'src/features/profile/policy/access-policy.ts', [{ name: 'canSubmitProfile' }]);
    const billingPolicy = addModule('mod:app/src/features/billing/policy/access-policy', 'src/features/billing/policy/access-policy.ts', [{ name: 'canSubmitBilling' }]);

    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });
    const result = await architectureResult(ctx, {
      categories: ['duplicated-client-policy'],
      minConfidence: 0.5,
    }) as Record<string, unknown>;
    const findings = result.findings as Array<Record<string, unknown>>;

    expect(findings).toHaveLength(1);
    const finding = expectFinding(findings, 'duplicated-client-policy:permissions:submit');
    const nodes = finding.nodes as string[];
    expect(nodes).toEqual(expect.arrayContaining([orderPolicy.id, profilePolicy.id, billingPolicy.id]));
    expect(nodes).not.toContain('mod:app/src/pages/TickPrivacyPage');
    expect(nodes).not.toContain('mod:app/src/pages/LandingPage');
    expect(nodes).not.toContain('mod:app/src/features/orders/types');
  });

  it('uses annotations and export verbs to detect duplicated client policy', async () => {
    const { graph, modulesById } = buildRefactoringFixture();
    const addModule = (id: string, relativeFilePath: string, exportNames: string[]): ModuleInfo => {
      addNode(graph, { id, type: 'module', label: relativeFilePath.replace(/\.(tsx?|jsx?)$/, ''), description: '', data: { relativeFilePath } });
      addEdge(graph, 'pkg:app', id, 'contains');
      const mod = makeModuleInfo(id, `/repo/packages/app/${relativeFilePath}`);
      mod.packageName = 'app';
      mod.relativeFilePath = relativeFilePath;
      mod.exports = exportNames.map((name, index) => ({
        name,
        kind: 'function' as const,
        lineRange: { start: index + 1, end: index + 1 },
        isDefault: false,
      }));
      modulesById.set(id, mod);
      return mod;
    };
    const order = addModule('mod:app/src/features/orders/utils/order-decisions', 'src/features/orders/utils/order-decisions.ts', ['shouldArchiveOrder']);
    const profile = addModule('mod:app/src/features/profile/helpers/profile-decisions', 'src/features/profile/helpers/profile-decisions.ts', ['shouldArchiveProfile']);
    const billing = addModule('mod:app/src/features/billing/utils/billing-decisions', 'src/features/billing/utils/billing-decisions.ts', ['archiveBilling']);
    const annotations = {
      get: (id: string) => id === billing.id
        ? {
          nodeId: billing.id,
          nodeType: 'module',
          contentHash: 'abc123',
          pass: 1,
          updatedAt: '2024-01-01',
          schemaVersion: 1,
          annotation: {
            summary: 'Builds billing archive decisions from reusable eligibility policy.',
            invariants: ['Billing archive eligibility must be checked before rendering actions.'],
          },
        }
        : undefined,
      set: jest.fn(),
      isFresh: () => true,
      getQueue: () => [],
      getStats: () => backlogCoverage(),
    } as unknown as RepovineState['annotations'];

    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]), annotations });
    const result = await architectureResult(ctx, {
      categories: ['duplicated-client-policy'],
      minConfidence: 0.5,
    }) as Record<string, unknown>;
    const findings = result.findings as Array<Record<string, unknown>>;

    const finding = expectFinding(findings, 'duplicated-client-policy:policy-rules:decisions-archive');
    expect(finding).toMatchObject({
      category: 'duplicated-client-policy',
      nodes: expect.arrayContaining([order.id, profile.id, billing.id]),
    });
  });
});

// ── refactoringThresholds: per-repo config knobs ──

describe('get_refactoring_report refactoringThresholds', () => {
  function buildTinyDuplicateFixture(): {
    graph: RepositoryGraph;
    modulesById: Map<string, ModuleInfo>;
  } {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'pkg:app', type: 'package', label: 'app', description: '' });
    addEdge(g, 'root', 'pkg:app', 'contains');
    const modulesById = new Map<string, ModuleInfo>();
    // 2 modules with same normalize key, same package → below "normal" thresholds (3 / 2)
    const addLogger = (relPath: string): void => {
      const id = `mod:app/${relPath.replace(/\.ts$/, '')}`;
      addNode(g, { id, type: 'module', label: relPath.replace(/\.ts$/, ''), description: '', data: { relativeFilePath: relPath } });
      addEdge(g, 'pkg:app', id, 'contains');
      const mod = makeModuleInfo(id, `/repo/packages/app/${relPath}`);
      mod.packageName = 'app';
      mod.relativeFilePath = relPath;
      modulesById.set(id, mod);
    };
    addLogger('src/lib/logger.ts');
    addLogger('src/utils/logger.ts');
    return { graph: g, modulesById };
  }

  it('default (normal profile) does NOT emit duplicate-like for a 2-module same-package group', async () => {
    const { graph, modulesById } = buildTinyDuplicateFixture();
    const ctx = makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });
    const result = await architectureResult(ctx, {
      categories: ['duplicate-like'],
      minConfidence: 0.3,
    }) as Record<string, unknown>;
    expect(result.totalFindings).toBe(0);
  });

  it('loose-profile thresholds (minGroupSize=2, minPackages=1) emit a finding for the same fixture', async () => {
    const { graph, modulesById } = buildTinyDuplicateFixture();
    const ctx = makeCtx({
      graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]),
      refactoringThresholds: {
        ...defaultRefactoringThresholds(),
        duplicateLike: { minGroupSize: 2, minPackages: 1 },
      },
    });
    const result = await architectureResult(ctx, {
      categories: ['duplicate-like'],
      minConfidence: 0.3,
    }) as Record<string, unknown>;
    const findings = result.findings as Array<{ id: string }>;
    expectFinding(findings, 'duplicate-like:logger');
  });

  it('per-knob override on godModule.minScore raises the score gate', async () => {
    // Build a god-module candidate: 12 exports + 1 fanIn → score 19 (above default 18, below 100).
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'pkg:app', type: 'package', label: 'app', description: '' });
    addNode(g, { id: 'pkg:client', type: 'package', label: 'client', description: '' });
    addEdge(g, 'root', 'pkg:app', 'contains');
    addEdge(g, 'root', 'pkg:client', 'contains');
    const targetId = 'mod:app/src/big-module';
    const importerId = 'mod:client/src/uses-big';
    addNode(g, { id: targetId, type: 'module', label: 'big-module', description: '',
      data: { relativeFilePath: 'src/big-module.ts' } });
    addNode(g, { id: importerId, type: 'module', label: 'uses-big', description: '',
      data: { relativeFilePath: 'src/uses-big.ts' } });
    addEdge(g, 'pkg:app', targetId, 'contains');
    addEdge(g, 'pkg:client', importerId, 'contains');
    addEdge(g, importerId, targetId, 'imports');
    const target = makeModuleInfo(targetId, '/repo/packages/app/src/big-module.ts');
    target.packageName = 'app';
    target.relativeFilePath = 'src/big-module.ts';
    target.exports = Array.from({ length: 12 }, (_, i) => ({
      name: `fn${i}`, kind: 'function' as const, lineRange: { start: i * 5 + 1, end: i * 5 + 4 }, isDefault: false,
    }));
    const importer = makeModuleInfo(importerId, '/repo/packages/client/src/uses-big.ts');
    importer.packageName = 'client';
    importer.relativeFilePath = 'src/uses-big.ts';
    const modulesById = new Map<string, ModuleInfo>([[target.id, target], [importer.id, importer]]);

    // Default thresholds → finding emitted (score 19 >= 18)
    const ctxDefault = makeCtx({ graph: g, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });
    const defaultResult = await architectureResult(ctxDefault, {
      categories: ['god-module'],
      minConfidence: 0.3,
    }) as Record<string, unknown>;
    expectFinding(defaultResult.findings as Array<{ id: string }>, `god-module:${targetId}`);

    // Bump minScore to 100 — should suppress
    const ctxStrict = makeCtx({
      graph: g, modulesById, snapshot: makeSnapshot([...modulesById.values()]),
      refactoringThresholds: {
        ...defaultRefactoringThresholds(),
        godModule: { minScore: 100, linesPerScorePoint: 150 },
      },
    });
    const strictResult = await architectureResult(ctxStrict, {
      categories: ['god-module'],
      minConfidence: 0.3,
    }) as Record<string, unknown>;
    expect(strictResult.totalFindings).toBe(0);
  });
});

// ── get_refactoring_report annotationReasoning mode ──

describe('get_refactoring_report annotationReasoning mode', () => {
  function buildDuplicateFixture(annotationsByModId: Record<string, unknown>): {
    graph: RepositoryGraph;
    modulesById: Map<string, ModuleInfo>;
    annotations: RepovineState['annotations'];
  } {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'pkg:app', type: 'package', label: 'app', description: '' });
    addEdge(g, 'root', 'pkg:app', 'contains');

    const modulesById = new Map<string, ModuleInfo>();
    const addLogger = (relPath: string): ModuleInfo => {
      const id = `mod:app/${relPath.replace(/\.ts$/, '')}`;
      addNode(g, {
        id,
        type: 'module',
        label: relPath.replace(/\.ts$/, ''),
        description: '',
        data: { relativeFilePath: relPath },
      });
      addEdge(g, 'pkg:app', id, 'contains');
      const mod = makeModuleInfo(id, `/repo/packages/app/${relPath}`);
      mod.packageName = 'app';
      mod.relativeFilePath = relPath;
      modulesById.set(id, mod);
      return mod;
    };
    addLogger('src/lib/logger.ts');
    addLogger('src/utils/logger.ts');
    addLogger('src/features/auth/logger.ts');

    const annotations = {
      get: (id: string) => annotationsByModId[id] as unknown,
      set: jest.fn(),
      isFresh: () => true,
      getQueue: () => [],
      getStats: () => backlogCoverage(),
    } as unknown as RepovineState['annotations'];

    return { graph: g, modulesById, annotations };
  }

  function ann(nodeId: string, annotation: Record<string, unknown>): unknown {
    return {
      nodeId,
      nodeType: 'module',
      contentHash: 'abc123',
      pass: 1,
      updatedAt: '2024-01-01',
      schemaVersion: 1,
      annotation,
    };
  }

  it('default mode does not attach annotationContext to duplicate-like findings', async () => {
    const { graph, modulesById, annotations } = buildDuplicateFixture({
      'mod:app/src/lib/logger': ann('mod:app/src/lib/logger', { summary: 'Structured HTTP request logger.' }),
      'mod:app/src/utils/logger': ann('mod:app/src/utils/logger', { summary: 'Lambda cold-start telemetry logger.' }),
    });
    const ctx = makeCtx({ graph, modulesById, annotations, snapshot: makeSnapshot([...modulesById.values()]) });

    const result = await architectureResult(ctx, {
      categories: ['duplicate-like'],
    }) as Record<string, unknown>;
    const findings = result.findings as Array<{ id: string; annotationContext?: unknown }>;

    expectFinding(findings, 'duplicate-like:logger');
    expect(findings.every(f => f.annotationContext === undefined)).toBe(true);
    expect(result.annotationReasoning).toBe('off');
  });

  it('attaches annotationContext to duplicate-like findings when annotationReasoning is on', async () => {
    const { graph, modulesById, annotations } = buildDuplicateFixture({
      'mod:app/src/lib/logger': ann('mod:app/src/lib/logger', {
        summary: 'Structured HTTP request logger emitting JSON lines.',
        invariants: ['Each emit carries a request id'],
      }),
      'mod:app/src/utils/logger': ann('mod:app/src/utils/logger', {
        summary: 'Lambda cold-start telemetry logger; not for request logging.',
        invariants: ['Only fires once per cold start'],
      }),
    });
    const ctx = makeCtx({ graph, modulesById, annotations, snapshot: makeSnapshot([...modulesById.values()]) });

    const result = await architectureResult(ctx, {
      categories: ['duplicate-like'],
      annotationReasoning: 'on',
    }) as Record<string, unknown>;
    const findings = result.findings as Array<{ id: string; annotationContext?: Record<string, unknown> }>;

    expect(result.annotationReasoning).toBe('on');
    const loggerFinding = findings.find(f => f.id === 'duplicate-like:logger');
    expect(loggerFinding).toBeDefined();
    expect(loggerFinding!.annotationContext).toBeDefined();
    expect(loggerFinding!.annotationContext!.question).toBe('same-concept');
    expect(loggerFinding!.annotationContext!.relevantFields).toEqual(expect.arrayContaining(['summary', 'invariants']));
    const nodes = loggerFinding!.annotationContext!.nodes as Array<{ id: string; annotation: Record<string, unknown> }>;
    expect(nodes.length).toBe(2);
    expect(nodes.every(n => typeof n.annotation.summary === 'string')).toBe(true);
    expect((result.note as string)).toContain('annotationContext');
  });

  it('omits annotationContext when fewer than 2 affected nodes carry annotations', async () => {
    const { graph, modulesById, annotations } = buildDuplicateFixture({
      'mod:app/src/lib/logger': ann('mod:app/src/lib/logger', {
        summary: 'Structured HTTP request logger.',
      }),
      // only one annotation — cannot compare
    });
    const ctx = makeCtx({ graph, modulesById, annotations, snapshot: makeSnapshot([...modulesById.values()]) });

    const result = await architectureResult(ctx, {
      categories: ['duplicate-like'],
      annotationReasoning: 'on',
    }) as Record<string, unknown>;
    const findings = result.findings as Array<{ annotationContext?: unknown }>;
    const loggerFinding = findings.find(f => (f as { id: string }).id === 'duplicate-like:logger');
    expect(loggerFinding).toBeDefined();
    expect(loggerFinding!.annotationContext).toBeUndefined();
  });

  it('attaches shared-invariant annotationContext to low-cohesion findings when annotationReasoning is on', async () => {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'pkg:app', type: 'package', label: 'app', description: '' });
    addEdge(g, 'root', 'pkg:app', 'contains');
    addNode(g, { id: 'pkg:external', type: 'package', label: 'external', description: '' });
    addEdge(g, 'root', 'pkg:external', 'contains');
    addNode(g, { id: 'domain:billing', type: 'domain', label: 'billing', description: '' });
    addNode(g, { id: 'mod:external/lib', type: 'module', label: 'lib', description: '',
      data: { relativeFilePath: 'lib.ts' } });
    addEdge(g, 'pkg:external', 'mod:external/lib', 'contains');

    const modulesById = new Map<string, ModuleInfo>();
    const moduleIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const id = `mod:app/src/billing/m${i}`;
      addNode(g, { id, type: 'module', label: `m${i}`, description: '',
        data: { relativeFilePath: `src/billing/m${i}.ts` } });
      addEdge(g, 'pkg:app', id, 'contains');
      addEdge(g, id, 'domain:billing', 'tagged');
      addEdge(g, id, 'mod:external/lib', 'imports');  // 1 external import each, 0 internal
      const mod = makeModuleInfo(id, `/repo/packages/app/src/billing/m${i}.ts`);
      mod.packageName = 'app';
      mod.relativeFilePath = `src/billing/m${i}.ts`;
      modulesById.set(id, mod);
      moduleIds.push(id);
    }
    modulesById.set('mod:external/lib', makeModuleInfo('mod:external/lib', '/repo/packages/external/lib.ts'));

    const annotationsByModId: Record<string, unknown> = {
      [moduleIds[0]]: ann(moduleIds[0], {
        summary: 'Computes invoice eligibility for billing module 0.',
        invariants: ['Invoice must be in pending state', 'Customer must have an active subscription'],
      }),
      [moduleIds[1]]: ann(moduleIds[1], {
        summary: 'Billing invoice mailer.',
        invariants: ['Email is sent only after invoice creation'],
      }),
    };
    const annotations = {
      get: (id: string) => annotationsByModId[id] as unknown,
      set: jest.fn(),
      isFresh: () => true,
      getQueue: () => [],
      getStats: () => backlogCoverage(),
    } as unknown as RepovineState['annotations'];

    const ctx = makeCtx({ graph: g, modulesById, annotations, snapshot: makeSnapshot([...modulesById.values()]) });
    const result = await architectureResult(ctx, {
      categories: ['low-cohesion'],
      minConfidence: 0.3,
      annotationReasoning: 'on',
    }) as Record<string, unknown>;
    const findings = result.findings as Array<{ id: string; annotationContext?: Record<string, unknown> }>;
    const finding = findings.find(f => f.id === 'low-cohesion:domain:billing');

    expect(finding).toBeDefined();
    expect(finding!.annotationContext).toBeDefined();
    expect(finding!.annotationContext!.question).toBe('shared-invariant');
    expect(finding!.annotationContext!.relevantFields).toEqual(expect.arrayContaining(['invariants']));
    const nodes = finding!.annotationContext!.nodes as Array<{ id: string }>;
    expect(nodes.length).toBe(2);
    // Domain node must NOT be in annotationContext.nodes — only modules with annotations
    expect(nodes.every(n => n.id !== 'domain:billing')).toBe(true);
  });

  it('attaches shared-state-shape annotationContext to state-fragmentation findings when annotationReasoning is on', async () => {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'pkg:app', type: 'package', label: 'app', description: '' });
    addEdge(g, 'root', 'pkg:app', 'contains');

    const modulesById = new Map<string, ModuleInfo>();
    const addStateModule = (id: string, relPath: string, exportNames: string[]): void => {
      addNode(g, { id, type: 'module', label: id, description: '', data: { relativeFilePath: relPath } });
      addEdge(g, 'pkg:app', id, 'contains');
      const mod = makeModuleInfo(id, `/repo/packages/app/${relPath}`);
      mod.packageName = 'app';
      mod.relativeFilePath = relPath;
      mod.exports = exportNames.map((name, i) => ({
        name,
        kind: /^[A-Z]/.test(name) ? 'component' as const : 'function' as const,
        lineRange: { start: i + 1, end: i + 1 },
        isDefault: false,
      }));
      modulesById.set(id, mod);
    };
    addStateModule('mod:app/src/features/orders/store/order-store',
      'src/features/orders/store/order-store.ts', ['useOrderStore']);
    addStateModule('mod:app/src/features/orders/hooks/useOrderDraft',
      'src/features/orders/hooks/useOrderDraft.ts', ['useOrderDraft']);
    addStateModule('mod:app/src/features/orders/contexts/OrderContext',
      'src/features/orders/contexts/OrderContext.tsx', ['OrderProvider', 'useOrderContext']);

    const annotationsByModId: Record<string, unknown> = {
      'mod:app/src/features/orders/store/order-store': ann('mod:app/src/features/orders/store/order-store', {
        summary: 'Persisted order entity store.',
        stateShape: 'Order { id, items[], total, status }',
      }),
      'mod:app/src/features/orders/hooks/useOrderDraft': ann('mod:app/src/features/orders/hooks/useOrderDraft', {
        summary: 'In-memory draft state for order being assembled.',
        stateShape: 'OrderDraft { items[], total, dirty }',
      }),
    };
    const annotations = {
      get: (id: string) => annotationsByModId[id] as unknown,
      set: jest.fn(),
      isFresh: () => true,
      getQueue: () => [],
      getStats: () => backlogCoverage(),
    } as unknown as RepovineState['annotations'];

    const ctx = makeCtx({ graph: g, modulesById, annotations, snapshot: makeSnapshot([...modulesById.values()]) });
    const result = await architectureResult(ctx, {
      categories: ['state-fragmentation'],
      annotationReasoning: 'on',
    }) as Record<string, unknown>;
    const findings = result.findings as Array<{ id: string; annotationContext?: Record<string, unknown> }>;

    const finding = expectFinding(findings, 'state-fragmentation:feature:orders');
    expect(finding.annotationContext).toBeDefined();
    expect(finding.annotationContext!.question).toBe('shared-state-shape');
    expect(finding.annotationContext!.relevantFields).toEqual(expect.arrayContaining(['stateShape']));
    const nodes = finding.annotationContext!.nodes as Array<{ annotation: Record<string, unknown> }>;
    expect(nodes.length).toBe(2);
    expect(nodes.every(n => typeof n.annotation.stateShape === 'string')).toBe(true);
  });

  it('attaches real-side-effect annotationContext to client-business-logic findings', async () => {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'pkg:app', type: 'package', label: 'app', description: '' });
    addEdge(g, 'root', 'pkg:app', 'contains');
    const id = 'mod:app/src/features/orders/rules';
    addNode(g, { id, type: 'module', label: 'rules', description: '',
      data: { relativeFilePath: 'src/features/orders/rules.ts' } });
    addEdge(g, 'pkg:app', id, 'contains');
    const mod = makeModuleInfo(id, '/repo/packages/app/src/features/orders/rules.ts');
    mod.packageName = 'app';
    mod.relativeFilePath = 'src/features/orders/rules.ts';
    mod.exports = ['validateOrder', 'priceOrder', 'mapOrder', 'canSubmit', 'normalizeOrder'].map((name, i) => ({
      name, kind: 'function' as const, lineRange: { start: i + 1, end: i + 1 }, isDefault: false,
    }));
    mod.semanticHints = { envVars: ['ORDERS_API_URL'] };
    const modulesById = new Map<string, ModuleInfo>([[id, mod]]);

    const annotationsByModId: Record<string, unknown> = {
      [id]: ann(id, {
        summary: 'Order business rules invoked from the orders feature.',
        sideEffects: ['external: POST /orders', 'reads: ORDERS_API_URL env var'],
      }),
    };
    const annotations = {
      get: (modId: string) => annotationsByModId[modId] as unknown,
      set: jest.fn(), isFresh: () => true, getQueue: () => [], getStats: () => backlogCoverage(),
    } as unknown as RepovineState['annotations'];

    const ctx = makeCtx({ graph: g, modulesById, annotations, snapshot: makeSnapshot([mod]) });
    const result = await architectureResult(ctx, {
      scope: 'pkg:app',
      categories: ['client-business-logic'],
      annotationReasoning: 'on',
    }) as Record<string, unknown>;
    const findings = result.findings as Array<{ id: string; annotationContext?: Record<string, unknown> }>;
    const finding = findings.find(f => f.id === `client-business-logic:${id}`);
    expect(finding?.annotationContext?.question).toBe('real-side-effect');
    const nodes = finding!.annotationContext!.nodes as Array<{ annotation: Record<string, unknown> }>;
    expect(nodes.length).toBe(1);
    expect(Array.isArray(nodes[0].annotation.sideEffects)).toBe(true);
  });

  it('attaches intentional-internal annotationContext to boundary findings (target node only)', async () => {
    const { graph, modulesById } = (function buildBoundary() {
      const g = createEmptyGraph();
      addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
      addNode(g, { id: 'pkg:app', type: 'package', label: 'app', description: '' });
      addNode(g, { id: 'pkg:shared', type: 'package', label: 'shared', description: '' });
      addNode(g, { id: 'mod:app/src/page', type: 'module', label: 'src/page', description: '',
        data: { relativeFilePath: 'src/page.tsx' } });
      addNode(g, { id: 'mod:shared/src/index', type: 'module', label: 'src/index', description: '',
        data: { relativeFilePath: 'src/index.ts' } });
      addNode(g, { id: 'mod:shared/src/internal/rules', type: 'module', label: 'src/internal/rules', description: '',
        data: { relativeFilePath: 'src/internal/rules.ts' } });
      addEdge(g, 'root', 'pkg:app', 'contains');
      addEdge(g, 'root', 'pkg:shared', 'contains');
      addEdge(g, 'pkg:app', 'mod:app/src/page', 'contains');
      addEdge(g, 'pkg:shared', 'mod:shared/src/index', 'contains');
      addEdge(g, 'pkg:shared', 'mod:shared/src/internal/rules', 'contains');
      addEdge(g, 'mod:app/src/page', 'mod:shared/src/internal/rules', 'imports');

      const page = makeModuleInfo('mod:app/src/page', '/repo/packages/app/src/page.tsx');
      page.packageName = 'app';
      page.relativeFilePath = 'src/page.tsx';
      page.imports = [{ moduleSpecifier: 'shared/src/internal/rules', resolvedModuleId: 'mod:shared/src/internal/rules',
        importedNames: ['applyRules'], isTypeOnly: false, isExternal: false }];
      const index = makeModuleInfo('mod:shared/src/index', '/repo/packages/shared/src/index.ts');
      index.packageName = 'shared';
      index.relativeFilePath = 'src/index.ts';
      const rules = makeModuleInfo('mod:shared/src/internal/rules', '/repo/packages/shared/src/internal/rules.ts');
      rules.packageName = 'shared';
      rules.relativeFilePath = 'src/internal/rules.ts';
      return { graph: g, modulesById: new Map<string, ModuleInfo>([[page.id, page], [index.id, index], [rules.id, rules]]) };
    })();

    const targetId = 'mod:shared/src/internal/rules';
    const annotationsByModId: Record<string, unknown> = {
      [targetId]: ann(targetId, {
        summary: 'Internal rule application — not part of public package contract.',
        assumptions: ['Only called from shared/src/index re-exports'],
      }),
    };
    const annotations = {
      get: (id: string) => annotationsByModId[id] as unknown,
      set: jest.fn(), isFresh: () => true, getQueue: () => [], getStats: () => backlogCoverage(),
    } as unknown as RepovineState['annotations'];

    const ctx = makeCtx({ graph, modulesById, annotations, snapshot: makeSnapshot([...modulesById.values()]) });
    const result = await architectureResult(ctx, {
      scope: 'pkg:shared',
      categories: ['boundary'],
      annotationReasoning: 'on',
    }) as Record<string, unknown>;
    const findings = result.findings as Array<{ id: string; annotationContext?: Record<string, unknown> }>;
    const finding = findings.find(f => f.id === `boundary:${targetId}`);
    expect(finding?.annotationContext?.question).toBe('intentional-internal');
    const nodes = finding!.annotationContext!.nodes as Array<{ id: string }>;
    expect(nodes.length).toBe(1);
    expect(nodes[0].id).toBe(targetId);
  });

  it('attaches type-only-or-barrel annotationContext to god-module findings', async () => {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'pkg:app', type: 'package', label: 'app', description: '' });
    addEdge(g, 'root', 'pkg:app', 'contains');
    const id = 'mod:app/src/types';
    addNode(g, { id, type: 'module', label: 'types', description: '',
      data: { relativeFilePath: 'src/types.ts' } });
    addEdge(g, 'pkg:app', id, 'contains');
    const mod = makeModuleInfo(id, '/repo/packages/app/src/types.ts');
    mod.packageName = 'app';
    mod.relativeFilePath = 'src/types.ts';
    mod.exports = Array.from({ length: 20 }, (_, i) => ({
      name: `Type${i}`, kind: 'type' as const, lineRange: { start: i + 1, end: i + 1 }, isDefault: false,
    }));
    const modulesById = new Map<string, ModuleInfo>([[id, mod]]);

    const annotationsByModId: Record<string, unknown> = {
      [id]: ann(id, {
        summary: 'Pure type declarations for the app package; no runtime behavior.',
        patterns: ['type-only', 'no-runtime-imports'],
      }),
    };
    const annotations = {
      get: (modId: string) => annotationsByModId[modId] as unknown,
      set: jest.fn(), isFresh: () => true, getQueue: () => [], getStats: () => backlogCoverage(),
    } as unknown as RepovineState['annotations'];

    const ctx = makeCtx({ graph: g, modulesById, annotations, snapshot: makeSnapshot([mod]) });
    const result = await architectureResult(ctx, {
      scope: 'pkg:app',
      categories: ['god-module'],
      annotationReasoning: 'on',
    }) as Record<string, unknown>;
    const findings = result.findings as Array<{ id: string; annotationContext?: Record<string, unknown> }>;
    const finding = findings.find(f => f.id === `god-module:${id}`);
    expect(finding?.annotationContext?.question).toBe('type-only-or-barrel');
    const nodes = finding!.annotationContext!.nodes as Array<{ annotation: Record<string, unknown> }>;
    expect(Array.isArray(nodes[0].annotation.patterns)).toBe(true);
  });

  it('attaches shared-invariant annotationContext to duplicated-client-policy findings', async () => {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'pkg:app', type: 'package', label: 'app', description: '' });
    addEdge(g, 'root', 'pkg:app', 'contains');

    const modulesById = new Map<string, ModuleInfo>();
    const addPolicy = (id: string, relPath: string, exportName: string): void => {
      addNode(g, { id, type: 'module', label: id, description: '', data: { relativeFilePath: relPath } });
      addEdge(g, 'pkg:app', id, 'contains');
      const mod = makeModuleInfo(id, `/repo/packages/app/${relPath}`);
      mod.packageName = 'app';
      mod.relativeFilePath = relPath;
      mod.exports = [{ name: exportName, kind: 'function', lineRange: { start: 1, end: 1 }, isDefault: false }];
      modulesById.set(id, mod);
    };
    addPolicy('mod:app/src/features/orders/policy/access-policy',
      'src/features/orders/policy/access-policy.ts', 'canSubmitOrder');
    addPolicy('mod:app/src/features/profile/policy/access-policy',
      'src/features/profile/policy/access-policy.ts', 'canSubmitProfile');
    addPolicy('mod:app/src/features/billing/policy/access-policy',
      'src/features/billing/policy/access-policy.ts', 'canSubmitBilling');

    const annotationsByModId: Record<string, unknown> = {
      'mod:app/src/features/orders/policy/access-policy': ann('mod:app/src/features/orders/policy/access-policy', {
        summary: 'Order submission eligibility checks.',
        invariants: ['User must have verified email', 'Order must be in draft state'],
      }),
      'mod:app/src/features/profile/policy/access-policy': ann('mod:app/src/features/profile/policy/access-policy', {
        summary: 'Profile submission eligibility checks.',
        invariants: ['User must have verified email', 'Profile must be in draft state'],
      }),
    };
    const annotations = {
      get: (id: string) => annotationsByModId[id] as unknown,
      set: jest.fn(), isFresh: () => true, getQueue: () => [], getStats: () => backlogCoverage(),
    } as unknown as RepovineState['annotations'];

    const ctx = makeCtx({ graph: g, modulesById, annotations, snapshot: makeSnapshot([...modulesById.values()]) });
    const result = await architectureResult(ctx, {
      categories: ['duplicated-client-policy'],
      annotationReasoning: 'on',
    }) as Record<string, unknown>;
    const findings = result.findings as Array<{ id: string; annotationContext?: Record<string, unknown> }>;
    const finding = expectFinding(findings, 'duplicated-client-policy:permissions:submit');
    expect(finding.annotationContext?.question).toBe('shared-invariant');
    const nodes = finding.annotationContext!.nodes as Array<{ annotation: Record<string, unknown> }>;
    expect(nodes.length).toBe(2);
    expect(nodes.every(n => Array.isArray(n.annotation.invariants))).toBe(true);
  });

  it('attaches shared-prep-logic annotationContext to flow-convergence findings (prep stages only)', async () => {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'pkg:app', type: 'package', label: 'app', description: '' });
    addNode(g, { id: 'pkg:shared', type: 'package', label: 'shared', description: '' });
    addEdge(g, 'root', 'pkg:app', 'contains');
    addEdge(g, 'root', 'pkg:shared', 'contains');
    addNode(g, { id: 'mod:shared/src/internal/rules', type: 'module', label: 'rules', description: '',
      data: { relativeFilePath: 'src/internal/rules.ts' } });
    addEdge(g, 'pkg:shared', 'mod:shared/src/internal/rules', 'contains');
    const rulesInfo = makeModuleInfo('mod:shared/src/internal/rules', '/repo/packages/shared/src/internal/rules.ts');
    rulesInfo.packageName = 'shared';
    rulesInfo.relativeFilePath = 'src/internal/rules.ts';
    const modulesById = new Map<string, ModuleInfo>([[rulesInfo.id, rulesInfo]]);

    const addAppMod = (id: string, relPath: string, exportNames: string[]): ModuleInfo => {
      addNode(g, { id, type: 'module', label: id, description: '', data: { relativeFilePath: relPath } });
      addEdge(g, 'pkg:app', id, 'contains');
      const mod = makeModuleInfo(id, `/repo/packages/app/${relPath}`);
      mod.packageName = 'app';
      mod.relativeFilePath = relPath;
      mod.exports = exportNames.map((name, i) => ({
        name, kind: /^[A-Z]/.test(name) ? 'component' as const : 'function' as const,
        lineRange: { start: i + 1, end: i + 1 }, isDefault: false,
      }));
      modulesById.set(id, mod);
      return mod;
    };
    const checkoutPage = addAppMod('mod:app/src/pages/checkout', 'src/pages/checkout.tsx', ['CheckoutPage']);
    const profilePage = addAppMod('mod:app/src/pages/profile', 'src/pages/profile.tsx', ['ProfilePage']);
    const checkoutMapper = addAppMod('mod:app/src/features/checkout/mapping',
      'src/features/checkout/mapping.ts', ['mapCheckout']);
    const profileMapper = addAppMod('mod:app/src/features/profile/mapping',
      'src/features/profile/mapping.ts', ['mapProfile']);
    addEdge(g, checkoutPage.id, checkoutMapper.id, 'imports');
    addEdge(g, profilePage.id, profileMapper.id, 'imports');
    addEdge(g, checkoutMapper.id, 'mod:shared/src/internal/rules', 'imports');
    addEdge(g, profileMapper.id, 'mod:shared/src/internal/rules', 'imports');

    const annotationsByModId: Record<string, unknown> = {
      [checkoutMapper.id]: ann(checkoutMapper.id, {
        summary: 'Maps checkout form payload into shared domain rule input.',
        invariants: ['All monetary values are converted to cents before validation'],
      }),
      [profileMapper.id]: ann(profileMapper.id, {
        summary: 'Maps profile form payload into shared domain rule input.',
        invariants: ['All monetary values are converted to cents before validation'],
      }),
    };
    const annotations = {
      get: (id: string) => annotationsByModId[id] as unknown,
      set: jest.fn(), isFresh: () => true, getQueue: () => [], getStats: () => backlogCoverage(),
    } as unknown as RepovineState['annotations'];

    const ctx = makeCtx({ graph: g, modulesById, annotations, snapshot: makeSnapshot([...modulesById.values()]) });
    const result = await architectureResult(ctx, {
      categories: ['flow-convergence'],
      minConfidence: 0.5,
      annotationReasoning: 'on',
    }) as Record<string, unknown>;
    const findings = result.findings as Array<{ id: string; annotationContext?: Record<string, unknown> }>;
    const finding = expectFinding(findings, 'flow-convergence:mod:shared/src/internal/rules');
    expect(finding.annotationContext?.question).toBe('shared-prep-logic');
    const nodes = finding.annotationContext!.nodes as Array<{ id: string }>;
    // Prep stages only — must NOT include entrypoints or the shared target
    const nodeIds = nodes.map(n => n.id);
    expect(nodeIds).not.toContain(checkoutPage.id);
    expect(nodeIds).not.toContain(profilePage.id);
    expect(nodeIds).not.toContain('mod:shared/src/internal/rules');
    expect(nodeIds).toEqual(expect.arrayContaining([checkoutMapper.id, profileMapper.id]));
  });

  it('attaches workflow-orchestrator-or-layout annotationContext to prop-drilling orchestration findings', async () => {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'pkg:app', type: 'package', label: 'app', description: '' });
    addEdge(g, 'root', 'pkg:app', 'contains');

    const modulesById = new Map<string, ModuleInfo>();
    const addComponentModule = (id: string, relPath: string, exportName: string): ModuleInfo => {
      addNode(g, { id, type: 'module', label: relPath, description: '', data: { relativeFilePath: relPath } });
      addEdge(g, 'pkg:app', id, 'contains');
      const mod = makeModuleInfo(id, `/repo/packages/app/${relPath}`);
      mod.packageName = 'app';
      mod.relativeFilePath = relPath;
      mod.exports = [{ name: exportName, kind: 'component', lineRange: { start: 1, end: 80 }, isDefault: false }];
      modulesById.set(id, mod);
      return mod;
    };

    const parent = addComponentModule('mod:app/src/features/orders/OrdersController', 'src/features/orders/OrdersController.tsx', 'OrdersController');
    const form = addComponentModule('mod:app/src/features/orders/OrderForm', 'src/features/orders/OrderForm.tsx', 'OrderForm');
    const toolbar = addComponentModule('mod:app/src/features/orders/OrderToolbar', 'src/features/orders/OrderToolbar.tsx', 'OrderToolbar');
    const summary = addComponentModule('mod:app/src/features/orders/OrderSummary', 'src/features/orders/OrderSummary.tsx', 'OrderSummary');
    const submit = addComponentModule('mod:app/src/features/orders/SubmitButton', 'src/features/orders/SubmitButton.tsx', 'SubmitButton');

    parent.imports = [
      { moduleSpecifier: './OrderForm', resolvedModuleId: form.id, importedNames: ['OrderForm'], isTypeOnly: false, isExternal: false },
      { moduleSpecifier: './OrderToolbar', resolvedModuleId: toolbar.id, importedNames: ['OrderToolbar'], isTypeOnly: false, isExternal: false },
      { moduleSpecifier: './OrderSummary', resolvedModuleId: summary.id, importedNames: ['OrderSummary'], isTypeOnly: false, isExternal: false },
    ];
    form.imports = [{ moduleSpecifier: './SubmitButton', resolvedModuleId: submit.id, importedNames: ['SubmitButton'], isTypeOnly: false, isExternal: false }];
    for (const imp of parent.imports) addEdge(g, parent.id, imp.resolvedModuleId!, 'imports');
    addEdge(g, form.id, submit.id, 'imports');

    parent.semanticHints = {
      ui: {
        framework: 'react',
        components: [{
          framework: 'react',
          name: 'OrdersController',
          lineRange: { start: 1, end: 80 },
          props: [
            { name: 'order', kind: 'data', source: 'destructured-param' },
            { name: 'selectedOrder', kind: 'data', source: 'destructured-param' },
            { name: 'isLoading', kind: 'state-flag', source: 'destructured-param' },
            { name: 'errorMessage', kind: 'data', source: 'destructured-param' },
            { name: 'onSubmit', kind: 'callback', source: 'destructured-param' },
            { name: 'onCancel', kind: 'callback', source: 'destructured-param' },
            { name: 'onRetry', kind: 'callback', source: 'destructured-param' },
            { name: 'setDraftMode', kind: 'setter', source: 'destructured-param' },
          ],
          childComponents: [
            { componentName: 'OrderForm', passedProps: ['order', 'selectedOrder', 'onSubmit', 'setDraftMode'], passedCallbacks: ['onSubmit', 'setDraftMode'], forwardedProps: ['order', 'selectedOrder', 'onSubmit', 'setDraftMode'], spreadProps: [] },
            { componentName: 'OrderToolbar', passedProps: ['isLoading', 'onCancel', 'onRetry'], passedCallbacks: ['onCancel', 'onRetry'], forwardedProps: ['isLoading', 'onCancel', 'onRetry'], spreadProps: [] },
            { componentName: 'OrderSummary', passedProps: ['order', 'errorMessage'], passedCallbacks: [], forwardedProps: ['order', 'errorMessage'], spreadProps: [] },
          ],
          localSignals: { localState: 2, effects: 1, dataAccess: 1, navigation: 1, timers: 0, subscriptions: 0, serviceImports: 1, validationOrMapping: 1 },
        }],
      },
    };
    form.semanticHints = {
      ui: {
        framework: 'react',
        components: [{
          framework: 'react',
          name: 'OrderForm',
          props: [{ name: 'onSubmit', kind: 'callback', source: 'destructured-param' }],
          childComponents: [{ componentName: 'SubmitButton', passedProps: ['onSubmit'], passedCallbacks: ['onSubmit'], forwardedProps: ['onSubmit'], spreadProps: [] }],
          localSignals: { localState: 0, effects: 0, dataAccess: 0, navigation: 0, timers: 0, subscriptions: 0, serviceImports: 0, validationOrMapping: 0 },
        }],
      },
    };

    const annotationsByModId: Record<string, unknown> = {
      [parent.id]: ann(parent.id, {
        summary: 'Orders workflow controller coordinates submit state and child callbacks.',
        dataFlow: 'Order draft -> validation -> submit mutation -> navigation',
        sideEffects: ['external: POST /orders'],
        stateShape: 'OrderWorkflow { order, draft, selectedOrder, loading }',
      }),
    };
    const annotations = {
      get: (id: string) => annotationsByModId[id] as unknown,
      set: jest.fn(), isFresh: () => true, getQueue: () => [], getStats: () => backlogCoverage(),
    } as unknown as RepovineState['annotations'];

    const ctx = makeCtx({ graph: g, modulesById, annotations, snapshot: makeSnapshot([...modulesById.values()]) });
    const result = await architectureResult(ctx, {
      categories: ['prop-drilling-orchestration'],
      annotationReasoning: 'on',
    }) as Record<string, unknown>;
    const findings = result.findings as Array<{ id: string; annotationContext?: Record<string, unknown> }>;
    const finding = expectFinding(findings, `prop-drilling-orchestration:${parent.id}:OrdersController#1`);
    expect(finding.annotationContext?.question).toBe('workflow-orchestrator-or-layout');

    const detail = await architectureResult(ctx, {
      findingId: finding.id,
      annotationReasoning: 'on',
    }) as Record<string, unknown>;
    expect(detail.categoryDetail).toMatchObject({
      componentName: 'OrdersController',
      propCount: 8,
      callbackPropCount: 4,
    });
  });

  it('opportunity detail with annotationReasoning on attaches annotationContext and prepends an instruction nextCall', async () => {
    const { graph, modulesById, annotations } = buildDuplicateFixture({
      'mod:app/src/lib/logger': ann('mod:app/src/lib/logger', {
        summary: 'Structured HTTP request logger emitting JSON lines.',
        invariants: ['Each emit carries a request id'],
      }),
      'mod:app/src/utils/logger': ann('mod:app/src/utils/logger', {
        summary: 'Lambda cold-start telemetry logger.',
        invariants: ['Only fires once per cold start'],
      }),
    });
    const ctx = makeCtx({ graph, modulesById, annotations, snapshot: makeSnapshot([...modulesById.values()]) });

    const detail = await architectureResult(ctx, {
      findingId: 'duplicate-like:logger',
      annotationReasoning: 'on',
    }) as Record<string, unknown>;

    const finding = detail.finding as { annotationContext?: { question: string } };
    expect(finding.annotationContext).toBeDefined();
    expect(finding.annotationContext!.question).toBe('same-concept');
    const nextCalls = detail.nextCalls as Array<{ tool?: string; reason: string }>;
    expect(nextCalls[0].tool).toBeUndefined();
    expect(nextCalls[0].reason).toMatch(/READ finding\.annotationContext\.nodes/);
  });
});

// ── get_context_detail ──

describe('get_context_detail', () => {
  it('returns error for unknown node', async () => {
    const ctx = makeCtx();
    const result = await buildInspectNodeDetail(ctx, { nodeId: 'mod:test/nonexistent' });
    expect(result).toMatchObject({ error: expect.stringContaining('not found') });
  });

  it('returns node view for known module', async () => {
    const ctx = makeCtx();
    const result = await buildInspectNodeDetail(ctx, { nodeId: 'mod:test/alpha' }) as Record<string, unknown>;
    expect(result.id).toBe('mod:test/alpha');
    expect(result.label).toBe('alpha');
    expect(Array.isArray(result.drillDown)).toBe(true);
  });

  it('sets bodyError when includeBody and file read fails', async () => {
    jest.mocked(fsPromises.readFile).mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) as never);
    const ctx = makeCtx();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await buildInspectNodeDetail(ctx, { nodeId: 'mod:test/alpha', includeBody: true }) as Record<string, unknown>;
      expect(result.bodyError).toBeDefined();
      expect(typeof result.bodyError).toBe('string');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Could not read file'));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('returns body when includeBody and file read succeeds', async () => {
    jest.mocked(fsPromises.readFile).mockResolvedValueOnce('export function Foo() {}' as never);
    const ctx = makeCtx();
    const result = await buildInspectNodeDetail(ctx, { nodeId: 'mod:test/alpha', includeBody: true }) as Record<string, unknown>;
    expect(result.body).toBe('export function Foo() {}');
    expect(result.bodyError).toBeUndefined();
  });

  it('redacts obvious secret values from included source body', async () => {
    jest.mocked(fsPromises.readFile).mockResolvedValueOnce('const token = "sk_live_1234567890abcdef";' as never);
    const ctx = makeCtx();
    const result = await buildInspectNodeDetail(ctx, { nodeId: 'mod:test/alpha', includeBody: true }) as Record<string, unknown>;
    expect(result.body).toContain('[REDACTED_SECRET]');
    expect(result.body as string).not.toContain('sk_live_1234567890abcdef');
  });

  it('refuses to include source body outside the repo root', async () => {
    const ctx = makeCtx();
    ctx.getState().modulesById.get('mod:test/alpha')!.filePath = '/tmp/outside.ts';
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await buildInspectNodeDetail(ctx, { nodeId: 'mod:test/alpha', includeBody: true }) as Record<string, unknown>;
      expect(result.bodyError).toContain('outside repo root');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('outside repo root'));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('sets grepError when grepBody and file read fails', async () => {
    jest.mocked(fsPromises.readFile).mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }) as never);
    const ctx = makeCtx();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await buildInspectNodeDetail(ctx, { nodeId: 'mod:test/alpha', grepBody: 'Foo' }) as Record<string, unknown>;
      expect(result.grepError).toBeDefined();
      expect(typeof result.grepError).toBe('string');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('grepBody'));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each(['(a+)+$', '(a|a)+$'])('rejects potentially unsafe grep regex pattern %s', async pattern => {
    const ctx = makeCtx();
    const result = await buildInspectNodeDetail(ctx, { nodeId: 'mod:test/alpha', grepBody: pattern }) as Record<string, unknown>;
    expect(result.grepError).toContain('potentially unsafe');
  });

  it('returns grepMatches when grepBody and file read succeeds', async () => {
    jest.mocked(fsPromises.readFile).mockResolvedValueOnce('export function Foo() {}\nexport function Bar() {}' as never);
    const ctx = makeCtx();
    const result = await buildInspectNodeDetail(ctx, { nodeId: 'mod:test/alpha', grepBody: 'Foo' }) as Record<string, unknown>;
    expect(Array.isArray(result.grepMatches)).toBe(true);
    // One match, nothing bounded: matching lines carry isMatch, so the count needs no second field.
    expect((result.grepMatches as Array<{ isMatch: boolean }>).filter(m => m.isMatch)).toHaveLength(1);
    expect(result.truncation).toBeUndefined();
  });

  it('bounds long grep lines and reports that input was truncated', async () => {
    const longLine = `${'x'.repeat(100_000)}NEEDLE`;
    jest.mocked(fsPromises.readFile).mockResolvedValueOnce(longLine as never);
    const ctx = makeCtx();
    const result = await buildInspectNodeDetail(ctx, { nodeId: 'mod:test/alpha', grepBody: 'NEEDLE$' }) as Record<string, unknown>;
    expect(result.grepError).toBeUndefined();
    expect(result.grepMatches).toEqual([]);
    const grepInput = (result.truncation as Record<string, { shown: number; total: number; unit: string; more: { kind: string; hint: string } }>).grepInput;
    expect(grepInput).toMatchObject({ shown: 0, total: 1, unit: 'line', more: { kind: 'unavailable' } });
    // The hint carries the width that was actually applied; a wrong number there is a wrong answer.
    const width = Number(/tested only up to|longer than (\d+) chars/.exec(grepInput.more.hint)?.[1]);
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThan(longLine.length);
    expect(grepInput.more.hint).toContain(`1 line(s) longer than ${width} chars`);
  });

  it('sets bodyError for export-symbol when parent module not found in modulesById', async () => {
    const ctx = makeCtx();
    ctx.getState().modulesById.delete('mod:test/alpha');
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await buildInspectNodeDetail(ctx, { nodeId: 'export:test/alpha/Foo', includeBody: true }) as Record<string, unknown>;
      expect(result.bodyError).toBeDefined();
      expect(result.bodyError as string).toContain('Parent module not found');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Parent module not found'));
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('write_annotation safety', () => {
  it('rejects obvious secret values but allows env var names', async () => {
    const ctx = makeCtx();
    const rejected = await toolHandlers['write_annotation'](ctx, {
      nodeId: 'mod:test/alpha',
      annotation: { summary: 'Uses token: sk_live_1234567890abcdef' },
    });
    expect((rejected.result as Record<string, unknown>).error).toContain('secret values');
    expect(rejected.summary).toContain('Failed to save annotation');

    const rejectedAssignment = await toolHandlers['write_annotation'](ctx, {
      nodeId: 'mod:test/alpha',
      annotation: { assumptions: ['password=supersecret123'] },
    });
    expect((rejectedAssignment.result as Record<string, unknown>).error).toContain('secret values');
    expect((rejectedAssignment.result as Record<string, unknown>).fieldPaths).toEqual(['annotation.assumptions[0]']);

    const accepted = await toolHandlers['write_annotation'](ctx, {
      nodeId: 'mod:test/alpha',
      annotation: { summary: 'Reads STRIPE_SECRET_KEY by name only' },
    });
    expect((accepted.result as Record<string, unknown>).status).toBe('saved');
    const submitted = (accepted.result as Record<string, unknown>).submittedAnnotation as {
      chars: number;
      estimatedTokens: number;
      estimateMethod: string;
    };
    expect(submitted.chars).toBeGreaterThan(0);
    expect(submitted.estimatedTokens).toBe(Math.ceil(submitted.chars / 4));
    expect(submitted.estimateMethod).toBe('chars/4');
    expect(accepted.summary).toContain('Saved annotation');
    expect(accepted.summary).toContain('chars');
    expect(accepted.summary).toContain('tok est.');
    // Default write is queued (debounced), not yet durably flushed.
    expect((accepted.result as Record<string, unknown>).persistence).toMatchObject({ durable: false, persisted: false });
    expect(accepted.summary).toContain('disk write queued');

    // durable: true blocks on the flush and reports a durable commit.
    const durableWrite = await toolHandlers['write_annotation'](ctx, {
      nodeId: 'mod:test/alpha',
      annotation: { summary: 'Reads STRIPE_SECRET_KEY by name only (durable)' },
      durable: true,
    });
    expect((durableWrite.result as Record<string, unknown>).persistence).toMatchObject({ durable: true, persisted: true });
    expect(durableWrite.summary).toContain('persisted to disk');
    expect(ctx.getState().annotations.flushAsync).toHaveBeenCalled();
  });

  it('returns failure summaries for missing nodes and empty updates', async () => {
    const ctx = makeCtx();
    const missingNode = await toolHandlers['write_annotation'](ctx, {
      nodeId: 'mod:test/missing',
      annotation: { summary: 'Meaningful summary for a missing node.' },
    });
    expect(missingNode.confidence).toBe('low');
    expect(missingNode.summary).toContain('Failed to save annotation');
    expect(missingNode.summary).not.toContain('Saved annotation');
    expect((missingNode.result as Record<string, unknown>).error).toContain('Node not found');

    const emptyUpdate = await toolHandlers['write_annotation'](ctx, {
      nodeId: 'mod:test/alpha',
      annotation: {},
    });
    expect(emptyUpdate.summary).toContain('Failed to save annotation');
    expect((emptyUpdate.result as Record<string, unknown>).error).toContain('empty');

    const blankSummary = await toolHandlers['write_annotation'](ctx, {
      nodeId: 'mod:test/alpha',
      annotation: { summary: '   ' },
    });
    expect(blankSummary.summary).toContain('Failed to save annotation');
    expect((blankSummary.result as Record<string, unknown>).error).toContain('cannot be empty');
  });

  it('warns at write time when annotating a node not inspected in the context session', async () => {
    const ctx: McpToolRuntime = {
      ...makeCtx(),
      contextSessionId: 'sess-1',
      contextQualityStore: ({ getReport: () => ({ aggregates: { stableAnchors: [] } }) }) as unknown as McpToolRuntime['contextQualityStore'],
    };
    const res = await toolHandlers['write_annotation'](ctx, {
      nodeId: 'mod:test/alpha',
      annotation: { summary: 'A note written without inspecting the node first.' },
    });
    const warnings = ((res.result as Record<string, unknown>).warnings as string[] | undefined) ?? [];
    expect(warnings.join(' ')).toMatch(/Provenance:.*mod:test\/alpha.*not inspected/i);
  });

  it('does not warn at write time when the node or one of its export-symbols was inspected in the session', async () => {
    for (const stableAnchors of [['mod:test/alpha'], ['export:test/alpha/Foo']]) {
      const ctx: McpToolRuntime = {
        ...makeCtx(),
        contextSessionId: 'sess-1',
        contextQualityStore: ({ getReport: () => ({ aggregates: { stableAnchors } }) }) as unknown as McpToolRuntime['contextQualityStore'],
      };
      const res = await toolHandlers['write_annotation'](ctx, {
        nodeId: 'mod:test/alpha',
        annotation: { summary: 'A note written after inspecting the node.' },
      });
      const warnings = ((res.result as Record<string, unknown>).warnings as string[] | undefined) ?? [];
      expect(warnings.join(' ')).not.toMatch(/Provenance/);
    }
  });

  it('clears merge-review markers when summary is rewritten', async () => {
    const existing = {
      nodeId: 'mod:test/alpha',
      nodeType: 'module' as const,
      contentHash: 'abc123',
      pass: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      schemaVersion: 1,
      annotation: {
        summary: 'Draft winner summary text.',
        patterns: ['merge-review:summary'],
        assumptions: [
          '[merge-review:summary:ours] Draft winner summary text.',
          '[merge-review:summary:theirs] Other branch summary text.',
          'real assumption',
        ],
      },
    };
    const set = jest.fn();
    const ctx = makeCtx({
      annotations: {
        get: (id: string) => (id === 'mod:test/alpha' ? existing : undefined),
        set,
        isFresh: () => true,
        getQueue: () => [],
        getStats: () => backlogCoverage(),
      } as unknown as RepovineState['annotations'],
    });

    const result = await toolHandlers['write_annotation'](ctx, {
      nodeId: 'mod:test/alpha',
      annotation: { summary: 'Final merged summary written by agent.' },
    });

    expect((result.result as Record<string, unknown>).status).toBe('saved');
    expect(set).toHaveBeenCalledTimes(1);
    const saved = set.mock.calls[0][1] as { annotation: Record<string, unknown> };
    expect(saved.annotation.summary).toBe('Final merged summary written by agent.');
    expect(saved.annotation.patterns).toBeUndefined();
    expect(saved.annotation.assumptions).toEqual(['real assumption']);
  });

  it('refreshImportBaseline re-snapshots importBaseline without content changes', async () => {
    const existing = {
      nodeId: 'mod:test/alpha',
      nodeType: 'module' as const,
      contentHash: 'abc123',
      pass: 2,
      updatedAt: '2026-01-01T00:00:00.000Z',
      schemaVersion: 1,
      importBaseline: { 'mod:test/beta': 'old_hash' },
      annotation: {
        summary: 'Alpha imports beta and re-exports helpers.',
        sideEffects: [{ kind: 'pure' }],
      },
    };
    const set = jest.fn();
    const ctx = makeCtx({
      annotations: {
        get: (id: string) => (id === 'mod:test/alpha' ? existing : undefined),
        set,
        isFresh: () => true,
        getQueue: () => [],
        getStats: () => backlogCoverage(),
      } as unknown as RepovineState['annotations'],
    });

    const result = await toolHandlers['write_annotation'](ctx, {
      nodeId: 'mod:test/alpha',
      refreshImportBaseline: true,
    });

    expect((result.result as Record<string, unknown>).status).toBe('saved');
    expect((result.result as Record<string, unknown>).importBaselineRefreshed).toBe(true);
    expect(set).toHaveBeenCalledTimes(1);
    const saved = set.mock.calls[0][1] as { importBaseline?: Record<string, string>; pass: number };
    expect(saved.pass).toBe(3);
  });

  it('keeps merge-review markers when updating an unrelated field', async () => {
    const existing = {
      nodeId: 'mod:test/alpha',
      nodeType: 'module' as const,
      contentHash: 'abc123',
      pass: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      schemaVersion: 1,
      annotation: {
        summary: 'Draft winner summary text.',
        patterns: ['merge-review:summary'],
        assumptions: [
          '[merge-review:summary:ours] Draft winner summary text.',
          '[merge-review:summary:theirs] Other branch summary text.',
        ],
      },
    };
    const set = jest.fn();
    const ctx = makeCtx({
      annotations: {
        get: (id: string) => (id === 'mod:test/alpha' ? existing : undefined),
        set,
        isFresh: () => true,
        getQueue: () => [],
        getStats: () => backlogCoverage(),
      } as unknown as RepovineState['annotations'],
    });

    await toolHandlers['write_annotation'](ctx, {
      nodeId: 'mod:test/alpha',
      annotation: { risks: ['New risk after merge'] },
    });

    const saved = set.mock.calls[0][1] as { annotation: Record<string, unknown> };
    expect(saved.annotation.patterns).toEqual(['merge-review:summary']);
    expect(saved.annotation.risks).toEqual(['New risk after merge']);
  });
});

// ── get_dependency_impact ──

describe('get_dependency_impact', () => {
  it('returns error for unknown node', () => {
    const ctx = makeCtx();
    const result = analyzeImpact(ctx, { nodeId: 'mod:test/nonexistent' });
    expect(result).toMatchObject({ error: expect.stringContaining('not found') });
  });

  it('returns downstream for mod:test/alpha (imported by beta)', () => {
    const ctx = makeCtx();
    const result = analyzeImpact(ctx, { nodeId: 'mod:test/alpha' }) as Record<string, unknown>;
    const downstream = result.downstream as Array<{ id: string }>;
    expect(downstream.some(d => d.id === 'mod:test/beta')).toBe(true);
  });

  it('returns uses[] in downstream entry', () => {
    const ctx = makeCtx();
    const result = analyzeImpact(ctx, { nodeId: 'mod:test/alpha' }) as Record<string, unknown>;
    const downstream = result.downstream as Array<{ id: string; uses?: string[] }>;
    const betaEntry = downstream.find(d => d.id === 'mod:test/beta');
    expect(betaEntry?.uses).toContain('Foo');
  });

  it('filters downstream by exportName', () => {
    const ctx = makeCtx();
    const result = analyzeImpact(ctx, { nodeId: 'mod:test/alpha', exportName: 'NonExistent' }) as Record<string, unknown>;
    const downstream = result.downstream as unknown[];
    expect(downstream.length).toBe(0);
  });
});

// ── analyze_dependencies output bounding (anti-flood) ──

describe('analyze_dependencies output bounding', () => {
  function nameMatchedImpactCtx(options: {
    nameMatchedCount?: number;
    includeResolvedCaller?: boolean;
  } = {}): McpToolRuntime {
    const nameMatchedCount = options.nameMatchedCount ?? 1;
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'pkg:app', type: 'package', label: 'app', description: '' });
    addNode(g, { id: 'mod:app/validator', type: 'module', label: 'validator.ts', description: '',
      data: { filePath: '/repo/src/validator.ts', relativeFilePath: 'src/validator.ts' } });
    addNode(g, { id: 'export:app/validator/validateMonitor', type: 'export-symbol', label: 'validateMonitor', description: '',
      data: { signature: 'function validateMonitor(): void', symbolKind: 'function', lineRange: { start: 1, end: 3 } } });
    addEdge(g, 'root', 'pkg:app', 'contains');
    addEdge(g, 'pkg:app', 'mod:app/validator', 'contains');
    addEdge(g, 'mod:app/validator', 'export:app/validator/validateMonitor', 'contains');

    const validator = makeModuleInfo('mod:app/validator', '/repo/src/validator.ts');
    validator.packageName = 'app';
    validator.relativeFilePath = 'src/validator.ts';
    validator.exports = [{
      name: 'validateMonitor',
      kind: 'function',
      lineRange: { start: 1, end: 3 },
      isDefault: false,
      calls: [],
    }];
    const modulesById = new Map<string, ModuleInfo>([
      ['mod:app/validator', validator],
    ]);

    if (options.includeResolvedCaller) {
      addNode(g, { id: 'mod:app/resolved-caller', type: 'module', label: 'resolved-caller.ts', description: '',
        data: { filePath: '/repo/src/resolved-caller.ts', relativeFilePath: 'src/resolved-caller.ts' } });
      addEdge(g, 'pkg:app', 'mod:app/resolved-caller', 'contains');
      addEdge(g, 'mod:app/resolved-caller', 'mod:app/validator', 'imports');
      const resolved = makeModuleInfo('mod:app/resolved-caller', '/repo/src/resolved-caller.ts');
      resolved.packageName = 'app';
      resolved.relativeFilePath = 'src/resolved-caller.ts';
      resolved.imports = [{
        moduleSpecifier: './validator',
        resolvedModuleId: 'mod:app/validator',
        importedNames: ['validateMonitor'],
        isTypeOnly: false,
        isExternal: false,
      }];
      modulesById.set('mod:app/resolved-caller', resolved);
    }

    for (let i = 0; i < nameMatchedCount; i++) {
      const id = `mod:app/formatter-${i}`;
      addNode(g, { id, type: 'module', label: `formatter-${i}.ts`, description: '',
        data: { filePath: `/repo/src/formatter-${i}.ts`, relativeFilePath: `src/formatter-${i}.ts` } });
      addEdge(g, 'pkg:app', id, 'contains');
      const formatter = makeModuleInfo(id, `/repo/src/formatter-${i}.ts`);
      formatter.packageName = 'app';
      formatter.relativeFilePath = `src/formatter-${i}.ts`;
      formatter.exports = [{
        name: `ProjectMonitorFormatter${i}`,
        kind: 'function',
        lineRange: { start: 1, end: 4 },
        isDefault: false,
        calls: ['validateMonitor'],
      }];
      modulesById.set(id, formatter);
    }

    return makeCtx({ graph: g, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });
  }

  function highFanCtx(importerCount: number): McpToolRuntime {
    const { graph, modulesById } = buildFixtureGraph();
    addNode(graph, { id: 'mod:test/hub', type: 'module', label: 'hub', description: '',
      data: { filePath: '/repo/hub.ts', relativeFilePath: 'hub.ts' } });
    addEdge(graph, 'pkg:test', 'mod:test/hub', 'contains');
    modulesById.set('mod:test/hub', makeModuleInfo('mod:test/hub', '/repo/hub.ts'));
    for (let i = 0; i < importerCount; i++) {
      const id = `mod:test/importer-${i}`;
      addNode(graph, { id, type: 'module', label: `importer-${i}`, description: '',
        data: { filePath: `/repo/importer-${i}.ts`, relativeFilePath: `importer-${i}.ts` } });
      addEdge(graph, 'pkg:test', id, 'contains');
      addEdge(graph, id, 'mod:test/hub', 'imports');
      const info = makeModuleInfo(id, `/repo/importer-${i}.ts`);
      info.imports = [{ moduleSpecifier: './hub', resolvedModuleId: 'mod:test/hub', importedNames: ['hub'], isTypeOnly: false, isExternal: false }];
      modulesById.set(id, info);
    }
    return makeCtx({ graph, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });
  }

  function manyImplementersCtx(count: number): McpToolRuntime {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'pkg:test', type: 'package', label: 'test', description: '' });
    addNode(g, { id: 'mod:test/contracts', type: 'module', label: 'contracts', description: '',
      data: { filePath: '/repo/contracts.ts', relativeFilePath: 'contracts.ts' } });
    addNode(g, { id: 'export:test/contracts/IThing', type: 'export-symbol', label: 'IThing', description: '',
      data: { signature: 'interface IThing', symbolKind: 'interface', lineRange: { start: 1, end: 3 } } });
    addEdge(g, 'root', 'pkg:test', 'contains');
    addEdge(g, 'pkg:test', 'mod:test/contracts', 'contains');
    addEdge(g, 'mod:test/contracts', 'export:test/contracts/IThing', 'contains');
    for (let i = 0; i < count; i++) {
      const modId = `mod:test/impl-${i}`;
      const clsId = `export:test/impl-${i}/Impl${i}`;
      addNode(g, { id: modId, type: 'module', label: `impl-${i}`, description: '',
        data: { filePath: `/repo/impl-${i}.ts`, relativeFilePath: `impl-${i}.ts` } });
      addNode(g, { id: clsId, type: 'export-symbol', label: `Impl${i}`, description: '',
        data: { signature: `class Impl${i} implements IThing`, symbolKind: 'class', lineRange: { start: 1, end: 5 } } });
      addEdge(g, 'pkg:test', modId, 'contains');
      addEdge(g, modId, clsId, 'contains');
      addEdge(g, clsId, 'export:test/contracts/IThing', 'implements');
    }
    return makeCtx({ graph: g, modulesById: new Map(), snapshot: makeSnapshot([]) });
  }

  function crossPackageCtx(): McpToolRuntime {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    for (const p of ['a', 'b', 'c']) {
      addNode(g, { id: `pkg:${p}`, type: 'package', label: p, description: '', data: { path: `packages/${p}` } });
      addEdge(g, 'root', `pkg:${p}`, 'contains');
    }
    const mk = (pkg: string, name: string): string => {
      const id = `mod:${pkg}/src/${name}`;
      addNode(g, { id, type: 'module', label: `src/${name}`, description: '',
        data: { filePath: `/repo/packages/${pkg}/src/${name}.ts`, relativeFilePath: `src/${name}.ts` } });
      addEdge(g, `pkg:${pkg}`, id, 'contains');
      return id;
    };
    const consumer = mk('a', 'consumer');
    const libB = mk('b', 'libB');
    const libC = mk('c', 'libC');
    addEdge(g, consumer, libB, 'imports');
    addEdge(g, consumer, libC, 'imports');
    const consumerInfo = makeModuleInfo(consumer, '/repo/packages/a/src/consumer.ts');
    consumerInfo.packageName = 'a';
    consumerInfo.imports = [
      { moduleSpecifier: 'b/libB', resolvedModuleId: libB, importedNames: ['fnB'], isTypeOnly: false, isExternal: false },
      { moduleSpecifier: 'c/libC', resolvedModuleId: libC, importedNames: ['fnC'], isTypeOnly: false, isExternal: false },
    ];
    const modulesById = new Map<string, ModuleInfo>([
      [consumer, consumerInfo],
      [libB, makeModuleInfo(libB, '/repo/packages/b/src/libB.ts')],
      [libC, makeModuleInfo(libC, '/repo/packages/c/src/libC.ts')],
    ]);
    return makeCtx({ graph: g, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });
  }

  it('caps impact downstream at the build site with total/nextOffset', () => {
    const result = analyzeImpact(highFanCtx(60), { nodeId: 'mod:test/hub', limit: 20, offset: 0 }) as Record<string, unknown>;
    const bound = (result.truncation as Record<string, Record<string, unknown>>).downstream;
    expect((result.downstream as unknown[]).length).toBe(20);
    expect(bound).toMatchObject({ shown: 20, total: 60, more: { kind: 'page', nextOffset: 20 } });
  });

  it('pages the next slice with offset', () => {
    const result = analyzeImpact(highFanCtx(60), { nodeId: 'mod:test/hub', limit: 20, offset: 20 }) as Record<string, unknown>;
    const bound = (result.truncation as Record<string, Record<string, unknown>>).downstream;
    expect((result.downstream as unknown[]).length).toBe(20);
    expect(bound).toMatchObject({ shown: 20, more: { kind: 'page', nextOffset: 40 } });
  });

  it('caps impact via the analyze_dependencies handler with total/nextOffset and a consumable size (59 KB regression)', async () => {
    const result = await toolHandlers['analyze_dependencies'](highFanCtx(400), {
      scope: 'mod:test/hub',
      mode: 'impact',
    });
    const out = toCallToolMcpResult(result, CONFIG_DEFAULTS.mcp.response);
    expect(out.content[0].text.length).toBeLessThanOrEqual(CONFIG_DEFAULTS.mcp.response.maxChars);
    const analysis = (result.result as { analysis: Record<string, unknown> }).analysis;
    const bound = (analysis.truncation as Record<string, Record<string, unknown>>).downstream;
    expect((analysis.downstream as unknown[]).length).toBe(20); // default page
    expect(bound).toMatchObject({ shown: 20, total: 400, more: { kind: 'page', nextOffset: 20 } });
  });

  it('adds a soft gap and validation navigation for name-matched unresolved impact callers', async () => {
    const result = await toolHandlers['analyze_dependencies'](nameMatchedImpactCtx(), {
      scope: 'export:app/validator/validateMonitor',
      mode: 'impact',
    });

    expectEnvelope(result);
    expect(result.confidence).toBe('high');
    const analysis = (result.result as { analysis: Record<string, unknown> }).analysis;
    expect(analysis.nameMatchedCallers).toBe(1);
    expect(analysis.downstream).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'mod:app/formatter-0', provenance: { basis: 'inferred', method: 'call-name-index' } }),
    ]));
    const gaps = result.gaps as string[];
    expect(gaps.filter(g => g.includes('name-matched unresolved caller'))).toHaveLength(1);
    expect(gaps).toEqual(expect.arrayContaining([
      expect.stringContaining('inspect or explicitly justify'),
    ]));
    const validate = (result.navigation as { validate: Array<{ tool: string; args: Record<string, unknown>; reason: string }> }).validate;
    expect(validate).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'inspect_node', args: expect.objectContaining({ scope: 'export:app/validator/validateMonitor' }) }),
      expect.objectContaining({ tool: 'inspect_node', args: expect.objectContaining({ nodeId: 'mod:app/formatter-0' }) }),
    ]));
  });

  it('does not add the unresolved caller gap when impact has no name-matched callers', async () => {
    const result = await toolHandlers['analyze_dependencies'](nameMatchedImpactCtx({
      nameMatchedCount: 0,
      includeResolvedCaller: true,
    }), {
      scope: 'export:app/validator/validateMonitor',
      mode: 'impact',
    });

    expectEnvelope(result);
    const gaps = result.gaps as string[];
    expect(gaps.some(g => g.includes('name-matched unresolved caller'))).toBe(false);
    const validate = (result.navigation as { validate: Array<{ args: Record<string, unknown> }> }).validate;
    expect(validate.some(item => item.args.nodeId === 'mod:app/formatter-0')).toBe(false);
  });

  it('keeps hot-name unresolved caller guidance bounded', async () => {
    const result = await toolHandlers['analyze_dependencies'](nameMatchedImpactCtx({
      nameMatchedCount: 8,
    }), {
      scope: 'export:app/validator/validateMonitor',
      mode: 'impact',
      limit: 8,
    });

    expectEnvelope(result);
    const gaps = result.gaps as string[];
    expect(gaps.filter(g => g.includes('name-matched unresolved caller'))).toHaveLength(1);
    const validate = (result.navigation as { validate: Array<{ args: Record<string, unknown> }> }).validate;
    const candidateValidation = validate.filter(item => typeof item.args.nodeId === 'string');
    expect(validate.length).toBeLessThanOrEqual(4);
    expect(candidateValidation.length).toBeLessThanOrEqual(3);
    const out = toCallToolMcpResult(result, CONFIG_DEFAULTS.mcp.response);
    expect(out.content[0].text.length).toBeLessThanOrEqual(CONFIG_DEFAULTS.mcp.response.maxChars);
  });

  it('tells agents to page or narrow when name-matched callers are off the current downstream page', async () => {
    const result = await toolHandlers['analyze_dependencies'](nameMatchedImpactCtx({
      nameMatchedCount: 1,
      includeResolvedCaller: true,
    }), {
      scope: 'export:app/validator/validateMonitor',
      mode: 'impact',
      limit: 1,
    });

    expectEnvelope(result);
    const analysis = (result.result as { analysis: Record<string, unknown> }).analysis;
    expect(analysis.nameMatchedCallers).toBe(1);
    expect(analysis.downstream).toEqual([
      expect.objectContaining({ id: 'mod:app/resolved-caller' }),
    ]);
    const gaps = result.gaps as string[];
    expect(gaps).toEqual(expect.arrayContaining([
      expect.stringContaining('not shown on this downstream page'),
    ]));
    expect(gaps).toEqual(expect.arrayContaining([
      expect.stringContaining('limit/offset'),
    ]));
    const validate = (result.navigation as { validate: Array<{ args: Record<string, unknown> }> }).validate;
    expect(validate.some(item => item.args.nodeId === 'mod:app/formatter-0')).toBe(false);
  });

  it('caps interface-implementations via the handler with total/nextOffset', async () => {
    const result = await toolHandlers['analyze_dependencies'](manyImplementersCtx(3), {
      mode: 'interface-implementations',
      interfaceName: 'IThing',
      limit: 2,
    });
    const analysis = (result.result as { analysis: Record<string, unknown> }).analysis;
    expect(analysis.count).toBe(3); // full count is preserved
    expect((analysis.implementations as unknown[]).length).toBe(2);
    const bound = (analysis.truncation as Record<string, Record<string, unknown>>).implementations;
    expect(bound).toMatchObject({ shown: 2, total: 3, more: { kind: 'page', nextOffset: 2 } });
  });

  it('caps package-boundaries edges via the handler with total/nextOffset', async () => {
    const result = await toolHandlers['analyze_dependencies'](crossPackageCtx(), {
      scope: 'all',
      mode: 'package-boundaries',
      limit: 1,
    });
    expectEnvelope(result);
    const analysis = (result.result as { analysis: Record<string, unknown> }).analysis;
    expect((analysis.edges as unknown[]).length).toBe(1);
    const bound = (analysis.truncation as Record<string, Record<string, unknown>>).edges;
    expect(bound).toMatchObject({ shown: 1, total: 2, more: { kind: 'page', nextOffset: 1 } });
    // A truncated first page must not be mistaken for "no cross-package edges".
    expect(result.gaps).not.toEqual(expect.arrayContaining([expect.stringContaining('No cross-package import edges')]));
  });
});

// ── analyze_architecture report-mode node bounding (anti-flood) ──

describe('analyze_architecture report node bounding', () => {
  // N cross-package importers of an internal module (whose package has an index sibling) make the
  // boundary detector emit a finding with N+1 nodes (detectors.ts: `nodes: [target, ...importers]`).
  function manyImportersCtx(importerCount: number): McpToolRuntime {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'pkg:app', type: 'package', label: 'app', description: '' });
    addNode(g, { id: 'pkg:shared', type: 'package', label: 'shared', description: '' });
    addNode(g, { id: 'mod:shared/src/index', type: 'module', label: 'src/index', description: '', data: { relativeFilePath: 'src/index.ts' } });
    addNode(g, { id: 'mod:shared/src/internal/rules', type: 'module', label: 'src/internal/rules', description: '', data: { relativeFilePath: 'src/internal/rules.ts' } });
    addEdge(g, 'root', 'pkg:app', 'contains');
    addEdge(g, 'root', 'pkg:shared', 'contains');
    addEdge(g, 'pkg:shared', 'mod:shared/src/index', 'contains');
    addEdge(g, 'pkg:shared', 'mod:shared/src/internal/rules', 'contains');
    const modulesById = new Map<string, ModuleInfo>();
    const rules = makeModuleInfo('mod:shared/src/internal/rules', '/repo/packages/shared/src/internal/rules.ts');
    rules.packageName = 'shared';
    rules.relativeFilePath = 'src/internal/rules.ts';
    modulesById.set(rules.id, rules);
    const index = makeModuleInfo('mod:shared/src/index', '/repo/packages/shared/src/index.ts');
    index.packageName = 'shared';
    index.relativeFilePath = 'src/index.ts';
    modulesById.set(index.id, index);
    for (let i = 0; i < importerCount; i++) {
      const id = `mod:app/src/consumer-${i}`;
      addNode(g, { id, type: 'module', label: `src/consumer-${i}`, description: '', data: { relativeFilePath: `src/consumer-${i}.ts` } });
      addEdge(g, 'pkg:app', id, 'contains');
      addEdge(g, id, 'mod:shared/src/internal/rules', 'imports');
      const info = makeModuleInfo(id, `/repo/packages/app/src/consumer-${i}.ts`);
      info.packageName = 'app';
      info.relativeFilePath = `src/consumer-${i}.ts`;
      info.imports = [{ moduleSpecifier: 'shared/src/internal/rules', resolvedModuleId: 'mod:shared/src/internal/rules', importedNames: ['applyRules'], isTypeOnly: false, isExternal: false }];
      modulesById.set(id, info);
    }
    return makeCtx({ graph: g, modulesById, snapshot: makeSnapshot([...modulesById.values()]) });
  }

  const BOUNDARY_ID = 'boundary:mod:shared/src/internal/rules';

  it('caps a report finding`s nodes to a preview and points at detail mode', async () => {
    const result = await architectureResult(manyImportersCtx(15), { scope: 'all', categories: ['boundary'] });
    const findings = result.findings as Array<Record<string, unknown>>;
    const boundary = findings.find(f => f.id === BOUNDARY_ID);
    expect(boundary).toBeDefined();
    expect((boundary!.nodes as unknown[]).length).toBe(10); // preview, not 16
    expect((boundary!.truncation as Record<string, unknown>).nodes).toMatchObject({
      shown: 10,
      total: 16,
      more: { kind: 'arg', arg: 'detailFindingId', value: BOUNDARY_ID },
    });
  });

  it('leaves a small finding`s nodes untouched (no bound)', async () => {
    const result = await architectureResult(manyImportersCtx(3), { scope: 'all', categories: ['boundary'] });
    const findings = result.findings as Array<Record<string, unknown>>;
    const boundary = findings.find(f => f.id === BOUNDARY_ID);
    expect(boundary).toBeDefined();
    expect((boundary!.nodes as unknown[]).length).toBe(4); // target + 3 importers, below preview
    expect(boundary!.truncation).toBeUndefined();
  });

  it('detail mode returns the full node set (maxNodes-bounded), unaffected by the report preview', async () => {
    const detail = await architectureResult(manyImportersCtx(15), { detailFindingId: BOUNDARY_ID });
    expect((detail.affectedNodes as unknown[]).length).toBe(16); // full set, under maxNodes default 30
    expect(detail.truncatedAffectedNodes).toBe(0);
    expect(((detail.finding as { nodes: unknown[] }).nodes).length).toBe(16); // detail keeps full nodes
  });
});

// ── search_repo_context ──

describe('search_repo_context', () => {
  it('returns results matching query tokens', () => {
    const ctx = makeCtx();
    const state = ctx.getState();
    const tokenize = (s: string) => s.toLowerCase().replace(/[/\-_.:]/g, ' ').split(/\s+/).filter(Boolean);
    for (const node of state.graph.nodes.values()) {
      for (const t of tokenize(node.id + ' ' + node.label)) {
        let s = state.searchIndex.tokens.get(t);
        if (!s) { s = new Set(); state.searchIndex.tokens.set(t, s); }
        s.add(node.id);
      }
    }

    const result = searchGraph(ctx, { query: 'alpha' }) as Record<string, unknown>;
    const grouped = result.results as Record<string, Array<{ id: string }>>;
    const allResults = Object.values(grouped).flat();
    expect(allResults.some(r => r.id === 'mod:test/alpha')).toBe(true);
  });

  it('returns empty results for unmatched query', () => {
    const ctx = makeCtx();
    const result = searchGraph(ctx, { query: 'zzzznotfound' }) as Record<string, unknown>;
    expect(result.totalResults).toBe(0);
  });

  it('signals truncated + hint when grouped results exceed per-group cap', () => {
    const ctx = makeCtx();
    const state = ctx.getState();
    // Inject 50 domain nodes matching "thing"
    for (let i = 0; i < 50; i++) {
      const id = `domain:thing${i}`;
      addNode(state.graph, { id, type: 'domain', label: `thing${i}`, description: '' });
      let s = state.searchIndex.tokens.get(`thing${i}`);
      if (!s) { s = new Set(); state.searchIndex.tokens.set(`thing${i}`, s); }
      s.add(id);
      let s2 = state.searchIndex.tokens.get('thing');
      if (!s2) { s2 = new Set(); state.searchIndex.tokens.set('thing', s2); }
      s2.add(id);
    }
    const result = searchGraph(ctx, { query: 'thing', maxResults: 10 }) as Record<string, unknown>;
    const bound = (result.truncation as Record<string, Record<string, unknown>>).domains;
    expect(bound).toMatchObject({ total: 50, more: { kind: 'page', arg: 'offset' } });
    expect((bound.more as { hint: string }).hint).toContain('types:["domain"]');
    expect((result.groupTotals as Record<string, number>).domains).toBe(50);
  });

  it('groups domain-filter results by tier and returns totalResults', () => {
    const ctx = makeCtx();
    const state = ctx.getState();
    addNode(state.graph, { id: 'domain:auth', type: 'domain', label: 'auth', description: '', data: { tier: 'business' } });
    addNode(state.graph, { id: 'domain:utils', type: 'domain', label: 'utils', description: '', data: { tier: 'technical' } });
    for (const t of ['auth', 'utils']) {
      let s = state.searchIndex.tokens.get(t);
      if (!s) { s = new Set(); state.searchIndex.tokens.set(t, s); }
      s.add(`domain:${t}`);
    }
    state.searchIndex.tokens.set('domain', new Set(['domain:auth', 'domain:utils']));

    const result = searchGraph(ctx, { query: 'domain', nodeTypes: ['domain'] }) as Record<string, unknown>;
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.totalResults).toBe(2);
    expect(result.returned).toBe(2);
    const byTier = result.byTier as Record<string, Array<{ id: string }>>;
    expect(byTier.business.map(r => r.id)).toEqual(['domain:auth']);
    expect(byTier.technical.map(r => r.id)).toEqual(['domain:utils']);
  });
});

describe('get_domain_modules_slice — primary vs secondary tags', () => {
  function buildSliceCtx(): McpToolRuntime {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'pkg:test', type: 'package', label: 'test', description: '' });
    addNode(g, { id: 'mod:test/auth-mod', type: 'module', label: 'auth-mod', description: '',
      data: { filePath: '/repo/auth-mod.ts', relativeFilePath: 'auth-mod.ts' } });
    addNode(g, { id: 'mod:test/utils-mod', type: 'module', label: 'utils-mod', description: '',
      data: { filePath: '/repo/utils-mod.ts', relativeFilePath: 'utils-mod.ts' } });
    addNode(g, { id: 'domain:auth', type: 'domain', label: 'auth', description: '' });
    addEdge(g, 'root', 'pkg:test', 'contains');
    addEdge(g, 'pkg:test', 'mod:test/auth-mod', 'contains');
    addEdge(g, 'pkg:test', 'mod:test/utils-mod', 'contains');
    // auth-mod tagged by path (primary), utils-mod tagged by regex pattern (secondary)
    addEdge(g, 'mod:test/auth-mod', 'domain:auth', 'tagged', { tagSource: 'path' });
    addEdge(g, 'mod:test/utils-mod', 'domain:auth', 'tagged', { tagSource: 'pattern' });

    const annotations = {
      get: () => undefined, set: jest.fn(), isFresh: () => true, getQueue: () => [], getStats: () => backlogCoverage(),
    } as unknown as RepovineState['annotations'];
    const state: RepovineState = {
      graph: g,
      snapshot: { repoRoot: '/repo', timestamp: '2024-01-01', packages: [], modules: [] },
      modulesById: new Map(),
      searchIndex: { tokens: new Map(), annotationText: new Map() },
      semanticIndex: null,
      semanticSearchRefresh: { status: 'disabled' },
      annotations,
      domainsConfig: null,
      domainsSuggestions: defaultDomainsSuggestions(),
      refactoringThresholds: defaultRefactoringThresholds(),
      builtAt: '2024-01-01',
    };
    return wrapTestRuntime(state);
  }

  it('excludes pattern-only matches by default and says which argument returns them', () => {
    const ctx = buildSliceCtx();
    const result = buildDomainModulesSlice(ctx, { domainTag: 'auth' }) as Record<string, unknown>;
    expect(result.taggedModules).toBe(1);
    const sec = (result.truncation as Record<string, Record<string, unknown>>).secondaryMatches;
    expect(sec).toMatchObject({
      shown: 0,
      total: 1,
      more: { kind: 'arg', arg: 'includeSecondaryMatches', value: true },
    });
    // utils-mod must not appear in byPackage
    const byPkg = result.byPackage as Record<string, Array<{ id: string }>>;
    const allIds = Object.values(byPkg).flat().map(m => m.id);
    expect(allIds).toContain('mod:test/auth-mod');
    expect(allIds).not.toContain('mod:test/utils-mod');
  });

  it('includes pattern matches when includeSecondaryMatches is true', () => {
    const ctx = buildSliceCtx();
    const result = buildDomainModulesSlice(ctx, { domainTag: 'auth', includeSecondaryMatches: true }) as Record<string, unknown>;
    expect(result.taggedModules).toBe(2);
    expect(result.truncation).toBeUndefined();
    const byPkg = result.byPackage as Record<string, Array<{ id: string }>>;
    const allIds = Object.values(byPkg).flat().map(m => m.id);
    expect(allIds).toContain('mod:test/utils-mod');
  });

  it('summaryOnly returns topModules and omits byPackage', () => {
    const ctx = buildSliceCtx();
    const result = buildDomainModulesSlice(ctx, {
      domainTag: 'auth',
      includeSecondaryMatches: true,
      summaryOnly: true,
      moduleLimit: 1,
    }) as Record<string, unknown>;
    expect(result.byPackage).toBeUndefined();
    expect(Array.isArray(result.topModules)).toBe(true);
    expect(result.summaryOnly).toBe(true);
    expect((result.truncation as Record<string, Record<string, unknown>>).modules).toMatchObject({
      shown: 1,
      more: { kind: 'arg', arg: 'view', value: 'modules' },
    });
  });

  it('moduleLimit paginates byPackage entries', () => {
    const ctx = buildSliceCtx();
    const result = buildDomainModulesSlice(ctx, {
      domainTag: 'auth',
      includeSecondaryMatches: true,
      moduleLimit: 1,
      offset: 0,
    }) as Record<string, unknown>;
    const byPkg = result.byPackage as Record<string, Array<{ id: string }>>;
    const allIds = Object.values(byPkg).flat().map(m => m.id);
    expect(allIds).toHaveLength(1);
    expect((result.truncation as Record<string, Record<string, unknown>>).modules).toMatchObject({
      shown: 1,
      total: 2,
      more: { kind: 'page', arg: 'offset', nextOffset: 1 },
    });
  });
});

describe('get_domain_or_focus_context — pagination', () => {
  function buildDomainCtx(): McpToolRuntime {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'pkg:test', type: 'package', label: 'test', description: '' });
    addNode(g, { id: 'mod:test/low', type: 'module', label: 'low', description: '',
      data: { filePath: '/repo/low.ts', relativeFilePath: 'low.ts' } });
    addNode(g, { id: 'mod:test/high', type: 'module', label: 'high', description: '',
      data: { filePath: '/repo/high.ts', relativeFilePath: 'high.ts' } });
    addNode(g, { id: 'domain:auth', type: 'domain', label: 'auth', description: '', data: { tier: 'business' } });
    addEdge(g, 'root', 'pkg:test', 'contains');
    addEdge(g, 'pkg:test', 'mod:test/low', 'contains');
    addEdge(g, 'pkg:test', 'mod:test/high', 'contains');
    addEdge(g, 'mod:test/low', 'domain:auth', 'tagged', { tagSource: 'path' });
    addEdge(g, 'mod:test/high', 'domain:auth', 'tagged', { tagSource: 'path' });
    addEdge(g, 'mod:test/high', 'mod:test/low', 'imports');

    const annotations = {
      get: () => undefined, set: jest.fn(), isFresh: () => true, getQueue: () => [], getStats: () => backlogCoverage(),
    } as unknown as RepovineState['annotations'];
    const state: RepovineState = {
      graph: g,
      snapshot: { repoRoot: '/repo', timestamp: '2024-01-01', packages: [], modules: [] },
      modulesById: new Map(),
      searchIndex: { tokens: new Map(), annotationText: new Map() },
      semanticIndex: null,
      semanticSearchRefresh: { status: 'disabled' },
      annotations,
      domainsConfig: null,
      domainsSuggestions: defaultDomainsSuggestions(),
      refactoringThresholds: defaultRefactoringThresholds(),
      builtAt: '2024-01-01',
    };
    return wrapTestRuntime(state);
  }

  it('summaryOnly returns topModules sorted by connectivity', () => {
    const ctx = buildDomainCtx();
    const result = buildDomainContext(ctx, {
      domain: 'auth',
      summaryOnly: true,
      moduleLimit: 1,
    }) as Record<string, unknown>;
    expect(result.modules).toBeUndefined();
    const top = result.topModules as Array<{ id: string }>;
    expect(top).toHaveLength(1);
    expect(top[0].id).toBe('mod:test/high');
    expect(result.summaryOnly).toBe(true);
  });
});

describe('get_annotation_status coverage — compact response', () => {
  function buildStatsCtx(getStatsImpl: () => unknown): McpToolRuntime {
    const g = createEmptyGraph();
    addNode(g, { id: 'mod:test/x', type: 'module', label: 'x', description: '',
      data: { filePath: '/repo/x.ts', relativeFilePath: 'x.ts' } });

    const annotations = {
      get: () => undefined,
      set: jest.fn(),
      isFresh: () => true,
      getQueue: () => [],
      getStats: getStatsImpl,
      getAll: () => ({}),
    } as unknown as RepovineState['annotations'];

    const state: RepovineState = {
      graph: g,
      snapshot: { repoRoot: '/repo', timestamp: '2024-01-01', packages: [],
        modules: [{ id: 'mod:test/x', packageName: 'test', filePath: '/repo/x.ts', relativeFilePath: 'x.ts', contentHash: 'h', imports: [], exports: [] }] },
      modulesById: new Map(),
      searchIndex: { tokens: new Map(), annotationText: new Map() },
      semanticIndex: null,
      semanticSearchRefresh: { status: 'disabled' },
      annotations,
      domainsConfig: null,
      domainsSuggestions: defaultDomainsSuggestions(),
      refactoringThresholds: defaultRefactoringThresholds(),
      builtAt: '2024-01-01',
    };
    return wrapTestRuntime(state);
  }

    it('returns aggregates and surfaces only anomalous domains', () => {
      const ctx = buildStatsCtx(() => backlogCoverage({
        modules: kindCoverage({ total: 100, annotated: 90, fresh: 80, stale: 10, unannotated: 10 }),
        byDomain: {
          // healthy: must NOT appear in anomalies
          healthy: kindCoverage({ total: 50, annotated: 50, fresh: 50 }),
          // has stale
          stale_domain: kindCoverage({ total: 30, annotated: 30, fresh: 25, stale: 5 }),
          // has unannotated
          partial: kindCoverage({ total: 20, annotated: 10, fresh: 10, unannotated: 10 }),
        },
        domains: { ...kindCoverage({ total: 3 }), list: [] },
      }));
    const envelope = toolHandlers['get_annotation_status'](ctx, { view: 'coverage' }) as ToolResponse;
    const result = (envelope.result as { coverage: Record<string, unknown> }).coverage;
    expect(result.modules).toEqual({ total: 100, annotated: 90, fresh: 80, stale: 10, unannotated: 10 });
    expect((result.allNodeTypes as { needsWork: number }).needsWork).toBe(20);
    expect(result.byDomain).toBeUndefined(); // compact by default
    expect(result.domainCount).toBe(3);
    const a = result.anomalies as { staleDomains: Array<{ domain: string }>; unannotatedDomains: Array<{ domain: string }> };
    expect(a.staleDomains.map(d => d.domain)).toEqual(['stale_domain']);
    expect(a.unannotatedDomains.map(d => d.domain)).toEqual(['partial']);
  });

  it('reports an advisory inconsistent count over a module note with drifted keyExports', () => {
    const g = createEmptyGraph();
    addNode(g, { id: 'mod:test/drift', type: 'module', label: 'drift', description: '',
      data: { filePath: '/repo/drift.ts', relativeFilePath: 'drift.ts' } });
    const mod: ModuleInfo = {
      id: 'mod:test/drift', packageName: 'test', filePath: '/repo/drift.ts', relativeFilePath: 'drift.ts',
      contentHash: 'h', imports: [],
      exports: [{ name: 'realFn', kind: 'function', lineRange: { start: 1, end: 5 }, isDefault: false }],
    } as unknown as ModuleInfo;
    const modulesById = new Map<string, ModuleInfo>([[mod.id, mod]]);
    const annotations = {
      get: () => undefined, set: jest.fn(), isFresh: () => true, getQueue: () => [],
        getStats: () => backlogCoverage({ modules: kindCoverage({ total: 1, annotated: 1, fresh: 1 }) }),
      getAll: () => ({
        'mod:test/drift': {
          nodeId: 'mod:test/drift', nodeType: 'module', contentHash: 'h', pass: 1, updatedAt: '',
          annotation: { summary: 'A module that drifted: keyExports list a renamed export.', keyExports: { ghostFn: 'gone' } },
        },
        // env mismatch alone must NOT count as inconsistent (advisory only)
        'mod:test/env': {
          nodeId: 'mod:test/env', nodeType: 'module', contentHash: 'h', pass: 1, updatedAt: '',
          annotation: { summary: 'Declares an env var the detector did not capture.', envDependencies: { UNDETECTED: 'x' } },
        },
      }),
    } as unknown as RepovineState['annotations'];
    // env module: has a captured export + no detected env vars, so its only issue is env (advisory)
    modulesById.set('mod:test/env', {
      id: 'mod:test/env', packageName: 'test', filePath: '/repo/env.ts', relativeFilePath: 'env.ts',
      contentHash: 'h', imports: [],
      exports: [{ name: 'cfg', kind: 'const', lineRange: { start: 1, end: 2 }, isDefault: false }],
    } as unknown as ModuleInfo);

    const state: RepovineState = {
      graph: g, snapshot: makeSnapshot([...modulesById.values()]), modulesById,
      searchIndex: { tokens: new Map(), annotationText: new Map() },
      semanticIndex: null,
      semanticSearchRefresh: { status: 'disabled' }, annotations, domainsConfig: null,
      domainsSuggestions: defaultDomainsSuggestions(),
      refactoringThresholds: defaultRefactoringThresholds(), builtAt: '2024-01-01',
    };
    const ctx = wrapTestRuntime(state);

    const envelope = toolHandlers['get_annotation_status'](ctx, { view: 'coverage' }) as ToolResponse;
    const anomalies = ((envelope.result as { coverage: Record<string, unknown> }).coverage.anomalies) as {
      inconsistent: { sample: Array<{ nodeId: string; issues: string[] }> };
      truncation?: unknown;
    };
    // Only the keyExports drift; env-only is advisory/excluded. One note fits the preview, so no bound.
    expect(anomalies.inconsistent.sample).toHaveLength(1);
    expect(anomalies.truncation).toBeUndefined();
    expect(anomalies.inconsistent.sample[0].nodeId).toBe('mod:test/drift');
    expect(anomalies.inconsistent.sample[0].issues).toContain('keyExports:ghostFn');
  });

    it('includes full byDomain when includeAllDomains is true', () => {
      const ctx = buildStatsCtx(() => backlogCoverage({
        modules: kindCoverage({ total: 1, annotated: 1, fresh: 1 }),
        byDomain: { x: kindCoverage({ total: 1, annotated: 1, fresh: 1 }) },
        domains: { ...kindCoverage({ total: 1 }), list: [] },
      }));
    const envelope = toolHandlers['get_annotation_status'](ctx, { view: 'coverage', includeAllDomains: true }) as ToolResponse;
    const result = (envelope.result as { coverage: Record<string, unknown> }).coverage;
    expect(result.byDomain).toEqual({ x: kindCoverage({ total: 1, annotated: 1, fresh: 1 }) });
    expect(result.byTier).toEqual({});
  });

    it('filters byDomain by domainsFilter', () => {
      const ctx = buildStatsCtx(() => backlogCoverage({
        modules: kindCoverage({ total: 2, annotated: 2, fresh: 2 }),
        byDomain: {
          a: kindCoverage({ total: 1, annotated: 1, fresh: 1 }),
          b: kindCoverage({ total: 1, annotated: 1, fresh: 1 }),
        },
        domains: { ...kindCoverage({ total: 2 }), list: [] },
      }));
    const envelope = toolHandlers['get_annotation_status'](ctx, { view: 'coverage', domainsFilter: ['a'] }) as ToolResponse;
    const result = (envelope.result as { coverage: Record<string, unknown> }).coverage;
    expect(result.byDomain).toEqual({ a: kindCoverage({ total: 1, annotated: 1, fresh: 1 }) });
  });
});

describe('get_runtime_topology — returns whatever the graph contains', () => {
  // Filtering of infra resources moved to stage2/pass2Infra (config-driven). MCP handler is
  // a pass-through: every runtime-resource node in the graph is reported. Excludes live in
  // repovine.domains.json#infra.excludeSuffixes/excludePatterns and are
  // covered by stage2 tests (see stage2/infra-exclude.test.ts).
  it('returns all runtime-resource nodes in the graph (no MCP-level monitoring filter)', () => {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'resource:aws-lambda:UsersFunction', type: 'runtime-resource', label: 'UsersFunction', description: 'Lambda' });
    addNode(g, { id: 'resource:aws-dynamodb:UsersTable', type: 'runtime-resource', label: 'UsersTable', description: 'Dynamo' });
    addNode(g, { id: 'resource:aws:UsersFunctionErrorAlarm', type: 'runtime-resource', label: 'UsersFunctionErrorAlarm', description: 'Alarm' });

    const annotations = {
      get: () => undefined, set: jest.fn(), isFresh: () => true, getQueue: () => [], getStats: () => backlogCoverage(),
    } as unknown as RepovineState['annotations'];
    const state: RepovineState = {
      graph: g,
      snapshot: { repoRoot: '/repo', timestamp: '2024-01-01', packages: [], modules: [] },
      modulesById: new Map(),
      searchIndex: { tokens: new Map(), annotationText: new Map() },
      semanticIndex: null,
      semanticSearchRefresh: { status: 'disabled' },
      annotations,
      domainsConfig: null,
      domainsSuggestions: defaultDomainsSuggestions(),
      refactoringThresholds: defaultRefactoringThresholds(),
      builtAt: '2024-01-01',
    };
    const ctx = wrapTestRuntime(state);
    const result = projectRuntimeTopology(ctx, {}) as Record<string, unknown>;
    const services = result.services as Array<{ label: string }>;
    const labels = services.map(s => s.label);
    expect(labels).toEqual(expect.arrayContaining(['UsersFunction', 'UsersTable', 'UsersFunctionErrorAlarm']));
    expect(result.monitoringHidden).toBeUndefined();
  });

  it('exposes service kind and provider so callers can filter across providers', () => {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'resource:aws-lambda:SamLambda', type: 'runtime-resource', label: 'SamLambda', description: 'Lambda',
      data: { kind: 'lambda', provider: 'aws' } });
    addNode(g, { id: 'resource:terraform:TfLambda', type: 'runtime-resource', label: 'TfLambda', description: 'lambda declared in main.tf',
      data: { kind: 'lambda', provider: 'terraform' } });
    addNode(g, { id: 'resource:k8s:_/Deployment/web', type: 'runtime-resource', label: 'web', description: 'Deployment',
      data: { provider: 'k8s', k8sKind: 'Deployment' } });

    const annotations = {
      get: () => undefined, set: jest.fn(), isFresh: () => true, getQueue: () => [], getStats: () => backlogCoverage(),
    } as unknown as RepovineState['annotations'];
    const state: RepovineState = {
      graph: g,
      snapshot: { repoRoot: '/repo', timestamp: '2024-01-01', packages: [], modules: [] },
      modulesById: new Map(),
      searchIndex: { tokens: new Map(), annotationText: new Map() },
      semanticIndex: null,
      semanticSearchRefresh: { status: 'disabled' },
      annotations,
      domainsConfig: null,
      domainsSuggestions: defaultDomainsSuggestions(),
      refactoringThresholds: defaultRefactoringThresholds(),
      builtAt: '2024-01-01',
    };
    const ctx = wrapTestRuntime(state);
    const result = projectRuntimeTopology(ctx, {}) as Record<string, unknown>;
    const services = result.services as Array<{ label: string; kind?: string; provider?: string }>;
    const byLabel = Object.fromEntries(services.map(s => [s.label, s]));

    expect(byLabel['SamLambda']).toMatchObject({ kind: 'lambda', provider: 'aws' });
    expect(byLabel['TfLambda']).toMatchObject({ kind: 'lambda', provider: 'terraform' });
    expect(byLabel['web']).toMatchObject({ provider: 'k8s' });
    // Cross-provider filter use-case: every lambda regardless of how it was declared.
    expect(services.filter(s => s.kind === 'lambda').map(s => s.label).sort())
      .toEqual(['SamLambda', 'TfLambda']);
  });

  it('surfaces routes_to as a routing hop (routesTo / routedFrom) and expands the hull through it', () => {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'resource:k8s:_/Ingress/web-ingress', type: 'runtime-resource', label: 'web-ingress', description: 'Service',
      data: { kind: 'k8s-service', k8sKind: 'Ingress', provider: 'k8s' } });
    addNode(g, { id: 'resource:k8s:_/Service/web', type: 'runtime-resource', label: 'web', description: 'Service',
      data: { kind: 'k8s-service', k8sKind: 'Service', provider: 'k8s' } });
    addEdge(g, 'resource:k8s:_/Ingress/web-ingress', 'resource:k8s:_/Service/web', 'routes_to');

    const annotations = {
      get: () => undefined, set: jest.fn(), isFresh: () => true, getQueue: () => [], getStats: () => backlogCoverage(),
    } as unknown as RepovineState['annotations'];
    const state: RepovineState = {
      graph: g,
      snapshot: { repoRoot: '/repo', timestamp: '2024-01-01', packages: [], modules: [] },
      modulesById: new Map(),
      searchIndex: { tokens: new Map(), annotationText: new Map() },
      semanticIndex: null,
      semanticSearchRefresh: { status: 'disabled' },
      annotations,
      domainsConfig: null,
      domainsSuggestions: defaultDomainsSuggestions(),
      refactoringThresholds: defaultRefactoringThresholds(),
      builtAt: '2024-01-01',
    };
    const ctx = wrapTestRuntime(state);

    const all = projectRuntimeTopology(ctx, {}) as Record<string, unknown>;
    const byLabel = Object.fromEntries((all.services as Array<Record<string, unknown>>).map(s => [s.label as string, s]));
    expect(byLabel['web-ingress'].routesTo).toEqual([{ target: 'resource:k8s:_/Service/web', label: 'web' }]);
    expect(byLabel['web-ingress'].routedFrom).toBeUndefined();
    expect(byLabel['web'].routedFrom).toEqual([{ source: 'resource:k8s:_/Ingress/web-ingress', label: 'web-ingress' }]);
    expect(byLabel['web'].routesTo).toBeUndefined();

    // Scoped at the ingress, the hull reaches the backend it routes to (routes_to is a witness edge).
    const scoped = projectRuntimeTopology(ctx, {
      scope: resolveScope(ctx, 'resource:k8s:_/Ingress/web-ingress'),
    }) as Record<string, unknown>;
    const scopedLabels = (scoped.services as Array<{ label: string }>).map(s => s.label).sort();
    expect(scopedLabels).toEqual(['web', 'web-ingress']);
  });

  it('builds dataFlows only through concrete trigger consumers, not env-var access', () => {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'resource:aws-lambda:ProducerFunction', type: 'runtime-resource', label: 'ProducerFunction', description: 'Lambda' });
    addNode(g, { id: 'resource:aws-lambda:EnvOnlyFunction', type: 'runtime-resource', label: 'EnvOnlyFunction', description: 'Lambda',
      data: { envRefs: [{ varName: 'QUEUE_URL', refType: 'ref', targetLogicalId: 'WorkQueue' }] } });
    addNode(g, { id: 'resource:aws-lambda:WorkerFunction', type: 'runtime-resource', label: 'WorkerFunction', description: 'Lambda' });
    addNode(g, { id: 'resource:aws-sqs:WorkQueue', type: 'runtime-resource', label: 'WorkQueue', description: 'Queue' });

    addEdge(g, 'resource:aws-lambda:ProducerFunction', 'resource:aws-sqs:WorkQueue', 'publishes');
    addEdge(g, 'resource:aws-sqs:WorkQueue', 'resource:aws-lambda:WorkerFunction', 'consumes');

    const annotations = {
      get: () => undefined, set: jest.fn(), isFresh: () => true, getQueue: () => [], getStats: () => backlogCoverage(),
    } as unknown as RepovineState['annotations'];
    const state: RepovineState = {
      graph: g,
      snapshot: { repoRoot: '/repo', timestamp: '2024-01-01', packages: [], modules: [] },
      modulesById: new Map(),
      searchIndex: { tokens: new Map(), annotationText: new Map() },
      semanticIndex: null,
      semanticSearchRefresh: { status: 'disabled' },
      annotations,
      domainsConfig: null,
      domainsSuggestions: defaultDomainsSuggestions(),
      refactoringThresholds: defaultRefactoringThresholds(),
      builtAt: '2024-01-01',
    };
    const ctx = wrapTestRuntime(state);
    const result = projectRuntimeTopology(ctx, {}) as Record<string, unknown>;

    expect(result.dataFlows).toEqual([
      {
        from: 'ProducerFunction',
        through: 'resource:aws-sqs:WorkQueue',
        to: 'WorkerFunction',
        // The pair is a static possibility through the shared queue, not an observed route.
        relation: 'possible-via-shared-resource',
      },
    ]);
    expect(result.dataFlows).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'ProducerFunction', to: 'EnvOnlyFunction' }),
      ]),
    );
  });

  it('separates the declared handler from the modules the infra edge resolved to', () => {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, {
      id: 'resource:k8s:_/Deployment/api',
      type: 'runtime-resource',
      label: 'api',
      description: 'Deployment',
      data: { handler: 'src/server.main', provider: 'k8s', kind: 'k8s-deployment' },
    });
    addNode(g, { id: 'mod:app/worker', type: 'module', label: 'worker.ts', description: 'worker' });
    addNode(g, { id: 'mod:app/api', type: 'module', label: 'api.ts', description: 'api' });
    addNode(g, { id: 'infra:dockerfile:docker/Dockerfile', type: 'module', label: 'Dockerfile', description: 'Dockerfile' });
    // A container with several images reaches several infra targets; one of them is a build
    // artifact, not code.
    addEdge(g, 'resource:k8s:_/Deployment/api', 'mod:app/worker', 'infra');
    addEdge(g, 'resource:k8s:_/Deployment/api', 'mod:app/api', 'infra');
    addEdge(g, 'resource:k8s:_/Deployment/api', 'infra:dockerfile:docker/Dockerfile', 'infra');

    const annotations = {
      get: () => undefined, set: jest.fn(), isFresh: () => true, getQueue: () => [], getStats: () => backlogCoverage(),
    } as unknown as RepovineState['annotations'];
    const state: RepovineState = {
      graph: g,
      snapshot: { repoRoot: '/repo', timestamp: '2024-01-01', packages: [], modules: [] },
      modulesById: new Map(),
      searchIndex: { tokens: new Map(), annotationText: new Map() },
      semanticIndex: null,
      semanticSearchRefresh: { status: 'disabled' },
      annotations,
      domainsConfig: null,
      domainsSuggestions: defaultDomainsSuggestions(),
      refactoringThresholds: defaultRefactoringThresholds(),
      builtAt: '2024-01-01',
    };
    const result = projectRuntimeTopology(wrapTestRuntime(state), {}) as Record<string, unknown>;
    const service = (result.services as Array<Record<string, unknown>>)[0];

    // The declaration stays what the manifest says, whatever resolution found.
    expect(service.handler).toBe('src/server.main');
    // Every resolved module, sorted — not the first edge, and not the Dockerfile.
    expect(service.handlerModules).toEqual(['api.ts', 'worker.ts']);
  });

  it('discloses that a many-to-many dataFlows listing is a product, not that many routes', () => {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    for (const name of ['ProducerA', 'ProducerB', 'WorkerA', 'WorkerB']) {
      addNode(g, { id: `resource:aws-lambda:${name}`, type: 'runtime-resource', label: name, description: 'Lambda' });
    }
    addNode(g, { id: 'resource:aws-sqs:WorkQueue', type: 'runtime-resource', label: 'WorkQueue', description: 'Queue' });
    addEdge(g, 'resource:aws-lambda:ProducerA', 'resource:aws-sqs:WorkQueue', 'publishes');
    addEdge(g, 'resource:aws-lambda:ProducerB', 'resource:aws-sqs:WorkQueue', 'publishes');
    addEdge(g, 'resource:aws-sqs:WorkQueue', 'resource:aws-lambda:WorkerA', 'consumes');
    addEdge(g, 'resource:aws-sqs:WorkQueue', 'resource:aws-lambda:WorkerB', 'consumes');

    const annotations = {
      get: () => undefined, set: jest.fn(), isFresh: () => true, getQueue: () => [], getStats: () => backlogCoverage(),
    } as unknown as RepovineState['annotations'];
    const state: RepovineState = {
      graph: g,
      snapshot: { repoRoot: '/repo', timestamp: '2024-01-01', packages: [], modules: [] },
      modulesById: new Map(),
      searchIndex: { tokens: new Map(), annotationText: new Map() },
      semanticIndex: null,
      semanticSearchRefresh: { status: 'disabled' },
      annotations,
      domainsConfig: null,
      domainsSuggestions: defaultDomainsSuggestions(),
      refactoringThresholds: defaultRefactoringThresholds(),
      builtAt: '2024-01-01',
    };
    const ctx = wrapTestRuntime(state);

    const projected = projectRuntimeTopology(ctx, {}) as Record<string, unknown>;
    const flows = projected.dataFlows as Array<Record<string, unknown>>;
    // 2 producers x 2 consumers; every pair carries the possibility marker, none is a witnessed route.
    expect(flows).toHaveLength(4);
    expect(flows.every(f => f.relation === 'possible-via-shared-resource')).toBe(true);

    const response = handleTraceFlow(ctx, {}) as { gaps?: string[] };
    expect(response.gaps?.some(g => g.includes('2x2 producer-consumer product'))).toBe(true);
  });
});

describe('get_cross_package_dependencies — grouped boundary violations + suggested fix', () => {
  function buildBoundaryCtx(): McpToolRuntime {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'pkg:shared', type: 'package', label: 'shared', description: '', data: { path: 'packages/shared' } });
    addNode(g, { id: 'pkg:app', type: 'package', label: 'app', description: '', data: { path: 'packages/app' } });

    // shared/src/index — package public API
    addNode(g, { id: 'mod:shared/src/index', type: 'module', label: '…/shared/index', description: '',
      data: { filePath: '/repo/packages/shared/src/index.ts', relativeFilePath: 'src/index.ts' } });
    // shared/src/auth/index — auth/ sibling-index (the heuristic checks for one of these)
    addNode(g, { id: 'mod:shared/src/auth/index', type: 'module', label: '…/auth/index', description: '',
      data: { filePath: '/repo/packages/shared/src/auth/index.ts', relativeFilePath: 'src/auth/index.ts' } });
    // shared/src/auth/middleware — deep target
    addNode(g, { id: 'mod:shared/src/auth/middleware', type: 'module', label: '…/auth/middleware', description: '',
      data: { filePath: '/repo/packages/shared/src/auth/middleware.ts', relativeFilePath: 'src/auth/middleware.ts' } });
    // Two importers in `app` both reaching the same deep module
    addNode(g, { id: 'mod:app/src/handler-a', type: 'module', label: 'handler-a', description: '',
      data: { filePath: '/repo/packages/app/src/handler-a.ts', relativeFilePath: 'src/handler-a.ts' } });
    addNode(g, { id: 'mod:app/src/handler-b', type: 'module', label: 'handler-b', description: '',
      data: { filePath: '/repo/packages/app/src/handler-b.ts', relativeFilePath: 'src/handler-b.ts' } });

    addEdge(g, 'pkg:shared', 'mod:shared/src/index', 'contains');
    addEdge(g, 'pkg:shared', 'mod:shared/src/auth/index', 'contains');
    addEdge(g, 'pkg:shared', 'mod:shared/src/auth/middleware', 'contains');
    addEdge(g, 'pkg:app', 'mod:app/src/handler-a', 'contains');
    addEdge(g, 'pkg:app', 'mod:app/src/handler-b', 'contains');
    addEdge(g, 'mod:app/src/handler-a', 'mod:shared/src/auth/middleware', 'imports');
    addEdge(g, 'mod:app/src/handler-b', 'mod:shared/src/auth/middleware', 'imports');

    const modulesById = new Map<string, ModuleInfo>([
      ['mod:app/src/handler-a', { id: 'mod:app/src/handler-a', packageName: 'app', filePath: '/repo/packages/app/src/handler-a.ts', relativeFilePath: 'src/handler-a.ts', contentHash: 'h1', imports: [{ moduleSpecifier: '../../shared/src/auth/middleware', resolvedModuleId: 'mod:shared/src/auth/middleware', importedNames: ['authMiddleware', 'checkAuth'], isTypeOnly: false, isExternal: false }], exports: [] }],
      ['mod:app/src/handler-b', { id: 'mod:app/src/handler-b', packageName: 'app', filePath: '/repo/packages/app/src/handler-b.ts', relativeFilePath: 'src/handler-b.ts', contentHash: 'h2', imports: [{ moduleSpecifier: '../../shared/src/auth/middleware', resolvedModuleId: 'mod:shared/src/auth/middleware', importedNames: ['getCorsHeaders'], isTypeOnly: false, isExternal: false }], exports: [] }],
    ]);

    const annotations = {
      get: () => undefined, set: jest.fn(), isFresh: () => true, getQueue: () => [], getStats: () => backlogCoverage(),
    } as unknown as RepovineState['annotations'];
    const state: RepovineState = {
      graph: g,
      snapshot: { repoRoot: '/repo', timestamp: '2024-01-01', packages: [], modules: [...modulesById.values()] },
      modulesById,
      searchIndex: { tokens: new Map(), annotationText: new Map() },
      semanticIndex: null,
      semanticSearchRefresh: { status: 'disabled' },
      annotations,
      domainsConfig: null,
      domainsSuggestions: defaultDomainsSuggestions(),
      refactoringThresholds: defaultRefactoringThresholds(),
      builtAt: '2024-01-01',
    };
    return wrapTestRuntime(state);
  }

  it('groups violations by target module and aggregates importers', () => {
    const ctx = buildBoundaryCtx();
    const result = analyzePackageBoundaries(ctx, {}) as Record<string, unknown>;
    const violations = result.boundaryViolations as Array<{
      targetModule: string;
      importerCount: number;
      importedBy: Array<{ from: string; symbols: string[] }>;
    }>;
    expect(violations).toHaveLength(1);
    expect(violations[0].targetModule).toBe('…/auth/middleware');
    expect(violations[0].importerCount).toBe(2);
    const importers = violations[0].importedBy.map(i => i.from).sort();
    expect(importers).toEqual(['handler-a', 'handler-b']);
  });

  it('produces a ready-to-paste suggestedFix with merged symbol list', () => {
    const ctx = buildBoundaryCtx();
    const result = analyzePackageBoundaries(ctx, {}) as Record<string, unknown>;
    const violations = result.boundaryViolations as Array<{
      suggestedFix?: { exportLocation: string; exportStatement: string; fixesViolations: number };
    }>;
    const fix = violations[0].suggestedFix;
    expect(fix).toBeDefined();
    expect(fix?.exportLocation).toBe('packages/shared/src/index.ts');
    expect(fix?.fixesViolations).toBe(2);
    // Symbols from both importers are merged + sorted
    expect(fix?.exportStatement).toBe("export { authMiddleware, checkAuth, getCorsHeaders } from './auth/middleware';");
  });

  it('counts a barrel-routed import once and suppresses its empty redirected-leaf violation', () => {
    const ctx = buildBoundaryCtx();
    const { graph, modulesById } = ctx.getState();
    const redirectedLeaf = (graph.outEdges.get('mod:app/src/handler-a') ?? [])
      .find(edge => edge.to === 'mod:shared/src/auth/middleware');
    if (!redirectedLeaf) throw new Error('fixture is missing redirected leaf edge');
    redirectedLeaf.metadata = { usedNames: ['publicAuth'] };
    addEdge(graph, 'mod:app/src/handler-a', 'mod:shared/src/index', 'imports');
    addNode(graph, {
      id: 'mod:shared/src/setup',
      type: 'module',
      label: '…/shared/setup',
      description: '',
      data: { filePath: '/repo/packages/shared/src/setup.ts', relativeFilePath: 'src/setup.ts' },
    });
    addEdge(graph, 'pkg:shared', 'mod:shared/src/setup', 'contains');
    addEdge(graph, 'mod:app/src/handler-a', 'mod:shared/src/setup', 'imports');
    modulesById.get('mod:app/src/handler-a')!.imports = [
      {
        moduleSpecifier: '@shared',
        resolvedModuleId: 'mod:shared/src/index',
        importedNames: ['publicAuth'],
        isTypeOnly: false,
        isExternal: false,
      },
      {
        moduleSpecifier: '@shared/setup',
        resolvedModuleId: 'mod:shared/src/setup',
        importedNames: [],
        isTypeOnly: false,
        isExternal: false,
      },
    ];

    const result = analyzePackageBoundaries(ctx, {}) as {
      edges: Array<{
        moduleEdges: number;
        topModuleEdges: Array<{ fromModule: string; toModule: string; symbols: string[] }>;
      }>;
      boundaryViolations: Array<{
        importerCount: number;
        importedBy: Array<{ from: string; symbols: string[] }>;
        suggestedFix?: { exportStatement: string };
      }>;
    };

    expect(result.edges[0].moduleEdges).toBe(3);
    expect(result.edges[0].topModuleEdges.filter(edge => edge.fromModule === 'handler-a')).toEqual([{
      fromModule: 'handler-a',
      toModule: '…/shared/index',
      symbols: ['publicAuth'],
    }, {
      fromModule: 'handler-a',
      toModule: '…/shared/setup',
      symbols: [],
    }]);
    expect(result.boundaryViolations[0].importerCount).toBe(1);
    expect(result.boundaryViolations[0].importedBy).toEqual([{
      from: 'handler-b',
      symbols: ['getCorsHeaders'],
    }]);
    expect(result.boundaryViolations[0].suggestedFix?.exportStatement).not.toContain('export {  }');
  });
});

describe('inferFileBasedRoutes — file-based routes across frameworks', () => {
  function mkMod(id: string, relativeFilePath: string, partial?: Partial<ModuleInfo>): ModuleInfo {
    return {
      id,
      packageName: 'app',
      filePath: `/repo/${relativeFilePath}`,
      relativeFilePath,
      contentHash: 'h',
      imports: [],
      exports: [],
      ...partial,
    };
  }
  function mkFileRouteMod(
    id: string,
    relativeFilePath: string,
    route: { path: string; framework: string; fileType: string; kind?: 'frontend' | 'api' },
  ): ModuleInfo {
    return mkMod(id, relativeFilePath, {
      semanticHints: {
        hasRoutes: true,
        routes: [{
          path: route.path,
          component: '(file-route)',
          source: 'file',
          kind: route.kind ?? (['api', 'server', 'server-api', 'route'].includes(route.fileType) ? 'api' : 'frontend'),
          framework: route.framework,
          fileType: route.fileType,
        }],
      },
    });
  }

  it('extracts Next.js App Router routes (page.tsx, route.ts, layout.tsx)', () => {
    const mods = [
      mkFileRouteMod('mod:app/page', 'app/page.tsx', { path: '/', framework: 'nextjs-app', fileType: 'page' }),
      mkFileRouteMod('mod:app/users-page', 'app/users/page.tsx', { path: '/users', framework: 'nextjs-app', fileType: 'page' }),
      mkFileRouteMod('mod:app/api-users', 'app/api/users/route.ts', { path: '/api/users', framework: 'nextjs-app', fileType: 'route' }),
      mkFileRouteMod('mod:app/blog-slug', 'app/blog/[slug]/page.tsx', { path: '/blog/[slug]', framework: 'nextjs-app', fileType: 'page' }),
      mkFileRouteMod('mod:app/marketing-pricing', 'app/(marketing)/pricing/page.tsx', { path: '/pricing', framework: 'nextjs-app', fileType: 'page' }), // route group dropped
    ];
    const fb = inferFileBasedRoutes({ modules: mods });
    expect(fb.find(r => r.moduleId === 'mod:app/page')).toMatchObject({ path: '/', framework: 'nextjs-app', fileType: 'page' });
    expect(fb.find(r => r.moduleId === 'mod:app/users-page')).toMatchObject({ path: '/users', framework: 'nextjs-app' });
    expect(fb.find(r => r.moduleId === 'mod:app/api-users')).toMatchObject({ path: '/api/users', framework: 'nextjs-app', fileType: 'route' });
    expect(fb.find(r => r.moduleId === 'mod:app/blog-slug')).toMatchObject({ path: '/blog/[slug]' });
    expect(fb.find(r => r.moduleId === 'mod:app/marketing-pricing')).toMatchObject({ path: '/pricing' });
  });

  it('extracts Next.js Pages Router routes', () => {
    const mods = [
      mkFileRouteMod('mod:pages/index', 'pages/index.tsx', { path: '/', framework: 'nextjs-pages', fileType: 'page' }),
      mkFileRouteMod('mod:pages/about', 'pages/about.tsx', { path: '/about', framework: 'nextjs-pages', fileType: 'page' }),
      mkFileRouteMod('mod:pages/api-hello', 'pages/api/hello.ts', { path: '/api/hello', framework: 'nextjs-pages', fileType: 'api' }),
      mkFileRouteMod('mod:pages/dynamic', 'pages/users/[id].tsx', { path: '/users/[id]', framework: 'nextjs-pages', fileType: 'page' }),
      mkMod('mod:pages/_app', 'pages/_app.tsx'),  // private — skipped
    ];
    const fb = inferFileBasedRoutes({ modules: mods });
    const ids = fb.map(r => r.moduleId);
    expect(fb.find(r => r.moduleId === 'mod:pages/index')).toMatchObject({ path: '/', framework: 'nextjs-pages' });
    expect(fb.find(r => r.moduleId === 'mod:pages/about')).toMatchObject({ path: '/about', framework: 'nextjs-pages', fileType: 'page' });
    expect(fb.find(r => r.moduleId === 'mod:pages/api-hello')).toMatchObject({ path: '/api/hello', fileType: 'api' });
    expect(ids).not.toContain('mod:pages/_app');
  });

  it('extracts SvelteKit +page / +server / +layout', () => {
    const mods = [
      mkFileRouteMod('mod:sk/root-page', 'src/routes/+page.svelte', { path: '/', framework: 'sveltekit', fileType: 'page' }),
      mkFileRouteMod('mod:sk/users-page', 'src/routes/users/+page.svelte', { path: '/users', framework: 'sveltekit', fileType: 'page' }),
      mkFileRouteMod('mod:sk/users-api', 'src/routes/api/users/+server.ts', { path: '/api/users', framework: 'sveltekit', fileType: 'server' }),
      mkFileRouteMod('mod:sk/layout', 'src/routes/+layout.ts', { path: '/', framework: 'sveltekit', fileType: 'layout' }),
      mkFileRouteMod('mod:sk/dashboard-server', 'src/routes/dashboard/+page.server.ts', { path: '/dashboard', framework: 'sveltekit', fileType: 'page' }),
    ];
    const fb = inferFileBasedRoutes({ modules: mods });
    expect(fb.find(r => r.moduleId === 'mod:sk/root-page')).toMatchObject({ path: '/', framework: 'sveltekit', fileType: 'page' });
    expect(fb.find(r => r.moduleId === 'mod:sk/users-page')).toMatchObject({ path: '/users', framework: 'sveltekit' });
    expect(fb.find(r => r.moduleId === 'mod:sk/users-api')).toMatchObject({ path: '/api/users', fileType: 'server' });
    expect(fb.find(r => r.moduleId === 'mod:sk/layout')).toMatchObject({ path: '/', fileType: 'layout' });
    expect(fb.find(r => r.moduleId === 'mod:sk/dashboard-server')).toMatchObject({ path: '/dashboard', fileType: 'page' });
  });

  it('extracts Nuxt server/api endpoints', () => {
    const mods = [
      mkFileRouteMod('mod:nuxt/api-users', 'server/api/users.ts', { path: '/api/users', framework: 'nuxt', fileType: 'server-api' }),
      mkFileRouteMod('mod:nuxt/api-products-list', 'server/api/products/index.ts', { path: '/api/products', framework: 'nuxt', fileType: 'server-api' }),
      mkFileRouteMod('mod:nuxt/api-auth-login', 'server/api/auth/login.ts', { path: '/api/auth/login', framework: 'nuxt', fileType: 'server-api' }),
    ];
    const fb = inferFileBasedRoutes({ modules: mods });
    expect(fb.find(r => r.moduleId === 'mod:nuxt/api-users')).toMatchObject({ path: '/api/users', framework: 'nuxt', fileType: 'server-api' });
    expect(fb.find(r => r.moduleId === 'mod:nuxt/api-products-list')).toMatchObject({ path: '/api/products' });
    expect(fb.find(r => r.moduleId === 'mod:nuxt/api-auth-login')).toMatchObject({ path: '/api/auth/login' });
  });

  it('returns nothing when no file-based routes exist', () => {
    const mods = [mkMod('mod:plain', 'src/utils/helpers.ts')];
    const fb = inferFileBasedRoutes({ modules: mods });
    expect(fb).toHaveLength(0);
  });

  it('projects only file-based routes, ignoring JSX routes', () => {
    const mods = [
      mkMod('mod:app/page', 'app/page.tsx', {
        semanticHints: {
          hasRoutes: true,
          routes: [{ path: '/', component: '(file-route)', source: 'file', kind: 'frontend', framework: 'nextjs-app', fileType: 'page' }],
        },
      }),
      mkMod('mod:app/router', 'src/App.tsx', {
        semanticHints: {
          hasRoutes: true,
          routes: [{ path: '/users', component: 'UsersPage', source: 'jsx', kind: 'frontend' }],
        },
      }),
    ];
    const fb = inferFileBasedRoutes({ modules: mods });
    expect(fb.map(r => r.moduleId)).toEqual(['mod:app/page']);
  });
});
