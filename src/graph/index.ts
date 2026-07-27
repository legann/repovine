import type { GraphNode, GraphEdge, GraphEdgeMetadata, NodeType, EdgeKind, RepositoryGraph, NodeView, ExportSymbolNodeData } from '../types.js';
import { narrowTruncation, unavailableTruncation, type Truncation } from '../response/truncation.js';

export { addEdge, addNode, createEmptyGraph } from './mutate.js';

// ── Queries ──

export function getChildren(graph: RepositoryGraph, nodeId: string): GraphNode[] {
  const edges = graph.outEdges.get(nodeId) ?? [];
  return edges
    .filter(e => e.kind === 'contains')
    .map(e => graph.nodes.get(e.to))
    .filter((n): n is GraphNode => n !== undefined);
}

/**
 * Every node id of one type, in index order.
 *
 * `graph.byType` holds a `Set` that is absent rather than empty for a type no node has, and the
 * five spellings of that absence (`?? []`, a spread, an `if (set)` guard, an early return, a
 * ternary) were the whole difference between thirty-odd call sites.
 */
export function nodesOfType(graph: RepositoryGraph, type: NodeType): string[] {
  return [...(graph.byType.get(type) ?? [])];
}

/** How many nodes of this type the graph holds. */
export function countNodesOfType(graph: RepositoryGraph, type: NodeType): number {
  return graph.byType.get(type)?.size ?? 0;
}

/**
 * What to call this node in a response.
 *
 * Falls back to the id, which is always meaningful to the reader and always resolvable back to the
 * node. A site that needs a different fallback — a file path, a domain label — says so at the call
 * site rather than carrying its own copy of the lookup.
 */
export function nodeLabel(graph: RepositoryGraph, nodeId: string): string {
  return graph.nodes.get(nodeId)?.label ?? nodeId;
}

export function getParent(graph: RepositoryGraph, nodeId: string): GraphNode | undefined {
  const edges = graph.inEdges.get(nodeId) ?? [];
  const containsEdge = edges.find(e => e.kind === 'contains');
  return containsEdge ? graph.nodes.get(containsEdge.from) : undefined;
}

/**
 * True when the graph already holds this exact edge.
 *
 * Every builder that adds an edge more than once needs this test, and each one used to carry its
 * own copy with the kind baked into the body. `addEdge` appends without checking, so the guard is
 * the caller's job and the key is the whole triple.
 */
export function hasEdge(graph: RepositoryGraph, from: string, kind: EdgeKind, to: string): boolean {
  return (graph.outEdges.get(from) ?? []).some(e => e.kind === kind && e.to === to);
}

/**
 * The package node that contains this module, or `undefined` when no package does.
 *
 * The miss is `undefined` and has no other spelling. A string miss (`'unknown'`) reached
 * `map_context` as a key in `byPackage`, shaped like a package id and resolvable as nothing —
 * IaC modules hang off `root`, not off a package, so a domain holding them published a package
 * that does not exist.
 */
export function modulePackageId(graph: RepositoryGraph, moduleId: string): string | undefined {
  const pkgEdge = (graph.inEdges.get(moduleId) ?? []).find(e => e.kind === 'contains' && e.from.startsWith('pkg:'));
  return pkgEdge?.from;
}

/** Module node ids this package contains. */
export function packageModuleIds(graph: RepositoryGraph, packageId: string): string[] {
  return (graph.outEdges.get(packageId) ?? [])
    .filter(e => e.kind === 'contains' && graph.nodes.get(e.to)?.type === 'module')
    .map(e => e.to);
}

