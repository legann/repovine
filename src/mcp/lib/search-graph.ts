import { buildNodeView } from '../../graph/index.js';
import { DEFAULT_CONTEXT_QUALITY_CONFIG } from '../../context-quality/session-store.js';
import { type McpToolRuntime } from '../types.js';
import {
  WEAK_SEARCH_TOKENS,
  searchTokenize,
  suggestVocabulary,
  type SearchIndex,
} from './search-index.js';
import {
  DEFAULT_SEMANTIC_FUSION_POLICY,
  semanticRankBoost,
  type SemanticFusionPolicy,
} from '../../semantic/relevance.js';

export { WEAK_SEARCH_TOKENS, searchTokenize };

/** Per-token score contribution of an annotation-text match (below label=3, equal to id=2). */
const ANNOTATION_MATCH_SCORE = 2;

/** Top-N window for export-symbol flood detection (mirrors context-quality capRatio on topResults). */
const EXPORT_SYMBOL_FLOOD_MIN_WINDOW = 5;
/** Score multiplier applied to export symbols when flood ratio exceeds threshold. */
const EXPORT_SYMBOL_DAMPEN_FACTOR = 0.35;

function compareSearchMatches(a: SearchMatch, b: SearchMatch): number {
  return b.score - a.score
    || searchTypePriority(b.type, b.weight) - searchTypePriority(a.type, a.weight)
    || b.linksCount - a.linksCount;
}

/** Whether a match is a good map_context / inspect entry scope (not a raw export symbol). */
export function isSuggestedScopeCandidate(m: SearchMatch): boolean {
  if (m.type === 'export-symbol') return false;
  if (m.type === 'domain') {
    return (m.semanticRank !== undefined && m.semanticRank <= 2)
      || m.tier === 'business' || m.tier === 'feature';
  }
  if (m.type === 'runtime-resource') {
    return m.semanticRank !== undefined && m.semanticRank <= 2;
  }
  if (m.type === 'template') return true;
  return true;
}

function suggestedScopeReason(m: SearchMatch): string {
  if (m.semanticRank !== undefined && m.matchedTokens.length === 0) {
    return `Advisory semantic similarity (${m.semanticScore?.toFixed(2) ?? 'unknown'} cosine; no token match)`;
  }
  if (m.semanticRank !== undefined && m.matchedTokens.length > 0) {
    return `Semantic + token match (${m.matchedTokens.join(', ')})`;
  }
  return `Matched ${m.matchedTokens.length > 0 ? m.matchedTokens.join(', ') : 'query token(s)'}`;
}

/**
 * Downrank export symbols when they dominate token hits, so the modules and domains they belong to
 * are still reachable in the top window.
 *
 * This used to run only while semantic search was active. `@huggingface/transformers` is an
 * optional peer, so that gate made ranking depend on whether an optional dependency happened to be
 * installed: the same query on the same repository ranked differently for two users. The flood
 * condition below is about token hits and needs no vectors to be true, so it is evaluated either
 * way, and `exportSymbolDampened` reports when it fired.
 */
export function applyExportSymbolDampeningIfNeeded(
  matches: SearchMatch[],
  floodRatio: number,
  maxResults: number,
): boolean {
  if (matches.length === 0 || maxResults <= 0) return false;
  const window = Math.min(maxResults, matches.length);
  // A handful of hits cannot crowd anything out: with one match the ratio is 1 and "the whole top
  // block is export symbols" is trivially true, which would dampen a result set that has nothing
  // to promote in their place. Domination needs a window wide enough to be dominated.
  if (window < EXPORT_SYMBOL_FLOOD_MIN_WINDOW) return false;
  const preview = matches.slice(0, window);
  const exportSymbolCount = preview.filter(m => m.type === 'export-symbol').length;
  const exportSymbolRatio = exportSymbolCount / preview.length;
  const topBlock = Math.min(EXPORT_SYMBOL_FLOOD_MIN_WINDOW, window);
  const topBlockAllExportSymbols = topBlock > 0
    && preview.slice(0, topBlock).every(m => m.type === 'export-symbol');
  if (exportSymbolRatio <= floodRatio && !topBlockAllExportSymbols) return false;
  for (const m of matches) {
    if (m.type === 'export-symbol') m.score *= EXPORT_SYMBOL_DAMPEN_FACTOR;
  }
  return true;
}

