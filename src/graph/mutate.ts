/**
 * The two writes that maintain the graph's indexes.
 *
 * A leaf module: it imports only types, so both `graph/index.ts` and `graph/delta.ts` can call it.
 * They used to hold a copy each — `index.ts` re-exports from `delta.ts`, so `delta.ts` importing
 * back would have closed a cycle, and the answer was a second body rather than a third file.
 */

import type { EdgeKind, GraphEdge, GraphEdgeMetadata, GraphNode, RepositoryGraph } from '../types.js';

export function createEmptyGraph(): RepositoryGraph {
  return {
    nodes: new Map(),
    edges: [],
    outEdges: new Map(),
    inEdges: new Map(),
    byType: new Map(),
  };
}

/** Add or replace a node, keeping the by-type index in step. */
export function addNode(graph: RepositoryGraph, node: GraphNode): void {
  graph.nodes.set(node.id, node);

  let typeSet = graph.byType.get(node.type);
  if (!typeSet) {
    typeSet = new Set();
    graph.byType.set(node.type, typeSet);
  }
  typeSet.add(node.id);
}

/**
 * Append an edge, keeping both adjacency indexes in step.
 *
 * Appends without checking: a caller that can add the same edge twice guards with `hasEdge`.
 */
export function addEdge(graph: RepositoryGraph, from: string, to: string, kind: EdgeKind, metadata?: GraphEdgeMetadata): void {
  const edge: GraphEdge = metadata ? { from, to, kind, metadata } : { from, to, kind };
  graph.edges.push(edge);

  let out = graph.outEdges.get(from);
  if (!out) { out = []; graph.outEdges.set(from, out); }
  out.push(edge);

  let inc = graph.inEdges.get(to);
  if (!inc) { inc = []; graph.inEdges.set(to, inc); }
  inc.push(edge);
}
