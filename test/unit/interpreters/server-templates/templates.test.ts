import { describe, expect, it } from '@jest/globals';
import { createEmptyGraph, addNode } from '../../../../src/graph/index.js';
import {
  contributeServerTemplates,
  makeTemplateResolver,
} from '../../../../src/interpreters/server-templates/templates.js';
import { composeRepositoryGraph } from '../../../../src/stage2/index.js';
import type { InterpreterGraphContext } from '../../../../src/interpreter/types.js';
import type {
  ExportInfo,
  ModuleInfo,
  RepositoryFactsSnapshot,
  RepositoryGraph,
  TemplateFileInfo,
} from '../../../../src/types.js';

function template(rel: string, extra: Partial<TemplateFileInfo> = {}): TemplateFileInfo {
  return { id: `template:${rel}`, relPath: rel, contentHash: `hash:${rel}`, ...extra };
}

function templates(...rel: string[]): TemplateFileInfo[] {
  return rel.map(r => template(r));
}

function graphCtx(graph: RepositoryGraph, snapshot: RepositoryFactsSnapshot): InterpreterGraphContext {
  return {
    graph,
    snapshot,
    modulesById: new Map(snapshot.modules.map(m => [m.id, m])),
    sourcePluginIds: ['python'],
    domainsConfig: null,
    log: () => {},
  };
}

function exp(name: string): ExportInfo {
  return { name, kind: 'function', lineRange: { start: 1, end: 3 }, isDefault: false };
}

function pyModule(id: string, opts: { route?: { component: string; rendersTemplate: string[] }; exports?: ExportInfo[] } = {}): ModuleInfo {
  return {
    id,
    packageName: 'app',
    filePath: `/repo/${id}.py`,
    relativeFilePath: `${id.slice(4)}.py`,
    contentHash: id,
    imports: [],
    exports: opts.exports ?? [],
    sourcePluginId: 'python',
    ...(opts.route
      ? {
          semanticHints: {
            hasRoutes: true,
            routes: [{ path: '/home', component: opts.route.component, source: 'decorator', kind: 'api', rendersTemplate: opts.route.rendersTemplate }],
          },
        }
      : {}),
  };
}

describe('makeTemplateResolver', () => {
  const resolve = makeTemplateResolver(
    templates('app/templates/home.html', 'app/templates/users/profile.html', 'app/templates/layout.html'),
  );

  it('resolves a name to the template under templates/', () => {
    expect(resolve('home.html')).toBe('template:app/templates/home.html');
    expect(resolve('users/profile.html')).toBe('template:app/templates/users/profile.html');
  });

  it('normalizes leading ./ and backslashes', () => {
    expect(resolve('./home.html')).toBe('template:app/templates/home.html');
    expect(resolve('users\\profile.html')).toBe('template:app/templates/users/profile.html');
  });

  it('returns undefined for an unknown name (honest under-capture)', () => {
    expect(resolve('missing.html')).toBeUndefined();
  });

  it('returns undefined when the name is ambiguous across templates/ dirs', () => {
    const ambiguous = makeTemplateResolver(
      templates('app1/templates/x.html', 'app2/templates/x.html'),
    );
    expect(ambiguous('x.html')).toBeUndefined();
  });
});

