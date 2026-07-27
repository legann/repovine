import * as path from 'node:path';
import type { PackageNodeData, RepositoryGraph, TemplateNodeData } from '../../types.js';
import { resolveDomainToCanonical } from '../../stage2/domains.js';
import { countNodesOfType, isNodeType, isTaggedInto, modulePackageId, nodesOfType } from '../../graph/index.js';
import { domainLabelFromId, domainNodeId, isDomainNodeId, moduleTailFromId, packageNameFromId, packageNodeId } from '../../graph/node-ids.js';
import type { ResolvedScope } from '../../scope/resolved.js';
import type { McpToolRuntime } from '../types.js';
// Side-effect import ensures built-in source plugins are registered so the loose-name-separator
// relaxation can ask the owning plugin's capability instead of comparing against 'python'.

// Side-effect import: the built-in source plugins must be registered before this module asks the
// registry which extensions it owns, so every ecosystem reduces by its own declaration.
import '../../stage1/source/bootstrap.js';
import { getKnownExtensions, pluginUsesLooseNameSeparators, stripIndexBasename, stripModuleIdSuffix } from '../../stage1/source/registry.js';
import { resolveNodeIdByShape } from '../../graph/module-files.js';
import { toPosixPath } from '../../platform/paths.js';

/**
 * Exact-id lookup with the two mechanical spellings of a module id forgiven: a file extension and a
 * trailing `/index` segment, neither of which stage2 keeps in the id it mints.
 *
 * Private on purpose. It is one rung of {@link resolveScope}'s ladder, and callers that reached for
 * it directly got a different answer for the same argument than the tool's own envelope reported.
 */
function resolveNodeId(graph: RepositoryGraph, rawId: string): string | undefined {
  return resolveNodeIdByShape(graph, rawId);
}

