import type { GraphNode, GraphEdge, GraphEdgeMetadata, NodeType, EdgeKind, RepositoryGraph, NodeView, ExportSymbolNodeData } from '../types.js';
import { narrowTruncation, unavailableTruncation, type Truncation } from '../response/truncation.js';

export function createEmptyGraph(): RepositoryGraph {
  return {
    nodes: new Map(),
    edges: [],
    outEdges: new Map(),
    inEdges: new Map(),
    byType: new Map(),
  };
}

export function addNode(graph: RepositoryGraph, node: GraphNode): void {
  graph.nodes.set(node.id, node);

  let typeSet = graph.byType.get(node.type);
  if (!typeSet) {
    typeSet = new Set();
    graph.byType.set(node.type, typeSet);
  }
  typeSet.add(node.id);
}

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

// ── Queries ──

export function getChildren(graph: RepositoryGraph, nodeId: string): GraphNode[] {
  const edges = graph.outEdges.get(nodeId) ?? [];
  return edges
    .filter(e => e.kind === 'contains')
    .map(e => graph.nodes.get(e.to))
    .filter((n): n is GraphNode => n !== undefined);
}

export function getParent(graph: RepositoryGraph, nodeId: string): GraphNode | undefined {
  const edges = graph.inEdges.get(nodeId) ?? [];
  const containsEdge = edges.find(e => e.kind === 'contains');
  return containsEdge ? graph.nodes.get(containsEdge.from) : undefined;
}

export function getLinks(graph: RepositoryGraph, nodeId: string): Array<{ targetId: string; relation: EdgeKind; label: string; tagSource?: NonNullable<GraphEdgeMetadata['tagSource']> }> {
  const edges = graph.outEdges.get(nodeId) ?? [];
  return edges
    .filter(e => e.kind !== 'contains')
    .map(e => {
      const entry: { targetId: string; relation: EdgeKind; label: string; tagSource?: NonNullable<GraphEdgeMetadata['tagSource']> } = {
        targetId: e.to,
        relation: e.kind,
        label: graph.nodes.get(e.to)?.label ?? e.to,
      };
      if (e.kind === 'tagged' && e.metadata?.tagSource) entry.tagSource = e.metadata.tagSource;
      return entry;
    });
}

/** Response cap for buildNodeView; graph queries keep using the complete adjacency indexes. */
export const MAX_NODE_VIEW_LINKS = 50;

