import * as fs from 'node:fs';
import * as path from 'node:path';
import { toPosixPath } from '../../src/platform/paths.js';
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

// ── text guards ──
// A guard that reads source, not the graph: it catches a SECOND declaration of a form that was just
// centralized. Shared by the laws that hold such forms, so a guard fixed in one place is fixed for
// both — stage 8 had five guards pass their own rollback, and every one of them was a text guard.
//
// `where` is a repo-relative POSIX path, on every host. A guard that narrows to one file writes that
// file the way the repository writes it — `analysis/architecture/detectors.ts` — and `path.relative`
// answers with the host separator, so the normalization happens here rather than at each comparison.
// Stage 9 shipped without it: the law was green on Linux and failed on the Windows CI leg, where the
// key read `analysis\\architecture\\detectors.ts` and matched no POSIX literal.

export function repoRoot(): string {
  return path.resolve(findFixturesRoot(), '..', '..');
}

export function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* sourceFiles(full);
      continue;
    }
    if (entry.isFile() && full.endsWith('.ts')) yield full;
  }
}

/** Every engine and SDK source root a text guard reads. */
export function guardedRoots(): Array<{ root: string; dir: string }> {
  const root = repoRoot();
  return [
    { root, dir: path.join(root, 'src') },
    { root, dir: path.join(root, 'packages', 'plugin-sdk', 'src') },
  ].filter(entry => fs.existsSync(entry.dir));
}

/** A file's code with comments dropped, one entry per file. */
export function codeFiles(exempt: readonly string[]): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  for (const { root, dir } of guardedRoots()) {
    for (const file of sourceFiles(dir)) {
      const rel = toPosixPath(path.relative(root, file));
      if (exempt.some(e => rel.endsWith(e))) continue;
      // Prose names a form without declaring it, so comment lines are dropped before the text is
      // joined. Joined without newlines: a chain broken across lines is the same declaration, and
      // a line-local guard is one `prettier` run away from blind.
      const code = fs.readFileSync(file, 'utf8').split('\n')
        .filter(line => {
          const t = line.trim();
          return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'));
        })
        .join(' ');
      out.push({ where: rel, text: code });
    }
  }
  return out;
}

/** Code lines of every guarded root, minus the module each form is allowed to live in. */
export function codeLines(exempt: readonly string[]): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  for (const { root, dir } of guardedRoots()) {
    for (const file of sourceFiles(dir)) {
      const rel = toPosixPath(path.relative(root, file));
      if (exempt.some(e => rel.endsWith(e))) continue;
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
        out.push({ where: `${rel}:${i + 1}`, text: line });
      });
    }
  }
  return out;
}
