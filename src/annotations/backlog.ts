/**
 * The annotation backlog, walked once.
 *
 * Two questions are asked about the same surface: "what should be annotated next" and "how much is
 * annotated and current". They are one walk here — over modules, templates, IaC modules, runtime
 * resources and domains — because a node that the queue does not list must not be reported as work
 * by coverage, and the only way to guarantee that is to decide it in one place.
 *
 * Each node gets one entry filter, one freshness verdict ({@link ./freshness.js}) and one bucket.
 * Needs-work nodes also get a {@link BacklogRow}; item text is built by `hydrate` so a caller that
 * only counts never pays for prose.
 */
import { compareCodeUnits } from '../platform/ordering.js';
import type {
  ModuleInfo,
  RepositoryFactsSnapshot,
  RepositoryGraph,
  StoredAnnotation,
  TemplateFileInfo,
} from '../types.js';
import { CURRENT_ANNOTATION_SCHEMA_VERSION } from '../types.js';
import type { PropagationConfig } from '../config.js';
import { DEFAULT_PROPAGATION_CONFIG } from '../config.js';
import type { EntrypointFragment } from '../interpreter/types.js';
import { annotationFreshness, type FreshnessVerdict, type StaleReason } from './freshness.js';
import {
  nodeContentHashLookup,
  resolveCachedDomainContentHash,
  resolveLeafNodeContentHash,
  type DomainContentHashCache,
} from './content-hash.js';
import { getParentInfraModuleId } from './service-resource-hash.js';
import { domainLabelFromId, domainNodeId } from '../graph/node-ids.js';
import { domainLabel, domainMembers, importerCount, isPackageOnlyDomain, moduleLabelOf, nodeLabel, nodesOfType, taggedDomains } from '../graph/index.js';
import { computeEntrypointBoundedDerived, getImportBaselineStaleUpstream } from './propagation.js';
import { inferModuleKind, recommendedFieldsForKind, type ModuleKind } from './module-kind.js';
import { computeAnnotationQuality } from './quality.js';

// ── Queue vocabulary ──

export type QueueStatus = 'unannotated' | 'stale';
export type StaleKind = 'content' | 'propagation';

export type ModuleQueueClassification =
  | { status: 'unannotated' }
  | { status: 'stale'; staleKind: StaleKind };

/**
 * Review depth for a stale reason. Content and schema both mean "rewrite the note"; propagation
 * means "re-confirm what it says about upstream", which is the shallower pass.
 */
export function staleKindForReason(reason: StaleReason): StaleKind {
  return reason === 'propagation' ? 'propagation' : 'content';
}

/**
 * What a freshness verdict means for the queue. `null` is "no work": the annotation is confirmed,
 * or the node carries no hash to confirm it against and the queue has nothing to ask for.
 */
export function classifyStale(verdict: FreshnessVerdict): ModuleQueueClassification | null {
  switch (verdict.state) {
    case 'unannotated': return { status: 'unannotated' };
    case 'stale': return { status: 'stale', staleKind: staleKindForReason(verdict.reason) };
    case 'fresh':
    case 'not-comparable':
      return null;
  }
}

export function isPropagationStaleItem(item: { status: string; staleKind?: StaleKind }): boolean {
  return item.status === 'stale' && item.staleKind === 'propagation';
}

export function isContentStaleItem(item: { status: string; staleKind?: StaleKind }): boolean {
  return item.status === 'stale' && item.staleKind !== 'propagation';
}

export type QueuePhase = 'module' | 'template' | 'runtime-resource' | 'infra' | 'domain';

/** Node kinds the backlog walks, in the order the queue ranks them. */
export const BACKLOG_PHASES: readonly QueuePhase[] = ['module', 'template', 'runtime-resource', 'infra', 'domain'];

export interface QueueItem {
  nodeId: string;
  label: string;
  status: QueueStatus;
  /** Present when status is stale; content vs propagation review depth. */
  staleKind?: StaleKind;
  domains: string[];
  priority: number;
  reason: string;
  moduleKind?: ModuleKind;
  recommendedFields?: string[];
  context: {
    exportCount: number;
    topExports: Array<{ name: string; kind: string; signature?: string }>;
    downstreamCount: number;
    totalLines: number;
    /** Module dependency depth used for first-run bottom-up annotation ordering. */
    dependencyDepth?: number;
    /** Queue phase used to keep aggregates after lower-level notes. */
    annotationPhase?: QueuePhase;
    /** Direct imports whose contentHash differs from importBaseline (propagation-stale modules). */
    upstreamTriggers?: string[];
    staleKind?: StaleKind;
  };
}

