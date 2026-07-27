import type { RepositoryGraph } from '../types.js';
import { isWitnessedNode, nodesOfType } from '../graph/index.js';
import type { DomainsConfig } from './domains-schema.js';
import { matchesInfraResourceExclude } from './domains.js';

/**
 * Builder-level form of the witness rule: drop runtime-resource nodes that no load-bearing edge
 * witnesses (only `contains`/`tagged`). Gated by `infra.pruneInert` (off by default); `infra.keep`
 * (suffixes/patterns, matched against the resource label) is the per-resource opt-out, so a resource
 * the user explicitly keeps stays even when inert. Must run after every load-bearing edge has been
 * added (i.e. after the interpreter composer) and before the result is consumed.
 *
 * Returns the number of pruned nodes. A no-op (returns 0) unless `pruneInert` is enabled.
 */
export function pruneInertRuntimeResources(graph: RepositoryGraph, config: DomainsConfig | null): number {
  if (!config?.infra?.pruneInert) return 0;
  const resourceIds = nodesOfType(graph, 'runtime-resource');
  if (resourceIds.length === 0) return 0;

  const keepSuffixes = config.infra.keep?.suffixes;
  const keepPatterns = config.infra.keep?.patterns;
  const hasKeep = (keepSuffixes && keepSuffixes.length > 0) || (keepPatterns && keepPatterns.length > 0);

  const pruned = new Set<string>();
  for (const id of resourceIds) {
    const node = graph.nodes.get(id);
    if (!node) continue;
    if (hasKeep && matchesInfraResourceExclude(node.label, keepSuffixes, keepPatterns)) continue;
    if (!isWitnessedNode(graph, id)) pruned.add(id);
  }
  if (pruned.size === 0) return 0;

  for (const id of pruned) {
    graph.nodes.delete(id);
    graph.byType.get('runtime-resource')?.delete(id);
    graph.outEdges.delete(id);
    graph.inEdges.delete(id);
  }

  // Drop every edge touching a pruned node from the flat list and the surviving adjacency entries.
  // Inert resources only carry contains/tagged, so no load-bearing edge is ever orphaned here.
  const surviving = graph.edges.filter(edge => !pruned.has(edge.from) && !pruned.has(edge.to));
  graph.edges.length = 0;
  graph.edges.push(...surviving);
  for (const [key, list] of graph.outEdges) {
    const filtered = list.filter(edge => !pruned.has(edge.to));
    if (filtered.length !== list.length) graph.outEdges.set(key, filtered);
  }
  for (const [key, list] of graph.inEdges) {
    const filtered = list.filter(edge => !pruned.has(edge.from));
    if (filtered.length !== list.length) graph.inEdges.set(key, filtered);
  }

  return pruned.size;
}
