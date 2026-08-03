import type { ToolHandler } from '../types.js';
import { resolveScope } from '../scope/resolve.js';
import { scopeNavigation } from '../scope/navigation.js';
import { envelope, nav } from '../response/envelope.js';
import { emptyOutcome, entrypointsEmptyDiagnostic } from '../response/empty-diagnostics.js';
import { collectEntrypoints } from '../lib/entrypoints.js';

export const handleGetEntrypoints: ToolHandler = (ctx, args) => {
  const scope = resolveScope(ctx, args.scope);
  const result = collectEntrypoints(ctx, args);
  const navigation = scopeNavigation(scope);
  for (const item of result.items.slice(0, 8)) {
    const moduleId = item.moduleId as string | undefined;
    const serviceId = item.serviceId as string | undefined;
    if (moduleId) navigation.deeper.push(nav('inspect_node', { nodeId: moduleId }, 'Inspect the module that owns this entrypoint.'));
    if (serviceId) navigation.crossLayer.push(nav('trace_flow', { scope: serviceId }, 'Trace runtime flow from this entrypoint service.'));
  }
  // One reading of "empty", and the gap is the diagnostic's own sentence: the prose that used to sit
  // beside it said "kind/layer filter" whether or not one was passed.
  const emptyDiagnostic = result.total === 0 ? entrypointsEmptyDiagnostic(ctx, scope, args) : undefined;
  const outcome = emptyOutcome(emptyDiagnostic);
  return envelope(scope, `Found ${result.total} entrypoint(s).`, {
    ...result,
    ...(emptyDiagnostic ? { emptyDiagnostic } : {}),
  }, {
    confidence: outcome.confidence,
    gaps: outcome.gaps,
    navigation,
  });
};
