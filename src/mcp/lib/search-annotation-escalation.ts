export const SEARCH_ANNOTATION_ESCALATION_GAP =
  'One or more top matches carry annotations; search_context does not include annotation fields — call inspect_node on the match before source-only reasoning or treating the node as understood.';

export const SEARCH_ANNOTATION_ESCALATION_NAV_REASON =
  'Inspect this match — annotations (risks, integrationPoints) are not included in search_context.';

type SearchHit = { annotationMatched?: unknown };

function searchHits(matches: Record<string, unknown>, topN: number): SearchHit[] {
  const topResults = matches.topResults;
  if (Array.isArray(topResults)) return topResults.slice(0, topN) as SearchHit[];

  const results = matches.results;
  if (Array.isArray(results)) return results.slice(0, topN) as SearchHit[];

  if (results && typeof results === 'object') {
    return Object.values(results as Record<string, unknown>)
      .flatMap(items => Array.isArray(items) ? items as SearchHit[] : [])
      .slice(0, topN);
  }

  return [];
}

function isAnnotationMatched(hit: SearchHit | undefined): boolean {
  return hit?.annotationMatched === true;
}

export function topResultsHaveAnnotationMatch(matches: Record<string, unknown>, topN = 3): boolean {
  return searchHits(matches, topN).some(isAnnotationMatched);
}

export function searchAnnotationEscalation(matches: Record<string, unknown>): {
  shouldEscalate: boolean;
  top1Annotated: boolean;
} {
  const hits = searchHits(matches, 3);
  return {
    shouldEscalate: hits.some(isAnnotationMatched),
    top1Annotated: isAnnotationMatched(hits[0]),
  };
}
