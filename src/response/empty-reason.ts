/**
 * Why an answer came back with nothing in it.
 *
 * A leaf on purpose: the vocabulary is matched by name in two subsystems that must not import each
 * other -- the diagnostics that produce it (`mcp/response/empty-diagnostics.ts`) and the session
 * score that counts it off an already-published response (`context-quality/metrics.ts`). Declaring
 * it here is what lets the second one hold a reference instead of retyping a string literal.
 *
 * Emptiness is not a refusal. It says the request was answered and the answer is nothing; a refusal
 * (`./refusal.js`) says the engine would not answer at all.
 */
export const EMPTY_DIAGNOSTIC_REASONS = [
  'graph_empty',
  'semantic_domain_not_runtime_boundary',
  'library_module_no_entrypoint',
  'package_has_no_entrypoints',
  'filtered_out',
  'query_no_entrypoints',
  'scope_unresolved',
  'no_entrypoints_indexed',
  'semantic_scope_has_no_runtime_topology',
  'no_producer_resource_consumer_edges',
  'no_token_hits',
  'strict_and_no_single_node',
  'scope_has_no_config_surface',
  'scope_has_no_map_context',
  'package_has_no_modules',
  'offset_out_of_range',
  'dependency_mode_scope_mismatch',
  'no_cross_package_edges',
  'no_dependency_edges',
  'no_interface_implementations',
  'no_callgraph_edges',
  'no_architecture_findings',
  'scope_kind_not_analyzable',
  'finding_not_found',
] as const;

export type EmptyDiagnosticReason = typeof EMPTY_DIAGNOSTIC_REASONS[number];

/**
 * The one member another subsystem matches on by name. Context Session Quality counts a session's
 * unresolved scopes off the published response, where the union does not survive as a type, so the
 * member is named once and imported rather than retyped as a literal at both ends.
 */
export const SCOPE_UNRESOLVED = 'scope_unresolved' satisfies EmptyDiagnosticReason;
