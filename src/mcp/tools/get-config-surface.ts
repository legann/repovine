import type { ToolHandler } from '../types.js';
import { resolveScope } from '../scope/resolve.js';
import { scopeNavigation } from '../scope/navigation.js';
import { envelope, envelopeError, nav } from '../response/envelope.js';
import { configSurfaceEmptyDiagnostic } from '../response/empty-diagnostics.js';
import { collectConfigSurface } from '../lib/config-surface.js';

export const handleGetConfigSurface: ToolHandler = (ctx, args) => {
  const scope = resolveScope(ctx, args.scope);
  const result = collectConfigSurface(ctx, args);
  if (result.error) {
    return envelopeError(scope, result.error, {
      namePattern: args.namePattern,
    });
  }
  const navigation = scopeNavigation(scope);
  for (const item of result.items.slice(0, 8)) {
    const moduleId = item.moduleId as string | undefined;
    if (moduleId) navigation.deeper.push(nav('inspect_node', { nodeId: moduleId }, 'Inspect code that reads this config/resource binding.'));
  }
  navigation.cross_layer.push(nav('trace_flow', { scope: scope.resolvedScope, include: ['services', 'resources', 'flows'] }, 'Check whether config/resource bindings appear in runtime flow.'));
  const responseResult: Record<string, unknown> = {
    ...result,
    ...(result.total === 0 ? { emptyDiagnostic: configSurfaceEmptyDiagnostic(ctx, scope, args) } : {}),
  };
  return envelope(scope, `Found ${result.total} extracted config/resource surface item(s).`, responseResult, {
    // Envelope confidence answers "did the request resolve", the same question it answers on every
    // other tool. Completeness is a separate fact and it is stated in `gaps`: presence is proven,
    // coverage is not, because source plugins do not guess computed env keys and an aliased or
    // wrapped access can sit outside a plugin's syntax vocabulary.
    confidence: result.total > 0 ? 'high' : 'low',
    gaps: result.total > 0
      ? ['Config-surface coverage is best-effort; computed, aliased, or wrapped config accesses may be omitted.']
      : ['No config/resource surface items matched this scope and filter.'],
    navigation,
  });
};
