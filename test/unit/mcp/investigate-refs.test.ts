import { describe, it, expect } from '@jest/globals';
import {
  applyInvestigateTags,
  computeHubInDegreeThreshold,
  HUB_IMPORTER_FLOOR,
  MAX_HUB_REFS,
  MAX_INVESTIGATE_REFS,
  MAX_INVESTIGATE_TAGS_PER_REF,
  MAX_WIRING_REFS,
} from '../../../src/mcp/lib/investigate-refs.js';
import { createEmptyGraph, addNode, addEdge } from '../../../src/graph/index.js';
import type { AnnotationContent, EdgeKind, NodeViewDetail } from '../../../src/types.js';

/** Build a graph whose targets have the given import in-degrees (degrees[i] importers of `mod:t<i>`). */
function graphWithImportInDegrees(degrees: number[]) {
  const g = createEmptyGraph();
  let importer = 0;
  degrees.forEach((d, t) => {
    const target = `mod:t${t}`;
    addNode(g, { id: target, type: 'module', label: `t${t}`, description: '' });
    for (let i = 0; i < d; i++) {
      const src = `mod:src${importer++}`;
      addNode(g, { id: src, type: 'module', label: 's', description: '' });
      addEdge(g, src, target, 'imports');
    }
  });
  return g;
}

/** Annotation lookup backed by an id → AnnotationContent map. */
function annotationsFor(map: Record<string, AnnotationContent>) {
  return {
    get: (id: string): { annotation: AnnotationContent } | undefined =>
      map[id] ? { annotation: map[id] } : undefined,
  };
}

function consumerRiskAnnotations(consumerIds: Set<string>) {
  return {
    get: (id: string): { annotation: AnnotationContent } | undefined =>
      consumerIds.has(id)
        ? { annotation: { summary: 's', risks: [{ text: 'importer must verify gate', scope: 'consumer' }] } }
        : undefined,
  };
}

function baseView(): NodeViewDetail {
  return { id: 'mod:x', level: 2, label: 'x', description: '', drill_down: [] };
}

describe('applyInvestigateTags', () => {
  it('tags a link whose target carries a consumer-scoped risk with ["risk"]', () => {
    const view = baseView();
    view.links = [
      { targetId: 'mod:a', relation: 'imports', label: 'a' },
      { targetId: 'mod:b', relation: 'imports', label: 'b' },
    ];
    applyInvestigateTags(view, consumerRiskAnnotations(new Set(['mod:a'])));
    expect(view.links[0].investigate).toEqual(['risk']);
    expect(view.links[1].investigate).toBeUndefined();
    expect(view.investigateTruncated).toBeUndefined();
  });

  it('tags drill_down children too', () => {
    const view = baseView();
    view.drill_down = [
      { id: 'export:a', label: 'a', type: 'export-symbol' },
      { id: 'export:b', label: 'b', type: 'export-symbol' },
    ];
    applyInvestigateTags(view, consumerRiskAnnotations(new Set(['export:b'])));
    expect(view.drill_down[0].investigate).toBeUndefined();
    expect(view.drill_down[1].investigate).toEqual(['risk']);
  });

  it('does not tag local-only or absent risks', () => {
    const annotations = {
      get: (id: string): { annotation: AnnotationContent } | undefined =>
        id === 'mod:a'
          ? { annotation: { summary: 's', risks: ['local-only risk'] } }
          : undefined,
    };
    const view = baseView();
    view.links = [{ targetId: 'mod:a', relation: 'imports', label: 'a' }];
    applyInvestigateTags(view, annotations);
    expect(view.links[0].investigate).toBeUndefined();
  });

  it('caps the number of tagged refs per response and records investigateTruncated', () => {
    const total = MAX_INVESTIGATE_REFS + 5;
    const ids = Array.from({ length: total }, (_, i) => `mod:r${i}`);
    const view = baseView();
    view.links = ids.map((id) => ({ targetId: id, relation: 'imports' as const, label: id }));
    applyInvestigateTags(view, consumerRiskAnnotations(new Set(ids)));

    const tagged = view.links.filter((l) => l.investigate?.length);
    expect(tagged).toHaveLength(MAX_INVESTIGATE_REFS);
    expect(view.investigateTruncated).toEqual({ shownRefs: MAX_INVESTIGATE_REFS, totalRefs: total });
  });

  it('does not surface investigatePointers without options (legacy 2-arg behavior)', () => {
    const view = baseView();
    view.links = [{ targetId: 'mod:a', relation: 'imports', label: 'a' }];
    applyInvestigateTags(view, consumerRiskAnnotations(new Set(['mod:a'])));
    expect(view.investigatePointers).toBeUndefined();
  });
});

