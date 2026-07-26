import type { EntrypointFragment } from '../../interpreter/types.js';
import {
  LAYER_ENTRYPOINT_SLOT_KEY,
  type EntrypointSlot,
  stripEntrypointFragmentInternals,
} from '../../stage2/interpreter/entrypoint-slots.js';
import { getInterpreterEntrypoints } from '../../stage2/interpreter/entrypoint-store.js';
import { triggerEntryKind } from '../../stage2/runtime/trigger-entry-kind.js';
import {
  fileBasedEntryKind,
  inferFileBasedRoutes,
  type FileBasedRoute,
} from '../../stage2/routes/file-based.js';
import { nodeInScope, resolveScope } from '../scope/resolve.js';
import { DEFAULT_LIST_LIMIT, limitFrom, offsetFrom } from '../response/pagination.js';
import { pageTruncation, truncationMap, type TruncationMap } from '../../response/truncation.js';
import type { McpToolRuntime } from '../types.js';

export { fileBasedEntryKind, inferFileBasedRoutes } from '../../stage2/routes/file-based.js';
export { triggerEntryKind } from '../../stage2/runtime/trigger-entry-kind.js';

export function collectEntrypoints(ctx: McpToolRuntime, args: Record<string, unknown>): {
  items: Array<Record<string, unknown>>;
  total: number;
  truncation?: TruncationMap;
} {
  const { graph, snapshot } = ctx.getState();
  const scope = resolveScope(ctx, args.scope);
  const requestedKinds = Array.isArray(args.kinds)
    ? new Set(args.kinds.filter((k): k is string => typeof k === 'string'))
    : undefined;
  const requestedKind = (args.kind as string | undefined) ?? 'all';
  const requestedLayer = (args.layer as string | undefined) ?? 'all';
  const limit = limitFrom(args, DEFAULT_LIST_LIMIT);
  const offset = offsetFrom(args);
  const items: Array<Record<string, unknown>> = [];
  const interpreterEntrypoints = indexInterpreterEntrypoints(getInterpreterEntrypoints(graph));

  const push = (entry: Record<string, unknown>, ...nodesForScope: Array<string | undefined>) => {
    const kind = entry.kind as string;
    const layer = entry.layer as string;
    if (requestedKinds?.size) {
      if (!requestedKinds.has('all') && !requestedKinds.has(kind)) return;
    } else if (requestedKind !== 'all' && kind !== requestedKind) return;
    if (requestedLayer !== 'all' && layer !== requestedLayer) return;
    const anchors = nodesForScope.filter((n): n is string => typeof n === 'string' && n.length > 0);
    if (anchors.length > 0) {
      if (!anchors.some(n => nodeInScope(ctx, n, scope))) return;
    } else if (scope.kind !== 'all' && scope.kind !== 'query') return;
    items.push(entry);
  };
  const pushInterpreterEntry = (entry: EntrypointFragment | undefined) => {
    if (!entry) return;
    // Scope anchors mirror the legacy inline pushes: module entrypoints anchor on moduleId; service
    // trigger entrypoints anchor on serviceId + handlerModule. Empty/undefined anchors are dropped.
    push(
      stripEntrypointFragmentInternals(entry),
      entry.moduleId,
      entry.serviceId as string | undefined,
      entry.handlerModule as string | undefined,
    );
  };

  // Replay layer-owned entrypoints in the legacy global order. The MCP shell stays the ordering
  // authority (per-module jsx/python-api/conditional, then file-based, then service triggers);
  // each entry is now built by its owning layer (frontend-routes / backend-routes / infra-link)
  // and looked up here by slot key, then stripped of its hidden slot before output.
  for (const mod of snapshot.modules) {
    for (const route of mod.semanticHints?.routes ?? []) {
      if (route.source === 'jsx' || route.source === 'config') {
        pushInterpreterEntry(interpreterEntrypoints.get(jsxRouteLayerKey(mod.id, route.path)));
        continue;
      }
      if (route.source === 'ast' && route.framework === 'tanstack-router' && route.kind === 'frontend') {
        pushInterpreterEntry(interpreterEntrypoints.get(tanstackRouteLayerKey(mod.id, route.path)));
        continue;
      }
      if (route.source === 'ast' && route.framework === 'angular' && route.kind === 'frontend') {
        pushInterpreterEntry(interpreterEntrypoints.get(angularRouteLayerKey(mod.id, route.path)));
        continue;
      }
      if ((route.source === 'decorator' || route.source === 'ast') && route.kind === 'api') {
        const method = route.method ?? 'GET';
        pushInterpreterEntry(interpreterEntrypoints.get(pythonApiLayerKey(mod.id, route.path, method)));
      }
    }
    for (const cr of mod.semanticHints?.conditionalRenders ?? []) {
      pushInterpreterEntry(interpreterEntrypoints.get(conditionalLayerKey(mod.id, cr.component)));
    }
  }

  for (const r of inferFileBasedRoutes(snapshot)) {
    if (fileBasedEntryKind(r.fileType) === 'api') {
      pushInterpreterEntry(interpreterEntrypoints.get(fileApiLayerKey(r)));
      continue;
    }
    pushInterpreterEntry(interpreterEntrypoints.get(filePageLayerKey(r)));
  }

  for (const svcId of graph.byType.get('runtime-resource') ?? []) {
    const node = graph.nodes.get(svcId);
    if (!node || node.type !== 'runtime-resource') continue;
    for (const trigger of node.data?.triggers ?? []) {
      const kind = triggerEntryKind(trigger);
      const disambiguator = trigger.name ?? trigger.path ?? trigger.queueRef ?? trigger.schedule ?? 'trigger';
      pushInterpreterEntry(interpreterEntrypoints.get(serviceTriggerLayerKey(kind, svcId, disambiguator)));
    }
  }

  const page = items.slice(offset, offset + limit);
  const truncation = truncationMap({
    items: pageTruncation({
      shown: page.length,
      total: items.length,
      offset,
      noun: 'entrypoint',
      hint: `${items.length} entrypoint(s). Pass offset ${offset + page.length} with the same limit for the next page.`,
    }),
  });
  return { items: page, total: items.length, ...(truncation ? { truncation } : {}) };
}

