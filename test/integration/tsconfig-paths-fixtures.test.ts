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
  codeEdges: Array<{ from: string; to: string; kind: 'imports' | 'reexports' }>;
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

interface CodeEdge {
  from: string;
  to: string;
  kind: 'imports' | 'reexports';
}

function projectCodeEdges(graph: RepositoryGraph): CodeEdge[] {
  return graph.edges
    .filter((edge): edge is typeof edge & CodeEdge => {
      if (edge.kind !== 'imports' && edge.kind !== 'reexports') return false;
      return graph.nodes.get(edge.from)?.type === 'module' && graph.nodes.get(edge.to)?.type === 'module';
    })
    .map(({ from, to, kind }) => ({ from, to, kind }))
    .sort((a, b) => `${a.from}:${a.to}:${a.kind}`.localeCompare(`${b.from}:${b.to}:${b.kind}`));
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

    it('emits exactly the hand-derived module code edges declared in expected.json', () => {
      const expectedEdges = [...typescript.codeEdges]
        .sort((a, b) => `${a.from}:${a.to}:${a.kind}`.localeCompare(`${b.from}:${b.to}:${b.kind}`));
      expect(projectCodeEdges(graph)).toEqual(expectedEdges);
    });
  });
});