export function tokenWeight(token: string, searchIndex: SearchIndex): number {
  if (WEAK_SEARCH_TOKENS.has(token)) return 0.5;
  const documentFrequency = searchIndex.tokens.get(token)?.size ?? 0;
  if (token.length >= 10 || documentFrequency <= 3) return 3;
  if (token.length >= 6 || documentFrequency <= 10) return 2;
  return 1;
}

export function searchTypePriority(type: string, weight?: string): number {
  if (type === 'module') return 5;
  if (type === 'template') return 4.5;
  if (type === 'runtime-resource') return 4;
  if (type === 'export-symbol') return 3;
  if (type === 'package') return 2;
  if (type === 'domain') return weight === 'lightweight' ? 0 : 1;
  return 0;
}

type SearchMatchMode = 'and' | 'or' | 'auto';
type SearchMatch = {
  id: string;
  label: string;
  type: string;
  score: number;
  linksCount: number;
  matchedTokens: string[];
  annotationMatched: boolean;
  semanticRank?: number;
  semanticScore?: number;
  tier?: string;
  weight?: string;
};

/** Precomputed semantic ranking passed in by the caller (search_context embeds the query asynchronously). */
export type SemanticRanking = Array<{ id: string; score: number }>;

export function searchGraph(
  ctx: McpToolRuntime,
  args: Record<string, unknown>,
  semanticPolicy: SemanticFusionPolicy = DEFAULT_SEMANTIC_FUSION_POLICY,
): unknown {
  const { graph, searchIndex } = ctx.getState();
  const rawQuery = (args.query as string).trim();
  const normalized = rawQuery.replace(/\.(tsx?|jsx?)$/, '').replace(/\/index$/, '');
  const tokens = searchTokenize(normalized);
  const max = (args.maxResults as number) ?? 10;
  const offset = Math.max(0, (args.offset as number) ?? 0);
  const nodeTypes = args.nodeTypes as string[] | undefined;
  const requestedMatch = args.match === 'and' || args.match === 'or' || args.match === 'auto'
    ? args.match as SearchMatchMode
    : 'auto';
  // Per-token candidate budget before global ranking. `topTokenCandidates` scores every candidate
  // in the posting list either way, so this bounds the size of the union handed to global ranking,
  // not the scoring work.
  //
  // Measured posting-list sizes: on repovine 3.6% of tokens exceed 20 and 1.6% exceed 50; on a
  // 1979-module app repo, 3.7% and 2.0%. The band between those two is where a discriminating token
  // loses real candidates. Above it the tail is extreme (thousands of nodes for the top tokens) and
  // truncating is correct — a token matching a third of the graph carries no signal. Hence 50, not
  // 20 and not unbounded. `postingLists` reports every token where the budget still bit.
  const perTokenLimit = Math.max(1, Math.min(100, (args.perTokenLimit as number | undefined) ?? Math.max(30, max * 5)));
  const includeLightweight = args.includeLightweight === true;
  const semantic = Array.isArray(args.semantic) ? args.semantic as SemanticRanking : [];
  const postingLists: Record<string, {
    total: number;
    considered: number;
    limit: number;
    truncated: boolean;
    weakToken: boolean;
  }> = {};
  const semanticRankById = new Map<string, { rank: number; score: number }>();
  semantic.forEach((hit, rank) => {
    if (!semanticRankById.has(hit.id)) semanticRankById.set(hit.id, { rank, score: hit.score });
  });

  const isLightweightDomain = (nodeId: string): boolean => {
    const n = graph.nodes.get(nodeId);
    return n?.type === 'domain' && n.data?.weight === 'lightweight';
  };
  const isExactNameMatch = (nodeId: string, label: string): boolean => {
    const q = normalized.toLowerCase();
    if (label.toLowerCase() === q) return true;
    const strippedId = nodeId.replace(/^[^:]+:/, '').toLowerCase();
    return strippedId === q;
  };

  const linksCountFor = (id: string): number => {
    const out = (graph.outEdges.get(id) ?? []).filter(e => e.kind !== 'contains').length;
    const inc = (graph.inEdges.get(id) ?? []).filter(e => e.kind !== 'contains').length;
    return out + inc;
  };

  const scoreNodeForToken = (nodeId: string, token: string): number => {
    const node = graph.nodes.get(nodeId);
    if (!node) return 0;
    const idL = node.id.toLowerCase();
    const labelL = node.label.toLowerCase();
    const searchableData = node.type === 'export-symbol' && node.data
      ? [node.data.signature ?? '', node.data.typeValue ?? '', ...(node.data.implementsInterfaces ?? [])].join(' ').toLowerCase()
      : '';
    const annotationL = searchIndex.annotationText.get(nodeId) ?? '';
    let score = 0;
    if (labelL.includes(token)) score += 3;
    if (idL.includes(token)) score += 2;
    if (searchableData && searchableData.includes(token)) score += 2;
    if (annotationL && annotationL.includes(token)) score += ANNOTATION_MATCH_SCORE;
    if (node.type === token) score += 1;
    score += searchTypePriority(node.type, node.type === 'domain' && node.data?.weight ? node.data.weight : undefined) / 10;
    score += Math.min(1, linksCountFor(nodeId) / 10);
    return score;
  };

  const topTokenCandidates = (token: string): string[] => {
    const candidates = [...(searchIndex.tokens.get(token) ?? [])];
    const tokenLimit = WEAK_SEARCH_TOKENS.has(token) ? Math.max(3, Math.floor(perTokenLimit / 3)) : perTokenLimit;
    const ranked = candidates
      .map(id => ({ id, score: scoreNodeForToken(id, token) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score);
    const considered = Math.min(tokenLimit, ranked.length);
    postingLists[token] = {
      total: ranked.length,
      considered,
      limit: tokenLimit,
      truncated: ranked.length > considered,
      weakToken: WEAK_SEARCH_TOKENS.has(token),
    };
    return ranked.slice(0, tokenLimit).map(item => item.id);
  };

  const candidatesForAnd = (): Set<string> => {
    if (tokens.length === 0) return new Set();
    if (tokens.length === 1) return new Set(searchIndex.tokens.get(tokens[0]) ?? []);
    const first = searchIndex.tokens.get(tokens[0]) ?? new Set();
    let candidateIds = new Set(first);
    for (let i = 1; i < tokens.length; i++) {
      const next = searchIndex.tokens.get(tokens[i]) ?? new Set();
      candidateIds = new Set([...candidateIds].filter(id => next.has(id)));
    }
    return candidateIds;
  };

  const strongTokens = tokens.filter(token => !WEAK_SEARCH_TOKENS.has(token));
  const hasStrongTokenHit = strongTokens.some(token => (searchIndex.tokens.get(token)?.size ?? 0) > 0);

  const candidatesForOr = (options?: { allowWeakWithoutStrongAnchor?: boolean }): Set<string> => {
    const candidateIds = new Set<string>();
    for (const token of tokens) {
      if (
        WEAK_SEARCH_TOKENS.has(token)
        && strongTokens.length > 0
        && !hasStrongTokenHit
        && !options?.allowWeakWithoutStrongAnchor
      ) {
        continue;
      }
      for (const id of topTokenCandidates(token)) candidateIds.add(id);
    }
    return candidateIds;
  };

  let usedMatch: SearchMatchMode = requestedMatch === 'auto' && tokens.length > 1 ? 'and' : requestedMatch;
  let candidateIds = requestedMatch === 'or' ? candidatesForOr({ allowWeakWithoutStrongAnchor: true }) : candidatesForAnd();
  let relaxedFrom: SearchMatchMode | undefined;
  if (requestedMatch === 'auto' && tokens.length > 1 && candidateIds.size === 0) {
    relaxedFrom = 'and';
    usedMatch = 'or';
    candidateIds = candidatesForOr();
  }
  const weakTokenOnlySuppressed =
    requestedMatch === 'auto'
    && relaxedFrom === 'and'
    && strongTokens.length > 0
    && !hasStrongTokenHit
    && tokens.some(token => WEAK_SEARCH_TOKENS.has(token) && (searchIndex.tokens.get(token)?.size ?? 0) > 0);

  // Semantic hits are entry candidates regardless of token-match mode.
  for (const hit of semantic) {
    if (graph.nodes.has(hit.id)) candidateIds.add(hit.id);
  }

  // Repository-vocabulary suggestions for strong tokens the index does not know.
  const vocabulary: Record<string, string[]> = {};
  for (const token of strongTokens) {
    if ((searchIndex.tokens.get(token)?.size ?? 0) > 0) continue;
    const suggestions = suggestVocabulary(token, searchIndex);
    if (suggestions.length > 0) vocabulary[token] = suggestions;
  }
  const hasVocabulary = Object.keys(vocabulary).length > 0;

  const allMatches: SearchMatch[] = [];
  let lightweightHidden = 0;
  for (const nodeId of candidateIds) {
    const node = graph.nodes.get(nodeId);
    if (!node) continue;
    if (nodeTypes?.length && !nodeTypes.includes(node.type)) continue;
    if (!includeLightweight && isLightweightDomain(node.id) && !isExactNameMatch(node.id, node.label)) {
      lightweightHidden++;
      continue;
    }
    const idL = node.id.toLowerCase();
    const labelL = node.label.toLowerCase();
    const searchableData = node.type === 'export-symbol' && node.data
      ? [node.data.signature ?? '', node.data.typeValue ?? '', ...(node.data.implementsInterfaces ?? [])].join(' ').toLowerCase()
      : '';
    const annotationL = searchIndex.annotationText.get(nodeId) ?? '';
    let score = 0;
    let annotationMatched = false;
    const matchedTokens: string[] = [];
    for (const t of tokens) {
      let tokenScore = 0;
      if (labelL.includes(t)) tokenScore += 3;
      if (idL.includes(t)) tokenScore += 2;
      if (searchableData && searchableData.includes(t)) tokenScore += 2;
      if (annotationL && annotationL.includes(t)) {
        tokenScore += ANNOTATION_MATCH_SCORE;
        annotationMatched = true;
      }
      if (node.type === t) tokenScore += 1;
      if (tokenScore > 0) {
        matchedTokens.push(t);
        score += tokenScore * tokenWeight(t, searchIndex);
      }
    }
    const semanticHit = semanticRankById.get(nodeId);
    if (semanticHit) {
      score += semanticRankBoost(semanticHit.rank, semanticPolicy);
      score += semanticHit.score * semanticPolicy.cosineWeight;
    }
    if (score > 0) {
      const linksCount = linksCountFor(node.id);
      score += Math.min(5, matchedTokens.length);
      score += Math.min(3, Math.floor(linksCount / 3));
      const tier = node.type === 'domain' && node.data?.tier ? node.data.tier : undefined;
      const weight = node.type === 'domain' && node.data?.weight ? node.data.weight : undefined;
      allMatches.push({
        id: node.id, label: node.label, type: node.type, score, linksCount, matchedTokens, annotationMatched,
        ...(semanticHit ? { semanticRank: semanticHit.rank, semanticScore: Number(semanticHit.score.toFixed(4)) } : {}),
        tier, weight,
      });
    }
  }
  allMatches.sort(compareSearchMatches);

  const exportSymbolFloodRatio = ctx.contextQualityStore?.getConfig().exportSymbolFloodRatio
    ?? DEFAULT_CONTEXT_QUALITY_CONFIG.exportSymbolFloodRatio;
  const exportSymbolDampened = applyExportSymbolDampeningIfNeeded(
    allMatches,
    exportSymbolFloodRatio,
    max,
  );
  if (exportSymbolDampened) allMatches.sort(compareSearchMatches);

  const enrichMatch = (m: SearchMatch) => {
    const nodeView = buildNodeView(graph, m.id);
    const out: Record<string, unknown> = {
      id: m.id, label: m.label, type: m.type, score: m.score,
      matchedTokens: m.matchedTokens,
      matchedTokenCount: m.matchedTokens.length,
      children: nodeView?.drill_down.length ?? 0,
      links: nodeView?.linksPagination?.total ?? nodeView?.links?.length ?? 0,
    };
    if (m.annotationMatched) out.annotationMatched = true;
    if (m.semanticRank !== undefined) {
      out.semanticRank = m.semanticRank;
      out.semanticScore = m.semanticScore;
    }
    if (m.tier) out.tier = m.tier;
    if (m.weight) out.weight = m.weight;
    return out;
  };
  const topResults = allMatches.slice(0, max).map(enrichMatch);
  const suggestedScopes = allMatches
    .filter(isSuggestedScopeCandidate)
    .slice(0, 5)
    .map(m => ({ scope: m.id, reason: suggestedScopeReason(m) }));
  const strategy = {
    requested: requestedMatch,
    used: usedMatch,
    tokens,
    perTokenLimit,
    strongTokens,
    // `exportSymbolDampened` is reported on both branches: the flood rule now runs without the
    // embedder, so hiding the flag behind `semantic.used` would reorder a token-only result set
    // and say nothing about it.
    semantic: semantic.length > 0
      ? {
        used: true,
        candidates: semantic.length,
        ...(exportSymbolDampened ? { exportSymbolDampened: true } : {}),
      }
      : {
        used: false,
        ...(exportSymbolDampened ? { exportSymbolDampened: true } : {}),
      },
    ...(Object.keys(postingLists).length > 0
      ? {
        postingLists: {
          truncated: Object.values(postingLists).some(item => item.truncated),
          tokens: postingLists,
        },
      }
      : {}),
    ...(relaxedFrom ? { relaxedFrom } : {}),
    ...(weakTokenOnlySuppressed ? { weakTokenOnlySuppressed } : {}),
  };

  if (nodeTypes?.length) {
    const returned = allMatches.slice(offset, offset + max);
    if (nodeTypes.length === 1 && nodeTypes[0] === 'domain') {
      const byTier: Record<string, ReturnType<typeof enrichMatch>[]> = {};
      for (const m of returned) {
        const tier = m.tier ?? 'technical';
        (byTier[tier] ??= []).push(enrichMatch(m));
      }
      const truncated = offset + returned.length < allMatches.length;
      return {
        query: normalized || rawQuery,
        strategy,
        results: returned.map(enrichMatch),
        topResults,
        suggestedScopes,
        byTier,
        totalResults: allMatches.length,
        returned: returned.length,
        truncated,
        pagination: { total: allMatches.length, returned: returned.length, offset, truncated },
        ...(hasVocabulary ? { vocabulary } : {}),
        ...(lightweightHidden > 0 ? { lightweightHidden } : {}),
        ...(truncated ? {
          hint: `${allMatches.length} domains matched. Showing ${offset + 1}-${offset + returned.length}. Use offset:${offset + returned.length} for the next page or narrow the query.`,
        } : {}),
      };
    }
    const truncated = offset + returned.length < allMatches.length;
    return {
      query: normalized || rawQuery,
      strategy,
      results: returned.map(enrichMatch),
      topResults,
      suggestedScopes,
      totalResults: allMatches.length,
      returned: returned.length,
      truncated,
      pagination: { total: allMatches.length, returned: returned.length, offset, truncated },
      ...(hasVocabulary ? { vocabulary } : {}),
      ...(lightweightHidden > 0 ? { lightweightHidden } : {}),
      ...(truncated ? { hint: `${allMatches.length} matches. Showing ${offset + 1}-${offset + returned.length}. Use offset:${offset + returned.length} for the next page or narrow the query.` } : {}),
    };
  }

  const groups: Record<string, typeof allMatches> = { domains: [], packages: [], modules: [], templates: [], runtimeResources: [], exportSymbols: [] };
  for (const m of allMatches) {
    switch (m.type) {
      case 'domain': groups.domains.push(m); break;
      case 'package': groups.packages.push(m); break;
      case 'module': groups.modules.push(m); break;
      case 'template': groups.templates.push(m); break;
      case 'runtime-resource': groups.runtimeResources.push(m); break;
      case 'export-symbol': groups.exportSymbols.push(m); break;
    }
  }

  const maxPerGroup = Math.max(2, Math.floor(max / 6));
  const grouped: Record<string, unknown[]> = {};
  const groupTotals: Record<string, number> = {};
  const groupPagination: Record<string, { total: number; returned: number; offset: number; truncated: boolean }> = {};
  let totalResults = 0;
  let anyTruncated = false;
  for (const [key, items] of Object.entries(groups)) {
    if (items.length > 0) {
      const page = items.slice(offset, offset + maxPerGroup);
      grouped[key] = page.map(enrichMatch);
      groupTotals[key] = items.length;
      groupPagination[key] = {
        total: items.length,
        returned: page.length,
        offset,
        truncated: offset + page.length < items.length,
      };
      totalResults += items.length;
      if (offset + page.length < items.length) anyTruncated = true;
    }
  }

  return {
    query: normalized || rawQuery,
    strategy,
    results: grouped,
    topResults,
    suggestedScopes,
    groupTotals,
    groupPagination,
    totalResults,
    truncated: anyTruncated,
    ...(hasVocabulary ? { vocabulary } : {}),
    ...(lightweightHidden > 0 ? { lightweightHidden } : {}),
    ...(anyTruncated ? {
      hint: 'Use types to page a single category (for example types:["export-symbol"] with offset), or narrow your query.',
    } : {}),
  };
}
