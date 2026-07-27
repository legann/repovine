import type { RepositoryFactsSnapshot, RepositoryGraph, StoredAnnotation } from '../types.js';
import { compareCodeUnits } from '../platform/ordering.js';
import { owningModuleId } from '../graph/node-ids.js';
import { normalizeRisks } from './format.js';
import { parseIntegrationPointTargets } from './carrier-links.js';
import { nodeInScopeHints } from './scope-hints.js';
import { shortenText } from '../platform/text.js';
import { ANNOTATION_EXCERPT } from './excerpt.js';

export type RiskScopeSuggestion = 'consumer' | 'boundary';

export type RiskScopeCandidateReason =
  | 'consumer-obligation-cue'
  | 'consumer-role-cue'
  | 'boundary-explicit-cue'
  | 'published-contract-cue'
  | 'compatibility-surface-cue'
  | 'stored-or-wire-identity-cue'
  | 'migration-or-versioned-surface-cue'
  | 'path-supporting-cue'
  | 'integration-point-supporting-cue';

export interface RiskScopeCandidate {
  nodeId: string;
  nodeType: StoredAnnotation['nodeType'];
  riskIndex: number;
  suggestedScope: RiskScopeSuggestion;
  reasons: RiskScopeCandidateReason[];
  textPreview: string;
}

export interface RiskScopeCandidates {
  consumer: number;
  boundary: number;
  total: number;
  byReason: Partial<Record<RiskScopeCandidateReason, number>>;
  sample: RiskScopeCandidate[];
}

export interface RiskScopeCandidatesPage extends RiskScopeCandidates {
  items?: RiskScopeCandidate[];
  totalItems?: number;
  nextOffset?: number;
}

const DEFAULT_SAMPLE_LIMIT = 10;

const REASON_ORDER: RiskScopeCandidateReason[] = [
  'boundary-explicit-cue',
  'published-contract-cue',
  'compatibility-surface-cue',
  'stored-or-wire-identity-cue',
  'migration-or-versioned-surface-cue',
  'consumer-role-cue',
  'consumer-obligation-cue',
  'path-supporting-cue',
  'integration-point-supporting-cue',
];

const STRONG_BOUNDARY_REASONS = new Set<RiskScopeCandidateReason>([
  'boundary-explicit-cue',
  'published-contract-cue',
  'compatibility-surface-cue',
  'stored-or-wire-identity-cue',
  'migration-or-versioned-surface-cue',
]);

const CONSUMER_ROLE_CUE = /\b(?:importers?|consumers?|callers?|call ?sites?|downstream|clients?)\b/i;
const CONSUMER_OBLIGATION_CUE =
  /\b(?:must|should)\s+(?:verify|check|preserve|keep|maintain|retain|validate|inspect|confirm)\b|\bbefore changing\b|\blocally\b|\bpreserve at the caller\b|\b(?:callers?|importers?|consumers?|clients?)\s+must\b/i;

const BOUNDARY_EXPLICIT_CUE =
  /\b(?:frozen|off[- ]limits?|must not edit|compatibility boundary|codec boundary|boundary surface)\b/i;
const PUBLISHED_CONTRACT_CUE =
  /\b(?:published contract|public api|public contract|published surface|public surface)\b/i;
const COMPATIBILITY_SURFACE_CUE =
  /\b(?:external clients?|older clients?|subpath consumers?|compat(?:ibility|ible)?(?: surface| contract)?|backward[- ]compatible)\b/i;
const STORED_OR_WIRE_IDENTITY_CUE =
  /\b(?:wire contract|stored identity|persisted rows?|persisted id(?: mapping)?|stable id(?:entity)?)\b/i;
const MIGRATION_OR_VERSIONED_SURFACE_CUE =
  /\b(?:versioned migration|frozen migration|migration (?:contract|version)|versioned surface|versioned contract)\b/i;
const DRIFT_WITH_QUALIFIER_CUE =
  /\b(?:schema|contract)\s+drift\b(?=.*\b(?:published|public|external|versioned|compat(?:ibility|ible)?|clients?|consumers?|subpath)\b)|\b(?:published|public|external|versioned|compat(?:ibility|ible)?|clients?|consumers?|subpath)\b(?=.*\b(?:schema|contract)\s+drift\b)/i;

