/**
 * What a graph node id looks like as a string.
 *
 * Pure string knowledge about ids — no graph, no config, no runtime. Both the vocabulary of id
 * prefixes and the transforms between id kinds live here so a second reader cannot answer "is this
 * a node id" with a different list. Resolution against a real graph is `resolveScope`
 * (`src/mcp/scope/resolve.ts`); this module only reads the shape of the string.
 */

/**
 * The prefix every graph node id starts with, declared once.
 *
 * A caller-facing scope argument may also carry `query:`, which names a search rather than a node —
 * {@link SCOPE_PREFIXES} is the wider list for arguments, this one is what can name a node.
 */
export const NODE_ID_PREFIXES = ['mod', 'export', 'pkg', 'domain', 'resource', 'infra', 'template'] as const;

export type NodeIdPrefix = (typeof NODE_ID_PREFIXES)[number];

/** Node id prefixes plus `query:`, which reaches the resolver as a scope argument and names no node. */
export const SCOPE_PREFIXES = [...NODE_ID_PREFIXES, 'query'] as const;

export type ScopePrefix = (typeof SCOPE_PREFIXES)[number];

/** True when the string carries a node id prefix. Says nothing about the node existing. */
export function hasNodeIdPrefix(value: string): boolean {
  return NODE_ID_PREFIXES.some(prefix => value.startsWith(`${prefix}:`));
}

/** True when the string carries a node id prefix or `query:`. */
export function hasScopePrefix(value: string): boolean {
  return SCOPE_PREFIXES.some(prefix => value.startsWith(`${prefix}:`));
}

/**
 * Map an export-symbol node id to its owning module id (pure string transform).
 *
 * Export-symbol ids are built in stage2 as `export:${moduleId.slice(4)}/${exportName}`, so the owning
 * module is `mod:` + everything in the export id before its final path segment. Used by annotation
 * provenance: an `export:` anchor inspected in a session grounds its owning module (but a coarser
 * `pkg:`/`domain:` anchor deliberately does not). Returns `undefined` for non-`export:` ids or ids
 * with no separable export segment.
 */
export function owningModuleId(exportSymbolId: string): string | undefined {
  if (!exportSymbolId.startsWith('export:')) return undefined;
  const rest = exportSymbolId.slice('export:'.length);
  const lastSlash = rest.lastIndexOf('/');
  if (lastSlash <= 0) return undefined;
  return `mod:${rest.slice(0, lastSlash)}`;
}
