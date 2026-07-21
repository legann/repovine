import type { McpToolRuntime } from '../types.js';
import type { Confidence } from './envelope.js';
import type { ResolvedScope } from '../scope/resolve.js';
import {
  graphIsEffectivelyEmpty,
  refactoringScopeArg,
  scopeLabel,
} from '../scope/resolve.js';
import {
  DEFAULT_ARCHITECTURE_LIMIT,
  DEFAULT_MAP_LIMIT,
  offsetFrom,
} from './pagination.js';
import { searchTokenize } from '../lib/search-index.js';

export type EmptyDiagnosticReason =
  | 'graph_empty'
  | 'semantic_domain_not_runtime_boundary'
  | 'library_module_no_entrypoint'
  | 'package_has_no_entrypoints'
  | 'filtered_out'
  | 'query_no_entrypoints'
  | 'scope_unresolved'
  | 'no_entrypoints_indexed'
  | 'semantic_scope_has_no_runtime_topology'
  | 'no_producer_resource_consumer_edges'
  | 'no_token_hits'
  | 'strict_and_no_single_node'
  | 'type_filter_excluded'
  | 'weak_token_only_suppressed'
  | 'scope_has_no_config_surface'
  | 'kind_filter_empty'
  | 'name_pattern_empty'
  | 'scope_has_no_map_context'
  | 'package_has_no_modules'
  | 'offset_out_of_range'
  | 'dependency_mode_scope_mismatch'
  | 'no_cross_package_edges'
  | 'no_dependency_edges'
  | 'no_interface_implementations'
  | 'no_callgraph_edges'
  | 'no_architecture_findings'
  | 'finding_not_found';

export type EmptyDiagnosticAction = {
  when?: string;
  tool?: string;
  args?: Record<string, unknown>;
  note?: string;
};

export type EmptyDiagnostic = {
  reason: EmptyDiagnosticReason;
  message: string;
  diagnosticConfidence: Confidence;
  nextActions: EmptyDiagnosticAction[];
  details?: Record<string, unknown>;
};

type CollectorResult = {
  total: number;
};

type EmptyDiagnosticCollectors = {
  collectEntrypoints: (ctx: McpToolRuntime, args: Record<string, unknown>) => CollectorResult;
  collectConfigSurface: (ctx: McpToolRuntime, args: Record<string, unknown>) => CollectorResult;
};

let collectors: EmptyDiagnosticCollectors | undefined;

/** Wire tool-layer collectors after handlers refactor to avoid circular imports. */
export function wireEmptyDiagnosticCollectors(deps: EmptyDiagnosticCollectors): void {
  collectors = deps;
}

function collectEntrypoints(ctx: McpToolRuntime, args: Record<string, unknown>): CollectorResult {
  if (!collectors) {
    throw new Error('empty-diagnostics: collectEntrypoints not wired — call wireEmptyDiagnosticCollectors during MCP init');
  }
  return collectors.collectEntrypoints(ctx, args);
}

function collectConfigSurface(ctx: McpToolRuntime, args: Record<string, unknown>): CollectorResult {
  if (!collectors) {
    throw new Error('empty-diagnostics: collectConfigSurface not wired — call wireEmptyDiagnosticCollectors during MCP init');
  }
  return collectors.collectConfigSurface(ctx, args);
}

export { searchTokenize };

export function graphEmptyDiagnostic(): EmptyDiagnostic {
  return {
    reason: 'graph_empty',
      message: 'The repository graph has no indexed modules, templates, runtime resources, export symbols, or domains, so no narrower alternatives can be inferred yet.',
    diagnosticConfidence: 'high',
    nextActions: [
      { tool: 'refresh_context', args: {}, note: 'Build or refresh the repository syntax index.' },
      { note: 'If refresh still returns an empty graph, check the repovine repo root and scan configuration.' },
    ],
  };
}

export function emptyAction(when: string, tool: string, args: Record<string, unknown>): EmptyDiagnosticAction {
  return { when, tool, args };
}

