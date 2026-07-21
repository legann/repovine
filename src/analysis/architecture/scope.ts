/**
 * Scope resolution: map a textual scope (all / package / domain) into the
 * concrete sets of node ids the detectors will inspect.
 */

import type { RepositoryGraph } from '../../types.js';
import type { DomainsConfig } from '../../stage2/domains.js';
import { resolveDomainToCanonical } from '../../stage2/domains.js';
import type { RefactoringScope } from './types.js';

export function modulePackageId(graph: RepositoryGraph, modId: string): string | undefined {
  const pkgEdge = (graph.inEdges.get(modId) ?? []).find(e => e.kind === 'contains' && e.from.startsWith('pkg:'));
  return pkgEdge?.from;
}

export function scopedGraphIds(
  graph: RepositoryGraph,
  modulesById: Map<string, unknown>,
  domainsConfig: DomainsConfig | null,
  scope: string,
): RefactoringScope {
  const allModuleIds = new Set([...modulesById.keys()].filter(id => graph.nodes.get(id)?.type === 'module'));
  const allServiceIds = new Set([...(graph.byType.get('runtime-resource') ?? [])]);
  const allDomainIds = new Set([...(graph.byType.get('domain') ?? [])]);
  if (scope === 'all') return { moduleIds: allModuleIds, serviceIds: allServiceIds, domainIds: allDomainIds, scope, kind: 'all' };

  const pkgId = scope.startsWith('pkg:') ? scope : `pkg:${scope}`;
  if (graph.nodes.get(pkgId)?.type === 'package') {
    const moduleIds = new Set<string>();
    for (const edge of graph.outEdges.get(pkgId) ?? []) {
      if (edge.kind === 'contains' && graph.nodes.get(edge.to)?.type === 'module') moduleIds.add(edge.to);
    }
    const serviceIds = new Set<string>();
    for (const svcId of allServiceIds) {
      const infraTargets = (graph.outEdges.get(svcId) ?? []).filter(e => e.kind === 'infra').map(e => e.to);
      if (infraTargets.some(modId => modulePackageId(graph, modId) === pkgId)) serviceIds.add(svcId);
    }
    return { moduleIds, serviceIds, domainIds: allDomainIds, scope: pkgId, kind: 'package', packageId: pkgId };
  }

  const resolved = resolveDomainToCanonical(scope.replace(/^domain:/, ''), domainsConfig);
  const domainId = resolved.startsWith('domain:') ? resolved : `domain:${resolved}`;
  if (graph.nodes.get(domainId)?.type === 'domain') {
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

  return { moduleIds: new Set(), serviceIds: new Set(), domainIds: new Set(), scope, kind: 'unknown' };
}
