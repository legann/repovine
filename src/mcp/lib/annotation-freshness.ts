import { provenance, type Provenance } from '../../response/provenance.js';

/**
 * How `annotationMeta.fresh` was decided, or why it is absent.
 *
 * `fresh` is left unset wherever no hash comparison ran — a node type the writer cannot hash stores
 * `contentHash: 'unknown'`, and reporting `fresh: false` there would state a verification that never
 * happened. Both projections that publish `annotationMeta` label it from here, so a node cannot be
 * `not-comparable` in one tool and hash-compared in another.
 */
export function annotationFreshnessProvenance(fresh: boolean | undefined): Provenance {
  return provenance(fresh === undefined ? 'not-comparable' : 'content-hash');
}

/** `fresh` for a node whose hash resolver may have nothing to compare against. */
export function freshAgainstHash(storedHash: string | undefined, currentHash: string | undefined): boolean | undefined {
  if (storedHash === undefined || storedHash === 'unknown' || currentHash === undefined) return undefined;
  return storedHash === currentHash;
}
