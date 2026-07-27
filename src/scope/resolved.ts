/**
 * What a caller's scope argument turned out to be.
 *
 * Layer-neutral by construction: the request parser lives in the MCP layer, but the analyses it
 * feeds — architecture detectors under `src/analysis`, runtime topology under `src/mcp/lib` —
 * consume the answer, and one of them sits outside `src/mcp` entirely. The type lives here so a
 * consumer takes the resolved scope instead of re-parsing the string the resolver already read.
 *
 * The resolver itself is `resolveScope` in `src/mcp/scope/resolve.ts`: it needs the MCP runtime
 * (graph, module index, domains config, repo root), which this module deliberately does not.
 */

/**
 * Every kind a scope argument can resolve to.
 *
 * A runtime list, not just a union: a consumer that answers per kind is held to answering for all
 * of them, and a kind added here shows up as an unanswered case instead of a silent empty result.
 */
export const SCOPE_KINDS = [
  'all',
  'domain',
  'package',
  'module',
  'export-symbol',
  'runtime-resource',
  'template',
  'infra',
  'query',
  'unknown',
] as const;

export type ScopeKind = (typeof SCOPE_KINDS)[number];

export interface ResolvedScope {
  /** The argument as the caller wrote it, trimmed; `all` when absent. */
  raw: string;
  /** The id or scope expression the argument resolved to; echoed back to the caller. */
  resolvedScope: string;
  kind: ScopeKind;
  /** Set when the scope names one graph node. */
  nodeId?: string;
  domainId?: string;
  packageId?: string;
  /** Set for `kind: 'query'` and for unresolved arguments, carrying the text to search for. */
  query?: string;
}

/** The whole repository — what an absent scope argument resolves to. */
export const ALL_SCOPE: ResolvedScope = { raw: 'all', resolvedScope: 'all', kind: 'all' };
