/**
 * Integration tests: build a real snapshot + graph from each fixture project and assert that
 * the domain heuristic produces the expected classification for that JS/TS stack convention.
 *
 * Each fixture is a self-contained mini-project (package.json + tsconfig.json + src tree).
 * `expected.json` lists what the heuristic must produce for that layout — used as a regression
 * net for future heuristic tweaks.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../src/stage2/index.js';
import { collectEntrypoints } from '../../src/mcp/lib/entrypoints.js';
import type { McpToolRuntime } from '../../src/mcp/types.js';
import type { ModuleInfo, RepositoryFactsSnapshot, RepositoryGraph } from '../../src/types.js';

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

interface ExpectedDomains {
  _description?: string;
  heavyDomains?: string[];
  lightweightDomains?: string[];
  rejectedAsDomain?: string[];
  modulesInDomain?: Record<string, string[]>;
  /** Runtime-resource nodes that must exist in the graph after stage2 (e.g. Terraform/SAM resources). */
  runtimeResourceNodes?: Array<{ label: string; kind?: string; k8sKind?: string; provider?: string }>;
  /** Execution entrypoints the fixture must surface (get_entrypoints contract): routes/apis with layer + method. */
  entrypoints?: Array<{ path: string; kind: string; layer: string; method?: string }>;
  /** Named documentation-derived edge-case groups, kept distinct in the fixture oracle. */
  entrypointEdgeCases?: Record<string, Array<{ path: string; kind: string; layer: string; method?: string }>>;
}

function makeEntrypointCtx(graph: RepositoryGraph, snapshot: RepositoryFactsSnapshot): McpToolRuntime {
  const modulesById = new Map<string, ModuleInfo>(snapshot.modules.map(m => [m.id, m]));
  return {
    getState: () => ({ graph, snapshot, modulesById }),
    refreshRepoState: () => undefined,
    repoRoot: snapshot.repoRoot,
  } as unknown as McpToolRuntime;
}

interface EntrypointShape { path: string; kind: string; layer: string; method?: string }

/** Project an entrypoint to the stable contract fields and sort deterministically for comparison. */
function projectEntrypoints(items: Array<Record<string, unknown>>): EntrypointShape[] {
  return items
    .map((e): EntrypointShape => ({
      path: String(e.path),
      kind: String(e.kind),
      layer: String(e.layer),
      ...(e.method ? { method: String(e.method) } : {}),
    }))
    .sort((a, b) => `${a.path}:${a.kind}:${a.layer}:${a.method ?? ''}`.localeCompare(`${b.path}:${b.kind}:${b.layer}:${b.method ?? ''}`));
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function kebabLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function listFixtures(): string[] {
  return fs
    .readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => {
      const expectedPath = path.join(FIXTURES_ROOT, name, 'expected.json');
      if (!fs.existsSync(expectedPath)) return false;
      const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf-8')) as {
        python?: unknown;
        polyglot?: unknown;
        modules?: unknown;
      };
      // Python fixtures use test/integration/python-fixtures.test.ts (different contract).
      // Root TS+Python fixtures use test/integration/root-ts-python-fixtures.test.ts.
      // Stage-1 discovery fixtures use test/unit/stage1/packages.test.ts.
      return expected.python == null && expected.polyglot == null && expected.modules == null;
    });
}

/** Collect domain labels by weight. */
function collectDomainsByWeight(graph: RepositoryGraph): { heavy: Set<string>; lightweight: Set<string>; all: Set<string> } {
  const heavy = new Set<string>();
  const lightweight = new Set<string>();
  const all = new Set<string>();
  const domainIds = graph.byType.get('domain') ?? new Set();
  for (const id of domainIds) {
    const node = graph.nodes.get(id);
    if (!node || node.type !== 'domain') continue;
    all.add(node.label);
    if (node.data?.weight === 'lightweight') lightweight.add(node.label);
    else heavy.add(node.label);
  }
  return { heavy, lightweight, all };
}

/** Return all module relativeFilePaths tagged with the given domain. */
function modulesInDomain(graph: RepositoryGraph, domainLabel: string): string[] {
  const domainId = `domain:${domainLabel}`;
  const incoming = graph.inEdges.get(domainId) ?? [];
  const out: string[] = [];
  for (const edge of incoming) {
    if (edge.kind !== 'tagged') continue;
    const node = graph.nodes.get(edge.from);
    if (!node || node.type !== 'module') continue;
    const relPath = node.data && 'relativeFilePath' in node.data ? (node.data as { relativeFilePath?: string }).relativeFilePath : undefined;
    if (relPath) out.push(relPath);
  }
  return out;
}

