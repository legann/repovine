import type { ToolHandler } from '../types.js';
import { resolveScope } from '../scope/resolve.js';
import { scopeNavigation } from '../scope/navigation.js';
import { envelope, envelopeError, nav } from '../response/envelope.js';
import { configSurfaceEmptyDiagnostic, emptyOutcome } from '../response/empty-diagnostics.js';
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
  navigation.crossLayer.push(nav('trace_flow', { scope: scope.resolvedScope, include: ['services', 'resources', 'flows'] }, 'Check whether config/resource bindings appear in runtime flow.'));
  const emptyDiagnostic = result.total === 0 ? configSurfaceEmptyDiagnostic(ctx, scope, args) : undefined;
  // Envelope confidence answers "did the request resolve", the same question it answers on every
  // other tool. Completeness is a separate fact and it is stated in `gaps`: presence is proven,
  // coverage is not, because source plugins do not guess computed env keys and an aliased or
  // wrapped access can sit outside a plugin's syntax vocabulary.
  const outcome = emptyOutcome(emptyDiagnostic);
  return envelope(scope, `Found ${result.total} extracted config/resource surface item(s).`, {
    ...result,
    ...(emptyDiagnostic ? { emptyDiagnostic } : {}),
  }, {
    confidence: outcome.confidence,
    gaps: emptyDiagnostic
      ? outcome.gaps
      : ['Config-surface coverage is best-effort; computed, aliased, or wrapped config accesses may be omitted.'],
    navigation,
  });
};
