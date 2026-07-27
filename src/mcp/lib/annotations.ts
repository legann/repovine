import type { AnnotationContent, ModuleInfo, StoredAnnotation } from '../../types.js';
import { compareCodeUnits } from '../../platform/ordering.js';
import { importerCount, moduleLabelOf } from '../../graph/index.js';
import { CURRENT_ANNOTATION_SCHEMA_VERSION } from '../../types.js';
import { AnnotationContentSchema } from '../../annotations/store.js';
import {
  type AnnotationConsistency,
  computeAnnotationQuality,
  computeInconsistentModuleAnnotations,
  isHardConsistencyIssue,
} from '../../annotations/quality.js';
import { computeImportBaseline, resolveNodeContentHash } from '../../annotations/content-hash.js';
import { detectSideEffectKindsFromHints } from '../../annotations/side-effect-vocab.js';
import { clearMergeReviewHints } from '../../annotations/merge-review.js';
import { inferModuleKind } from '../../annotations/module-kind.js';
import { measureSubmittedAnnotationText } from '../../annotations/annotation-metrics.js';
import { graphStats } from '../../graph/index.js';
import { domainNodeId, owningModuleId } from '../../graph/node-ids.js';
import { getInterpreterEntrypoints } from '../../stage2/interpreter/entrypoint-store.js';
import { computePropagationPreview } from '../../annotations/propagation.js';
import { describeMergeKeeps } from '../../annotations/store.js';
import {
  needsWorkOf,
  publishedCoverageBucket,
  publishedDomainCoverage,
  rollUpCoverage,
} from '../../annotations/backlog.js';
import type { BacklogPhaseCounts, QueuePhase } from '../../annotations/backlog.js';
import { computeRiskScopeCandidates } from '../../annotations/risk-scope-candidates.js';
import { computeCarrierLinkGaps } from '../../annotations/carrier-links.js';
import { carrierTargetRiskHash, readCarrierReviewFile, readValidSuppressedTargets } from '../../annotations/carrier-review.js';
import { limitFrom, offsetFrom, DEFAULT_SEMANTIC_LIMIT } from '../response/pagination.js';
import { narrowTruncation, pageTruncation, truncationMap, type TruncationMap } from '../../response/truncation.js';

/** Ranking cut on the unannotated-module anomaly list, applied before the page limit sees it. */
const TOP_UNANNOTATED_MODULE_CAP = 20;
import { outsideRepoReport } from './refresh-summary.js';
import { type McpToolRuntime } from '../types.js';
import { resolveScope } from '../scope/resolve.js';
import { writeBoundaryIndex } from '../boundary-index.js';
import { hasBoundaryScopedRisk } from '../../annotations/format.js';

/** Canonical key order follows the validation schema, so new accepted fields cannot be dropped. */
const ANNOTATION_CONTENT_KEY_ORDER = (
  AnnotationContentSchema.keyof().options
) satisfies readonly (keyof AnnotationContent)[];

type SameKeys<A, B> = [Exclude<A, B>, Exclude<B, A>] extends [never, never] ? true : false;
const annotationContentKeysAreExhaustive: SameKeys<
  keyof AnnotationContent,
  typeof ANNOTATION_CONTENT_KEY_ORDER[number]
> = true;
void annotationContentKeysAreExhaustive;

function annotationContentWithStableKeyOrder(content: AnnotationContent): AnnotationContent {
  const out: AnnotationContent = { summary: content.summary };
  for (const k of ANNOTATION_CONTENT_KEY_ORDER) {
    if (k === 'summary') continue;
    const value = content[k];
    if (value !== undefined) Object.assign(out, { [k]: value });
  }
  return out;
}