describe('contributeServerTemplates', () => {
  it('projects template nodes and a renders edge from the view export-symbol', () => {
    const graph = createEmptyGraph();
    addNode(graph, { id: 'mod:app/views', type: 'module', label: 'views.py', description: 'views' });
    addNode(graph, { id: 'export:app/views/home_view', type: 'export-symbol', label: 'home_view', description: 'view', data: { symbolKind: 'function' } });

    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: '/repo',
      timestamp: '2026-06-19T00:00:00.000Z',
      packages: [],
      modules: [pyModule('mod:app/views', { route: { component: 'home_view', rendersTemplate: ['home.html'] } })],
      templates: templates('app/templates/home.html', 'app/templates/base.html'),
    };

    contributeServerTemplates(graphCtx(graph, snapshot));

    // Both discovered templates are nodes (base.html exists even with no incoming renders yet).
    expect(graph.nodes.get('template:app/templates/home.html')?.type).toBe('template');
    expect(graph.nodes.get('template:app/templates/base.html')?.type).toBe('template');
    // renders edge points from the view symbol to the rendered template.
    const renders = graph.edges.filter(e => e.kind === 'renders');
    expect(renders).toEqual([
      { from: 'export:app/views/home_view', to: 'template:app/templates/home.html', kind: 'renders' },
    ]);
  });

  it('projects template blocks plus extends/includes template edges', () => {
    const graph = createEmptyGraph();
    addNode(graph, { id: 'mod:app/views', type: 'module', label: 'views.py', description: 'views' });
    addNode(graph, { id: 'export:app/views/home_view', type: 'export-symbol', label: 'home_view', description: 'view', data: { symbolKind: 'function' } });

    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: '/repo',
      timestamp: '2026-06-19T00:00:00.000Z',
      packages: [],
      modules: [pyModule('mod:app/views', { route: { component: 'home_view', rendersTemplate: ['home.html'] } })],
      templates: [
        template('app/templates/home.html', {
          extendsTemplate: 'base.html',
          includesTemplate: ['partials/nav.html'],
          blocks: ['content'],
        }),
        template('app/templates/base.html', { blocks: ['shell'] }),
        template('app/templates/partials/nav.html'),
      ],
    };

    contributeServerTemplates(graphCtx(graph, snapshot));

    expect(graph.nodes.get('template:app/templates/home.html')?.data).toEqual({
      relPath: 'app/templates/home.html',
      contentHash: 'hash:app/templates/home.html',
      blocks: ['content'],
    });
    expect(graph.nodes.get('template:app/templates/base.html')?.data).toEqual({
      relPath: 'app/templates/base.html',
      contentHash: 'hash:app/templates/base.html',
      blocks: ['shell'],
    });
    expect(graph.edges.filter(e => e.kind === 'extends')).toEqual([
      { from: 'template:app/templates/home.html', to: 'template:app/templates/base.html', kind: 'extends' },
    ]);
    expect(graph.edges.filter(e => e.kind === 'includes')).toEqual([
      { from: 'template:app/templates/home.html', to: 'template:app/templates/partials/nav.html', kind: 'includes' },
    ]);
  });

  it('falls back to the module node when the view symbol is absent', () => {
    const graph = createEmptyGraph();
    addNode(graph, { id: 'mod:app/views', type: 'module', label: 'views.py', description: 'views' });

    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: '/repo',
      timestamp: '2026-06-19T00:00:00.000Z',
      packages: [],
      modules: [pyModule('mod:app/views', { route: { component: 'home_view', rendersTemplate: ['home.html'] } })],
      templates: templates('app/templates/home.html'),
    };

    contributeServerTemplates(graphCtx(graph, snapshot));

    expect(graph.edges.filter(e => e.kind === 'renders')).toEqual([
      { from: 'mod:app/views', to: 'template:app/templates/home.html', kind: 'renders' },
    ]);
  });

  it('is inert when no templates were discovered', () => {
    const graph = createEmptyGraph();
    addNode(graph, { id: 'mod:app/views', type: 'module', label: 'views.py', description: 'views' });
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: '/repo',
      timestamp: '2026-06-19T00:00:00.000Z',
      packages: [],
      modules: [pyModule('mod:app/views', { route: { component: 'home_view', rendersTemplate: ['home.html'] } })],
    };

    contributeServerTemplates(graphCtx(graph, snapshot));

    expect(graph.byType.get('template')).toBeUndefined();
    expect(graph.edges.filter(e => e.kind === 'renders')).toEqual([]);
  });
});

describe('composeRepositoryGraph wires the server-templates interpreter', () => {
  it('produces template nodes + renders edges end-to-end', () => {
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: '/repo',
      timestamp: '2026-06-19T00:00:00.000Z',
      packages: [{ name: 'app', path: '.', sourcePluginId: 'python' }],
      modules: [
        pyModule('mod:app/views', {
          route: { component: 'home_view', rendersTemplate: ['home.html'] },
          exports: [exp('home_view')],
        }),
      ],
      templates: [
        template('app/templates/home.html', {
          extendsTemplate: 'base.html',
          includesTemplate: ['partials/nav.html'],
        }),
        template('app/templates/base.html'),
        template('app/templates/partials/nav.html'),
      ],
    };

    const graph = composeRepositoryGraph(snapshot);

    expect(graph.nodes.get('template:app/templates/home.html')?.type).toBe('template');
    const renders = graph.edges.filter(e => e.kind === 'renders');
    expect(renders).toHaveLength(1);
    expect(renders[0].to).toBe('template:app/templates/home.html');
    expect(renders[0].from).toBe('export:app/views/home_view');
    expect(graph.edges.filter(e => e.kind === 'extends')).toEqual([
      { from: 'template:app/templates/home.html', to: 'template:app/templates/base.html', kind: 'extends' },
    ]);
    expect(graph.edges.filter(e => e.kind === 'includes')).toEqual([
      { from: 'template:app/templates/home.html', to: 'template:app/templates/partials/nav.html', kind: 'includes' },
    ]);
  });
});
