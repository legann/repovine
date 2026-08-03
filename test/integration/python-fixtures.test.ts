/**
 * Integration tests: build a real snapshot + graph from each Python fixture and assert
 * against `expected.json` → `python` block (packages, modules, import edges, resolver).
 *
 * Mirror of runtime-links / service-links harnesses for IaC — auto-discovers fixture dirs
 * that declare a `python` section in expected.json.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../src/stage2/index.js';
import { CONFIG_DEFAULTS } from '../../src/config.js';
import { collectEntrypoints, inferFileBasedRoutes } from '../../src/mcp/lib/entrypoints.js';
import { detectPython } from '../../packages/plugins/source-python/src/discover.js';
import { inferredHintLeaks } from '../helpers/semantic-hints-tiers.js';
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

interface ExpectedPythonImport {
  moduleId: string;
  specifier: string;
  resolvedModuleId?: string;
  isExternal: boolean;
}

interface ExpectedPython {
  packages: string[];
  moduleIds: string[];
  importEdges: Array<{ from: string; to: string }>;
  resolvedImports?: ExpectedPythonImport[];
  externalImports?: Array<{ moduleId: string; specifier: string }>;
  tier3Empty?: boolean;
  /** Python semanticHints may carry only ast-provable facts (envVars, effectImports);
   * Tier-3 hint fields (routes/frontend/ssr/…) must be absent on every module. */
  factHintsOnly?: boolean;
  /** Expected envVars per module (modules not listed must have NO envVars hint). */
  envVars?: Array<{ moduleId: string; names: string[] }>;
  /** Expected effectImports kinds per module. */
  effectImports?: Array<{ moduleId: string; kinds: string[] }>;
  frameworks?: Array<{ moduleId: string; name: 'fastapi' | 'django' | 'drf' }>;
  routes?: Array<{
    moduleId: string;
    path: string;
    method?: string;
    component?: string;
    syntax?: 'decorator' | 'call';
  }>;
  entrypoints?: Array<{
    moduleId: string;
    path: string;
    method?: string;
    layer: string;
    kind: string;
  }>;
  /** Routes that must NOT appear (e.g. SimpleRouter without POST on list). */
  routesAbsent?: Array<{ moduleId: string; path: string; method?: string }>;
}

interface ExpectedFixture {
  _description?: string;
  python?: ExpectedPython;
}

function sorted(values: string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function listPythonFixtures(): string[] {
  return fs
    .readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => {
      const expectedPath = path.join(FIXTURES_ROOT, name, 'expected.json');
      if (!fs.existsSync(expectedPath)) return false;
      const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf-8')) as ExpectedFixture;
      return expected.python != null;
    });
}

function modulesById(snapshot: RepositoryFactsSnapshot): Map<string, ModuleInfo> {
  const out = new Map<string, ModuleInfo>();
  for (const mod of snapshot.modules) out.set(mod.id, mod);
  return out;
}

