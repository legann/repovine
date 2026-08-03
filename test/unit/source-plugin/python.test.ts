import { asPkgRelPath } from '@repovine/plugin-sdk';
import { asRepoRelPath } from '@repovine/plugin-sdk';
import { asHostPath } from '@repovine/plugin-sdk';
import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../../src/stage2/index.js';
import { inferFileBasedRoutes } from '../../../src/mcp/lib/entrypoints.js';
import { detectPython } from '../../../packages/plugins/source-python/src/discover.js';
import pythonSourcePlugin from '../../../packages/plugins/source-python/src/plugin.js';
import { runSourceExtraction } from '../../../src/stage1/extract-runner.js';
import { effectImportsFromPythonImports } from '../../../packages/plugins/source-python/src/effect-imports.js';
import type { ImportInfo, ModuleInfo, PackageInfo, PendingModule, RepositoryFactsSnapshot } from '../../../src/types.js';

const PYTHON_AVAILABLE = detectPython() !== null;
const d = PYTHON_AVAILABLE ? describe : describe.skip;

describe('inferFileBasedRoutes language gate (no Python interpreter needed)', () => {
  function mod(id: string, relativeFilePath: string, sourcePluginId: string, semanticHints?: ModuleInfo['semanticHints']): ModuleInfo {
    return { id, packageName: 'p', absPath: asHostPath('/' + relativeFilePath), pkgRelPath: asPkgRelPath(relativeFilePath), contentHash: 'h', imports: [], exports: [], sourcePluginId, semanticHints };
  }

  it('emits TS file routes from enriched RouteInfo but never from non-TS router-shaped paths', () => {
    const snapshot = {
      modules: [
        mod('mod:p/pages/index', 'pages/index.ts', 'typescript', {
          hasRoutes: true,
          routes: [{
            path: '/',
            component: '(file-route)',
            declaredIn: 'layout',
            kind: 'frontend',
            framework: 'nextjs-pages',
            fileType: 'page',
          }],
        }),
        mod('mod:p/pages/index.py', 'pages/index.py', 'python'),
      ],
    } as unknown as RepositoryFactsSnapshot;
    const routes = inferFileBasedRoutes(snapshot);
    expect(routes.map(r => r.moduleId)).toEqual(['mod:p/pages/index']);
  });
});

describe('effectImportsFromPythonImports (no interpreter needed)', () => {
  function imp(specifier: string, isExternal = true): ImportInfo {
    return { moduleSpecifier: specifier, importedNames: [], isTypeOnly: false, isExternal };
  }

  it('maps unambiguous external imports to side-effect kinds, deduplicated and sorted', () => {
    const out = effectImportsFromPythonImports([
      imp('subprocess'),
      imp('subprocess.run'),
      imp('requests'),
      imp('boto3'),
    ]);
    expect(out).toEqual([
      { kind: 'concurrency', source: 'subprocess' },
      { kind: 'external', source: 'boto3' },
      { kind: 'io-read', source: 'requests' },
    ]);
  });

  it('never maps ambiguous/common modules or internal imports', () => {
    expect(effectImportsFromPythonImports([
      imp('os'),
      imp('sys'),
      imp('json'),
      imp('logging'),
      imp('asyncio'),
      imp('requests', false),
    ])).toEqual([]);
  });

  it('does not match prefix-similar module names', () => {
    expect(effectImportsFromPythonImports([imp('requests_cache_local')])).toEqual([]);
  });
});

const du = PYTHON_AVAILABLE ? describe : describe.skip;

du('python fact hints (env vars, __all__, effect imports)', () => {
  let tmpRoot: string;
  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'py-hints-'));
    fs.writeFileSync(path.join(tmpRoot, 'pyproject.toml'), '[project]\nname = "hints-pkg"\n');
    fs.writeFileSync(path.join(tmpRoot, 'cfg.py'), [
      'import os',
      'import subprocess',
      '',
      '__all__ = ["load", "ReExported"]',
      '__version__ = "1.0"',
      '',
      'def load():',
      '    a = os.environ["DB_URL"]',
      '    b = os.environ.get("REGION", "eu")',
      '    c = os.getenv("STAGE")',
      '    d = os.getenv(some_dynamic_name)',
      '    return (a, b, c, d)',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpRoot, 'pure_mod.py'), 'def add(a, b):\n    return a + b\n');
  });
  afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  it('extracts literal env names, __all__ re-exports, and effect imports; pure module stays hint-free', async () => {
    const snapshot = await collectRepositoryFactsAsync(tmpRoot);
    const byId = new Map(snapshot.modules.map(m => [m.id, m]));

    const cfg = byId.get('mod:hints-pkg/cfg')!;
    expect(cfg.semanticHints?.envVars).toEqual(['DB_URL', 'REGION', 'STAGE']);
    expect(cfg.semanticHints?.effectImports).toEqual([{ kind: 'concurrency', source: 'subprocess' }]);

    const names = cfg.exports.map(e => e.name);
    expect(names).toContain('load');
    // __all__ adds the re-exported name once, with kind 'unknown'; dunder assignments are not exports.
    expect(cfg.exports.filter(e => e.name === 'load')).toHaveLength(1);
    expect(cfg.exports.find(e => e.name === 'ReExported')?.kind).toBe('unknown');
    expect(names).not.toContain('__all__');
    expect(names).not.toContain('__version__');

    const pure = byId.get('mod:hints-pkg/pure_mod')!;
    expect(pure.semanticHints).toBeUndefined();
  });
});