export function entrypointsEmptyDiagnostic(
  ctx: McpToolRuntime,
  scope: ResolvedScope,
  args: Record<string, unknown>,
): EmptyDiagnostic {
  if (graphIsEffectivelyEmpty(ctx)) return graphEmptyDiagnostic();
  if (scope.kind === 'unknown') {
    return {
      reason: 'scope_unresolved',
        message: `The scope "${scope.raw}" did not resolve to a graph node, package, domain, template, runtime resource, or query scope.`,
      diagnosticConfidence: 'high',
      nextActions: [
        emptyAction('if you have a symbol or path', 'search_context', { query: scope.query ?? scope.raw }),
        emptyAction('if you need repository-level entrypoints', 'get_entrypoints', { scope: 'all' }),
      ],
    };
  }

  const hasKindFilter =
    (typeof args.kind === 'string' && args.kind !== 'all')
    || (Array.isArray(args.kinds) && !args.kinds.includes('all'));
  const hasLayerFilter = typeof args.layer === 'string' && args.layer !== 'all';
  if ((hasKindFilter || hasLayerFilter) && collectEntrypoints(ctx, { scope: scope.resolvedScope, limit: 1 }).total > 0) {
    return {
      reason: 'filtered_out',
      message: `Entrypoints exist in ${scopeLabel(scope)}, but the requested kind/layer filter removed all of them.`,
      diagnosticConfidence: 'high',
      nextActions: [
        emptyAction('to inspect unfiltered execution starts', 'get_entrypoints', { scope: scope.resolvedScope }),
      ],
      details: {
        kind: args.kind,
        kinds: args.kinds,
        layer: args.layer,
      },
    };
  }

  if (scope.kind === 'domain') {
    const label = scope.domainId?.replace(/^domain:/, '') ?? scope.raw.replace(/^domain:/, '');
    return {
      reason: 'semantic_domain_not_runtime_boundary',
      message: `${scope.resolvedScope} is a semantic/path tag. Entrypoints are owned by handler modules, pages, packages, or runtime resources, not by the domain tag itself.`,
      diagnosticConfidence: 'high',
      nextActions: [
        emptyAction('if you need runtime/API/page entrypoints', 'search_context', { query: `${label} handler route lambda` }),
        emptyAction('if you need code structure', 'map_context', { scope: scope.resolvedScope, view: 'modules' }),
        emptyAction('if you need import/consumer relationships', 'analyze_dependencies', { scope: scope.resolvedScope, mode: 'import-map' }),
      ],
    };
  }

  if (scope.kind === 'module' || scope.kind === 'export-symbol') {
    return {
      reason: 'library_module_no_entrypoint',
      message: `${scope.resolvedScope} does not own a detected route/page/API/queue/schedule entrypoint. It may be library code used by another handler or page.`,
      diagnosticConfidence: 'medium',
      nextActions: [
        emptyAction('if you need consumers/importers', 'analyze_dependencies', { scope: scope.resolvedScope, mode: 'impact' }),
        emptyAction('if you need implementation details', 'inspect_node', { nodeId: scope.nodeId ?? scope.resolvedScope }),
      ],
    };
  }

  if (scope.kind === 'package') {
    return {
      reason: 'package_has_no_entrypoints',
      message: `${scope.resolvedScope} has no detected execution starts. It may be a library package or the entrypoint detector may not cover this package's runtime style.`,
      diagnosticConfidence: 'medium',
      nextActions: [
        emptyAction('if you need package structure', 'map_context', { scope: scope.resolvedScope, view: 'modules' }),
        emptyAction('if you need likely runtime anchors', 'search_context', { query: `${scope.raw.replace(/^pkg:/, '')} handler route` }),
      ],
    };
  }

  if (scope.kind === 'query') {
    return {
      reason: 'query_no_entrypoints',
      message: `No detected entrypoints matched query scope "${scope.query ?? scope.raw}". Try a stronger symbol, route path, package, module, or runtime-resource anchor.`,
      diagnosticConfidence: 'medium',
      nextActions: [
        emptyAction('to find graph anchors first', 'search_context', { query: scope.query ?? scope.raw }),
        emptyAction('to inspect all known execution starts', 'get_entrypoints', { scope: 'all' }),
      ],
    };
  }

  return {
    reason: 'no_entrypoints_indexed',
    message: `No detected execution starts matched ${scopeLabel(scope)}.`,
    diagnosticConfidence: 'medium',
    nextActions: [
      emptyAction('to inspect all known execution starts', 'get_entrypoints', { scope: 'all' }),
      emptyAction('to search for runtime anchors', 'search_context', { query: 'handler route lambda page' }),
    ],
  };
}

