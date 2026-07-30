import { asRepoRelPath } from '@repovine/plugin-sdk';
import { asHostPath, asPkgRelPath } from '@repovine/plugin-sdk';
import { describe, expect, it } from '@jest/globals';
import { createEmptyGraph } from '../../../../src/graph/index.js';
import {
  collectBackendRouteEntrypoints,
  LAYER_ENTRYPOINT_SLOT_KEY,
} from '../../../../src/interpreters/server-entrypoints/entrypoints.js';
import type { InterpreterEntrypointContext } from '../../../../src/interpreter/types.js';
import type { ModuleInfo, RepositoryFactsSnapshot } from '../../../../src/types.js';

function mod(id: string, sourcePluginId: string, semanticHints?: ModuleInfo['semanticHints']): ModuleInfo {
  return {
    id,
    packageName: 'pkg',
    absPath: asHostPath(`/repo/${id}.ts`),
    pkgRelPath: asPkgRelPath(`${id}.ts`),
    contentHash: id,
    imports: [],
    exports: [],
    sourcePluginId,
    semanticHints,
  };
}

function ctx(modules: ModuleInfo[]): InterpreterEntrypointContext {
  const snapshot: RepositoryFactsSnapshot = {
    repoRoot: '/repo',
    timestamp: '2026-06-13T00:00:00.000Z',
    packages: [{ name: 'pkg', repoRelDir: asRepoRelPath('.'), sourcePluginId: 'typescript' }],
    modules,
  };
  return {
    graph: createEmptyGraph(),
    snapshot,
    modulesById: new Map(modules.map(module => [module.id, module])),
    log: () => undefined,
  };
}