interface QueueSortMeta {
  statusRank: number;
  phaseRank: number;
  dependencyDepth: number;
  domainDepth: number;
  urgency: number;
}

/**
 * One needs-work node: classification and sort key are computed during the walk, the full
 * {@link QueueItem} only when `hydrate` is called. Health, compliance and coverage paths count and
 * rank without materializing item text.
 */
export interface BacklogRow {
  nodeId: string;
  status: QueueStatus;
  staleKind?: StaleKind;
  phase: QueuePhase;
  _sort: QueueSortMeta;
  hydrate: () => QueueItem;
}

// ── Coverage vocabulary ──

/**
 * One node kind's share of the backlog.
 *
 * `total` counts in-scope nodes of the kind and stays a repo-wide fact when no scope is set.
 * `unconfirmable` counts the nodes the backlog asks no freshness question about — a resource with no
 * hash source, a template with no graph node, a package-only domain under `path-only` staleness — so
 * they are visible without being reported as work. The four verdict buckets close over the total:
 * `total === fresh + stale + unannotated + unconfirmable`.
 */
export interface KindCoverage {
  total: number;
  /** In-scope nodes of this kind carrying a stored note, including unconfirmable ones. */
  annotated: number;
  fresh: number;
  stale: number;
  unannotated: number;
  unconfirmable: number;
}

export interface DomainTierCoverage {
  domains: string[];
  totalModules: number;
}

export interface BacklogCoverage {
  modules: KindCoverage;
  templates: KindCoverage;
  infraModules: KindCoverage;
  services: KindCoverage;
  /** Domain roll-up nodes; `list` names the annotated ones. */
  domains: KindCoverage & { list: string[] };
  /** Per-domain-label coverage of the nodes tagged to it (domain roll-up nodes excluded). */
  byDomain: Record<string, KindCoverage>;
  /** Tier census over every domain node in the graph — a structural fact, never scoped. */
  byTier: Record<string, DomainTierCoverage>;
}

export interface AnnotationBacklog {
  /** Needs-work rows in walk order; sort with {@link sortBacklogRows} for queue order. */
  rows: BacklogRow[];
  coverage: BacklogCoverage;
}

export interface AnnotationQueuePage {
  items: QueueItem[];
  /** The whole backlog in scope; `counts.needsWork` is what a drain runs to zero. */
  counts: BacklogCounts;
  /** The slice the caller's filters left; `displayCounts.needsWork` is what this page pages through. */
  displayCounts: BacklogCounts;
  byType: BacklogPhaseCounts;
}

export interface BacklogCounts {
  /** Total needs-work nodes (unannotated + content-stale + propagation-stale). */
  needsWork: number;
  stale: number;
  staleContent: number;
  stalePropagation: number;
  unannotated: number;
}

// ── Ranking ──

const STATUS_RANK: Record<QueueStatus, number> = {
  stale: 3,
  unannotated: 1,
};

/** Content-stale (own hash drift) sorts above propagation-stale (importBaseline). */
const CONTENT_STALE_KIND_RANK = STATUS_RANK.stale;
const PROPAGATION_STALE_KIND_RANK = 2;

const PHASE_RANK: Record<QueuePhase, number> = {
  module: 5,
  template: 4,
  'runtime-resource': 3,
  infra: 2,
  domain: 1,
};

function statusRankForItem(status: QueueStatus, staleKind?: StaleKind): number {
  if (status === 'stale' && staleKind === 'propagation') return PROPAGATION_STALE_KIND_RANK;
  if (status === 'stale' && staleKind === 'content') return CONTENT_STALE_KIND_RANK;
  return STATUS_RANK[status];
}

function queuePriority(
  status: QueueStatus,
  phase: QueuePhase,
  dependencyDepth: number,
  domainDepth: number,
  urgency: number,
  staleKind?: StaleKind,
): number {
  return (statusRankForItem(status, staleKind) * 1_000_000)
    + (PHASE_RANK[phase] * 100_000)
    - (Math.min(dependencyDepth, 100) * 1_000)
    + (domainDepth * 100)
    + urgency;
}

