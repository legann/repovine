/**
 * Unit tests for the graph module (createEmptyGraph, addNode, addEdge, queries).
 * Uses a small in-memory fixture — no real repo scan, no file I/O.
 */
import {
  createEmptyGraph,
  addNode,
  addEdge,
  getChildren,
  getImpact,
  pathFromRoot,
  buildNodeView,
  graphStats,
  MAX_NODE_VIEW_LINKS,
} from '../../../src/graph/index.js';
import type { RepositoryGraph } from '../../../src/types.js';

/** Build a tiny graph:  root → pkg:a → mod:a/foo → export:a/foo/Bar */
function buildFixture(): RepositoryGraph {
  const g = createEmptyGraph();
  addNode(g, { id: 'root', type: 'root', label: 'root', description: 'repo root' });
  addNode(g, { id: 'pkg:a', type: 'package', label: 'a', description: 'package a' });
  addNode(g, { id: 'mod:a/foo', type: 'module', label: 'foo', description: 'module foo' });
  addNode(g, { id: 'export:a/foo/Bar', type: 'export-symbol', label: 'Bar', description: 'export Bar',
    data: { signature: 'function Bar(x: number): string', symbolKind: 'function', lineRange: { start: 1, end: 10 } } });

  addEdge(g, 'root', 'pkg:a', 'contains');
  addEdge(g, 'pkg:a', 'mod:a/foo', 'contains');
  addEdge(g, 'mod:a/foo', 'export:a/foo/Bar', 'contains');
  return g;
}

describe('createEmptyGraph', () => {
  it('returns an empty graph structure', () => {
    const g = createEmptyGraph();
    expect(g.nodes.size).toBe(0);
    expect(g.edges.length).toBe(0);
    expect(g.outEdges.size).toBe(0);
    expect(g.inEdges.size).toBe(0);
    expect(g.byType.size).toBe(0);
  });
});

describe('addNode', () => {
  it('inserts node and updates byType index', () => {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    expect(g.nodes.has('root')).toBe(true);
    expect(g.byType.get('root')?.has('root')).toBe(true);
  });

  it('groups multiple nodes of the same type', () => {
    const g = createEmptyGraph();
    addNode(g, { id: 'pkg:a', type: 'package', label: 'a', description: '' });
    addNode(g, { id: 'pkg:b', type: 'package', label: 'b', description: '' });
    expect(g.byType.get('package')?.size).toBe(2);
  });
});

describe('addEdge', () => {
  it('inserts edge and updates outEdges / inEdges indices', () => {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, { id: 'pkg:a', type: 'package', label: 'a', description: '' });
    addEdge(g, 'root', 'pkg:a', 'contains');

    expect(g.edges.length).toBe(1);
    expect((g.outEdges.get('root') ?? [])[0]).toMatchObject({ from: 'root', to: 'pkg:a', kind: 'contains' });
    expect((g.inEdges.get('pkg:a') ?? [])[0]).toMatchObject({ from: 'root', to: 'pkg:a', kind: 'contains' });
  });
});

describe('getChildren', () => {
  it('returns direct children via contains edges', () => {
    const g = buildFixture();
    const children = getChildren(g, 'pkg:a');
    expect(children.map(c => c.id)).toEqual(['mod:a/foo']);
  });

  it('returns empty array for leaf node', () => {
    const g = buildFixture();
    expect(getChildren(g, 'export:a/foo/Bar')).toEqual([]);
  });

  it('returns empty array for unknown node', () => {
    const g = buildFixture();
    expect(getChildren(g, 'mod:nonexistent')).toEqual([]);
  });
});

describe('buildNodeView', () => {
  it('returns null for unknown node', () => {
    const g = buildFixture();
    expect(buildNodeView(g, 'mod:nonexistent')).toBeNull();
  });

  it('builds view for root with package children in drill_down', () => {
    const g = buildFixture();
    const view = buildNodeView(g, 'root');
    expect(view).not.toBeNull();
    const v = view as NonNullable<typeof view>;
    expect(v.id).toBe('root');
    expect(v.level).toBe(0);
    expect(v.drill_down.map(d => d.id)).toContain('pkg:a');
  });

  it('builds view for module with export-symbol children', () => {
    const g = buildFixture();
    const view = buildNodeView(g, 'mod:a/foo');
    expect(view).not.toBeNull();
    const v = view as NonNullable<typeof view>;
    expect(v.drill_down.length).toBe(1);
    expect(v.drill_down[0].id).toBe('export:a/foo/Bar');
    expect(v.drill_down[0].signature).toBe('function Bar(x: number): string');
    expect(v.drill_down[0].symbolKind).toBe('function');
  });

  it('builds view for export-symbol with symbol detail', () => {
    const g = buildFixture();
    const view = buildNodeView(g, 'export:a/foo/Bar');
    expect(view).not.toBeNull();
    const v = view as NonNullable<typeof view>;
    expect(v.signature).toBe('function Bar(x: number): string');
    expect(v.lineRange).toEqual({ start: 1, end: 10 });
    expect(v.level).toBe(3);
  });

  it('exposes envVars from module node data', () => {
    const g = createEmptyGraph();
    addNode(g, { id: 'mod:a/config', type: 'module', label: 'config', description: '',
      data: { envVars: ['API_KEY', 'BASE_URL'] } });
    const view = buildNodeView(g, 'mod:a/config');
    expect(view).not.toBeNull();
    expect((view as NonNullable<typeof view>).envVars).toEqual(['API_KEY', 'BASE_URL']);
  });

  it('deduplicates and caps high-fanout links with explicit totals', () => {
    const g = createEmptyGraph();
    addNode(g, { id: 'mod:a/index', type: 'module', label: 'index', description: 'barrel' });
    for (let i = 0; i < MAX_NODE_VIEW_LINKS + 10; i++) {
      const id = `mod:a/leaf-${i}`;
      addNode(g, { id, type: 'module', label: `leaf-${i}`, description: '' });
      addEdge(g, 'mod:a/index', id, 'reexports');
    }
    addEdge(g, 'mod:a/index', 'mod:a/leaf-0', 'reexports');

    const view = buildNodeView(g, 'mod:a/index');

    expect(view?.links).toHaveLength(MAX_NODE_VIEW_LINKS);
    expect(view?.links?.filter(link => link.targetId === 'mod:a/leaf-0')).toHaveLength(1);
    expect(view?.linksPagination).toEqual(expect.objectContaining({
      total: MAX_NODE_VIEW_LINKS + 10,
      returned: MAX_NODE_VIEW_LINKS,
      offset: 0,
      truncated: true,
    }));
  });
});

