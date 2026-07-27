/**
 * The one shape "how do we know this" is reported in.
 *
 * Layer-neutral by construction, for the same reason as {@link ./truncation.js}: the node-view
 * projection and the MCP response layer both qualify facts they hand over.
 */
import { z } from 'zod';

/**
 * What produced the fact standing next to this block.
 *
 * The grade a reader acts on. `declared` and `computed` are load-bearing; `inferred` is a candidate
 * to check before trusting; `absent` says the fact was not established at all, which is what the
 * neighbouring value being `unknown` or missing means.
 */
export type ProvenanceBasis = 'declared' | 'computed' | 'inferred' | 'absent';

/**
 * Which mechanism produced it.
 *
 * Closed on purpose. An open string here would rebuild the per-site vocabularies this replaces, one
 * spelling at a time.
 */
export type ProvenanceMethod =
  | 'iam-policy'
  | 'not-declared'
  | 'content-hash'
  | 'import-baseline'
  | 'not-comparable'
  | 'call-name-index';

/**
 * Basis per method, declared once.
 *
 * The two travel together in every response, so deriving one from the other is what keeps them from
 * disagreeing — a site cannot claim a hash comparison and grade it as a guess.
 */
const BASIS_BY_METHOD: Record<ProvenanceMethod, ProvenanceBasis> = {
  'iam-policy': 'declared',
  'not-declared': 'absent',
  'content-hash': 'computed',
  'import-baseline': 'computed',
  'not-comparable': 'absent',
  'call-name-index': 'inferred',
};

/** How a neighbouring fact was established. */
export interface Provenance {
  basis: ProvenanceBasis;
  method: ProvenanceMethod;
}

export const ProvenanceSchema = z.strictObject({
  basis: z.enum(['declared', 'computed', 'inferred', 'absent']),
  method: z.enum([
    'iam-policy',
    'not-declared',
    'content-hash',
    'import-baseline',
    'not-comparable',
    'call-name-index',
  ]),
});

export function provenance(method: ProvenanceMethod): Provenance {
  return { basis: BASIS_BY_METHOD[method], method };
}

/** The methods this vocabulary knows, for the law that holds the basis table total. */
export const PROVENANCE_METHODS = Object.keys(BASIS_BY_METHOD) as ProvenanceMethod[];
