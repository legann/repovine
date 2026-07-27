/**
 * Scope resolution: map a resolved scope into the concrete sets of node ids the detectors inspect.
 *
 * The argument arrives already resolved (`ResolvedScope`), so nothing here re-reads a caller's
 * string. Every scope kind is answered: the ones that name a set a detector iterates get that set,
 * the rest are refused by name. An unanswered kind used to come back as three empty sets, which the
 * report then published as "no findings".
 */

import type { RepositoryGraph } from '../../types.js';
import type { ResolvedScope, ScopeKind } from '../../scope/resolved.js';
import type { RefactoringScope } from './types.js';

export function modulePackageId(graph: RepositoryGraph, modId: string): string | undefined {
  const pkgEdge = (graph.inEdges.get(modId) ?? []).find(e => e.kind === 'contains' && e.from.startsWith('pkg:'));
  return pkgEdge?.from;
}

/**
 * The scope kinds architecture analysis can inspect.
 *
 * A kind belongs here when it names a set the detectors iterate: modules, runtime resources, or
 * domains. `export-symbol` sits below the granularity every detector works at, and `template`,
 * `infra` and `query` name nothing a detector reads — analysing them would mean answering about a
 * neighbouring node instead of the one that was asked about.
 */
export const ARCHITECTURE_SCOPE_KINDS: readonly ScopeKind[] = ['all', 'package', 'domain', 'module', 'runtime-resource'];

export function architectureCanScope(kind: ScopeKind): boolean {
  return ARCHITECTURE_SCOPE_KINDS.includes(kind);
}

/**
 * Scopes holding a single graph node.
 *
 * Detectors read the in-scope set: a per-node signal (responsibility surface, unresolved handler,
 * secret handling) is fully answerable, while anything that compares members of the set has nothing
 * to compare. The report says so rather than letting an empty finding list stand for a clean node.
 */
export function isSingleNodeScope(kind: ScopeKind): boolean {
  return kind === 'module' || kind === 'runtime-resource';
}

export function scopedGraphIds(
  graph: RepositoryGraph,
  modulesById: Map<string, unknown>,
  scope: ResolvedScope,
): RefactoringScope {
  if (typeof scope !== 'object' || scope === null || typeof (scope as ResolvedScope).kind !== 'string') {
    throw new Error(
      'scopedGraphIds expects a ResolvedScope, not a raw scope string. Resolve the caller\'s argument '
      + 'with resolveScope first — re-parsing it here answered for three of the ten scope kinds and '
      + 'returned empty sets for the rest, which the report published as "no findings".',
    );
  }

  const allDomainIds = new Set([...(graph.byType.get('domain') ?? [])]);

  if (scope.kind === 'all') {
    return {
      moduleIds: new Set([...modulesById.keys()].filter(id => graph.nodes.get(id)?.type === 'module')),
      serviceIds: new Set([...(graph.byType.get('runtime-resource') ?? [])]),
      domainIds: allDomainIds,
      scope: 'all',
      kind: 'all',
    };
  }

  if (scope.kind === 'package' && scope.packageId) {
    const pkgId = scope.packageId;
    const moduleIds = new Set<string>();
    for (const edge of graph.outEdges.get(pkgId) ?? []) {
      if (edge.kind === 'contains' && graph.nodes.get(edge.to)?.type === 'module') moduleIds.add(edge.to);
    }
    const serviceIds = new Set<string>();
    for (const svcId of graph.byType.get('runtime-resource') ?? []) {
      const infraTargets = (graph.outEdges.get(svcId) ?? []).filter(e => e.kind === 'infra').map(e => e.to);
      if (infraTargets.some(modId => modulePackageId(graph, modId) === pkgId)) serviceIds.add(svcId);
    }
    return { moduleIds, serviceIds, domainIds: allDomainIds, scope: pkgId, kind: 'package', packageId: pkgId };
  }

  if (scope.kind === 'domain' && scope.domainId) {
    const domainId = scope.domainId;
    const moduleIds = new Set<string>();
    const serviceIds = new Set<string>();
    for (const edge of graph.inEdges.get(domainId) ?? []) {
      if (edge.kind !== 'tagged') continue;
      const node = graph.nodes.get(edge.from);
      if (node?.type === 'module') moduleIds.add(edge.from);
      if (node?.type === 'runtime-resource') serviceIds.add(edge.from);
    }
    return { moduleIds, serviceIds, domainIds: new Set([domainId]), scope: domainId, kind: 'domain' };
  }

  // A single node is its own set. Domains stay out of it: a module scope names a module, and running
  // the domain-shape detectors over every domain filtered to one member would report on a domain the
  // caller did not ask about.
  if (scope.kind === 'module' && scope.nodeId) {
    return {
      moduleIds: new Set([scope.nodeId]),
      serviceIds: new Set(),
      domainIds: new Set(),
      scope: scope.nodeId,
      kind: 'module',
    };
  }

  if (scope.kind === 'runtime-resource' && scope.nodeId) {
    return {
      moduleIds: new Set(),
      serviceIds: new Set([scope.nodeId]),
      domainIds: new Set(),
      scope: scope.nodeId,
      kind: 'runtime-resource',
    };
  }

  return {
    moduleIds: new Set(),
    serviceIds: new Set(),
    domainIds: new Set(),
    scope: scope.resolvedScope,
    kind: 'unsupported',
    unsupportedKind: scope.kind,
  };
}
