import * as fs from 'node:fs';
import * as path from 'node:path';
import { addEdge, addNode, createEmptyGraph } from '../../src/graph/index.js';
import { CONFIG_DEFAULTS } from '../../src/config.js';
import type { AnnotationStore } from '../../src/annotations/store.js';
import type { RefactoringThresholds } from '../../src/analysis/architecture/config.js';
import type {
  EdgeKind,
  GraphEdge,
  GraphNode,
  ModuleInfo,
  RepositoryFactsSnapshot,
  RepositoryGraph,
} from '../../src/types.js';
import type { McpToolRuntime } from '../../src/mcp/types.js';

export function findFixturesRoot(): string {
  const candidates = [
    path.resolve(process.cwd(), 'test', 'fixtures'),
    path.resolve(process.cwd(), 'repovine', 'test', 'fixtures'),
  ];
  const root = candidates.find(candidate => fs.existsSync(candidate));
  if (!root) throw new Error(`Could not find test fixtures root. Tried: ${candidates.join(', ')}`);
  return root;
}

export function cloneWithoutEdgeKind(graph: RepositoryGraph, kind: EdgeKind): RepositoryGraph {
  const next = createEmptyGraph();
  for (const node of graph.nodes.values()) addNode(next, node);
  for (const edge of graph.edges) {
    if (edge.kind === kind) continue;
    addEdge(next, edge.from, edge.to, edge.kind, edge.metadata);
  }
  return next;
}

export function lawRuntime(
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot = { repoRoot: '/repo', timestamp: '2024-01-01', packages: [], modules: [] },
): McpToolRuntime {
  const modulesById = new Map<string, ModuleInfo>(snapshot.modules.map(mod => [mod.id, mod]));
  return {
    repoRoot: snapshot.repoRoot,
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

export function normalizeGraph(graph: RepositoryGraph): {
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
} {
  return {
    nodes: [...graph.nodes.values()]
      .map(node => stableRecord(node))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    edges: graph.edges
      .map(edge => stableRecord(edge))
      .sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
  };
}

function edgeKey(edge: Record<string, unknown>): string {
  return `${String(edge.from)}\0${String(edge.kind)}\0${String(edge.to)}\0${JSON.stringify(edge.metadata ?? {})}`;
}

function stableRecord(value: GraphNode | GraphEdge): Record<string, unknown> {
  return stableValue(value) as Record<string, unknown>;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = stableValue((value as Record<string, unknown>)[key]);
  return out;
}
