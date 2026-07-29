import { describe, expect, it } from '@jest/globals';
import { createEmptyGraph, addNode } from '../../../src/graph/index.js';
import { collectBackendRouteEntrypoints } from '../../../src/interpreters/server-entrypoints/entrypoints.js';
import { collectUiRouteEntrypoints } from '../../../src/interpreters/ui-entrypoints/entrypoints.js';
import { collectServiceTriggerEntrypoints } from '../../../src/interpreters/infra-runtime-links/entrypoints.js';
import { collectEntrypoints } from '../../../src/mcp/lib/entrypoints.js';
import type { InterpreterEntrypointContext } from '../../../src/interpreter/types.js';
import type { McpToolRuntime } from '../../../src/mcp/types.js';
import { rememberInterpreterEntrypoints } from '../../../src/stage2/interpreter/entrypoint-store.js';
import type { ModuleInfo, RepositoryFactsSnapshot } from '../../../src/types.js';

function mod(id: string, semanticHints?: ModuleInfo['semanticHints'], sourcePluginId = 'typescript'): ModuleInfo {
  return {
    id,
    packageName: 'pkg',
    filePath: `/repo/${id}.ts`,
    relativeFilePath: `${id}.ts`,
    contentHash: id,
    imports: [],
    exports: [],
    sourcePluginId,
    semanticHints,
  };
}

function makeCtx(snapshot: RepositoryFactsSnapshot, graph = createEmptyGraph()): McpToolRuntime {
  const modulesById = new Map(snapshot.modules.map(module => [module.id, module]));
  const layerCtx: InterpreterEntrypointContext = {
    graph,
    snapshot,
    modulesById,
    sourcePluginIds: ['typescript', 'python'],
    log: () => undefined,
  };
  // Mirror the composer: every entrypoint-producing builtin layer populates the store; the MCP
  // shell then replays them in legacy order.
  rememberInterpreterEntrypoints(graph, [
    ...collectBackendRouteEntrypoints(layerCtx),
    ...collectUiRouteEntrypoints(layerCtx),
    ...collectServiceTriggerEntrypoints(layerCtx),
  ]);
  return {
    getState: () => ({ graph, snapshot, modulesById }),
    refreshRepoState: () => undefined,
    repoRoot: '/repo',
  } as unknown as McpToolRuntime;
}

describe('collectEntrypoints layer parity', () => {
  it('keeps mixed source ordering and strips layer-internal fields', () => {
    const modules = [
      mod('mod:app/jsx', {
        hasRoutes: true,
        routes: [{ path: '/jsx', component: 'JsxPage', declaredIn: 'code', syntax: 'markup', kind: 'frontend' }],
      }),
      mod('mod:py/api', {
        webFramework: 'fastapi',
        hasRoutes: true,
        routes: [{ path: '/py', component: 'read_py', declaredIn: 'code', syntax: 'decorator', kind: 'api' }],
      }, 'python'),
      mod('mod:app/conditional', {
        conditionalRenders: [{ component: 'MaybeAdmin', condition: 'isAdmin', renderedIn: 'App', lineRange: { start: 5, end: 7 } }],
      }),
      mod('mod:app/page', {
        hasRoutes: true,
        routes: [{ path: '/page', component: '(file-route)', declaredIn: 'layout', kind: 'frontend', framework: 'nextjs-app', fileType: 'page' }],
      }),
      mod('mod:app/api', {
        hasRoutes: true,
        routes: [{ path: '/api/items', component: '(file-route)', declaredIn: 'layout', kind: 'api', method: 'POST', framework: 'nextjs-app', fileType: 'route' }],
      }),
    ];
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: '/repo',
      timestamp: '2026-06-13T00:00:00.000Z',
      packages: [{ name: 'pkg', path: '.', sourcePluginId: 'typescript' }],
      modules,
    };
    const graph = createEmptyGraph();
    addNode(graph, {
      id: 'resource:aws:OrdersFunction',
      type: 'runtime-resource',
      label: 'OrdersFunction',
      description: 'Lambda',
      data: {
        kind: 'lambda',
        provider: 'aws',
        handler: 'orders.handler',
        triggers: [{ name: 'ApiEvent', type: 'api', path: '/orders', method: 'GET' }],
      },
    });

    const result = collectEntrypoints(makeCtx(snapshot, graph), { scope: 'all', limit: 20 });

    expect(result.items).toEqual([
      {
        id: 'entrypoint:route:mod:app/jsx:/jsx',
        kind: 'route',
        layer: 'frontend',
        path: '/jsx',
        component: 'JsxPage',
        moduleId: 'mod:app/jsx',
        source: 'jsx-route',
      },
      {
        id: 'entrypoint:api:mod:py/api:/py:GET',
        kind: 'api',
        layer: 'backend',
        path: '/py',
        component: 'read_py',
        method: 'GET',
        moduleId: 'mod:py/api',
        source: 'fastapi-decorator',
        webFramework: 'fastapi',
      },
      {
        id: 'entrypoint:conditional:mod:app/conditional:MaybeAdmin',
        kind: 'unknown',
        layer: 'frontend',
        component: 'MaybeAdmin',
        condition: 'isAdmin',
        moduleId: 'mod:app/conditional',
        source: 'conditional-render',
        lineRange: { start: 5, end: 7 },
      },
      {
        id: 'entrypoint:file:mod:app/page:/page:page',
        kind: 'page',
        layer: 'frontend',
        path: '/page',
        moduleId: 'mod:app/page',
        source: 'nextjs-app',
        fileType: 'page',
      },
      {
        id: 'entrypoint:file:mod:app/api:/api/items:route:POST',
        kind: 'api',
        layer: 'backend',
        path: '/api/items',
        method: 'POST',
        moduleId: 'mod:app/api',
        source: 'nextjs-app',
        fileType: 'route',
      },
      expect.objectContaining({
        id: 'entrypoint:api:resource:aws:OrdersFunction:ApiEvent',
        kind: 'api',
        layer: 'backend',
        serviceId: 'resource:aws:OrdersFunction',
        path: '/orders',
      }),
    ]);
    expect(result.items.some(item => '__repovineSlot' in item)).toBe(false);
  });
});
