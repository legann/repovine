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
 * The node id of a domain, from its label.
 *
 * Mints unconditionally: a label is a label, even one that reads like an id. A caller holding a
 * string that may already be an id composes the pair — `domainNodeId(domainLabelFromId(value))` —
 * which is total and says which of the two it meant. Folding that coercion in here would silently
 * merge a domain whose configured name starts with `domain:` into the domain it names.
 */
export function domainNodeId(label: string): string {
  return `domain:${label}`;
}

/** The label a domain node id carries. Returns the input unchanged when it carries no prefix. */
export function domainLabelFromId(labelOrId: string): string {
  return labelOrId.startsWith('domain:') ? labelOrId.slice('domain:'.length) : labelOrId;
}

/** True when the string is a domain node id. Says nothing about the node existing. */
export function isDomainNodeId(value: string): boolean {
  return value.startsWith('domain:');
}

/**
 * The `pkg:` mint and its inverse live in the SDK beside the module-id mint, because a source
 * plugin reports an import that resolves to a package as `pkg:<name>` and cannot reach into the
 * engine for the spelling. Re-exported here so engine callers read the whole id vocabulary from
 * one module.
 */
export { packageNameFromId, packageNodeId } from '@repovine/plugin-sdk';

/**
 * The node id of an export symbol, from its owning module id and the exported name.
 *
 * The inverse is {@link owningModuleId}, and the pair is why the recipe is written once: the id is
 * `export:` + the module id's tail + `/` + the name, so un-minting can only be a last-slash cut.
 * A name carrying `/` would break that, and no ecosystem's exported name does.
 */
export function exportSymbolId(moduleId: string, exportName: string): string {
  return `export:${moduleTailFromId(moduleId)}/${exportName}`;
}

/**
 * Attach the `mod:` prefix to a tail that already carries `<package>/<path>`.
 *
 * Distinct from the SDK's `mintModuleId`, which builds the tail from a package name and a file
 * path: this is for a caller that already holds the whole tail — an agent-supplied path resolved
 * against the graph, or an id being rebuilt after its tail was read.
 */
export function moduleNodeId(tail: string): string {
  return `mod:${tail}`;
}

/** The `<package>/<path>` tail a `mod:` id carries. Returns the input unchanged with no prefix. */
export function moduleTailFromId(idOrTail: string): string {
  return idOrTail.startsWith('mod:') ? idOrTail.slice('mod:'.length) : idOrTail;
}

/**
 * The node id of an IaC document. `kind` is the parser's own word for the artifact (`dockerfile`,
 * `terraform`, …) and sits inside the id, so two documents of different kinds at one path stay
 * apart. The node itself carries graph type `module`; only the prefix marks what it is.
 */
export function infraNodeId(kind: string, relPath: string): string {
  return `infra:${kind}:${relPath}`;
}

/** The node id of a server-side template, from its repo-relative path. */
export function templateNodeId(relPath: string): string {
  return `template:${relPath}`;
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