describe('pathFromRoot', () => {
  it('returns null for unknown node', () => {
    const g = buildFixture();
    expect(pathFromRoot(g, 'mod:unknown')).toBeNull();
  });

  it('returns chain starting at root', () => {
    const g = buildFixture();
    const result = pathFromRoot(g, 'export:a/foo/Bar');
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.path[0].id).toBe('root');
    expect(r.focus.id).toBe('export:a/foo/Bar');
  });

  it('chain has correct depth (root → pkg → mod for module node)', () => {
    const g = buildFixture();
    const result = pathFromRoot(g, 'mod:a/foo');
    expect(result).not.toBeNull();
    expect((result as NonNullable<typeof result>).path.map(p => p.id)).toEqual(['root', 'pkg:a']);
  });
});

describe('getImpact', () => {
  it('returns empty arrays for isolated node', () => {
    const g = buildFixture();
    const impact = getImpact(g, 'mod:a/foo');
    expect(impact.downstream).toEqual([]);
    expect(impact.upstream).toEqual([]);
  });

  it('returns downstream for a module that is imported by another', () => {
    const g = buildFixture();
    addNode(g, { id: 'pkg:b', type: 'package', label: 'b', description: '' });
    addNode(g, { id: 'mod:b/bar', type: 'module', label: 'bar', description: '' });
    addEdge(g, 'root', 'pkg:b', 'contains');
    addEdge(g, 'pkg:b', 'mod:b/bar', 'contains');
    addEdge(g, 'mod:b/bar', 'mod:a/foo', 'imports');

    const impact = getImpact(g, 'mod:a/foo');
    expect(impact.downstream).toContain('mod:b/bar');
    expect(impact.upstream).toEqual([]);
  });

  it('returns upstream for a module that imports another', () => {
    const g = buildFixture();
    addNode(g, { id: 'mod:a/utils', type: 'module', label: 'utils', description: '' });
    addEdge(g, 'pkg:a', 'mod:a/utils', 'contains');
    addEdge(g, 'mod:a/foo', 'mod:a/utils', 'imports');

    const impact = getImpact(g, 'mod:a/foo');
    expect(impact.upstream).toContain('mod:a/utils');
  });

  it('maxDepth=1 returns only direct neighbors', () => {
    const g = buildFixture();
    addNode(g, { id: 'pkg:b', type: 'package', label: 'b', description: '' });
    addNode(g, { id: 'mod:b/bar', type: 'module', label: 'bar', description: '' });
    addNode(g, { id: 'mod:b/baz', type: 'module', label: 'baz', description: '' });
    addEdge(g, 'root', 'pkg:b', 'contains');
    addEdge(g, 'pkg:b', 'mod:b/bar', 'contains');
    addEdge(g, 'pkg:b', 'mod:b/baz', 'contains');
    addEdge(g, 'mod:b/bar', 'mod:a/foo', 'imports');
    addEdge(g, 'mod:b/baz', 'mod:b/bar', 'imports');

    const shallow = getImpact(g, 'mod:a/foo', 'downstream', 1);
    expect(shallow.downstream).toContain('mod:b/bar');
    expect(shallow.downstream).not.toContain('mod:b/baz');

    const deep = getImpact(g, 'mod:a/foo', 'downstream');
    expect(deep.downstream).toContain('mod:b/bar');
    expect(deep.downstream).toContain('mod:b/baz');
  });

  it('includes one re-export hop but does not expand through the reached barrel', () => {
    const g = createEmptyGraph();
    addNode(g, { id: 'mod:pkg/leaf', type: 'module', label: 'leaf', description: '' });
    addNode(g, { id: 'mod:pkg/index', type: 'module', label: 'index', description: 'barrel' });
    addNode(g, { id: 'mod:app/consumer', type: 'module', label: 'consumer', description: '' });
    addEdge(g, 'mod:pkg/index', 'mod:pkg/leaf', 'reexports');
    addEdge(g, 'mod:app/consumer', 'mod:pkg/index', 'imports');

    const impact = getImpact(g, 'mod:pkg/leaf', 'downstream');

    expect(impact.downstream).toContain('mod:pkg/index');
    expect(impact.downstream).not.toContain('mod:app/consumer');
  });
});

describe('graphStats', () => {
  it('counts nodes and edges correctly', () => {
    const g = buildFixture();
    const s = graphStats(g);
    expect(s.totalNodes).toBe(4);
    expect(s.totalEdges).toBe(3);
    expect(s.nodesByType['module']).toBe(1);
    expect(s.nodesByType['export-symbol']).toBe(1);
    expect(s.edgesByKind['contains']).toBe(3);
  });
});
