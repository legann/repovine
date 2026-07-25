import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { StoredAnnotation, RepositoryGraph, RepositoryFactsSnapshot, ModuleInfo, TemplateFileInfo, GraphEdge } from '../types.js';
import { CURRENT_ANNOTATION_SCHEMA_VERSION } from '../types.js';
import { writeFileAtomic, writeFileAtomicSync } from '../fs/atomic.js';
import {
  buildRuntimeResourceContentHashLookup,
  resolveServiceResourceContentHash,
  getParentInfraModuleId,
  getParentInfraContentHash,
  getResourceContentHashForServiceId,
  type RuntimeResourceContentHashLookup,
} from './service-resource-hash.js';
import { ANNOTATIONS_FILENAME, resolveAnnotationsFilePath } from '../paths.js';
import { ensureEmptyAnnotationsFileAtPath, EMPTY_ANNOTATION_FILE_TEXT } from './maintenance.js';
import { writeAnnotationBackup } from './backup.js';
import {
  withAnnotationFileLockAsync,
  withAnnotationFileLockSync,
} from './file-lock.js';
import { inferModuleKind, recommendedFieldsForKind, type ModuleKind } from './module-kind.js';
import { detectSideEffectKindsFromHints } from './side-effect-vocab.js';
import { formatPipelineDetail, formatPipelineStatus, logPipeline, logPipelineWarn } from '../cli/ui.js';
import {
  AnnotationContentSchema,
  hydrateAnnotationMap,
  parseAnnotationFile,
  parseAnnotationsRawShape,
  serializeAnnotationFileFromRaw,
} from './format.js';
import type { PropagationConfig } from '../config.js';
import { DEFAULT_PROPAGATION_CONFIG } from '../config.js';
import type { EntrypointFragment } from '../interpreter/types.js';
import { computeEntrypointBoundedDerived } from './propagation.js';

export { AnnotationContentSchema };
export {
  computeEntrypointBoundedDerived,
  computePropagationPreview,
  buildPropagationSlice,
  collectEntrypointRoots,
  collectEntrypointRootsDiagnostics,
  computeDepCone,
  reachesEntrypoint,
  isHubContractDrift,
} from './propagation.js';
export type { PropagationConfig } from '../config.js';
export { DEFAULT_PROPAGATION_CONFIG };

// ── Annotation quality scoring ──

/**
 * Consistency is a SEPARATE axis from completeness (`score`/`tier`). It does not measure how
 * many fields are filled; it asks whether the fields that ARE filled contradict facts the graph
 * already knows (real export names, detected env vars, detected side effects). It is recomputable
 * from `annotation × current graph`, but it is a contradiction list, not a ladder — one
 * contradiction is enough to distrust — so it is `ok` + `issues[]`, never a number. It MUST NOT
 * affect `score`/`tier`.
 */
export interface AnnotationConsistency {
  ok: boolean;
  /** ONLY concrete contradictions with graph facts — never "field is empty" (that is completeness's job). */
  issues: Array<{
    field: 'keyExports' | 'envDependencies' | 'sideEffects';
    kind: 'unknown-name' | 'contradicts-hints';
    detail: string;
  }>;
}

export interface AnnotationQuality {
  /** Completeness only (0–10). UNCHANGED by the consistency axis. */
  score: number;
  missingFields: string[];
  tier: 'minimal' | 'basic' | 'detailed' | 'comprehensive';
  /** Module kind inferred from snapshot/graph (or 'generic' if not available). */
  moduleKind?: ModuleKind;
  /** Orthogonal axis: do the filled fields contradict graph facts? Recomputable; does NOT move score/tier. */
  consistency: AnnotationConsistency;
}

export interface AnnotationQualityInput {
  exportCount: number;
  lineCount: number;
  envVars?: string[];
  /** Optional kind override (computed by inferModuleKind). When omitted, scoring uses generic baseline. */
  moduleKind?: ModuleKind;
  /**
   * Ground truth for the consistency axis: the module's real export names (`mod.exports.map(e => e.name)`).
   * When absent, the keyExports consistency check is SKIPPED — never fabricate ground truth.
   */
  exportNames?: string[];
  /**
   * Ground truth for the consistency axis: side-effect kinds the graph can honestly detect from
   * SemanticHints (see `detectSideEffectKindsFromHints`). When absent, the declared-`pure`-vs-detected
   * check is SKIPPED — never fabricate detected effects.
   */
  detectedSideEffectKinds?: string[];
}

export type QueueStatus = 'unannotated' | 'stale';
export type StaleKind = 'content' | 'propagation';

export type ModuleQueueClassification =
  | { status: 'unannotated' }
  | { status: 'stale'; staleKind: StaleKind };

/** Classify module freshness for the annotation queue. */
export function classifyStale(input: {
  annotated: boolean;
  contentStale: boolean;
  schemaOutdated: boolean;
  isDerivedStale: boolean;
}): ModuleQueueClassification | null {
  if (!input.annotated) return { status: 'unannotated' };
  if (input.contentStale || input.schemaOutdated) {
    return { status: 'stale', staleKind: 'content' };
  }
  if (input.isDerivedStale) {
    return { status: 'stale', staleKind: 'propagation' };
  }
  return null;
}

export function isPropagationStaleItem(item: { status: string; staleKind?: StaleKind }): boolean {
  return item.status === 'stale' && item.staleKind === 'propagation';
}

export function isContentStaleItem(item: { status: string; staleKind?: StaleKind }): boolean {
  return item.status === 'stale' && item.staleKind !== 'propagation';
}

export type QueuePhase = 'module' | 'template' | 'runtime-resource' | 'infra' | 'domain';