export function traceFlowEmptyDiagnostic(
  ctx: McpToolRuntime,
  scope: ResolvedScope,
  args: Record<string, unknown>,
  counts: { services: number; resources: number; dataFlows: number; entrypoints: number },
): EmptyDiagnostic {
  if (graphIsEffectivelyEmpty(ctx)) return graphEmptyDiagnostic();
  if (scope.kind === 'unknown') {
    return {
      reason: 'scope_unresolved',
      message: `The scope "${scope.raw}" did not resolve, so runtime topology cannot be traced for it.`,
      diagnosticConfidence: 'high',
      nextActions: [
        emptyAction('if you have a symbol or runtime name', 'search_context', { query: scope.query ?? scope.raw }),
      ],
    };
  }
  if (scope.kind === 'domain') {
    const label = scope.domainId?.replace(/^domain:/, '') ?? scope.raw.replace(/^domain:/, '');
    return {
      reason: 'semantic_domain_not_runtime_boundary',
      message: `${scope.resolvedScope} is a semantic/path tag. Runtime flow is graph-proven through services/resources/entrypoints, which may live outside that domain tag.`,
      diagnosticConfidence: 'high',
      nextActions: [
        emptyAction('if you need runtime flow', 'search_context', { query: `${label} handler route lambda` }),
        emptyAction('if you need code structure', 'map_context', { scope: scope.resolvedScope, view: 'modules' }),
      ],
      details: counts,
    };
  }
  if (counts.services > 0 && counts.dataFlows === 0) {
    return {
      reason: 'no_producer_resource_consumer_edges',
      message: `Runtime services/resources were found for ${scopeLabel(scope)}, but no concrete producer-resource-consumer data flow was proven.`,
      diagnosticConfidence: 'medium',
      nextActions: [
        emptyAction('if you need execution starts first', 'get_entrypoints', { scope: scope.resolvedScope }),
        emptyAction('if you need config/resource bindings', 'get_config_surface', { scope: scope.resolvedScope }),
      ],
      details: counts,
    };
  }
  return {
    reason: 'semantic_scope_has_no_runtime_topology',
    message: `No runtime services, resources, entrypoints, or data-flow edges matched ${scopeLabel(scope)}.`,
    diagnosticConfidence: 'medium',
    nextActions: [
      emptyAction('if you need execution starts', 'get_entrypoints', { scope: scope.resolvedScope }),
      emptyAction('if you need code structure', 'map_context', { scope: scope.resolvedScope }),
    ],
    details: { ...counts, include: args.include },
  };
}

export function searchEmptyDiagnostic(
  ctx: McpToolRuntime,
  query: string,
  rawTypes: string[] | undefined,
  matches: Record<string, unknown>,
): EmptyDiagnostic {
  if (graphIsEffectivelyEmpty(ctx)) return graphEmptyDiagnostic();
  const strategy = matches.strategy as {
    requested?: string;
    used?: string;
    tokens?: string[];
    relaxedFrom?: string;
    weakTokenOnlySuppressed?: boolean;
  } | undefined;
  const tokens = strategy?.tokens ?? searchTokenize(query);
  const { searchIndex } = ctx.getState();
  const hitTokens = tokens.filter(t => (searchIndex.tokens.get(t)?.size ?? 0) > 0);
  if (strategy?.weakTokenOnlySuppressed) {
    return {
      reason: 'weak_token_only_suppressed',
      message: 'Only weak/common tokens had matches after auto-relaxation, so search_context suppressed them instead of surfacing noisy results.',
      diagnosticConfidence: 'high',
      nextActions: [
        emptyAction('if you want weak-token matches anyway', 'search_context', { query, match: 'or' }),
        emptyAction('if you know a stronger symbol/path', 'search_context', { query: '<symbol-or-path>' }),
      ],
      details: { tokens, hitTokens },
    };
  }
  if (hitTokens.length === 0) {
    return {
      reason: 'no_token_hits',
      message: 'None of the query tokens matched the repository search index.',
      diagnosticConfidence: 'high',
      nextActions: [
        emptyAction('if you have a path/package/domain alias', 'map_context', { scope: query }),
        emptyAction('to browse from the repository root', 'map_context', { scope: 'all', view: 'summary' }),
      ],
      details: { tokens },
    };
  }
  if (rawTypes?.length) {
    return {
      reason: 'type_filter_excluded',
      message: 'Some query tokens matched the index, but no results survived the requested type filter.',
      diagnosticConfidence: 'medium',
      nextActions: [
        emptyAction('to retry without type filtering', 'search_context', { query }),
      ],
      details: { tokens, hitTokens, types: rawTypes },
    };
  }
  return {
    reason: 'strict_and_no_single_node',
    message: 'Query tokens matched the index, but no single graph node matched the requested token combination.',
    diagnosticConfidence: 'medium',
    nextActions: [
      emptyAction('to intentionally union token matches', 'search_context', { query, match: 'or' }),
      emptyAction('to narrow by one strong anchor', 'search_context', { query: hitTokens[0] ?? query }),
    ],
    details: { tokens, hitTokens, strategy },
  };
}