function compareQueueItems(a: BacklogRow, b: BacklogRow): number {
  return b._sort.statusRank - a._sort.statusRank
    || b._sort.phaseRank - a._sort.phaseRank
    || a._sort.dependencyDepth - b._sort.dependencyDepth
    || b._sort.domainDepth - a._sort.domainDepth
    || b._sort.urgency - a._sort.urgency
    || compareCodeUnits(a.nodeId, b.nodeId);
}

/** Queue order: content-stale first, then phase, then bottom-up by dependency depth. Sorts in place. */
export function sortBacklogRows(rows: BacklogRow[]): BacklogRow[] {
  return rows.sort(compareQueueItems);
}

/** The one row tally. Every counter a caller publishes about the queue comes from here. */
export function countBacklogRows(rows: readonly BacklogRow[]): BacklogCounts {
  const counts: BacklogCounts = { needsWork: rows.length, stale: 0, staleContent: 0, stalePropagation: 0, unannotated: 0 };
  for (const row of rows) {
    if (row.status === 'unannotated') {
      counts.unannotated++;
    } else if (row.staleKind === 'propagation') {
      counts.stale++;
      counts.stalePropagation++;
    } else {
      counts.stale++;
      counts.staleContent++;
    }
  }
  return counts;
}

/**
 * The five kind buckets, enumerated once.
 *
 * Every roll-up over the annotatable surface reads them from here: a hand-written sum is how a new
 * node kind gets counted by the queue and missed by coverage, which the typechecker cannot see.
 */
export function backlogKindCoverages(coverage: BacklogCoverage): KindCoverage[] {
  return [coverage.modules, coverage.templates, coverage.infraModules, coverage.services, coverage.domains];
}

/** The whole annotatable surface as one bucket. */
export function rollUpCoverage(coverage: BacklogCoverage): KindCoverage {
  const out = emptyKindCoverage();
  for (const kind of backlogKindCoverages(coverage)) {
    out.total += kind.total;
    out.annotated += kind.annotated;
    out.fresh += kind.fresh;
    out.stale += kind.stale;
    out.unannotated += kind.unannotated;
    out.unconfirmable += kind.unconfirmable;
  }
  return out;
}

/** Nodes a drain still has to touch: notes to rewrite or re-confirm, plus nodes with no note. */
export function needsWorkOf(coverage: KindCoverage): number {
  return coverage.stale + coverage.unannotated;
}

/**
 * Nodes the backlog does ask about — the denominator a drain converges on. Excludes
 * `unconfirmable`, so coverage reaches 100% exactly when the queue reaches zero.
 */
export function answerableOf(coverage: KindCoverage): number {
  return coverage.total - coverage.unconfirmable;
}

/**
 * A coverage bucket as tools publish it. `unconfirmable` is emitted only where it exists, so a repo
 * whose every node carries a freshness question reads the four verdict buckets it always did.
 */
export interface PublishedCoverageBucket {
  total: number;
  annotated: number;
  fresh: number;
  stale: number;
  unannotated: number;
  unconfirmable?: number;
}

export function publishedCoverageBucket(kind: KindCoverage): PublishedCoverageBucket {
  return {
    total: kind.total,
    annotated: kind.annotated,
    fresh: kind.fresh,
    stale: kind.stale,
    unannotated: kind.unannotated,
    ...(kind.unconfirmable > 0 ? { unconfirmable: kind.unconfirmable } : {}),
  };
}

/** The domain bucket, whose published count key is `totalDomains` rather than `total`. */
export function publishedDomainCoverage(
  domains: KindCoverage,
): Omit<PublishedCoverageBucket, 'total'> & { totalDomains: number } {
  const { total, ...rest } = publishedCoverageBucket(domains);
  return { totalDomains: total, ...rest };
}

export type BacklogPhaseCounts = Record<QueuePhase, number>;

export function countBacklogPhases(rows: readonly BacklogRow[]): BacklogPhaseCounts {
  const byType = { module: 0, template: 0, 'runtime-resource': 0, infra: 0, domain: 0 };
  for (const row of rows) byType[row.phase]++;
  return byType;
}

/** Rows of one review depth: `propagation` for importBaseline review, `content` for a rewrite. */
export function filterRowsByStaleKind(rows: readonly BacklogRow[], staleKind: StaleKind): BacklogRow[] {
  return rows.filter(row => (staleKind === 'propagation'
    ? isPropagationStaleItem(row)
    : isContentStaleItem(row)));
}