describe('applyInvestigateTags — effect / hub / boundary tags', () => {
  function linkView(targetIds: string[]): NodeViewDetail {
    const view = baseView();
    view.links = targetIds.map((id) => ({ targetId: id, relation: 'imports' as const, label: id }));
    return view;
  }

  it('emits `effect` for a target declaring a persistent side effect', () => {
    const view = linkView(['mod:writer', 'mod:logger', 'mod:reader']);
    applyInvestigateTags(view, annotationsFor({
      'mod:writer': { summary: 's', sideEffects: [{ kind: 'io-write', subtype: 'db' }] },
      'mod:logger': { summary: 's', sideEffects: [{ kind: 'io-write', subtype: 'stdout' }] },
      'mod:reader': { summary: 's', sideEffects: [{ kind: 'io-read', subtype: 'db' }] },
    }));
    expect(view.links![0].investigate).toEqual(['effect']);
    expect(view.links![1].investigate).toBeUndefined(); // stdout is not persistent
    expect(view.links![2].investigate).toBeUndefined(); // read is not a write
  });

  it('emits `hub` only at or above the importer floor', () => {
    const view = linkView(['mod:hub', 'mod:small']);
    const importerCount = (id: string): number =>
      id === 'mod:hub' ? HUB_IMPORTER_FLOOR : HUB_IMPORTER_FLOOR - 1;
    applyInvestigateTags(view, annotationsFor({}), { importerCount });
    expect(view.links![0].investigate).toEqual(['hub']);
    expect(view.links![1].investigate).toBeUndefined();
  });

  it('does not emit `hub` without an importerCount provider', () => {
    const view = linkView(['mod:hub']);
    applyInvestigateTags(view, annotationsFor({}));
    expect(view.links![0].investigate).toBeUndefined();
  });

  it('emits `boundary` for a target carrying a boundary-scoped risk', () => {
    const view = linkView(['mod:frozen']);
    applyInvestigateTags(view, annotationsFor({
      'mod:frozen': { summary: 's', risks: [{ text: 'frozen contract', scope: 'boundary' }] },
    }));
    expect(view.links![0].investigate).toEqual(['boundary']);
  });

  it('orders multiple tags by priority and respects the per-ref cap', () => {
    const view = linkView(['mod:all']);
    const importerCount = (): number => HUB_IMPORTER_FLOOR; // hub also qualifies
    applyInvestigateTags(view, annotationsFor({
      'mod:all': {
        summary: 's',
        risks: [
          { text: 'verify at consumer', scope: 'consumer' },
          { text: 'off-limits', scope: 'boundary' },
        ],
        sideEffects: [{ kind: 'state-global' }],
      },
    }), { importerCount });
    // risk > boundary > effect > hub; cap keeps the top MAX_INVESTIGATE_TAGS_PER_REF, dropping hub.
    expect(view.links![0].investigate).toEqual(['risk', 'boundary', 'effect']);
    expect(view.links![0].investigate).toHaveLength(MAX_INVESTIGATE_TAGS_PER_REF);
  });

  it('does not flood: detectors stay silent on plain targets (anti-dilution)', () => {
    const view = linkView(['mod:a', 'mod:b', 'mod:c']);
    applyInvestigateTags(view, annotationsFor({
      'mod:a': { summary: 's' },
      'mod:b': { summary: 's', sideEffects: [{ kind: 'pure' }] },
      'mod:c': { summary: 's', risks: ['local fact'] },
    }), { importerCount: () => 1 });
    expect(view.links!.every((l) => l.investigate === undefined)).toBe(true);
  });
});

