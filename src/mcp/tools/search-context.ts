import type { McpToolRuntime, ToolHandler } from '../types.js';
import { resolveScope, firstResultId, topSearchResultIds } from '../scope/resolve.js';
import { envelope, envelopeError, emptyNavigation, nav } from '../response/envelope.js';
import { limitFrom, offsetFrom, DEFAULT_SEARCH_LIMIT } from '../response/pagination.js';
import { searchEmptyDiagnostic } from '../response/empty-diagnostics.js';
import { searchGraph, type SemanticRanking } from '../lib/search-graph.js';
import { collectConfigSurface } from '../lib/config-surface.js';
import { collectEntrypoints } from '../lib/entrypoints.js';
import {
  SEARCH_ANNOTATION_ESCALATION_GAP,
  SEARCH_ANNOTATION_ESCALATION_NAV_REASON,
  searchAnnotationEscalation,
} from '../lib/search-annotation-escalation.js';
import { SEMANTIC_MIN_COSINE } from '../../semantic/relevance.js';

type SearchStrategy = {
  relaxedFrom?: string;
  used?: string;
  tokens?: string[];
  weakTokenOnlySuppressed?: boolean;
  postingLists?: {
    truncated?: boolean;
    tokens?: Record<string, { total?: number; considered?: number; truncated?: boolean }>;
  };
};

function getTopHitQuality(
  matches: Record<string, unknown>,
): { score: number; matchedTokenCount: number; semanticRank?: number } | undefined {
  const topResults = matches.topResults;
  if (!Array.isArray(topResults) || topResults.length === 0) return undefined;
  const top = topResults[0] as { score?: unknown; matchedTokenCount?: unknown; semanticRank?: unknown };
  return {
    score: typeof top.score === 'number' ? top.score : 0,
    matchedTokenCount: typeof top.matchedTokenCount === 'number' ? top.matchedTokenCount : 0,
    ...(typeof top.semanticRank === 'number' ? { semanticRank: top.semanticRank } : {}),
  };
}

/**
 * Auto AND→OR relax where the top hit is not a strong inspect anchor. A relaxed match is weak only
 * when the top hit matched a single query token — a hit matching ≥ 2 tokens stays a medium anchor
 * regardless of raw score. Score is IDF-scaled and corpus-size-dependent, so a borderline value is
 * not a reliable weakness signal: the same query flips medium↔low as the graph grows or a fixture
 * under-builds. Multi-token coverage is the stable signal.
 */
export function isWeakRelaxedSearchMatch(
  strategy: SearchStrategy | undefined,
  topQuality: { score: number; matchedTokenCount: number } | undefined,
  tokenCount: number,
): boolean {
  if (!topQuality || tokenCount <= 1 || strategy?.relaxedFrom !== 'and') return false;
  return topQuality.matchedTokenCount <= 1;
}

type SemanticQueryOutcome =
  | { status: 'disabled' }
  | {
    status: 'ok';
    ranking: SemanticRanking;
    compared: number;
    dimensionMismatches: number;
    candidatesBeforeFloor: number;
  }
  | { status: 'dimension-mismatch'; indexed: number; dimensionMismatches: number }
  | { status: 'error'; reason: string };

/**
 * Embed the query and rank node cards. The semantic backend is an entry-point
 * concern only: it nominates candidates; deterministic token scoring and graph
 * facts decide everything else. Failures degrade to token-only search.
 */
async function querySemanticRanking(ctx: McpToolRuntime, query: string, k: number): Promise<SemanticQueryOutcome> {
  const { semanticIndex } = ctx.getState();
  if (!semanticIndex || semanticIndex.size === 0) return { status: 'disabled' };
  // Best-effort cancellation: skip the ONNX embedding inference if the request was already cancelled.
  if (ctx.signal?.aborted) return { status: 'disabled' };
  try {
    const vector = await semanticIndex.embedQuery(query);
    const report = semanticIndex.queryDetailed(vector, k);
    if (report.compared === 0 && report.dimensionMismatches > 0) {
      return {
        status: 'dimension-mismatch',
        indexed: report.indexed,
        dimensionMismatches: report.dimensionMismatches,
      };
    }
    return {
      status: 'ok',
      ranking: report.hits.filter(hit => hit.score >= SEMANTIC_MIN_COSINE),
      compared: report.compared,
      dimensionMismatches: report.dimensionMismatches,
      candidatesBeforeFloor: report.hits.length,
    };
  } catch (e) {
    return { status: 'error', reason: (e as Error).message };
  }
}

