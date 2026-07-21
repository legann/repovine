/**
 * Integration tests: assert tsconfig `paths` alias resolution for fixtures that declare
 * an `expected.json` → `typescript` block (import edges + resolvedImports).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../src/stage2/index.js';
import type { ModuleInfo, RepositoryGraph, RepositoryFactsSnapshot } from '../../src/types.js';

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

interface ExpectedTypescriptImport {
  moduleId: string;
  specifier: string;
  resolvedModuleId?: string;
  isExternal: boolean;
}

interface ExpectedTypescript {
  importEdges: Array<{ from: string; to: string }>;
  reExportEdges?: Array<{ from: string; to: string }>;
  redirectedImportEdges?: Array<{ from: string; to: string; usedNames: string[] }>;
  resolvedImports: ExpectedTypescriptImport[];
}

interface ExpectedFixture {
  typescript?: ExpectedTypescript;
}

function listFixtures(): string[] {
  return fs
    .readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => {
      const expectedPath = path.join(FIXTURES_ROOT, name, 'expected.json');
      if (!fs.existsSync(expectedPath)) return false;
      const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf-8')) as ExpectedFixture;
      return expected.typescript != null;
    })
    .sort();
}

function graphImportEdges(graph: RepositoryGraph): Set<string> {
  const edges = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'imports') continue;
    edges.add(`${edge.from}\t${edge.to}`);
  }
  return edges;
}

describe('tsconfig paths — fixture suite', () => {
  const fixtures = listFixtures();
  if (fixtures.length === 0) {
    it('has at least one fixture with typescript block', () => {
      throw new Error('No fixtures with typescript block in expected.json');
    });
    return;
  }

  describe.each(fixtures)('%s', (fixtureName) => {
    const fixtureRoot = path.join(FIXTURES_ROOT, fixtureName);
    const expected = JSON.parse(
      fs.readFileSync(path.join(fixtureRoot, 'expected.json'), 'utf-8'),
    ) as ExpectedFixture;
    const typescript = expected.typescript!;

    let snapshot: RepositoryFactsSnapshot;
    let graph: RepositoryGraph;
    let modulesById: Map<string, ModuleInfo>;

    beforeAll(async () => {
      const origLog = console.log;
      console.log = () => {};
      try {
        snapshot = await collectRepositoryFactsAsync(fixtureRoot);
        graph = composeRepositoryGraph(snapshot);
        modulesById = new Map(snapshot.modules.map(m => [m.id, m]));
      } finally {
        console.log = origLog;
      }
    });

    it('resolves imports as declared in expected.json', () => {
      for (const imp of typescript.resolvedImports) {
        const mod = modulesById.get(imp.moduleId);
        expect(mod).toBeDefined();
        const found = mod!.imports.find(i => i.moduleSpecifier === imp.specifier);
        expect(found).toBeDefined();
        expect(found!.resolvedModuleId).toBe(imp.resolvedModuleId);
        expect(found!.isExternal).toBe(imp.isExternal);
      }
    });

    it('emits import graph edges as declared in expected.json', () => {
      const edges = graphImportEdges(graph);
      for (const { from, to } of typescript.importEdges) {
        expect(edges.has(`${from}\t${to}`)).toBe(true);
      }
    });

    it('emits re-export graph edges as declared in expected.json', () => {
      const edges = new Set(
        graph.edges
          .filter(edge => edge.kind === 'reexports')
          .map(edge => `${edge.from}\t${edge.to}`),
      );
      for (const { from, to } of typescript.reExportEdges ?? []) {
        expect(edges.has(`${from}\t${to}`)).toBe(true);
      }
    });

    it('emits barrel-redirected import edges with used names as declared in expected.json', () => {
      for (const { from, to, usedNames } of typescript.redirectedImportEdges ?? []) {
        const edge = graph.edges.find(item => item.kind === 'imports' && item.from === from && item.to === to);
        expect(edge).toBeDefined();
        expect(edge?.metadata?.usedNames).toEqual(usedNames);
      }
    });
  });
});
