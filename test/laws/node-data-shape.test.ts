import { describe, expect, it } from '@jest/globals';
import { validateGraphDelta } from '../../src/graph/index.js';
import { NODE_DATA_KEYS, NODE_TYPES } from '../../src/types.js';

// The GraphNode TS union types `data` per node type, but the untrusted-input boundary
// (validateGraphDelta) historically accepted any `data` object. This guard checks that the
// runtime validation now enforces the per-type discriminant: data keys foreign to a node type are
// rejected, so a producer bug emitting an `export-symbol`-shaped payload on a `module` node is
// caught rather than silently accepted. See graph/delta.ts superRefine + NODE_DATA_KEYS.
describe('core-laws node-data shape (per-type data discriminant, D3)', () => {
  it('NODE_DATA_KEYS has an entry for every NodeType', () => {
    expect(Object.keys(NODE_DATA_KEYS).sort()).toEqual([...NODE_TYPES].sort());
  });

  it('accepts data carrying only keys valid for the node type', () => {
    const result = validateGraphDelta({
      nodes: [
        { id: 'export:x/Foo', type: 'export-symbol', label: 'Foo', description: 'class', data: { symbolKind: 'class', signature: 'class Foo' } },
        { id: 'mod:x', type: 'module', label: 'x.ts', description: 'module', data: { envVars: ['API_URL'], hasRoutes: true } },
        { id: 'resource:aws-dynamodb:T', type: 'runtime-resource', label: 'T', description: 'table', data: { kind: 'table', provider: 'aws' } },
        { id: 'resource:k8s:_/Deployment/web', type: 'runtime-resource', label: 'web', description: 'deployment', data: { kind: 'k8s-deployment', k8sKind: 'Deployment', provider: 'k8s' } },
      ],
      edges: [],
    });

    expect(result.ok).toBe(true);
    expect(result.delta.nodes.map(n => n.id).sort()).toEqual([
      'export:x/Foo',
      'mod:x',
      'resource:aws-dynamodb:T',
      'resource:k8s:_/Deployment/web',
    ]);
  });

  it('rejects a data key foreign to the node type (cross-type contamination)', () => {
    const result = validateGraphDelta({
      nodes: [
        // symbolKind is an export-symbol field; it must not be accepted on a module node.
        { id: 'mod:x', type: 'module', label: 'x.ts', description: 'module', data: { symbolKind: 'class' } },
      ],
      edges: [],
    });

    expect(result.ok).toBe(false);
    expect(result.delta.nodes).toEqual([]); // contaminated node dropped, not silently accepted
    expect(result.errors.join(' ')).toMatch(/unexpected data key 'symbolKind'/);
  });
});
