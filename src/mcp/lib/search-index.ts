/**
 * Token search index over the repository graph PLUS annotation text.
 *
 * Annotations are the natural-language bridge between fuzzy query wording and
 * repository terminology: summaries, keyExports descriptions, and risks are
 * written in the words a human uses to ask questions. Indexing them makes
 * `search_context` improve as annotation coverage grows.
 */

import { compareCodeUnits } from '../../platform/ordering.js';
import type { RepositoryGraph, StoredAnnotation } from '../../types.js';

export interface SearchIndex {
  /** Inverted index: token (lowercase) -> Set<nodeId>. */
  tokens: Map<string, Set<string>>;
  /** nodeId -> lowercased annotation-derived text, for query-time scoring of annotation matches. */
  annotationText: Map<string, string>;
}

/** Tokens too generic to anchor a search on their own; matched at reduced weight. */
export const WEAK_SEARCH_TOKENS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'do', 'for', 'from', 'how', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'via', 'we', 'with',
  'app', 'component', 'file', 'function', 'handle', 'handler', 'lambda', 'module', 'package', 'page', 'route', 'routes', 'routing',
  'service', 'tool', 'tools', 'user', 'what', 'when', 'where', 'why',
]);

/** English filler filtered out when indexing annotation prose (kept for ids/labels, which never contain it). */
const ANNOTATION_STOPWORDS = new Set([
  'about', 'after', 'all', 'also', 'and', 'are', 'been', 'before', 'being', 'between', 'both', 'but', 'can', 'does', 'each',
  'for', 'from', 'the', 'with',
  'has', 'have', 'into', 'its', 'must', 'not', 'only', 'other', 'over', 'per', 'same', 'should', 'some', 'such',
  'than', 'that', 'their', 'them', 'then', 'these', 'they', 'this', 'through', 'under', 'use', 'used', 'uses', 'using',
  'via', 'was', 'when', 'where', 'which', 'while', 'will', 'within', 'without',
]);

export function searchTokenize(s: string): string[] {
  const splitCamel = (value: string): string =>
    value
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const splitPlain = (value: string): string[] =>
    value.toLowerCase().replace(/[/\-_.:]/g, ' ').split(/\s+/).filter(Boolean);
  return [...new Set([...splitPlain(s), ...splitPlain(splitCamel(s))])];
}

/** All string leaves of the annotation content, joined and lowercased. Generic walk so new fields index automatically. */
export function annotationSearchText(stored: StoredAnnotation): string {
  const parts: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        parts.push(key);
        visit(nested);
      }
    }
  };
  visit(stored.annotation);
  return parts.join(' ').toLowerCase();
}

function indexableAnnotationTokens(text: string): string[] {
  return searchTokenize(text).filter(token =>
    token.length >= 3
    && !ANNOTATION_STOPWORDS.has(token)
    && !/^\d+$/.test(token),
  );
}

function boundedLevenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Repository-vocabulary suggestions for a query token with zero index hits.
 * The agent is its own query rewriter — it only needs to know which words THIS
 * repository speaks. Ranked: prefix > substring > small edit distance, then by
 * document frequency.
 */
export function suggestVocabulary(missingToken: string, index: SearchIndex, limit = 5): string[] {
  const token = missingToken.toLowerCase();
  if (token.length < 3) return [];
  const maxDistance = token.length >= 7 ? 2 : 1;
  const scored: Array<{ candidate: string; quality: number; docFreq: number }> = [];
  for (const [candidate, nodeIds] of index.tokens) {
    if (candidate.length < 3 || candidate === token) continue;
    let quality = 0;
    if (candidate.startsWith(token) || token.startsWith(candidate)) quality = 3;
    else if (candidate.includes(token) || token.includes(candidate)) quality = 2;
    else if (boundedLevenshtein(token, candidate, maxDistance) <= maxDistance) quality = 1;
    if (quality === 0) continue;
    scored.push({ candidate, quality, docFreq: nodeIds.size });
  }
  scored.sort((a, b) =>
    b.quality - a.quality
    || b.docFreq - a.docFreq
    || compareCodeUnits(a.candidate, b.candidate),
  );
  return scored.slice(0, limit).map(item => item.candidate);
}

export function buildTokenIndex(
  graph: RepositoryGraph,
  annotations: Record<string, StoredAnnotation>,
): SearchIndex {
  const tokens = new Map<string, Set<string>>();
  const annotationText = new Map<string, string>();
  const add = (token: string, nodeId: string) => {
    if (!token) return;
    let set = tokens.get(token);
    if (!set) { set = new Set(); tokens.set(token, set); }
    set.add(nodeId);
  };

  for (const node of graph.nodes.values()) {
    for (const t of searchTokenize(node.id)) add(t, node.id);
    for (const t of searchTokenize(node.label)) add(t, node.id);
    if (node.type === 'export-symbol' && node.data) {
      if (node.data.signature) for (const t of searchTokenize(node.data.signature)) add(t, node.id);
      if (node.data.typeValue) for (const t of searchTokenize(node.data.typeValue)) add(t, node.id);
      for (const iface of node.data.implementsInterfaces ?? []) {
        for (const t of searchTokenize(iface)) add(t, node.id);
      }
    }
  }

  for (const [nodeId, stored] of Object.entries(annotations)) {
    if (!graph.nodes.has(nodeId)) continue;
    const text = annotationSearchText(stored);
    if (!text) continue;
    annotationText.set(nodeId, text);
    for (const t of indexableAnnotationTokens(text)) add(t, nodeId);
  }

  return { tokens, annotationText };
}
