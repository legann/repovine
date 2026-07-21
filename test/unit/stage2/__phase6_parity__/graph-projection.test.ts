/**
 * Parity harness.
 *
 * Freezes a deterministic, *observable* projection of composeRepositoryGraph + MCP surfaces for the
 * full fixture corpus, so the structural / infra-link / frontend-routes lift-and-shift can be
 * proven byte-identical. The projection deliberately captures the surfaces that are actually
 * visible to MCP consumers — not raw graph.edges insertion order, which is invisible
 * (getLinks excludes `contains`, getChildren only reads `contains`, byType keeps per-type order):
 *
 *  - stats                : node/edge counts by type/kind
 *  - byType               : per-type id list in Set-iteration order (drives handler iteration)
 *  - nodes                : every node sorted by id with full public data (content parity)
 *  - links                : per node, getLinks order + getChildren order (visible edge order)
 *  - entrypoints          : collectEntrypoints({scope:'all'}) item order (get_entrypoints surface)
 *
 * Regenerate goldens (only against trusted, green baseline) with:
 *   PHASE6_UPDATE=1 npm test -- --runTestsByPath test/unit/stage2/__phase6_parity__/graph-projection.test.ts
 */
import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../../../src/stage2/index.js';
import { buildNodeView, getChildren, getLinks } from '../../../../src/graph/index.js';
import { collectEntrypoints } from '../../../../src/mcp/lib/entrypoints.js';
import type { McpToolRuntime } from '../../../../src/mcp/types.js';
import type { ModuleInfo, NodeType, RepositoryGraph, RepositoryFactsSnapshot } from '../../../../src/types.js';

function findParityDir(): string {
  const candidates = [
    path.resolve(process.cwd(), 'test', 'unit', 'stage2', '__phase6_parity__'),
    path.resolve(process.cwd(), 'repovine', 'test', 'unit', 'stage2', '__phase6_parity__'),
  ];
  const dir = candidates.find(candidate => fs.existsSync(candidate));
  if (!dir) throw new Error(`Could not find phase6 parity dir. Tried: ${candidates.join(', ')}`);
  return dir;
}

const HERE = findParityDir();
const UPDATE = process.env.PHASE6_UPDATE === '1';

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

function listFixtures(): string[] {
  return fs
    .readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => fs.existsSync(path.join(FIXTURES_ROOT, name, 'expected.json')))
    .sort();
}

function makeCtx(graph: RepositoryGraph, snapshot: RepositoryFactsSnapshot): McpToolRuntime {
  const modulesById = new Map<string, ModuleInfo>(snapshot.modules.map(m => [m.id, m]));
  return {
    getState: () => ({ graph, snapshot, modulesById }),
    refreshRepoState: () => undefined,
    repoRoot: snapshot.repoRoot,
  } as unknown as McpToolRuntime;
}

function projectGraph(graph: RepositoryGraph, ctx: McpToolRuntime): unknown {
  const stats = {
    totalNodes: graph.nodes.size,
    totalEdges: graph.edges.length,
    nodesByType: Object.fromEntries(
      [...graph.byType.entries()]
        .map(([type, ids]): [NodeType, number] => [type, ids.size])
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    edgesByKind: countBy(graph.edges.map(e => e.kind)),
  };

  // Per-type Set iteration order — load-bearing for handler iteration (services, domains, …).
  const byType: Record<string, string[]> = {};
  for (const [type, ids] of [...graph.byType.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    byType[type] = [...ids];
  }

  // Content parity: every node sorted by id with full public shape.
  const nodeIds = [...graph.nodes.keys()].sort((a, b) => a.localeCompare(b));
  const nodes = nodeIds.map(id => {
    const n = graph.nodes.get(id)!;
    return { id: n.id, type: n.type, label: n.label, description: n.description, data: n.data ?? null };
  });

  // Visible edge order: getLinks (non-contains, outEdge order) + getChildren (contains order).
  const links = nodeIds.map(id => ({
    id,
    links: getLinks(graph, id).map(l => ({ to: l.targetId, kind: l.relation, ...(l.tagSource ? { tagSource: l.tagSource } : {}) })),
    children: getChildren(graph, id).map(c => c.id),
    view: stableView(buildNodeView(graph, id)),
  }));

  const entrypoints = collectEntrypoints(ctx, { scope: 'all', limit: 99999 }).items;

  return { stats, byType, nodes, links, entrypoints };
}

/** Trim NodeView to the fields exercised by MCP map/inspect output. */
function stableView(view: ReturnType<typeof buildNodeView>): unknown {
  if (!view) return null;
  return {
    id: view.id,
    level: view.level,
    drill_down: view.drill_down.map(d => ({ id: d.id, type: d.type })),
    links: (view.links ?? []).map(l => ({ to: l.targetId, kind: l.relation })),
    ...(view.envVars ? { envVars: view.envVars } : {}),
    ...(view.hasRoutes ? { hasRoutes: view.hasRoutes } : {}),
    ...(view.sourcePluginId ? { sourcePluginId: view.sourcePluginId } : {}),
  };
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

describe('phase6 graph projection parity', () => {
  const fixtures = listFixtures();
  if (fixtures.length === 0) {
    it('has at least one fixture', () => {
      throw new Error('No fixtures with expected.json found under test/fixtures/');
    });
    return;
  }

  describe.each(fixtures)('%s', (fixtureName) => {
    it('matches frozen observable projection', async () => {
      const fixtureRoot = path.join(FIXTURES_ROOT, fixtureName);
      const origLog = console.log;
      console.log = () => {};
      let projection: unknown;
      try {
        const snapshot = await collectRepositoryFactsAsync(fixtureRoot);
        const graph = composeRepositoryGraph(snapshot);
        projection = projectGraph(graph, makeCtx(graph, snapshot));
      } finally {
        console.log = origLog;
      }

      // Make the golden portable + serialization-stable: JSON round-trip drops
      // undefined-valued keys (matching how the golden file is written), and the
      // machine-absolute fixture root is replaced with a placeholder so the golden
      // matches on any checkout location (a contributor's clone, CI, …) instead of
      // baking in where it was frozen.
      const portable = JSON.parse(
        JSON.stringify(projection).split(fixtureRoot).join('<FIXTURE>'),
      );

      const goldenPath = path.join(HERE, `${fixtureName}.json`);
      if (UPDATE) {
        fs.writeFileSync(goldenPath, JSON.stringify(portable, null, 2) + '\n');
        return;
      }
      const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf-8'));
      expect(portable).toEqual(golden);
    });
  });
});
