import { asHostPath, asPkgRelPath } from '@repovine/plugin-sdk';
/**
 * Delivery invariance.
 *
 * A node carrying a mechanic's primitive emits that mechanic's declared tags on that mechanic's
 * declared surfaces. The registry (`src/mechanics/registry.ts`) declares which primitive a mechanic
 * reads and which channels carry its signal; the surfaces that do the carrying are written
 * separately. Nothing tied the two together: `channels` had no consumer in code or test, so renaming
 * a channel — or losing a surface — left every suite green.
 *
 * The published benchmark corpus measures repovine's effect on agent behaviour, and the whole effect
 * arrives through these mechanics. Four primitive forms carry it: `scope:"boundary"`,
 * `scope:"consumer"`, a carrier pair named through `integrationPoints`, and a persistent
 * `sideEffect`. Those four are the mandatory cases here. A broken channel raises no error — the run
 * completes and reports numbers that mean nothing — so the check is delivery observed at the
 * surface, not a call into the detector.
 *
 * Scope: this law fixes the invariance direction — primitive present ⇒ tags delivered, primitive
 * absent ⇒ nothing delivered. Totality (no channel declared without a surface, no surface without a
 * mechanic) is a separate law.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { createEmptyGraph, addNode, addEdge } from '../../src/graph/index.js';
import { CONFIG_DEFAULTS } from '../../src/config.js';
import { DELIVERY_MECHANICS, deliveryMechanic } from '../../src/mechanics/registry.js';
import { handleInspectNode } from '../../src/mcp/tools/inspect-node.js';
import { buildBoundaryIndex } from '../../src/mcp/boundary-index.js';
import { computeCarrierLinkGaps } from '../../src/annotations/carrier-links.js';
import type { AnnotationStore } from '../../src/annotations/store.js';
import type { McpToolRuntime, RepovineState } from '../../src/mcp/types.js';
import type {
  AnnotationContent,
  InvestigateTag,
  ModuleInfo,
  RepositoryFactsSnapshot,
  RiskEntry,
  StoredAnnotation,
} from '../../src/types.js';

// ── The five-node fixture ──
//
// A four-module runtime import chain plus one export child. The chain is what makes the four
// primitives observable on different channels at once: each annotated node is a 1-hop neighbour of
// exactly one other node (pull-neighbor), the boundary carrier sits three hops out so it can only
// arrive through `integrationPoints` (pull-carrier), and the consumer-risk node sits two hops from
// an annotated importer that does not name it (advisory).
//
//   api/order-handler ──imports──▶ db/order-repo ──imports──▶ services/order-service
//         │                                                          │
//    contains                                                     imports
//         ▼                                                          ▼
//   export handleOrder                                     contracts/order-dto
//
// order-handler names `contracts/order-dto` in integrationPoints; nothing imports it directly.

const HANDLER = 'mod:app/src/api/order-handler';
const REPO_NODE = 'mod:app/src/db/order-repo';
const SERVICE = 'mod:app/src/services/order-service';
const DTO = 'mod:app/src/contracts/order-dto';
const HANDLER_EXPORT = 'export:app/src/api/order-handler/handleOrder';

/** Pinned so a fixture that silently loses a node cannot pass a totality check vacuously. */
const FIXTURE_NODES = [HANDLER, REPO_NODE, SERVICE, DTO, HANDLER_EXPORT] as const;

const BOUNDARY_RISK_TEXT = 'published DTO consumed by the billing service; do not rename fields';
const CONSUMER_RISK_TEXT = 'importers must re-check the tenant gate locally; this service does not enforce it';

const boundaryRisk: RiskEntry = { text: BOUNDARY_RISK_TEXT, scope: 'boundary' };
const consumerRisk: RiskEntry = { text: CONSUMER_RISK_TEXT, scope: 'consumer' };

function relPathOf(nodeId: string): string {
  return `${nodeId.replace(/^mod:app\//, '')}.ts`;
}

function moduleInfo(nodeId: string): ModuleInfo {
  const relativeFilePath = relPathOf(nodeId);
  return {
    id: nodeId,
    packageName: 'app',
    absPath: asHostPath(`/repo/${relativeFilePath}`),
    pkgRelPath: asPkgRelPath(relativeFilePath),
    contentHash: 'fixture-hash',
    imports: [],
    exports: [],
  };
}

function stored(nodeId: string, annotation: AnnotationContent): StoredAnnotation {
  return {
    nodeId,
    nodeType: nodeId.startsWith('export:') ? 'export-symbol' : 'module',
    contentHash: 'fixture-hash',
    pass: 1,
    updatedAt: '2026-07-27T00:00:00.000Z',
    annotation,
  };
}

