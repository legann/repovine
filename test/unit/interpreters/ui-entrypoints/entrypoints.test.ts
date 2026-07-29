import { describe, expect, it } from '@jest/globals';
import { createEmptyGraph } from '../../../../src/graph/index.js';
import { collectUiRouteEntrypoints } from '../../../../src/interpreters/ui-entrypoints/entrypoints.js';
import type { InterpreterEntrypointContext } from '../../../../src/interpreter/types.js';
import type { ModuleInfo, RepositoryFactsSnapshot } from '../../../../src/types.js';

function mod(id: string, semanticHints?: ModuleInfo['semanticHints']): ModuleInfo {
  return {
    id,
    packageName: 'pkg',
    filePath: `/repo/${id}.tsx`,
    relativeFilePath: `${id}.tsx`,
    contentHash: id,
    imports: [],
    exports: [],
    sourcePluginId: 'typescript',
    semanticHints,
  };
}

function ctxFor(modules: ModuleInfo[]): InterpreterEntrypointContext {
  const snapshot: RepositoryFactsSnapshot = {
    repoRoot: '/repo',
    timestamp: '2026-06-13T00:00:00.000Z',
    packages: [{ name: 'pkg', path: '.', sourcePluginId: 'typescript' }],
    modules,
  };
  return {
    graph: createEmptyGraph(),
    snapshot,
    modulesById: new Map(modules.map(m => [m.id, m])),
    sourcePluginIds: ['typescript'],
    log: () => undefined,
  };
}

describe('frontend-routes layer entrypoints', () => {
  it('emits jsx routes, conditional renders, and non-api file pages with hidden slots', () => {
    const entries = collectUiRouteEntrypoints(ctxFor([
      mod('jsx', { routes: [{ path: '/jsx', component: 'JsxPage', declaredIn: 'code', syntax: 'markup', kind: 'frontend' }] }),
      mod('cond', { conditionalRenders: [{ component: 'MaybeAdmin', condition: 'isAdmin', renderedIn: 'App', lineRange: { start: 5, end: 7 } }] }),
      mod('page', { routes: [{ path: '/page', component: '(file-route)', declaredIn: 'layout', kind: 'frontend', framework: 'nextjs-app', fileType: 'page' }] }),
      mod('src-app-page', { routes: [{ path: '/agents', component: '(file-route)', declaredIn: 'layout', kind: 'frontend', framework: 'nextjs-app', fileType: 'page' }] }),
    ]));

    expect(entries).toEqual([
      {
        __repovineSlot: 'jsx-route',
        id: 'entrypoint:route:jsx:/jsx',
        kind: 'route',
        layer: 'frontend',
        path: '/jsx',
        component: 'JsxPage',
        moduleId: 'jsx',
        source: 'jsx-route',
      },
      {
        __repovineSlot: 'conditional',
        id: 'entrypoint:conditional:cond:MaybeAdmin',
        kind: 'unknown',
        layer: 'frontend',
        component: 'MaybeAdmin',
        condition: 'isAdmin',
        moduleId: 'cond',
        source: 'conditional-render',
        lineRange: { start: 5, end: 7 },
      },
      {
        __repovineSlot: 'file-page',
        id: 'entrypoint:file:page:/page:page',
        kind: 'page',
        layer: 'frontend',
        path: '/page',
        moduleId: 'page',
        source: 'nextjs-app',
        fileType: 'page',
      },
      {
        __repovineSlot: 'file-page',
        id: 'entrypoint:file:src-app-page:/agents:page',
        kind: 'page',
        layer: 'frontend',
        path: '/agents',
        moduleId: 'src-app-page',
        source: 'nextjs-app',
        fileType: 'page',
      },
    ]);
  });

  it('skips api file routes (owned by backend-routes)', () => {
    const entries = collectUiRouteEntrypoints(ctxFor([
      mod('api', { routes: [{ path: '/api/items', component: '(file-route)', declaredIn: 'layout', kind: 'api', framework: 'nextjs-app', fileType: 'route' }] }),
    ]));
    expect(entries).toEqual([]);
  });
});