function uniqueNodeViewLinks(links: NonNullable<NodeView['links']>): NonNullable<NodeView['links']> {
  const seen = new Set<string>();
  return links.filter(link => {
    const key = `${link.relation}\0${link.targetId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fillExportSymbolEntry(
  entry: NodeView['drillDown'][number],
  d: ExportSymbolNodeData,
): void {
  if (d.signature) entry.signature = d.signature;
  if (d.symbolKind) entry.symbolKind = d.symbolKind;
  if (d.typeValue) entry.typeValue = d.typeValue;
  if (d.fields) entry.fields = d.fields;
  if (d.implementsInterfaces) entry.implementsInterfaces = d.implementsInterfaces;
  if (d.calls) entry.calls = d.calls;
  const calls = callsTruncation(d);
  if (calls) entry.truncation = { calls };
  if (d.lineRange) entry.lineRange = d.lineRange;
}

/**
 * The bound on a declaration's callee names, applied while extracting.
 *
 * Names past the cap are discarded there, so only their count reaches the graph — no call returns
 * them, and raising the cap needs a rebuild.
 */
export function callsTruncation(d: ExportSymbolNodeData): Truncation | undefined {
  const total = d.callsTotal;
  const shown = d.calls?.length ?? 0;
  if (!total || total <= shown) return undefined;
  return unavailableTruncation({
    shown,
    total,
    unit: 'name',
    hint: 'Call names are capped per declaration while extracting; the dropped names are not in the graph.',
  });
}

export function buildNodeView(graph: RepositoryGraph, nodeId: string): NodeView | null {
  const node = graph.nodes.get(nodeId);
  if (!node) return null;

  const levelMap: Record<NodeType, number> = {
    root: 0, package: 1, 'runtime-resource': 1, domain: 1,
    module: 2, template: 2, 'export-symbol': 3,
  };

  const children = getChildren(graph, nodeId);
  const allLinks = uniqueNodeViewLinks(getLinks(graph, nodeId));
  const links = allLinks.slice(0, MAX_NODE_VIEW_LINKS);

  const drillDown: NodeView['drillDown'] = children.map(c => {
    const entry: NodeView['drillDown'][number] = { id: c.id, label: c.label, type: c.type };
    if (c.type === 'export-symbol' && c.data) fillExportSymbolEntry(entry, c.data);
    return entry;
  });

  const linksTruncation = allLinks.length > links.length
    ? narrowTruncation({
      shown: links.length,
      total: allLinks.length,
      hint: `Links are capped at ${MAX_NODE_VIEW_LINKS} in node views; use analyze_dependencies or trace_flow for complete traversal.`,
    })
    : undefined;

  const view: NodeView = {
    id: node.id,
    level: levelMap[node.type] ?? 2,
    label: node.label,
    description: node.description,
    drillDown,
    links: links.length > 0 ? links : undefined,
    ...(linksTruncation ? { truncation: { links: linksTruncation } } : {}),
  };

  if (node.type === 'export-symbol' && node.data) {
    view.signature = node.data.signature;
    view.params = node.data.params;
    view.returnType = node.data.returnType;
    view.typeValue = node.data.typeValue;
    view.lineRange = node.data.lineRange;
    view.symbolKind = node.data.symbolKind;
    view.fields = node.data.fields;
    view.implementsInterfaces = node.data.implementsInterfaces;
    view.calls = node.data.calls;
    const calls = callsTruncation(node.data);
    if (calls) view.truncation = { ...view.truncation, calls };
  }
  if (node.type === 'module' && node.data) {
    if (node.data.envVars) view.envVars = node.data.envVars;
    if (node.data.hasRoutes) view.hasRoutes = true;
    if (node.data.ssr) view.ssr = node.data.ssr;
    if (node.data.sourcePluginId) view.sourcePluginId = node.data.sourcePluginId;
  }

  return view;
}

export function pathFromRoot(graph: RepositoryGraph, focusId: string): { path: NodeView[]; focus: NodeView } | null {
  const focus = buildNodeView(graph, focusId);
  if (!focus) return null;

  const chain: NodeView[] = [];
  let current = focusId;

  while (true) {
    const parent = getParent(graph, current);
    if (!parent) break;
    const parentView = buildNodeView(graph, parent.id);
    if (parentView) chain.unshift(parentView);
    current = parent.id;
  }

  return { path: chain, focus };
}

export function getImpact(
  graph: RepositoryGraph,
  nodeId: string,
  direction: 'downstream' | 'upstream' | 'both' = 'both',
  maxDepth?: number,
): { downstream: string[]; upstream: string[] } {
  const downstream = new Set<string>();
  const upstream = new Set<string>();

  if (direction === 'downstream' || direction === 'both') {
    bfs(graph, nodeId, 'in', downstream, maxDepth);
  }
  if (direction === 'upstream' || direction === 'both') {
    bfs(graph, nodeId, 'out', upstream, maxDepth);
  }

  downstream.delete(nodeId);
  upstream.delete(nodeId);

  return {
    downstream: [...downstream],
    upstream: [...upstream],
  };
}

function bfs(
  graph: RepositoryGraph,
  start: string,
  follow: 'in' | 'out',
  visited: Set<string>,
  maxDepth?: number,
): void {
  const queue: Array<{ id: string; depth: number }> = [{ id: start, depth: 0 }];
  visited.add(start);
  const queuedForExpansion = new Set<string>([start]);

  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;
    const { id: current, depth } = item;
    if (maxDepth !== undefined && depth >= maxDepth) continue;
    const edges = follow === 'out'
      ? (graph.outEdges.get(current) ?? [])
      : (graph.inEdges.get(current) ?? []);

    for (const edge of edges) {
      if (edge.kind === 'contains') continue;
      const next = follow === 'out' ? edge.to : edge.from;
      visited.add(next);
      // Re-export targets are part of impact, but expanding through them recursively makes every
      // multi-consumer barrel look like a dependency of every other consumer. A non-reexport path
      // may still enqueue the same node later, so alternate direct-import reachability is preserved.
      if (edge.kind === 'reexports' || queuedForExpansion.has(next)) continue;
      queuedForExpansion.add(next);
      queue.push({ id: next, depth: depth + 1 });
    }
  }
}

/**
 * Node ids the start node transitively imports, up to `maxDepth` hops. Follows `imports` edges only
 * (dependency direction: the start node depends on each returned id). The start node is excluded.
 * Bounded membership test for the investigate-channel direction guard, not a full reachability walk.
 */
export function forwardImportClosure(graph: RepositoryGraph, start: string, maxDepth: number): Set<string> {
  const closure = new Set<string>();
  const seen = new Set<string>([start]);
  const queue: Array<{ id: string; depth: number }> = [{ id: start, depth: 0 }];
  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;
    const { id, depth } = item;
    if (depth >= maxDepth) continue;
    for (const edge of graph.outEdges.get(id) ?? []) {
      if (edge.kind !== 'imports') continue;
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      closure.add(edge.to);
      queue.push({ id: edge.to, depth: depth + 1 });
    }
  }
  return closure;
}

// ── Stats ──

export function graphStats(graph: RepositoryGraph) {
  const nodesByType: Record<string, number> = {};
  for (const [type, ids] of graph.byType) {
    nodesByType[type] = ids.size;
  }
  const edgesByKind: Record<string, number> = {};
  for (const edge of graph.edges) {
    edgesByKind[edge.kind] = (edgesByKind[edge.kind] ?? 0) + 1;
  }
  return {
    totalNodes: graph.nodes.size,
    totalEdges: graph.edges.length,
    nodesByType,
    edgesByKind,
  };
}

export { applyValidated, emptyGraphDelta, GraphDeltaSchema, validateGraphDelta } from './delta.js';
export type {
  ApplyGraphDeltaOptions,
  GraphDeltaLogLevel,
  GraphDeltaValidationResult,
} from './delta.js';
export { owningModuleId } from './node-ids.js';
