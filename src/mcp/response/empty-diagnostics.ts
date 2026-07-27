import type { McpToolRuntime } from '../types.js';
import type { Confidence } from './envelope.js';
import type { ResolvedScope } from '../../scope/resolved.js';
import {
  graphIsEffectivelyEmpty,
  refactoringScopeArg,
  scopeLabel,
} from '../scope/resolve.js';
import { ARCHITECTURE_SCOPE_KINDS, architectureCanScope } from '../../analysis/architecture/scope.js';
import { domainLabelFromId, owningModuleId } from '../../graph/node-ids.js';
import { RUNTIME_TOPOLOGY_SCOPE_KINDS, topologyCanScope } from '../lib/topology.js';
import {
  DEFAULT_ARCHITECTURE_LIMIT,
  DEFAULT_MAP_LIMIT,
  offsetFrom,
} from './pagination.js';
import { searchTokenize } from '../lib/search-index.js';
import { nextCall, type NextCall } from '../../response/next-call.js';

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
  | 'scope_has_no_config_surface'
  | 'scope_has_no_map_context'
  | 'package_has_no_modules'
  | 'offset_out_of_range'
  | 'dependency_mode_scope_mismatch'
  | 'no_cross_package_edges'
  | 'no_dependency_edges'
  | 'no_interface_implementations'
  | 'no_callgraph_edges'
  | 'no_architecture_findings'
  | 'scope_kind_not_analyzable'
  | 'finding_not_found';

/**
 * What to call once the answer came back empty. The same {@link NextCall} the envelope's
 * `navigation` and an obligation's `next` carry — the diagnostic is a different delivery of one
 * form, not a different shape. It had three field names of its own (`when`, `note`, and an absent
 * `reason`) for the one thing all three said: why this call, now.
 */
export type EmptyDiagnosticAction = NextCall;

export type EmptyDiagnostic = {
  reason: EmptyDiagnosticReason;
  message: string;
  confidence: Confidence;
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
    confidence: 'high',
    nextActions: [
      emptyAction('Build or refresh the repository syntax index.', 'refresh_context', {}),
      { reason: 'If refresh still returns an empty graph, check the repovine repo root and scan configuration.' },
    ],
  };
}

export function emptyAction(reason: string, tool: string, args: Record<string, unknown>): EmptyDiagnosticAction {
  return nextCall(tool, args, reason);
}

/**
 * One narrowing that removed rows on the way to an empty answer.
 *
 * "There were rows and a filter took them all" is a different answer from "there were none", and it
 * had six names — `filtered_out`, `kind_filter_empty`, `name_pattern_empty`, `type_filter_excluded`,
 * `weak_token_only_suppressed`, and an unnamed clause inside `no_architecture_findings` — over two
 * implementations. The fact is one triple: what narrowed, how many it saw, how many survived.
 */
export type Narrowing = {
  /** Argument or threshold that removed rows, named as the caller passes it. */
  by: string;
  /** What the caller set it to. Echoed back so the response names the filter, not just its slot. */
  value?: unknown;
  /** How many rows the narrowing saw. Absent when the site keeps no count — said, not invented. */
  before?: number;
  /** How many survived it. */
  after: number;
  /** The number the narrowing compared against, when it is numeric. */
  threshold?: number;
  /** The argument value that widens it back. */
  restoreWith?: { arg: string; value: unknown };
};

/**
 * The answer when a narrowing emptied a non-empty set. One reason and one place the counts live;
 * the sentence stays the asking tool's, because what was narrowed reads differently per tool.
 * `confidence` follows the evidence: `high` when a count proves rows existed, `medium` when the
 * narrowing kept none and existence is known only from the tool's own branch.
 */
export function filteredOutDiagnostic(
  message: string,
  narrowings: Narrowing[],
  nextActions: EmptyDiagnosticAction[],
  details: Record<string, unknown> = {},
): EmptyDiagnostic {
  return {
    reason: 'filtered_out',
    message,
    confidence: narrowings.some(n => typeof n.before === 'number') ? 'high' : 'medium',
    nextActions,
    details: { ...details, narrowings },
  };
}

