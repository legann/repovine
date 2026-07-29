import type { InterpreterEntrypointContext } from '../../interpreter/types.js';
import {
  LAYER_ENTRYPOINT_SLOT_KEY,
  type SlottedEntrypointFragment,
} from '../../stage2/interpreter/entrypoint-slots.js';
import { fileBasedEntryKind, inferFileBasedRoutes } from '../../stage2/routes/file-based.js';

export const UI_ENTRYPOINTS_INTERPRETER_ID = 'ui-entrypoints';

/**
 * Owns the frontend-side entrypoints previously assembled inline in the MCP shell:
 *   - JSX `<Route>` entries (`source:'jsx'`) and React Router config objects (`source:'config'`)
 *   - TanStack Router code routes (`source:'ast'`, `framework:'tanstack-router'`)
 *   - conditional render entries (`semanticHints.conditionalRenders`)
 *   - non-api file-based routes (page/route/layout/…) from inferFileBasedRoutes
 *
 * API file routes stay with server-entrypoints; this interpreter skips them so ownership never overlaps.
 * Entries carry a hidden slot; the MCP shell replays them in the legacy global order.
 */
export function collectUiRouteEntrypoints(ctx: InterpreterEntrypointContext): SlottedEntrypointFragment[] {
  const out: SlottedEntrypointFragment[] = [];

  for (const mod of ctx.snapshot.modules) {
    for (const route of mod.semanticHints?.routes ?? []) {
      if (
        route.syntax === 'call'
        && route.framework === 'tanstack-router'
        && route.kind === 'frontend'
      ) {
        out.push({
          [LAYER_ENTRYPOINT_SLOT_KEY]: 'tanstack-route',
          id: `entrypoint:route:${mod.id}:${route.path}`,
          kind: 'route',
          layer: 'frontend',
          path: route.path,
          component: route.component,
          moduleId: mod.id,
          source: 'tanstack-router',
          webFramework: 'tanstack-router',
        });
        continue;
      }
      if (
        route.syntax === 'call'
        && route.framework === 'angular'
        && route.kind === 'frontend'
      ) {
        out.push({
          [LAYER_ENTRYPOINT_SLOT_KEY]: 'angular-route',
          id: `entrypoint:route:${mod.id}:${route.path}`,
          kind: 'route',
          layer: 'frontend',
          path: route.path,
          component: route.component,
          moduleId: mod.id,
          source: 'angular',
          webFramework: 'angular',
        });
        continue;
      }
      if (route.syntax !== 'markup' && route.syntax !== 'table') continue;
      const webFramework = route.framework ?? mod.semanticHints?.webFramework;
      const kind = route.kind === 'api'
        ? 'api'
        : (route.syntax === 'table' && route.fileType === 'index' ? 'page' : 'route');
      out.push({
        [LAYER_ENTRYPOINT_SLOT_KEY]: 'jsx-route',
        id: `entrypoint:route:${mod.id}:${route.path}`,
        kind,
        layer: 'frontend',
        path: route.path,
        component: route.component,
        moduleId: mod.id,
        source: webFramework === 'react-router' || route.syntax === 'table' ? 'react-router' : 'jsx-route',
        ...(webFramework ? { webFramework } : {}),
      });
    }
    for (const cr of mod.semanticHints?.conditionalRenders ?? []) {
      out.push({
        [LAYER_ENTRYPOINT_SLOT_KEY]: 'conditional',
        id: `entrypoint:conditional:${mod.id}:${cr.component}`,
        kind: 'unknown',
        layer: 'frontend',
        component: cr.component,
        condition: cr.condition,
        moduleId: mod.id,
        source: 'conditional-render',
        lineRange: cr.lineRange,
      });
    }
  }

  for (const route of inferFileBasedRoutes(ctx.snapshot)) {
    const kind = fileBasedEntryKind(route.fileType);
    if (kind === 'api') continue;
    out.push({
      [LAYER_ENTRYPOINT_SLOT_KEY]: 'file-page',
      id: `entrypoint:file:${route.moduleId}:${route.path}:${route.fileType}`,
      kind,
      layer: 'frontend',
      path: route.path,
      moduleId: route.moduleId,
      source: route.framework,
      fileType: route.fileType,
    });
  }

  return out;
}
