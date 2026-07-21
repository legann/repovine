import { describe, expect, it } from '@jest/globals';
import {
  CARRIER_LINK_GAP_SAMPLE_LIMIT,
  computeCarrierLinkGaps,
  parseIntegrationPointTargets,
} from '../../../src/annotations/carrier-links.js';
import { addEdge, addNode, createEmptyGraph } from '../../../src/graph/index.js';
import type { AnnotationContent, GraphNode, RepositoryGraph, StoredAnnotation } from '../../../src/types.js';

function addGraphNode(graph: RepositoryGraph, id: string, type: GraphNode['type'] = 'module'): void {
  addNode(graph, {
    id,
    type,
    label: id,
    description: '',
  } as GraphNode);
}

function addExport(graph: RepositoryGraph, moduleId: string, exportId: string): void {
  addGraphNode(graph, exportId, 'export-symbol');
  addEdge(graph, moduleId, exportId, 'contains');
}

function ann(nodeId: string, annotation: AnnotationContent): StoredAnnotation {
  const nodeType: StoredAnnotation['nodeType'] = nodeId.startsWith('export:')
    ? 'export-symbol'
    : nodeId.startsWith('template:')
      ? 'template'
      : nodeId.startsWith('resource:')
        ? 'runtime-resource'
        : 'module';
  return {
    nodeId,
    nodeType,
    contentHash: `${nodeId}:hash`,
    pass: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    annotation,
    schemaVersion: 1,
  };
}

function compute(graph: RepositoryGraph, annotations: StoredAnnotation[], scopeHints?: string[]) {
  return computeCarrierLinkGaps({
    graph,
    annotations: Object.fromEntries(annotations.map((a) => [a.nodeId, a])),
    ...(scopeHints ? { scopeHints } : {}),
  });
}

describe('parseIntegrationPointTargets', () => {
  it('parses string and record integrationPoints with dedupe, graph filtering, and trailing punctuation trim', () => {
    const ids = parseIntegrationPointTargets({
      'export:pkg/a/Foo': 'delegates to mod:pkg/a, mod:missing.',
      extra: 'mod:pkg/a; resource:aws-lambda:Fn)',
    }, {
      nodeExists: (id) => id !== 'mod:missing',
    });

    expect(ids).toEqual(['export:pkg/a/Foo', 'mod:pkg/a', 'resource:aws-lambda:Fn']);
  });
});