interface QueueItem {
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
 * Lightweight queue row: classification + sort key are computed eagerly; the
 * full QueueItem (reason/context/recommendedFields/topExports) is built lazily
 * via `hydrate`, so health/compliance paths classify and count without
 * materializing every item. getQueue hydrates only the returned slice.
 */
interface QueueRow {
  nodeId: string;
  status: QueueStatus;
  staleKind?: StaleKind;
  phase: QueuePhase;
  _sort: QueueSortMeta;
  hydrate: () => QueueItem;
}

export interface AnnotationHealthCounts {
  /** Total needs-work nodes (unannotated + content-stale + propagation-stale). */
  needsWork: number;
  stale: number;
  staleContent: number;
  stalePropagation: number;
  unannotated: number;
}

export interface AnnotationHealthScanRow {
  nodeId: string;
  status: QueueStatus;
  staleKind?: StaleKind;
  /** Queue phase. domain/runtime-resource/infra are auto-derived aggregates. */
  phase: QueuePhase;
}

export interface AnnotationHealthSampleItem {
  nodeId: string;
  status: QueueStatus;
  staleKind?: StaleKind;
  moduleKind?: ModuleKind;
  reason: string;
}

/**
 * Single read-only pass over the annotatable surface (modules, templates,
 * infra, runtime-resources, domains). Shared by validate/compliance/status so
 * those paths build one lightweight scan instead of repeated full queues.
 */
export interface AnnotationHealthScan {
  counts: AnnotationHealthCounts;
  /** Needs-work rows sorted in the same priority order as getQueue. */
  rows: AnnotationHealthScanRow[];
  /**
   * Hydrate the top `limit` needs-work items (optionally restricted by
   * predicate), preserving getQueue ordering and the queueSample shape.
   */
  sample: (limit: number, predicate?: (row: AnnotationHealthScanRow) => boolean) => AnnotationHealthSampleItem[];
}

export interface AnnotationFileStatusSnapshot {
  exists: boolean;
  parseOk: boolean;
  hasConflictMarkers: boolean;
  annotationCount?: number;
  error?: string;
}

/**
 * What the last merge kept over the file, per branch of the never-lose net: `readded` for records the
 * file no longer had, `reverted` for records it had in a superseded version. Runtime state of one store
 * instance, so only an in-process reader sees it.
 */
export interface AnnotationMergeKeeps {
  readded: number;
  reverted: number;
  /** Bounded, so one large revert cannot flood a response. */
  sample: string[];
}

/** How many node ids a merge-keep report names before it falls back to the counts. */
const MERGE_KEEP_SAMPLE = 5;

/**
 * One sentence for a merge that kept records the file disagreed with, or undefined when it kept none.
 * The net exists so an interrupted save cannot lose a note, but it also silently outlives a deliberate
 * revert, so the message names that cause and how to make a revert stick.
 */
export function describeMergeKeeps(keeps: AnnotationMergeKeeps): string | undefined {
  const total = keeps.readded + keeps.reverted;
  if (total === 0) return undefined;
  const parts: string[] = [];
  if (keeps.readded > 0) parts.push(`${keeps.readded} the file no longer held`);
  if (keeps.reverted > 0) parts.push(`${keeps.reverted} the file held in an older version`);
  const more = total > keeps.sample.length ? ` (+${total - keeps.sample.length} more)` : '';
  return `Kept ${total} in-memory annotation(s) the file disagreed with — ${parts.join(', ')}: `
    + `${keeps.sample.join(', ')}${more}. A revert of the annotations file does not stick while this process `
    + 'holds the newer records; re-apply it after the process exits, or write the intended state through '
    + 'write_annotation / merge_annotations.';
}

export interface AnnotationQueuePage {
  items: QueueItem[];
  counts: {
    stale: number;
    staleContent: number;
    stalePropagation: number;
    unannotated: number;
  };
  displayCounts: {
    stale: number;
    staleContent: number;
    stalePropagation: number;
    unannotated: number;
  };
  byType: { module: number; template: number; 'runtime-resource': number; infra: number; domain: number };
  needsWork: number;
  totalRemaining: number;
}

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

function compareQueueItems(a: { _sort: QueueSortMeta; nodeId: string }, b: { _sort: QueueSortMeta; nodeId: string }): number {
  return b._sort.statusRank - a._sort.statusRank
    || b._sort.phaseRank - a._sort.phaseRank
    || a._sort.dependencyDepth - b._sort.dependencyDepth
    || b._sort.domainDepth - a._sort.domainDepth
    || b._sort.urgency - a._sort.urgency
    || a.nodeId.localeCompare(b.nodeId);
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

/**
 * Field weights, expressed once and reused by both score accumulation and
 * the "missing" recommendation list. Numbers reflect prior implicit weights
 * but are now centralized.
 */
const FIELD_WEIGHTS = {
  summary: 1,
  keyExports: 1.5,
  assumptions: 0.5,
  sideEffects: 1,
  risks: 1,
  patterns: 1,
  flowDescription: 1,
  invariants: 1,
  extensionPoints: 0.5,
  integrationPoints: 1,
  stateShape: 1,
  dataFlow: 2,
  envDependencies: 1,
} as const;

type ScorableField = keyof typeof FIELD_WEIGHTS;

function hasField(content: StoredAnnotation['annotation'], field: ScorableField): boolean {
  switch (field) {
    case 'summary': return !!content.summary && content.summary.length > 20;
    case 'keyExports': return !!content.keyExports && Object.keys(content.keyExports).length > 0;
    case 'assumptions': return !!content.assumptions?.length;
    case 'sideEffects': return !!content.sideEffects?.length;
    case 'risks': return !!content.risks?.length;
    case 'patterns': return !!content.patterns?.length;
    case 'flowDescription': return !!content.flowDescription;
    case 'invariants': return !!content.invariants?.length;
    case 'extensionPoints': return !!content.extensionPoints?.length;
    case 'integrationPoints': return content.integrationPoints != null
      && (typeof content.integrationPoints === 'string'
        ? content.integrationPoints.length > 0
        : Object.keys(content.integrationPoints).length > 0);
    case 'stateShape': return content.stateShape != null
      && (typeof content.stateShape === 'string'
        ? content.stateShape.length > 0
        : Object.keys(content.stateShape).length > 0);
    case 'dataFlow': return content.dataFlow != null
      && (typeof content.dataFlow === 'string'
        ? content.dataFlow.length > 0
        : Object.keys(content.dataFlow).length > 0);
    case 'envDependencies': return !!content.envDependencies
      && Object.keys(content.envDependencies).length > 0;
  }
}

/**
 * Pure consistency check: does the annotation content contradict facts the graph already knows?
 * Recomputable from `content × input` alone. Only fields the agent actually FILLED are checked —
 * an empty field is completeness's concern, never an issue here (so we never double-count). When a
 * check's ground truth is missing from `input`, that check is silently skipped (never fabricate).
 */
function computeConsistency(
  content: StoredAnnotation['annotation'],
  input: AnnotationQualityInput,
): AnnotationConsistency {
  const issues: AnnotationConsistency['issues'] = [];

  // keyExports — declared export names that the graph does not actually export (drift after refactor).
  // Skip when the module has no captured NAMED exports: re-export barrels (`export { X } from './y'`)
  // record an empty / `default`-only export set because stage1 does not resolve re-exports, so the
  // ground truth is absent — not "exports nothing". Flagging every key there is a false positive, so
  // we treat it like any other absent ground truth and skip (never fabricate a contradiction).
  if (content.keyExports && input.exportNames && input.exportNames.some(n => n !== 'default')) {
    const real = new Set(input.exportNames);
    for (const k of Object.keys(content.keyExports)) {
      if (!real.has(k)) issues.push({ field: 'keyExports', kind: 'unknown-name', detail: k });
    }
  }

  // envDependencies declared but not detected among the module's env vars.
  if (content.envDependencies && input.envVars) {
    const real = new Set(input.envVars);
    for (const k of Object.keys(content.envDependencies)) {
      if (!real.has(k)) issues.push({ field: 'envDependencies', kind: 'unknown-name', detail: k });
    }
  }

  // declared pure while the graph detects real side effects (high signal).
  if (content.sideEffects?.some(e => e.kind === 'pure') && input.detectedSideEffectKinds?.length) {
    issues.push({
      field: 'sideEffects',
      kind: 'contradicts-hints',
      detail: `declared pure; detected ${input.detectedSideEffectKinds.join(',')}`,
    });
  }

  return { ok: issues.length === 0, issues };
}

export function computeAnnotationQuality(
  content: StoredAnnotation['annotation'],
  moduleData: AnnotationQualityInput,
): AnnotationQuality {
  let score = 0;
  const missing: string[] = [];

  const kind: ModuleKind = moduleData.moduleKind ?? 'generic';
  const recommendedForKind = new Set(recommendedFieldsForKind(kind));

  // Universal: always score summary; recommended only when too short.
  if (hasField(content, 'summary')) score += FIELD_WEIGHTS.summary;
  else missing.push('summary (>20 chars)');

  // keyExports — required for kinds that surface exports (everything except 'runtime-resource'/'infra'/'domain'
  // where exports aren't well-defined, and except types-only where summary alone is sometimes enough
  // unless the file has real exports — recommendedFieldsForKind('types') already includes keyExports).
  if (hasField(content, 'keyExports')) score += FIELD_WEIGHTS.keyExports;
  else if (recommendedForKind.has('keyExports') && moduleData.exportCount > 0) missing.push('keyExports');

  if (hasField(content, 'assumptions')) score += FIELD_WEIGHTS.assumptions;
  else if (recommendedForKind.has('assumptions')) missing.push('assumptions');

  if (hasField(content, 'sideEffects')) score += FIELD_WEIGHTS.sideEffects;
  else if (recommendedForKind.has('sideEffects') || moduleData.envVars?.length) missing.push('sideEffects');

  if (hasField(content, 'risks')) score += FIELD_WEIGHTS.risks;
  else if (recommendedForKind.has('risks') || moduleData.lineCount > 500) missing.push('risks');

  if (hasField(content, 'patterns')) score += FIELD_WEIGHTS.patterns;
  else if (recommendedForKind.has('patterns')) missing.push('patterns');

  if (hasField(content, 'flowDescription')) score += FIELD_WEIGHTS.flowDescription;
  else if (recommendedForKind.has('flowDescription')) missing.push('flowDescription');

  if (hasField(content, 'invariants')) score += FIELD_WEIGHTS.invariants;
  else if (recommendedForKind.has('invariants')) missing.push('invariants');

  if (hasField(content, 'extensionPoints')) score += FIELD_WEIGHTS.extensionPoints;
  else if (recommendedForKind.has('extensionPoints')) missing.push('extensionPoints');

  if (hasField(content, 'integrationPoints')) score += FIELD_WEIGHTS.integrationPoints;
  else if (recommendedForKind.has('integrationPoints') || moduleData.exportCount > 5) missing.push('integrationPoints');

  if (hasField(content, 'stateShape')) score += FIELD_WEIGHTS.stateShape;
  else if (recommendedForKind.has('stateShape')) missing.push('stateShape');

  if (hasField(content, 'dataFlow')) score += FIELD_WEIGHTS.dataFlow;
  else if (moduleData.lineCount > 200 && (kind === 'api-handler' || kind === 'service-mgr' || kind === 'generic')) {
    missing.push('dataFlow');
  }

  if (hasField(content, 'envDependencies')) score += FIELD_WEIGHTS.envDependencies;
  else if (moduleData.envVars?.length) missing.push('envDependencies');

  const tier: AnnotationQuality['tier'] = score >= 8 ? 'comprehensive'
    : score >= 5 ? 'detailed'
    : score >= 2 ? 'basic'
    : 'minimal';

  // Consistency is computed independently and attached, but deliberately does NOT touch score/tier.
  const consistency = computeConsistency(content, moduleData);

  return { score: Math.min(10, score), missingFields: missing, tier, moduleKind: kind, consistency };
}

/**
 * A consistency issue is "hard" (trustworthy contradiction → gate error under harness, counted as
 * inconsistent) vs "advisory" (the backing graph detector is known-incomplete, so a mismatch may be
 * a detection gap rather than annotation drift). Currently only `envDependencies` is advisory.
 *
 * The env-var detector resolves a read whose name is written at the access site. Three forms carry
 * the name elsewhere and stay unresolved: a computed key (`process.env[BY_ROLE[role]]`), an aliased
 * container (`const env = process.env` then `env.NAME`), and a name that reaches the read as an
 * argument (`envEnabled('NAME')`). Each is a live source of honestly-declared env dependencies the
 * graph cannot see, so a mismatch stays advisory. keyExports/sideEffects stay hard.
 */
export function isHardConsistencyIssue(issue: AnnotationConsistency['issues'][number]): boolean {
  return issue.field !== 'envDependencies';
}

/** Build the consistency-aware quality input for a module (shared ground-truth derivation). */
export function annotationQualityInputForModule(mod: ModuleInfo, moduleKind?: ModuleKind): AnnotationQualityInput {
  return {
    exportCount: mod.exports.length,
    lineCount: mod.exports.reduce((m, e) => Math.max(m, e.lineRange.end), 0),
    envVars: mod.semanticHints?.envVars,
    ...(moduleKind ? { moduleKind } : {}),
    exportNames: mod.exports.map(e => e.name),
    detectedSideEffectKinds: detectSideEffectKindsFromHints(mod.semanticHints),
  };
}

export interface InconsistentModuleAnnotation {
  nodeId: string;
  /** Only HARD issues (advisory env mismatches are excluded — see isHardConsistencyIssue). */
  issues: AnnotationConsistency['issues'];
}

/**
 * Recompute the consistency axis for every stored MODULE annotation against the current snapshot and
 * return those with at least one HARD contradiction. Advisory-only mismatches do not make a note
 * "inconsistent" here. Pure function of `annotations × modulesById`, so it surfaces drift on existing
 * notes (e.g. keyExports after a refactor) without re-annotating — an advisory health signal, never a
 * gate. Module-only: domain/service/infra roll-ups carry no keyExports/env/sideEffects to contradict.
 */
export function computeInconsistentModuleAnnotations(
  annotations: AnnotationStore,
  modulesById: Map<string, ModuleInfo>,
): InconsistentModuleAnnotation[] {
  const out: InconsistentModuleAnnotation[] = [];
  for (const [nodeId, stored] of Object.entries(annotations.getAll())) {
    if (stored.nodeType !== 'module') continue;
    const mod = modulesById.get(nodeId);
    if (!mod) continue;
    const quality = computeAnnotationQuality(stored.annotation, annotationQualityInputForModule(mod));
    const hard = quality.consistency.issues.filter(isHardConsistencyIssue);
    if (hard.length > 0) out.push({ nodeId, issues: hard });
  }
  return out;
}

// ── Content hash for non-leaf nodes (domain) ──

export interface DomainContentHashLookup {
  moduleContentHashById: ReadonlyMap<string, string>;
  infraContentHashById: ReadonlyMap<string, string>;
  templateContentHashById: ReadonlyMap<string, string>;
  runtimeResourceHashes: RuntimeResourceContentHashLookup;
}

export function buildDomainContentHashLookup(
  snapshot: RepositoryFactsSnapshot,
): DomainContentHashLookup {
  const moduleContentHashById = new Map<string, string>();
  for (const m of snapshot.modules) moduleContentHashById.set(m.id, m.contentHash);
  const infraContentHashById = new Map<string, string>();
  for (const im of snapshot.infraModules ?? []) infraContentHashById.set(im.id, im.contentHash);
  const templateContentHashById = new Map<string, string>();
  for (const t of snapshot.templates ?? []) templateContentHashById.set(t.id, t.contentHash);
  return {
    moduleContentHashById,
    infraContentHashById,
    templateContentHashById,
    runtimeResourceHashes: buildRuntimeResourceContentHashLookup(snapshot),
  };
}

/**
 * Compute a stable content hash for a domain node as a function of its tagged
 * member modules' contentHashes. Two members with the same set of module ids
 * and contentHashes always produce the same domain hash, regardless of insertion
 * order. Used to detect when a domain annotation has become stale because its
 * underlying members changed.
 *
 * Includes module, infra-module, runtime-resource and template nodes that participate in this domain.
 * Export symbols are excluded (already covered transitively via their parent module).
 */
/**
 * Hash a pre-filtered set of tagged domain-member edges. Shared by the two domain
 * content-hash policies (full rollup vs path-only): they differ ONLY in which tagged
 * edges they pass in, never in how a member set is hashed. Order-independent — members
 * sort so the same set always yields the same hash. Returns the `'empty'` sentinel when
 * no member resolves to a content hash.
 */
function hashDomainMembers(
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  taggedEdges: GraphEdge[],
  hashes: DomainContentHashLookup,
): string {
  const members: Array<[string, string]> = [];
  for (const edge of taggedEdges) {
    const memberId = edge.from;
    const memberNode = graph.nodes.get(memberId);
    let hash: string | undefined;
    if (memberId.startsWith('infra:')) {
      hash = hashes.infraContentHashById.get(memberId);
    } else if (memberNode?.type === 'module') {
      hash = hashes.moduleContentHashById.get(memberId);
    } else if (memberNode?.type === 'runtime-resource') {
      hash = resolveServiceResourceContentHash(graph, snapshot, memberId, hashes.runtimeResourceHashes);
    } else if (memberNode?.type === 'template') {
      hash = hashes.templateContentHashById.get(memberId);
    }
    if (hash) members.push([memberId, hash]);
  }
  if (members.length === 0) return 'empty';

  members.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const payload = members.map(([id, h]) => `${id}:${h}`).join('\n');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function computeDomainContentHash(
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  domainId: string,
  lookup?: DomainContentHashLookup,
): string | undefined {
  const node = graph.nodes.get(domainId);
  if (!node || node.type !== 'domain') return undefined;

  const taggedEdges = (graph.inEdges.get(domainId) ?? []).filter(e => e.kind === 'tagged');
  if (taggedEdges.length === 0) return 'empty'; // domain with no members — stable sentinel

  return hashDomainMembers(graph, snapshot, taggedEdges, lookup ?? buildDomainContentHashLookup(snapshot));
}

/**
 * Hash only path/pattern-tagged domain members (path-only domain staleness). A deliberately
 * different scope from computeDomainContentHash — it excludes `cluster`/`package`-sourced tagged
 * members. `resolveDomainContentHash` selects between the two by `domainStalePolicy`; they are not
 * interchangeable, and unifying them would re-flag path-only domains against persisted hashes.
 */
export function computeDomainContentHashForPathOnly(
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  domainId: string,
  lookup?: DomainContentHashLookup,
): string | undefined {
  const node = graph.nodes.get(domainId);
  if (!node || node.type !== 'domain') return undefined;

  const taggedEdges = (graph.inEdges.get(domainId) ?? []).filter(e => {
    if (e.kind !== 'tagged') return false;
    const src = e.metadata?.tagSource;
    return src === 'path' || src === 'pattern';
  });
  if (taggedEdges.length === 0) return 'empty';

  return hashDomainMembers(graph, snapshot, taggedEdges, lookup ?? buildDomainContentHashLookup(snapshot));
}

/** True when every tagged edge to this domain is package-sourced only. */
export function isPackageOnlyDomain(graph: RepositoryGraph, domainId: string): boolean {
  const tagged = (graph.inEdges.get(domainId) ?? []).filter(e => e.kind === 'tagged');
  if (tagged.length === 0) return false;
  return tagged.every(e => e.metadata?.tagSource === 'package');
}

/**
 * Domain content hash under the active propagation policy. `path-only` policy uses the path/pattern
 * scope for slashed (subdomain) or non-package-only domains, and the full rollup otherwise;
 * `all-tags` policy always uses the full rollup. This selection is load-bearing for staleness — the
 * two scopes are not interchangeable.
 */
export function resolveDomainContentHash(
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  domainId: string,
  propagation: PropagationConfig,
  lookup?: DomainContentHashLookup,
): string | undefined {
  if (propagation.domainStalePolicy === 'path-only') {
    const label = graph.nodes.get(domainId)?.label ?? domainId.replace(/^domain:/, '');
    if (label.includes('/') || !isPackageOnlyDomain(graph, domainId)) {
      return computeDomainContentHashForPathOnly(graph, snapshot, domainId, lookup);
    }
  }
  return computeDomainContentHash(graph, snapshot, domainId, lookup);
}

type DomainContentHashCache = Map<string, string | undefined>;

function resolveCachedDomainContentHash(
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  domainId: string,
  propagation: PropagationConfig,
  lookup: DomainContentHashLookup,
  cache: DomainContentHashCache,
): string | undefined {
  const key = `${propagation.domainStalePolicy}\0${domainId}`;
  if (!cache.has(key)) {
    cache.set(key, resolveDomainContentHash(graph, snapshot, domainId, propagation, lookup));
  }
  return cache.get(key);
}

function shouldHardQueueDomain(
  graph: RepositoryGraph,
  domainId: string,
  propagation: PropagationConfig,
): boolean {
  if (propagation.domainStalePolicy !== 'path-only' || propagation.packageDomainHardQueue) {
    return true;
  }
  const label = graph.nodes.get(domainId)?.label ?? domainId.replace(/^domain:/, '');
  if (label.includes('/')) return true;
  return !isPackageOnlyDomain(graph, domainId);
}

// ── Derived-stale via importBaseline (v1: direct imports only) ──

/** Direct module import targets (`imports` edges from moduleId). */
export function getDirectImportModuleIds(graph: RepositoryGraph, moduleId: string): string[] {
  const out = graph.outEdges.get(moduleId) ?? [];
  return out
    .filter(e => e.kind === 'imports' && e.to.startsWith('mod:'))
    .map(e => e.to);
}

export function resolveModuleContentHash(
  snapshot: RepositoryFactsSnapshot,
  moduleId: string,
  contentHashById?: ReadonlyMap<string, string>,
): string | undefined {
  if (contentHashById) return contentHashById.get(moduleId);
  return snapshot.modules.find(m => m.id === moduleId)?.contentHash;
}

export function resolveTemplateContentHash(
  snapshot: RepositoryFactsSnapshot,
  templateId: string,
): string | undefined {
  return snapshot.templates?.find(t => t.id === templateId)?.contentHash;
}

function templateQueuePreview(t: TemplateFileInfo): Array<{ name: string; kind: string }> {
  const out: Array<{ name: string; kind: string }> = [];
  if (t.extendsTemplate) out.push({ name: t.extendsTemplate, kind: 'extends' });
  for (const name of t.includesTemplate ?? []) out.push({ name, kind: 'includes' });
  for (const name of t.blocks ?? []) out.push({ name, kind: 'block' });
  return out.slice(0, 10);
}

/** Snapshot current direct-import content hashes for persisting on write/ack. */
export function computeImportBaseline(
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  moduleId: string,
  contentHashById?: ReadonlyMap<string, string>,
): Record<string, string> {
  const baseline: Record<string, string> = {};
  for (const targetId of getDirectImportModuleIds(graph, moduleId)) {
    const hash = resolveModuleContentHash(snapshot, targetId, contentHashById);
    if (hash) baseline[targetId] = hash;
  }
  return baseline;
}

/** Upstream module ids whose graph contentHash differs from stored importBaseline. */
export function getImportBaselineStaleUpstream(
  ann: StoredAnnotation,
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  moduleId: string,
  contentHashById?: ReadonlyMap<string, string>,
): string[] {
  const stale: string[] = [];
  const baseline = ann.importBaseline;
  for (const targetId of getDirectImportModuleIds(graph, moduleId)) {
    const current = resolveModuleContentHash(snapshot, targetId, contentHashById);
    if (!current) continue;
    if (!baseline || baseline[targetId] !== current) stale.push(targetId);
  }
  return stale;
}

export function isDerivedStaleModule(
  ann: StoredAnnotation | undefined,
  mod: ModuleInfo,
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  contentHashById?: ReadonlyMap<string, string>,
): boolean {
  if (!ann) return false;
  if (ann.contentHash !== mod.contentHash) return false;
  if ((ann.schemaVersion ?? 1) < CURRENT_ANNOTATION_SCHEMA_VERSION) return false;
  return getImportBaselineStaleUpstream(ann, graph, snapshot, mod.id, contentHashById).length > 0;
}

const SAVE_DEBOUNCE_MS = 800;
const MAX_SAVE_RETRIES = 3;

function isAnnotationRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A `pass` read off a RAW disk record. The serializer elides the key when the value is 1, and the
 * loader hydrates that absence back to 1, so a raw record without the key is pass 1 — reading it as 0
 * would rank every first-pass record on disk as superseded.
 */
function rawDiskPass(diskRec: Record<string, unknown>): number {
  return typeof diskRec.pass === 'number' ? diskRec.pass : 1;
}

/**
 * Whether a disk record is a superseded version of the one we hold: a lower `pass`, or the same `pass`
 * with an older `updatedAt`. Drives the never-regress net in {@link AnnotationStore.mergeWithDisk}.
 * Unparseable or equal metadata reads as "not older", so disk keeps the merge base by default and only a
 * demonstrable regression is overridden.
 */
function diskRecordIsOlder(diskRec: unknown, ours: StoredAnnotation): boolean {
  if (!isAnnotationRecord(diskRec)) return false;
  const diskPass = rawDiskPass(diskRec);
  const ourPass = typeof ours.pass === 'number' ? ours.pass : 1;
  if (diskPass !== ourPass) return diskPass < ourPass;
  const diskAt = typeof diskRec.updatedAt === 'string' ? Date.parse(diskRec.updatedAt) : NaN;
  const ourAt = typeof ours.updatedAt === 'string' ? Date.parse(ours.updatedAt) : NaN;
  if (Number.isNaN(diskAt) || Number.isNaN(ourAt)) return false;
  return diskAt < ourAt;
}

/**
 * Merge for a write that changed no annotation content (a re-submitted identical write, a bare
 * importBaseline refresh). The disk record stays the base so its content keeps the `contentHash` and
 * `updatedAt` that describe it; only what this write can carry independently of content is overlaid.
 * Stamping our metadata over disk content instead would report a record as fresh while it holds the
 * older text.
 */
function mergeRecordLevelOnly(disk: Record<string, unknown>, ours: StoredAnnotation): Record<string, unknown> {
  const ourPass = typeof ours.pass === 'number' ? ours.pass : 1;
  return {
    ...disk,
    pass: Math.max(rawDiskPass(disk), ourPass),
    ...(ours.importBaseline ? { importBaseline: ours.importBaseline } : {}),
  };
}

/**
 * Thrown when a save finds the file changed externally to something unreadable (git conflict markers,
 * partial write, corruption). The save refuses rather than overwrite the external bytes with in-memory
 * state; the deltas stay pending and are surfaced via `lastSaveError`.
 */
export class AnnotationExternalCorruptionError extends Error {
  readonly code = 'ANNOTATION_EXTERNAL_CORRUPTION';

  constructor(readonly filePath: string, readonly reason: string) {
    super(
      `Refusing to overwrite ${filePath}: it changed externally and is now unreadable (${reason}). `
      + 'Resolve the conflict (merge_annotations) or restore the file, then reload repovine.',
    );
    this.name = 'AnnotationExternalCorruptionError';
  }
}

export class AnnotationStore {
  private filePath: string;
  private data: Record<string, StoredAnnotation> = {};
  /**
   * Raw entries that failed schema validation at load time. They are NEVER dropped — they are
   * parked here and carried through on every write, so a schema mismatch (e.g. a tightened
   * `sideEffects` rule during a migration window) can never silently delete annotations off disk.
   * Hidden from graph/queries; not counted as queryable annotations.
   */
  private quarantine: Record<string, unknown> = {};
  /** nodeIds this process has explicitly written since the last successful persist. */
  private touched = new Set<string>();
  /**
   * Per-touched-node record of which annotation fields changed this cycle, for field-level merge against
   * a concurrent external writer. A Set names the changed fields; `null` means whole-record (legacy set,
   * migrations). Absence (a `touched` key with no entry) is also treated as whole-record.
   */
  private touchedFields = new Map<string, Set<string> | null>();
  /** nodeIds this process has explicitly deleted since the last successful persist. */
  private deleted = new Set<string>();
  /** Monotonic mutation counter; every set()/delete() bumps it. */
  private mutationSeq = 0;
  /**
   * Per-key mutation generation at its last set()/delete(). A save clears a key only if its generation is
   * unchanged since the save was composed — so a re-write of the SAME node during an in-flight save is
   * kept pending instead of being reverted to the composed version (a `Set<nodeId>` cannot tell a
   * re-write from the original write).
   */
  private opGen = new Map<string, number>();
  /** Stat of the file as of our last read/write — used to detect external writers cheaply. */
  private lastWriteStat: { mtimeMs: number; size: number } | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serializes async saves so two debounced/flush cycles never overlap in-process. Never rejects. */
  private saveChain: Promise<unknown> = Promise.resolve();
  /** True while an async save holds (or is acquiring) the file lock — lets sync flush() fail fast. */
  private asyncSaveInFlight = false;
  private _lastSaveError: string | null = null;
  private mergeKeeps: AnnotationMergeKeeps = { readded: 0, reverted: 0, sample: [] };
  private lastFlushedCount: number | null = null;
  private mergeStatusSnapshot: AnnotationFileStatusSnapshot = {
    exists: false,
    parseOk: false,
    hasConflictMarkers: false,
  };
  private writeBlockedAfterFailedLoad = false;
  private failedLoadBackupPending = false;
  private failedLoadOriginalContent: string | undefined;

  private constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Factory: create and load store asynchronously. */
  static async create(repoRoot: string, annotationsFile = ANNOTATIONS_FILENAME): Promise<AnnotationStore> {
    const store = new AnnotationStore(resolveAnnotationsFilePath(repoRoot, annotationsFile));
    await store.loadAsync();
    return store;
  }

  /** Synchronous factory for backward compatibility (tests, CLI). */
  static createSync(repoRoot: string, annotationsFile = ANNOTATIONS_FILENAME): AnnotationStore {
    const store = new AnnotationStore(resolveAnnotationsFilePath(repoRoot, annotationsFile));
    store.loadSync();
    return store;
  }

  private parseAndValidate(rawJson: string): void {
    const raw = JSON.parse(rawJson);
    this.data = {};
    this.quarantine = {};
    const anns = raw?.annotations;
    if (anns && typeof anns === 'object') {
      // Validate per-entry, hydrating compact disk records into the full runtime shape.
      // Invalid entries are quarantined, NOT discarded — they are written back on every
      // save so disk never loses data we simply could not parse.
      const hydrated = hydrateAnnotationMap(anns as Record<string, unknown>);
      this.data = hydrated.data;
      this.quarantine = hydrated.quarantine;
      const loaded = Object.keys(this.data).length;
      const quarantinedIds = hydrated.errors.map(error => error.nodeId);
      const firstError = hydrated.errors[0];
      if (quarantinedIds.length > 0) {
        const shown = quarantinedIds.slice(0, 10).join(', ');
        logPipelineWarn(`  Annotations: ${quarantinedIds.length} entry(ies) failed validation, quarantined (preserved on disk, hidden from queries): ${shown}${quarantinedIds.length > 10 ? ', …' : ''}`);
        if (firstError) logPipelineWarn(`    Example error (${firstError.nodeId}): ${firstError.message}`);
      }
      logPipeline(formatPipelineStatus(`  Annotations loaded: ${loaded} nodes${quarantinedIds.length ? ` (+${quarantinedIds.length} quarantined)` : ''}`));
    }
    this.lastFlushedCount = Object.keys(this.data).length + Object.keys(this.quarantine).length;
  }

  private mergeStatusSnapshotFromContent(content: string, exists = true): AnnotationFileStatusSnapshot {
    const hasConflictMarkers = /^(<<<<<<<|=======|>>>>>>>) ?/m.test(content);
    if (hasConflictMarkers) {
      return {
        exists,
        parseOk: false,
        hasConflictMarkers: true,
        error: 'contains conflict markers',
      };
    }
    try {
      const parsed = parseAnnotationFile(content, this.filePath);
      return {
        exists,
        parseOk: true,
        hasConflictMarkers: false,
        annotationCount: Object.keys(parsed.annotations).length,
      };
    } catch (e) {
      return {
        exists,
        parseOk: false,
        hasConflictMarkers: false,
        error: (e as Error).message,
      };
    }
  }

  private setMergeStatusSnapshot(snapshot: AnnotationFileStatusSnapshot): void {
    this.mergeStatusSnapshot = snapshot;
    if (snapshot.parseOk) {
      this.writeBlockedAfterFailedLoad = false;
      this.failedLoadBackupPending = false;
      this.failedLoadOriginalContent = undefined;
    }
  }

  private rememberFailedLoad(content?: string): void {
    if (!this.mergeStatusSnapshot.exists) return;
    this.writeBlockedAfterFailedLoad = true;
    this.failedLoadBackupPending = true;
    if (content !== undefined) {
      this.failedLoadOriginalContent = content;
      return;
    }
    if (this.failedLoadOriginalContent !== undefined) return;
    try {
      this.failedLoadOriginalContent = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      // A read failure still makes the store non-writable; a later backup attempt may succeed.
    }
  }

  private mergeStatusSnapshotAfterLoadFailure(error: unknown): AnnotationFileStatusSnapshot {
    const exists = fs.existsSync(this.filePath);
    if (exists) {
      try {
        return this.mergeStatusSnapshotFromContent(fs.readFileSync(this.filePath, 'utf-8'), true);
      } catch (readError) {
        return {
          exists: true,
          parseOk: false,
          hasConflictMarkers: false,
          error: (readError as Error).message,
        };
      }
    }
    return {
      exists: false,
      parseOk: false,
      hasConflictMarkers: false,
      ...((error as Error).message ? { error: (error as Error).message } : {}),
    };
  }

  private loadSync(): void {
    let loadedContent: string | undefined;
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        loadedContent = content;
        const snapshot = this.mergeStatusSnapshotFromContent(content, true);
        this.setMergeStatusSnapshot(snapshot);
        this.parseAndValidate(content);
        this.captureStatSync();
      } else if (ensureEmptyAnnotationsFileAtPath(this.filePath)) {
        this.setMergeStatusSnapshot(this.mergeStatusSnapshotFromContent(EMPTY_ANNOTATION_FILE_TEXT, true));
        this.parseAndValidate(EMPTY_ANNOTATION_FILE_TEXT);
        this.captureStatSync();
      }
    } catch (e) {
      this.data = {};
      this.quarantine = {};
      this.setMergeStatusSnapshot(this.mergeStatusSnapshotAfterLoadFailure(e));
      this.rememberFailedLoad(loadedContent);
      logPipeline(formatPipelineDetail(`  Annotations: failed to load (${(e as Error).message}), starting with none`));
    }
  }

  private async loadAsync(): Promise<void> {
    let loadedContent: string | undefined;
    try {
      const content = await fsPromises.readFile(this.filePath, 'utf-8');
      loadedContent = content;
      const snapshot = this.mergeStatusSnapshotFromContent(content, true);
      this.setMergeStatusSnapshot(snapshot);
      this.parseAndValidate(content);
      this.captureStatSync();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' && ensureEmptyAnnotationsFileAtPath(this.filePath)) {
        this.setMergeStatusSnapshot(this.mergeStatusSnapshotFromContent(EMPTY_ANNOTATION_FILE_TEXT, true));
        this.parseAndValidate(EMPTY_ANNOTATION_FILE_TEXT);
        this.captureStatSync();
        return;
      }
      if (code !== 'ENOENT') {
        logPipeline(formatPipelineDetail(`  Annotations: failed to load (${(e as Error).message}), starting with none`));
      }
      this.data = {};
      this.quarantine = {};
      this.setMergeStatusSnapshot(this.mergeStatusSnapshotAfterLoadFailure(e));
      this.rememberFailedLoad(loadedContent);
    }
  }