describe('computeHubInDegreeThreshold — adaptive hub floor', () => {
  it('returns the floor on an empty graph', () => {
    expect(computeHubInDegreeThreshold(createEmptyGraph())).toBe(HUB_IMPORTER_FLOOR);
  });

  it('clamps to the floor when the p95 in-degree is below it', () => {
    // 95 targets with 1 importer, 5 with 5 → p95 = 5 → max(8, 5) = 8
    const g = graphWithImportInDegrees([...Array(95).fill(1), ...Array(5).fill(5)]);
    expect(computeHubInDegreeThreshold(g)).toBe(HUB_IMPORTER_FLOOR);
  });

  it('rises above the floor when the in-degree tail is high', () => {
    // 90 targets with 1, 10 with 9 → p95 lands on 9 → max(8, 9) = 9; a node with 8 importers no longer a hub
    const g = graphWithImportInDegrees([...Array(90).fill(1), ...Array(10).fill(9)]);
    expect(computeHubInDegreeThreshold(g)).toBe(9);
  });

  it('counts only `imports` in-edges (ignores `contains`)', () => {
    const g = createEmptyGraph();
    addNode(g, { id: 'mod:t', type: 'module', label: 't', description: '' });
    for (let i = 0; i < 50; i++) {
      addNode(g, { id: `mod:c${i}`, type: 'module', label: 'c', description: '' });
      addEdge(g, `mod:c${i}`, 'mod:t', 'contains');
    }
    expect(computeHubInDegreeThreshold(g)).toBe(HUB_IMPORTER_FLOOR); // no import in-edges → floor
  });

  it('a target below the adaptive threshold does not get `hub`', () => {
    const view = baseView();
    view.links = [{ targetId: 'mod:mid', relation: 'imports', label: 'mid' }];
    // importer count 9 clears the absolute floor (8) but not an adaptive threshold of 20
    applyInvestigateTags(view, annotationsFor({}), { importerCount: () => 9, hubThreshold: 20 });
    expect(view.links[0].investigate).toBeUndefined();
  });
});

describe('applyInvestigateTags — hub per-response cap', () => {
  function hubLinks(ids: string[]): NodeViewDetail {
    const view = baseView();
    view.links = ids.map((id) => ({ targetId: id, relation: 'imports' as const, label: id }));
    return view;
  }
  const counts: Record<string, number> = { 'mod:h1': 10, 'mod:h2': 20, 'mod:h3': 30, 'mod:h4': 40, 'mod:h5': 50 };
  const importerCount = (id: string): number => counts[id] ?? 0;

  it('keeps `hub` on at most MAX_HUB_REFS refs, the highest-importer ones', () => {
    const view = hubLinks(['mod:h1', 'mod:h2', 'mod:h3', 'mod:h4', 'mod:h5']);
    applyInvestigateTags(view, annotationsFor({}), { importerCount, hubThreshold: 8 });
    const withHub = view.links!.filter((l) => l.investigate?.includes('hub')).map((l) => l.targetId).sort();
    expect(withHub).toEqual(['mod:h4', 'mod:h5']); // top-2 by importer count
    expect(withHub).toHaveLength(MAX_HUB_REFS);
    // the demoted hub-only refs end up with no tag at all
    expect(view.links!.filter((l) => l.investigate === undefined).map((l) => l.targetId).sort())
      .toEqual(['mod:h1', 'mod:h2', 'mod:h3']);
  });

  it('a demoted ref keeps its non-hub tags (only `hub` is stripped)', () => {
    const view = hubLinks(['mod:h5', 'mod:h4', 'mod:riskhub']);
    const annotations = annotationsFor({
      'mod:riskhub': { summary: 's', risks: [{ text: 'verify at consumer', scope: 'consumer' }] },
    });
    // riskhub has the lowest importer count → demoted from hub, but its consumer risk survives
    applyInvestigateTags(view, annotations, { importerCount: (id) => (id === 'mod:riskhub' ? 9 : counts[id] ?? 0), hubThreshold: 8 });
    expect(view.links![2].investigate).toEqual(['risk']);
    expect(view.links!.filter((l) => l.investigate?.includes('hub')).map((l) => l.targetId).sort())
      .toEqual(['mod:h4', 'mod:h5']);
  });

  it('does not cap when hub refs are at or under MAX_HUB_REFS', () => {
    const view = hubLinks(['mod:h4', 'mod:h5']);
    applyInvestigateTags(view, annotationsFor({}), { importerCount, hubThreshold: 8 });
    expect(view.links!.every((l) => l.investigate?.includes('hub'))).toBe(true);
  });
});