const REPLAYED_SLOTS = new Set<EntrypointSlot>([
  'python-api',
  'file-api',
  'jsx-route',
  'tanstack-route',
  'angular-route',
  'conditional',
  'file-page',
  'service-trigger',
]);

function indexInterpreterEntrypoints(entries: readonly EntrypointFragment[]): Map<string, EntrypointFragment> {
  const out = new Map<string, EntrypointFragment>();
  for (const entry of entries) {
    const slot = entry[LAYER_ENTRYPOINT_SLOT_KEY] as EntrypointSlot | undefined;
    if (!slot || !REPLAYED_SLOTS.has(slot)) continue;
    const id = typeof entry.id === 'string' ? entry.id : undefined;
    if (!id) continue;
    out.set(`${slot}:${id}`, entry);
  }
  return out;
}

function jsxRouteLayerKey(moduleId: string, path: string): string {
  return `jsx-route:entrypoint:route:${moduleId}:${path}`;
}

function tanstackRouteLayerKey(moduleId: string, path: string): string {
  return `tanstack-route:entrypoint:route:${moduleId}:${path}`;
}

function angularRouteLayerKey(moduleId: string, path: string): string {
  return `angular-route:entrypoint:route:${moduleId}:${path}`;
}

function conditionalLayerKey(moduleId: string, component: string): string {
  return `conditional:entrypoint:conditional:${moduleId}:${component}`;
}

function pythonApiLayerKey(moduleId: string, path: string, method: string): string {
  return `python-api:entrypoint:api:${moduleId}:${path}:${method}`;
}

function fileApiLayerKey(route: FileBasedRoute): string {
  const methodSuffix = route.method ? `:${route.method}` : '';
  return `file-api:entrypoint:file:${route.moduleId}:${route.path}:${route.fileType}${methodSuffix}`;
}

function filePageLayerKey(route: FileBasedRoute): string {
  return `file-page:entrypoint:file:${route.moduleId}:${route.path}:${route.fileType}`;
}

function serviceTriggerLayerKey(kind: string, serviceId: string, disambiguator: string): string {
  return `service-trigger:entrypoint:${kind}:${serviceId}:${disambiguator}`;
}