const PATH_SUPPORTING_CUE =
  /(?:^|[/_.-])(?:migrations?|public-api|schema|protocol|gateway|proxy|types)(?:$|[/_.-])/i;

function isCandidateNodeType(value: string): value is StoredAnnotation['nodeType'] {
  return value === 'module'
    || value === 'export-symbol'
    || value === 'domain'
    || value === 'runtime-resource'
    || value === 'template';
}

function addReason(out: Set<RiskScopeCandidateReason>, reason: RiskScopeCandidateReason): void {
  out.add(reason);
}

function orderedReasons(reasons: Set<RiskScopeCandidateReason>): RiskScopeCandidateReason[] {
  return REASON_ORDER.filter((reason) => reasons.has(reason));
}

/**
 * The candidate's risk text, at the excerpt width every quoting surface uses.
 *
 * A preview answers "is this the entry I meant", which is the same question `annotationContext`
 * answers, so it gets the same width. It used to be 180 against that surface's 150 — two literals
 * written apart, not two decisions.
 */
function textPreview(text: string): string {
  return shortenText(text.replace(/\s+/g, ' ').trim(), ANNOTATION_EXCERPT.entryChars);
}

function appendNodePathParts(
  parts: string[],
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  nodeId: string,
): void {
  const node = graph.nodes.get(nodeId);
  if (node) {
    parts.push(node.id, node.label, node.description);
    const data = node.data as Record<string, unknown> | undefined;
    for (const key of ['filePath', 'relativeFilePath', 'relPath', 'handler']) {
      const value = data?.[key];
      if (typeof value === 'string') parts.push(value);
    }
  }
  const moduleId = node?.type === 'module' ? nodeId : owningModuleId(nodeId);
  if (moduleId) {
    const mod = (snapshot.modules ?? []).find((m) => m.id === moduleId);
    if (mod) parts.push(mod.filePath, mod.relativeFilePath);
    const moduleNode = graph.nodes.get(moduleId);
    if (moduleNode && moduleNode.id !== nodeId) {
      parts.push(moduleNode.label, moduleNode.description);
      const data = moduleNode.data as Record<string, unknown> | undefined;
      for (const key of ['filePath', 'relativeFilePath']) {
        const value = data?.[key];
        if (typeof value === 'string') parts.push(value);
      }
    }
  }
  const template = snapshot.templates?.find((t) => t.id === nodeId);
  if (template) parts.push(template.relPath);
  const infra = snapshot.infraModules?.find((m) => m.id === nodeId);
  if (infra) parts.push(infra.filePath, infra.relativeFilePath);
}

function nodePathText(graph: RepositoryGraph, snapshot: RepositoryFactsSnapshot, nodeId: string): string {
  const parts: string[] = [];
  appendNodePathParts(parts, graph, snapshot, nodeId);
  return parts.filter(Boolean).join(' ');
}

function hasIntegrationPointSupport(graph: RepositoryGraph, annotation: StoredAnnotation): boolean {
  return parseIntegrationPointTargets(annotation.annotation.integrationPoints, {
    nodeExists: (id) => graph.nodes.has(id),
  }).length > 0;
}

function consumerReasons(text: string): Set<RiskScopeCandidateReason> {
  const reasons = new Set<RiskScopeCandidateReason>();
  if (CONSUMER_ROLE_CUE.test(text)) addReason(reasons, 'consumer-role-cue');
  if (CONSUMER_OBLIGATION_CUE.test(text)) addReason(reasons, 'consumer-obligation-cue');
  return reasons;
}

function boundaryReasons(
  text: string,
  pathText: string,
  hasIntegrationSupport: boolean,
): Set<RiskScopeCandidateReason> {
  const reasons = new Set<RiskScopeCandidateReason>();
  if (BOUNDARY_EXPLICIT_CUE.test(text)) addReason(reasons, 'boundary-explicit-cue');
  if (PUBLISHED_CONTRACT_CUE.test(text)) addReason(reasons, 'published-contract-cue');
  if (COMPATIBILITY_SURFACE_CUE.test(text) || DRIFT_WITH_QUALIFIER_CUE.test(text)) {
    addReason(reasons, 'compatibility-surface-cue');
  }
  if (STORED_OR_WIRE_IDENTITY_CUE.test(text)) addReason(reasons, 'stored-or-wire-identity-cue');
  if (MIGRATION_OR_VERSIONED_SURFACE_CUE.test(text)) {
    addReason(reasons, 'migration-or-versioned-surface-cue');
  }
  if (PATH_SUPPORTING_CUE.test(pathText)) addReason(reasons, 'path-supporting-cue');
  if (hasIntegrationSupport) addReason(reasons, 'integration-point-supporting-cue');
  return reasons;
}

