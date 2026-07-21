import { parseIntegrationPointTargets } from '../../annotations/carrier-links.js';
import { HUB_IMPORTER_FLOOR, DELIVERY_MECHANICS, DELIVERY_MECHANIC_PRIORITY } from '../../mechanics/registry.js';
import type { DeliveryMechanicContext } from '../../mechanics/types.js';
import type { AnnotationContent, EdgeKind, InvestigateTag, NodeViewDetail, RepositoryGraph } from '../../types.js';

type AnnotationLookup = {
  get(nodeId: string): { annotation: AnnotationContent } | undefined;
};

/** Tag priority, highest first — registry order (`mechanics/registry.ts`). Used to keep the strongest tags when a cap bites. */
export const INVESTIGATE_PRIORITY: readonly InvestigateTag[] = DELIVERY_MECHANIC_PRIORITY;

/**
 * Re-exported from the hub mechanic (`mechanics/registry.ts`): the floor under the adaptive
 * threshold, so a tiny repo still needs a real count. The live threshold is
 * `max(HUB_IMPORTER_FLOOR, percentile)` — an absolute floor alone floods a large monorepo
 * (every barrel/type clears 8).
 */
export { HUB_IMPORTER_FLOOR } from '../../mechanics/registry.js';
/** Percentile of the import in-degree distribution at/above which a target is a `hub`. */
export const HUB_PERCENTILE = 0.95;
/** Max `hub`-tagged refs per response; `hub` is advisory, so a hard cap stops it flooding. */
export const MAX_HUB_REFS = 2;
/** Max `wiring`-tagged refs per response; topology-driven advisory tag, capped like `hub`. */
export const MAX_WIRING_REFS = 2;
/** Max `co-change`-tagged refs per response; topology-driven advisory tag, capped like `hub`. */
export const MAX_CO_CHANGE_REFS = 2;

/**
 * Per-response caps for the advisory structural tags. Excess carriers lose only the capped tag;
 * `hub` keeps the highest-importer refs, the topology-edge tags keep collection order.
 */
const STRUCTURAL_REF_CAPS: ReadonlyArray<{ tag: InvestigateTag; cap: number }> = [
  { tag: 'hub', cap: MAX_HUB_REFS },
  { tag: 'wiring', cap: MAX_WIRING_REFS },
  { tag: 'co-change', cap: MAX_CO_CHANGE_REFS },
];

/**
 * Adaptive `hub` threshold: `max(HUB_IMPORTER_FLOOR, p95(import in-degree))`. One O(N) pass over
 * `inEdges` counting `imports` in-degree per target (degree ≥ 1 only), then the percentile. Self-scales
 * to repo size; the per-request `hub` check stays 1-hop against this cached number. Memoized by the
 * caller on the graph, so it runs once per graph build, not per request.
 */
export function computeHubInDegreeThreshold(graph: RepositoryGraph): number {
  const degrees: number[] = [];
  for (const edges of graph.inEdges.values()) {
    let n = 0;
    for (const edge of edges) if (edge.kind === 'imports') n++;
    if (n > 0) degrees.push(n);
  }
  if (degrees.length === 0) return HUB_IMPORTER_FLOOR;
  degrees.sort((a, b) => a - b);
  const idx = Math.min(degrees.length - 1, Math.floor(degrees.length * HUB_PERCENTILE));
  return Math.max(HUB_IMPORTER_FLOOR, degrees[idx]);
}

/** Max tags surfaced on a single ref. */
export const MAX_INVESTIGATE_TAGS_PER_REF = 3;
/** Max refs across one response that carry investigate tags. */
export const MAX_INVESTIGATE_REFS = 12;
/** Forward-import-closure depth for the integrationPoints direction guard. */
export const INVESTIGATE_DEP_GUARD_DEPTH = 4;

/**
 * Extra inputs for the integrationPoints carrier channel. Absent → the channel is a no-op and only
 * structural (`links`/`drill_down`) refs are tagged, matching the legacy 2-arg behavior.
 */
export type InvestigateOptions = {
  /** The inspected node's own annotation; `integrationPoints` is the carrier source. */
  selfAnnotation?: AnnotationContent;
  /** Direction guard: true when the inspected node transitively depends on `targetId`. */
  dependsOn?: (targetId: string) => boolean;
  /** Graph membership test; unknown tokens parsed from prose are dropped. */
  nodeExists?: (id: string) => boolean;
  /** 1-hop `imports` in-edge count for a target; feeds the `hub` tag. Absent → `hub` never fires. */
  importerCount?: (targetId: string) => number;
  /** Adaptive `hub` threshold (see {@link computeHubInDegreeThreshold}); falls back to `HUB_IMPORTER_FLOOR`. */
  hubThreshold?: number;
  /** 1-hop kind+direction edge count; feeds the `wiring`/`co-change` tags. Absent → they never fire. */
  edgeCount?: (id: string, kind: EdgeKind, dir: 'in' | 'out') => number;
};

/** Salience weight of a tag, higher = stronger. Exported for the inspect_node child partition. */
export function priorityWeight(tag: InvestigateTag): number {
  const idx = INVESTIGATE_PRIORITY.indexOf(tag);
  return idx === -1 ? 0 : INVESTIGATE_PRIORITY.length - idx;
}