/** The four primitives, one per annotated node. `handleOrder` is deliberately left unannotated. */
function fixtureAnnotations(): Record<string, StoredAnnotation> {
  return {
    [DTO]: stored(DTO, {
      summary: 'Order DTO published to the billing service.',
      risks: [boundaryRisk],
    }),
    [SERVICE]: stored(SERVICE, {
      summary: 'Order service; tenant gate is the caller\'s obligation.',
      risks: [consumerRisk],
    }),
    [REPO_NODE]: stored(REPO_NODE, {
      summary: 'Order repository.',
      sideEffects: [{ kind: 'io-write', subtype: 'db', description: 'writes the orders table' }],
    }),
    [HANDLER]: stored(HANDLER, {
      summary: 'Order API handler.',
      integrationPoints: `delegates the published field contract to ${DTO}`,
    }),
  };
}

function makeGraph() {
  const graph = createEmptyGraph();
  addNode(graph, { id: HANDLER, type: 'module', label: 'order-handler', description: '' });
  addNode(graph, { id: REPO_NODE, type: 'module', label: 'order-repo', description: '' });
  addNode(graph, { id: SERVICE, type: 'module', label: 'order-service', description: '' });
  addNode(graph, { id: DTO, type: 'module', label: 'order-dto', description: '' });
  addNode(graph, { id: HANDLER_EXPORT, type: 'export-symbol', label: 'handleOrder', description: '' });
  addEdge(graph, HANDLER, REPO_NODE, 'imports');
  addEdge(graph, REPO_NODE, SERVICE, 'imports');
  addEdge(graph, SERVICE, DTO, 'imports');
  addEdge(graph, HANDLER, HANDLER_EXPORT, 'contains');
  return graph;
}

function makeState(annots: Record<string, StoredAnnotation> = fixtureAnnotations()): RepovineState {
  const graph = makeGraph();
  const modulesById = new Map<string, ModuleInfo>(
    [HANDLER, REPO_NODE, SERVICE, DTO].map(id => [id, moduleInfo(id)]),
  );
  const snapshot = {
    repoRoot: '/repo',
    timestamp: '2026-07-27T00:00:00.000Z',
    packages: [],
    modules: [...modulesById.values()],
  } as unknown as RepositoryFactsSnapshot;
  const annotations = {
    get: (id: string) => annots[id],
    getAll: () => annots,
    isFresh: () => true,
    set: jest.fn(),
    flushAsync: jest.fn(async () => {}),
    lastSaveError: null,
  } as unknown as AnnotationStore;
  return {
    graph,
    snapshot,
    modulesById,
    annotations,
    searchIndex: { tokens: new Map(), annotationText: new Map() },
    semanticIndex: null,
    builtAt: '2026-07-27T00:00:00.000Z',
  } as unknown as RepovineState;
}

function makeCtx(state: RepovineState = makeState()): McpToolRuntime {
  return {
    getState: () => state,
    getConfig: () => CONFIG_DEFAULTS,
    refreshRepoState: () => {},
    repoRoot: '/repo',
  } as unknown as McpToolRuntime;
}

type InspectResult = {
  links?: Array<{ targetId: string; investigate?: InvestigateTag[] }>;
  drillDown: Array<{ id: string; investigate?: InvestigateTag[] }>;
  investigatePointers?: Array<{ id: string; investigate: InvestigateTag[]; via: string }>;
};

async function inspect(nodeId: string, ctx: McpToolRuntime = makeCtx()) {
  const response = await handleInspectNode(ctx, { nodeId });
  return {
    attention: response.attention ?? [],
    result: response.result as InspectResult,
  };
}

/** Tags a 1-hop neighbour ref carries in the inspected node's response, by target id. */
function neighborTags(result: InspectResult, targetId: string): InvestigateTag[] {
  const link = result.links?.find(l => l.targetId === targetId);
  const child = result.drillDown.find(c => c.id === targetId);
  return [...(link?.investigate ?? []), ...(child?.investigate ?? [])];
}

