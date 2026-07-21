import type { McpToolRuntime } from '../types.js';

/** Same floor as search_context fusion: below this cosine, semantic hits are noise. */
const SEMANTIC_MIN_COSINE = 0.35;
const MAX_SUGGESTIONS = 3;

type DiagnosticAction = { when?: string; tool?: string; args?: Record<string, unknown>; note?: string };
type DiagnosticShape = { reason?: unknown; nextActions?: DiagnosticAction[] };

/**
 * Advisory semantic recovery for scope misses, appended centrally by executeTool for
 * every tool. Two triggers, both meaning "the scope text did not anchor to the graph":
 *
 * - `emptyDiagnostic.reason === "scope_unresolved"` — the scope string resolved to nothing;
 * - any emptyDiagnostic on a scope that resolved as a free-text `query:` fallback —
 *   bare phrases never produce scope_unresolved (resolveScope falls back to `query:<raw>`),
 *   so an empty result on a query scope is the common fuzzy-language miss.
 *
 * Up to three semantically similar graph nodes are appended to emptyDiagnostic.nextActions
 * as same-tool retry suggestions. Entry-point concern only: nothing resolves silently, and
 * token/graph facts still decide every result. No-op when the semantic index is absent,
 * empty, or the embedder fails (token-only installs keep the unchanged diagnostic).
 */
export async function appendSemanticScopeSuggestions(
  ctx: Pick<McpToolRuntime, 'getState'>,
  toolName: string,
  handlerArgs: Record<string, unknown>,
  response: unknown,
): Promise<void> {
  const scopeArg = typeof handlerArgs.scope === 'string' ? handlerArgs.scope.trim() : '';
  // inspect_node anchors via nodeId; a missed nodeId is the same recovery case as a missed scope.
  const nodeIdArg = typeof handlerArgs.nodeId === 'string' ? handlerArgs.nodeId.trim() : '';
  const rawScope = scopeArg || nodeIdArg;
  if (!rawScope) return;
  const diagnostic = scopeMissDiagnosticOf(response);
  if (!diagnostic) return;

  // One snapshot for the whole call: the graph used to validate suggested ids is the same generation
  // as the index that ranked them, even though a concurrent refresh may swap state across the await.
  const { semanticIndex, graph } = ctx.getState();
  if (!semanticIndex || semanticIndex.size === 0) return;

  // Explicit `query:`-prefixed scopes carry the prefix in the raw string; the embedder
  // should see only the phrase.
  const embedText = rawScope.replace(/^query:/, '').trim();
  if (!embedText) return;

  let hits: Array<{ id: string; score: number }>;
  try {
    const vector = await semanticIndex.embedQuery(embedText);
    hits = semanticIndex.query(vector, MAX_SUGGESTIONS * 2).filter(h => h.score >= SEMANTIC_MIN_COSINE);
  } catch {
    return;
  }

  // Retry via scope (dropping any missed nodeId — it would take precedence and miss again).
  const { nodeId: _missedNodeId, ...retryBase } = handlerArgs;
  const seen = new Set<string>([rawScope]);
  const actions: DiagnosticAction[] = [];
  for (const hit of hits) {
    if (actions.length >= MAX_SUGGESTIONS) break;
    if (seen.has(hit.id)) continue;
    // Skip ids no longer in the graph: a concurrent refresh may have removed/renamed a node the
    // (possibly stale) index still ranks, and suggesting it as a retry scope guarantees another miss.
    if (!graph.nodes.has(hit.id)) continue;
    seen.add(hit.id);
    actions.push({
      when: `if "${hit.id}" matches your intent (semantic similarity ${hit.score.toFixed(2)}; advisory)`,
      tool: toolName,
      args: { ...retryBase, scope: hit.id },
    });
  }
  if (actions.length === 0) return;
  diagnostic.nextActions = [...(diagnostic.nextActions ?? []), ...actions];
}

/**
 * The envelope places tool payloads under `result` (diagnostics at result.emptyDiagnostic)
 * and the resolved scope at resolvedScope.kind. Returns the diagnostic only when it
 * represents a scope miss: explicit scope_unresolved, or any empty result on a
 * free-text `query:` scope.
 */
function scopeMissDiagnosticOf(response: unknown): DiagnosticShape | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const envelope = response as Record<string, unknown>;
  const result = envelope.result;
  if (typeof result !== 'object' || result === null) return undefined;
  const diagnostic = (result as Record<string, unknown>).emptyDiagnostic;
  if (typeof diagnostic !== 'object' || diagnostic === null) return undefined;

  const shape = diagnostic as DiagnosticShape;
  if (shape.reason === 'scope_unresolved') return shape;

  const resolvedScope = envelope.resolvedScope;
  const kind = typeof resolvedScope === 'object' && resolvedScope !== null
    ? (resolvedScope as Record<string, unknown>).kind
    : undefined;
  return kind === 'query' ? shape : undefined;
}
