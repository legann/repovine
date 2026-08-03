/**
 * Whether a stored annotation still describes its node — decided once, for every node kind.
 *
 * Freshness has three inputs: the hash the annotation was written against, the node's current hash
 * ({@link ./content-hash.js}), and whether the node's imports drifted since the write. The verdict
 * names which of them decided it, so a tool that ranks work and a tool that describes a node report
 * the same node the same way and differ only in what they do with the reason.
 */
import type { StoredAnnotation } from '../types.js';
import { CURRENT_ANNOTATION_SCHEMA_VERSION } from '../types.js';
import { provenance, type Provenance } from '../response/provenance.js';

/** Every state a freshness question can end in. Enumerated so a consumer can be held to all of them. */
export const FRESHNESS_STATES = ['fresh', 'stale', 'not-comparable', 'unannotated'] as const;

export type FreshnessState = typeof FRESHNESS_STATES[number];

/**
 * Why an annotation is stale.
 *
 * `content` — the node's own text changed. `schema` — the annotation predates the current
 * annotation schema and lacks fields the current one carries. `propagation` — the node is
 * unchanged but a module it imports moved, so claims about upstream contracts are unconfirmed.
 * `no-baseline` — the note was written when the node carried no hash, so nothing ties it to the
 * content it describes even though that content is hashable now.
 */
export const STALE_REASONS = ['content', 'schema', 'propagation', 'no-baseline'] as const;

export type StaleReason = typeof STALE_REASONS[number];

export type FreshnessVerdict =
  | { state: 'fresh' }
  | { state: 'stale'; reason: StaleReason }
  | { state: 'not-comparable' }
  | { state: 'unannotated' };

/** A verdict about a node that has an annotation — every state except `unannotated`. */
export type AnnotatedFreshnessVerdict = Exclude<FreshnessVerdict, { state: 'unannotated' }>;

/**
 * The freshness verdict for a node, or `undefined` when it has no annotation.
 *
 * Passed to a projection rather than recomputed inside it: propagation needs graph-wide inputs a
 * projection does not carry, and a site that decided freshness on its own would answer about a node
 * differently than the tool the reader called last.
 */
export type NodeFreshnessLookup = (nodeId: string) => AnnotatedFreshnessVerdict | undefined;

export interface FreshnessInput {
  /** The stored annotation, or `undefined` when the node has none. */
  annotation: StoredAnnotation | undefined;
  /** The node's current content hash, or `undefined` when its kind carries no hash. */
  currentHash: string | undefined;
  /**
   * Whether the node's stored import baseline drifted (entrypoint-bounded propagation).
   * `undefined` when propagation was not evaluated — it then cannot decide the verdict.
   */
  propagationStale?: boolean;
}

/**
 * The freshness verdict for one node.
 *
 * Content and schema are checked before propagation because a node whose own text changed needs a
 * rewrite regardless of what its upstreams did; propagation review only makes sense for an
 * annotation that still matches the node it describes.
 */
export function annotationFreshness(
  input: FreshnessInput & { annotation: StoredAnnotation },
): AnnotatedFreshnessVerdict;
export function annotationFreshness(input: FreshnessInput): FreshnessVerdict;
export function annotationFreshness(input: FreshnessInput): FreshnessVerdict {
  const ann = input.annotation;
  if (!ann) return { state: 'unannotated' };
  // A node kind with no hash source cannot be compared at all; `write_annotation` stored
  // `contentHash: 'unknown'` there, and calling that stale would report a check that never ran.
  if (input.currentHash === undefined) return { state: 'not-comparable' };
  // The node does hash, but the annotation was written without one. The note needs the same
  // rewrite a content change needs, and no hash comparison stands behind that.
  if (ann.contentHash === 'unknown') return { state: 'stale', reason: 'no-baseline' };
  if (ann.contentHash !== input.currentHash) return { state: 'stale', reason: 'content' };
  if ((ann.schemaVersion ?? 1) < CURRENT_ANNOTATION_SCHEMA_VERSION) return { state: 'stale', reason: 'schema' };
  if (input.propagationStale) return { state: 'stale', reason: 'propagation' };
  return { state: 'fresh' };
}

/** True only for a verdict of `fresh`. Every other state means the annotation is not confirmed. */
export function isFreshVerdict(verdict: FreshnessVerdict): boolean {
  return verdict.state === 'fresh';
}

/**
 * True when the node's own content no longer matches what the annotation was written against.
 *
 * Narrower than "not fresh": a schema-stale or propagation-stale note still describes the text it
 * was written for, which is the difference a caller asking about the node's own drift needs.
 */
export function contentMoved(verdict: FreshnessVerdict): boolean {
  return verdict.state === 'stale' && (verdict.reason === 'content' || verdict.reason === 'no-baseline');
}

/**
 * How the verdict was reached.
 *
 * Propagation is decided from stored import baselines rather than the node's own hash, so it
 * carries its own method — a reader can tell which comparison produced `fresh: false`.
 */
export function annotationFreshnessProvenance(verdict: AnnotatedFreshnessVerdict): Provenance {
  if (verdict.state === 'not-comparable') return provenance('not-comparable');
  if (verdict.state === 'stale') {
    if (verdict.reason === 'propagation') return provenance('import-baseline');
    // Nothing was compared: the stored side of the comparison is the `unknown` sentinel.
    if (verdict.reason === 'no-baseline') return provenance('not-comparable');
  }
  return provenance('content-hash');
}

/** How a verdict is published next to an annotation in a tool response. */
export interface AnnotationFreshnessMeta {
  /** Omitted when no comparison was possible; `false` always names its `staleReason`. */
  fresh?: boolean;
  staleReason?: StaleReason;
  provenance: Provenance;
}

/**
 * The response fields for a verdict.
 *
 * `fresh` answers about the annotation as a whole, so an unconfirmed upstream makes it `false`;
 * `staleReason` says which check decided that, which is what separates "rewrite this note" from
 * "re-confirm its upstream claims".
 */
export function annotationFreshnessMeta(verdict: AnnotatedFreshnessVerdict): AnnotationFreshnessMeta {
  const prov = annotationFreshnessProvenance(verdict);
  if (verdict.state === 'not-comparable') return { provenance: prov };
  if (verdict.state === 'stale') return { fresh: false, staleReason: verdict.reason, provenance: prov };
  return { fresh: true, provenance: prov };
}
