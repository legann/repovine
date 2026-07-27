import type { ContextEvent, ContextEventMetrics } from './types.js';
import { publishedRefusalMessage } from '../response/refusal.js';
import { SCOPE_UNRESOLVED } from '../response/empty-reason.js';

type JsonObject = Record<string, unknown>;

const REQUEST_ECHO_KEYS = [
  'query',
  'scope',
  'nodeId',
  'types',
  'match',
  'perTokenLimit',
  'limit',
  'offset',
  'view',
  'mode',
  'direction',
  'exportName',
  'interfaceName',
  'groupBy',
  'depth',
  'kind',
  'kinds',
  'layer',
  'include',
  'categories',
  'minConfidence',
  'annotationReasoning',
  'includeBody',
  'grepBody',
  'responseFormat',
] as const;

const ANCHOR_KINDS = new Set(['package', 'module', 'runtime-resource', 'template', 'infra', 'export-symbol']);

/**
 * Tools whose responses describe repository NAVIGATION — scope resolution over
 * the graph. Only these can emit unresolved-scope noise. Service tools
 * (annotation writes/validation, status, refresh) echo string scopes as
 * `kind:'unknown'` by construction, and compliance followups REQUIRE them after
 * a rejected handoff — counting them as failed navigation lets a gate rejection
 * manufacture the noise that keeps the gate closed on retry. Their response
 * bytes still count toward the byte budget.
 */
const NAVIGATION_TOOLS = new Set([
  'search_context',
  'map_context',
  'inspect_node',
  'get_entrypoints',
  'trace_flow',
  'analyze_dependencies',
  'get_config_surface',
  'analyze_architecture',
]);

export interface BuildContextEventInput {
  seq: number;
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  responseText: string;
  testPackageRegex: RegExp;
  exportSymbolFloodRatio: number;
}

export function buildContextEvent(input: BuildContextEventInput): ContextEvent {
  return {
    seq: input.seq,
    tool: input.tool,
    at: new Date().toISOString(),
    responseBytes: input.responseText.length,
    requestEcho: buildRequestEcho(input.args),
    metrics: extractMetrics(input),
  };
}

