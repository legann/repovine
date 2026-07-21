/**
 * Integration tests: root-level TS+Python fixtures (colliding package name at repo root).
 * Auto-discovers fixture dirs that declare a `polyglot` section in expected.json.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../src/stage2/index.js';
import { CONFIG_DEFAULTS } from '../../src/config.js';
import { collectEntrypoints } from '../../src/mcp/lib/entrypoints.js';
import { detectPython } from '../../src/source-plugins/python/discover.js';
import type { AnnotationStore } from '../../src/annotations/store.js';
import type { RefactoringThresholds } from '../../src/analysis/architecture/config.js';
import type { ModuleInfo, RepositoryGraph, RepositoryFactsSnapshot } from '../../src/types.js';
import type { McpToolRuntime } from '../../src/mcp/types.js';

function findFixturesRoot(): string {
  const candidates = [
    path.resolve(process.cwd(), 'test', 'fixtures'),
    path.resolve(process.cwd(), 'repovine', 'test', 'fixtures'),
  ];
  const root = candidates.find(candidate => fs.existsSync(candidate));
  if (!root) throw new Error(`Could not find test fixtures root. Tried: ${candidates.join(', ')}`);
  return root;
}

const FIXTURES_ROOT = findFixturesRoot();
const PYTHON_AVAILABLE = detectPython() !== null;
const d = PYTHON_AVAILABLE ? describe : describe.skip;

interface ExpectedPolyglot {
  packageName: string;
  tsModuleIds: string[];
  pythonModuleIds: string[];
  pythonPackages?: string[];
  routes?: Array<{
    moduleId: string;
    path: string;
    method?: string;
    source?: 'decorator' | 'ast';
  }>;
  entrypoints?: Array<{
    moduleId: string;
    path: string;
    method?: string;
    layer: string;
    kind: string;
    source?: string;
  }>;
}

interface ExpectedFixture {
  _description?: string;
  polyglot?: ExpectedPolyglot;
}

function sorted(values: string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function listPolyglotFixtures(): string[] {
  return fs
    .readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => {
      const expectedPath = path.join(FIXTURES_ROOT, name, 'expected.json');
      if (!fs.existsSync(expectedPath)) return false;
      const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf-8')) as ExpectedFixture;
      return expected.polyglot != null;
    });
}

function modulesById(snapshot: RepositoryFactsSnapshot): Map<string, ModuleInfo> {
  const out = new Map<string, ModuleInfo>();
  for (const mod of snapshot.modules) out.set(mod.id, mod);
  return out;
}

function entrypointCtx(snapshot: RepositoryFactsSnapshot, graph: RepositoryGraph): McpToolRuntime {
  const modulesById = new Map(snapshot.modules.map(m => [m.id, m]));
  return {
    repoRoot: '/',
    refreshRepoState: () => {},
    getConfig: () => CONFIG_DEFAULTS,
    getState: () => ({
      graph,
      snapshot,
      modulesById,
      searchIndex: { tokens: new Map(), annotationText: new Map() },
      semanticIndex: null,
      semanticSearchRefresh: { status: 'disabled' },
      annotations: { getAll: () => ({}) } as unknown as AnnotationStore,
      domainsConfig: null,
      domainsSuggestions: { additions: [], count: 0, axes: [], declinedHidden: 0, mergedConfig: {}, keepConfig: {} },
      refactoringThresholds: {} as RefactoringThresholds,
      builtAt: '',
    }),
  };
}

d('Root TS+Python fixtures — colliding package name at repo root', () => {
  const fixtures = listPolyglotFixtures();
  if (fixtures.length === 0) {
    it('has at least one polyglot fixture', () => {
      throw new Error('No fixtures with polyglot block in expected.json');
    });
    return;
  }

  describe.each(fixtures)('%s', fixtureName => {
    const fixtureRoot = path.join(FIXTURES_ROOT, fixtureName);
    const expected = JSON.parse(
      fs.readFileSync(path.join(fixtureRoot, 'expected.json'), 'utf-8'),
    ) as ExpectedFixture;
    const polyglot = expected.polyglot!;

    let snapshot: RepositoryFactsSnapshot;
    let graph: RepositoryGraph;

    beforeAll(async () => {
      const origLog = console.log;
      console.log = () => {};
      try {
        snapshot = await collectRepositoryFactsAsync(fixtureRoot);
        graph = composeRepositoryGraph(snapshot);
      } finally {
        console.log = origLog;
      }
    });

    it('discovers both TypeScript and Python packages at the same name', () => {
      const sameName = snapshot.packages.filter(p => p.name === polyglot.packageName);
      const pluginIds = sorted(sameName.map(p => p.sourcePluginId ?? ''));
      expect(pluginIds).toEqual(sorted(['python', 'typescript']));
    });

    it('includes both TS and Python modules in the snapshot', () => {
      const moduleIds = sorted(snapshot.modules.map(m => m.id));
      for (const id of polyglot.tsModuleIds) {
        expect(moduleIds).toContain(id);
      }
      for (const id of polyglot.pythonModuleIds) {
        expect(moduleIds).toContain(id);
      }
    });

    it('materializes graph nodes for both ecosystems', () => {
      for (const id of [...polyglot.tsModuleIds, ...polyglot.pythonModuleIds]) {
        expect(graph.nodes.has(id)).toBe(true);
      }
    });

    if (polyglot.pythonPackages) {
      const expectedPythonPackages = polyglot.pythonPackages;
      it('registers Python packages from the python plugin', () => {
        const pyNames = sorted(
          snapshot.packages.filter(p => p.sourcePluginId === 'python').map(p => p.name),
        );
        expect(pyNames).toEqual(sorted(expectedPythonPackages));
      });
    }

    if (polyglot.routes) {
      const expectedRoutes = polyglot.routes;
      it('extracts Django routes into semanticHints.routes', () => {
        const mods = modulesById(snapshot);
        for (const expectedRoute of expectedRoutes) {
          const mod = mods.get(expectedRoute.moduleId);
          expect(mod?.semanticHints?.hasRoutes).toBe(true);
          const routes = mod?.semanticHints?.routes ?? [];
          const found = routes.find(
            r =>
              r.path === expectedRoute.path &&
              (expectedRoute.method ? r.method === expectedRoute.method : true),
          );
          expect(found).toBeDefined();
          if (expectedRoute.source) expect(found?.source).toBe(expectedRoute.source);
        }
      });
    }

    if (polyglot.entrypoints) {
      const expectedEntrypoints = polyglot.entrypoints;
      it('surfaces typed entrypoints via collectEntrypoints', () => {
        for (const expected of expectedEntrypoints) {
          const layer = expected.layer;
          const kind = expected.kind;
          const { items } = collectEntrypoints(entrypointCtx(snapshot, graph), {
            layer,
            kind: kind === 'route' ? 'route' : kind,
            limit: 200,
          });
          const found = items.find(
            item =>
              item.moduleId === expected.moduleId &&
              item.path === expected.path &&
              item.layer === expected.layer &&
              item.kind === expected.kind &&
              (expected.method ? item.method === expected.method : true) &&
              (expected.source ? item.source === expected.source : true),
          );
          expect(found).toBeDefined();
        }
      });
    }
  });
});
