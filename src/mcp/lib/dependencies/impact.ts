import { getImpact, getParent } from '../../../graph/index.js';
import { resolveNodeId, type McpToolRuntime } from '../../types.js';
import { paginateList } from '../../response/pagination.js';
import { PER_BUCKET_CAP } from '../../../source-plugins/typescript/call-graph.js';
import { getCallersByName } from './reverse-calls.js';
import { truncationMap } from '../../../response/truncation.js';
import { provenance } from '../../../response/provenance.js';

export function analyzeImpact(ctx: McpToolRuntime, args: Record<string, unknown>): unknown {
  const { graph, modulesById } = ctx.getState();
  const rawId = args.nodeId as string;
  const exportName = args.exportName as string | undefined;
  const maxDepth = args.maxDepth as number | undefined;
  const limit = typeof args.limit === 'number' ? Math.max(1, args.limit) : 20;
  const offset = typeof args.offset === 'number' ? Math.max(0, args.offset) : 0;
  const nodeId = resolveNodeId(graph, rawId);
  if (!nodeId) return { error: `Node not found: ${rawId}` };
  const node = graph.nodes.get(nodeId);

  // Part 3 — export-symbol scope precision. Import edges run module → module; an export-symbol node
  // has none. So walk the import impact of the export's PARENT module and filter importers by the
  // export name. This restores precise, collision-free resolved callers for an
  // `analyze_dependencies(export:…X, impact)` query, which otherwise returned nothing.
  const isExportSymbol = node?.type === 'export-symbol';
  const filterName = isExportSymbol ? node.label : exportName;
  const importTargetId = (isExportSymbol ? getParent(graph, nodeId)?.id : nodeId) ?? nodeId;

  const impact = getImpact(graph, importTargetId, 'both', maxDepth);
  const nodeLabel = (id: string) => graph.nodes.get(id)?.label ?? id;
  const findUsedNames = (dependentId: string, targetId: string): string[] | undefined => {
    const imp = modulesById.get(dependentId)?.imports.find(i => i.resolvedModuleId === targetId);
    if (imp?.importedNames.length) return imp.importedNames;
    // A barrel-redirected import edge points at the leaf while the import record points at the
    // barrel; the names it routed are on the edge metadata.
    const edge = (graph.outEdges.get(dependentId) ?? []).find(e => e.kind === 'imports' && e.to === targetId);
    const used = edge?.metadata?.usedNames;
    return used?.length ? used : undefined;
  };
  let downstreamEntries = impact.downstream
    .filter(id => id !== nodeId)
    .map(id => {
      const entry: Record<string, unknown> = { id, label: nodeLabel(id), type: graph.nodes.get(id)?.type };
      const uses = findUsedNames(id, importTargetId);
      if (uses) entry.uses = uses;
      return entry;
    });
  if (filterName) {
    downstreamEntries = downstreamEntries.filter(e => (e.uses as string[] | undefined)?.includes(filterName));
  }

  // Reverse-by-name completeness backstop (grep-parity, works across barrels): when the query is
  // scoped to a single symbol — an export-symbol node, or a module plus exportName — union the
  // modules whose forward calls include that name. These are matched by call name, not a resolved
  // import edge, so they carry `provenance` naming the index that found them; entries reached over a
  // graph edge carry none, because the walk records no edge kind and labelling them all as import
  // callers would claim an edge that may have been `infra` or `reexports`. Graph-reached callers keep
  // priority and de-duplicate the name-only hits.
  let nameMatchedCallers = 0;
  if (filterName) {
    const seen = new Set(downstreamEntries.map(e => e.id as string));
    seen.add(importTargetId);
    for (const callerId of getCallersByName(modulesById).get(filterName) ?? []) {
      if (callerId === nodeId || seen.has(callerId)) continue;
      seen.add(callerId);
      nameMatchedCallers++;
      downstreamEntries.push({
        id: callerId,
        label: nodeLabel(callerId),
        type: graph.nodes.get(callerId)?.type,
        provenance: provenance('call-name-index'),
      });
    }
  }
  const upstreamEntries = impact.upstream
    .filter(id => id !== nodeId)
    .map(id => {
      const entry: Record<string, unknown> = { id, label: nodeLabel(id), type: graph.nodes.get(id)?.type };
      const uses = findUsedNames(importTargetId, id);
      if (uses) entry.uses = uses;
      return entry;
    });
  const down = paginateList(downstreamEntries, {
    limit, offset, noun: 'downstream importer',
    narrow: filterName ? 'reduce depth' : 'pass exportName to scope to one export, or reduce depth',
  });
  const up = paginateList(upstreamEntries, { limit, offset, noun: 'upstream dependency', narrow: 'reduce depth' });
  const truncation = truncationMap({ downstream: down.truncation, upstream: up.truncation });
  return {
    nodeId,
    label: nodeLabel(nodeId),
    ...(filterName ? { filteredByExport: filterName } : {}),
    ...(nameMatchedCallers > 0 ? { nameMatchedCallers } : {}),
    downstream: down.page,
    upstream: up.page,
    ...(truncation ? { truncation } : {}),
  };
}

/**
 * What the caller index knows about a name-matched caller, and why it is weaker than an import edge.
 *
 * The index is built from call names capped per declaration while extracting, so a caller whose
 * declaration exceeded the cap is absent from it — the answer is a completeness backstop, not grep
 * parity, and nothing in the response marks the absence. Said as a gap because the cap may not have
 * bitten on this query at all: counting what a rebuild would add is not possible from here.
 */
export function nameMatchGap(): string {
  return `Name-matched callers come from a call index capped at ${PER_BUCKET_CAP} distinct call names per declaration while extracting; callers in declarations above the cap are not represented.`;
}