/**
 * Modules that import this one, in edge order.
 *
 * Counts every `imports` edge from a module, build-erased `import type` included, because the
 * callers ranking annotation work and flagging hubs care that a contract is depended on at all. An
 * importer that is not a module can only arrive from a plugin delta; four of the eleven call sites
 * used to check for that and seven did not, so the check belongs to the answer, not to the caller.
 *
 * Four predicates answer "how much comes in" and they are not interchangeable — the differences are
 * what each caller is asking, so merging them would delete the distinction rather than the copies:
 *
 * | Predicate | Counts | Asked by |
 * |---|---|---|
 * | `imports`, type-only included (this one) | runtime and type dependents | annotation queue priority, hub tag, domain promotion |
 * | `isRuntimeImportEdge` (`analysis/architecture/heuristics.ts`) | `imports` minus type-only | architecture fan-in, god-module and annotation-risk scores |
 * | every kind but `contains` (`mcp/lib/search-graph.ts`) | tags, infra and re-exports too | search ranking, which must score domains and resources that carry no `imports` edge at all |
 * | `imports` with resolvable symbols and barrel dedup (`mcp/lib/dependencies/package-boundaries.ts`) | named cross-package reaches | package-boundary violations |
 *
 * The last two disagree with the first two on purpose. The fourth disagrees with the second on
 * type-only imports without either side saying so, and reconciling them moves detector output.
 */
export function directImporters(graph: RepositoryGraph, nodeId: string): string[] {
  return (graph.inEdges.get(nodeId) ?? [])
    .filter(e => e.kind === 'imports' && e.from.startsWith('mod:'))
    .map(e => e.from);
}

/** How many modules import this node. See {@link directImporters} for why there are four counts. */
export function importerCount(graph: RepositoryGraph, nodeId: string): number {
  let count = 0;
  for (const edge of graph.inEdges.get(nodeId) ?? []) {
    if (edge.kind === 'imports' && edge.from.startsWith('mod:')) count++;
  }
  return count;
}

/**
 * What a runtime resource is wired to over `infra` edges, in edge order.
 *
 * The list is the whole answer: a resource can reach several targets, and not all of them are code.
 * IaC discovery attaches build artifacts (`infra:dockerfile:*`) on the same edge kind as handler
 * modules, so a caller that wants the code takes {@link handlerModuleIds} and a caller that wants
 * the wiring takes this. Taking `[0]` of this list is "whatever the parser saw first", which is a
 * weaker claim than "the handler" — the IaC parsers are per-format and their coverage is partial.
 */
export function infraTargetIds(graph: RepositoryGraph, resourceId: string): string[] {
  return (graph.outEdges.get(resourceId) ?? []).filter(e => e.kind === 'infra').map(e => e.to);
}

/** Module nodes a runtime resource dispatches into, sorted so the choice does not depend on edge order. */
export function handlerModuleIds(graph: RepositoryGraph, resourceId: string): string[] {
  return infraTargetIds(graph, resourceId)
    .filter(id => id.startsWith('mod:') && graph.nodes.has(id))
    .sort();
}

/**
 * Edge kinds every materialized runtime resource carries whether or not anything reads it:
 * `contains` ties it to its IaC module, `tagged` to its infra domain.
 */
export const STRUCTURAL_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>(['contains', 'tagged']);

/**
 * True when some load-bearing edge touches this node in either direction.
 *
 * The witness rule decides whether a runtime resource is inert. The builder prunes on it and the
 * domains advisor reports on it, so they must read the same rule — two copies of it would let the
 * advisor recommend hiding a resource the builder keeps.
 */
export function isWitnessedNode(graph: RepositoryGraph, nodeId: string): boolean {
  if (!graph.nodes.has(nodeId)) return false;
  const incident = [...(graph.outEdges.get(nodeId) ?? []), ...(graph.inEdges.get(nodeId) ?? [])];
  return incident.some(edge => !STRUCTURAL_EDGE_KINDS.has(edge.kind));
}

/** The domains a node is tagged into: ids and labels from one walk, in edge order. */
export function taggedDomains(graph: RepositoryGraph, nodeId: string): { ids: string[]; labels: string[] } {
  const ids: string[] = [];
  const labels: string[] = [];
  for (const edge of graph.outEdges.get(nodeId) ?? []) {
    if (edge.kind !== 'tagged') continue;
    ids.push(edge.to);
    labels.push(graph.nodes.get(edge.to)?.label ?? edge.to);
  }
  return { ids, labels };
}

