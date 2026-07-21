import { describe, it, expect } from '@jest/globals';
import { selfWiringAttention } from '../../../src/mcp/tools/inspect-node.js';
import { createEmptyGraph, addNode, addEdge } from '../../../src/graph/index.js';
import type { RepositoryGraph } from '../../../src/types.js';

function graphWithHandler(): RepositoryGraph {
  const g = createEmptyGraph();
  addNode(g, { id: 'mod:app/handler', type: 'module', label: 'handler', description: '' });
  addNode(g, { id: 'resource:aws/lambda/ResA', type: 'runtime-resource', label: 'ResA', description: '' });
  return g;
}

describe('selfWiringAttention', () => {
  it('hoists an infra-wired module to an attention item naming the resource, bridging to trace_flow', () => {
    const g = graphWithHandler();
    addEdge(g, 'resource:aws/lambda/ResA', 'mod:app/handler', 'infra');
    const item = selfWiringAttention('mod:app/handler', g);
    expect(item).toEqual({
      nodeId: 'mod:app/handler',
      investigate: ['wiring'],
      note: expect.stringContaining('ResA'),
      next: { tool: 'trace_flow', args: { scope: 'mod:app/handler' } },
    });
  });

  it('fires on a binds_to out-edge and names the bound resource', () => {
    const g = graphWithHandler();
    addEdge(g, 'mod:app/handler', 'resource:aws/lambda/ResA', 'binds_to');
    const item = selfWiringAttention('mod:app/handler', g);
    expect(item?.investigate).toEqual(['wiring']);
    expect(item?.note).toContain('ResA');
  });

  it('names at most two wired resources', () => {
    const g = graphWithHandler();
    addEdge(g, 'resource:aws/lambda/ResA', 'mod:app/handler', 'infra');
    for (const name of ['ResB', 'ResC']) {
      addNode(g, { id: `resource:aws/lambda/${name}`, type: 'runtime-resource', label: name, description: '' });
      addEdge(g, `resource:aws/lambda/${name}`, 'mod:app/handler', 'infra');
    }
    const item = selfWiringAttention('mod:app/handler', g);
    expect(item?.note).toContain('ResA');
    expect(item?.note).toContain('ResB');
    expect(item?.note).not.toContain('ResC');
  });

  it('names resources by node label, not node id', () => {
    const g = graphWithHandler();
    addNode(g, { id: 'resource:aws/sqs/orders-queue', type: 'runtime-resource', label: 'OrdersQueue', description: '' });
    addEdge(g, 'resource:aws/sqs/orders-queue', 'mod:app/handler', 'infra');
    const item = selfWiringAttention('mod:app/handler', g);
    expect(item?.note).toContain('OrdersQueue');
    expect(item?.note).not.toContain('resource:aws/sqs');
  });

  it('returns undefined for an unwired module', () => {
    expect(selfWiringAttention('mod:app/handler', graphWithHandler())).toBeUndefined();
  });

  it('returns undefined when the runtime edges point the wrong way', () => {
    const g = graphWithHandler();
    // infra out-edge and binds_to in-edge are the reversed shapes; neither is a wiring trigger.
    addEdge(g, 'mod:app/handler', 'resource:aws/lambda/ResA', 'infra');
    addEdge(g, 'resource:aws/lambda/ResA', 'mod:app/handler', 'binds_to');
    expect(selfWiringAttention('mod:app/handler', g)).toBeUndefined();
  });
});