  // ── Persistence ──
  //
  // A write never derives the file purely from in-memory `this.data`. The on-disk file is the
  // durable accumulator; a write applies only this process's explicit deltas (writes + deletes)
  // on top of it. Two guards keep this cheap on large (30–40k line) files:
  //   1. The in-memory map is a true superset of disk (invalid entries are quarantined, not
  //      dropped), so the common single-writer path writes straight from memory — no re-read.
  //   2. A stat check detects external writers; only then do we re-read and merge, so the hot
  //      path pays a single fs.stat. Writes are atomic (temp + rename) — a crash cannot truncate.

  /** Fast path: our in-memory map is authoritative (== disk + our deltas). */
  private composeOwn(): Record<string, unknown> {
    return { ...this.data, ...this.quarantine };
  }

  /** Merge path: disk is the base; overlay the entries this process holds, then apply our deletes. */
  private mergeWithDisk(diskAnns: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...diskAnns };
    // Reset here rather than in a caller: a save on an unchanged file returns before merging, and a
    // caller-side reset would erase a count the preceding refresh legitimately produced.
    this.mergeKeeps = { readded: 0, reverted: 0, sample: [] };
    // Carry our quarantined entries the external writer does not have.
    for (const [k, v] of Object.entries(this.quarantine)) {
      if (!(k in out)) out[k] = v;
    }
    // Apply our pending writes. For a key an external writer also holds, merge only the fields we changed
    // so their concurrent field additions survive; otherwise overlay the whole record. The regress net
    // below deliberately does NOT apply here: `pass` is derived from our own possibly-stale copy
    // (`existing.pass + 1`) and `updatedAt` from our wall clock, so a single concurrent write ties on
    // `pass` and loses the timestamp comparison — treating that as a regression would discard exactly the
    // field additions this branch exists to keep.
    for (const k of this.touched) {
      const ours = this.data[k];
      if (ours === undefined) continue;
      const fields = this.touchedFields.get(k);
      const diskRec = out[k];
      if (!isAnnotationRecord(diskRec) || !(fields instanceof Set)) {
        out[k] = ours;
      } else if (fields.size === 0) {
        out[k] = mergeRecordLevelOnly(diskRec, ours);
      } else {
        out[k] = this.mergeAnnotationFields(diskRec, ours, fields);
      }
    }
    // Safety net against concurrent-writer / interrupted-save / git-checkout data loss: a merge must
    // never DROP an annotation this process still holds in memory unless it was explicitly deleted, and
    // never REVERT one to an older disk copy. `touched` only covers writes since the last persist, so an
    // annotation we persisted in an earlier cycle is otherwise protected solely by the disk snapshot — and
    // a concurrent writer, a half-flushed debounced save, or an out-of-band file reset can leave the disk
    // transiently missing it or holding a superseded version. Treat both as external gaps, not as intent:
    // resurfacing a stale note is recoverable (freshness/orphan checks flag it); silently losing an update
    // is not. A genuine external update carries a higher `pass`, so it still wins.
    for (const k of Object.keys(this.data)) {
      if (this.deleted.has(k)) continue;
      const ours = this.data[k];
      if (!(k in out)) {
        out[k] = ours;
        this.recordMergeKeep('readded', k);
      } else if (!this.touched.has(k) && diskRecordIsOlder(out[k], ours)) {
        out[k] = ours;
        this.recordMergeKeep('reverted', k);
      }
    }
    // Apply our pending deletes. Absence from memory for any OTHER reason never deletes.
    for (const k of this.deleted) delete out[k];
    return out;
  }

  /**
   * Overlay only `fields` from our annotation onto the disk record, keeping the disk record's other
   * fields (a concurrent external writer's additions). Record metadata comes from our write; `pass` takes
   * the max so neither side's increment is lost. Callers pass a non-empty `fields`; an empty set means the
   * write changed no content and routes to {@link mergeRecordLevelOnly} instead.
   */
  private mergeAnnotationFields(
    disk: Record<string, unknown>,
    ours: StoredAnnotation,
    fields: Set<string>,
  ): StoredAnnotation {
    const diskAnnotation = (disk.annotation && typeof disk.annotation === 'object' ? disk.annotation : {}) as Record<string, unknown>;
    const ourAnnotation = ours.annotation as unknown as Record<string, unknown>;
    const mergedAnnotation: Record<string, unknown> = { ...diskAnnotation };
    for (const f of fields) {
      if (ourAnnotation[f] === undefined) delete mergedAnnotation[f];
      else mergedAnnotation[f] = ourAnnotation[f];
    }
    const diskPass = typeof disk.pass === 'number' ? disk.pass : 0;
    return {
      ...ours,
      pass: Math.max(diskPass, ours.pass),
      annotation: mergedAnnotation as unknown as StoredAnnotation['annotation'],
    };
  }

  /** Re-derive in-memory maps from a merged raw map so memory re-converges with disk. */
  private ingestRaw(annotations: Record<string, unknown>): void {
    const hydrated = hydrateAnnotationMap(annotations);
    this.data = hydrated.data;
    this.quarantine = hydrated.quarantine;
  }

  private fileChangedExternally(): boolean {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.filePath);
    } catch {
      return false; // absent → we are creating it, nothing external to merge
    }
    if (!this.lastWriteStat) return true; // file exists but we have no baseline → merge to be safe
    return st.mtimeMs !== this.lastWriteStat.mtimeMs || st.size !== this.lastWriteStat.size;
  }

  private captureStatSync(): void {
    try {
      const st = fs.statSync(this.filePath);
      this.lastWriteStat = { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      this.lastWriteStat = null;
    }
  }

  private readDiskAnnotationsSync(): { ok: true; anns: Record<string, unknown> } | { ok: false; reason: string } {
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      // Validate the OUTER shape via the canonical schema — `{"annotations":"THEIRS"}` is a well-formed
      // JSON string but an INVALID annotations file. Accepting it as an empty set would let the next save
      // overwrite the external bytes. Per-entry validity is deferred (quarantined by ingestRaw), not
      // grounds to reject the whole file.
      const anns = parseAnnotationsRawShape(content);
      if (anns === null) return { ok: false, reason: 'invalid annotations file shape' };
      return { ok: true, anns };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  /** Decide final content: disk-merge when an external writer touched the file, else our superset. */
  private composeFinalRaw(): { finalRaw: Record<string, unknown>; merged: boolean } {
    if (!this.fileChangedExternally()) return { finalRaw: this.composeOwn(), merged: false };
    // The file changed under us. Read it; a parse/conflict failure means an external writer (git merge,
    // partial write) left it unreadable. Fail closed rather than overwrite THEIR bytes with our memory —
    // the corrupt file stays intact on disk for merge_annotations / manual repair. Symmetric with the
    // load-time refusal (a corrupt file blocks writes until reload).
    const disk = this.readDiskAnnotationsSync();
    if (!disk.ok) {
      throw new AnnotationExternalCorruptionError(this.filePath, disk.reason);
    }
    return { finalRaw: this.mergeWithDisk(disk.anns), merged: true };
  }

  private finalizeWrite(
    finalRaw: Record<string, unknown>,
    merged: boolean,
    capturedGen: ReadonlyMap<string, number>,
  ): void {
    // A touched/deleted key is fully persisted by this save only if its mutation generation is unchanged
    // since the save was composed. A key set/deleted AGAIN during the write (same or new nodeId) has a
    // newer generation and stays pending — its in-memory value must not be reverted to `finalRaw`.
    const persisted = (k: string): boolean => {
      const g = capturedGen.get(k);
      return g !== undefined && this.opGen.get(k) === g;
    };
    if (merged) {
      // ingestRaw re-derives this.data from the merged base composed BEFORE the await. Preserve the
      // in-memory value of any key that changed during the write so ingestRaw cannot wipe/revert it.
      const stillPending = [...this.touched].filter(k => !persisted(k));
      const stillPendingDeletes = [...this.deleted].filter(k => !persisted(k));
      const preserved: Record<string, StoredAnnotation> = {};
      for (const k of stillPending) {
        if (this.data[k] !== undefined) preserved[k] = this.data[k];
      }
      this.ingestRaw(finalRaw);
      for (const [k, v] of Object.entries(preserved)) {
        this.data[k] = v;
        delete this.quarantine[k];
      }
      for (const k of stillPendingDeletes) {
        delete this.data[k];
        delete this.quarantine[k];
      }
    }
    // Clear ONLY keys this save fully persisted (captured generation unchanged); the rest stay pending.
    for (const k of [...this.touched]) {
      if (persisted(k)) {
        this.touched.delete(k);
        this.touchedFields.delete(k);
        this.opGen.delete(k);
      }
    }
    for (const k of [...this.deleted]) {
      if (persisted(k)) {
        this.deleted.delete(k);
        this.opGen.delete(k);
      }
    }
    this.lastFlushedCount = Object.keys(finalRaw).length;
    this.setMergeStatusSnapshot(
      this.mergeStatusSnapshotFromContent(
        serializeAnnotationFileFromRaw({ version: 1, annotations: finalRaw }),
        true,
      ),
    );
    this.captureStatSync();
  }

  private async saveAsync(): Promise<void> {
    this.asyncSaveInFlight = true;
    try {
      await fsPromises.mkdir(path.dirname(this.filePath), { recursive: true });
      await withAnnotationFileLockAsync(this.filePath, async () => {
        this.assertWritable();
        const { finalRaw, merged } = this.composeFinalRaw();
        // Snapshot per-key generations baked into finalRaw NOW, before the await yields the event loop.
        const capturedGen = new Map(this.opGen);
        this.maybeBackup(Object.keys(finalRaw).length);
        await writeFileAtomic(
          this.filePath,
          serializeAnnotationFileFromRaw({ version: 1, annotations: finalRaw }),
        );
        this.finalizeWrite(finalRaw, merged, capturedGen);
      });
    } finally {
      this.asyncSaveInFlight = false;
    }
  }

  private saveSync(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    withAnnotationFileLockSync(this.filePath, () => {
      this.assertWritable();
      const { finalRaw, merged } = this.composeFinalRaw();
      const capturedGen = new Map(this.opGen);
      this.maybeBackup(Object.keys(finalRaw).length);
      writeFileAtomicSync(
        this.filePath,
        serializeAnnotationFileFromRaw({ version: 1, annotations: finalRaw }),
      );
      this.finalizeWrite(finalRaw, merged, capturedGen);
    });
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      // Fire-and-forget: `runSaveWithRetry` already records `lastSaveError`, so swallow the rejection.
      void this.enqueueSave(() => this.runSaveWithRetry()).catch(() => { /* recorded in lastSaveError */ });
    }, SAVE_DEBOUNCE_MS);
  }

  /** Append a save to the single in-process chain so async saves never overlap. Chain never rejects. */
  private enqueueSave(run: () => Promise<void>): Promise<void> {
    const next = this.saveChain.then(run);
    this.saveChain = next.catch(() => { /* keep the chain alive after a failed save */ });
    return next;
  }

  /**
   * The one save routine every path funnels through: bounded retry, records `lastSaveError` (cleared on
   * success), throws on final failure so awaiting callers (durable write, flush, drain) learn the outcome.
   * A load-failure block never retries (it cannot succeed until reload). Lock timeouts retry as transient IO.
   */
  private async runSaveWithRetry(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_SAVE_RETRIES; attempt++) {
      try {
        await this.saveAsync();
        this._lastSaveError = null;
        return;
      } catch (e) {
        lastError = e;
        const msg = (e as Error).message;
        this._lastSaveError = msg;
        if (this.writeBlockedAfterFailedLoad) {
          console.error(`  [ALERT] Annotations save blocked: ${msg}`);
          throw e;
        }
        if (attempt >= MAX_SAVE_RETRIES) {
          console.error(`  [ALERT] Annotations save FAILED after ${MAX_SAVE_RETRIES} attempts: ${msg}. Data may be lost on restart!`);
          throw e;
        }
        const delay = SAVE_DEBOUNCE_MS * attempt;
        console.error(`  [ALERT] Annotations save failed (attempt ${attempt}/${MAX_SAVE_RETRIES}): ${msg}. Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastError;
  }

  get lastSaveError(): string | null {
    return this._lastSaveError;
  }

  /** What the last merge kept over a disagreeing file. Zeroed by every merge, so it describes the latest one. */
  get lastMergeKeeps(): AnnotationMergeKeeps {
    return { ...this.mergeKeeps, sample: [...this.mergeKeeps.sample] };
  }

  private recordMergeKeep(kind: 'readded' | 'reverted', nodeId: string): void {
    this.mergeKeeps[kind]++;
    if (this.mergeKeeps.sample.length < MERGE_KEEP_SAMPLE) this.mergeKeeps.sample.push(nodeId);
  }

  /**
   * Write pending annotations to disk immediately via the sync path (tests, one-shot CLI). Throws fast
   * if an async save holds the lock — synchronously waiting would busy-block the event loop for up to
   * the lock timeout. Async callers use {@link flushAsync} or {@link drain} instead.
   */
  flush(): void {
    if (this.asyncSaveInFlight) {
      throw new Error(
        'Cannot sync-flush annotations while an async save is in flight; use flushAsync()/drain().',
      );
    }
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveSync();
  }

  /**
   * Async flush: waits for any in-flight save, then persists via the retrying async path. Rejects on final
   * failure (so `durable: true` learns durability failed). On failure it re-arms the debounce so the pending
   * write is not stranded by the timer this method cancelled.
   */
  async flushAsync(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      await this.enqueueSave(() => this.runSaveWithRetry());
    } catch (e) {
      if (this.touched.size > 0 || this.deleted.size > 0) this.scheduleSave();
      throw e;
    }
  }

  /**
   * Drain for graceful shutdown / store handoff: cancel the debounce, persist pending deltas (with retry),
   * and wait for the save chain to settle. Never throws — a failure is recorded in `lastSaveError`, since a
   * shutdown path must not reject.
   */
  async drain(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      await this.enqueueSave(() => this.runSaveWithRetry());
    } catch (e) {
      this._lastSaveError = (e as Error).message;
      console.error(`  [ALERT] Annotations drain failed: ${this._lastSaveError}`);
    }
  }

  /**
   * Re-read the file and re-base in-memory state on it, preserving this process's uncommitted writes and
   * deletes. A long-lived runtime calls this on refresh so external edits (git pull) surface WITHOUT a
   * fresh store instance — a new store's orphaned debounce timer could fire after the swap and
   * clobber/resurrect records. Fail-closed on an unreadable/conflicted file: in-memory state is kept and
   * writes are blocked until repair, matching load-time behavior.
   */
  async reloadFromDisk(options: { signal?: AbortSignal } = {}): Promise<void> {
    const signal = options.signal;
    signal?.throwIfAborted();
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      await withAnnotationFileLockAsync(this.filePath, async () => {
        // Acquiring the cross-process lock can wait. Do not start disk IO for a refresh that was cancelled
        // while queued for it.
        signal?.throwIfAborted();
        let content: string;
        try {
          content = await fsPromises.readFile(this.filePath, 'utf-8');
        } catch (e) {
          signal?.throwIfAborted();
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // nothing on disk; keep memory as-is
          throw e;
        }

        // Reading is the only awaited operation inside the transaction. Once this checkpoint passes, the
        // snapshot/merge/ingest commit below is synchronous, so an abort cannot publish a partial reload.
        signal?.throwIfAborted();
        const snapshot = this.mergeStatusSnapshotFromContent(content, true);
        if (!snapshot.parseOk) {
          // Corrupt/conflicted external file: keep our annotation data, but publish the fail-closed status.
          this.setMergeStatusSnapshot(snapshot);
          this.rememberFailedLoad(content);
          return;
        }
        const diskAnns = parseAnnotationsRawShape(content);
        if (diskAnns === null) {
          // Well-formed JSON but not a valid annotations envelope — fail closed like the save path.
          this.setMergeStatusSnapshot(snapshot);
          this.rememberFailedLoad(content);
          return;
        }
        // Merge disk INTO memory with the SAME semantics as a save-time merge: disk is the base, our pending
        // writes overlay it (field-merged via touchedFields), keys we hold but disk lacks are kept (never-drop,
        // the 19b5491 guarantee), our deletes apply. Reading `this.touched`/`this.data` here — after the await —
        // captures a set() that landed during the read, so it is not lost.
        this.ingestRaw(this.mergeWithDisk(diskAnns));
        this.setMergeStatusSnapshot(snapshot);
        this.captureStatSync();
      });
    } finally {
      // The reload cancelled the debounce. Restore it after success, failure, or cancellation so local
      // uncommitted writes/deletes cannot be stranded by an aborted refresh.
      if (this.touched.size > 0 || this.deleted.size > 0) this.scheduleSave();
    }
  }

  /**
   * Back up the existing file before overwriting it with `newCount` entries, when that would
   * shrink it by >5%. Runs on EVERY write path (called from saveSync/saveAsync), not just flush.
   */
  private maybeBackup(newCount: number): void {
    const currentCount = newCount;
    const previousCount = this.lastFlushedCount ?? currentCount;
    if (previousCount > 0 && (previousCount - currentCount) / previousCount > 0.05) {
      this.createBackup();
    }
  }

  private createBackup(content = this.failedLoadOriginalContent): boolean {
    let data: Buffer;
    try {
      if (content === undefined) {
        if (!fs.existsSync(this.filePath)) return false;
        data = fs.readFileSync(this.filePath);
      } else {
        data = Buffer.from(content, 'utf-8');
      }
    } catch (e) {
      console.error(`  [WARN] Failed to create annotation backup: ${(e as Error).message}`);
      return false;
    }
    const result = writeAnnotationBackup(this.filePath, data);
    if (result.status === 'failed') {
      console.error(`  [WARN] Failed to create annotation backup: ${result.error}`);
      return false;
    }
    if (result.status === 'written') {
      logPipeline(formatPipelineDetail(`  Annotation backup created: ${result.backupPath}`));
    }
    return true;
  }

  private assertWritable(): void {
    if (!this.writeBlockedAfterFailedLoad) return;
    if (this.failedLoadBackupPending && this.createBackup()) {
      this.failedLoadBackupPending = false;
      this.failedLoadOriginalContent = undefined;
    }
    const reason = this.mergeStatusSnapshot.error ?? 'annotation file did not load successfully';
    throw new Error(
      `Refusing to write ${this.filePath} while its loaded contents are invalid (${reason}). `
      + 'Repair or restore the file, then reload repovine before writing annotations.',
    );
  }

  /**
   * Accept deletions an external tool already committed to disk (merge_annotations resolving a git
   * conflict). Without this the never-drop net in {@link mergeWithDisk} treats the nodes as an
   * external add-gap and writes them back, undoing a resolution the merge reported as done.
   *
   * Unlike {@link delete}, this records an accomplished fact: it never schedules a save and is
   * allowed while writes are blocked, because the file on disk already lacks these nodes. It also
   * stays out of the pending-delete set, so a later write that legitimately re-adds one of these
   * nodes is accepted instead of being deleted again on every save.
   */
  forgetDeletedOnDisk(nodeIds: readonly string[]): void {
    for (const nodeId of nodeIds) {
      delete this.data[nodeId];
      delete this.quarantine[nodeId];
      this.touched.delete(nodeId);
      this.touchedFields.delete(nodeId);
    }
  }

  get(nodeId: string): StoredAnnotation | undefined {
    return this.data[nodeId];
  }

  /**
   * Write a full annotation record. `changedFields` names the annotation-content fields this write
   * changed; when a concurrent external writer touched the same node, only those fields overwrite the
   * disk record (other fields survive). Omit it for whole-record semantics (migrations, bulk merges).
   */
  set(nodeId: string, annotation: StoredAnnotation, changedFields?: readonly string[]): void {
    this.assertWritable();
    this.data[nodeId] = annotation;
    delete this.quarantine[nodeId];
    this.touched.add(nodeId);
    this.recordTouchedFields(nodeId, changedFields);
    this.deleted.delete(nodeId);
    this.opGen.set(nodeId, ++this.mutationSeq);
    this.scheduleSave();
  }

  /** Accumulate the changed-field set for a node across multiple writes before a persist. */
  private recordTouchedFields(nodeId: string, changedFields?: readonly string[]): void {
    if (changedFields === undefined) {
      this.touchedFields.set(nodeId, null); // whole-record write dominates any prior field-level set
      return;
    }
    const existing = this.touchedFields.get(nodeId);
    if (existing === null) return; // a prior whole-record write already covers this node
    const merged = existing ?? new Set<string>();
    for (const f of changedFields) merged.add(f);
    this.touchedFields.set(nodeId, merged);
  }

  isFresh(nodeId: string, currentHash: string): boolean {
    const ann = this.data[nodeId];
    if (!ann) return false;
    if (ann.contentHash !== currentHash) return false;
    const v = ann.schemaVersion ?? 1;
    return v >= CURRENT_ANNOTATION_SCHEMA_VERSION;
  }

  getAll(): Record<string, StoredAnnotation> {
    return this.data;
  }

  /** Delete specific annotation entries by node id. Returns number deleted. */
  delete(nodeIds: string[]): number {
    this.assertWritable();
    let count = 0;
    for (const id of nodeIds) {
      let existed = false;
      if (id in this.data) { delete this.data[id]; existed = true; }
      if (id in this.quarantine) { delete this.quarantine[id]; existed = true; }
      if (existed) {
        // An explicit delete is the ONLY thing that removes an entry from disk on the next write.
        this.deleted.add(id);
        this.touched.delete(id);
        this.touchedFields.delete(id);
        this.opGen.set(id, ++this.mutationSeq);
        count++;
      }
    }
    if (count > 0) this.scheduleSave();
    return count;
  }

  get dataEntries(): Record<string, StoredAnnotation> {
    return this.data;
  }

  getMergeStatusSnapshot(): AnnotationFileStatusSnapshot {
    return { ...this.mergeStatusSnapshot };
  }

  detectOrphaned(graph: RepositoryGraph): {
    total: number;
    orphaned: Array<{
      nodeId: string;
      nodeType: string;
      pass: number;
      updatedAt: string;
      summaryPreview: string;
      reason: 'node_missing' | 'node_type_changed';
    }>;
    byType: Record<string, number>;
  } {
    const orphaned: Array<{
      nodeId: string;
      nodeType: string;
      pass: number;
      updatedAt: string;
      summaryPreview: string;
      reason: 'node_missing' | 'node_type_changed';
    }> = [];
    const byType: Record<string, number> = {};

    for (const [nodeId, ann] of Object.entries(this.data)) {
      const graphNode = graph.nodes.get(nodeId);
      if (!graphNode) {
        orphaned.push({
          nodeId,
          nodeType: ann.nodeType,
          pass: ann.pass,
          updatedAt: ann.updatedAt,
          summaryPreview: (ann.annotation?.summary ?? '').slice(0, 100),
          reason: 'node_missing',
        });
        byType[ann.nodeType] = (byType[ann.nodeType] ?? 0) + 1;
      } else if (graphNode.type !== ann.nodeType) {
        orphaned.push({
          nodeId,
          nodeType: ann.nodeType,
          pass: ann.pass,
          updatedAt: ann.updatedAt,
          summaryPreview: (ann.annotation?.summary ?? '').slice(0, 100),
          reason: 'node_type_changed',
        });
        byType[ann.nodeType] = (byType[ann.nodeType] ?? 0) + 1;
      }
    }

    return {
      total: orphaned.length,
      orphaned: orphaned.sort((a, b) => b.pass - a.pass),
      byType,
    };
  }

  /**
   * Build a prioritized queue of nodes that need annotation.
   * Hard: contentStale / schema outdated / unannotated.
   * Derived (modules): importBaseline stale vs direct import contentHashes — persists after hard queue closes.
   */
  getQueue(
    graph: RepositoryGraph,
    snapshot: RepositoryFactsSnapshot,
    options: {
      domain?: string;
      limit?: number;
      propagation?: PropagationConfig;
      entrypoints?: readonly EntrypointFragment[];
    } = {},
  ): QueueItem[] {
    const limit = options.limit ?? 10;
    const rows = this.buildQueueRows(graph, snapshot, options);
    rows.sort(compareQueueItems);
    return rows.slice(0, limit).map(row => row.hydrate());
  }

  getQueuePage(
    graph: RepositoryGraph,
    snapshot: RepositoryFactsSnapshot,
    options: {
      domain?: string;
      limit?: number;
      offset?: number;
      propagation?: PropagationConfig;
      entrypoints?: readonly EntrypointFragment[];
      derivedOnly?: boolean;
      staleKind?: 'propagation' | 'content';
    } = {},
  ): AnnotationQueuePage {
    const {
      limit = 10,
      offset = 0,
      derivedOnly = false,
      staleKind,
    } = options;
    const rows = this.buildQueueRows(graph, snapshot, options);
    rows.sort(compareQueueItems);
    const counts = {
      stale: 0,
      staleContent: 0,
      stalePropagation: 0,
      unannotated: 0,
    };
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

    let displayRows = derivedOnly
      ? rows.filter(row => row.status === 'stale' && row.staleKind === 'propagation')
      : rows;
    if (staleKind) {
      displayRows = displayRows.filter(row => staleKind === 'propagation'
        ? row.status === 'stale' && row.staleKind === 'propagation'
        : row.status === 'stale' && row.staleKind !== 'propagation');
    }
    const displayCounts = {
      stale: 0,
      staleContent: 0,
      stalePropagation: 0,
      unannotated: 0,
    };
    for (const row of displayRows) {
      if (row.status === 'unannotated') {
        displayCounts.unannotated++;
      } else if (row.staleKind === 'propagation') {
        displayCounts.stale++;
        displayCounts.stalePropagation++;
      } else {
        displayCounts.stale++;
        displayCounts.staleContent++;
      }
    }
    const items = displayRows.slice(offset, offset + limit).map(row => row.hydrate());
    const byType = {
      module: 0,
      template: 0,
      'runtime-resource': 0,
      infra: 0,
      domain: 0,
    };
    for (const row of displayRows) byType[row.phase]++;

    return {
      items,
      counts,
      displayCounts,
      byType,
      needsWork: rows.length,
      totalRemaining: displayRows.length,
    };
  }

  /**
   * Single read-only pass over the annotatable surface for annotation health
   * and compliance gates. Classification and sort key are computed for every
   * needs-work node; full item text (reason/context) is hydrated only for the
   * returned sample. Replaces repeated full getQueue(MAX) materialization on
   * validate/compliance paths.
   */
  scanAnnotationHealth(
    graph: RepositoryGraph,
    snapshot: RepositoryFactsSnapshot,
    options: {
      domain?: string;
      propagation?: PropagationConfig;
      entrypoints?: readonly EntrypointFragment[];
    } = {},
  ): AnnotationHealthScan {
    const rows = this.buildQueueRows(graph, snapshot, options);
    let stale = 0;
    let staleContent = 0;
    let stalePropagation = 0;
    let unannotated = 0;
    for (const row of rows) {
      if (row.status === 'unannotated') {
        unannotated++;
      } else if (row.staleKind === 'propagation') {
        stale++;
        stalePropagation++;
      } else {
        stale++;
        staleContent++;
      }
    }
    rows.sort(compareQueueItems);
    const liteRows: AnnotationHealthScanRow[] = rows.map(row => ({
      nodeId: row.nodeId,
      status: row.status,
      ...(row.staleKind ? { staleKind: row.staleKind } : {}),
      phase: row.phase,
    }));
    const sample: AnnotationHealthScan['sample'] = (limit, predicate) => {
      const out: AnnotationHealthSampleItem[] = [];
      for (const row of rows) {
        if (out.length >= limit) break;
        if (predicate && !predicate(row)) continue;
        const item = row.hydrate();
        out.push({
          nodeId: item.nodeId,
          status: item.status,
          ...(item.staleKind ? { staleKind: item.staleKind } : {}),
          moduleKind: item.moduleKind,
          reason: item.reason,
        });
      }
      return out;
    };
    return {
      counts: { needsWork: rows.length, stale, staleContent, stalePropagation, unannotated },
      rows: liteRows,
      sample,
    };
  }

  private buildQueueRows(
    graph: RepositoryGraph,
    snapshot: RepositoryFactsSnapshot,
    options: {
      domain?: string;
      propagation?: PropagationConfig;
      entrypoints?: readonly EntrypointFragment[];
    } = {},
  ): QueueRow[] {
    const {
      domain,
      propagation = DEFAULT_PROPAGATION_CONFIG,
      entrypoints = [],
    } = options;
    const rows: QueueRow[] = [];
    const moduleDependencyDepths = computeModuleDependencyDepths(
      graph,
      snapshot.modules.map(mod => mod.id),
    );

    const derivedStaleSet = computeEntrypointBoundedDerived({
      graph,
      snapshot,
      annotations: this.data,
      entrypoints,
      propagation,
    });
    const moduleContentHashById = new Map(snapshot.modules.map(mod => [mod.id, mod.contentHash] as const));
    const contentHashLookup = buildDomainContentHashLookup(snapshot);
    const domainContentHashCache: DomainContentHashCache = new Map();

    for (const mod of snapshot.modules) {
      // Filter by domain if specified
      if (domain) {
        const domainId = domain.startsWith('domain:') ? domain : `domain:${domain}`;
        const outEdges = graph.outEdges.get(mod.id) ?? [];
        const isTagged = outEdges.some(e => e.kind === 'tagged' && e.to === domainId);
        if (!isTagged) continue;
      }

      const ann = this.data[mod.id];
      const schemaOutdated = ann && ((ann.schemaVersion ?? 1) < CURRENT_ANNOTATION_SCHEMA_VERSION);
      const contentStale = ann && ann.contentHash !== mod.contentHash;
      const isDerivedStale = !!(ann && !contentStale && !schemaOutdated && derivedStaleSet.has(mod.id));
      const classified = classifyStale({
        annotated: !!ann,
        contentStale: !!contentStale,
        schemaOutdated: !!schemaOutdated,
        isDerivedStale,
      });
      if (!classified) continue;

      const status = classified.status;
      const staleKind = classified.status === 'stale' ? classified.staleKind : undefined;

      // Priority inputs (sort key): downstream count, size, and quality.
      const inEdges = graph.inEdges.get(mod.id) ?? [];
      const downstreamCount = inEdges.filter(e => e.kind === 'imports').length;
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
          const outEdges = graph.outEdges.get(mod.id) ?? [];
          const domains = outEdges
            .filter(e => e.kind === 'tagged')
            .map(e => graph.nodes.get(e.to)?.label ?? e.to)
            .filter((d): d is string => d != null);
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
            reason = schemaOutdated && !contentStale
              ? `Schema outdated (v${ann?.schemaVersion ?? 1} < v${CURRENT_ANNOTATION_SCHEMA_VERSION}), needs backfill (${downstreamCount} downstream deps)`
              : contentStale
                ? `Content changed since last annotation (${downstreamCount} downstream deps)`
                : `Stale (${downstreamCount} downstream deps)`;
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
            label: graph.nodes.get(mod.id)?.label ?? mod.relativeFilePath,
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

    // Template/rendered-surface nodes — freshness from the template file content hash.
    const templates = snapshot.templates ?? [];
    for (const t of templates) {
      const node = graph.nodes.get(t.id);
      if (!node || node.type !== 'template') continue;

      const outEdges = graph.outEdges.get(t.id) ?? [];
      if (domain) {
        const domainId = domain.startsWith('domain:') ? domain : `domain:${domain}`;
        const isTagged = outEdges.some(e => e.kind === 'tagged' && e.to === domainId);
        if (!isTagged) continue;
      }

      const ann = this.data[t.id];
      const schemaOutdated = ann && ((ann.schemaVersion ?? 1) < CURRENT_ANNOTATION_SCHEMA_VERSION);
      const contentStale = ann && ann.contentHash !== t.contentHash;
      let status: QueueStatus;
      if (!ann) {
        status = 'unannotated';
      } else if (contentStale || schemaOutdated) {
        status = 'stale';
      } else {
        continue;
      }

      const inEdges = graph.inEdges.get(t.id) ?? [];
      const renderCount = inEdges.filter(e => e.kind === 'renders').length;
      const compositionInCount = inEdges.filter(e => e.kind === 'extends' || e.kind === 'includes').length;
      const compositionOutCount = outEdges.filter(e => e.kind === 'extends' || e.kind === 'includes').length;
      const domains = outEdges
        .filter(e => e.kind === 'tagged')
        .map(e => graph.nodes.get(e.to)?.label ?? e.to)
        .filter((d): d is string => d != null);
      const topExports = templateQueuePreview(t);
      const urgency = (renderCount * 2) + compositionInCount + compositionOutCount + (t.blocks?.length ?? 0);
      const phase: QueuePhase = 'template';
      const reason = status === 'stale'
        ? (schemaOutdated && !contentStale
          ? `Schema outdated (v${ann?.schemaVersion ?? 1} < v${CURRENT_ANNOTATION_SCHEMA_VERSION})`
          : 'Template content changed')
        : `Template not yet annotated (${renderCount} render edge${renderCount === 1 ? '' : 's'}, ${compositionOutCount} composition edge${compositionOutCount === 1 ? '' : 's'})`;

      const templateKind: ModuleKind = 'template';
      const templateStaleKind = status === 'stale' ? ('content' as const) : undefined;
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

    // Infra modules (IaC: SAM/CloudFormation, etc.)
    const infraModules = snapshot.infraModules ?? [];
    for (const infraMod of infraModules) {
      if (domain) {
        const domainId = domain.startsWith('domain:') ? domain : `domain:${domain}`;
        const outEdges = graph.outEdges.get(infraMod.id) ?? [];
        const isTagged = outEdges.some(e => e.kind === 'tagged' && e.to === domainId);
        if (!isTagged) continue;
      }

      const ann = this.data[infraMod.id];
      const schemaOutdated = ann && ((ann.schemaVersion ?? 1) < CURRENT_ANNOTATION_SCHEMA_VERSION);
      const contentStale = ann && ann.contentHash !== infraMod.contentHash;
      let status: QueueStatus;
      if (!ann) {
        status = 'unannotated';
      } else if (contentStale || schemaOutdated) {
        status = 'stale';
      } else {
        continue;
      }

      const outEdges = graph.outEdges.get(infraMod.id) ?? [];
      const domains = outEdges
        .filter(e => e.kind === 'tagged')
        .map(e => graph.nodes.get(e.to)?.label ?? e.to)
        .filter((d): d is string => d != null);
      const resourceCount = infraMod.resources.length;
      const urgency = resourceCount;
      const phase: QueuePhase = 'infra';
      const reason = status === 'stale'
        ? (schemaOutdated && !contentStale
          ? `Schema outdated (v${ann?.schemaVersion ?? 1} < v${CURRENT_ANNOTATION_SCHEMA_VERSION})`
          : 'IaC template content changed')
        : `IaC module not yet annotated (${resourceCount} resources)`;

      const infraKind: ModuleKind = 'infra';
      const infraStaleKind = status === 'stale' ? ('content' as const) : undefined;
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
          label: graph.nodes.get(infraMod.id)?.label ?? infraMod.relativeFilePath,
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

    // Runtime-resource nodes — freshness from per-resource IaC fragment hash (not whole template)
    const serviceSet = graph.byType.get('runtime-resource');
    const serviceIds = serviceSet ? Array.from(serviceSet) : [];
    for (const serviceId of serviceIds) {
      const parentInfraId = getParentInfraModuleId(graph, serviceId);
      if (!parentInfraId) continue;

      const resourceHash = resolveServiceResourceContentHash(
        graph,
        snapshot,
        serviceId,
        contentHashLookup.runtimeResourceHashes,
      );
      if (resourceHash === undefined) continue;

      if (domain) {
        const domainId = domain.startsWith('domain:') ? domain : `domain:${domain}`;
        const parentOut = graph.outEdges.get(parentInfraId) ?? [];
        const parentTagged = parentOut.some(e => e.kind === 'tagged' && e.to === domainId);
        if (!parentTagged) continue;
      }

      const ann = this.data[serviceId];
      const schemaOutdated = ann && ((ann.schemaVersion ?? 1) < CURRENT_ANNOTATION_SCHEMA_VERSION);
      const contentStale = ann && ann.contentHash !== resourceHash;
      let status: QueueStatus;
      if (!ann) {
        status = 'unannotated';
      } else if (contentStale || schemaOutdated) {
        status = 'stale';
      } else {
        continue;
      }

      const node = graph.nodes.get(serviceId);
      const domains = parentInfraId
        ? (graph.outEdges.get(parentInfraId) ?? []).filter(e => e.kind === 'tagged').map(e => graph.nodes.get(e.to)?.label ?? e.to).filter((d): d is string => d != null)
        : [];
      const urgency = 1;
      const phase: QueuePhase = 'runtime-resource';
      const reason = status === 'stale'
        ? (schemaOutdated && !contentStale ? 'Schema outdated' : 'IaC resource definition changed')
        : 'Runtime resource not yet annotated';

      const serviceKind: ModuleKind = 'runtime-resource';
      const serviceStaleKind = status === 'stale' ? ('content' as const) : undefined;
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
          label: node?.label ?? serviceId,
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

    // Domain nodes — freshness derived from member modules' contentHashes.
    // A domain annotation becomes stale when any of its tagged members changed,
    // which is the "upstream" propagation case (changes percolate up to the
    // containing domain).
    const domainSet = graph.byType.get('domain');
    const domainIds = domainSet ? Array.from(domainSet) : [];
    for (const domainId of domainIds) {
      // Domain filter: when caller scoped the query to a specific domain, only
      // surface that domain itself (and skip unrelated peers).
      if (domain) {
        const wantedId = domain.startsWith('domain:') ? domain : `domain:${domain}`;
        if (domainId !== wantedId) continue;
      }

      if (!shouldHardQueueDomain(graph, domainId, propagation)) continue;

      const ann = this.data[domainId];
      const currentHash = resolveCachedDomainContentHash(
        graph,
        snapshot,
        domainId,
        propagation,
        contentHashLookup,
        domainContentHashCache,
      );
      if (currentHash === undefined) continue;

      const schemaOutdated = ann && ((ann.schemaVersion ?? 1) < CURRENT_ANNOTATION_SCHEMA_VERSION);
      const contentStale = ann && ann.contentHash !== currentHash;
      // Membership-stale = the domain hash changed because some member content
      // changed even though the domain itself hasn't been re-annotated. This is
      // reported the same as content-stale because for a domain there's no
      // distinct "code" — its content IS the union of its members.
      let status: QueueStatus;
      if (!ann) {
        status = 'unannotated';
      } else if (contentStale || schemaOutdated) {
        status = 'stale';
      } else {
        continue;
      }

      const node = graph.nodes.get(domainId);
      const memberCount = (graph.inEdges.get(domainId) ?? []).filter(e => e.kind === 'tagged').length;
      const urgency = Math.min(memberCount, 50);
      const phase: QueuePhase = 'domain';
      const label = node?.label ?? domainId.replace(/^domain:/, '');
      const domainDepth = label.split('/').filter(Boolean).length;
      const reason = status === 'stale'
        ? (schemaOutdated && !contentStale
          ? `Schema outdated (v${ann?.schemaVersion ?? 1} < v${CURRENT_ANNOTATION_SCHEMA_VERSION})`
          : `Domain member modules changed; re-check domain-level summary, invariants and integrationPoints (${memberCount} members)`)
        : `Domain not yet annotated (${memberCount} members)`;

      const domainKind: ModuleKind = 'domain';
      const domainStaleKind = status === 'stale' ? ('content' as const) : undefined;
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

    return rows;
  }

  /**
   * Get annotation coverage statistics.
   */
  getStats(
    graph: RepositoryGraph,
    snapshot: RepositoryFactsSnapshot,
    options: {
      domainFilter?: string;
      propagation?: PropagationConfig;
      entrypoints?: readonly EntrypointFragment[];
    } = {},
  ): {
    totalModules: number;
    annotated: number;
    fresh: number;
    stale: number;
    unannotated: number;
    infraModules: { total: number; annotated: number; fresh: number; stale: number; unannotated: number };
    templates: { total: number; annotated: number; fresh: number; stale: number; unannotated: number };
    services: { total: number; annotated: number; fresh: number; stale: number; unannotated: number };
    byDomain: Record<string, { total: number; annotated: number; fresh: number }>;
    byTier: Record<string, { domains: string[]; totalModules: number }>;
    domainAnnotations: { totalDomains: number; annotated: number; fresh: number; stale: number; list: string[] };
  } {
    // When a domain scope is active, every per-type bucket is counted only for
    // nodes tagged to that domain so the roll-up matches the (already-scoped)
    // queue. With no filter, `inDomain` is always true and the totals stay
    // repo-wide and byte-identical to the unscoped behavior.
    const { domainFilter, propagation = DEFAULT_PROPAGATION_CONFIG, entrypoints = [] } = options;
    const inDomain = (domains: string[]): boolean => !domainFilter || domains.includes(domainFilter);
    const derivedStaleSet = computeEntrypointBoundedDerived({
      graph,
      snapshot,
      annotations: this.data,
      entrypoints,
      propagation,
    });
    const contentHashLookup = buildDomainContentHashLookup(snapshot);
    const domainContentHashCache: DomainContentHashCache = new Map();

    let annotated = 0;
    let fresh = 0;
    let stale = 0;
    let moduleTotal = 0;
    let templateTotal = 0;
    let infraTotal = 0;
    let svcTotal = 0;
    let domainTotal = 0;

    const byDomain: Record<string, { total: number; annotated: number; fresh: number }> = {};

    for (const mod of snapshot.modules) {
      // Get domains
      const outEdges = graph.outEdges.get(mod.id) ?? [];
      const domains = outEdges
        .filter(e => e.kind === 'tagged')
        .map(e => graph.nodes.get(e.to)?.label ?? e.to)
        .filter((d): d is string => d != null);

      const ann = this.data[mod.id];
      const isAnnotated = ann !== undefined;
      const contentFresh = isAnnotated && ann.contentHash === mod.contentHash && (ann.schemaVersion ?? 1) >= CURRENT_ANNOTATION_SCHEMA_VERSION;
      const propagationStale = isAnnotated && contentFresh && derivedStaleSet.has(mod.id);
      const isFresh = contentFresh && !propagationStale;

      if (inDomain(domains)) {
        moduleTotal++;
        if (isAnnotated) {
          annotated++;
          if (isFresh) fresh++;
          else stale++;
        }
      }

      for (const d of domains) {
        if (!byDomain[d]) byDomain[d] = { total: 0, annotated: 0, fresh: 0 };
        byDomain[d].total++;
        if (isAnnotated) byDomain[d].annotated++;
        if (isFresh) byDomain[d].fresh++;
      }
    }

    // Template/rendered-surface nodes
    const templates = snapshot.templates ?? [];
    let templateAnnotated = 0;
    let templateFresh = 0;
    let templateStale = 0;
    for (const t of templates) {
      const domains = (graph.outEdges.get(t.id) ?? [])
        .filter(e => e.kind === 'tagged')
        .map(e => graph.nodes.get(e.to)?.label ?? e.to)
        .filter((d): d is string => d != null);
      const ann = this.data[t.id];
      const isAnnotated = ann !== undefined;
      const isFresh = isAnnotated && ann.contentHash === t.contentHash && (ann.schemaVersion ?? 1) >= CURRENT_ANNOTATION_SCHEMA_VERSION;
      if (inDomain(domains)) {
        templateTotal++;
        if (isAnnotated) {
          templateAnnotated++;
          if (isFresh) templateFresh++;
          else templateStale++;
        }
      }
      for (const d of domains) {
        if (!byDomain[d]) byDomain[d] = { total: 0, annotated: 0, fresh: 0 };
        byDomain[d].total++;
        if (isAnnotated) byDomain[d].annotated++;
        if (isFresh) byDomain[d].fresh++;
      }
    }

    // Infra modules (IaC)
    const infraModules = snapshot.infraModules ?? [];
    let infraAnnotated = 0;
    let infraFresh = 0;
    let infraStale = 0;
    for (const im of infraModules) {
      const ann = this.data[im.id];
      const isAnnotated = ann !== undefined;
      const isFresh = isAnnotated && ann.contentHash === im.contentHash && (ann.schemaVersion ?? 1) >= CURRENT_ANNOTATION_SCHEMA_VERSION;
      const domains = (graph.outEdges.get(im.id) ?? []).filter(e => e.kind === 'tagged').map(e => graph.nodes.get(e.to)?.label ?? e.to).filter((d): d is string => d != null);
      if (inDomain(domains)) {
        infraTotal++;
        if (isAnnotated) {
          infraAnnotated++;
          if (isFresh) infraFresh++;
          else infraStale++;
        }
      }
      for (const d of domains) {
        if (!byDomain[d]) byDomain[d] = { total: 0, annotated: 0, fresh: 0 };
        byDomain[d].total++;
        if (isAnnotated) byDomain[d].annotated++;
        if (isFresh) byDomain[d].fresh++;
      }
    }

    // Runtime-resource nodes (Lambda, SQS, etc.)
    const serviceSet = graph.byType.get('runtime-resource');
    const serviceIds = serviceSet ? Array.from(serviceSet) : [];
    let svcAnnotated = 0;
    let svcFresh = 0;
    let svcStale = 0;
    for (const serviceId of serviceIds) {
      const resourceHash = resolveServiceResourceContentHash(
        graph,
        snapshot,
        serviceId,
        contentHashLookup.runtimeResourceHashes,
      );
      if (resourceHash === undefined) continue;
      const parentInfraId = getParentInfraModuleId(graph, serviceId);
      const ann = this.data[serviceId];
      const isAnnotated = ann !== undefined;
      const isFresh = isAnnotated && ann.contentHash === resourceHash && (ann.schemaVersion ?? 1) >= CURRENT_ANNOTATION_SCHEMA_VERSION;
      const parentDomains = parentInfraId
        ? (graph.outEdges.get(parentInfraId) ?? []).filter(e => e.kind === 'tagged').map(e => graph.nodes.get(e.to)?.label ?? e.to).filter((d): d is string => d != null)
        : [];
      if (inDomain(parentDomains)) {
        svcTotal++;
        if (isAnnotated) {
          svcAnnotated++;
          if (isFresh) svcFresh++;
          else svcStale++;
        }
      }
      for (const d of parentDomains) {
        if (!byDomain[d]) byDomain[d] = { total: 0, annotated: 0, fresh: 0 };
        byDomain[d].total++;
        if (isAnnotated) byDomain[d].annotated++;
        if (isFresh) byDomain[d].fresh++;
      }
    }

    // Count domain-level annotations + tier classification
    const domainNodes = graph.byType.get('domain') ?? new Set<string>();
    let annotatedDomains = 0;
    let freshDomains = 0;
    let staleDomains = 0;
    const domainList: string[] = [];
    const byTier: Record<string, { domains: string[]; totalModules: number }> = {
      business: { domains: [], totalModules: 0 },
      feature: { domains: [], totalModules: 0 },
      layer: { domains: [], totalModules: 0 },
      technical: { domains: [], totalModules: 0 },
    };
    for (const dId of domainNodes) {
      const dNode = graph.nodes.get(dId);
      const dAnn = this.data[dId];
      // Domain scope counts only the scoped domain node itself (matching the
      // queue's exact-domain filter); no filter counts every domain node.
      const domainInScope = !domainFilter || (dNode?.label ?? dId.replace(/^domain:/, '')) === domainFilter;
      if (domainInScope) {
        domainTotal++;
        if (dAnn) {
          annotatedDomains++;
          domainList.push(dNode?.label ?? dId);
          const currentHash = resolveCachedDomainContentHash(
            graph,
            snapshot,
            dId,
            propagation,
            contentHashLookup,
            domainContentHashCache,
          );
          const schemaOk = (dAnn.schemaVersion ?? 1) >= CURRENT_ANNOTATION_SCHEMA_VERSION;
          if (currentHash !== undefined && dAnn.contentHash === currentHash && schemaOk) {
            freshDomains++;
          } else {
            staleDomains++;
          }
        }
      }
      const tier = (dNode?.type === 'domain' && dNode.data?.tier) ? dNode.data.tier : 'technical';
      const taggedCount = (graph.inEdges.get(dId) ?? []).filter(e => e.kind === 'tagged').length;
      byTier[tier].domains.push(dNode?.label ?? dId);
      byTier[tier].totalModules += taggedCount;
    }

    // Use the scoped totals only when a domain filter is active; otherwise keep
    // the original repo-wide totals (snapshot/graph lengths) byte-for-byte.
    const modTotalOut = domainFilter ? moduleTotal : snapshot.modules.length;
    const templateTotalOut = domainFilter ? templateTotal : templates.length;
    const infraTotalOut = domainFilter ? infraTotal : infraModules.length;
    const svcTotalOut = domainFilter ? svcTotal : serviceIds.length;
    const domainTotalOut = domainFilter ? domainTotal : domainNodes.size;
    return {
      totalModules: modTotalOut,
      annotated,
      fresh,
      stale,
      unannotated: modTotalOut - annotated,
      infraModules: {
        total: infraTotalOut,
        annotated: infraAnnotated,
        fresh: infraFresh,
        stale: infraStale,
        unannotated: infraTotalOut - infraAnnotated,
      },
      templates: {
        total: templateTotalOut,
        annotated: templateAnnotated,
        fresh: templateFresh,
        stale: templateStale,
        unannotated: templateTotalOut - templateAnnotated,
      },
      services: {
        total: svcTotalOut,
        annotated: svcAnnotated,
        fresh: svcFresh,
        stale: svcStale,
        unannotated: svcTotalOut - svcAnnotated,
      },
      byDomain,
      byTier,
      domainAnnotations: {
        totalDomains: domainTotalOut,
        annotated: annotatedDomains,
        fresh: freshDomains,
        stale: staleDomains,
        list: domainList,
      },
    };
  }

  /**
   * Legacy: service annotations used to store the parent template file hash. When that value still
   * matches the current parent module hash, rewrite to the per-resource fragment hash (no pass bump).
   */
  migrateServiceAnnotationHashesFromParentTemplate(
    graph: RepositoryGraph,
    snapshot: RepositoryFactsSnapshot,
  ): number {
    let updated = 0;
    const runtimeResourceHashes = buildRuntimeResourceContentHashLookup(snapshot);
    for (const [nodeId, ann] of Object.entries(this.data)) {
      if (ann.nodeType !== 'runtime-resource') continue;
      const resourceHash = getResourceContentHashForServiceId(snapshot, nodeId, runtimeResourceHashes);
      if (!resourceHash || ann.contentHash === resourceHash) continue;
      const parentId = getParentInfraModuleId(graph, nodeId);
      if (!parentId) continue;
      const parentHash = getParentInfraContentHash(snapshot, parentId, runtimeResourceHashes);
      if (!parentHash || ann.contentHash !== parentHash) continue;
      this.assertWritable();
      this.data[nodeId] = {
        ...ann,
        contentHash: resourceHash,
        updatedAt: new Date().toISOString(),
      };
      this.touched.add(nodeId);
      // Whole-record migration write (no field set) with a fresh generation for the save-commit gate.
      this.opGen.set(nodeId, ++this.mutationSeq);
      updated++;
    }
    if (updated > 0) this.scheduleSave();
    return updated;
  }
}