/**
 * True for a domain-membership edge, whatever its source.
 *
 * Three partitions narrow this one, and they stay three because they are three questions. Merging
 * them would not remove a copy, it would pick one caller's answer for all of them:
 *
 * | Partition | Keeps | Asked by |
 * |---|---|---|
 * | {@link isPrimaryTag} | everything but `pattern` | domain membership in `map_context`, where a regex match is opt-in |
 * | {@link isPatternTag} | `pattern` only | the count that offers the opt-in |
 * | {@link isAuthoredTag} | everything but `cluster` and `package` | the path-only domain roll-up hash |
 *
 * Only one of the eight writers of a `tagged` edge stamps `metadata.tagSource`, so a partition must
 * say what it does with an edge that carries none — see {@link isAuthoredTag}.
 */
export function isTaggedEdge(edge: GraphEdge): boolean {
  return edge.kind === 'tagged';
}

/** Tagged edges other than regex-config matches. */
export function isPrimaryTag(edge: GraphEdge): boolean {
  return edge.kind === 'tagged' && edge.metadata?.tagSource !== 'pattern';
}

/** Tagged edges that came from a regex pattern in the domains config. */
export function isPatternTag(edge: GraphEdge): boolean {
  return edge.kind === 'tagged' && edge.metadata?.tagSource === 'pattern';
}

/**
 * Tagged edges other than those an import cluster or a package name produced.
 *
 * Written as an exclusion, not as a list of `path` and `pattern`. The inclusion form dropped every
 * member whose edge carries no source — that is seven of the eight writers, including subdomain
 * roll-ups, content domains and infra propagation — so those domains hashed to the empty sentinel
 * and their annotations could never go stale. The exclusion admits members the engine placed as
 * well as members the author placed; what it excludes is membership derived from the import graph
 * or from a package name, which moves without anyone editing the domain.
 */
export function isAuthoredTag(edge: GraphEdge): boolean {
  if (edge.kind !== 'tagged') return false;
  const source = edge.metadata?.tagSource;
  return source !== 'cluster' && source !== 'package';
}

/** True when every tag reaching this domain came from a package name. */
export function isPackageOnlyDomain(graph: RepositoryGraph, domainId: string): boolean {
  const tagged = (graph.inEdges.get(domainId) ?? []).filter(e => e.kind === 'tagged');
  if (tagged.length === 0) return false;
  return tagged.every(e => e.metadata?.tagSource === 'package');
}

/** True when the node carries a tag into this domain. Asks about the node itself, never its parent. */
export function isTaggedInto(graph: RepositoryGraph, nodeId: string, domainId: string): boolean {
  return (graph.outEdges.get(nodeId) ?? []).some(e => e.kind === 'tagged' && e.to === domainId);
}

/**
 * The nodes tagged into a domain, split by what they are.
 *
 * Membership is one walk and the split is part of the answer: subdomains carry a domain→domain tag
 * and runtime resources inherit their handler's tags, so `all` is wider than `modules` for most
 * domains. A count taken off `all` and a list taken off `modules` disagreed inside one response.
 */
export function domainMembers(graph: RepositoryGraph, domainId: string): {
  all: string[];
  modules: string[];
  resources: string[];
} {
  const all: string[] = [];
  const modules: string[] = [];
  const resources: string[] = [];
  for (const edge of graph.inEdges.get(domainId) ?? []) {
    if (edge.kind !== 'tagged') continue;
    all.push(edge.from);
    const type = graph.nodes.get(edge.from)?.type;
    if (type === 'module') modules.push(edge.from);
    else if (type === 'runtime-resource') resources.push(edge.from);
  }
  return { all, modules, resources };
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

/**
 * Reachability walk behind {@link getImpact}: every edge kind but `contains`, either direction,
 * unbounded when `maxDepth` is omitted.
 *
 * Kept separate from {@link forwardImportClosure}, which is not a narrower spelling of this walk but
 * a different question. This one answers "is that node reachable from here at all" and returns bare
 * ids with the edge kind dropped, so `mod:a --tagged--> domain:core` comes back beside a real
 * import. `forwardImportClosure` answers "does this node import that one", follows `imports` only,
 * and requires a depth. Its two callers guard on the answer meaning delivery, so widening them to
 * this walk would let a shared domain tag stand as proof of an import.
 */
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