describe('backend-routes layer entrypoints', () => {
  it('maps Python FastAPI decorator routes with legacy defaults', () => {
    const entries = collectBackendRouteEntrypoints(ctx([
      mod('mod:py/api', 'python', {
        webFramework: 'fastapi',
        hasRoutes: true,
        routes: [{ path: '/users', component: 'list_users', declaredIn: 'code', syntax: 'decorator', kind: 'api' }],
      }),
    ]));

    expect(entries).toEqual([
      {
        [LAYER_ENTRYPOINT_SLOT_KEY]: 'api-route',
        id: 'entrypoint:api:mod:py/api:/users:GET',
        kind: 'api',
        layer: 'backend',
        path: '/users',
        component: 'list_users',
        method: 'GET',
        moduleId: 'mod:py/api',
        source: 'fastapi-decorator',
        webFramework: 'fastapi',
      },
    ]);
  });

  it('marks server-rendered routes with surface:server-page and rendersTemplate, keeping the api-route slot', () => {
    const entries = collectBackendRouteEntrypoints(ctx([
      mod('mod:py/views', 'python', {
        webFramework: 'django',
        hasRoutes: true,
        routes: [{
          path: '/profile/',
          component: 'profile_view',
          declaredIn: 'code', syntax: 'call',
          kind: 'api',
          method: 'GET',
          rendersTemplate: ['accounts/profile.html'],
        }],
      }),
    ]));

    expect(entries).toEqual([
      expect.objectContaining({
        [LAYER_ENTRYPOINT_SLOT_KEY]: 'api-route',
        id: 'entrypoint:api:mod:py/views:/profile/:GET',
        surface: 'server-page',
        rendersTemplate: ['accounts/profile.html'],
        source: 'django-urlpatterns',
      }),
    ]);
  });

  it('does not add surface/rendersTemplate to plain API routes', () => {
    const [entry] = collectBackendRouteEntrypoints(ctx([
      mod('mod:py/api', 'python', {
        webFramework: 'fastapi',
        hasRoutes: true,
        routes: [{ path: '/users', component: 'list_users', declaredIn: 'code', syntax: 'decorator', kind: 'api' }],
      }),
    ]));
    expect(entry).not.toHaveProperty('surface');
    expect(entry).not.toHaveProperty('rendersTemplate');
  });

  it('maps Python Django/DRF ast routes with explicit method', () => {
    const entries = collectBackendRouteEntrypoints(ctx([
      mod('mod:py/urls', 'python', {
        webFramework: 'drf',
        hasRoutes: true,
        routes: [{ path: '/users/', component: 'UserViewSet', declaredIn: 'code', syntax: 'call', kind: 'api', method: 'POST' }],
      }),
    ]));

    expect(entries).toEqual([
      expect.objectContaining({
        [LAYER_ENTRYPOINT_SLOT_KEY]: 'api-route',
        id: 'entrypoint:api:mod:py/urls:/users/:POST',
        method: 'POST',
        source: 'django-urlpatterns',
        webFramework: 'drf',
      }),
    ]);
  });

  it('maps TypeScript Fastify ast route hints as backend API entrypoints', () => {
    const entries = collectBackendRouteEntrypoints(ctx([
      mod('mod:ts/routes/environment', 'typescript', {
        webFramework: 'fastify',
        hasRoutes: true,
        routes: [
          {
            path: '/api/environments',
            component: 'fastify.get',
            declaredIn: 'code', syntax: 'call',
            kind: 'api',
            method: 'GET',
          },
          {
            path: '/api/environments',
            component: 'fastify.post',
            declaredIn: 'code', syntax: 'call',
            kind: 'api',
            method: 'POST',
          },
        ],
      }),
    ]));

    expect(entries).toEqual([
      expect.objectContaining({
        [LAYER_ENTRYPOINT_SLOT_KEY]: 'api-route',
        id: 'entrypoint:api:mod:ts/routes/environment:/api/environments:GET',
        kind: 'api',
        layer: 'backend',
        method: 'GET',
        moduleId: 'mod:ts/routes/environment',
        source: 'fastify-route',
        webFramework: 'fastify',
      }),
      expect.objectContaining({
        id: 'entrypoint:api:mod:ts/routes/environment:/api/environments:POST',
        method: 'POST',
        source: 'fastify-route',
      }),
    ]);
  });

  it('maps TS/JS file-based API routes to the backend layer and preserves methods', () => {
    const entries = collectBackendRouteEntrypoints(ctx([
      mod('mod:next/route', 'typescript', {
        hasRoutes: true,
        routes: [{ path: '/api/users', component: '(file-route)', declaredIn: 'layout', kind: 'api', method: 'GET', framework: 'nextjs-app', fileType: 'route' }],
      }),
      mod('mod:pages/api', 'typescript', {
        hasRoutes: true,
        routes: [{ path: '/api/hello', component: '(file-route)', declaredIn: 'layout', kind: 'api', framework: 'nextjs-pages', fileType: 'api' }],
      }),
      mod('mod:sk/server', 'typescript', {
        hasRoutes: true,
        routes: [{ path: '/api/users', component: '(file-route)', declaredIn: 'layout', kind: 'api', framework: 'sveltekit', fileType: 'server' }],
      }),
      mod('mod:nuxt/server-api', 'typescript', {
        hasRoutes: true,
        routes: [{ path: '/api/products', component: '(file-route)', declaredIn: 'layout', kind: 'api', framework: 'nuxt', fileType: 'server-api' }],
      }),
      mod('mod:page', 'typescript', {
        hasRoutes: true,
        routes: [{ path: '/users', component: '(file-route)', declaredIn: 'layout', kind: 'frontend', framework: 'nextjs-app', fileType: 'page' }],
      }),
    ]));

    expect(entries).toEqual([
      expect.objectContaining({
        [LAYER_ENTRYPOINT_SLOT_KEY]: 'file-api',
        id: 'entrypoint:file:mod:next/route:/api/users:route:GET',
        kind: 'api',
        layer: 'backend',
        path: '/api/users',
        method: 'GET',
        moduleId: 'mod:next/route',
        source: 'nextjs-app',
        fileType: 'route',
      }),
      expect.objectContaining({
        id: 'entrypoint:file:mod:pages/api:/api/hello:api',
        source: 'nextjs-pages',
        fileType: 'api',
      }),
      expect.objectContaining({
        id: 'entrypoint:file:mod:sk/server:/api/users:server',
        source: 'sveltekit',
        fileType: 'server',
      }),
      expect.objectContaining({
        id: 'entrypoint:file:mod:nuxt/server-api:/api/products:server-api',
        source: 'nuxt',
        fileType: 'server-api',
      }),
    ]);
    expect(entries.every(entry => entry.layer === 'backend')).toBe(true);
    expect(entries.map(entry => entry.moduleId)).not.toContain('mod:page');
  });

  it('labels decorator routes with no webFramework as decorator-route', () => {
    const [entry] = collectBackendRouteEntrypoints(ctx([
      mod('mod:py/deco', 'python', {
        hasRoutes: true,
        routes: [{ path: '/ping', component: 'ping', declaredIn: 'code', syntax: 'decorator', kind: 'api' }],
      }),
    ]));
    expect(entry.source).toBe('decorator-route');
  });

  it('labels ast routes with no webFramework as ast-route', () => {
    const [entry] = collectBackendRouteEntrypoints(ctx([
      mod('mod:py/ast', 'python', {
        hasRoutes: true,
        routes: [{ path: '/status', component: 'status', declaredIn: 'code', syntax: 'call', kind: 'api' }],
      }),
    ]));
    expect(entry.source).toBe('ast-route');
  });

  it('labels ast routes of an unknown webFramework as ${webFramework}-ast', () => {
    const [entry] = collectBackendRouteEntrypoints(ctx([
      mod('mod:py/flask', 'python', {
        webFramework: 'flask',
        hasRoutes: true,
        routes: [{ path: '/items', component: 'items', declaredIn: 'code', syntax: 'call', kind: 'api' }],
      }),
    ]));
    expect(entry.source).toBe('flask-ast');
  });
});