function riskScopeCandidateSort(a: RiskScopeCandidate, b: RiskScopeCandidate): number {
  if (a.suggestedScope !== b.suggestedScope) return a.suggestedScope === 'boundary' ? -1 : 1;
  return b.reasons.length - a.reasons.length
    || compareCodeUnits(a.nodeId, b.nodeId)
    || a.riskIndex - b.riskIndex;
}

function incrementReason(
  byReason: Partial<Record<RiskScopeCandidateReason, number>>,
  reason: RiskScopeCandidateReason,
): void {
  byReason[reason] = (byReason[reason] ?? 0) + 1;
}

export function computeRiskScopeCandidates(input: {
  graph: RepositoryGraph;
  snapshot: RepositoryFactsSnapshot;
  annotations: Record<string, StoredAnnotation>;
  scopeHints?: string[];
  sampleLimit?: number;
  limit?: number;
  offset?: number;
  suggestedScope?: RiskScopeSuggestion;
}): RiskScopeCandidatesPage {
  const candidates: RiskScopeCandidate[] = [];
  for (const [nodeId, annotation] of Object.entries(input.annotations).sort(([a], [b]) => compareCodeUnits(a, b))) {
    if (!nodeInScopeHints(nodeId, input.scopeHints)) continue;
    const node = input.graph.nodes.get(nodeId);
    const nodeType = node && isCandidateNodeType(node.type) ? node.type : annotation.nodeType;
    if (!isCandidateNodeType(nodeType)) continue;
    if (!node && !input.graph.nodes.has(nodeId)) continue;

    const pathText = nodePathText(input.graph, input.snapshot, nodeId);
    const integrationSupport = hasIntegrationPointSupport(input.graph, annotation);
    const risks = normalizeRisks(annotation.annotation.risks);
    for (const [riskIndex, risk] of risks.entries()) {
      if (risk.scope !== 'local') continue;
      const consumer = consumerReasons(risk.text);
      const boundary = boundaryReasons(risk.text, pathText, integrationSupport);
      const strongBoundary = [...boundary].some((reason) => STRONG_BOUNDARY_REASONS.has(reason));
      const consumerCandidate =
        consumer.has('consumer-role-cue') && consumer.has('consumer-obligation-cue');
      const suggestedScope: RiskScopeSuggestion | undefined = strongBoundary
        ? 'boundary'
        : consumerCandidate
          ? 'consumer'
          : undefined;
      if (!suggestedScope) continue;

      const reasons = orderedReasons(new Set([...boundary, ...consumer]));
      candidates.push({
        nodeId,
        nodeType,
        riskIndex,
        suggestedScope,
        reasons,
        textPreview: textPreview(risk.text),
      });
    }
  }

  candidates.sort(riskScopeCandidateSort);
  const byReason: Partial<Record<RiskScopeCandidateReason, number>> = {};
  let consumer = 0;
  let boundary = 0;
  for (const candidate of candidates) {
    if (candidate.suggestedScope === 'consumer') consumer++;
    else boundary++;
    for (const reason of candidate.reasons) incrementReason(byReason, reason);
  }

  const sampleLimit = input.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  const pageSource = input.suggestedScope
    ? candidates.filter((candidate) => candidate.suggestedScope === input.suggestedScope)
    : candidates;
  const offset = input.offset ?? 0;
  const pageLimit = input.limit;
  const items = pageLimit === undefined
    ? undefined
    : pageSource.slice(offset, offset + pageLimit);
  const nextOffset = items && offset + items.length < pageSource.length ? offset + items.length : undefined;

  return {
    consumer,
    boundary,
    total: candidates.length,
    byReason,
    sample: candidates.slice(0, sampleLimit),
    ...(items ? { items, totalItems: pageSource.length } : {}),
    ...(nextOffset !== undefined ? { nextOffset } : {}),
  };
}
