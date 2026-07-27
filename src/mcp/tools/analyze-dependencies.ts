import type { ToolHandler } from '../types.js';
import { resolveScope, parentModuleId } from '../scope/resolve.js';
import type { ResolvedScope } from '../../scope/resolved.js';
import { scopeNavigation } from '../scope/navigation.js';
import { envelope, resultError, nav } from '../response/envelope.js';
import { limitFrom, offsetFrom } from '../response/pagination.js';
import {
  boundedTotal,
  dependenciesEmptyDiagnostic,
  dependencyModeScopeMismatchDiagnostic,
} from '../response/empty-diagnostics.js';
import { analyzeImpact } from '../lib/dependencies/impact.js';
import { analyzeCallgraph } from '../lib/dependencies/callgraph.js';
import { nameMatchGap } from '../lib/dependencies/impact.js';
import { findInterfaceImplementations } from '../lib/dependencies/interfaces.js';
import { analyzePackageBoundaries } from '../lib/dependencies/package-boundaries.js';
import type { Provenance } from '../../response/provenance.js';
import { exportSymbolId } from '../../graph/node-ids.js';

export function defaultDependencyMode(scope: ResolvedScope): string {
  return scope.kind === 'module' || scope.kind === 'export-symbol' ? 'impact' : 'package-boundaries';
}

function impactNameMatchedCallerFollowup(result: unknown): {
  total: number;
  unresolvedCurrentPage: string[];
} | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const analysis = result as {
    nameMatchedCallers?: unknown;
    downstream?: unknown;
  };
  const unresolvedCurrentPage = Array.isArray(analysis.downstream)
    ? analysis.downstream
      .filter((entry): entry is { id: string; provenance: Provenance } =>
        !!entry
        && typeof entry === 'object'
        && (entry as { provenance?: Provenance }).provenance?.basis === 'inferred'
        && typeof (entry as { id?: unknown }).id === 'string')
      .map(entry => entry.id)
    : [];
  const reportedTotal = typeof analysis.nameMatchedCallers === 'number'
    ? analysis.nameMatchedCallers
    : 0;
  const total = Math.max(reportedTotal, unresolvedCurrentPage.length);
  return total > 0 ? { total, unresolvedCurrentPage } : undefined;
}

