/**
 * `moduleCount` has to mean the same thing wherever map_context reports it.
 *
 * The domain-level count was every `tagged` in-edge source, while each subdomain counted
 * module-typed sources only. Infra propagation tags runtime resources into domains, so one response
 * reported a domain holding more "modules" than its subdomain rows could ever sum to.
 */
import { buildDomainContext } from '../../../src/mcp/lib/domain-map.js';
import { createEmptyGraph, addNode, addEdge } from '../../../src/graph/index.js';
import { CONFIG_DEFAULTS } from '../../../src/config.js';
import type { McpToolRuntime, RepovineState } from '../../../src/mcp/types.js';
import type { RepositoryGraph } from '../../../src/types.js';

function buildGraph(): RepositoryGraph {
  const g = createEmptyGraph();
  addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
  addNode(g, { id: 'domain:orders', type: 'domain', label: 'orders', description: '', data: { tier: 'business' } });
  addNode(g, { id: 'mod:app/orders/service', type: 'module', label: 'service', description: '' });
  addNode(g, { id: 'mod:app/orders/repo', type: 'module', label: 'repo', description: '' });
  // Infra propagation attaches runtime resources to the same domain with the same edge kind.
  addNode(g, { id: 'resource:aws-dynamodb:Orders', type: 'runtime-resource', label: 'Orders', description: '' });
  addNode(g, { id: 'resource:aws-sqs:OrderJobs', type: 'runtime-resource', label: 'OrderJobs', description: '' });

  addEdge(g, 'root', 'domain:orders', 'contains');
  for (const id of [
    'mod:app/orders/service',
    'mod:app/orders/repo',
    'resource:aws-dynamodb:Orders',
    'resource:aws-sqs:OrderJobs',
  ]) {
    addEdge(g, id, 'domain:orders', 'tagged');
  }
  return g;
}

function makeCtx(graph: RepositoryGraph): McpToolRuntime {
  const state = {
    graph,
    snapshot: { repoRoot: '/repo', timestamp: '2026-01-01', packages: [], modules: [] },
    modulesById: new Map(),
    annotations: { get: () => undefined, getAll: () => ({}) },
    domainsConfig: null,
  } as unknown as RepovineState;
  return { getState: () => state, refreshRepoState: () => {}, getConfig: () => CONFIG_DEFAULTS, repoRoot: '/repo' };
}

describe('map_context domain counts', () => {
  it('counts module-typed sources only, and discloses the rest', () => {
    const result = buildDomainContext(makeCtx(buildGraph()), { domain: 'orders' }) as Record<string, unknown>;

    expect(result.moduleCount).toBe(2);
    expect(result.taggedNonModuleCount).toBe(2);
  });

  it('omits the disclosure when every tagged source is a module', () => {
    const graph = buildGraph();
    for (const id of ['resource:aws-dynamodb:Orders', 'resource:aws-sqs:OrderJobs']) {
      const edges = (graph.inEdges.get('domain:orders') ?? []).filter(e => e.from !== id);
      graph.inEdges.set('domain:orders', edges);
      graph.outEdges.delete(id);
    }
    const result = buildDomainContext(makeCtx(graph), { domain: 'orders' }) as Record<string, unknown>;

    expect(result.moduleCount).toBe(2);
    expect(result).not.toHaveProperty('taggedNonModuleCount');
  });
});