function buildRequestEcho(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of REQUEST_ECHO_KEYS) {
    const value = args[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function extractMetrics(input: BuildContextEventInput): ContextEventMetrics {
  const result = isRecord(input.result) ? input.result : {};
  const confidence = typeof result.confidence === 'string' ? result.confidence : undefined;
  const resolvedScope = isRecord(result.resolvedScope) ? result.resolvedScope : undefined;
  const resolvedScopeKind = typeof resolvedScope?.kind === 'string' ? resolvedScope.kind : undefined;
  const resolvedScopeId = typeof resolvedScope?.id === 'string' ? resolvedScope.id : undefined;
  const resultBody = isRecord(result.result) ? result.result : undefined;
  const emptyDiagnostic = findEmptyDiagnostic(result);
  const emptyDiagnosticReason = typeof emptyDiagnostic?.reason === 'string'
    ? emptyDiagnostic.reason
    : undefined;
  // Read through the envelope's own reader rather than sniffing for a string field: the shape a
  // refusal is published in is declared in one place, and a change to it is a compile error here
  // instead of a metric that silently counts nothing.
  const hasError = publishedRefusalMessage(result) !== undefined;
  // `filtered_out` is the opposite of a scope miss: the scope anchored, it held rows, and the
  // caller's own filter removed them. Its predecessor `type_filter_excluded` was counted here and
  // named only search's type filter; merging the six narrowing names into one would have widened
  // that to every tool that filters, scoring a successful narrowing as a navigation failure.
  const unresolvedScope =
    NAVIGATION_TOOLS.has(input.tool)
    && (resolvedScopeKind === 'unknown'
      || emptyDiagnosticReason === SCOPE_UNRESOLVED
      || hasError);

  const search = input.tool === 'search_context' ? extractSearchMetrics(resultBody, input.testPackageRegex) : undefined;
  const stableAnchor = extractStableAnchor(input.tool, confidence, resolvedScopeKind, resolvedScopeId);
  const hadImpactOnModule = input.tool === 'analyze_dependencies'
    && confidence === 'high'
    && (resolvedScopeKind === 'module' || resolvedScopeKind === 'export-symbol')
    && resultBody?.mode === 'impact';
  const returnedFindings = input.tool === 'analyze_architecture'
    && typeof resultBody?.returnedFindings === 'number'
    ? resultBody.returnedFindings
    : undefined;

  return {
    confidence,
    resolvedScopeKind,
    resolvedScopeId,
    emptyDiagnosticReason,
    hasEmptyDiagnostic: !!emptyDiagnostic,
    hasError,
    unresolvedScope,
    isOrSearch: search?.isOrSearch ?? false,
    capRatio: search?.capRatio ?? 0,
    totalResults: search?.totalResults ?? 0,
    returned: search?.returned ?? 0,
    truncated: search?.truncated ?? false,
    capabilityDominantSearch: (search?.capRatio ?? 0) > input.exportSymbolFloodRatio,
    testPackageHit: search?.testPackageHit === true || (stableAnchor ? input.testPackageRegex.test(stableAnchor) : false),
    ...(stableAnchor ? { stableAnchor } : {}),
    hadImpactOnModule,
    ...(returnedFindings !== undefined ? { returnedFindings } : {}),
    emptyResult: confidence === 'low' && !!emptyDiagnostic,
  };
}

function extractSearchMetrics(resultBody: JsonObject | undefined, testPackageRegex: RegExp): {
  isOrSearch: boolean;
  capRatio: number;
  totalResults: number;
  returned: number;
  truncated: boolean;
  testPackageHit: boolean;
} {
  const matches = isRecord(resultBody?.matches) ? resultBody.matches : {};
  const strategy = isRecord(matches.strategy) ? matches.strategy : {};
  const topResults = Array.isArray(matches.topResults) ? matches.topResults.filter(isRecord) : [];
  const capCount = topResults.filter(item => item.type === 'export-symbol').length;
  const capRatio = topResults.length > 0 ? capCount / topResults.length : 0;
  const totalResults = typeof matches.totalResults === 'number' ? matches.totalResults : 0;
  const returned = typeof matches.returned === 'number' ? matches.returned : topResults.length;
  // A bound is reported only when it bit, so its presence is the fact — no separate flag to read.
  // Only bounds on the returned rows count: a filtered-out lightweight tag is a narrower question,
  // not a cut answer, and folding it in here would widen what this metric has always meant.
  const truncated = isRecord(matches.truncation)
    && Object.keys(matches.truncation).some(key => key !== 'lightweight');
  return {
    isOrSearch: strategy.used === 'or' || strategy.relaxedFrom === 'and',
    capRatio,
    totalResults,
    returned,
    truncated,
    testPackageHit: topResults.some(item => {
      const id = typeof item.id === 'string' ? item.id : '';
      const label = typeof item.label === 'string' ? item.label : '';
      return testPackageRegex.test(`${id} ${label}`);
    }),
  };
}

function extractStableAnchor(
  tool: string,
  confidence: string | undefined,
  resolvedScopeKind: string | undefined,
  resolvedScopeId: string | undefined,
): string | undefined {
  if (confidence !== 'high') return undefined;
  if (!resolvedScopeKind || !resolvedScopeId || !ANCHOR_KINDS.has(resolvedScopeKind)) return undefined;
  if (tool !== 'map_context' && tool !== 'inspect_node' && tool !== 'analyze_dependencies') return undefined;
  return resolvedScopeId;
}

function findEmptyDiagnostic(value: unknown): JsonObject | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.emptyDiagnostic)) return value.emptyDiagnostic;
  if (isRecord(value.result)) {
    if (isRecord(value.result.emptyDiagnostic)) return value.result.emptyDiagnostic;
    if (isRecord(value.result.matches) && isRecord(value.result.matches.emptyDiagnostic)) {
      return value.result.matches.emptyDiagnostic;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