export function configSurfaceEmptyDiagnostic(
  ctx: McpToolRuntime,
  scope: ResolvedScope,
  args: Record<string, unknown>,
): EmptyDiagnostic {
  if (graphIsEffectivelyEmpty(ctx)) return graphEmptyDiagnostic();
  if (scope.kind === 'unknown') {
    return {
      reason: 'scope_unresolved',
      message: `The scope "${scope.raw}" did not resolve, so config/resource bindings cannot be inspected for it.`,
      diagnosticConfidence: 'high',
      nextActions: [
        emptyAction('if you have a config/resource name', 'get_config_surface', { scope: 'all', namePattern: scope.query ?? scope.raw }),
        emptyAction('if you have a symbol/path', 'search_context', { query: scope.query ?? scope.raw }),
      ],
    };
  }

  const hasKindFilter =
    (typeof args.kind === 'string' && args.kind !== 'all')
    || (Array.isArray(args.kinds) && !args.kinds.includes('all'));
  const hasNamePattern = typeof args.namePattern === 'string' && args.namePattern.trim().length > 0;
  if ((hasKindFilter || hasNamePattern) && collectConfigSurface(ctx, { scope: scope.resolvedScope, limit: 1 }).total > 0) {
    return {
      reason: hasNamePattern ? 'name_pattern_empty' : 'kind_filter_empty',
      message: `Config/resource surface items exist in ${scopeLabel(scope)}, but the requested filter removed all of them.`,
      diagnosticConfidence: 'high',
      nextActions: [
        emptyAction('to inspect unfiltered config/resource surface', 'get_config_surface', { scope: scope.resolvedScope }),
      ],
      details: {
        kind: args.kind,
        kinds: args.kinds,
        namePattern: args.namePattern,
      },
    };
  }

  return {
    reason: 'scope_has_no_config_surface',
    message: `No env vars, public config, secrets, resources, or resource bindings matched ${scopeLabel(scope)}.`,
    diagnosticConfidence: 'medium',
    nextActions: [
      emptyAction('if you need code structure instead', 'map_context', { scope: scope.resolvedScope }),
      emptyAction('if you need runtime topology', 'trace_flow', { scope: scope.resolvedScope, include: ['services', 'resources', 'flows'] }),
    ],
  };
}