function annotationSecretFieldPaths(content: AnnotationContent): string[] {
  const paths: string[] = [];
  const visit = (value: unknown, pathName: string): void => {
    if (typeof value === 'string') {
      if (containsSecretValue(value)) paths.push(pathName);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, idx) => visit(item, `${pathName}[${idx}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        visit(nested, `${pathName}.${key}`);
      }
    }
  };
  visit(content as unknown as Record<string, unknown>, 'annotation');
  return paths;
}

function containsSecretValue(text: string): boolean {
  const trimmed = text.trim();
  if (/^(?:[A-Z][A-Z0-9_]{5,}|[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD)[A-Z0-9_]*)$/.test(trimmed)) return false;
  return /\b(sk_(?:live|test)_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/.test(text)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)
    || /\b(?:secret|token|password|api[_ -]?key|client[_ -]?secret)\b\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{8,}/i.test(text);
}

function consistencyWarnings(consistency: AnnotationConsistency, mod: ModuleInfo | undefined): string[] {
  if (consistency.ok) return [];
  const byField = new Map<string, string[]>();
  for (const issue of consistency.issues) {
    const list = byField.get(issue.field) ?? [];
    list.push(issue.detail);
    byField.set(issue.field, list);
  }
  const warnings: string[] = [];
  const ke = byField.get('keyExports');
  if (ke?.length) {
    const sample = ke.slice(0, 5).join(', ');
    const more = ke.length > 5 ? ` (+${ke.length - 5} more)` : '';
    const realSample = mod ? mod.exports.slice(0, 8).map(e => e.name).join(', ') : '';
    warnings.push(
      `keyExports contains ${ke.length} name(s) not present in module exports: ${sample}${more}.`
      + (mod ? ` Real exports: ${realSample}${mod.exports.length > 8 ? ` (+${mod.exports.length - 8} more)` : ''}.` : ''),
    );
  }
  const env = byField.get('envDependencies');
  if (env?.length) {
    const sample = env.slice(0, 5).join(', ');
    const more = env.length > 5 ? ` (+${env.length - 5} more)` : '';
    warnings.push(`envDependencies declares ${env.length} var(s) not detected in module hints: ${sample}${more}.`);
  }
  for (const detail of byField.get('sideEffects') ?? []) {
    warnings.push(`sideEffects: ${detail}.`);
  }
  return warnings;
}

function countByType(items: Array<{ nodeType: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const i of items) {
    counts[i.nodeType] = (counts[i.nodeType] ?? 0) + 1;
  }
  return counts;
}

function formatQueueTypeParts(byType: BacklogPhaseCounts): string {
  return (Object.entries(byType) as [QueuePhase, number][])
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');
}

function queueOptionsFromCtx(ctx: McpToolRuntime, extra: Record<string, unknown> = {}) {
  const { graph, snapshot, annotations } = ctx.getState();
  const propagation = ctx.getConfig().annotations.propagation;
  const entrypoints = getInterpreterEntrypoints(graph);
  return {
    graph,
    snapshot,
    annotations,
    propagation,
    entrypoints,
    ...extra,
  };
}

export function getAnnotationQueue(ctx: McpToolRuntime, args: Record<string, unknown>): unknown {
  const { graph, snapshot, annotations, propagation, entrypoints } = queueOptionsFromCtx(ctx);
  // Already resolved by `resolveScope` at the handler; a second canonicalization here would be a
  // parallel ladder over the same string, which is how the two views drifted apart.
  const domain = args.domain as string | undefined;
  const limit = (args.limit as number) ?? 10;
  const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : 0;
  const derivedOnly = args.derivedOnly === true;
  const staleKindFilter = typeof args.staleKind === 'string' ? args.staleKind as 'propagation' | 'content' : undefined;
  const paged = annotations.getQueuePage(graph, snapshot, {
    ...(domain !== undefined ? { domain } : {}),
    limit,
    offset,
    propagation,
    entrypoints,
    derivedOnly,
    ...(staleKindFilter ? { staleKind: staleKindFilter } : {}),
  });
  const { items, counts, displayCounts, byType } = paged;
  const needsWork = counts.needsWork;
  const totalRemaining = displayCounts.needsWork;
  const returned = items.length;
  const queueBound = pageTruncation({
    shown: returned,
    total: totalRemaining,
    offset,
    noun: 'queued node',
    hint: `${totalRemaining} node(s) still need work. Pass offset ${offset + returned} with the same limit for the next page, or annotate the returned items and re-call.`,
  });
  const nextOffset = queueBound?.more.kind === 'page' ? queueBound.more.nextOffset : undefined;
  let hint: string;
  if (totalRemaining > 0) {
    const statusParts: string[] = [];
    if (displayCounts.staleContent > 0) statusParts.push(`${displayCounts.staleContent} content-stale`);
    if (displayCounts.stalePropagation > 0) {
      statusParts.push(`${displayCounts.stalePropagation} propagation-stale (entrypoint-bounded)`);
    }
    if (displayCounts.unannotated > 0) statusParts.push(`${displayCounts.unannotated} unannotated`);
    const typeParts = formatQueueTypeParts(byType);
    const modeText = derivedOnly || staleKindFilter === 'propagation'
      ? 'propagation-stale review queue'
      : 'annotation queue';
    const reviewDepthHint = ' Tier order: content-stale before propagation-stale; within each tier, bottom-up by dependency depth.'
      + ' Items with staleKind:"propagation" need inspect_node + upstream review and refreshImportBaseline:true (prose only when the upstream contract changed); staleKind:"content" needs full rewrite.';
    hint =
      `This is ONE unified ${modeText}, not separate queues. It spans every node type `
      + `(${typeParts}) and returns items in priority order: content-stale before propagation-stale, then modules/templates before services/infra/domain roll-ups, bottom-up within each tier. `
      + `${totalRemaining} item(s) in this view (${statusParts.join(', ')}); needsWork=${needsWork}. `
      + `This page shows ${returned} starting at offset ${offset}. `
      + (nextOffset !== undefined
        ? `Page with offset:${nextOffset} to inspect more without annotating, or annotate the returned items and re-call. `
        : 'This is the last page. ')
      + reviewDepthHint
      + ' Items shift as you annotate (annotated ones drop out), so prefer annotating the top before paging deeper. '
      + 'Use moduleKind + recommendedFields per item (propagation-stale items may have none — use refreshImportBaseline). '
      + 'For each: inspect_node first; use grepBody or a bounded includeBody slice only when source text is needed, then write_annotation.';
  } else if (derivedOnly || staleKindFilter === 'propagation') {
    hint = 'Propagation-stale review queue empty: no annotated modules in scope are currently flagged by upstream import changes. '
      + 'Default drain uses view:"queue" (content-stale ranks first).';
  } else {
    hint = 'Queue empty: every node in scope is annotated and fresh — code modules, templates, services, infra, and domain roll-ups alike.';
  }
  return {
    returned,
    offset,
    mode: derivedOnly || staleKindFilter === 'propagation'
      ? 'derived-review'
      : 'queue',
    totalRemaining,
    needsWork,
    ...(queueBound ? { truncation: { items: queueBound } } : {}),
    counts: {
      stale: counts.stale,
      unannotated: counts.unannotated,
      staleContent: counts.staleContent,
      stalePropagation: counts.stalePropagation,
    },
    byType,
    hint,
    items,
  };
}

export function getPropagationSlice(ctx: McpToolRuntime, args: Record<string, unknown>): unknown {
  const { graph, snapshot, annotations, propagation, entrypoints } = queueOptionsFromCtx(ctx);
  const from = args.from as string | undefined;
  if (!from || typeof from !== 'string') {
    return { error: 'from (module node id) is required.' };
  }
  const nodeId = resolveScope(ctx, from).nodeId;
  if (!nodeId) return { error: `Node not found: ${from}` };

  const preview = computePropagationPreview({
    graph,
    snapshot,
    annotations,
    entrypoints,
    propagation,
    from: nodeId,
    includeDomains: args.includeDomains === true,
  });

  return {
    from: nodeId,
    ...preview,
  };
}

/** Annotation-content field names whose value differs between the prior and the newly stored record. */
function changedAnnotationFields(before: AnnotationContent | undefined, after: AnnotationContent): string[] {
  const beforeRec = (before ?? {}) as Record<string, unknown>;
  const afterRec = after as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(beforeRec), ...Object.keys(afterRec)]);
  const changed: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(beforeRec[k]) !== JSON.stringify(afterRec[k])) changed.push(k);
  }
  return changed;
}

export function annotateModule(ctx: McpToolRuntime, args: Record<string, unknown>): unknown {
  const state = ctx.getState();
  const { graph, snapshot, modulesById, annotations } = state;
  const rawId = args.nodeId as string;
  const refreshImportBaseline = args.refreshImportBaseline === true;
  const rawPropagationSlice = args.propagationSlice;
  const rawAnnotation = args.annotation;
  if (rawAnnotation !== undefined && (typeof rawAnnotation !== 'object' || rawAnnotation === null || Array.isArray(rawAnnotation))) {
    return { error: 'annotation must be a JSON object with annotation fields when provided.' };
  }
  const contentFields = (rawAnnotation ?? {}) as Partial<AnnotationContent> & Record<string, unknown>;
  if (rawPropagationSlice !== undefined) {
    if (typeof rawPropagationSlice !== 'object' || rawPropagationSlice === null || Array.isArray(rawPropagationSlice)) {
      return { error: 'propagationSlice must be an object with anchor, path, and reviewedAt.' };
    }
    contentFields.propagationSlice = rawPropagationSlice as AnnotationContent['propagationSlice'];
  }
  const submittedKeys = Object.keys(contentFields).filter(key => contentFields[key] !== undefined);
  if (submittedKeys.length === 0 && !refreshImportBaseline && rawPropagationSlice === undefined) {
    return { error: 'Annotation update is empty. Provide annotation fields, propagationSlice, and/or refreshImportBaseline: true.' };
  }
  if ('summary' in contentFields) {
    if (typeof contentFields.summary !== 'string') {
      return { error: 'annotation.summary must be a string when provided.' };
    }
    const summary = contentFields.summary.trim();
    if (summary.length === 0) {
      return { error: 'annotation.summary cannot be empty.' };
    }
    if (summary.length < 12) {
      return { error: 'annotation.summary is too short; provide a concise but meaningful summary.' };
    }
    contentFields.summary = summary;
  }
  const submittedSecretFieldPaths = annotationSecretFieldPaths(contentFields as unknown as AnnotationContent);
  if (submittedSecretFieldPaths.length > 0) {
    return {
      error: 'Annotation appears to contain secret values. Store env/config names and risk descriptions only, never credential values.',
      fieldPaths: submittedSecretFieldPaths.slice(0, 8),
    };
  }
  // The same resolution the response envelope reports. A weaker ladder here answered
  // `Node not found` for an id the envelope had already resolved, inside one response.
  const nodeId = resolveScope(ctx, rawId).nodeId;
  if (!nodeId) return { error: `Node not found: ${rawId}` };
  const existing = annotations.get(nodeId);
  if (!existing && !('summary' in contentFields)) {
    return { error: 'annotation.summary is required when creating a new annotation.' };
  }
  if (refreshImportBaseline && !existing) {
    return { error: 'refreshImportBaseline requires an existing annotation.' };
  }
  const mergedContentCandidate = existing
    ? { ...existing.annotation, ...contentFields }
    : contentFields;
  const validationResult = AnnotationContentSchema.safeParse(mergedContentCandidate);
  if (!validationResult.success) {
    return { error: `Invalid annotation: ${validationResult.error.message}` };
  }
  const mergedContent = validationResult.data;
  const updatedFields = Object.keys(contentFields);
  const mergedAfterReview = clearMergeReviewHints(mergedContent, updatedFields);
  const secretFieldPaths = annotationSecretFieldPaths(mergedAfterReview);
  if (secretFieldPaths.length > 0) {
    return {
      error: 'Annotation appears to contain secret values. Store env/config names and risk descriptions only, never credential values.',
      fieldPaths: secretFieldPaths.slice(0, 8),
    };
  }
  const mergedContentFinal = mergedAfterReview;
  const node = graph.nodes.get(nodeId);
  if (!node) return { error: `Node not found: ${rawId}` };

  const mod = modulesById.get(nodeId);
  // `unknown` records that this node kind carries no hash to write the annotation against; the
  // freshness rule reads it back as "not comparable" rather than as a failed comparison.
  const contentHash = resolveNodeContentHash(nodeId, {
    graph,
    snapshot,
    propagation: ctx.getConfig().annotations.propagation,
  }) ?? 'unknown';

  const moduleKind = inferModuleKind({ mod, node });
  const lineCount = mod ? mod.exports.reduce((m, e) => Math.max(m, e.lineRange.end), 0) : 0;
  const qualityInput = {
    exportCount: mod?.exports.length ?? 0,
    lineCount,
    envVars: mod?.semanticHints?.envVars,
    moduleKind,
    exportNames: mod?.exports.map(e => e.name),
    detectedSideEffectKinds: detectSideEffectKindsFromHints(mod?.semanticHints),
  };
  const preWriteQuality = computeAnnotationQuality(mergedContentFinal, qualityInput);
  if (refreshImportBaseline && submittedKeys.length === 0) {
    const hardIssues = preWriteQuality.consistency.issues.filter(isHardConsistencyIssue);
    if (hardIssues.length > 0) {
      return {
        error: 'Cannot refreshImportBaseline while hard consistency issues exist; rewrite conflicting fields first.',
        consistency: preWriteQuality.consistency,
      };
    }
  }

  const pass = existing ? existing.pass + 1 : 1;
  const contentStable = annotationContentWithStableKeyOrder(mergedContentFinal);
  const nodeType = node.type as StoredAnnotation['nodeType'];
  const importBaseline = mod ? computeImportBaseline(graph, snapshot, nodeId) : undefined;
  // The precise set of annotation fields this write changed (vs the prior record) — not just the submitted
  // fields, since clearMergeReviewHints can also rewrite patterns/assumptions. Drives field-level merge so
  // a concurrent external writer's other fields survive.
  const changedFields = changedAnnotationFields(existing?.annotation, contentStable);
  annotations.set(nodeId, {
    nodeId,
    nodeType,
    contentHash,
    pass,
    updatedAt: new Date().toISOString(),
    annotation: contentStable,
    ...(importBaseline && Object.keys(importBaseline).length > 0 ? { importBaseline } : {}),
    schemaVersion: CURRENT_ANNOTATION_SCHEMA_VERSION,
  }, changedFields);

  // Keep the pre-edit push index (.repovine/boundary-index.json) in sync when this write changes a
  // boundary-scoped risk. write_annotation mutates the in-memory store only; without this the pre-edit
  // hook would deliver a stale advisory until the next build/refresh (merge_annotations already
  // refreshes; write_annotation did not). Fires only when risks were submitted AND a boundary risk is
  // present before or after — reprojects from annotations, no graph rebuild; best-effort (writeBoundaryIndex
  // swallows its own IO errors, so it never fails the annotation write).
  if (submittedKeys.includes('risks')
    && (hasBoundaryScopedRisk(existing?.annotation) || hasBoundaryScopedRisk(contentStable))) {
    writeBoundaryIndex(ctx.repoRoot, state);
  }

  const quality = preWriteQuality;

  const warnings = consistencyWarnings(quality.consistency, mod);

  const contextSessionId = ctx.contextSessionId;
  if (mod && contextSessionId && ctx.contextQualityStore) {
    const anchors = ctx.contextQualityStore.getReport(contextSessionId)?.aggregates.stableAnchors ?? [];
    const grounded = anchors.includes(nodeId)
      || anchors.some(a => a.startsWith('export:') && owningModuleId(a) === nodeId);
    if (!grounded) {
      warnings.push(
        `Provenance: ${nodeId} was not inspected or mapped in context session "${contextSessionId}" before this write. `
        + 'Run inspect_node on the node (or edit its file) in the same session so the annotation is grounded; '
        + 'score measures completeness, not correctness.',
      );
    }
  }

  const submittedAnnotation = measureSubmittedAnnotationText(contentFields);

  return {
    status: 'saved',
    nodeId,
    pass,
    contentHash,
    schemaVersion: CURRENT_ANNOTATION_SCHEMA_VERSION,
    merged: !!existing,
    moduleKind,
    ...(importBaseline && Object.keys(importBaseline).length > 0 ? { importBaseline } : {}),
    ...(refreshImportBaseline ? { importBaselineRefreshed: true } : {}),
    quality: {
      score: quality.score,
      tier: quality.tier,
      missingFields: quality.missingFields,
      consistency: quality.consistency,
    },
    submittedAnnotation,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export function getAnnotationsStats(ctx: McpToolRuntime, args: Record<string, unknown>): unknown {
  const { graph, snapshot, modulesById, annotations } = ctx.getState();
  const scopeDomain = typeof args.scopeDomain === 'string' ? args.scopeDomain : undefined;
  const full = annotations.getStats(graph, snapshot, {
    ...(scopeDomain ? { domain: scopeDomain } : {}),
    propagation: ctx.getConfig().annotations.propagation,
    entrypoints: getInterpreterEntrypoints(graph),
  });
  const includeAllDomains = args.includeAllDomains === true;
  const limit = limitFrom(args, DEFAULT_SEMANTIC_LIMIT, 100);
  const offset = offsetFrom(args);
  const domainsFilter = Array.isArray(args.domainsFilter)
    ? (args.domainsFilter as unknown[]).filter((d): d is string => typeof d === 'string')
    : undefined;

  const includeLightweight = args.includeLightweight === true;
  const isHeavyDomain = (label: string): boolean => {
    const node = graph.nodes.get(domainNodeId(label));
    return !node || node.type !== 'domain' || node.data?.weight !== 'lightweight';
  };
  let lightweightStaleSuppressed = 0;
  let lightweightUnannotatedSuppressed = 0;
  const staleDomains: Array<{ domain: string; stale: number; total: number }> = [];
  const unannotatedDomains: Array<{ domain: string; unannotated: number; total: number }> = [];
  for (const [domain, d] of Object.entries(full.byDomain)) {
    const heavy = isHeavyDomain(domain);
    if (d.stale > 0) {
      if (heavy || includeLightweight) staleDomains.push({ domain, stale: d.stale, total: d.total });
      else lightweightStaleSuppressed++;
    }
    if (d.unannotated > 0) {
      if (heavy || includeLightweight) unannotatedDomains.push({ domain, unannotated: d.unannotated, total: d.total });
      else lightweightUnannotatedSuppressed++;
    }
  }
  staleDomains.sort((a, b) => b.stale - a.stale);
  unannotatedDomains.sort((a, b) => b.unannotated - a.unannotated);

  const topUnannotatedModules: Array<{ nodeId: string; label: string; downstreamCount: number }> = [];
  let unannotatedModuleCandidates = 0;
  if (full.modules.unannotated > 0) {
    const annotationsData = annotations.getAll();
    const scored: Array<{ nodeId: string; label: string; downstreamCount: number }> = [];
    for (const mod of snapshot.modules) {
      if (annotationsData[mod.id]) continue;
      const downstreamCount = importerCount(graph, mod.id);
      const label = moduleLabelOf(graph, mod);
      scored.push({ nodeId: mod.id, label, downstreamCount });
    }
    scored.sort((a, b) => b.downstreamCount - a.downstreamCount);
    unannotatedModuleCandidates = scored.length;
    topUnannotatedModules.push(...scored.slice(0, TOP_UNANNOTATED_MODULE_CAP));
  }

  const allNodes = rollUpCoverage(full);
  const allNodeTypes = {
    scope: scopeDomain ?? 'repo-wide',
    total: allNodes.total,
    fresh: allNodes.fresh,
    needsWork: needsWorkOf(allNodes),
    ...(allNodes.unconfirmable > 0 ? { unconfirmable: allNodes.unconfirmable } : {}),
    note: (scopeDomain
      ? `Scoped to domain "${scopeDomain}": every bucket below (modules, templates, infra, services, domains) and this roll-up count only nodes tagged to it. `
      : 'Repo-wide. ')
      + 'These buckets are one annotation backlog, not separate queues. get_annotation_status({view:"queue"}) returns a single bottom-up list across all of them; the queue is done only when needsWork is 0 for every type, not just modules.'
      + (allNodes.unconfirmable > 0
        ? ' unconfirmable counts nodes the backlog asks no freshness question about (no hash source, no graph node, or an advisory package-domain roll-up); they are in total and never in needsWork.'
        : ''),
  };

  const inconsistentNotes = computeInconsistentModuleAnnotations(annotations, modulesById);
  const anomalyPreview = (shown: number, total: number) => total > shown
    ? narrowTruncation({
      shown,
      total,
      hint: 'Anomaly lists are previewed on the coverage view; raise limit, or call get_annotation_status({view:"queue"}) for the whole backlog.',
    })
    : undefined;
  const anomalyBounds = truncationMap({
    staleDomains: anomalyPreview(Math.min(limit, staleDomains.length), staleDomains.length),
    unannotatedDomains: anomalyPreview(Math.min(limit, unannotatedDomains.length), unannotatedDomains.length),
    topUnannotatedModules: anomalyPreview(
      Math.min(limit, topUnannotatedModules.length),
      // The list was already cut to the ranking cap before the page limit saw it, so the honest
      // total is how many candidates were scored, not how many survived the first cut.
      Math.max(unannotatedModuleCandidates, topUnannotatedModules.length),
    ),
    inconsistent: anomalyPreview(Math.min(limit, inconsistentNotes.length), inconsistentNotes.length),
  });

  const compact: Record<string, unknown> = {
    allNodeTypes,
    modules: publishedCoverageBucket(full.modules),
    templates: publishedCoverageBucket(full.templates),
    infra: publishedCoverageBucket(full.infraModules),
    services: publishedCoverageBucket(full.services),
    domainAnnotations: publishedDomainCoverage(full.domains),
    domainCount: scopeDomain ? (full.byDomain[scopeDomain] ? 1 : 0) : Object.keys(full.byDomain).length,
    anomalies: {
      staleDomains: staleDomains.slice(0, limit),
      unannotatedDomains: unannotatedDomains.slice(0, limit),
      topUnannotatedModules: topUnannotatedModules.slice(0, limit),
      inconsistent: {
        sample: inconsistentNotes.slice(0, limit).map(n => ({
          nodeId: n.nodeId,
          issues: n.issues.map(i => `${i.field}:${i.detail}`),
        })),
        note: 'Recomputed from annotation × current graph; advisory only (not a QueueStatus, does not affect freshness/coverage). Fix by re-running write_annotation with corrected fields.',
      },
      // Four previews of one backlog, each cut to the same limit. The queue view is what returns
      // them in full, so the bound points there rather than at an offset these previews do not take.
      ...(anomalyBounds ? { truncation: anomalyBounds } : {}),
      ...(lightweightStaleSuppressed + lightweightUnannotatedSuppressed > 0 ? {
        lightweightSuppressed: {
          stale: lightweightStaleSuppressed,
          unannotated: lightweightUnannotatedSuppressed,
          note: 'Lightweight (1-2 module) domains are excluded from anomalies by default. Pass includeLightweight: true to include them.',
        },
      } : {}),
    },
  };

  if (includeAllDomains) {
    const domainEntries = Object.entries(full.byDomain).sort(([a], [b]) => compareCodeUnits(a, b));
    const page = domainEntries.slice(offset, offset + limit);
    compact.byDomain = Object.fromEntries(page);
    compact.byTier = Object.fromEntries(
      Object.entries(full.byTier).map(([tier, tierInfo]) => [tier, {
        domainCount: tierInfo.domains.length,
        totalModules: tierInfo.totalModules,
      }]),
    );
    const byDomainBound = pageTruncation({
      shown: page.length,
      total: domainEntries.length,
      offset,
      noun: 'domain',
      hint: `${domainEntries.length} domain(s). Pass offset ${offset + page.length} with the same limit for the next page.`,
    });
    if (byDomainBound) compact.truncation = { byDomain: byDomainBound };
  } else if (domainsFilter && domainsFilter.length > 0) {
    const filtered: typeof full.byDomain = {};
    for (const d of domainsFilter) {
      if (full.byDomain[d]) filtered[d] = full.byDomain[d];
    }
    compact.byDomain = filtered;
  } else {
    compact.hint = 'Pass includeAllDomains: true with limit/offset for a paged per-domain breakdown, or scope a specific domain.';
  }

  return compact;
}

export async function cleanupOrphanedAnnotations(ctx: McpToolRuntime, args: Record<string, unknown>): Promise<unknown> {
  const { graph, annotations } = ctx.getState();
  const mode = args.mode as string;
  const nodeType = (args.nodeType as string) ?? 'all';

  const report = annotations.detectOrphaned(graph);
  const orphaned = nodeType === 'all'
    ? report.orphaned
    : report.orphaned.filter(o => o.nodeType === nodeType);

  if (mode === 'preview') {
    return {
      mode: 'preview',
      wouldRemove: orphaned.length,
      wouldRemoveByType: countByType(orphaned),
      entries: orphaned.slice(0, 50).map(o => ({
        nodeId: o.nodeId,
        pass: o.pass,
        summary: o.summaryPreview,
      })),
    };
  }

  if (mode === 'remove') {
    const idsToRemove = orphaned.map(o => o.nodeId);
    await annotations.flushAsync();
    const removed = annotations.delete(idsToRemove);
    await annotations.flushAsync();
    return {
      mode: 'remove',
      removed,
      removedByType: countByType(orphaned),
    };
  }

  return { error: `Unknown mode: ${mode}` };
}

export function getOrphanedAnnotations(ctx: McpToolRuntime, args: Record<string, unknown>): unknown {
  const { graph, annotations } = ctx.getState();
  const nodeType = (args.nodeType as string) ?? 'all';
  const limit = limitFrom(args, DEFAULT_SEMANTIC_LIMIT, 100);
  const offset = offsetFrom(args);
  const report = annotations.detectOrphaned(graph);

  if (nodeType !== 'all') {
    const filtered = report.orphaned.filter(o => o.nodeType === nodeType);
    const page = filtered.slice(offset, offset + limit);
    return {
      total: filtered.length,
      orphaned: page,
      byType: { [nodeType]: filtered.length },
      ...(orphanBound(page.length, filtered.length, offset) ?? {}),
    };
  }

  const page = report.orphaned.slice(offset, offset + limit);
  return {
    total: report.total,
    orphaned: page,
    byType: report.byType,
    ...(orphanBound(page.length, report.total, offset) ?? {}),
  };
}

/** The bound on one page of an advisory `items` list, keyed by the list it bounds. */
function itemsBound(shown: number, total: number, offset: number, noun: string): { truncation?: TruncationMap } {
  const truncation = truncationMap({
    items: pageTruncation({
      shown,
      total,
      offset,
      noun,
      hint: `${total} ${noun}(s). Pass offset ${offset + shown} with the same limit for the next page.`,
    }),
  });
  return truncation ? { truncation } : {};
}

/** The bound on one page of orphaned annotations, keyed by the list it bounds. */
function orphanBound(shown: number, total: number, offset: number): { truncation: TruncationMap } | undefined {
  const truncation = truncationMap({
    orphaned: pageTruncation({
      shown,
      total,
      offset,
      noun: 'orphaned annotation',
      hint: `${total} orphaned annotation(s). Pass offset ${offset + shown} with the same limit for the next page.`,
    }),
  });
  return truncation ? { truncation } : undefined;
}

export function getRiskScopeCandidateStatus(ctx: McpToolRuntime, args: Record<string, unknown>): unknown {
  const { graph, snapshot, annotations } = ctx.getState();
  const limit = limitFrom(args, DEFAULT_SEMANTIC_LIMIT, 100);
  const offset = offsetFrom(args);
  const scopeHints = Array.isArray(args.scopeHints)
    ? (args.scopeHints as unknown[]).filter((hint): hint is string => typeof hint === 'string')
    : undefined;
  const candidates = computeRiskScopeCandidates({
    graph,
    snapshot,
    annotations: annotations.getAll(),
    sampleLimit: limit,
    limit,
    offset,
    ...(scopeHints?.length ? { scopeHints } : {}),
  });

  return {
    total: candidates.total,
    consumer: candidates.consumer,
    boundary: candidates.boundary,
    byReason: candidates.byReason,
    items: candidates.items ?? [],
    ...itemsBound(candidates.items?.length ?? 0, candidates.totalItems ?? candidates.total, offset, 'candidate'),
    note: 'Advisory only: candidates are review prompts for plain/local risks, not stale items and not proof. Inspect the node/source before rewriting via write_annotation.',
  };
}

export function getCarrierGapStatus(ctx: McpToolRuntime, args: Record<string, unknown>): unknown {
  const { graph, annotations } = ctx.getState();
  const limit = limitFrom(args, DEFAULT_SEMANTIC_LIMIT, 100);
  const offset = offsetFrom(args);
  const scopeHints = Array.isArray(args.scopeHints)
    ? (args.scopeHints as unknown[]).filter((hint): hint is string => typeof hint === 'string')
    : undefined;
  const allAnnotations = annotations.getAll();
  const reviewed = readCarrierReviewFile(ctx.repoRoot).reviewedTargets;
  const suppressedSet = readValidSuppressedTargets(ctx.repoRoot, allAnnotations);

  // Full pair listing, reviewed targets included — suppression hides pairs from advisory counts,
  // never from this review view.
  const allPairs = computeCarrierLinkGaps({
    graph,
    annotations: allAnnotations,
    sampleLimit: Infinity,
    ...(scopeHints?.length ? { scopeHints } : {}),
  });
  const current = computeCarrierLinkGaps({
    graph,
    annotations: allAnnotations,
    sampleLimit: 0,
    suppressedTargetIds: suppressedSet,
    ...(scopeHints?.length ? { scopeHints } : {}),
  });

  const importersByTarget = new Map<string, string[]>();
  for (const sample of allPairs.sample) {
    if (sample.kind !== 'missing-carrier-link') continue;
    const importers = importersByTarget.get(sample.targetId) ?? [];
    importers.push(sample.importerId);
    importersByTarget.set(sample.targetId, importers);
  }
  const targetIds = [...importersByTarget.keys()].sort();
  const page = targetIds.slice(offset, offset + limit);
  const items = page.map((targetId) => {
    const currentHash = carrierTargetRiskHash(allAnnotations[targetId]?.annotation);
    const entry = reviewed[targetId];
    return {
      targetId,
      riskHash: currentHash,
      reviewed: entry
        ? {
          decidedAt: entry.decidedAt,
          ...(entry.reason ? { reason: entry.reason } : {}),
          hashValid: entry.riskHash === currentHash,
        }
        : null,
      importerIds: importersByTarget.get(targetId) ?? [],
    };
  });

  return {
    missingCarrierLinks: current.missingCarrierLinks,
    suppressedTargets: current.suppressedTargets,
    totalTargets: targetIds.length,
    items,
    total: targetIds.length,
    ...itemsBound(items.length, targetIds.length, offset, 'carrier-link target'),
    note: 'Advisory only: each target groups runtime 2-hop delegation candidates. Name the SSOT in the importer\'s integrationPoints where it delegates, or record reviewed-not-a-gap via decline_advisory({ "kind": "carrier-link-gaps" }). Suppression is workspace-local (.repovine/carrier-review.json) and re-surfaces when the target\'s consumer risks change.',
  };
}

export async function refreshContextCore(ctx: McpToolRuntime, args: Record<string, unknown>): Promise<unknown> {
  const before = graphStats(ctx.getState().graph);
  const reloadConfig = args.reloadConfig === true;
  const refreshResult = await Promise.resolve(ctx.refreshRepoState({ reloadConfig }));
  const afterState = ctx.getState();
  const after = graphStats(afterState.graph);

  const orphanedReport = afterState.annotations.detectOrphaned(afterState.graph);
  const annotationsData = afterState.annotations.getAll();
  const totalAnnotations = Object.keys(annotationsData).length;
  const domainsSuggestions = afterState.domainsSuggestions ?? { count: 0, axes: [], declinedHidden: 0 };
  const outsideRepo = outsideRepoReport(afterState.snapshot);
  const mergeKeeps = afterState.annotations.lastMergeKeeps;
  const mergeKeepsWarning = describeMergeKeeps(mergeKeeps);

  const result: Record<string, unknown> = {
    status: 'rebuilt',
    ...(reloadConfig ? {
      configReloaded: typeof refreshResult === 'object' && refreshResult !== null
        ? (refreshResult as { configReloaded?: boolean }).configReloaded === true
        : true,
    } : {}),
    builtAt: afterState.builtAt,
    before: { nodes: before.totalNodes, edges: before.totalEdges },
    after: { nodes: after.totalNodes, edges: after.totalEdges },
    annotations: {
      total: totalAnnotations,
      orphaned: orphanedReport.total,
      ...(orphanedReport.total > 0 ? { orphanedByType: orphanedReport.byType } : {}),
    },
    searchTokens: afterState.searchIndex.tokens.size,
    semanticSearch: afterState.semanticSearchRefresh,
    domainsSuggestions: {
      count: domainsSuggestions.count,
      axes: domainsSuggestions.axes,
      declinedHidden: domainsSuggestions.declinedHidden,
    },
    ...(outsideRepo ? { outsideRepo } : {}),
    // A separate key, not `annotations.warning`: that field is a single scalar and the orphan report
    // already owns it, and the two conditions are independent.
    ...(mergeKeepsWarning ? {
      annotationMergeKeeps: {
        readded: mergeKeeps.readded,
        reverted: mergeKeeps.reverted,
        sample: mergeKeeps.sample,
        warning: mergeKeepsWarning,
      },
    } : {}),
  };

  if (orphanedReport.total > 0) {
    (result.annotations as Record<string, unknown>).warning =
      `${orphanedReport.total} annotations reference nodes that no longer exist. Run get_annotation_status({ "view": "orphans" }) for details, or refresh_context({ "cleanupOrphans": true }) to resolve.`;
  }

  return result;
}