describe('Domain heuristic — fixture suite', () => {
  const fixtures = listFixtures();
  if (fixtures.length === 0) {
    it('has at least one fixture', () => {
      throw new Error('No fixtures found under test/fixtures/');
    });
    return;
  }

  describe.each(fixtures)('%s', (fixtureName) => {
    const fixtureRoot = path.join(FIXTURES_ROOT, fixtureName);
    const expected = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'expected.json'), 'utf-8')) as ExpectedDomains;

    let graph: RepositoryGraph;
    let snapshot: RepositoryFactsSnapshot;
    let domains: ReturnType<typeof collectDomainsByWeight>;

    beforeAll(async () => {
      // Silence the noisy `Domains: N` log from stage2 (still prints to stderr from ts-morph itself).
      const origLog = console.log;
      console.log = () => {};
      try {
        snapshot = await collectRepositoryFactsAsync(fixtureRoot);
        graph = composeRepositoryGraph(snapshot);
        domains = collectDomainsByWeight(graph);
      } finally {
        console.log = origLog;
      }
    });

    it('produces exactly the expected heavy domains', () => {
      expect(sorted(domains.heavy)).toEqual(sorted(expected.heavyDomains ?? []));
    });

    it('produces exactly the expected lightweight domains', () => {
      expect(sorted(domains.lightweight)).toEqual(sorted(expected.lightweightDomains ?? []));
    });

    it('rejects basenames that must not become a domain', () => {
      for (const r of expected.rejectedAsDomain ?? []) {
        // The forbidden name must not appear in any domain (heavy or lightweight).
        const candidates = new Set([r, r.toLowerCase(), kebabLabel(r)].filter(Boolean));
        const matches = [...candidates].filter(candidate => domains.all.has(candidate));
        expect({ name: r, matches }).toEqual({ name: r, matches: [] });
      }
    });

    it('tags each listed domain with exactly the expected modules', () => {
      for (const [domain, modules] of Object.entries(expected.modulesInDomain ?? {})) {
        const actual = modulesInDomain(graph, domain);
        expect({ domain, modules: sorted(actual) }).toEqual({ domain, modules: sorted(modules) });
      }
    });

    it('surfaces exactly the expected entrypoints (routes/apis with layer + method)', () => {
      if (!expected.entrypoints && !expected.entrypointEdgeCases) return;
      const items = collectEntrypoints(makeEntrypointCtx(graph, snapshot), { scope: 'all', limit: 200 }).items;
      const edgeCases = Object.values(expected.entrypointEdgeCases ?? {}).flat();
      const expectedItems = [...(expected.entrypoints ?? []), ...edgeCases];
      expect(projectEntrypoints(items)).toEqual(projectEntrypoints(expectedItems as Array<Record<string, unknown>>));
      expect(items.filter(item => Object.keys(item).some(key => key.startsWith('__repovine')))).toEqual([]);
    });

    it('creates exactly the expected runtime-resource nodes from IaC resources', () => {
      const expectedNodes = expected.runtimeResourceNodes ?? [];
      const serviceIds = graph.byType.get('runtime-resource') ?? new Set();
      const actual: Array<{ label: string; kind?: string; k8sKind?: string; provider?: string }> = [];
      for (const id of serviceIds) {
        const n = graph.nodes.get(id);
        if (!n || n.type !== 'runtime-resource') continue;
        const data = (n.data ?? {}) as { kind?: string; k8sKind?: string; provider?: string };
        actual.push({
          label: n.label,
          kind: data.kind,
          ...(data.k8sKind ? { k8sKind: data.k8sKind } : {}),
          provider: data.provider,
        });
      }
      const order = (
        a: { label: string; provider?: string; kind?: string; k8sKind?: string },
        b: { label: string; provider?: string; kind?: string; k8sKind?: string },
      ) => `${a.provider ?? ''}:${a.kind ?? ''}:${a.k8sKind ?? ''}:${a.label}`
        .localeCompare(`${b.provider ?? ''}:${b.kind ?? ''}:${b.k8sKind ?? ''}:${b.label}`);
      expect(actual.sort(order)).toEqual([...expectedNodes].sort(order));
    });
  });
});