export function mapContextEmptyDiagnostic(
  ctx: McpToolRuntime,
  scope: ResolvedScope,
  args: Record<string, unknown>,
  result?: Record<string, unknown>,
): EmptyDiagnostic | undefined {
  if (graphIsEffectivelyEmpty(ctx)) return graphEmptyDiagnostic();
  if (scope.kind === 'unknown') {
    return {
      reason: 'scope_unresolved',
        message: `The scope "${scope.raw}" did not resolve to a graph node, package, domain, template, runtime resource, or query scope.`,
      diagnosticConfidence: 'high',
      nextActions: [
        emptyAction('if this is a symbol, file, route, config, or feature name', 'search_context', { query: scope.query ?? scope.raw }),
        emptyAction('to browse from the repository root', 'map_context', { scope: 'all', view: 'summary' }),
      ],
    };
  }

  const pagination = result?.pagination as { total?: unknown; returned?: unknown; offset?: unknown } | undefined;
  const focus = result?.focus as { childPagination?: { total?: unknown; returned?: unknown; offset?: unknown } } | undefined;
  const childPagination = focus?.childPagination;
  const total = typeof pagination?.total === 'number'
    ? pagination.total
    : typeof childPagination?.total === 'number'
      ? childPagination.total
      : undefined;
  const returned = typeof pagination?.returned === 'number'
    ? pagination.returned
    : typeof childPagination?.returned === 'number'
      ? childPagination.returned
      : undefined;
  const offset = typeof pagination?.offset === 'number'
    ? pagination.offset
    : typeof childPagination?.offset === 'number'
      ? childPagination.offset
      : offsetFrom(args);
  if (typeof total === 'number' && total > 0 && returned === 0 && offset > 0) {
    return {
      reason: 'offset_out_of_range',
      message: `The scope has ${total} item(s), but offset ${offset} is outside the available page range.`,
      diagnosticConfidence: 'high',
      nextActions: [
        emptyAction('to restart pagination', 'map_context', { scope: scope.resolvedScope, view: args.view ?? 'summary', limit: args.limit ?? DEFAULT_MAP_LIMIT, offset: 0 }),
      ],
      details: { total, returned, offset },
    };
  }

  if (scope.kind === 'query' && typeof result?.totalResults === 'number' && result.totalResults === 0) {
    return searchEmptyDiagnostic(ctx, scope.query ?? scope.raw, undefined, result);
  }

  if (scope.kind === 'domain') {
    const moduleCount =
      typeof result?.moduleCount === 'number' ? result.moduleCount
        : typeof result?.taggedModules === 'number' ? result.taggedModules
          : typeof result?.totalWithDeps === 'number' ? result.totalWithDeps
            : undefined;
    if (moduleCount === 0) {
      const label = scope.domainId?.replace(/^domain:/, '') ?? scope.raw.replace(/^domain:/, '');
      return {
        reason: 'scope_has_no_map_context',
        message: `${scope.resolvedScope} exists as a domain tag, but no modules are currently tagged into that scope.`,
        diagnosticConfidence: 'medium',
        nextActions: [
          emptyAction('to find similarly named anchors', 'search_context', { query: label }),
          emptyAction('to browse repository packages/domains', 'map_context', { scope: 'all', view: 'summary' }),
        ],
        details: { moduleCount },
      };
    }
  }

  if (scope.kind === 'package') {
    const childTotal = typeof childPagination?.total === 'number' ? childPagination.total : undefined;
    if (childTotal === 0) {
      return {
        reason: 'package_has_no_modules',
        message: `${scope.resolvedScope} resolved as a package, but it has no module children in the current graph.`,
        diagnosticConfidence: 'medium',
        nextActions: [
          emptyAction('to inspect package-level dependencies', 'analyze_dependencies', { scope: scope.resolvedScope, mode: 'package-boundaries' }),
          emptyAction('to find files/symbols by query instead', 'search_context', { query: scope.raw.replace(/^pkg:/, '') }),
        ],
        details: { childTotal },
      };
    }
  }

  return undefined;
}

export function dependencyModeScopeMismatchDiagnostic(
  ctx: McpToolRuntime,
  scope: ResolvedScope,
  mode: string,
  message: string,
): EmptyDiagnostic {
  if (graphIsEffectivelyEmpty(ctx)) return graphEmptyDiagnostic();
  if (scope.kind === 'unknown') {
    return {
      reason: 'scope_unresolved',
      message: `The scope "${scope.raw}" did not resolve, so dependency analysis cannot choose the correct module/package/export-symbol boundary.`,
      diagnosticConfidence: 'high',
      nextActions: [
        emptyAction('if this is a symbol or path', 'search_context', { query: scope.query ?? scope.raw }),
        emptyAction('to browse package/module scopes', 'map_context', { scope: 'all', view: 'summary' }),
      ],
    };
  }

  const nextActions: EmptyDiagnosticAction[] = [];
  if (mode === 'impact') {
    nextActions.push(
      emptyAction('if you need domain/package import shape', 'analyze_dependencies', { scope: scope.resolvedScope, mode: 'import-map' }),
      emptyAction('if you need a concrete change target first', 'map_context', { scope: scope.resolvedScope, view: scope.kind === 'domain' ? 'modules' : 'summary' }),
    );
  } else if (mode === 'callgraph') {
    // The mismatch usually means the scope is a package/domain; suggesting the same scope back
    // would fail again, so point at a module placeholder unless the scope already is one.
    const callgraphScope = scope.kind === 'module' ? scope.resolvedScope : '<mod:package/path/module>';
    nextActions.push(
      emptyAction('if you have a module and export name', 'analyze_dependencies', { scope: callgraphScope, mode: 'callgraph', exportName: '<exportName>' }),
      emptyAction('to inspect exports first', 'inspect_node', { scope: scope.resolvedScope }),
    );
  } else if (mode === 'interface-implementations') {
    nextActions.push(
      emptyAction('if you know the interface name', 'analyze_dependencies', { scope: scope.resolvedScope, mode: 'interface-implementations', interfaceName: '<InterfaceName>' }),
      emptyAction('to search for likely interface symbols', 'search_context', { query: scope.query ?? scope.raw }),
    );
  } else {
    nextActions.push(emptyAction('to inspect the resolved scope first', 'map_context', { scope: scope.resolvedScope }));
  }

  return {
    reason: 'dependency_mode_scope_mismatch',
    message,
    diagnosticConfidence: 'high',
    nextActions,
    details: { mode, scopeKind: scope.kind },
  };
}