// ── The walk ──

export interface BacklogInput {
  graph: RepositoryGraph;
  snapshot: RepositoryFactsSnapshot;
  annotations: Record<string, StoredAnnotation>;
  /** Domain scope; accepts `foo` or `domain:foo`. Applies to rows and coverage alike. */
  domain?: string;
  propagation?: PropagationConfig;
  entrypoints?: readonly EntrypointFragment[];
}

function emptyKindCoverage(): KindCoverage {
  return { total: 0, annotated: 0, fresh: 0, stale: 0, unannotated: 0, unconfirmable: 0 };
}

/**
 * Whether the domain roll-up asks a freshness question about this domain at all.
 *
 * Under `path-only` staleness a package-only domain's roll-up moves whenever any package member
 * moves, which says nothing about the domain note itself, so the backlog leaves it alone until
 * `packageDomainHardQueue` opts back in.
 */
function domainCarriesFreshnessQuestion(
  graph: RepositoryGraph,
  domainId: string,
  propagation: PropagationConfig,
): boolean {
  if (propagation.domainStalePolicy !== 'path-only' || propagation.packageDomainHardQueue) {
    return true;
  }
  const label = domainLabel(graph, domainId);
  if (label.includes('/')) return true;
  return !isPackageOnlyDomain(graph, domainId);
}

function templateQueuePreview(t: TemplateFileInfo): Array<{ name: string; kind: string }> {
  const out: Array<{ name: string; kind: string }> = [];
  if (t.extendsTemplate) out.push({ name: t.extendsTemplate, kind: 'extends' });
  for (const name of t.includesTemplate ?? []) out.push({ name, kind: 'includes' });
  for (const name of t.blocks ?? []) out.push({ name, kind: 'block' });
  return out.slice(0, 10);
}

function computeModuleDependencyDepths(graph: RepositoryGraph, moduleIds: Iterable<string>): Map<string, number> {
  const moduleSet = new Set(moduleIds);
  const cache = new Map<string, number>();
  const visiting = new Set<string>();

  const depthOf = (id: string): number => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;

    visiting.add(id);
    const internalDeps = (graph.outEdges.get(id) ?? [])
      .filter(edge => edge.kind === 'imports' && moduleSet.has(edge.to))
      .map(edge => edge.to);
    const depth = internalDeps.length === 0
      ? 0
      : 1 + Math.max(...internalDeps.map(depthOf));
    visiting.delete(id);
    cache.set(id, depth);
    return depth;
  };

  for (const id of moduleSet) depthOf(id);
  return cache;
}

/** Domain node ids and labels a node is tagged to, read once per node. */
/**
 * Walk the annotatable surface once, producing the needs-work rows and the coverage tallies that
 * must agree with them.
 */
