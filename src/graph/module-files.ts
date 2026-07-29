import type { RepositoryGraph } from '../types.js';
// Side-effect import: the built-in source plugins must be registered before this module asks the
import { getSourceIndexBasenames, stripIndexBasename, stripModuleIdSuffix } from '../plugins/source-set.js';
import { lastPathSegment } from '../platform/paths.js';

/**
 * What file a module node stands for, asked of the graph rather than of the node's label.
 *
 * A label is a display form: it keeps two path segments behind `…/` and is minted to be read, not
 * parsed. Analyses that used to ask a label "does this path end in `/index`" answered differently
 * for two repositories whose only difference was whether the barrel was written `index.ts` or
 * `index.mjs`, and answered `false` for every Python barrel, because `__init__.py` is not spelled
 * `index`. The questions below read `relativeFilePath` and the registry instead, so the answer
 * depends on the repository rather than on how the display string came out.
 */

/** The module's package-relative file path, or `undefined` for a node that stands for no file. */
export function moduleRelPath(graph: RepositoryGraph, moduleId: string): string | undefined {
  const node = graph.nodes.get(moduleId);
  if (node?.type !== 'module') return undefined;
  return node.data?.relativeFilePath;
}

/** The directory the module's file sits in, package-relative. `''` for a file at the package root. */
export function moduleDirPath(graph: RepositoryGraph, moduleId: string): string | undefined {
  const rel = moduleRelPath(graph, moduleId);
  if (rel === undefined) return undefined;
  const slash = rel.lastIndexOf('/');
  return slash < 0 ? '' : rel.slice(0, slash);
}

/**
 * True when the module's file is the entry file of its directory — `index.ts`, `index.mjs`,
 * `__init__.py`, or whatever else a registered plugin declared as an index basename.
 */
export function isBarrelModule(graph: RepositoryGraph, moduleId: string): boolean {
  const rel = moduleRelPath(graph, moduleId);
  if (rel === undefined) return false;
  return isBarrelRelPath(rel);
}

/** {@link isBarrelModule} for a path already in hand. */
export function isBarrelRelPath(relPath: string): boolean {
  // Case-sensitive, matching the mint: `mintModuleId` collapses `index` and leaves `Index` alone,
  // so a case-folding answer here would call a module a barrel that has its own id.
  const basename = lastPathSegment(stripModuleIdSuffix(relPath));
  return getSourceIndexBasenames().some(name => basename === name);
}

/**
 * The node the caller's string names, with the two mechanical spellings of a module id forgiven: a
 * source extension and a trailing index basename, neither of which the mint keeps.
 *
 * One implementation because a string accepted here and refused elsewhere is the same defect from
 * two directions — `mod:pkg/src/worker.mjs` used to resolve for the agent-protocol validator and
 * not for the MCP scope resolver, in the same repository.
 */
export function resolveNodeIdByShape(graph: RepositoryGraph, rawId: string): string | undefined {
  if (graph.nodes.has(rawId)) return rawId;
  const normalized = stripIndexBasename(stripModuleIdSuffix(rawId));
  return graph.nodes.has(normalized) ? normalized : undefined;
}
