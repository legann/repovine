import { graphStats } from '../../graph/index.js';
import type { ToolHandler } from '../types.js';
import { resolveScope, stripDomainPrefix } from '../scope/resolve.js';
import { scopeNavigation } from '../scope/navigation.js';
import { envelope, resultError, nav } from '../response/envelope.js';
import { limitFrom, offsetFrom, pathFromRootPaginated, DEFAULT_MAP_LIMIT } from '../response/pagination.js';
import { pageTruncation } from '../../response/truncation.js';
import { mapContextEmptyDiagnostic } from '../response/empty-diagnostics.js';
import { searchGraph } from '../lib/search-graph.js';
import { buildDomainContext, buildDomainModulesSlice } from '../lib/domain-map.js';

export const handleMapContext: ToolHandler = (ctx, args) => {
  const scope = resolveScope(ctx, args.scope);
  const limit = limitFrom(args, DEFAULT_MAP_LIMIT);
  const offset = offsetFrom(args);
  const view = (args.view as string | undefined) ?? 'summary';
  let result: unknown;
  let summary = `Mapped ${scope.resolvedScope}.`;
  const gaps: string[] = [];
  const navigation = scopeNavigation(scope);

  if (scope.kind === 'all') {
    const { graph } = ctx.getState();
    const stats = graphStats(graph);
    const packages = [...(graph.byType.get('package') ?? [])].slice(offset, offset + limit).map(id => {
      const node = graph.nodes.get(id);
      return { id, label: node?.label ?? id };
    });
    const packageTotal = graph.byType.get('package')?.size ?? 0;
    const packagesBound = pageTruncation({
      shown: packages.length,
      total: packageTotal,
      offset,
      noun: 'package',
      hint: `${packageTotal} package(s). Pass offset ${offset + packages.length} with the same limit for the next page.`,
    });
    result = {
      stats,
      packages,
      packageTotal,
      ...(packagesBound ? { truncation: { packages: packagesBound } } : {}),
    };
    summary = `Repository map: ${stats.totalNodes} nodes and ${stats.totalEdges} edges.`;
  } else if (scope.kind === 'domain') {
    const domainArg = stripDomainPrefix(scope.resolvedScope);
    result = view === 'modules'
      ? buildDomainModulesSlice(ctx, {
        domainTag: domainArg,
        moduleLimit: limit,
        offset,
        includeSecondaryMatches: args.includeSecondaryMatches,
      })
      : buildDomainContext(ctx, { domain: domainArg, summaryOnly: true, moduleLimit: limit });
    summary = `Mapped domain ${scope.resolvedScope}.`;
  } else if (scope.kind === 'query') {
    result = searchGraph(ctx, { query: scope.query ?? scope.raw, maxResults: limit, offset });
    summary = `Mapped query ${scope.query ?? scope.raw} to search candidates.`;
  } else if (scope.nodeId) {
    result = pathFromRootPaginated(ctx.getState().graph, scope.nodeId, {
      limit,
      offset,
      summaryOnly: view === 'summary',
    }) ?? { error: `Not found: ${scope.nodeId}` };
    summary = `Mapped node ${scope.nodeId} to its repository path.`;
  } else {
    const message = `Could not resolve scope: ${scope.raw}`;
    return envelope(scope, message, resultError(message, {
      resolvedScope: scope.resolvedScope,
      emptyDiagnostic: mapContextEmptyDiagnostic(ctx, scope, args),
    }), {
      confidence: 'low',
      gaps: [message],
      navigation,
    });
  }

  const r = result as Record<string, unknown>;
  const topModules = Array.isArray(r.topModules) ? r.topModules as Array<{ id?: string }> : [];
  for (const m of topModules.slice(0, 5)) {
    if (m.id) {
      (navigation.deeper ??= []).push(nav('inspect_node', { nodeId: m.id }, 'Inspect a high-connectivity module in this scope.'));
    }
  }
  const focus = r.focus as { topChildren?: Array<{ id?: string }>; drillDown?: Array<{ id?: string }> } | undefined;
  const focusChildren = focus?.topChildren ?? focus?.drillDown ?? [];
  for (const child of focusChildren.slice(0, 5)) {
    if (child.id) navigation.deeper.push(nav('inspect_node', { nodeId: child.id }, 'Inspect a child node in this scope.'));
  }
  if ((result as { error?: string }).error) gaps.push((result as { error: string }).error);
  const emptyDiagnostic = mapContextEmptyDiagnostic(ctx, scope, args, r);
  const payload = emptyDiagnostic ? { ...r, emptyDiagnostic } : result;

  return envelope(scope, summary, payload, {
    confidence: gaps.length || emptyDiagnostic ? 'low' : 'high',
    gaps,
    navigation,
  });
};
