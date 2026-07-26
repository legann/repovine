import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { Project, ScriptTarget } from 'ts-morph';
import { createEmptyGraph } from '../../../src/graph/index.js';
import { collectUiRouteEntrypoints } from '../../../src/interpreters/ui-entrypoints/entrypoints.js';
import type { InterpreterEntrypointContext } from '../../../src/interpreter/types.js';
import { collectSemanticHints } from '../../../src/source-plugins/typescript/semantic-hints.js';
import type { ModuleInfo, RepositoryFactsSnapshot } from '../../../src/types.js';

const FIXTURE_ROOT = join(process.cwd(), 'test/fixtures/tanstack-router');

function fixtureSource(relativePath: string): string {
  return readFileSync(join(FIXTURE_ROOT, relativePath), 'utf8');
}

function makeSf(source: string, fileName: string) {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { target: ScriptTarget.ES2022, jsx: 2 },
  });
  return project.createSourceFile(fileName, source);
}

function mod(id: string, semanticHints?: ModuleInfo['semanticHints']): ModuleInfo {
  return {
    id,
    packageName: 'tanstack-router-fixture',
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
    repoRoot: FIXTURE_ROOT,
    timestamp: '2026-06-16T00:00:00.000Z',
    packages: [{ name: 'tanstack-router-fixture', path: '.', sourcePluginId: 'typescript' }],
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

describe('TanStack Router routes', () => {
  it('detects createFileRoute paths from fixture files', () => {
    const sf = makeSf(
      fixtureSource('src/routes/admin/users.tsx'),
      '/virtual/src/routes/admin/users.tsx',
    );
    const h = collectSemanticHints(sf, 'src/routes/admin/users.tsx');
    expect(h?.webFramework).toBe('tanstack-router');
    expect(h?.routes).toContainEqual({
      path: '/admin/users',
      component: 'AdminUsersPage',
      source: 'file',
      kind: 'frontend',
      framework: 'tanstack-router',
      fileType: 'page',
    });
  });

  it('detects dynamic createFileRoute segments', () => {
    const sf = makeSf(
      fixtureSource('src/routes/posts/$postId.tsx'),
      '/virtual/src/routes/posts/$postId.tsx',
    );
    const h = collectSemanticHints(sf, 'src/routes/posts/$postId.tsx');
    expect(h?.routes).toContainEqual({
      path: '/posts/$postId',
      component: 'PostDetailPage',
      source: 'file',
      kind: 'frontend',
      framework: 'tanstack-router',
      fileType: 'page',
    });
  });

  it('detects code-based createRoute without exposing createRootRoute as a URL', () => {
    const sf = makeSf(fixtureSource('src/routeTree.tsx'), '/virtual/src/routeTree.tsx');
    const h = collectSemanticHints(sf, 'src/routeTree.tsx');
    expect(h?.webFramework).toBe('tanstack-router');
    expect(h?.routes).toEqual([
      {
        path: '/settings',
        component: 'SettingsPage',
        source: 'ast',
        kind: 'frontend',
        framework: 'tanstack-router',
      },
    ]);
  });

  it('does not treat createRoute as TanStack when @tanstack/react-router is not imported', () => {
    const sf = makeSf(`
      function createRoute(opts: { path: string; component: unknown }) {
        return opts;
      }
      export const legacyRoute = createRoute({ path: '/legacy', component: LegacyPage });
    `, '/virtual/src/legacyRoutes.ts');
    expect(collectSemanticHints(sf, 'src/legacyRoutes.ts')?.routes ?? []).toEqual([]);
  });

  it('does not cross-tag React Router JSX when only react-router-dom is imported', () => {
    const sf = makeSf(`
      import { Route } from 'react-router-dom';
      export function AppRoutes() {
        return <Route path="/profile" element={<ProfilePage />} />;
      }
    `, '/virtual/src/AppRoutes.tsx');
    const h = collectSemanticHints(sf, 'src/AppRoutes.tsx');
    expect(h?.webFramework).toBe('react-router');
    expect(h?.routes ?? []).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/profile', source: 'jsx', framework: 'react-router' }),
    ]));
    expect(h?.routes ?? []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ framework: 'tanstack-router' }),
    ]));
  });

  it('projects file and code TanStack routes into ui entrypoints', () => {
    const fileHints = collectSemanticHints(
      makeSf(fixtureSource('src/routes/admin/users.tsx'), '/virtual/src/routes/admin/users.tsx'),
      'src/routes/admin/users.tsx',
    );
    const codeHints = collectSemanticHints(
      makeSf(fixtureSource('src/routeTree.tsx'), '/virtual/src/routeTree.tsx'),
      'src/routeTree.tsx',
    );

    const entries = collectUiRouteEntrypoints(ctxFor([
      mod('src/routes/admin/users', fileHints),
      mod('src/routeTree', codeHints),
    ]));

    expect(entries).toEqual(expect.arrayContaining([
      {
        __repovineSlot: 'file-page',
        id: 'entrypoint:file:src/routes/admin/users:/admin/users:page',
        kind: 'page',
        layer: 'frontend',
        path: '/admin/users',
        moduleId: 'src/routes/admin/users',
        source: 'tanstack-router',
        fileType: 'page',
      },
      {
        __repovineSlot: 'tanstack-route',
        id: 'entrypoint:route:src/routeTree:/settings',
        kind: 'route',
        layer: 'frontend',
        path: '/settings',
        component: 'SettingsPage',
        moduleId: 'src/routeTree',
        source: 'tanstack-router',
        webFramework: 'tanstack-router',
      },
    ]));
  });
});