export function normalizeLookupPath(value: string): string {
  // Only the suffixes the ID drops, never the wider "what is this file called" list: `.svelte`
  // stays in the id, so dropping it here would give `+page.svelte` and `+page.ts` one lookup key
  // and hand a caller whichever of the two the map happened to hold. `.yaml`/`.json` are the infra
  // and template spellings, which no source plugin owns and which only this lookup forgives.
  const withoutExtension = stripModuleIdSuffix(
    toPosixPath(value).replace(/^\.\//, ''),
  ).replace(/\.(ya?ml|json)$/i, '');
  return stripIndexBasename(withoutExtension)
    .replace(/\/$/, '')
    .toLowerCase();
}

export function isPathLikeScope(raw: string): boolean {
  if (raw.includes('/') || raw.includes('\\')) return true;
  const lower = raw.toLowerCase();
  return getKnownExtensions().some(ext => lower.endsWith(ext));
}

/**
 * npm scope marker `@` is mechanical for lookup purposes (scope-only workspace names
 * like `@backend`). Safe for every ecosystem: only names that literally start with `@`
 * (an npm-only shape) are affected. Case/paths are handled by normalizeLookupPath.
 */
function stripAtMarker(value: string): string {
  return normalizeLookupPath(value).replace(/^@/, '');
}

/**
 * PEP 503: `-`, `_`, `.` are interchangeable in Python dist names (pyproject
 * `name = "my-package"` vs import dir `my_package`). This relaxation is applied ONLY
 * to packages whose owning plugin declares `looseNameSeparators` — in npm/TS, `foo.bar`
 * and `foo-bar` are distinct identities and must never cross-match.
 */
function pep503Name(value: string): string {
  return stripAtMarker(value).replace(/[-_.]+/g, '-');
}

/** True when the package node's owning source plugin uses loose (PEP-503-style) name separators. */
function nodeUsesLooseNameSeparators(node: { data?: unknown }): boolean {
  return pluginUsesLooseNameSeparators((node.data as PackageNodeData | undefined)?.sourcePluginId);
}

export function resolvePackageId(graph: RepositoryGraph, rawPackage: string): string | undefined {
  if (graph.nodes.has(rawPackage)) return rawPackage;
  const value = packageNameFromId(rawPackage);
  const normalized = normalizeLookupPath(value.replace(/^packages\//, ''));
  const exactPkgId = packageNodeId(value);
  if (graph.nodes.has(exactPkgId)) return exactPkgId;

  const packages = nodesOfType(graph, 'package')
    .map(id => graph.nodes.get(id))
    .filter((node): node is NonNullable<typeof node> => !!node);

  const exact = packages.find(node => {
    const id = normalizeLookupPath(node.id.replace(/^pkg:/, ''));
    const label = normalizeLookupPath(node.label);
    return id === normalized || label === normalized;
  });
  if (exact) return exact.id;

  // Noise-relaxed equality, only when exactly one package matches (two real packages
  // that differ purely by scope marker/separators stay unresolved instead of being
  // silently picked). The `@` relaxation (`pkg:backend` -> `@backend`) applies to every
  // ecosystem; the PEP 503 separator relaxation (`pkg:my_pkg` -> `my-pkg`) is gated to
  // python-discovered candidates so it can never add noise to npm/TS repos.
  const qAt = stripAtMarker(normalized);
  const qPep = pep503Name(normalized);
  const relaxedMatches = packages.filter(node => {
    const id = node.id.replace(/^pkg:/, '');
    if (stripAtMarker(id) === qAt || stripAtMarker(node.label) === qAt) return true;
    return nodeUsesLooseNameSeparators(node)
      && (pep503Name(id) === qPep || pep503Name(node.label) === qPep);
  });
  if (relaxedMatches.length === 1) return relaxedMatches[0].id;

  const suffixMatches = packages.filter(node => {
    const id = normalizeLookupPath(node.id.replace(/^pkg:/, ''));
    const label = normalizeLookupPath(node.label);
    return id.endsWith(`/${normalized}`) || label.endsWith(`/${normalized}`);
  });
  if (suffixMatches.length === 1) return suffixMatches[0].id;

  const relaxedSuffixMatches = packages.filter(node => {
    const id = node.id.replace(/^pkg:/, '');
    if (stripAtMarker(id).endsWith(`/${qAt}`) || stripAtMarker(node.label).endsWith(`/${qAt}`)) return true;
    return nodeUsesLooseNameSeparators(node)
      && (pep503Name(id).endsWith(`/${qPep}`) || pep503Name(node.label).endsWith(`/${qPep}`));
  });
  return relaxedSuffixMatches.length === 1 ? relaxedSuffixMatches[0].id : undefined;
}

/**
 * Forgiving lookup for `resource:` / `infra:` scopes. Graph ids carry an internal
 * provider infix (`resource:aws-lambda:MyFunction`) that callers usually don't know —
 * tool responses surface only the label. Accepts, when exactly ONE node matches:
 * case-only mismatches of the full id, the bare resource name without the provider
 * infix (`resource:MyFunction`), or the node label. Ambiguity stays unresolved.
 */
export function resolveResourceInfraAlias(graph: RepositoryGraph, raw: string): string | undefined {
  const isResource = raw.startsWith('resource:');
  // IaC `infra:` nodes are stored with graph type 'module'; only the id prefix marks them.
  const nodeType = isResource ? 'runtime-resource' : 'module';
  const value = raw.slice(raw.indexOf(':') + 1).trim();
  if (!value) return undefined;
  const rawLower = raw.toLowerCase();
  const needle = value.toLowerCase();

  const matches = nodesOfType(graph, nodeType)
    .map(id => graph.nodes.get(id))
    .filter((node): node is NonNullable<typeof node> => !!node)
    .filter(node => isResource || node.id.startsWith('infra:'))
    .filter(node => {
      const idLower = node.id.toLowerCase();
      return idLower === rawLower
        || idLower.endsWith(`:${needle}`)
        || node.label.toLowerCase() === needle;
    });
  return matches.length === 1 ? matches[0].id : undefined;
}

export function resolveModulePathAlias(ctx: McpToolRuntime, raw: string): string | undefined {
  const { modulesById } = ctx.getState();
  const value = moduleTailFromId(raw);
  if (!isPathLikeScope(value)) return undefined;

  const normalized = normalizeLookupPath(value);
  for (const mod of modulesById.values()) {
    const candidates = [
      mod.filePath,
      mod.relativeFilePath,
      path.relative(ctx.repoRoot, mod.filePath),
    ].filter(Boolean).map(normalizeLookupPath);

    if (candidates.some(candidate => candidate === normalized || candidate.endsWith(`/${normalized}`))) {
      return mod.id;
    }
  }
  return undefined;
}

export function resolveTemplateAlias(graph: RepositoryGraph, raw: string): string | undefined {
  if (graph.nodes.has(raw) && isNodeType(graph, raw, 'template')) return raw;
  const value = raw.startsWith('template:') ? raw.slice('template:'.length) : raw;
  if (!value.trim()) return undefined;
  const normalized = normalizeLookupPath(value);
  const candidates = nodesOfType(graph, 'template')
    .map(id => graph.nodes.get(id))
    .filter((node): node is NonNullable<typeof node> => !!node && node.type === 'template');

  const exact = candidates.find(node => {
    const relPath = normalizeLookupPath((node.data as TemplateNodeData | undefined)?.relPath ?? node.id.replace(/^template:/, ''));
    const id = normalizeLookupPath(node.id.replace(/^template:/, ''));
    const label = normalizeLookupPath(node.label);
    return relPath === normalized || id === normalized || label === normalized;
  });
  if (exact) return exact.id;

  const suffixMatches = candidates.filter(node => {
    const relPath = normalizeLookupPath((node.data as TemplateNodeData | undefined)?.relPath ?? node.id.replace(/^template:/, ''));
    const id = normalizeLookupPath(node.id.replace(/^template:/, ''));
    return relPath.endsWith(`/${normalized}`) || id.endsWith(`/${normalized}`);
  });
  return suffixMatches.length === 1 ? suffixMatches[0].id : undefined;
}

export function resolveScope(ctx: McpToolRuntime, scopeArg?: unknown): ResolvedScope {
  const { graph, domainsConfig } = ctx.getState();
  const raw = typeof scopeArg === 'string' && scopeArg.trim() ? scopeArg.trim() : 'all';
  if (raw === 'all') return { raw, resolvedScope: 'all', kind: 'all' };

  if (raw.startsWith('query:')) {
    const query = raw.slice('query:'.length);
    return { raw, resolvedScope: `query:${query}`, kind: 'query', query };
  }

  if (isDomainNodeId(raw)) {
    const label = resolveDomainToCanonical(raw, domainsConfig);
    const domainId = domainNodeId(label);
    return graph.nodes.has(domainId)
      ? { raw, resolvedScope: domainId, kind: 'domain', nodeId: domainId, domainId }
      : { raw, resolvedScope: domainId, kind: 'unknown', query: domainLabelFromId(raw) };
  }

  if (raw.startsWith('pkg:')) {
    const packageId = resolvePackageId(graph, raw);
    return packageId
      ? { raw, resolvedScope: packageId, kind: 'package', nodeId: packageId, packageId }
      : { raw, resolvedScope: raw, kind: 'unknown', query: raw };
  }

  if (raw.startsWith('mod:') || raw.startsWith('export:')) {
    const nodeId = resolveNodeId(graph, raw);
    if (nodeId) {
      return {
        raw,
        resolvedScope: nodeId,
        kind: nodeId.startsWith('export:') ? 'export-symbol' : 'module',
        nodeId,
      };
    }
    const moduleId = raw.startsWith('mod:') ? resolveModulePathAlias(ctx, raw) : undefined;
    if (moduleId) return { raw, resolvedScope: moduleId, kind: 'module', nodeId: moduleId };
    return { raw, resolvedScope: raw, kind: 'unknown', query: raw };
  }

  if (raw.startsWith('template:')) {
    const templateId = resolveTemplateAlias(graph, raw);
    return templateId
      ? { raw, resolvedScope: templateId, kind: 'template', nodeId: templateId }
      : { raw, resolvedScope: raw, kind: 'unknown', query: raw };
  }

  if (raw.startsWith('resource:') || raw.startsWith('infra:')) {
    const kind = raw.startsWith('resource:') ? 'runtime-resource' : 'infra';
    if (graph.nodes.has(raw)) {
      return { raw, resolvedScope: raw, kind, nodeId: raw };
    }
    const aliasId = resolveResourceInfraAlias(graph, raw);
    if (aliasId) {
      return { raw, resolvedScope: aliasId, kind, nodeId: aliasId };
    }
    return { raw, resolvedScope: raw, kind: 'unknown', query: raw };
  }

  const exactNode = resolveNodeId(graph, raw);
  if (exactNode) {
    const exactType = graph.nodes.get(exactNode)?.type;
    return {
      raw,
      resolvedScope: exactNode,
      kind: exactType === 'export-symbol'
        ? 'export-symbol'
        : exactType === 'module'
          ? 'module'
          : exactType === 'template'
            ? 'template'
            : exactType === 'runtime-resource'
              ? 'runtime-resource'
              : exactType === 'domain'
                ? 'domain'
                : 'unknown',
      nodeId: exactNode,
    };
  }

  const moduleId = resolveModulePathAlias(ctx, raw);
  if (moduleId) return { raw, resolvedScope: moduleId, kind: 'module', nodeId: moduleId };

  const templateId = resolveTemplateAlias(graph, raw);
  if (templateId) return { raw, resolvedScope: templateId, kind: 'template', nodeId: templateId };

  const pkgId = resolvePackageId(graph, raw);
  if (pkgId) return { raw, resolvedScope: pkgId, kind: 'package', nodeId: pkgId, packageId: pkgId };

  const label = resolveDomainToCanonical(raw, domainsConfig);
  const domainId = domainNodeId(label);
  if (graph.nodes.has(domainId)) return { raw, resolvedScope: domainId, kind: 'domain', nodeId: domainId, domainId };

  return { raw, resolvedScope: `query:${raw}`, kind: 'query', query: raw };
}

export function parentModuleId(graph: RepositoryGraph, nodeId: string): string | undefined {
  if (isNodeType(graph, nodeId, 'module')) return nodeId;
  const parentEdge = (graph.inEdges.get(nodeId) ?? []).find(e => e.kind === 'contains' && isNodeType(graph, e.from, 'module'));
  return parentEdge?.from;
}

export function nodeInScope(ctx: McpToolRuntime, nodeId: string, scope: ResolvedScope): boolean {
  const { graph } = ctx.getState();
  if (scope.kind === 'all') return true;
  if (scope.nodeId && nodeId === scope.nodeId) return true;

  const moduleId = parentModuleId(graph, nodeId) ?? nodeId;
  if (scope.kind === 'package' && scope.packageId) {
    return modulePackageId(graph, moduleId) === scope.packageId;
  }
  if (scope.kind === 'domain' && scope.domainId) {
    // The owning module carries the tag for its exports; a runtime resource carries its own.
    return isTaggedInto(graph, moduleId, scope.domainId) || isTaggedInto(graph, nodeId, scope.domainId);
  }
  if (scope.kind === 'module') return moduleId === scope.nodeId;
  if (scope.kind === 'export-symbol') return nodeId === scope.nodeId;
  if (scope.kind === 'runtime-resource') return nodeId === scope.nodeId;
  if (scope.kind === 'template') return nodeId === scope.nodeId;
  if (scope.kind === 'query' && scope.query) {
    const node = graph.nodes.get(nodeId);
    const q = scope.query.toLowerCase();
    return nodeId.toLowerCase().includes(q) || (node?.label.toLowerCase().includes(q) ?? false);
  }
  return false;
}

export function firstResultId(searchResult: Record<string, unknown>): string | undefined {
  const topResults = searchResult.topResults;
  if (Array.isArray(topResults) && topResults.length > 0) {
    return (topResults[0] as { id?: string } | undefined)?.id;
  }
  const results = searchResult.results;
  if (Array.isArray(results)) {
    return (results[0] as { id?: string } | undefined)?.id;
  }
  if (results && typeof results === 'object') {
    const flattened = Object.values(results as Record<string, unknown>)
      .flatMap(items => Array.isArray(items) ? items as Array<{ id?: string; score?: number; type?: string }> : []);
    const typePriority: Record<string, number> = { module: 5, template: 4.5, 'runtime-resource': 4, 'export-symbol': 3, package: 2, domain: 1 };
    flattened.sort((a, b) =>
      (b.score ?? 0) - (a.score ?? 0)
      || (typePriority[b.type ?? ''] ?? 0) - (typePriority[a.type ?? ''] ?? 0),
    );
    for (const items of [flattened]) {
      if (Array.isArray(items) && items.length > 0) {
        return (items[0] as { id?: string }).id;
      }
    }
  }
  return undefined;
}

export function topSearchResultIds(searchResult: Record<string, unknown>, limit = 3): string[] {
  const topResults = searchResult.topResults;
  if (Array.isArray(topResults)) {
    return topResults
      .map(item => (item as { id?: string }).id)
      .filter((id): id is string => typeof id === 'string')
      .slice(0, limit);
  }
  const first = firstResultId(searchResult);
  return first ? [first] : [];
}

export function graphIsEffectivelyEmpty(ctx: McpToolRuntime): boolean {
  const { graph, snapshot } = ctx.getState();
  const indexedNodeCount =
    snapshot.modules.length
    + countNodesOfType(graph, 'module')
    + countNodesOfType(graph, 'export-symbol')
    + countNodesOfType(graph, 'runtime-resource')
    + countNodesOfType(graph, 'template')
    + countNodesOfType(graph, 'domain');
  return indexedNodeCount === 0;
}

export function refactoringScopeArg(scope: ResolvedScope): string {
  if (scope.kind === 'query') return scope.query ?? scope.raw;
  return scope.resolvedScope;
}

export function scopeLabel(scope: ResolvedScope): string {
  return scope.resolvedScope === 'all' ? 'the whole graph' : scope.resolvedScope;
}