du('python server-rendered template hints (route -> view -> template)', () => {
  let tmpRoot: string;
  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'py-tpl-'));
    fs.writeFileSync(path.join(tmpRoot, 'pyproject.toml'), '[project]\nname = "webpkg"\n');
    // FastAPI + Jinja2: route decorator and TemplateResponse in the same handler body.
    fs.writeFileSync(path.join(tmpRoot, 'app_main.py'), [
      'from fastapi import FastAPI',
      'from fastapi.templating import Jinja2Templates',
      '',
      'app = FastAPI()',
      'templates = Jinja2Templates(directory="templates")',
      '',
      '@app.get("/profile")',
      'def profile(request):',
      '    return templates.TemplateResponse("profile.html", {"request": request})',
      '',
      '@app.get("/api/items")',
      'def list_items():',
      '    return []',
      '',
    ].join('\n'));
    // Django function view defined in the same file as its urlpatterns entry.
    fs.writeFileSync(path.join(tmpRoot, 'urls.py'), [
      'from django.urls import path',
      'from django.shortcuts import render',
      '',
      'def home(request):',
      '    return render(request, "home.html")',
      '',
      'urlpatterns = [path("", home)]',
      '',
    ].join('\n'));
    // Flask: classic @app.route + blueprint with url_prefix + methods, all rendering templates.
    fs.writeFileSync(path.join(tmpRoot, 'flask_app.py'), [
      'from flask import Flask, Blueprint, render_template',
      '',
      'app = Flask(__name__)',
      'admin = Blueprint("admin", __name__, url_prefix="/admin")',
      '',
      '@app.route("/dashboard")',
      'def dashboard():',
      '    return render_template("dashboard.html")',
      '',
      '@admin.route("/users", methods=["GET", "POST"])',
      'def users():',
      '    return render_template("admin/users.html")',
      '',
    ].join('\n'));
    fs.mkdirSync(path.join(tmpRoot, 'templates', 'partials'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'templates', 'admin'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'templates', 'profile.html'), '<h1>profile</h1>');
    fs.writeFileSync(path.join(tmpRoot, 'templates', 'home.html'), [
      '{% extends "base.html" %}',
      '{% include "partials/nav.html" %}',
      '{% block content %}home{% endblock %}',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpRoot, 'templates', 'base.html'), '{% block shell %}{% endblock %}');
    fs.writeFileSync(path.join(tmpRoot, 'templates', 'partials', 'nav.html'), '<nav></nav>');
    fs.writeFileSync(path.join(tmpRoot, 'templates', 'dashboard.html'), '<h1>dashboard</h1>');
    fs.writeFileSync(path.join(tmpRoot, 'templates', 'admin', 'users.html'), '<h1>users</h1>');
  });
  afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  it('attaches rendersTemplate to same-file server-rendered routes, leaving JSON APIs untouched', async () => {
    const snapshot = await collectRepositoryFactsAsync(tmpRoot);
    const byId = new Map(snapshot.modules.map(m => [m.id, m]));

    const fastapi = byId.get('mod:webpkg/app_main')!;
    const byPath = new Map((fastapi.semanticHints?.routes ?? []).map(r => [r.path, r]));
    expect(byPath.get('/profile')?.rendersTemplate).toEqual(['profile.html']);
    expect(byPath.get('/api/items')?.rendersTemplate).toBeUndefined();

    const django = byId.get('mod:webpkg/urls')!;
    expect(django.semanticHints?.routes?.find(r => r.path === '/')?.rendersTemplate).toEqual(['home.html']);
  });

  it('detects Flask routes (blueprint url_prefix + methods) and attaches render_template', async () => {
    const snapshot = await collectRepositoryFactsAsync(tmpRoot);
    const flaskMod = snapshot.modules.find(m => m.id === 'mod:webpkg/flask_app')!;
    expect(flaskMod.semanticHints?.webFramework).toBe('flask');

    const byKey = new Map((flaskMod.semanticHints?.routes ?? []).map(r => [`${r.path}:${r.method}`, r]));
    expect(byKey.get('/dashboard:GET')?.rendersTemplate).toEqual(['dashboard.html']);
    // Blueprint url_prefix is applied; methods=[GET, POST] expand into two routes.
    expect(byKey.get('/admin/users:GET')?.rendersTemplate).toEqual(['admin/users.html']);
    expect(byKey.get('/admin/users:POST')?.rendersTemplate).toEqual(['admin/users.html']);
  });

  it('builds template graph edges end-to-end from Python routes and template files', async () => {
    const snapshot = await collectRepositoryFactsAsync(tmpRoot);
    const graph = composeRepositoryGraph(snapshot);
    const hasEdge = (from: string, to: string, kind: 'renders' | 'extends' | 'includes'): boolean =>
      graph.edges.some(e => e.from === from && e.to === to && e.kind === kind);

    expect(snapshot.templates?.map(t => t.relPath).sort()).toEqual([
      'templates/admin/users.html',
      'templates/base.html',
      'templates/dashboard.html',
      'templates/home.html',
      'templates/partials/nav.html',
      'templates/profile.html',
    ]);
    expect(graph.nodes.get('template:templates/home.html')?.type).toBe('template');
    expect(graph.nodes.get('template:templates/home.html')?.data).toEqual({
      relPath: 'templates/home.html',
      contentHash: expect.any(String),
      blocks: ['content'],
    });
    expect(hasEdge('export:webpkg/app_main/profile', 'template:templates/profile.html', 'renders')).toBe(true);
    expect(hasEdge('export:webpkg/urls/home', 'template:templates/home.html', 'renders')).toBe(true);
    expect(hasEdge('template:templates/home.html', 'template:templates/base.html', 'extends')).toBe(true);
    expect(hasEdge('template:templates/home.html', 'template:templates/partials/nav.html', 'includes')).toBe(true);
  });
});