/** The generic sentence: how many there were, what narrowed, and that nothing survived. */
export function narrowedAwayMessage(scope: ResolvedScope, noun: string, narrowings: Narrowing[]): string {
  const named = narrowings.map(n => n.by).join(', ');
  const counted = narrowings.find(n => typeof n.before === 'number');
  const existed = counted
    ? `${counted.before} ${noun}(s) exist in ${scopeLabel(scope)}`
    : `${noun}s exist in ${scopeLabel(scope)}`;
  return `${existed}, but the requested ${named} removed all of them.`;
}

/**
 * The empty fact, turned into envelope fields once.
 *
 * A handler used to answer "is this answer empty" up to three times — once to build the diagnostic,
 * once to grade `confidence`, once to word a gap — and the three did not always agree: `trace_flow`
 * read a paged slice for the diagnostic and the unpaged list for `confidence`, and four tools wrote
 * a gap sentence beside a diagnostic message that said the same thing in different words.
 *
 * `whenPresent` is the confidence a non-empty answer carries; it differs by tool because some answer
 * from heuristics. Empty is always `low` — the request did not resolve to anything, which is what
 * that field grades.
 */
export function emptyOutcome(
  diagnostic: EmptyDiagnostic | undefined,
  whenPresent: Confidence = 'high',
): { confidence: Confidence; gaps: string[] } {
  return diagnostic
    ? { confidence: 'low', gaps: [diagnostic.message] }
    : { confidence: whenPresent, gaps: [] };
}

/** Nothing was indexed at all, so no narrower answer exists to look for. Checked before every other branch. */
export function graphEmptyIf(ctx: McpToolRuntime): EmptyDiagnostic | undefined {
  return graphIsEffectivelyEmpty(ctx) ? graphEmptyDiagnostic() : undefined;
}

/** The scope string named nothing the graph knows by any of its addressing forms. */
export const SCOPE_MATCHED_NOTHING =
  'did not resolve to a graph node, package, domain, template, runtime resource, or query scope.';

/**
 * The two answers a scoped diagnostic owes before it reads its own data: the graph holds nothing at
 * all, or the scope named nothing in it. Both were written out once per builder — eight identical
 * graph-empty guards and eight `scope_unresolved` bodies whose message tail was the only real
 * difference, two of them byte-identical down to a stray indent.
 *
 * Returns undefined when the scope resolved against a non-empty graph, which is where the caller's
 * own branches begin.
 */
export function unresolvedScopeDiagnostic(
  ctx: McpToolRuntime,
  scope: ResolvedScope,
  tail: string,
  nextActions: EmptyDiagnosticAction[],
): EmptyDiagnostic | undefined {
  return graphEmptyIf(ctx)
    ?? (scope.kind === 'unknown' ? scopeUnresolvedDiagnostic(scope, tail, nextActions) : undefined);
}

/**
 * The body itself, for the one caller whose bar is higher than a resolved scope kind: `inspect_node`
 * answers about a single node, so a query or repository scope is unresolved for it even though the
 * tools that take a set resolve it fine.
 */
export function scopeUnresolvedDiagnostic(
  scope: ResolvedScope,
  tail: string,
  nextActions: EmptyDiagnosticAction[],
): EmptyDiagnostic {
  return {
    reason: 'scope_unresolved',
    message: `The scope "${scope.raw}" ${tail}`,
    confidence: 'high',
    nextActions,
  };
}

/** The recovery every unresolved scope offers first: hand the raw text to search. */
export function searchForScopeText(scope: ResolvedScope, reason: string): EmptyDiagnosticAction {
  return emptyAction(reason, 'search_context', { query: scope.query ?? scope.raw });
}

