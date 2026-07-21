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
  if (servicesRaw.length === 0 && dataFlowsRaw.length === 0 && scope.kind === 'domain') {
    gaps.push('Domain scopes are semantic/path tags, not always runtime boundaries. Try a package/service scope or search_context with the feature plus "handler", "route", or "lambda".');
  }
  const emptyTraceResult =
    (include.includes('services') ? services.length === 0 : true)
    && (include.includes('resources') ? resources.length === 0 : true)
    && (include.includes('flows') ? dataFlows.length === 0 : true)
    && (include.includes('entrypoints') ? entrypoints.length === 0 : true);
  if (emptyTraceResult) {
    result.emptyDiagnostic = traceFlowEmptyDiagnostic(ctx, scope, args, {
      services: services.length,
      resources: resources.length,
      dataFlows: dataFlows.length,
      entrypoints: entrypoints.length,
    });
  }
  return envelope(scope, `Traced runtime/system topology for ${scope.resolvedScope}.`, result, {
    confidence: servicesRaw.length > 0 || dataFlowsRaw.length > 0 ? 'medium' : 'low',
    gaps,
    navigation,
  });
};
