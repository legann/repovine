import { describe, expect, it } from '@jest/globals';
import {
  CORE_EDGE_KINDS,
  CORE_NODE_TYPES,
  scanLiteralGraphProducers,
} from './core-schema.js';

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

describe('core-laws edge-witness producer side (D6 producer)', () => {
  const scan = scanLiteralGraphProducers();

  it('has at least one literal addNode producer for every NodeType', () => {
    const missing = CORE_NODE_TYPES.filter(type => !scan.nodeTypes.has(type));
    const unexpected = sorted(scan.nodeTypes.keys()).filter(type => !CORE_NODE_TYPES.includes(type as never));

    expect(scan.nonLiteralNodeCalls).toEqual([]);
    expect(unexpected).toEqual([]);
    expect(missing).toEqual([]);
  });

  it('has at least one literal addEdge producer for every EdgeKind', () => {
    const missing = CORE_EDGE_KINDS.filter(kind => !scan.edgeKinds.has(kind));
    const unexpected = sorted(scan.edgeKinds.keys()).filter(kind => !CORE_EDGE_KINDS.includes(kind as never));

    expect(scan.nonLiteralEdgeCalls).toEqual([]);
    expect(unexpected).toEqual([]);
    expect(missing).toEqual([]);
  });
});