export function dependenciesEmptyDiagnostic(
  ctx: McpToolRuntime,
  scope: ResolvedScope,
  args: Record<string, unknown>,
  mode: string,
  result?: Record<string, unknown>,
): EmptyDiagnostic | undefined {
  if (graphIsEffectivelyEmpty(ctx)) return graphEmptyDiagnostic();
  if (scope.kind === 'unknown') {
    return {
      reason: 'scope_unresolved',
      message: `The scope "${scope.raw}" did not resolve, so dependency analysis could not anchor to imports, exports, packages, or export symbols.`,
      diagnosticConfidence: 'high',
      nextActions: [
        emptyAction('if this is a symbol or path', 'search_context', { query: scope.query ?? scope.raw }),
        emptyAction('to browse package/module scopes', 'map_context', { scope: 'all', view: 'summary' }),
      ],
    };
  }

  if (mode === 'package-boundaries' || mode === 'import-map') {
    const edgesPagination = result?.edgesPagination as { total?: number } | undefined;
    const edgeTotal = typeof edgesPagination?.total === 'number'
      ? edgesPagination.total
      : Array.isArray(result?.edges) ? result.edges.length : 0;
    if (edgeTotal === 0) {
      return {
        reason: 'no_cross_package_edges',
        message: `No cross-package import edges matched ${scopeLabel(scope)}. Intra-package imports are intentionally not reported in package-boundary/import-map mode.`,
        diagnosticConfidence: 'medium',
        nextActions: [
          emptyAction('to include every package boundary', 'analyze_dependencies', { scope: 'all', mode, ...(args.direction ? { direction: args.direction } : {}) }),
          emptyAction('if you need consumers of one concrete module/export', 'analyze_dependencies', { scope: '<module-or-export-symbol-scope>', mode: 'impact' }),
          emptyAction('if you need structure rather than dependencies', 'map_context', { scope: scope.resolvedScope, view: scope.kind === 'domain' ? 'modules' : 'summary' }),
        ],
        details: { direction: args.direction },
      };
    }
  }

  if (mode === 'impact') {
    const downstreamPagination = result?.downstreamPagination as { total?: number } | undefined;
    const upstreamPagination = result?.upstreamPagination as { total?: number } | undefined;
    const downstreamTotal = typeof downstreamPagination?.total === 'number'
      ? downstreamPagination.total
      : Array.isArray(result?.downstream) ? result.downstream.length : 0;
    const upstreamTotal = typeof upstreamPagination?.total === 'number'
      ? upstreamPagination.total
      : Array.isArray(result?.upstream) ? result.upstream.length : 0;
    const exportFiltered = typeof args.exportName === 'string' && args.exportName.length > 0;
    if ((downstreamTotal === 0 && upstreamTotal === 0) || (exportFiltered && downstreamTotal === 0)) {
      return {
        reason: 'no_dependency_edges',
        message: exportFiltered
          ? `No downstream importers matched export "${args.exportName}" for ${scopeLabel(scope)}.`
          : `No upstream or downstream import impact edges matched ${scopeLabel(scope)} within the requested depth.`,
        diagnosticConfidence: 'medium',
        nextActions: [
          emptyAction('to inspect the module/export surface', 'inspect_node', { scope: scope.resolvedScope }),
          emptyAction('to inspect package-level edges instead', 'analyze_dependencies', { scope: 'all', mode: 'package-boundaries' }),
        ],
        details: { downstream: downstreamTotal, upstream: upstreamTotal, exportName: args.exportName, depth: args.depth },
      };
    }
  }

  if (mode === 'interface-implementations') {
    const count = typeof result?.count === 'number' ? result.count : undefined;
    if (count === 0) {
      return {
        reason: 'no_interface_implementations',
        message: `No graph-indexed implementations were found for interface "${result?.interface ?? args.interfaceName ?? scope.raw}".`,
        diagnosticConfidence: 'medium',
        nextActions: [
          emptyAction('to search for similarly named symbols', 'search_context', { query: String(result?.interface ?? args.interfaceName ?? scope.raw) }),
          emptyAction('to inspect the candidate interface/export', 'inspect_node', { scope: scope.resolvedScope }),
        ],
        details: { interfaceName: result?.interface ?? args.interfaceName },
      };
    }
  }

  if (mode === 'callgraph') {
    const calls = Array.isArray(result?.calls) ? result.calls : [];
    if (calls.length === 0) {
      return {
        reason: 'no_callgraph_edges',
        message: `No calls were detected for ${scopeLabel(scope)} in the indexed export-symbol call graph.`,
        diagnosticConfidence: 'medium',
        nextActions: [
          emptyAction('to inspect source/signature details', 'inspect_node', { scope: scope.resolvedScope, includeBody: true }),
          emptyAction('to inspect import impact instead', 'analyze_dependencies', { scope: scope.resolvedScope, mode: 'impact' }),
        ],
        details: { note: result?.note },
      };
    }
  }

  return undefined;
}