describe('computeCarrierLinkGaps', () => {
  // Golden true-positive: a 2-hop runtime delegation chain (I → mid → T). A reexport-facade golden
  // (`A imports B`, `B reexports T`) is unsatisfiable here — pure barrels emit no `imports` edges,
  // so the delegation predicate can never cross one.
  it('reports Type A when an importer transitively depends on a consumer-risk target but omits integrationPoints', () => {
    const graph = createEmptyGraph();
    for (const id of ['mod:I', 'mod:mid', 'mod:T']) addGraphNode(graph, id);
    addEdge(graph, 'mod:I', 'mod:mid', 'imports');
    addEdge(graph, 'mod:mid', 'mod:T', 'imports');

    const gaps = compute(graph, [
      ann('mod:I', { summary: 'Importer' }),
      ann('mod:T', { summary: 'Target', risks: [{ text: 'importer must verify gate', scope: 'consumer' }] }),
    ]);

    expect(gaps.missingCarrierLinks).toBe(1);
    expect(gaps.namedButUndeliverable).toBe(0);
    expect(gaps.suppressedTargets).toBe(0);
    expect(gaps.sample).toEqual([
      { kind: 'missing-carrier-link', importerId: 'mod:I', targetId: 'mod:T' },
    ]);
  });

  it('does not report a 3-hop runtime chain (not a delegation shape)', () => {
    const graph = createEmptyGraph();
    for (const id of ['mod:I', 'mod:mid1', 'mod:mid2', 'mod:T']) addGraphNode(graph, id);
    addEdge(graph, 'mod:I', 'mod:mid1', 'imports');
    addEdge(graph, 'mod:mid1', 'mod:mid2', 'imports');
    addEdge(graph, 'mod:mid2', 'mod:T', 'imports');

    const gaps = compute(graph, [
      ann('mod:I', { summary: 'Importer' }),
      ann('mod:T', { summary: 'Target', risks: [{ text: 'importer must verify gate', scope: 'consumer' }] }),
    ]);

    expect(gaps.missingCarrierLinks).toBe(0);
    expect(gaps.sample).toEqual([]);
  });

  it('does not report a 2-hop chain whose first edge is type-only', () => {
    const graph = createEmptyGraph();
    for (const id of ['mod:I', 'mod:mid', 'mod:T']) addGraphNode(graph, id);
    addEdge(graph, 'mod:I', 'mod:mid', 'imports', { isTypeOnly: true });
    addEdge(graph, 'mod:mid', 'mod:T', 'imports');

    const gaps = compute(graph, [
      ann('mod:I', { summary: 'Importer' }),
      ann('mod:T', { summary: 'Target', risks: [{ text: 'importer must verify gate', scope: 'consumer' }] }),
    ]);

    expect(gaps.missingCarrierLinks).toBe(0);
  });

  it('does not report a 2-hop chain whose second edge is type-only', () => {
    const graph = createEmptyGraph();
    for (const id of ['mod:I', 'mod:mid', 'mod:T']) addGraphNode(graph, id);
    addEdge(graph, 'mod:I', 'mod:mid', 'imports');
    addEdge(graph, 'mod:mid', 'mod:T', 'imports', { isTypeOnly: true });

    const gaps = compute(graph, [
      ann('mod:I', { summary: 'Importer' }),
      ann('mod:T', { summary: 'Target', risks: [{ text: 'importer must verify gate', scope: 'consumer' }] }),
    ]);

    expect(gaps.missingCarrierLinks).toBe(0);
  });

  it('does not flag a runtime import cycle as self-delegation', () => {
    // I ⇄ M cycle: the 2-hop walk returns to the importer itself. The importer must never pair
    // with its own annotation as the SSOT (the closure gate this predicate replaced excluded
    // the start node).
    const graph = createEmptyGraph();
    for (const id of ['mod:A', 'mod:B']) addGraphNode(graph, id);
    addEdge(graph, 'mod:A', 'mod:B', 'imports');
    addEdge(graph, 'mod:B', 'mod:A', 'imports');

    const gaps = compute(graph, [
      ann('mod:A', { summary: 'Cycle member with consumer risk', risks: [{ text: 'importer must verify gate', scope: 'consumer' }] }),
      ann('mod:B', { summary: 'Cycle member' }),
    ]);

    expect(gaps.missingCarrierLinks).toBe(0);
    expect(gaps.sample).toEqual([]);
  });

  it('suppresses structurally when the risk sits on a contained export of a directly imported module', () => {
    // Diamond: I imports T directly AND I → M → T at runtime; consumer risk on export:T/Foo.
    // Exercises the equivalence set in the structural check — an exact-id check would flag via M.
    const graph = createEmptyGraph();
    for (const id of ['mod:I', 'mod:M', 'mod:T']) addGraphNode(graph, id);
    addExport(graph, 'mod:T', 'export:T/Foo');
    addEdge(graph, 'mod:I', 'mod:T', 'imports');
    addEdge(graph, 'mod:I', 'mod:M', 'imports');
    addEdge(graph, 'mod:M', 'mod:T', 'imports');

    const gaps = compute(graph, [
      ann('mod:I', { summary: 'Importer' }),
      ann('export:T/Foo', { summary: 'Foo export', risks: [{ text: 'importer must verify gate', scope: 'consumer' }] }),
    ]);

    expect(gaps.missingCarrierLinks).toBe(0);
    expect(gaps.sample).toEqual([]);
  });

  it('suppresses Type A for a direct import because the structural channel owns delivery', () => {
    const graph = createEmptyGraph();
    for (const id of ['mod:I', 'mod:T']) addGraphNode(graph, id);
    addEdge(graph, 'mod:I', 'mod:T', 'imports');

    const gaps = compute(graph, [
      ann('mod:I', { summary: 'Importer' }),
      ann('mod:T', { summary: 'Target', risks: [{ text: 'importer must verify gate', scope: 'consumer' }] }),
    ]);

    expect(gaps.missingCarrierLinks).toBe(0);
    expect(gaps.sample).toEqual([]);
  });

  it('suppresses Type A when integrationPoints names the transitive target', () => {
    const graph = createEmptyGraph();
    for (const id of ['mod:I', 'mod:mid', 'mod:T']) addGraphNode(graph, id);
    addEdge(graph, 'mod:I', 'mod:mid', 'imports');
    addEdge(graph, 'mod:mid', 'mod:T', 'imports');

    const gaps = compute(graph, [
      ann('mod:I', { summary: 'Importer', integrationPoints: 'authoritative gate: mod:T' }),
      ann('mod:T', { summary: 'Target', risks: [{ text: 'importer must verify gate', scope: 'consumer' }] }),
    ]);

    expect(gaps.missingCarrierLinks).toBe(0);
  });

  it('reports Type B when an importer names a risky target without an import path', () => {
    const graph = createEmptyGraph();
    for (const id of ['mod:I', 'mod:T']) addGraphNode(graph, id);

    const gaps = compute(graph, [
      ann('mod:I', { summary: 'Importer', integrationPoints: 'registry points at mod:T' }),
      ann('mod:T', { summary: 'Target', risks: [{ text: 'importer must verify gate', scope: 'consumer' }] }),
    ]);

    expect(gaps.missingCarrierLinks).toBe(0);
    expect(gaps.namedButUndeliverable).toBe(1);
    expect(gaps.sample).toEqual([
      { kind: 'named-but-undeliverable', importerId: 'mod:I', targetId: 'mod:T' },
    ]);
  });

  it('keeps full aggregate counts while capping the sample', () => {
    const graph = createEmptyGraph();
    addGraphNode(graph, 'mod:I');
    const annotations = [ann('mod:I', { summary: 'Importer' })];
    const total = CARRIER_LINK_GAP_SAMPLE_LIMIT + 5;
    for (let i = 0; i < total; i++) {
      const mid = `mod:mid${i}`;
      const target = `mod:T${i}`;
      addGraphNode(graph, mid);
      addGraphNode(graph, target);
      addEdge(graph, 'mod:I', mid, 'imports');
      addEdge(graph, mid, target, 'imports');
      annotations.push(ann(target, { summary: `Target ${i}`, risks: [{ text: 'importer must verify gate', scope: 'consumer' }] }));
    }

    const gaps = compute(graph, annotations);

    expect(gaps.missingCarrierLinks).toBe(total);
    expect(gaps.sample).toHaveLength(CARRIER_LINK_GAP_SAMPLE_LIMIT);
    expect(gaps.sample.every((s) => s.kind === 'missing-carrier-link')).toBe(true);
  });

  it('does not report Type A when the reachable target has no consumer-scoped risk', () => {
    const graph = createEmptyGraph();
    for (const id of ['mod:I', 'mod:mid', 'mod:T']) addGraphNode(graph, id);
    addEdge(graph, 'mod:I', 'mod:mid', 'imports');
    addEdge(graph, 'mod:mid', 'mod:T', 'imports');

    const gaps = compute(graph, [
      ann('mod:I', { summary: 'Importer' }),
      ann('mod:T', { summary: 'Target', risks: ['local-only fact'] }),
    ]);

    expect(gaps.missingCarrierLinks).toBe(0);
  });

  it('ignores wrong-way names where the named target imports the annotating module', () => {
    const graph = createEmptyGraph();
    for (const id of ['mod:I', 'mod:consumer']) addGraphNode(graph, id);
    addEdge(graph, 'mod:consumer', 'mod:I', 'imports');

    const gaps = compute(graph, [
      ann('mod:I', { summary: 'Importer', integrationPoints: 'wrong direction mod:consumer' }),
      ann('mod:consumer', { summary: 'Consumer', risks: [{ text: 'importer must verify gate', scope: 'consumer' }] }),
    ]);

    expect(gaps.missingCarrierLinks).toBe(0);
    expect(gaps.namedButUndeliverable).toBe(0);
    expect(gaps.sample).toEqual([]);
  });

  it('normalizes export SSOT annotations when a facade names the owning module', () => {
    const graph = createEmptyGraph();
    for (const id of ['mod:I', 'mod:mid', 'mod:T']) addGraphNode(graph, id);
    addExport(graph, 'mod:T', 'export:T/Foo');
    addEdge(graph, 'mod:I', 'mod:mid', 'imports');
    addEdge(graph, 'mod:mid', 'mod:T', 'imports');

    const gaps = compute(graph, [
      ann('mod:I', { summary: 'Importer', integrationPoints: 'authoritative export lives in mod:T' }),
      ann('export:T/Foo', { summary: 'Foo export', risks: [{ text: 'importer must verify gate', scope: 'consumer' }] }),
    ]);

    expect(gaps.missingCarrierLinks).toBe(0);
    expect(gaps.namedButUndeliverable).toBe(0);
  });

  it('filters scoped validate counts and samples by importer scope', () => {
    const graph = createEmptyGraph();
    for (const id of ['mod:in-scope/I', 'mod:out-scope/I', 'mod:mid', 'mod:T']) addGraphNode(graph, id);
    addEdge(graph, 'mod:in-scope/I', 'mod:mid', 'imports');
    addEdge(graph, 'mod:out-scope/I', 'mod:mid', 'imports');
    addEdge(graph, 'mod:mid', 'mod:T', 'imports');

    const gaps = compute(graph, [
      ann('mod:in-scope/I', { summary: 'Importer in scope' }),
      ann('mod:out-scope/I', { summary: 'Importer out of scope' }),
      ann('mod:T', { summary: 'Target', risks: [{ text: 'importer must verify gate', scope: 'consumer' }] }),
    ], ['in-scope']);

    expect(gaps.missingCarrierLinks).toBe(1);
    expect(gaps.sample).toEqual([
      { kind: 'missing-carrier-link', importerId: 'mod:in-scope/I', targetId: 'mod:T' },
    ]);
  });

  it('reports Type B for a boundary-risk target even without consumer risk', () => {
    const graph = createEmptyGraph();
    for (const id of ['mod:I', 'mod:T']) addGraphNode(graph, id);

    const gaps = compute(graph, [
      ann('mod:I', { summary: 'Importer', integrationPoints: 'metadata seam mod:T' }),
      ann('mod:T', { summary: 'Target', risks: [{ text: 'off-limits contract', scope: 'boundary' }] }),
    ]);

    expect(gaps.namedButUndeliverable).toBe(1);
    expect(gaps.sample).toEqual([
      { kind: 'named-but-undeliverable', importerId: 'mod:I', targetId: 'mod:T' },
    ]);
  });

  it('excludes suppressed targets from the count and reports suppressedTargets', () => {
    const graph = createEmptyGraph();
    for (const id of ['mod:I', 'mod:mid', 'mod:T', 'mod:mid2', 'mod:U']) addGraphNode(graph, id);
    addEdge(graph, 'mod:I', 'mod:mid', 'imports');
    addEdge(graph, 'mod:mid', 'mod:T', 'imports');
    addEdge(graph, 'mod:I', 'mod:mid2', 'imports');
    addEdge(graph, 'mod:mid2', 'mod:U', 'imports');

    const gaps = computeCarrierLinkGaps({
      graph,
      annotations: Object.fromEntries([
        ann('mod:I', { summary: 'Importer' }),
        ann('mod:T', { summary: 'Target', risks: [{ text: 'importer must verify gate', scope: 'consumer' }] }),
        ann('mod:U', { summary: 'Other target', risks: [{ text: 'importer must verify gate', scope: 'consumer' }] }),
      ].map((a) => [a.nodeId, a])),
      suppressedTargetIds: new Set(['mod:T']),
    });

    expect(gaps.missingCarrierLinks).toBe(1);
    expect(gaps.suppressedTargets).toBe(1);
    expect(gaps.sample).toEqual([
      { kind: 'missing-carrier-link', importerId: 'mod:I', targetId: 'mod:U' },
    ]);
  });

  it('reports zero candidates with suppressedTargets when every target is reviewed', () => {
    const graph = createEmptyGraph();
    for (const id of ['mod:I', 'mod:mid', 'mod:T', 'mod:mid2', 'mod:U']) addGraphNode(graph, id);
    addEdge(graph, 'mod:I', 'mod:mid', 'imports');
    addEdge(graph, 'mod:mid', 'mod:T', 'imports');
    addEdge(graph, 'mod:I', 'mod:mid2', 'imports');
    addEdge(graph, 'mod:mid2', 'mod:U', 'imports');

    const gaps = computeCarrierLinkGaps({
      graph,
      annotations: Object.fromEntries([
        ann('mod:I', { summary: 'Importer' }),
        ann('mod:T', { summary: 'Target', risks: [{ text: 'importer must verify gate', scope: 'consumer' }] }),
        ann('mod:U', { summary: 'Other target', risks: [{ text: 'importer must verify gate', scope: 'consumer' }] }),
      ].map((a) => [a.nodeId, a])),
      suppressedTargetIds: new Set(['mod:T', 'mod:U']),
    });

    expect(gaps.missingCarrierLinks).toBe(0);
    expect(gaps.suppressedTargets).toBe(2);
    expect(gaps.sample).toEqual([]);
  });

  it('does not count suppressed ids that are not current consumer-risk targets', () => {
    const graph = createEmptyGraph();
    for (const id of ['mod:I', 'mod:mid', 'mod:T']) addGraphNode(graph, id);
    addEdge(graph, 'mod:I', 'mod:mid', 'imports');
    addEdge(graph, 'mod:mid', 'mod:T', 'imports');

    const gaps = computeCarrierLinkGaps({
      graph,
      annotations: Object.fromEntries([
        ann('mod:I', { summary: 'Importer' }),
        ann('mod:T', { summary: 'Target', risks: [{ text: 'importer must verify gate', scope: 'consumer' }] }),
      ].map((a) => [a.nodeId, a])),
      suppressedTargetIds: new Set(['mod:gone']),
    });

    expect(gaps.missingCarrierLinks).toBe(1);
    expect(gaps.suppressedTargets).toBe(0);
  });

  it('does not report resource annotations as Type B carrier importers', () => {
    const graph = createEmptyGraph();
    addGraphNode(graph, 'resource:aws-lambda:Fn', 'runtime-resource');
    addGraphNode(graph, 'mod:handler');

    const gaps = compute(graph, [
      ann('resource:aws-lambda:Fn', { summary: 'Runtime resource', integrationPoints: 'handler mod:handler' }),
      ann('mod:handler', { summary: 'Handler', risks: [{ text: 'importer must verify gate', scope: 'consumer' }] }),
    ]);

    expect(gaps.missingCarrierLinks).toBe(0);
    expect(gaps.namedButUndeliverable).toBe(0);
  });
});
