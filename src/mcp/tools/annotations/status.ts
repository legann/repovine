import type { ToolHandler } from '../../types.js';
import type { ResolvedScope } from '../../scope/resolve.js';
import { resolveScope, stripDomainPrefix } from '../../scope/resolve.js';
import { scopeNavigation } from '../../scope/navigation.js';
import { envelope, nav } from '../../response/envelope.js';
import { limitFrom, offsetFrom, DEFAULT_SEMANTIC_LIMIT } from '../../response/pagination.js';
import {
  getAnnotationQueue,
  getAnnotationsStats,
  getCarrierGapStatus,
  getOrphanedAnnotations,
  getPropagationSlice,
  getRiskScopeCandidateStatus,
} from '../../lib/annotations.js';

export function domainLabelForQueue(scope: ResolvedScope): string | undefined {
  if (scope.kind !== 'domain') return undefined;
  return stripDomainPrefix(scope.resolvedScope);
}

export const handleGetAnnotationStatus: ToolHandler = (ctx, args) => {
  const scope = resolveScope(ctx, args.scope);
  const view = (args.view as string | undefined) ?? 'coverage';
  const limit = limitFrom(args, DEFAULT_SEMANTIC_LIMIT, 100);
  const offset = offsetFrom(args);
  const result: Record<string, unknown> = {};

  const scopeDomain = domainLabelForQueue(scope);
  if (view === 'coverage' || view === 'all') {
    result.coverage = getAnnotationsStats(ctx, {
      includeAllDomains: args.includeAllDomains,
      includeLightweight: args.includeLightweight,
      limit,
      offset,
      ...(scopeDomain ? { scopeDomain } : {}),
      ...(Array.isArray(args.domainsFilter) ? { domainsFilter: args.domainsFilter } : {}),
      ...(scopeDomain && !Array.isArray(args.domainsFilter)
        ? { domainsFilter: [scopeDomain] }
        : {}),
    });
  }
  if (view === 'queue' || view === 'all') {
    result.queue = getAnnotationQueue(ctx, {
      domain: scopeDomain,
      limit,
      offset,
      staleKind: args.staleKind,
    });
  }
  if (view === 'derived-review') {
    result.derivedReview = getAnnotationQueue(ctx, {
      domain: scopeDomain,
      limit,
      offset,
      derivedOnly: true,
    });
  }
  if (view === 'propagation-preview') {
    const from = args.from as string | undefined;
    if (!from) {
      return { error: 'view propagation-preview requires from (module node id).' };
    }
    result.propagationPreview = getPropagationSlice(ctx, {
      from,
      includeDomains: args.includeDomains,
    });
  }
  if (view === 'orphans' || view === 'all') {
    result.orphans = getOrphanedAnnotations(ctx, { nodeType: 'all', limit, offset });
  }
  if (view === 'risk-scope-candidates') {
    const scopeHints = typeof args.scope === 'string' ? [args.scope] : undefined;
    result.riskScopeCandidates = getRiskScopeCandidateStatus(ctx, {
      limit,
      offset,
      ...(scopeHints ? { scopeHints } : {}),
    });
  }
  if (view === 'carrier-gaps') {
    const scopeHints = typeof args.scope === 'string' ? [args.scope] : undefined;
    result.carrierGaps = getCarrierGapStatus(ctx, {
      limit,
      offset,
      ...(scopeHints ? { scopeHints } : {}),
    });
  }

  const navigation = scopeNavigation(scope);
  navigation.validate.push(nav('refresh_context', {}, 'Refresh the graph before trusting stale/orphan signals after code changes.'));
  return envelope(scope, `Computed annotation status view ${view}.`, result, {
    confidence: 'high',
    navigation,
  });
};