describe('applyInvestigateTags — wiring / co-change topology tags', () => {
  /** edgeCount fake keyed by `${id}|${kind}:${dir}`; every other combination counts 0. */
  function edgeCountFrom(counts: Record<string, number>) {
    return (id: string, kind: EdgeKind, dir: 'in' | 'out'): number => counts[`${id}|${kind}:${dir}`] ?? 0;
  }

  function linkView(targetIds: string[], relation: EdgeKind = 'imports'): NodeViewDetail {
    const view = baseView();
    view.links = targetIds.map((id) => ({ targetId: id, relation, label: id }));
    return view;
  }

  it('tags a link whose target has an infra in-edge with ["wiring"]; a plain module stays untagged', () => {
    const view = linkView(['mod:handler', 'mod:plain']);
    applyInvestigateTags(view, annotationsFor({}), {
      edgeCount: edgeCountFrom({ 'mod:handler|infra:in': 1 }),
    });
    expect(view.links![0].investigate).toEqual(['wiring']);
    expect(view.links![1].investigate).toBeUndefined();
  });

  it('tags a link whose target has a binds_to out-edge with ["wiring"]', () => {
    const view = linkView(['mod:envbound']);
    applyInvestigateTags(view, annotationsFor({}), {
      edgeCount: edgeCountFrom({ 'mod:envbound|binds_to:out': 2 }),
    });
    expect(view.links![0].investigate).toEqual(['wiring']);
  });

  it('tags a drill_down child that implements a contract with ["co-change"]', () => {
    const view = baseView();
    view.drill_down = [
      { id: 'export:x/Impl', label: 'Impl', type: 'export-symbol' },
      { id: 'export:x/Helper', label: 'Helper', type: 'export-symbol' },
    ];
    applyInvestigateTags(view, annotationsFor({}), {
      edgeCount: edgeCountFrom({ 'export:x/Impl|implements:out': 1 }),
    });
    expect(view.drill_down[0].investigate).toEqual(['co-change']);
    expect(view.drill_down[1].investigate).toBeUndefined();
  });

  it('tags an implements link to the contract with ["co-change"] (contract side: in-edge)', () => {
    const view = linkView(['export:contracts/Iface'], 'implements');
    applyInvestigateTags(view, annotationsFor({}), {
      edgeCount: edgeCountFrom({ 'export:contracts/Iface|implements:in': 3 }),
    });
    expect(view.links![0].investigate).toEqual(['co-change']);
  });

  it('does not fire either tag without an edgeCount provider (self-gate)', () => {
    const view = linkView(['mod:handler']);
    applyInvestigateTags(view, annotationsFor({}));
    expect(view.links![0].investigate).toBeUndefined();
  });

  it('keeps `wiring` on at most MAX_WIRING_REFS refs, in collection order', () => {
    const ids = ['mod:w0', 'mod:w1', 'mod:w2', 'mod:w3'];
    const view = linkView(ids);
    applyInvestigateTags(view, annotationsFor({}), {
      edgeCount: edgeCountFrom(Object.fromEntries(ids.map((id) => [`${id}|infra:in`, 1]))),
    });
    const withWiring = view.links!.filter((l) => l.investigate?.includes('wiring')).map((l) => l.targetId);
    expect(withWiring).toEqual(['mod:w0', 'mod:w1']); // first-collected kept
    expect(withWiring).toHaveLength(MAX_WIRING_REFS);
    expect(view.links![2].investigate).toBeUndefined();
    expect(view.links![3].investigate).toBeUndefined();
  });

  it('demotes `co-change` in collection order: first-collected keep it, a later high-rank ref yields', () => {
    const ids = ['export:c0', 'export:c1', 'export:c2'];
    const view = linkView(ids, 'implements');
    const annotations = annotationsFor({
      'export:c2': { summary: 's', risks: [{ text: 'importer must verify gate', scope: 'consumer' }] },
    });
    applyInvestigateTags(view, annotations, {
      edgeCount: edgeCountFrom(Object.fromEntries(ids.map((id) => [`${id}|implements:in`, 1]))),
    });
    // Collection order wins over rank: c0/c1 (co-change is their only signal) keep the tag; c2 was
    // collected last, loses co-change past the cap, and still surfaces via its own consumer risk.
    expect(view.links![0].investigate).toEqual(['co-change']);
    expect(view.links![1].investigate).toEqual(['co-change']);
    expect(view.links![2].investigate).toEqual(['risk']);
  });

  it('demotes `wiring` by collection order even when importerCount is supplied (hub comparator stays hub-only)', () => {
    // Collection order (w0,w1 keep) differs from importer ranking (w2,w1 would keep) and from rank
    // ordering (w2,w0 would keep) — pins the branch per carrier tag.
    const ids = ['mod:w0', 'mod:w1', 'mod:w2'];
    const view = linkView(ids);
    const counts: Record<string, number> = { 'mod:w0': 1, 'mod:w1': 5, 'mod:w2': 7 };
    const annotations = annotationsFor({
      'mod:w2': { summary: 's', risks: [{ text: 'importer must verify gate', scope: 'consumer' }] },
    });
    applyInvestigateTags(view, annotations, {
      importerCount: (id) => counts[id] ?? 0,
      hubThreshold: 8, // no hub anywhere: counts stay below the threshold
      edgeCount: edgeCountFrom(Object.fromEntries(ids.map((id) => [`${id}|infra:in`, 1]))),
    });
    expect(view.links![0].investigate).toEqual(['wiring']);
    expect(view.links![1].investigate).toEqual(['wiring']);
    expect(view.links![2].investigate).toEqual(['risk']);
  });

  it('reports investigateTruncated.shownRefs as refs that actually carry tags after demotion', () => {
    const riskIds = Array.from({ length: 8 }, (_, i) => `mod:r${i}`);
    const wiredIds = Array.from({ length: 6 }, (_, i) => `mod:w${i}`);
    const view = linkView([...riskIds, ...wiredIds]);
    applyInvestigateTags(view, consumerRiskAnnotations(new Set(riskIds)), {
      edgeCount: edgeCountFrom(Object.fromEntries(wiredIds.map((id) => [`${id}|infra:in`, 1]))),
    });
    // 14 carriers → kept 12 (8 risk + first 4 wiring); wiring demotion past cap 2 empties two refs.
    const tagged = view.links!.filter((l) => l.investigate?.length);
    expect(tagged).toHaveLength(10);
    expect(view.investigateTruncated).toEqual({ shownRefs: 10, totalRefs: 14 });
  });

  it('caps hub and wiring independently on the same response (hub comparator unchanged)', () => {
    const wired = ['mod:w0', 'mod:w1', 'mod:w2'];
    const hubs = ['mod:h1', 'mod:h2', 'mod:h3'];
    const view = linkView([...wired, ...hubs]);
    const counts: Record<string, number> = { 'mod:h1': 10, 'mod:h2': 20, 'mod:h3': 30 };
    applyInvestigateTags(view, annotationsFor({}), {
      importerCount: (id) => counts[id] ?? 0,
      hubThreshold: 8,
      edgeCount: edgeCountFrom(Object.fromEntries(wired.map((id) => [`${id}|infra:in`, 1]))),
    });
    const withWiring = view.links!.filter((l) => l.investigate?.includes('wiring')).map((l) => l.targetId);
    expect(withWiring).toEqual(['mod:w0', 'mod:w1']);
    const withHub = view.links!.filter((l) => l.investigate?.includes('hub')).map((l) => l.targetId).sort();
    expect(withHub).toEqual(['mod:h2', 'mod:h3']); // top-2 by importer count, comparator behavior unchanged
  });
});

