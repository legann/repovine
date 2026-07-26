/**
 * Shipped semantic-search relevance policy.
 *
 * Keep the defaults in one module so search_context, scope recovery, tests, and
 * offline calibration all evaluate the same policy.
 */
/**
 * Calibrated on the 25-query outcome-independent Archestra relevance corpus.
 * Keep the corpus caveat visible: these are in-sample defaults, not universal
 * probability thresholds. Semantic-only hits remain low-confidence advisory.
 */
export const SEMANTIC_MIN_COSINE = 0.3;
export const SEMANTIC_RRF_WEIGHT = 15;
export const SEMANTIC_RRF_K = 1;
export const SEMANTIC_COSINE_WEIGHT = 0;

export interface SemanticFusionPolicy {
  minCosine: number;
  rrfWeight: number;
  rrfK: number;
  cosineWeight: number;
}

export const DEFAULT_SEMANTIC_FUSION_POLICY: Readonly<SemanticFusionPolicy> = Object.freeze({
  minCosine: SEMANTIC_MIN_COSINE,
  rrfWeight: SEMANTIC_RRF_WEIGHT,
  rrfK: SEMANTIC_RRF_K,
  cosineWeight: SEMANTIC_COSINE_WEIGHT,
});

export function semanticRankBoost(rank: number, policy: SemanticFusionPolicy = DEFAULT_SEMANTIC_FUSION_POLICY): number {
  return policy.rrfWeight / (policy.rrfK + rank);
}