function hasImportEdge(graph: RepositoryGraph, from: string, to: string): boolean {
  return graph.edges.some(e => e.kind === 'imports' && e.from === from && e.to === to);
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

function snapshotFingerprint(snapshot: RepositoryFactsSnapshot): string {
  return snapshot.modules
    .map(
      m =>
        `${m.id}@${m.contentHash}|${m.imports.map(i => `${i.moduleSpecifier}:${i.resolvedModuleId ?? ''}:${i.isExternal}`).join(',')}`,
    )
    .sort()
    .join('\n');
}

d('Python source plugin — fixture suite', () => {
  const fixtures = listPythonFixtures();
  if (fixtures.length === 0) {
    it('has at least one python fixture', () => {
      throw new Error('No fixtures with python block in expected.json');
    });
    return;
  }

  describe.each(fixtures)('%s', fixtureName => {
    const fixtureRoot = path.join(FIXTURES_ROOT, fixtureName);
    const expected = JSON.parse(
      fs.readFileSync(path.join(fixtureRoot, 'expected.json'), 'utf-8'),
    ) as ExpectedFixture;
    const python = expected.python!;

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

    it('discovers the expected Python packages', () => {
      const names = sorted(snapshot.packages.map(p => p.name));
      expect(names).toEqual(sorted(python.packages));
      expect(snapshot.packages.every(p => p.sourcePluginId === 'python')).toBe(true);
    });

    it('emits exactly the expected module ids', () => {
      expect(sorted(snapshot.modules.map(m => m.id))).toEqual(sorted(python.moduleIds));
    });

    it('builds the expected imports edges in Stage 2', () => {
      for (const edge of python.importEdges) {
        expect(hasImportEdge(graph, edge.from, edge.to)).toBe(true);
      }
    });

    it('resolves imports as declared in expected.json', () => {
      const mods = modulesById(snapshot);
      for (const imp of python.resolvedImports ?? []) {
        const mod = mods.get(imp.moduleId);
        expect(mod).toBeDefined();
        const found = mod!.imports.find(i => i.moduleSpecifier === imp.specifier);
        expect(found).toBeDefined();
        expect(found!.resolvedModuleId).toBe(imp.resolvedModuleId);
        expect(found!.isExternal).toBe(imp.isExternal);
      }
      for (const ext of python.externalImports ?? []) {
        const mod = mods.get(ext.moduleId);
        expect(mod).toBeDefined();
        const found = mod!.imports.find(i => i.moduleSpecifier === ext.specifier);
        expect(found?.isExternal).toBe(true);
        expect(found?.resolvedModuleId).toBeUndefined();
      }
    });

    it('is deterministic — repeated snapshots match', async () => {
      const again = await collectRepositoryFactsAsync(fixtureRoot);
      expect(snapshotFingerprint(again)).toBe(snapshotFingerprint(snapshot));
    });

    if (python.factHintsOnly) {
      it('carries only ast-provable semanticHints (no inferred Tier-3 fields) on Python modules', () => {
        // Forbidden set is derived from the versioned hints schema (every slot except the ast-provable
        // fact-hints), so it cannot drift onto a phantom field or miss a newly added inferred slot.
        expect(snapshot.modules.some(mod => mod.semanticHints)).toBe(true); // non-vacuous
        expect(inferredHintLeaks(snapshot.modules)).toEqual([]);
      });
    }

    if (python.envVars) {
      it('extracts literal env var access into semanticHints.envVars', () => {
        const mods = modulesById(snapshot);
        const declared = new Map(python.envVars!.map(e => [e.moduleId, sorted(e.names)]));
        for (const [moduleId, names] of declared) {
          expect(sorted(mods.get(moduleId)?.semanticHints?.envVars ?? [])).toEqual(names);
        }
        for (const mod of snapshot.modules) {
          if (!declared.has(mod.id)) expect(mod.semanticHints?.envVars).toBeUndefined();
        }
      });
    }

    if (python.effectImports) {
      it('maps unambiguous effect imports into semanticHints.effectImports', () => {
        const mods = modulesById(snapshot);
        for (const expected of python.effectImports!) {
          const actual = mods.get(expected.moduleId)?.semanticHints?.effectImports ?? [];
          expect(sorted(actual.map(e => e.kind))).toEqual(sorted(expected.kinds));
        }
      });
    }

    if (python.tier3Empty) {
      it('produces no false file-based frontend routes', () => {
        expect(inferFileBasedRoutes(snapshot)).toEqual([]);
      });
    }

    if (python.frameworks) {
      const expectedFrameworks = python.frameworks;
      it('detects web frameworks from imports', () => {
        const mods = modulesById(snapshot);
        for (const fw of expectedFrameworks) {
          expect(mods.get(fw.moduleId)?.semanticHints?.webFramework).toBe(fw.name);
        }
      });
    }

    if (python.routes) {
      const expectedRoutes = python.routes;
      it('extracts FastAPI/Django API routes into semanticHints.routes', () => {
        const mods = modulesById(snapshot);
        for (const expectedRoute of expectedRoutes) {
          const mod = mods.get(expectedRoute.moduleId);
          expect(mod?.semanticHints?.hasRoutes).toBe(true);
          const routes = mod?.semanticHints?.routes ?? [];
          const found = routes.find(
            r =>
              r.path === expectedRoute.path &&
              (expectedRoute.method ? r.method === expectedRoute.method : true) &&
              (expectedRoute.component ? r.component === expectedRoute.component : true),
          );
          expect(found).toBeDefined();
          if (expectedRoute.syntax) expect(found?.syntax).toBe(expectedRoute.syntax);
          expect(found?.kind).toBe('api');
        }
      });
    }

    if (python.routesAbsent) {
      it('does not emit routes declared absent in expected.json', () => {
        const mods = modulesById(snapshot);
        for (const absent of python.routesAbsent!) {
          const routes = mods.get(absent.moduleId)?.semanticHints?.routes ?? [];
          const found = routes.find(
            r =>
              r.path === absent.path &&
              (absent.method ? r.method === absent.method : true),
          );
          expect(found).toBeUndefined();
        }
      });
    }

    if (python.entrypoints) {
      const expectedEntrypoints = python.entrypoints;
      it('surfaces backend API routes via collectEntrypoints', () => {
        const { items } = collectEntrypoints(entrypointCtx(snapshot, graph), {
          layer: 'backend',
          kind: 'api',
          limit: 200,
        });
        for (const expected of expectedEntrypoints) {
          const found = items.find(
            item =>
              item.moduleId === expected.moduleId &&
              item.path === expected.path &&
              item.layer === expected.layer &&
              item.kind === expected.kind &&
              (expected.method ? item.method === expected.method : true),
          );
          expect(found).toBeDefined();
        }
      });
    }
  });
});
