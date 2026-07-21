import { describe, expect, it } from '@jest/globals';
import { validateGraphDelta } from '../../src/graph/index.js';
import { EDGE_KINDS, NODE_TYPES } from '../../src/types.js';
import {
  CORE_EDGE_KINDS,
  CORE_NODE_TYPES,
} from './core-schema.js';

describe('core-laws schema-shape (D3)', () => {
  it('keeps the canonical NodeType and EdgeKind shape in src/types.ts runtime constants', () => {
    expect([...NODE_TYPES]).toEqual([...CORE_NODE_TYPES]);
    expect([...EDGE_KINDS]).toEqual([...CORE_EDGE_KINDS]);
  });

  it('keeps GraphDelta validation derived from the canonical graph shape', () => {
    const result = validateGraphDelta({
      nodes: CORE_NODE_TYPES.map(type => ({
        id: `law:${type}`,
        type,
        label: type,
        description: `${type} node`,
      })),
      edges: CORE_EDGE_KINDS.map(kind => ({
        from: 'law:root',
        to: `law:${kind}`,
        kind,
      })),
    });

    expect(result.ok).toBe(true);
    expect(result.delta.nodes.map(node => node.type)).toEqual([...CORE_NODE_TYPES]);
    expect(result.delta.edges.map(edge => edge.kind)).toEqual([...CORE_EDGE_KINDS]);
  });

  it('rejects non-canonical node types and edge kinds at the untrusted boundary', () => {
    const result = validateGraphDelta({
      nodes: [
        { id: 'law:bogus', type: 'frobnicate', label: 'x', description: 'not a NodeType' },
        { id: 'law:root', type: 'root', label: 'root', description: 'canonical' },
      ],
      edges: [
        { from: 'law:root', to: 'law:root', kind: 'frobnicate' },
        { from: 'law:root', to: 'law:root', kind: 'contains' },
      ],
    });

    // Acceptance alone is not enough: the enum must also drop members outside the canonical sets,
    // otherwise loosening EdgeKindSchema/NodeTypeSchema to z.string() would pass undetected.
    expect(result.ok).toBe(false);
    expect(result.delta.nodes.map(node => node.type)).toEqual(['root']);
    expect(result.delta.edges.map(edge => edge.kind)).toEqual(['contains']);
  });
});