export function buildAnnotationBacklog(input: BacklogInput): AnnotationBacklog {
  const {
    graph,
    snapshot,
    annotations,
    domain,
    propagation = DEFAULT_PROPAGATION_CONFIG,
    entrypoints = [],
  } = input;

  const scopedDomainId = domain
    ? domainNodeId(domainLabelFromId(domain))
    : undefined;
  const inScope = (domainIds: readonly string[]): boolean =>
    scopedDomainId === undefined || domainIds.includes(scopedDomainId);

  const rows: BacklogRow[] = [];
  const modules = emptyKindCoverage();
  const templatesCoverage = emptyKindCoverage();
  const infraCoverage = emptyKindCoverage();
  const services = emptyKindCoverage();
  const domainsCoverage: KindCoverage & { list: string[] } = { ...emptyKindCoverage(), list: [] };
  const byDomain: Record<string, KindCoverage> = {};
  const byTier: Record<string, DomainTierCoverage> = {
    business: { domains: [], totalModules: 0 },
    feature: { domains: [], totalModules: 0 },
    layer: { domains: [], totalModules: 0 },
    technical: { domains: [], totalModules: 0 },
  };

  /**
   * The one bucket decision. `asks` is false for a node the backlog poses no freshness question
   * about; every other node lands in exactly one verdict bucket, and only stale/unannotated
   * produce a queue row.
   */
  const tally = (
    coverage: KindCoverage,
    domainLabels: readonly string[],
    annotated: boolean,
    classified: ModuleQueueClassification | null,
    asks: boolean,
  ): void => {
    const buckets: KindCoverage[] = [coverage];
    for (const label of domainLabels) {
      buckets.push(byDomain[label] ??= emptyKindCoverage());
    }
    for (const bucket of buckets) {
      bucket.total++;
      if (annotated) bucket.annotated++;
      if (!asks) bucket.unconfirmable++;
      else if (classified === null) bucket.fresh++;
      else if (classified.status === 'unannotated') bucket.unannotated++;
      else bucket.stale++;
    }
  };

  const derivedStaleSet = computeEntrypointBoundedDerived({
    graph,
    snapshot,
    annotations,
    entrypoints,
    propagation,
  });
  const contentHashLookup = nodeContentHashLookup(snapshot);
  const moduleContentHashById = contentHashLookup.moduleContentHashById;
  const domainContentHashCache: DomainContentHashCache = new Map();
  const moduleDependencyDepths = computeModuleDependencyDepths(
    graph,
    snapshot.modules.map((mod: ModuleInfo) => mod.id),
  );

  // ── Code modules ──
  for (const mod of snapshot.modules) {
    const { ids: domainIds, labels: domains } = taggedDomains(graph, mod.id);
    if (!inScope(domainIds)) continue;

    const ann = annotations[mod.id];
    const verdict = annotationFreshness({
      annotation: ann,
      currentHash: mod.contentHash,
      propagationStale: derivedStaleSet.has(mod.id),
    });
    const classified = classifyStale(verdict);
    tally(modules, domains, ann !== undefined, classified, true);
    if (!classified) continue;

    const status = classified.status;
    const staleKind = classified.status === 'stale' ? classified.staleKind : undefined;

    // Priority inputs (sort key): downstream count, size, and quality.
    const downstreamCount = importerCount(graph, mod.id);
    const maxLine = mod.exports.reduce((m, e) => Math.max(m, e.lineRange.end), 0);
    const moduleKind = inferModuleKind({ mod, node: graph.nodes.get(mod.id) });
    const quality = ann
      ? computeAnnotationQuality(ann.annotation, {
        exportCount: mod.exports.length,
        lineCount: maxLine,
        envVars: mod.semanticHints?.envVars,
        moduleKind,
      })
      : null;
    const qualityScore = quality?.score ?? 0;
    const urgency = (downstreamCount * 2)
      + mod.exports.length
      + (maxLine / 200)
      - (qualityScore * 3);
    const dependencyDepth = moduleDependencyDepths.get(mod.id) ?? 0;
    const phase: QueuePhase = 'module';
    const isPropagationStale = staleKind === 'propagation';

    rows.push({
      nodeId: mod.id,
      status,
      ...(staleKind ? { staleKind } : {}),
      phase,
      _sort: {
        statusRank: statusRankForItem(status, staleKind),
        phaseRank: PHASE_RANK[phase],
        dependencyDepth,
        domainDepth: 0,
        urgency,
      },
      hydrate: () => {
        const topExports = mod.exports
          .slice(0, 10)
          .map(e => ({
            name: e.name,
            kind: e.kind,
            ...(e.signature ? { signature: e.signature } : {}),
          }));
        const priority = queuePriority(status, phase, dependencyDepth, 0, urgency, staleKind);

        let reason: string;
        if (status === 'stale' && staleKind === 'content') {
          reason = verdict.state === 'stale' && verdict.reason === 'schema'
            ? `Schema outdated (v${ann?.schemaVersion ?? 1} < v${CURRENT_ANNOTATION_SCHEMA_VERSION}), needs backfill (${downstreamCount} downstream deps)`
            : `Content changed since last annotation (${downstreamCount} downstream deps)`;
        } else if (isPropagationStale) {
          const staleUpstream = ann
            ? getImportBaselineStaleUpstream(ann, graph, snapshot, mod.id, moduleContentHashById)
            : [];
          const sample = staleUpstream.slice(0, 3).join(', ');
          const more = staleUpstream.length > 3 ? ` +${staleUpstream.length - 3} more` : '';
          reason = staleUpstream.length > 0
            ? `importBaseline stale (entrypoint-bounded) for upstream (${sample}${more}); review integrationPoints/dataFlow or refreshImportBaseline (${downstreamCount} downstream deps)`
            : `importBaseline review required (entrypoint-bounded, ${downstreamCount} downstream deps)`;
        } else {
          reason = `Not yet annotated (${downstreamCount} downstream deps, ${mod.exports.length} exports)`;
        }

        const recommendedFields = isPropagationStale
          ? []
          : quality
            ? quality.missingFields
            : Array.from(recommendedFieldsForKind(moduleKind));

        return {
          nodeId: mod.id,
          label: moduleLabelOf(graph, mod),
          status,
          ...(staleKind ? { staleKind } : {}),
          domains,
          priority,
          reason,
          moduleKind,
          context: {
            exportCount: mod.exports.length,
            topExports,
            downstreamCount,
            totalLines: maxLine,
            dependencyDepth,
            annotationPhase: phase,
            ...(isPropagationStale && ann
              ? {
                upstreamTriggers: getImportBaselineStaleUpstream(
                  ann,
                  graph,
                  snapshot,
                  mod.id,
                  moduleContentHashById,
                ),
                staleKind: 'propagation' as const,
              }
              : staleKind === 'content'
                ? { staleKind: 'content' as const }
                : {}),
          },
          ...(recommendedFields.length > 0 ? { recommendedFields } : {}),
        };
      },
    });
  }

  // ── Template/rendered-surface nodes — freshness from the template file content hash ──
  for (const t of snapshot.templates ?? []) {
    const { ids: domainIds, labels: domains } = taggedDomains(graph, t.id);
    if (!inScope(domainIds)) continue;

    const ann = annotations[t.id];
    // A template stage 1 discovered but no interpreter projected has no node to inspect or
    // annotate, so the backlog counts it without asking anything of it.
    const node = graph.nodes.get(t.id);
    if (!node || node.type !== 'template') {
      tally(templatesCoverage, domains, ann !== undefined, null, false);
      continue;
    }

    const verdict = annotationFreshness({ annotation: ann, currentHash: t.contentHash });
    const classified = classifyStale(verdict);
    tally(templatesCoverage, domains, ann !== undefined, classified, true);
    if (!classified) continue;
    const status = classified.status;

    const outEdges = graph.outEdges.get(t.id) ?? [];
    const inEdges = graph.inEdges.get(t.id) ?? [];
    const renderCount = inEdges.filter(e => e.kind === 'renders').length;
    const compositionInCount = inEdges.filter(e => e.kind === 'extends' || e.kind === 'includes').length;
    const compositionOutCount = outEdges.filter(e => e.kind === 'extends' || e.kind === 'includes').length;
    const topExports = templateQueuePreview(t);
    const urgency = (renderCount * 2) + compositionInCount + compositionOutCount + (t.blocks?.length ?? 0);
    const phase: QueuePhase = 'template';
    const reason = status === 'stale'
      ? (verdict.state === 'stale' && verdict.reason === 'schema'
        ? `Schema outdated (v${ann?.schemaVersion ?? 1} < v${CURRENT_ANNOTATION_SCHEMA_VERSION})`
        : 'Template content changed')
      : `Template not yet annotated (${renderCount} render edge${renderCount === 1 ? '' : 's'}, ${compositionOutCount} composition edge${compositionOutCount === 1 ? '' : 's'})`;

    const templateKind: ModuleKind = 'template';
    const templateStaleKind = classified.status === 'stale' ? classified.staleKind : undefined;
    rows.push({
      nodeId: t.id,
      status,
      ...(templateStaleKind ? { staleKind: templateStaleKind } : {}),
      phase,
      _sort: {
        statusRank: statusRankForItem(status, templateStaleKind),
        phaseRank: PHASE_RANK[phase],
        dependencyDepth: 0,
        domainDepth: 0,
        urgency,
      },
      hydrate: () => ({
        nodeId: t.id,
        label: node.label,
        status,
        ...(templateStaleKind ? { staleKind: templateStaleKind } : {}),
        domains,
        priority: queuePriority(status, phase, 0, 0, urgency, templateStaleKind),
        reason,
        moduleKind: templateKind,
        recommendedFields: Array.from(recommendedFieldsForKind(templateKind)),
        context: {
          exportCount: topExports.length,
          topExports,
          downstreamCount: renderCount + compositionInCount,
          totalLines: 0,
          annotationPhase: phase,
          ...(templateStaleKind ? { staleKind: templateStaleKind } : {}),
        },
      }),
    });
  }

  // ── Infra modules (IaC: SAM/CloudFormation, etc.) ──
  for (const infraMod of snapshot.infraModules ?? []) {
    const { ids: domainIds, labels: domains } = taggedDomains(graph, infraMod.id);
    if (!inScope(domainIds)) continue;

    const ann = annotations[infraMod.id];
    const verdict = annotationFreshness({ annotation: ann, currentHash: infraMod.contentHash });
    const classified = classifyStale(verdict);
    tally(infraCoverage, domains, ann !== undefined, classified, true);
    if (!classified) continue;
    const status = classified.status;

    const resourceCount = infraMod.resources.length;
    const urgency = resourceCount;
    const phase: QueuePhase = 'infra';
    const reason = status === 'stale'
      ? (verdict.state === 'stale' && verdict.reason === 'schema'
        ? `Schema outdated (v${ann?.schemaVersion ?? 1} < v${CURRENT_ANNOTATION_SCHEMA_VERSION})`
        : 'IaC template content changed')
      : `IaC module not yet annotated (${resourceCount} resources)`;

    const infraKind: ModuleKind = 'infra';
    const infraStaleKind = classified.status === 'stale' ? classified.staleKind : undefined;
    rows.push({
      nodeId: infraMod.id,
      status,
      ...(infraStaleKind ? { staleKind: infraStaleKind } : {}),
      phase,
      _sort: {
        statusRank: statusRankForItem(status, infraStaleKind),
        phaseRank: PHASE_RANK[phase],
        dependencyDepth: 0,
        domainDepth: 0,
        urgency,
      },
      hydrate: () => ({
        nodeId: infraMod.id,
        label: moduleLabelOf(graph, infraMod),
        status,
        ...(infraStaleKind ? { staleKind: infraStaleKind } : {}),
        domains,
        priority: queuePriority(status, phase, 0, 0, urgency, infraStaleKind),
        reason,
        moduleKind: infraKind,
        recommendedFields: Array.from(recommendedFieldsForKind(infraKind)),
        context: {
          exportCount: resourceCount,
          topExports: infraMod.resources.slice(0, 10).map(r => ({ name: r.id, kind: r.kind })),
          downstreamCount: resourceCount,
          totalLines: 0,
          annotationPhase: phase,
          ...(infraStaleKind ? { staleKind: infraStaleKind } : {}),
        },
      }),
    });
  }

  // ── Runtime-resource nodes — freshness from the per-resource IaC fragment hash ──
  for (const serviceId of nodesOfType(graph, 'runtime-resource')) {
    // A runtime resource carries its parent IaC module's domain tags; a resource projected without
    // a parent carries none, which under a domain scope puts it outside.
    const parentInfraId = getParentInfraModuleId(graph, serviceId);
    const { ids: domainIds, labels: domains } = parentInfraId
      ? taggedDomains(graph, parentInfraId)
      : { ids: [], labels: [] };
    if (!inScope(domainIds)) continue;

    const ann = annotations[serviceId];
    const resourceHash = resolveLeafNodeContentHash(serviceId, {
      graph,
      snapshot,
      lookup: contentHashLookup,
    });
    // No hash source for this resource: an annotation on it could never be confirmed, so the
    // backlog has nothing to ask for and does not rank it.
    if (resourceHash === undefined) {
      tally(services, domains, ann !== undefined, null, false);
      continue;
    }

    const verdict = annotationFreshness({ annotation: ann, currentHash: resourceHash });
    const classified = classifyStale(verdict);
    tally(services, domains, ann !== undefined, classified, true);
    if (!classified) continue;
    const status = classified.status;

    const urgency = 1;
    const phase: QueuePhase = 'runtime-resource';
    const reason = status === 'stale'
      ? (verdict.state === 'stale' && verdict.reason === 'schema' ? 'Schema outdated' : 'IaC resource definition changed')
      : 'Runtime resource not yet annotated';

    const serviceKind: ModuleKind = 'runtime-resource';
    const serviceStaleKind = classified.status === 'stale' ? classified.staleKind : undefined;
    rows.push({
      nodeId: serviceId,
      status,
      ...(serviceStaleKind ? { staleKind: serviceStaleKind } : {}),
      phase,
      _sort: {
        statusRank: statusRankForItem(status, serviceStaleKind),
        phaseRank: PHASE_RANK[phase],
        dependencyDepth: 0,
        domainDepth: 0,
        urgency,
      },
      hydrate: () => ({
        nodeId: serviceId,
        label: nodeLabel(graph, serviceId),
        status,
        ...(serviceStaleKind ? { staleKind: serviceStaleKind } : {}),
        domains,
        priority: queuePriority(status, phase, 0, 0, urgency, serviceStaleKind),
        reason,
        moduleKind: serviceKind,
        recommendedFields: Array.from(recommendedFieldsForKind(serviceKind)),
        context: {
          exportCount: 0,
          topExports: [],
          downstreamCount: 0,
          totalLines: 0,
          annotationPhase: phase,
          ...(serviceStaleKind ? { staleKind: serviceStaleKind } : {}),
        },
      }),
    });
  }

  // ── Domain nodes — freshness derived from member content hashes ──
  // A domain annotation becomes stale when a member it rolls up changed: changes percolate up to
  // the containing domain, and for a domain there is no distinct "code" to compare instead.
  for (const domainId of nodesOfType(graph, 'domain')) {
    const node = graph.nodes.get(domainId);
    const label = domainLabel(graph, domainId);
    const memberCount = domainMembers(graph, domainId).all.length;

    // Tier census covers every domain node in the graph, scoped or not.
    const tier = (node?.type === 'domain' && node.data?.tier) ? node.data.tier : 'technical';
    byTier[tier].domains.push(label);
    byTier[tier].totalModules += memberCount;

    // A scoped query surfaces that domain node only, never its peers.
    if (scopedDomainId !== undefined && domainId !== scopedDomainId) continue;

    const ann = annotations[domainId];
    if (ann) domainsCoverage.list.push(label);

    const currentHash = domainCarriesFreshnessQuestion(graph, domainId, propagation)
      ? resolveCachedDomainContentHash(
        graph,
        snapshot,
        domainId,
        propagation,
        contentHashLookup,
        domainContentHashCache,
      )
      : undefined;
    // Either the staleness policy asks nothing of this domain, or no member resolves to a hash.
    if (currentHash === undefined) {
      tally(domainsCoverage, [], ann !== undefined, null, false);
      continue;
    }

    const verdict = annotationFreshness({ annotation: ann, currentHash });
    const classified = classifyStale(verdict);
    tally(domainsCoverage, [], ann !== undefined, classified, true);
    if (!classified) continue;
    const status = classified.status;

    const urgency = Math.min(memberCount, 50);
    const phase: QueuePhase = 'domain';
    const domainDepth = label.split('/').filter(Boolean).length;
    const reason = status === 'stale'
      ? (verdict.state === 'stale' && verdict.reason === 'schema'
        ? `Schema outdated (v${ann?.schemaVersion ?? 1} < v${CURRENT_ANNOTATION_SCHEMA_VERSION})`
        : `Domain member changed; re-check domain-level summary, invariants and integrationPoints (${memberCount} members)`)
      : `Domain not yet annotated (${memberCount} members)`;

    const domainKind: ModuleKind = 'domain';
    const domainStaleKind = classified.status === 'stale' ? classified.staleKind : undefined;
    rows.push({
      nodeId: domainId,
      status,
      ...(domainStaleKind ? { staleKind: domainStaleKind } : {}),
      phase,
      _sort: {
        statusRank: statusRankForItem(status, domainStaleKind),
        phaseRank: PHASE_RANK[phase],
        dependencyDepth: 0,
        domainDepth,
        urgency,
      },
      hydrate: () => ({
        nodeId: domainId,
        label,
        status,
        ...(domainStaleKind ? { staleKind: domainStaleKind } : {}),
        domains: [],
        priority: queuePriority(status, phase, 0, domainDepth, urgency, domainStaleKind),
        reason,
        moduleKind: domainKind,
        recommendedFields: Array.from(recommendedFieldsForKind(domainKind)),
        context: {
          exportCount: memberCount,
          topExports: [],
          downstreamCount: memberCount,
          totalLines: 0,
          annotationPhase: phase,
          ...(domainStaleKind ? { staleKind: domainStaleKind } : {}),
        },
      }),
    });
  }

  return {
    rows,
    coverage: {
      modules,
      templates: templatesCoverage,
      infraModules: infraCoverage,
      services,
      domains: domainsCoverage,
      byDomain,
      byTier,
    },
  };
}
