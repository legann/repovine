import { asHostPath, asPkgRelPath } from '@repovine/plugin-sdk';
/**
 * The read-only post-composition invariant check. A healthy graph produces no
 * problems; a missing snapshot record or a dangling edge is reported.
 */
import { validateComposedGraph, summarizeGraphValidationProblems } from '../../../src/stage2/graph-validate.js';
import type {
  RepositoryGraph,
  RepositoryFactsSnapshot,
  GraphNode,
  GraphEdge,
  ModuleInfo,
  TemplateFileInfo,
} from '../../../src/types.js';

function makeGraph(nodes: GraphNode[], edges: GraphEdge[]): RepositoryGraph {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of nodes) nodeMap.set(n.id, n);
  const outEdges = new Map<string, GraphEdge[]>();
  const inEdges = new Map<string, GraphEdge[]>();
  const byType = new Map<GraphNode['type'], Set<string>>();
  for (const e of edges) {
    if (!outEdges.has(e.from)) outEdges.set(e.from, []);
    outEdges.get(e.from)!.push(e);
    if (!inEdges.has(e.to)) inEdges.set(e.to, []);
    inEdges.get(e.to)!.push(e);
  }
  for (const n of nodes) {
    if (!byType.has(n.type)) byType.set(n.type, new Set());
    byType.get(n.type)!.add(n.id);
  }
  return { nodes: nodeMap, edges, outEdges, inEdges, byType };
}

function makeMod(id: string): ModuleInfo {
  return { id, packageName: 'test', absPath: asHostPath(`/abs/${id}.ts`), pkgRelPath: asPkgRelPath(`${id}.ts`), contentHash: 'h', imports: [], exports: [] };
}

function makeSnapshot(modules: ModuleInfo[], templates?: TemplateFileInfo[]): RepositoryFactsSnapshot {
  return { repoRoot: '/abs', timestamp: '2026-07-12T00:00:00.000Z', packages: [], modules, ...(templates ? { templates } : {}) };
}

const modNode = (id: string): GraphNode => ({ id, type: 'module', label: id, description: '' });

describe('validateComposedGraph', () => {
  it('returns no problems for a consistent graph', () => {
    const graph = makeGraph(
      [modNode('mod:a'), modNode('mod:b'), { id: 'domain:x', type: 'domain', label: 'x', description: '' }],
      [{ from: 'mod:a', to: 'domain:x', kind: 'tagged' }],
    );
    const snapshot = makeSnapshot([makeMod('mod:a'), makeMod('mod:b')]);
    expect(validateComposedGraph(graph, snapshot)).toEqual([]);
  });

  it('flags a snapshot module that never became a node', () => {
    const graph = makeGraph([modNode('mod:a')], []);
    const snapshot = makeSnapshot([makeMod('mod:a'), makeMod('mod:missing')]);
    const problems = validateComposedGraph(graph, snapshot);
    expect(problems).toEqual([{ kind: 'missing-module', detail: 'mod:missing' }]);
  });

  it('flags a discovered template that never became a node', () => {
    const graph = makeGraph([modNode('mod:a')], []);
    const snapshot = makeSnapshot(
      [makeMod('mod:a')],
      [{ id: 'template:views/home.html', relPath: 'views/home.html', contentHash: 't1' }],
    );
    const problems = validateComposedGraph(graph, snapshot);
    expect(problems).toContainEqual({ kind: 'missing-template', detail: 'template:views/home.html' });
  });

  it('flags a dangling edge target', () => {
    const graph = makeGraph([modNode('mod:a')], [{ from: 'mod:a', to: 'domain:ghost', kind: 'tagged' }]);
    const problems = validateComposedGraph(graph, makeSnapshot([makeMod('mod:a')]));
    expect(problems).toContainEqual({ kind: 'dangling-edge-to', detail: 'mod:a -tagged-> domain:ghost' });
  });

  it('flags a dangling edge source', () => {
    const graph = makeGraph([modNode('mod:a')], [{ from: 'mod:ghost', to: 'mod:a', kind: 'imports' }]);
    const problems = validateComposedGraph(graph, makeSnapshot([makeMod('mod:a')]));
    expect(problems).toContainEqual({ kind: 'dangling-edge-from', detail: 'mod:ghost -imports-> mod:a' });
  });
});

describe('summarizeGraphValidationProblems', () => {
  it('summarizes and caps the problem list', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ kind: 'missing-module' as const, detail: `mod:${i}` }));
    const summary = summarizeGraphValidationProblems(many);
    expect(summary).toContain('8 problem(s)');
    expect(summary).toContain('+3 more');
  });
});