describe('python extract subprocess failure (no interpreter needed)', () => {
  let tmpRoot: string;
  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'py-fail-'));
    fs.writeFileSync(path.join(tmpRoot, 'svc.py'), 'def run():\n    return 1\n');
  });
  afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  it('does not cache empty modules under the real content hash when the subprocess fails', async () => {
    const pkg: PackageInfo = { name: 'py-pkg', repoRelDir: asRepoRelPath('.'), sourcePluginId: 'python' };
    const filePath = path.join(tmpRoot, 'svc.py');
    const pending: PendingModule = {
      absPath: asHostPath(filePath),
      pkg,
      pkgRelPath: asPkgRelPath('svc.py'),
      moduleId: 'mod:py-pkg/svc',
      sourcePluginId: 'python',
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // Route through the engine extraction boundary: it reads svc.py, computes the real hash, and
      // (because the producer marks the delta transient on subprocess failure) stamps the empty
      // sentinel hash. This exercises the producer→engine anti-poison contract end-to-end.
      const result = await runSourceExtraction({
        plugin: pythonSourcePlugin,
        repoRoot: asHostPath(tmpRoot),
        packages: [pkg],
        pendingModules: [pending],
        prevByAbsPath: new Map(),
        absPathToId: new Map([[asHostPath(filePath), pending.moduleId]]),
        extractContext: { pythonBin: '/nonexistent/python-binary-for-test' },
        analysisVersion: 0,
      });
      expect(result.modules).toHaveLength(1);
      const mod = result.modules[0]!;
      expect(mod.imports).toEqual([]);
      expect(mod.exports).toEqual([]);
      // Sentinel hash: a later incremental run must re-parse instead of reusing the empty module.
      expect(mod.contentHash).toBe('');
    } finally {
      warn.mockRestore();
    }
  });
});

d('mixed TS + Python monorepo', () => {
  let tmpRoot: string;
  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-mixed-'));
    fs.mkdirSync(path.join(tmpRoot, 'ts/src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'ts/tsconfig.json'), JSON.stringify({ include: ['src'] }));
    fs.writeFileSync(path.join(tmpRoot, 'ts/package.json'), JSON.stringify({ name: 'ts-pkg' }));
    fs.writeFileSync(path.join(tmpRoot, 'ts/src/index.ts'), 'export const x = 1;\n');
    fs.mkdirSync(path.join(tmpRoot, 'py'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'py/pyproject.toml'), '[project]\nname = "py-pkg"\n');
    fs.writeFileSync(path.join(tmpRoot, 'py/svc.py'), 'def run():\n    return 1\n');
  });
  afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  it('places both languages in one snapshot, each tagged with its sourcePluginId', async () => {
    const snapshot = await collectRepositoryFactsAsync(tmpRoot);
    const byPlugin = new Map(snapshot.packages.map(p => [p.name, p.sourcePluginId]));
    expect(byPlugin.get('ts-pkg')).toBe('typescript');
    expect(byPlugin.get('py-pkg')).toBe('python');

    const ids = snapshot.modules.map(m => m.id);
    expect(ids).toContain('mod:ts-pkg/src');
    expect(ids).toContain('mod:py-pkg/svc');
  });
});
