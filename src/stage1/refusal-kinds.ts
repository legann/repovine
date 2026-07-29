/**
 * What the build refuses, named once.
 *
 * `Refusal.kind` is how a reader picks one refusal out of the sink. The names live in their own
 * module because the producer is in stage 1 and the readers are in the MCP and CLI layers, and a
 * reader that retyped the string would go quietly blind the day the producer renamed it.
 */

/** A candidate that resolves outside the workspace root. Carries `{ count, sample }`. */
export const OUTSIDE_WORKSPACE_REFUSAL = 'outside-workspace';

/** Two source plugins claimed one file; the first is indexed. Carries `{ count, sample }`. */
export const FILE_CLAIMED_TWICE_REFUSAL = 'file-claimed-twice';

/** A source plugin's prerequisite is absent, so the files it reads are not indexed. */
export const SOURCE_PLUGIN_UNAVAILABLE_REFUSAL = 'source-plugin-unavailable';

/** A plugin named in repovine.config.json could not be loaded. */
export const PLUGIN_UNLOADABLE_REFUSAL = 'plugin-unloadable';

/** Composition did not take every record the scan produced. */
export const GRAPH_VALIDATION_REFUSAL = 'graph-validation';

/** A projector threw, returned the wrong shape, or blew its batch budget. Carries the owner. */
export const PROJECTION_CONTRIBUTOR_FAILED_REFUSAL = 'projection-contributor-failed';

/** One projection batch was refused whole; nothing it carried reached the graph. */
export const PROJECTION_BATCH_REJECTED_REFUSAL = 'projection-batch-rejected';

/** Two contributions named one thing and disagreed. Carries both owners and both values. */
export const PROJECTION_CONFLICT_REFUSAL = 'projection-conflict';

/** Two plugins declared one catalog key with different effects; neither declaration is in force. */
export const DECLARATION_CONFLICT_REFUSAL = 'declaration-conflict';

/** Two composite declaration keys narrow onto one lookup component, so the lookup answers nothing. */
export const DECLARATION_AMBIGUOUS_REFUSAL = 'declaration-ambiguous';