export function entrypointsEmptyDiagnostic(
  ctx: McpToolRuntime,
  scope: ResolvedScope,
  args: Record<string, unknown>,
): EmptyDiagnostic {
  const unresolved = unresolvedScopeDiagnostic(ctx, scope, SCOPE_MATCHED_NOTHING, [
    searchForScopeText(scope, 'if you have a symbol or path'),
    emptyAction('if you need repository-level entrypoints', 'get_entrypoints', { scope: 'all' }),
  ]);
  if (unresolved) return unresolved;

  const hasKindFilter =
    (typeof args.kind === 'string' && args.kind !== 'all')
    || (Array.isArray(args.kinds) && !args.kinds.includes('all'));
  const hasLayerFilter = typeof args.layer === 'string' && args.layer !== 'all';
  if (hasKindFilter || hasLayerFilter) {
    const before = collectEntrypoints(ctx, { scope: scope.resolvedScope, limit: 1 }).total;
    if (before > 0) {
      const narrowings: Narrowing[] = [];
      if (hasKindFilter) {
        const arg = Array.isArray(args.kinds) ? 'kinds' : 'kind';
        narrowings.push({ by: arg, value: args[arg], before, after: 0, restoreWith: { arg, value: 'all' } });
      }
      if (hasLayerFilter) {
        narrowings.push({ by: 'layer', value: args.layer, before, after: 0, restoreWith: { arg: 'layer', value: 'all' } });
      }
      return filteredOutDiagnostic(narrowedAwayMessage(scope, 'entrypoint', narrowings), narrowings, [
        emptyAction('to inspect unfiltered execution starts', 'get_entrypoints', { scope: scope.resolvedScope }),
      ]);
    }
  }

  if (scope.kind === 'domain') {
    const label = domainLabelFromId(scope.domainId ?? scope.raw);
    return {
      reason: 'semantic_domain_not_runtime_boundary',
      message: `${scope.resolvedScope} is a semantic/path tag. Entrypoints are owned by handler modules, pages, packages, or runtime resources, not by the domain tag itself.`,
      confidence: 'high',
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
      confidence: 'medium',
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
      confidence: 'medium',
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
      confidence: 'medium',
      nextActions: [
        emptyAction('to find graph anchors first', 'search_context', { query: scope.query ?? scope.raw }),
        emptyAction('to inspect all known execution starts', 'get_entrypoints', { scope: 'all' }),
      ],
    };
  }

  return {
    reason: 'no_entrypoints_indexed',
    message: `No detected execution starts matched ${scopeLabel(scope)}.`,
    confidence: 'medium',
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
  const unresolved = unresolvedScopeDiagnostic(ctx, scope, 'did not resolve, so runtime topology cannot be traced for it.', [
    searchForScopeText(scope, 'if you have a symbol or runtime name'),
  ]);
  if (unresolved) return unresolved;
  // A scope kind the projection cannot narrow by returns nothing because it was never asked, not
  // because the repository has no runtime topology.
  if (!topologyCanScope(scope.kind)) {
    const owner = scope.nodeId ? owningModuleId(scope.nodeId) : undefined;
    const nextActions: EmptyDiagnosticAction[] = [];
    if (owner) nextActions.push(emptyAction('to trace the module the symbol lives in', 'trace_flow', { scope: owner }));
    if (scope.nodeId) nextActions.push(emptyAction('to inspect this node itself', 'inspect_node', { nodeId: scope.nodeId }));
    nextActions.push(emptyAction('to see runtime topology repository-wide', 'trace_flow', { scope: 'all' }));
    return {
      reason: 'scope_kind_not_analyzable',
      message: `Runtime topology is not narrowed by "${scope.kind}" scopes. Services, resources and flows are reached from a runtime resource, a module, a package, a domain, or a query.`,
      confidence: 'high',
      nextActions,
      details: { scopeKind: scope.kind, supportedScopeKinds: [...RUNTIME_TOPOLOGY_SCOPE_KINDS], ...counts },
    };
  }
  if (scope.kind === 'domain') {
    const label = domainLabelFromId(scope.domainId ?? scope.raw);
    return {
      reason: 'semantic_domain_not_runtime_boundary',
      message: `${scope.resolvedScope} is a semantic/path tag. Runtime flow is graph-proven through services/resources/entrypoints, which may live outside that domain tag.`,
      confidence: 'high',
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
      confidence: 'medium',
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
    confidence: 'medium',
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
  const empty = graphEmptyIf(ctx);
  if (empty) return empty;
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
    return filteredOutDiagnostic(
      'Only weak/common tokens had matches after auto-relaxation, so search_context suppressed them instead of surfacing noisy results.',
      [{ by: 'match', value: 'auto', after: 0, restoreWith: { arg: 'match', value: 'or' } }],
      [
        emptyAction('if you want weak-token matches anyway', 'search_context', { query, match: 'or' }),
        emptyAction('if you know a stronger symbol/path', 'search_context', { query: '<symbol-or-path>' }),
      ],
      { tokens, hitTokens },
    );
  }
  if (hitTokens.length === 0) {
    return {
      reason: 'no_token_hits',
      message: 'None of the query tokens matched the repository search index.',
      confidence: 'high',
      nextActions: [
        emptyAction('if you have a path/package/domain alias', 'map_context', { scope: query }),
        emptyAction('to browse from the repository root', 'map_context', { scope: 'all', view: 'summary' }),
      ],
      details: { tokens },
    };
  }
  if (rawTypes?.length) {
    return filteredOutDiagnostic(
      'Some query tokens matched the index, but no results survived the requested type filter.',
      [{ by: 'types', value: rawTypes, after: 0, restoreWith: { arg: 'types', value: [] } }],
      [emptyAction('to retry without type filtering', 'search_context', { query })],
      { tokens, hitTokens, types: rawTypes },
    );
  }
  return {
    reason: 'strict_and_no_single_node',
    message: 'Query tokens matched the index, but no single graph node matched the requested token combination.',
    confidence: 'medium',
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
  const unresolved = unresolvedScopeDiagnostic(ctx, scope, 'did not resolve, so config/resource bindings cannot be inspected for it.', [
    emptyAction('if you have a config/resource name', 'get_config_surface', { scope: 'all', namePattern: scope.query ?? scope.raw }),
    searchForScopeText(scope, 'if you have a symbol/path'),
  ]);
  if (unresolved) return unresolved;

  const hasKindFilter =
    (typeof args.kind === 'string' && args.kind !== 'all')
    || (Array.isArray(args.kinds) && !args.kinds.includes('all'));
  const hasNamePattern = typeof args.namePattern === 'string' && args.namePattern.trim().length > 0;
  if (hasKindFilter || hasNamePattern) {
    const before = collectConfigSurface(ctx, { scope: scope.resolvedScope, limit: 1 }).total;
    if (before > 0) {
      const narrowings: Narrowing[] = [];
      if (hasKindFilter) {
        const arg = Array.isArray(args.kinds) ? 'kinds' : 'kind';
        narrowings.push({ by: arg, value: args[arg], before, after: 0, restoreWith: { arg, value: 'all' } });
      }
      if (hasNamePattern) {
        narrowings.push({ by: 'namePattern', value: args.namePattern, before, after: 0, restoreWith: { arg: 'namePattern', value: '' } });
      }
      return filteredOutDiagnostic(narrowedAwayMessage(scope, 'config/resource surface item', narrowings), narrowings, [
        emptyAction('to inspect unfiltered config/resource surface', 'get_config_surface', { scope: scope.resolvedScope }),
      ]);
    }
  }

  return {
    reason: 'scope_has_no_config_surface',
    message: `No env vars, public config, secrets, resources, or resource bindings matched ${scopeLabel(scope)}.`,
    confidence: 'medium',
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
  const unresolved = unresolvedScopeDiagnostic(ctx, scope, SCOPE_MATCHED_NOTHING, [
    searchForScopeText(scope, 'if this is a symbol, file, route, config, or feature name'),
    emptyAction('to browse from the repository root', 'map_context', { scope: 'all', view: 'summary' }),
  ]);
  if (unresolved) return unresolved;

  // `truncation` is present only when a bound bit, so a complete page carries its own total: the
  // page IS the whole list. Reading both apart tells "the scope is empty" from "this page is".
  const focus = result?.focus as {
    drillDown?: unknown;
    topChildren?: unknown;
    truncation?: { children?: { total?: unknown } };
  } | undefined;
  const childShown = Array.isArray(focus?.topChildren)
    ? focus.topChildren.length
    : Array.isArray(focus?.drillDown)
      ? focus.drillDown.length
      : undefined;
  const childTotal = typeof focus?.truncation?.children?.total === 'number'
    ? focus.truncation.children.total
    : childShown;
  const packagesShown = Array.isArray(result?.packages) ? result.packages.length : undefined;
  const packageTotal = typeof result?.packageTotal === 'number' ? result.packageTotal : packagesShown;
  const total = packageTotal ?? childTotal;
  const returned = packagesShown ?? childShown;
  const offset = offsetFrom(args);
  if (typeof total === 'number' && total > 0 && returned === 0 && offset > 0) {
    return {
      reason: 'offset_out_of_range',
      message: `The scope has ${total} item(s), but offset ${offset} is outside the available page range.`,
      confidence: 'high',
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
      const label = domainLabelFromId(scope.domainId ?? scope.raw);
      return {
        reason: 'scope_has_no_map_context',
        message: `${scope.resolvedScope} exists as a domain tag, but no modules are currently tagged into that scope.`,
        confidence: 'medium',
        nextActions: [
          emptyAction('to find similarly named anchors', 'search_context', { query: label }),
          emptyAction('to browse repository packages/domains', 'map_context', { scope: 'all', view: 'summary' }),
        ],
        details: { moduleCount },
      };
    }
  }

  if (scope.kind === 'package') {
    if (childTotal === 0) {
      return {
        reason: 'package_has_no_modules',
        message: `${scope.resolvedScope} resolved as a package, but it has no module children in the current graph.`,
        confidence: 'medium',
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

/**
 * How many entries a bounded list has in total.
 *
 * `truncation` is present only when a bound bit, so a list without one is complete and its own
 * length is the total. Reading it this way keeps "the scope has nothing" apart from "this page has
 * nothing", which is the difference these diagnostics exist to state.
 */
export function boundedTotal(result: Record<string, unknown> | undefined, key: string): number {
  const bound = (result?.truncation as Record<string, { total?: unknown }> | undefined)?.[key];
  if (typeof bound?.total === 'number') return bound.total;
  const list = result?.[key];
  return Array.isArray(list) ? list.length : 0;
}

export function dependencyModeScopeMismatchDiagnostic(
  ctx: McpToolRuntime,
  scope: ResolvedScope,
  mode: string,
  message: string,
): EmptyDiagnostic {
  const unresolved = unresolvedScopeDiagnostic(ctx, scope, 'did not resolve, so dependency analysis cannot choose the correct module/package/export-symbol boundary.', [
    searchForScopeText(scope, 'if this is a symbol or path'),
    emptyAction('to browse package/module scopes', 'map_context', { scope: 'all', view: 'summary' }),
  ]);
  if (unresolved) return unresolved;

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
    confidence: 'high',
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
  const unresolved = unresolvedScopeDiagnostic(ctx, scope, 'did not resolve, so dependency analysis could not anchor to imports, exports, packages, or export symbols.', [
    searchForScopeText(scope, 'if this is a symbol or path'),
    emptyAction('to browse package/module scopes', 'map_context', { scope: 'all', view: 'summary' }),
  ]);
  if (unresolved) return unresolved;

  if (mode === 'package-boundaries' || mode === 'import-map') {
    const edgeTotal = boundedTotal(result, 'edges');
    if (edgeTotal === 0) {
      return {
        reason: 'no_cross_package_edges',
        message: `No cross-package import edges matched ${scopeLabel(scope)}. Intra-package imports are intentionally not reported in package-boundary/import-map mode.`,
        confidence: 'medium',
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
    const downstreamTotal = boundedTotal(result, 'downstream');
    const upstreamTotal = boundedTotal(result, 'upstream');
    const exportFiltered = typeof args.exportName === 'string' && args.exportName.length > 0;
    if ((downstreamTotal === 0 && upstreamTotal === 0) || (exportFiltered && downstreamTotal === 0)) {
      return {
        reason: 'no_dependency_edges',
        message: exportFiltered
          ? `No downstream importers matched export "${args.exportName}" for ${scopeLabel(scope)}.`
          : `No upstream or downstream import impact edges matched ${scopeLabel(scope)} within the requested depth.`,
        confidence: 'medium',
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
        confidence: 'medium',
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
        confidence: 'medium',
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
  const unresolved = unresolvedScopeDiagnostic(ctx, scope, 'did not resolve, so architecture analysis inspected an empty scope.', [
    searchForScopeText(scope, 'if this is a feature/symbol/path'),
    emptyAction('to browse package/domain scopes', 'map_context', { scope: 'all', view: 'summary' }),
  ]);
  if (unresolved) return unresolved;

  // Before the empty-report branch: a scope kind the detectors do not read produced no finding list
  // to be empty. Saying "no findings" here would report a scope that was never inspected as clean.
  if (!architectureCanScope(scope.kind)) {
    const owner = scope.nodeId ? owningModuleId(scope.nodeId) : undefined;
    const nextActions: EmptyDiagnosticAction[] = [];
    if (owner) {
      nextActions.push(emptyAction('to analyse the module the symbol lives in', 'analyze_architecture', { scope: owner }));
    }
    if (scope.nodeId) {
      nextActions.push(emptyAction('to inspect this node itself', 'inspect_node', { nodeId: scope.nodeId }));
    } else {
      nextActions.push(emptyAction('to find an analysable anchor', 'search_context', { query: scope.query ?? scope.raw }));
    }
    nextActions.push(emptyAction('to analyse a package or domain around it', 'map_context', { scope: 'all', view: 'summary' }));
    return {
      reason: 'scope_kind_not_analyzable',
      message: `Architecture analysis does not inspect "${scope.kind}" scopes. Detectors read modules, runtime resources and domains.`,
      confidence: 'high',
      nextActions,
      details: { scopeKind: scope.kind, supportedScopeKinds: [...ARCHITECTURE_SCOPE_KINDS] },
    };
  }

  if (mode === 'detail' && typeof result.error === 'string') {
    return {
      reason: 'finding_not_found',
      message: result.error,
      confidence: 'high',
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
    // `minConfidence` defaults to 0.5 and applies whether or not the caller passed it, so a report
    // the default threshold emptied used to read as "the detectors found nothing". The count the
    // detectors produced decides which of the two answers this is.
    const detected = typeof result.detectedFindings === 'number' ? result.detectedFindings : undefined;
    const narrowings: Narrowing[] = [];
    if (Array.isArray(args.categories)) {
      narrowings.push({ by: 'categories', value: args.categories, before: detected, after: 0, restoreWith: { arg: 'categories', value: [] } });
    }
    if (typeof result.minConfidence === 'number') {
      narrowings.push({
        by: 'minConfidence',
        value: result.minConfidence,
        before: detected,
        after: 0,
        threshold: result.minConfidence,
        restoreWith: { arg: 'minConfidence', value: 0 },
      });
    }
    const nextActions: EmptyDiagnosticAction[] = [
      emptyAction('to inspect the scoped structure first', 'map_context', { scope: scope.resolvedScope, view: scope.kind === 'domain' ? 'modules' : 'summary' }),
    ];
    if (narrowings.length > 0) {
      nextActions.push(emptyAction('to retry without category/confidence filters', 'analyze_architecture', { scope: refactoringScopeArg(scope), minConfidence: 0, limit: args.limit ?? DEFAULT_ARCHITECTURE_LIMIT }));
    }
    nextActions.push(
      emptyAction('if the question is dependency/package risk', 'analyze_dependencies', { scope: scope.resolvedScope, mode: scope.kind === 'module' || scope.kind === 'export-symbol' ? 'impact' : 'package-boundaries' }),
      emptyAction('if annotation freshness may hide useful context', 'get_annotation_status', { scope: scope.resolvedScope, view: 'coverage' }),
    );
    const detail = {
      categories: args.categories,
      minConfidence: result.minConfidence,
      detectedFindings: detected,
      totalFindings: result.totalFindings,
      returnedFindings: result.returnedFindings,
    };
    if (detected !== undefined && detected > 0) {
      return filteredOutDiagnostic(
        narrowedAwayMessage(scope, 'architecture finding', narrowings),
        narrowings,
        nextActions,
        detail,
      );
    }
    return {
      reason: 'no_architecture_findings',
      message: `No architecture findings matched ${scopeLabel(scope)} with the current detectors and thresholds.`,
      confidence: 'medium',
      nextActions,
      details: detail,
    };
  }

  return undefined;
}