describe('core-laws delivery-invariance', () => {
  it('holds a five-node fixture with one primitive per annotated node', () => {
    const state = makeState();
    expect([...state.graph.nodes.keys()].sort()).toEqual([...FIXTURE_NODES].sort());
    const annots = state.annotations.getAll();
    // Non-vacuous: each mandatory primitive is present exactly where the cases below read it, and
    // the export child carries none, so the negative controls are not asserting an empty fixture.
    expect(deliveryMechanic('boundary').detect({ nodeId: DTO, annotation: annots[DTO].annotation })).toBe(true);
    expect(deliveryMechanic('risk').detect({ nodeId: SERVICE, annotation: annots[SERVICE].annotation })).toBe(true);
    expect(deliveryMechanic('effect').detect({ nodeId: REPO_NODE, annotation: annots[REPO_NODE].annotation })).toBe(true);
    expect(annots[HANDLER].annotation.integrationPoints).toContain(DTO);
    expect(annots[HANDLER_EXPORT]).toBeUndefined();
  });

  // The declaration itself. Without this, a channel can be renamed in the registry and every
  // delivery assertion below still passes — the exact hole this law was written to close.
  it('pins the declared channel set of every mechanic', () => {
    // Compared as plain strings on purpose: a renamed channel then reaches this assertion instead of
    // failing to compile, and a control that reddens the type-checker is not a control that reddens
    // this guard.
    const declared: Record<string, string[]> = Object.fromEntries(
      DELIVERY_MECHANICS.map(m => [m.id as string, [...m.channels] as string[]]),
    );
    expect(declared).toEqual({
      risk: ['pull-neighbor', 'pull-carrier', 'advisory'],
      boundary: ['pull-self', 'pull-neighbor', 'pull-carrier', 'push', 'advisory'],
      effect: ['pull-neighbor', 'pull-carrier'],
      unannotated: [],
      wiring: ['pull-self', 'pull-neighbor', 'pull-carrier'],
      'co-change': ['pull-neighbor', 'pull-carrier'],
      hub: ['pull-neighbor', 'pull-carrier'],
    });
    const spelled: string[] = [...new Set(Object.values(declared).flat())].sort();
    expect(spelled).toEqual(['advisory', 'pull-carrier', 'pull-neighbor', 'pull-self', 'push']);
  });

  // ── Case 1: scope:"boundary" — pull-self, pull-neighbor, push ──

  it('delivers a boundary risk to the node\'s own attention block (pull-self)', async () => {
    const { attention } = await inspect(DTO);
    expect(attention[0]).toEqual({
      nodeId: DTO,
      investigate: ['boundary'],
      note: 'off-limits boundary surface — this node',
      next: { tool: 'analyze_dependencies', args: { scope: DTO, mode: 'impact' }, reason: 'Check consumers before editing an off-limits surface.' },
    });
  });

  it('delivers a boundary risk to an importer\'s ref tags (pull-neighbor)', async () => {
    const { result, attention } = await inspect(SERVICE);
    expect(neighborTags(result, DTO)).toContain('boundary');
    // The same obligation is hoisted to the envelope so it survives a truncated ref list.
    expect(attention.some(item => item.nodeId === DTO && item.investigate?.includes('boundary'))).toBe(true);
  });

  it('delivers a boundary risk to the path-keyed index the pre-edit hook reads (push)', () => {
    const index = buildBoundaryIndex(makeState());
    expect(index.entries[relPathOf(DTO)]).toEqual([
      { nodeId: DTO, label: 'order-dto', risks: [BOUNDARY_RISK_TEXT] },
    ]);
    // Push carries `boundary` and nothing else: the other three primitives own no entry.
    expect(Object.keys(index.entries)).toEqual([relPathOf(DTO)]);
  });

  // ── Case 2: scope:"consumer" — pull-neighbor, advisory ──

  it('delivers a consumer-scoped risk to an importer\'s ref tags (pull-neighbor)', async () => {
    const { result } = await inspect(REPO_NODE);
    expect(neighborTags(result, SERVICE)).toEqual(['risk']);
  });

  it('delivers a consumer-scoped risk to the carrier-link advisory (advisory)', () => {
    const state = makeState();
    const gaps = computeCarrierLinkGaps({ graph: state.graph, annotations: state.annotations.getAll() });
    // order-handler delegates to order-service through order-repo and does not name it, which is
    // exactly the authoring gap the advisory exists to raise.
    expect(gaps.sample).toContainEqual({ kind: 'missing-carrier-link', importerId: HANDLER, targetId: SERVICE });
    expect(gaps.missingCarrierLinks).toBe(1);
    // The named carrier is deliverable, so the advisory does not also report it as unreachable.
    expect(gaps.namedButUndeliverable).toBe(0);
  });

  it('delivers a consumer-scoped risk through a carrier pair (pull-carrier)', async () => {
    // The declared pairing: `risk` explicitly names `pull-carrier` in the registry.
    const carried = makeState({
      ...fixtureAnnotations(),
      [DTO]: stored(DTO, { summary: 'Order DTO.', risks: [consumerRisk] }),
    });
    const { result } = await inspect(HANDLER, makeCtx(carried));
    expect(result.investigatePointers).toEqual([
      { id: DTO, investigate: ['risk'], via: 'integrationPoints' },
    ]);
  });

  // ── Case 3: carrier pair through integrationPoints — pull-carrier ──

  it('delivers a carrier pair named in integrationPoints (pull-carrier)', async () => {
    const { result } = await inspect(HANDLER);
    // The carrier channel carries every mechanic that declares it, so a boundary carrier — the
    // shape three of the four corpus cases use — arrives tagged `boundary`. Totality separately
    // checks that the registry declaration and surface stay aligned.
    expect(result.investigatePointers).toEqual([
      { id: DTO, investigate: ['boundary'], via: 'integrationPoints' },
    ]);
    // The carrier is three import hops out, so no structural ref could have carried it.
    expect(result.links?.map(l => l.targetId) ?? []).not.toContain(DTO);
  });

  // ── Case 4: persistent sideEffect — pull-neighbor ──

  it('delivers a persistent side effect to an importer\'s ref tags (pull-neighbor)', async () => {
    const { result } = await inspect(HANDLER);
    expect(neighborTags(result, REPO_NODE)).toEqual(['effect']);
  });

  it('delivers a neighbour tag through the child branch as well as the link branch', async () => {
    // `links` and `drillDown` are two assignment sites for the same channel; a fixture reaching
    // only one of them leaves the other unguarded.
    const child = makeState({
      ...fixtureAnnotations(),
      [HANDLER_EXPORT]: stored(HANDLER_EXPORT, { summary: 'Order entry point.', risks: [boundaryRisk] }),
    });
    const { result } = await inspect(HANDLER, makeCtx(child));
    expect(result.drillDown.find(c => c.id === HANDLER_EXPORT)?.investigate).toEqual(['boundary']);
  });

  // ── Declared surfaces, and no others ──

  it('hoists only the mechanics that declare pull-self to the node\'s own attention', async () => {
    // `effect` declares `pull-neighbor` alone: a persistent side effect on the inspected node is a
    // fact about its neighbours' obligations, not a self item. Nothing enforced that reading.
    const selfCapable = DELIVERY_MECHANICS.filter(m => m.channels.includes('pull-self')).map(m => m.id);
    expect(selfCapable).toEqual(['boundary', 'wiring']);
    const { attention } = await inspect(REPO_NODE);
    expect(attention.some(item => item.nodeId === REPO_NODE)).toBe(false);
  });

  // ── Negative controls: the primitive is what carries delivery, not the node's presence ──

  it('tags nothing when the neighbour carries no primitive', async () => {
    const { result, attention } = await inspect(HANDLER);
    expect(neighborTags(result, HANDLER_EXPORT)).toEqual([]);
    expect(attention.some(item => item.nodeId === HANDLER_EXPORT)).toBe(false);
  });

  it('delivers nothing on any channel once the annotations are dropped', async () => {
    const bare = makeState({});
    const ctx = makeCtx(bare);
    for (const nodeId of FIXTURE_NODES) {
      const { result, attention } = await inspect(nodeId, ctx);
      expect(attention).toEqual([]);
      expect(result.investigatePointers).toBeUndefined();
      expect((result.links ?? []).some(l => l.investigate)).toBe(false);
      expect(result.drillDown.some(c => c.investigate)).toBe(false);
    }
    expect(buildBoundaryIndex(bare).entries).toEqual({});
    expect(computeCarrierLinkGaps({ graph: bare.graph, annotations: {} }).missingCarrierLinks).toBe(0);
  });

  it('delivers nothing when the risk carries no scope', async () => {
    const plain = makeState({
      [DTO]: stored(DTO, { summary: 'Order DTO.', risks: [BOUNDARY_RISK_TEXT] }),
      [SERVICE]: stored(SERVICE, { summary: 'Order service.', risks: [CONSUMER_RISK_TEXT] }),
    });
    const ctx = makeCtx(plain);
    expect((await inspect(DTO, ctx)).attention).toEqual([]);
    expect(neighborTags((await inspect(SERVICE, ctx)).result, DTO)).toEqual([]);
    expect(neighborTags((await inspect(REPO_NODE, ctx)).result, SERVICE)).toEqual([]);
    expect(buildBoundaryIndex(plain).entries).toEqual({});
  });
});