export function architectureEmptyDiagnostic(
  ctx: McpToolRuntime,
  scope: ResolvedScope,
  args: Record<string, unknown>,
  mode: string,
  result: Record<string, unknown>,
): EmptyDiagnostic | undefined {
  if (graphIsEffectivelyEmpty(ctx)) return graphEmptyDiagnostic();
  if (scope.kind === 'unknown') {
    return {
      reason: 'scope_unresolved',
      message: `The scope "${scope.raw}" did not resolve, so architecture analysis inspected an empty scope.`,
      diagnosticConfidence: 'high',
      nextActions: [
        emptyAction('if this is a feature/symbol/path', 'search_context', { query: scope.query ?? scope.raw }),
        emptyAction('to browse package/domain scopes', 'map_context', { scope: 'all', view: 'summary' }),
      ],
    };
  }

  if (mode === 'detail' && typeof result.error === 'string') {
    return {
      reason: 'finding_not_found',
      message: result.error,
      diagnosticConfidence: 'high',
      nextActions: [
        emptyAction('to list current finding ids', 'analyze_architecture', {
          scope: refactoringScopeArg(scope),
          ...(args.categories ? { categories: args.categories } : {}),
          ...(args.minConfidence ? { minConfidence: args.minConfidence } : {}),
          limit: args.limit ?? DEFAULT_ARCHITECTURE_LIMIT,
        }),
      ],
      details: {
        detailFindingId: args.detailFindingId ?? args.findingId,
        hint: result.hint,
        sampleFindingIds: result.sampleFindingIds,
      },
    };
  }

  if (mode === 'report' && result.totalFindings === 0) {
    const hasFilters = Array.isArray(args.categories) || typeof args.minConfidence === 'number';
    const nextActions: EmptyDiagnosticAction[] = [
      emptyAction('to inspect the scoped structure first', 'map_context', { scope: scope.resolvedScope, view: scope.kind === 'domain' ? 'modules' : 'summary' }),
    ];
    if (hasFilters) {
      nextActions.push(emptyAction('to retry without category/confidence filters', 'analyze_architecture', { scope: refactoringScopeArg(scope), limit: args.limit ?? DEFAULT_ARCHITECTURE_LIMIT }));
    }
    nextActions.push(
      emptyAction('if the question is dependency/package risk', 'analyze_dependencies', { scope: scope.resolvedScope, mode: scope.kind === 'module' || scope.kind === 'export-symbol' ? 'impact' : 'package-boundaries' }),
      emptyAction('if annotation freshness may hide useful context', 'get_annotation_status', { scope: scope.resolvedScope, view: 'coverage' }),
    );
    return {
      reason: 'no_architecture_findings',
      message: hasFilters
        ? `No architecture findings survived the requested scope/category/confidence filters for ${scopeLabel(scope)}.`
        : `No architecture findings matched ${scopeLabel(scope)} with the current detectors and thresholds.`,
      diagnosticConfidence: 'medium',
      nextActions,
      details: {
        categories: args.categories,
        minConfidence: args.minConfidence,
        totalFindings: result.totalFindings,
        returnedFindings: result.returnedFindings,
      },
    };
  }

  return undefined;
}