export const handleAnalyzeDependencies: ToolHandler = (ctx, args) => {
  const scope = resolveScope(ctx, args.scope);
  const mode = (args.mode as string | undefined) ?? defaultDependencyMode(scope);
  const limit = limitFrom(args, 20, 200);
  const offset = offsetFrom(args);
  let result: unknown;
  const navigation = scopeNavigation(scope);
  if (scope.kind === 'unknown') {
    const message = `Could not resolve scope: ${scope.raw}`;
    return envelope(scope, message, resultError(message, {
      resolvedScope: scope.resolvedScope,
      emptyDiagnostic: dependenciesEmptyDiagnostic(ctx, scope, args, mode),
    }), {
      confidence: 'low',
      gaps: [message],
      navigation,
    });
  }

  if (mode === 'interface-implementations') {
    const interfaceName = args.interfaceName as string | undefined
      ?? (scope.kind === 'export-symbol' ? ctx.getState().graph.nodes.get(scope.nodeId!)?.label : undefined)
      ?? scope.query;
    if (!interfaceName) {
      const message = 'interfaceName is required for mode interface-implementations';
      return envelope(scope, message, resultError(message, {
        emptyDiagnostic: dependencyModeScopeMismatchDiagnostic(ctx, scope, mode, message),
      }), {
        confidence: 'low',
        gaps: [message],
        navigation,
      });
    }
    result = findInterfaceImplementations(ctx, { interfaceName, limit, offset });
  } else if (mode === 'callgraph') {
    let nodeId = scope.nodeId;
    if (scope.kind === 'module' && typeof args.exportName === 'string' && nodeId) {
      // Minted, not parsed: the only question left is whether the graph holds it.
      const exportId = exportSymbolId(nodeId, args.exportName);
      nodeId = ctx.getState().graph.nodes.has(exportId) ? exportId : undefined;
    }
    if (!nodeId || !nodeId.startsWith('export:')) {
      const message = 'mode callgraph requires an export-symbol scope, or a module scope with exportName';
      return envelope(scope, message, resultError(message, {
        resolvedScope: scope.resolvedScope,
        emptyDiagnostic: dependencyModeScopeMismatchDiagnostic(ctx, scope, mode, message),
      }), {
        confidence: 'low',
        gaps: [message],
        navigation,
      });
    }
    result = analyzeCallgraph(ctx, { nodeId });
  } else if (mode === 'impact') {
    let nodeId = scope.nodeId;
    let exportName = args.exportName as string | undefined;
    if (scope.kind === 'export-symbol' && nodeId) {
      exportName ??= ctx.getState().graph.nodes.get(nodeId)?.label;
      nodeId = parentModuleId(ctx.getState().graph, nodeId) ?? nodeId;
    }
    if (!nodeId || scope.kind === 'domain' || scope.kind === 'package' || scope.kind === 'all') {
      const message = 'mode impact requires a module or export-symbol scope';
      return envelope(scope, message, resultError(message, {
        resolvedScope: scope.resolvedScope,
        emptyDiagnostic: dependencyModeScopeMismatchDiagnostic(ctx, scope, mode, message),
      }), {
        confidence: 'low',
        gaps: [message],
        navigation,
      });
    }
    result = analyzeImpact(ctx, {
      nodeId,
      exportName,
      maxDepth: args.depth,
      limit,
      offset,
    });
  } else {
    const packageId = scope.kind === 'package' ? scope.packageId : undefined;
    result = analyzePackageBoundaries(ctx, {
      packageId,
      direction: args.direction,
      topN: limit,
      limit,
      offset,
    });
  }

  const error = (result as { error?: string }).error;
  const gaps = error ? [error] : [];
  if (!error && (mode === 'package-boundaries' || mode === 'import-map')) {
    const edgeTotal = boundedTotal(result as Record<string, unknown>, 'edges');
    if (edgeTotal === 0) {
      gaps.push('No cross-package import edges matched this scope/direction. Intra-package imports are intentionally omitted; try scope "all" or a different direction if you expected package-level edges.');
    }
  }
  const emptyDiagnostic = error
    ? undefined
    : dependenciesEmptyDiagnostic(ctx, scope, args, mode, result as Record<string, unknown>);
  if (emptyDiagnostic && !gaps.length) gaps.push(emptyDiagnostic.message);
  navigation.validate.push(nav('inspect_node', { scope: scope.resolvedScope }, 'Inspect the primary node before editing dependency-sensitive code.'));
  if (!error && mode === 'impact') {
    const followup = impactNameMatchedCallerFollowup(result);
    if (followup) {
      if (followup.unresolvedCurrentPage.length > 0) {
        gaps.push(`Impact includes ${followup.total} name-matched unresolved caller(s); inspect or explicitly justify them before treating the caller set as complete.`);
        for (const nodeId of followup.unresolvedCurrentPage) {
          navigation.validate.push(nav(
            'inspect_node',
            { nodeId },
            'Inspect name-matched unresolved caller before treating the impact set as complete.',
          ));
        }
      } else {
        gaps.push(`Impact includes ${followup.total} name-matched unresolved caller(s) not shown on this downstream page; page or narrow the impact result with limit/offset or a tighter export scope before treating the caller set as complete.`);
      }
    }
    // The cap on the name index runs while extracting and leaves no count behind, so whether it bit
    // on this query is unknowable here. Said as a standing gap rather than as a bound with a total
    // the response would have to invent.
    if (typeof args.exportName === 'string' || scope.kind === 'export-symbol') gaps.push(nameMatchGap());
  }
  return envelope(scope, `Analyzed dependencies using mode ${mode}.`, {
    mode,
    analysis: result,
    ...(emptyDiagnostic ? { emptyDiagnostic } : {}),
  }, {
    confidence: error || emptyDiagnostic ? 'low' : 'high',
    gaps,
    navigation,
  });
};