/**
 * Investigate tags carried by a 1-hop target: one registry pass, each mechanic reading its own
 * primitive from ctx (see `DELIVERY_MECHANICS` for the tag vocabulary and per-tag triggers). `unannotated`
 * stays reserved — its `detect` is always false. Caller re-orders and caps via {@link capTags}.
 */
function tagsForTarget(
  annotations: AnnotationLookup,
  nodeId: string,
  importerCount?: (id: string) => number,
  hubThreshold?: number,
  edgeCount?: (id: string, kind: EdgeKind, dir: 'in' | 'out') => number,
): InvestigateTag[] {
  const ctx: DeliveryMechanicContext = { nodeId, annotation: annotations.get(nodeId)?.annotation, importerCount, hubThreshold, edgeCount };
  const tags: InvestigateTag[] = [];
  for (const m of DELIVERY_MECHANICS) if (m.detect(ctx)) tags.push(m.id);
  return tags;
}

/** Order by priority and cap to the per-ref maximum. */
function capTags(tags: InvestigateTag[]): InvestigateTag[] {
  const ordered = [...tags].sort((a, b) => priorityWeight(b) - priorityWeight(a));
  return ordered.slice(0, MAX_INVESTIGATE_TAGS_PER_REF);
}

/**
 * Tag refs whose target carries an investigate reason (see {@link tagsForTarget} for the sources).
 *
 * Two channels share one priority-ordered cap:
 *   - structural: 1-hop `links` (imports) + `drill_down` (children) — target-side, no guard.
 *   - integrationPoints: deeper dependencies named in the inspected node's own annotation, kept only
 *     when the node transitively depends on them (direction guard) — surfaced as `investigatePointers`.
 *
 * Per-ref cap orders tags by priority; the per-response cap keeps the highest-priority refs (ties to
 * structural, which is collected first) and records `investigateTruncated` when refs were dropped.
 */
export function applyInvestigateTags(
  view: NodeViewDetail,
  annotations: AnnotationLookup,
  options?: InvestigateOptions,
): void {
  type Carrier = { targetId: string; assign: (tags: InvestigateTag[]) => void; tags: InvestigateTag[]; rank: number; order: number };
  const carriers: Carrier[] = [];
  let order = 0;

  const importerCount = options?.importerCount;
  const hubThreshold = options?.hubThreshold;
  const edgeCount = options?.edgeCount;
  const collect = (targetId: string, assign: (tags: InvestigateTag[]) => void): void => {
    const tags = capTags(tagsForTarget(annotations, targetId, importerCount, hubThreshold, edgeCount));
    if (tags.length === 0) return;
    const rank = Math.max(...tags.map(priorityWeight));
    carriers.push({ targetId, assign, tags, rank, order: order++ });
  };

  if (view.links) {
    for (const link of view.links) collect(link.targetId, (tags) => { link.investigate = tags; });
  }
  for (const child of view.drill_down) {
    collect(child.id, (tags) => { child.investigate = tags; });
  }

  // integrationPoints carriers: only when a direction guard is supplied. Same trigger, same cap.
  const pointers: NonNullable<NodeViewDetail['investigatePointers']> = [];
  if (options?.selfAnnotation && options.dependsOn) {
    const dependsOn = options.dependsOn;
    const nodeExists = options.nodeExists ?? (() => true);
    const structuralIds = new Set<string>([
      ...(view.links?.map((l) => l.targetId) ?? []),
      ...view.drill_down.map((c) => c.id),
    ]);
    for (const id of parseIntegrationPointTargets(options.selfAnnotation.integrationPoints, { nodeExists })) {
      if (structuralIds.has(id)) continue; // structural channel owns it
      if (!dependsOn(id)) continue; // direction guard: inherit only from what we depend on
      collect(id, (tags) => { pointers.push({ id, investigate: tags, via: 'integrationPoints', hops: 1 }); });
    }
  }

  if (carriers.length === 0) return;

  const kept = [...carriers]
    .sort((a, b) => (b.rank - a.rank) || (a.order - b.order))
    .slice(0, MAX_INVESTIGATE_REFS);

  // Advisory-tag caps: hub/wiring/co-change are advisory; keep each on at most its cap of refs so
  // they never flood. `hub` keeps the highest-importer refs (importerCount is present whenever hub
  // fires); the topology-edge tags keep collection order — first-collected carriers win, so a ref
  // whose only signal is the tag is not silently emptied in favor of an already-elevated ref.
  // Strip the capped tag from the rest; a ref left with no tags is simply not assigned.
  for (const { tag, cap } of STRUCTURAL_REF_CAPS) {
    const withTag = kept.filter((c) => c.tags.includes(tag));
    if (withTag.length <= cap) continue;
    const ranked = tag === 'hub' && importerCount
      ? [...withTag].sort((a, b) => importerCount(b.targetId) - importerCount(a.targetId))
      : [...withTag].sort((a, b) => a.order - b.order);
    for (const carrier of ranked.slice(cap)) carrier.tags = carrier.tags.filter((t) => t !== tag);
  }

  let shownRefs = 0;
  for (const carrier of kept) {
    if (carrier.tags.length > 0) {
      carrier.assign(carrier.tags);
      shownRefs++;
    }
  }

  if (pointers.length > 0) view.investigatePointers = pointers;

  if (carriers.length > kept.length) {
    view.investigateTruncated = { shownRefs, totalRefs: carriers.length };
  }
}
