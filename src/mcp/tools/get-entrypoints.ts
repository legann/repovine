import type { ToolHandler } from '../types.js';
import { resolveScope } from '../scope/resolve.js';
import { scopeNavigation } from '../scope/navigation.js';
import { envelope, nav } from '../response/envelope.js';
import { entrypointsEmptyDiagnostic } from '../response/empty-diagnostics.js';
import { collectEntrypoints } from '../lib/entrypoints.js';

export const handleGetEntrypoints: ToolHandler = (ctx, args) => {
  const scope = resolveScope(ctx, args.scope);
  const result = collectEntrypoints(ctx, args);
  const navigation = scopeNavigation(scope);
  for (const item of result.items.slice(0, 8)) {
    const moduleId = item.moduleId as string | undefined;
    const serviceId = item.serviceId as string | undefined;
    if (moduleId) navigation.deeper.push(nav('inspect_node', { nodeId: moduleId }, 'Inspect the module that owns this entrypoint.'));
    if (serviceId) navigation.cross_layer.push(nav('trace_flow', { scope: serviceId }, 'Trace runtime flow from this entrypoint service.'));
  }
  const gaps = result.total > 0 ? [] : ['No entrypoints matched this scope/kind/layer filter.'];
  if (result.total === 0 && scope.kind === 'domain') {
    gaps.push('Domain scopes are semantic/path tags, not always runtime boundaries. Try a package/service scope or search_context with the feature plus "handler", "route", or "lambda".');
  }
  const responseResult: Record<string, unknown> = {
    ...result,
    ...(result.total === 0 ? { emptyDiagnostic: entrypointsEmptyDiagnostic(ctx, scope, args) } : {}),
  };
  return envelope(scope, `Found ${result.total} entrypoint(s).`, responseResult, {
    confidence: result.total > 0 ? 'high' : 'low',
    gaps,
    navigation,
  });
};
