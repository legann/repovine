/**
 * Budgets on the semantic facts a producer publishes.
 *
 * A budget is a contract term, not a producer's private choice: the producer slices its output to
 * the budget and the host states the same number when it reports what the answer may be missing.
 * Written twice, the sentence and the slice drift, and the host's completeness claim stops matching
 * the index it is describing.
 */

/**
 * Distinct call names kept per bucket in the module call index — one bucket per exported
 * declaration, plus the module bucket. `ModuleInfo.callsTotal` carries the size before the slice, so
 * a reader can tell a capped bucket from a complete one.
 */
export const CALL_INDEX_PER_DECLARATION_CAP = 50;
