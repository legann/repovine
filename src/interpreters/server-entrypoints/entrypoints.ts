import type { InterpreterEntrypointContext } from '../../interpreter/types.js';
import {
  LAYER_ENTRYPOINT_SLOT_KEY,
  type SlottedEntrypointFragment,
  stripEntrypointFragmentInternals,
} from '../../stage2/interpreter/entrypoint-slots.js';
import { fileBasedEntryKind, inferFileBasedRoutes } from '../../stage2/routes/file-based.js';

export const SERVER_ENTRYPOINTS_INTERPRETER_ID = 'server-entrypoints';

// Re-exported for back-compat: the slot vocabulary now lives in the neutral entrypoint-slots module.
export { LAYER_ENTRYPOINT_SLOT_KEY, stripEntrypointFragmentInternals };
export type { EntrypointSlot } from '../../stage2/interpreter/entrypoint-slots.js';

export type BackendRoutesEntrypointFragment = SlottedEntrypointFragment;

export function collectBackendRouteEntrypoints(ctx: InterpreterEntrypointContext): BackendRoutesEntrypointFragment[] {
  return [
    ...collectFrameworkApiEntrypoints(ctx),
    ...collectFileApiEntrypoints(ctx),
  ];
}

export function collectFrameworkApiEntrypoints(ctx: InterpreterEntrypointContext): BackendRoutesEntrypointFragment[] {
  const out: BackendRoutesEntrypointFragment[] = [];

  for (const mod of ctx.snapshot.modules) {
    for (const route of mod.semanticHints?.routes ?? []) {
      if ((route.source !== 'decorator' && route.source !== 'ast') || route.kind !== 'api') continue;
      const method = route.method ?? 'GET';
      const webFramework = mod.semanticHints?.webFramework;
      const rendersTemplate = route.rendersTemplate;
      const isServerPage = Array.isArray(rendersTemplate) && rendersTemplate.length > 0;
      out.push({
        [LAYER_ENTRYPOINT_SLOT_KEY]: 'python-api',
        id: `entrypoint:api:${mod.id}:${route.path}:${method}`,
        kind: 'api',
        layer: 'backend',
        path: route.path,
        component: route.component,
        method,
        moduleId: mod.id,
        source: frameworkRouteSource(route.source, webFramework),
        webFramework,
        // Server-rendered page: keeps the python-api slot (no new EntrypointSlot / dual-gate),
        // attaches the rendered template(s) + a surface marker for trace_flow / page-vs-api queries.
        ...(isServerPage ? { surface: 'server-page', rendersTemplate } : {}),
      });
    }
  }

  return out;
}

function frameworkRouteSource(source: 'decorator' | 'ast', webFramework: string | undefined): string {
  if (webFramework === 'fastify') return 'fastify-route';
  if (source === 'decorator') return webFramework ? `${webFramework}-decorator` : 'decorator-route';
  if (webFramework === 'django' || webFramework === 'drf') return 'django-urlpatterns';
  return webFramework ? `${webFramework}-ast` : 'ast-route';
}

export function collectFileApiEntrypoints(ctx: InterpreterEntrypointContext): BackendRoutesEntrypointFragment[] {
  const out: BackendRoutesEntrypointFragment[] = [];

  for (const route of inferFileBasedRoutes(ctx.snapshot)) {
    if (fileBasedEntryKind(route.fileType) !== 'api') continue;
    out.push({
      [LAYER_ENTRYPOINT_SLOT_KEY]: 'file-api',
      id: `entrypoint:file:${route.moduleId}:${route.path}:${route.fileType}`,
      kind: 'api',
      layer: 'frontend',
      path: route.path,
      moduleId: route.moduleId,
      source: route.framework,
      fileType: route.fileType,
    });
  }

  return out;
}
