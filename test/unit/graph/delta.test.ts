import { describe, expect, it } from '@jest/globals';
import {
  addNode,
  applyValidated,
  createEmptyGraph,
  graphStats,
  validateGraphDelta,
} from '../../../src/graph/index.js';

describe('GraphDelta validation and application', () => {
  it('deduplicates valid nodes/edges and drops malformed untrusted entries', () => {
    const graph = createEmptyGraph();
    const warnings: string[] = [];
    addNode(graph, { id: 'root', type: 'root', label: 'root', description: 'repo root' });

    applyValidated(
      graph,
      {
        nodes: [
          { id: 'pkg:a', type: 'package', label: 'a', description: 'package a' },
          { id: 'pkg:a', type: 'package', label: 'a duplicate', description: 'duplicate' },
          { id: 'bad-node' } as never,
        ],
        edges: [
          { from: 'root', to: 'pkg:a', kind: 'contains' },
          { from: 'root', to: 'pkg:a', kind: 'contains' },
          { from: 'root', to: 'missing', kind: 'contains' },
          { from: 'root', to: 'pkg:a', kind: 'custom' } as never,
        ],
      },
      {
        trusted: false,
        logger(level, message) {
          if (level === 'warn') warnings.push(message);
        },
      },
    );

    expect(graph.nodes.has('pkg:a')).toBe(true);
    expect(graphStats(graph).totalNodes).toBe(2);
    expect(graph.edges).toEqual([{ from: 'root', to: 'pkg:a', kind: 'contains' }]);
    expect(warnings.some(message => message.includes('bad-node'))).toBe(true);
    expect(warnings.some(message => message.includes('missing endpoint'))).toBe(true);
    expect(warnings.some(message => message.includes('custom'))).toBe(true);
  });

  it('keeps unknown fields on otherwise valid delta entries', () => {
    const result = validateGraphDelta({
      nodes: [
        {
          id: 'mod:a',
          type: 'module',
          label: 'a',
          description: 'module a',
          extra: { kept: true },
        },
      ],
      edges: [
        {
          from: 'root',
          to: 'mod:a',
          kind: 'contains',
          metadata: { extra: 'kept' },
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect((result.delta.nodes[0] as Record<string, unknown>).extra).toEqual({ kept: true });
    expect((result.delta.edges[0].metadata as Record<string, unknown>).extra).toBe('kept');
  });

  it('rejects legacy graph node types from the pre-rename vocabulary', () => {
    const result = validateGraphDelta({
      nodes: [
        { id: 'export:a/foo/Bar', type: 'export-symbol', label: 'Bar', description: 'export Bar' },
        { id: 'resource:aws-lambda:WorkerFn', type: 'runtime-resource', label: 'WorkerFn', description: 'Lambda' },
        { id: 'cap:a/foo/Bar', type: 'capability', label: 'Bar', description: 'legacy export node' },
        { id: 'service:aws-lambda:WorkerFn', type: 'service', label: 'WorkerFn', description: 'legacy runtime node' },
      ],
      edges: [],
    });

    expect(result.ok).toBe(false);
    expect(result.delta.nodes.map(node => node.id)).toEqual([
      'export:a/foo/Bar',
      'resource:aws-lambda:WorkerFn',
    ]);
    const errors = result.errors.join('\n');
    expect(errors).toContain('cap:a/foo/Bar');
    expect(errors).toContain('service:aws-lambda:WorkerFn');
  });

  it('applies nodes and edges in deterministic id/key order', () => {
    const graph = createEmptyGraph();
    addNode(graph, { id: 'root', type: 'root', label: 'root', description: 'repo root' });

    applyValidated(graph, {
      nodes: [
        { id: 'pkg:b', type: 'package', label: 'b', description: 'package b' },
        { id: 'pkg:a', type: 'package', label: 'a', description: 'package a' },
      ],
      edges: [
        { from: 'root', to: 'pkg:b', kind: 'contains' },
        { from: 'root', to: 'pkg:a', kind: 'contains' },
      ],
    });

    expect([...graph.nodes.keys()]).toEqual(['root', 'pkg:a', 'pkg:b']);
    expect(graph.edges.map(edge => edge.to)).toEqual(['pkg:a', 'pkg:b']);
  });
});
