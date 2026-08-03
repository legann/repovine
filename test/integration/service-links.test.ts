/**
 * Integration tests: service-to-service edges (e.g. Ingress → backend Service).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../src/stage2/index.js';
import type { EdgeKind, RepositoryGraph } from '../../src/types.js';

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

interface ExpectedServiceLink {
  fromServiceLabel: string;
  fromServiceKind?: string;
  fromServiceProvider?: string;
  toServiceLabel: string;
  toServiceKind?: string;
  toServiceProvider?: string;
  edge: EdgeKind;
}

interface ExpectedFixture {
  serviceLinks?: ExpectedServiceLink[];
}

function listServiceLinkFixtures(): string[] {
  return fs
    .readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => {
      const expectedPath = path.join(FIXTURES_ROOT, name, 'expected.json');
      if (!fs.existsSync(expectedPath)) return false;
      const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf-8')) as ExpectedFixture;
      return (expected.serviceLinks?.length ?? 0) > 0;
    });
}

function serviceIdByLabel(
  graph: RepositoryGraph,
  label: string,
  kind?: string,
  provider?: string,
): string | undefined {
  for (const id of graph.byType.get('runtime-resource') ?? []) {
    const node = graph.nodes.get(id);
    if (node?.type !== 'runtime-resource' || node.label !== label) continue;
    const data = (node.data ?? {}) as { kind?: string; provider?: string };
    if (kind && data.kind !== kind) continue;
    if (provider && data.provider !== provider) continue;
    return id;
  }
  return undefined;
}

function hasEdge(graph: RepositoryGraph, from: string, to: string, kind: EdgeKind): boolean {
  return (graph.outEdges.get(from) ?? []).some(e => e.kind === kind && e.to === to);
}

describe('service links — fixture suite', () => {
  const fixtures = listServiceLinkFixtures();
  if (fixtures.length === 0) {
    it('has at least one service-link fixture', () => {
      throw new Error('No fixtures with serviceLinks in expected.json');
    });
    return;
  }

  describe.each(fixtures)('%s', (fixtureName) => {
    const fixtureRoot = path.join(FIXTURES_ROOT, fixtureName);
    const expected = JSON.parse(
      fs.readFileSync(path.join(fixtureRoot, 'expected.json'), 'utf-8'),
    ) as ExpectedFixture;

    let graph: RepositoryGraph;

    beforeAll(async () => {
      const origLog = console.log;
      console.log = () => {};
      try {
        graph = composeRepositoryGraph(await collectRepositoryFactsAsync(fixtureRoot));
      } finally {
        console.log = origLog;
      }
    });

    for (const link of expected.serviceLinks ?? []) {
      it(`links ${link.fromServiceLabel} → ${link.toServiceLabel} (${link.edge})`, () => {
        const fromId = serviceIdByLabel(
          graph,
          link.fromServiceLabel,
          link.fromServiceKind,
          link.fromServiceProvider,
        );
        const toId = serviceIdByLabel(
          graph,
          link.toServiceLabel,
          link.toServiceKind,
          link.toServiceProvider,
        );
        expect(fromId).toBeDefined();
        expect(toId).toBeDefined();
        expect(hasEdge(graph, fromId!, toId!, link.edge)).toBe(true);
      });
    }
  });
});
