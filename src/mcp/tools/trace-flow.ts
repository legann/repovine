import type { ToolHandler } from '../types.js';
import { resolveScope, nodeInScope } from '../scope/resolve.js';
import { scopeNavigation } from '../scope/navigation.js';
import { envelope, nav } from '../response/envelope.js';
import { limitFrom, offsetFrom, DEFAULT_LIST_LIMIT } from '../response/pagination.js';
import { traceFlowEmptyDiagnostic } from '../response/empty-diagnostics.js';
import { projectRuntimeTopology } from '../lib/topology.js';
import { collectEntrypoints } from '../lib/entrypoints.js';
import { computeRuntimeHandoff } from '../lib/runtime-handoff.js';

const RUNTIME_HANDOFF_TRUNCATED_GAP =
  'Runtime handoff list truncated - inspect listed handler modules first; paginate trace_flow or inspect remaining resources individually.';

const UNRESOLVED_REF_REASON_TEXT: Record<string, string> = {
  ambiguous: 'several resources carry that logical id and the declaring document does not single one out',
  'out-of-scope': 'the matching resources sit outside the reference\'s own namespace',
};

/**
 * Disclose where a data-flow listing is a producer×consumer product rather than a list of routes.
 * A resource with several producers and several consumers yields every pairing; without saying so,
 * the count reads as evidence of that many distinct flows.
 */
function dataFlowProductGaps(dataFlows: Array<Record<string, unknown>>): string[] {
  const byResource = new Map<string, { from: Set<string>; to: Set<string> }>();
  for (const flow of dataFlows) {
    const through = typeof flow.through === 'string' ? flow.through : undefined;
    if (!through) continue;
    let entry = byResource.get(through);
    if (!entry) { entry = { from: new Set(), to: new Set() }; byResource.set(through, entry); }
    if (typeof flow.from === 'string') entry.from.add(flow.from);
    if (typeof flow.to === 'string') entry.to.add(flow.to);
  }

  const out: string[] = [];
  for (const [through, { from, to }] of byResource) {
    if (from.size < 2 || to.size < 2) continue;
    out.push(
      `Data flows through ${through} are the ${from.size}x${to.size} producer-consumer product, not ${from.size * to.size} observed routes:`
      + ' each pair is a static possibility through a shared resource. Read publishes/consumes on the participants for what is proven.',
    );
  }
  return out;
}

/**
 * One gap line per reference the graph refused to bind. A missing edge is otherwise
 * indistinguishable from an absent reference, which is what makes an unbound id look resolved.
 */
function unresolvedRefGaps(services: Array<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const service of services) {
    const refs = service.unresolvedRefs;
    if (!Array.isArray(refs)) continue;
    for (const ref of refs as Array<{ logicalId?: string; reason?: string; candidates?: string[] }>) {
      const reason = UNRESOLVED_REF_REASON_TEXT[ref.reason ?? ''] ?? 'the reference could not be scoped';
      out.push(
        `${service.label ?? service.id} references "${ref.logicalId}" but no edge was emitted: ${reason}`
        + ` (candidates: ${(ref.candidates ?? []).join(', ') || 'none'}).`,
      );
    }
  }
  return out;
}