describe('applyInvestigateTags — integrationPoints carriers', () => {
  /** All integrationPoints targets are dependencies and exist, unless overridden. */
  function options(opts: {
    integrationPoints: AnnotationContent['integrationPoints'];
    dependsOnIds: Set<string>;
    existingIds: Set<string>;
  }) {
    return {
      selfAnnotation: { summary: 's', integrationPoints: opts.integrationPoints } as AnnotationContent,
      dependsOn: (id: string) => opts.dependsOnIds.has(id),
      nodeExists: (id: string) => opts.existingIds.has(id),
    };
  }

  it('surfaces a dependency with consumer risk named in integrationPoints as a hop-1 pointer', () => {
    const view = baseView();
    applyInvestigateTags(
      view,
      consumerRiskAnnotations(new Set(['mod:deep'])),
      options({
        integrationPoints: 'authoritative gate lives in mod:deep; see also utility_bar',
        dependsOnIds: new Set(['mod:deep']),
        existingIds: new Set(['mod:deep']),
      }),
    );
    expect(view.investigatePointers).toEqual([
      { id: 'mod:deep', investigate: ['risk'], via: 'integrationPoints' },
    ]);
  });

  it('parses the Record form (keys and values scanned for nodeId tokens)', () => {
    const view = baseView();
    applyInvestigateTags(
      view,
      consumerRiskAnnotations(new Set(['mod:viaValue', 'export:viaKey'])),
      options({
        integrationPoints: { 'export:viaKey': 'delegates disable semantics', delegate: 'mod:viaValue' },
        dependsOnIds: new Set(['mod:viaValue', 'export:viaKey']),
        existingIds: new Set(['mod:viaValue', 'export:viaKey']),
      }),
    );
    const ids = (view.investigatePointers ?? []).map((p) => p.id).sort();
    expect(ids).toEqual(['export:viaKey', 'mod:viaValue']);
  });

  it('drops a backward-direction target (a consumer of the inspected node)', () => {
    const view = baseView();
    applyInvestigateTags(
      view,
      consumerRiskAnnotations(new Set(['mod:dep', 'mod:consumer'])),
      options({
        integrationPoints: 'mod:dep mod:consumer',
        dependsOnIds: new Set(['mod:dep']), // mod:consumer imports us, not the other way
        existingIds: new Set(['mod:dep', 'mod:consumer']),
      }),
    );
    expect((view.investigatePointers ?? []).map((p) => p.id)).toEqual(['mod:dep']);
  });

  it('does not surface a dependency without consumer-scoped risk', () => {
    const view = baseView();
    applyInvestigateTags(
      view,
      consumerRiskAnnotations(new Set()), // no consumer risk anywhere
      options({
        integrationPoints: 'mod:dep',
        dependsOnIds: new Set(['mod:dep']),
        existingIds: new Set(['mod:dep']),
      }),
    );
    expect(view.investigatePointers).toBeUndefined();
  });

  it('drops unknown / non-nodeId tokens', () => {
    const view = baseView();
    applyInvestigateTags(
      view,
      consumerRiskAnnotations(new Set(['mod:real'])),
      options({
        integrationPoints: 'mod:real mod:ghost plainWord camelCaseName',
        dependsOnIds: new Set(['mod:real', 'mod:ghost']),
        existingIds: new Set(['mod:real']), // mod:ghost not in graph
      }),
    );
    expect((view.investigatePointers ?? []).map((p) => p.id)).toEqual(['mod:real']);
  });

  it('dedups a target the structural channel already owns', () => {
    const view = baseView();
    view.links = [{ targetId: 'mod:shared', relation: 'imports', label: 'shared' }];
    applyInvestigateTags(
      view,
      consumerRiskAnnotations(new Set(['mod:shared'])),
      options({
        integrationPoints: 'mod:shared',
        dependsOnIds: new Set(['mod:shared']),
        existingIds: new Set(['mod:shared']),
      }),
    );
    expect(view.links[0].investigate).toEqual(['risk']); // tagged on the structural edge
    expect(view.investigatePointers).toBeUndefined(); // not duplicated as a pointer
  });

  it('shares the per-response cap across links and investigatePointers (structural wins ties)', () => {
    const linkIds = Array.from({ length: MAX_INVESTIGATE_REFS }, (_, i) => `mod:link${i}`);
    const pointerIds = ['mod:p0', 'mod:p1'];
    const allRisk = new Set([...linkIds, ...pointerIds]);
    const view = baseView();
    view.links = linkIds.map((id) => ({ targetId: id, relation: 'imports' as const, label: id }));
    applyInvestigateTags(
      view,
      consumerRiskAnnotations(allRisk),
      options({
        integrationPoints: pointerIds.join(' '),
        dependsOnIds: new Set(pointerIds),
        existingIds: allRisk,
      }),
    );
    // All 12 cap slots go to the structural links (collected first); pointers are dropped.
    expect(view.links.filter((l) => l.investigate?.length)).toHaveLength(MAX_INVESTIGATE_REFS);
    expect(view.investigatePointers ?? []).toHaveLength(0);
    expect(view.investigateTruncated).toEqual({
      shownRefs: MAX_INVESTIGATE_REFS,
      totalRefs: MAX_INVESTIGATE_REFS + pointerIds.length,
    });
  });
});