export const handleSearchContext: ToolHandler = async (ctx, args) => {
  const query = String(args.query ?? '').trim();
  if (!query) return envelopeError('all', 'query is required');
  // Pin one graph/index generation for the whole request. A concurrent refresh_context swaps the
  // runtime state as a whole object mid-request; without this, semantic ranking computed against
  // generation G0 (before the embed await) would be joined onto a newer graph G1 — stale/missing
  // node ids and scores derived from old card text. RepovineState is generation-immutable, so a
  // captured reference is a consistent snapshot.
  const state = ctx.getState();
  const pinned: McpToolRuntime = { ...ctx, getState: () => state };
  const limit = limitFrom(args, DEFAULT_SEARCH_LIMIT);
  const offset = offsetFrom(args);
  const rawTypes = Array.isArray(args.types) ? args.types.filter((t): t is string => typeof t === 'string') : undefined;
  const nodeTypes = rawTypes
    ?.map(t => t === 'entrypoint' || t === 'config' ? undefined : t)
    .filter((t): t is 'domain' | 'package' | 'module' | 'runtime-resource' | 'template' | 'export-symbol' =>
      t === 'domain' || t === 'package' || t === 'module' || t === 'runtime-resource' || t === 'template' || t === 'export-symbol',
    );
  const includeNodes = !rawTypes?.length || !!nodeTypes?.length;
  const includeConfig = !rawTypes?.length || rawTypes.includes('config');
  const includeEntrypoints = !rawTypes?.length || rawTypes.includes('entrypoint');

  const semantic = includeNodes
    ? await querySemanticRanking(pinned, query, Math.max(10, limit * 2))
    : { status: 'disabled' as const };

  const matches = includeNodes
    ? searchGraph(pinned, {
        query,
        maxResults: limit,
        offset,
        ...(nodeTypes?.length ? { nodeTypes } : {}),
        ...(args.match ? { match: args.match } : {}),
        ...(args.perTokenLimit ? { perTokenLimit: args.perTokenLimit } : {}),
        ...(semantic.status === 'ok' && semantic.ranking.length > 0 ? { semantic: semantic.ranking } : {}),
      }) as Record<string, unknown>
    : { query, results: [], totalResults: 0, returned: 0, truncated: false };

  const matchStrategy = matches.strategy as Record<string, unknown> | undefined;
  if (matchStrategy) {
    // Merge, never replace: searchGraph already reported what the ranker did with the semantic
    // candidates (`candidates`, `exportSymbolDampened`). Assigning a fresh object here would drop
    // those, and the only test that asserts them calls searchGraph directly, so the loss is silent.
    const rankerSemantic = matchStrategy.semantic as Record<string, unknown> | undefined;
    if (semantic.status === 'ok') {
      matchStrategy.semantic = {
        ...rankerSemantic,
        attempted: true,
        used: semantic.ranking.length > 0,
        minCosine: SEMANTIC_MIN_COSINE,
        candidatesBeforeFloor: semantic.candidatesBeforeFloor,
        candidatesAboveFloor: semantic.ranking.length,
        compared: semantic.compared,
        dimensionMismatches: semantic.dimensionMismatches,
      };
    } else if (semantic.status === 'dimension-mismatch') {
      matchStrategy.semantic = {
        ...rankerSemantic,
        attempted: true,
        used: false,
        incompatibleDimensions: true,
        indexed: semantic.indexed,
        dimensionMismatches: semantic.dimensionMismatches,
      };
    }
  }

  const scope = resolveScope(pinned, `query:${query}`);
  const firstId = firstResultId(matches);
  const topIds = topSearchResultIds(matches, 3);
  const annotationEscalation = searchAnnotationEscalation(matches);
  const topQuality = getTopHitQuality(matches);
  const semanticOnlyTop = !!firstId
    && topQuality?.semanticRank !== undefined
    && topQuality.matchedTokenCount === 0;
  type SearchAuxiliaryResult = {
    items: Array<Record<string, unknown>>;
    total: number;
    pagination: { total: number; returned: number; offset: number; truncated: boolean };
  };
  const collectByScopes = (
    collector: (scopeArgs: Record<string, unknown>) => SearchAuxiliaryResult,
    idKey: string,
  ): SearchAuxiliaryResult => {
    const items: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    const scopes = [`query:${query}`, ...topIds];
    for (const scoped of scopes) {
      if (items.length >= Math.min(5, limit)) break;
      const result = collector({ ...args, scope: scoped, limit: Math.min(5, limit) - items.length });
      for (const item of result.items) {
        const key = typeof item[idKey] === 'string' ? item[idKey] as string : JSON.stringify(item);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(item);
        if (items.length >= Math.min(5, limit)) break;
      }
    }
    return {
      items,
      total: items.length,
      pagination: {
        total: items.length,
        returned: items.length,
        offset: 0,
        truncated: false,
      },
    };
  };
  const config = includeConfig
    ? collectByScopes(scopeArgs => collectConfigSurface(pinned, scopeArgs), 'name')
    : { items: [], total: 0, pagination: { total: 0, returned: 0, offset: 0, truncated: false } };
  const entrypoints = includeEntrypoints
    ? collectByScopes(scopeArgs => collectEntrypoints(pinned, scopeArgs), 'id')
    : { items: [], total: 0, pagination: { total: 0, returned: 0, offset: 0, truncated: false } };

  const navigation = emptyNavigation();
  if (firstId) {
    navigation.deeper.push(nav(
      'inspect_node',
      { nodeId: firstId },
      annotationEscalation.top1Annotated
        ? SEARCH_ANNOTATION_ESCALATION_NAV_REASON
        : semanticOnlyTop
          ? 'Inspect this advisory semantic neighbour and verify it against repository facts.'
          : 'Inspect the strongest matching node.',
    ));
    navigation.sideways.push(nav('map_context', { scope: firstId }, 'Map where the strongest match sits in the repository.'));
  }
  navigation.sideways.push(nav('map_context', { scope: query, limit: DEFAULT_SEARCH_LIMIT }, 'Try the query as a domain/package/module alias.'));
  if (entrypoints.items.length > 0) {
    navigation.crossLayer.push(nav('get_entrypoints', { scope: `query:${query}`, limit: DEFAULT_SEARCH_LIMIT }, 'Inspect execution starts matching the query.'));
  }
  if (config.items.length > 0) {
    navigation.sideways.push(nav('get_config_surface', { scope: `query:${query}`, limit: DEFAULT_SEARCH_LIMIT }, 'Inspect matching config/resource bindings.'));
  }

  const hasAuxiliaryMatches = config.items.length > 0 || entrypoints.items.length > 0;
  const strategy = matches.strategy as SearchStrategy | undefined;
  const tokenCount = strategy?.tokens?.length ?? 0;
  const weakRelaxedMatch = isWeakRelaxedSearchMatch(strategy, topQuality, tokenCount);
  const postingListsTruncated = strategy?.postingLists?.truncated === true;
  const gaps = firstId || hasAuxiliaryMatches ? [] : ['No graph node strongly matched the query; try a more specific symbol, route, package, or config name.'];
  if (strategy?.relaxedFrom === 'and') {
    gaps.push('No single node matched all query tokens; results were relaxed to bounded OR token matching.');
  }
  if (postingListsTruncated) {
    const windows = Object.entries(strategy?.postingLists?.tokens ?? {})
      .filter(([, window]) => window.truncated)
      .map(([token, window]) => `${token} (${window.considered ?? 0}/${window.total ?? 0})`);
    gaps.push(
      `Candidate posting lists were truncated before global ranking for: ${windows.join(', ')}. `
      + 'Increase perTokenLimit or narrow the query if the expected node is missing.',
    );
  }
  const vocabulary = matches.vocabulary as Record<string, string[]> | undefined;
  if (vocabulary) {
    for (const [token, suggestions] of Object.entries(vocabulary)) {
      gaps.push(`Token '${token}' is unknown to this repository — nearby vocabulary: ${suggestions.join(', ')}. Consider rephrasing the query with these terms.`);
    }
  }
  if (semantic.status === 'error') {
    gaps.push(`Semantic backend unavailable (${semantic.reason}); results are token-only.`);
  }
  if (semantic.status === 'dimension-mismatch') {
    gaps.push(
      `Semantic index dimensions are incompatible with the query vector `
      + `(${semantic.dimensionMismatches}/${semantic.indexed} entries skipped); results are token-only.`,
    );
  } else if (semantic.status === 'ok' && semantic.dimensionMismatches > 0) {
    gaps.push(
      `Semantic search skipped ${semantic.dimensionMismatches} index entries with incompatible vector dimensions.`,
    );
  }
  if (semanticOnlyTop) {
    gaps.push(
      'The top candidate is a nearest semantic neighbour with no matching repository token; '
      + 'it is not evidence that the requested functionality exists.',
    );
  }
  if (annotationEscalation.shouldEscalate && !gaps.includes(SEARCH_ANNOTATION_ESCALATION_GAP)) {
    gaps.push(SEARCH_ANNOTATION_ESCALATION_GAP);
  }
  const emptyDiagnostic = firstId || hasAuxiliaryMatches
    ? undefined
    : searchEmptyDiagnostic(pinned, query, rawTypes, matches);
  const hasHits = !!(firstId || hasAuxiliaryMatches);
  const summary = !hasHits
    ? `No context matched "${query}".`
    : semanticOnlyTop
      ? `No token-backed match for "${query}"; showing an advisory semantic neighbour.`
      : postingListsTruncated
        ? `Candidate retrieval for "${query}" was truncated before global ranking.`
        : weakRelaxedMatch
          ? `No strong match for "${query}"; showing relaxed OR candidates.`
          : `Found context candidates for "${query}".`;
  return envelope(scope, summary, {
    matches,
    suggestedScopes: matches.suggestedScopes ?? [],
    configMatches: config.items,
    entrypoints: entrypoints.items,
    ...(emptyDiagnostic ? { emptyDiagnostic } : {}),
  }, {
    confidence: !hasHits || weakRelaxedMatch || semanticOnlyTop || postingListsTruncated ? 'low' : 'medium',
    gaps,
    navigation,
  });
};