export const handleTraceFlow: ToolHandler = (ctx, args) => {
  const scope = resolveScope(ctx, args.scope ?? args.from ?? 'all');
  const include = Array.isArray(args.include) ? args.include as string[] : ['services', 'resources', 'flows'];
  const topologyScope = scope.kind === 'query' || scope.kind === 'export-symbol'
    ? 'all'
    : scope.resolvedScope;
  const raw = projectRuntimeTopology(ctx, {
    scope: topologyScope,
    includeResources: include.includes('resources'),
    includeApiRoutes: include.includes('entrypoints'),
  }) as Record<string, unknown>;

  const limit = limitFrom(args, DEFAULT_LIST_LIMIT);
  const offset = offsetFrom(args);
  const servicesRaw = Array.isArray(raw.services) ? raw.services as Array<Record<string, unknown>> : [];
  const hullAwareScope = scope.kind === 'runtime-resource' || scope.kind === 'module';
  const servicesInScope = servicesRaw.filter(s => {
    if (hullAwareScope) return true;
    const id = s.id as string | undefined;
    return !id || scope.kind === 'all' || nodeInScope(ctx, id, scope);
  });
  const services = servicesInScope.slice(offset, offset + limit);
  const resourcesRaw = Array.isArray(raw.resources) ? raw.resources as Array<Record<string, unknown>> : [];
  const resources = resourcesRaw.slice(offset, offset + limit);
  const dataFlowsRaw = Array.isArray(raw.dataFlows) ? raw.dataFlows as Array<Record<string, unknown>> : [];
  const dataFlows = dataFlowsRaw.slice(offset, offset + limit);
  const handoff = computeRuntimeHandoff(ctx, {
    scope,
    serviceIds: services.map(s => s.id).filter((id): id is string => typeof id === 'string'),
  });
  const entrypoints = include.includes('entrypoints')
    ? collectEntrypoints(ctx, { scope: scope.resolvedScope, limit }).items
    : [];
  const result: Record<string, unknown> = {
    scope: raw.scope,
    ...(include.includes('services') ? { services } : {}),
    ...(include.includes('resources') ? { resources } : {}),
    ...(include.includes('flows') ? { dataFlows } : {}),
    ...(include.includes('entrypoints') ? { entrypoints } : {}),
    runtimeHandoff: handoff,
    pagination: {
      servicesTotal: servicesInScope.length,
      servicesReturned: services.length,
      resourcesTotal: resourcesRaw.length,
      resourcesReturned: include.includes('resources') ? resources.length : 0,
      dataFlowsTotal: dataFlowsRaw.length,
      dataFlowsReturned: include.includes('flows') ? dataFlows.length : 0,
      offset,
      truncated:
        (include.includes('services') && offset + services.length < servicesInScope.length)
        || (include.includes('resources') && offset + resources.length < resourcesRaw.length)
        || (include.includes('flows') && offset + dataFlows.length < dataFlowsRaw.length),
    },
  };
  const navigation = scopeNavigation(scope);
  navigation.deeper.unshift(...handoff.items.map(item =>
    nav(
      'inspect_node',
      { nodeId: item.handlerModuleId },
      `Runtime handoff - handler module for ${item.resourceId}; inspect before editing code.`,
    ),
  ));
  const handoffResourceIds = new Set(handoff.items.map(item => item.resourceId));
  for (const s of services.slice(0, 6)) {
    const id = s.id as string | undefined;
    if (id && handoffResourceIds.has(id)) continue;
    if (id) navigation.deeper.push(nav('inspect_node', { nodeId: id }, 'Inspect a runtime service/resource participating in this flow.'));
  }
  const gaps = dataFlowsRaw.length > 0 ? [] : ['No concrete producer-resource-consumer data flow was found in this scope.'];
  if (handoff.truncated) gaps.push(RUNTIME_HANDOFF_TRUNCATED_GAP);
  gaps.push(...unresolvedRefGaps(services));
  gaps.push(...dataFlowProductGaps(dataFlowsRaw));
  if (servicesRaw.length === 0 && dataFlowsRaw.length === 0 && scope.kind === 'domain') {
    gaps.push('Domain scopes are semantic/path tags, not always runtime boundaries. Try a package/service scope or search_context with the feature plus "handler", "route", or "lambda".');
  }
  const emptyTraceResult =
    (include.includes('services') ? services.length === 0 : true)
    && (include.includes('resources') ? resources.length === 0 : true)
    && (include.includes('flows') ? dataFlows.length === 0 : true)
    && (include.includes('entrypoints') ? entrypoints.length === 0 : true);
  const emptyDiagnostic = emptyTraceResult
    ? traceFlowEmptyDiagnostic(ctx, scope, args, {
      services: services.length,
      resources: resources.length,
      dataFlows: dataFlows.length,
      entrypoints: entrypoints.length,
    })
    : undefined;
  const payload = emptyDiagnostic ? { ...result, emptyDiagnostic } : result;
  return envelope(scope, `Traced runtime/system topology for ${scope.resolvedScope}.`, payload, {
    confidence: servicesRaw.length > 0 || dataFlowsRaw.length > 0 ? 'medium' : 'low',
    gaps,
    navigation,
  });
};
