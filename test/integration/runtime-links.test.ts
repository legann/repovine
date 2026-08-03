/**
 * Integration tests: runtime linking (Lambda handler, K8s image→Dockerfile, Helm values, compose→Dockerfile).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../src/stage2/index.js';
import type { RepositoryGraph, RepositoryFactsSnapshot } from '../../src/types.js';

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

interface ExpectedRuntimeLink {
  fromServiceLabel: string;
  fromServiceKind?: string;
  fromServiceProvider?: string;
  toDockerfileSuffix?: string;
  toModuleSuffix?: string;
}

interface ExpectedFixture {
  _description?: string;
  linking?: NonNullable<RepositoryFactsSnapshot['linkingConfig']>;
  runtimeLinks?: ExpectedRuntimeLink[];
}

function listRuntimeFixtures(): string[] {
  return fs
    .readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => {
      const expectedPath = path.join(FIXTURES_ROOT, name, 'expected.json');
      if (!fs.existsSync(expectedPath)) return false;
      const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf-8')) as ExpectedFixture;
      return (expected.runtimeLinks?.length ?? 0) > 0;
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

function hasInfraLinkToSuffix(graph: RepositoryGraph, fromServiceId: string, suffix: string): boolean {
  const out = graph.outEdges.get(fromServiceId) ?? [];
  for (const edge of out) {
    if (edge.kind !== 'infra') continue;
    if (edge.to.includes(suffix)) return true;
  }
  return false;
}

describe('runtime links — fixture suite', () => {
  const fixtures = listRuntimeFixtures();
  if (fixtures.length === 0) {
    it('has at least one runtime-link fixture', () => {
      throw new Error('No fixtures with runtimeLinks in expected.json');
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
        const snapshot = await collectRepositoryFactsAsync(fixtureRoot, {
          linking: expected.linking,
        });
        graph = composeRepositoryGraph(snapshot);
      } finally {
        console.log = origLog;
      }
    });

    for (const link of expected.runtimeLinks ?? []) {
      const target = link.toDockerfileSuffix ?? link.toModuleSuffix;
      const kind = link.toDockerfileSuffix ? 'Dockerfile' : 'module';
      it(`links ${link.fromServiceLabel} → ${kind} (*${target})`, () => {
        const serviceId = serviceIdByLabel(
          graph,
          link.fromServiceLabel,
          link.fromServiceKind,
          link.fromServiceProvider,
        );
        expect(serviceId).toBeDefined();
        expect(hasInfraLinkToSuffix(graph, serviceId!, target!)).toBe(true);
      });
    }
  });
});
