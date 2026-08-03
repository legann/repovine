import { pruneInertRuntimeResources } from '../../../src/stage2/prune-inert-resources.js';
import { addEdge, addNode, createEmptyGraph } from '../../../src/graph/index.js';
import type { DomainsConfig } from '../../../src/stage2/domains-schema.js';
import type { RepositoryGraph } from '../../../src/types.js';

/**
 * Synthetic graph: one witnessed lambda (carries a load-bearing `uses_env` edge) and two inert
 * resources (only structural `contains`/`tagged`), mirroring how pass2Infra wires nodes.
 */
function makeGraph(): RepositoryGraph {
  const g = createEmptyGraph();
  addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
  addNode(g, { id: 'infra:mod', type: 'module', label: 'mod', description: '' });
  addNode(g, { id: 'domain:infra-aws', type: 'domain', label: 'infra-aws', description: '' });

  addNode(g, { id: 'resource:aws-lambda:Fn', type: 'runtime-resource', label: 'Fn', description: 'Lambda' });
  addEdge(g, 'infra:mod', 'resource:aws-lambda:Fn', 'contains');
  addEdge(g, 'resource:aws-lambda:Fn', 'domain:infra-aws', 'tagged');
  addEdge(g, 'resource:aws-lambda:Fn', 'resource:aws-dynamodb:Table', 'uses_env');

  for (const label of ['AppRole', 'AppPolicy']) {
    const id = `resource:aws:${label}`;
    addNode(g, { id, type: 'runtime-resource', label, description: 'inert' });
    addEdge(g, 'infra:mod', id, 'contains');
    addEdge(g, id, 'domain:infra-aws', 'tagged');
  }
  return g;
}

function resourceLabels(g: RepositoryGraph): string[] {
  return [...(g.byType.get('runtime-resource') ?? [])]
    .map(id => g.nodes.get(id)?.label)
    .filter((l): l is string => l != null)
    .sort();
}

describe('pruneInertRuntimeResources', () => {
  it('is a no-op when pruneInert is off (default)', () => {
    const g = makeGraph();
    expect(pruneInertRuntimeResources(g, { infra: {} } as DomainsConfig)).toBe(0);
    expect(pruneInertRuntimeResources(g, null)).toBe(0);
    expect(resourceLabels(g)).toEqual(['AppPolicy', 'AppRole', 'Fn']);
  });

  it('prunes inert resources but keeps witnessed ones when pruneInert is on', () => {
    const g = makeGraph();
    const removed = pruneInertRuntimeResources(g, { infra: { pruneInert: true } } as DomainsConfig);

    expect(removed).toBe(2);
    expect(resourceLabels(g)).toEqual(['Fn']);
    // Pruned nodes and their edges are gone from every index.
    expect(g.nodes.has('resource:aws:AppRole')).toBe(false);
    expect(g.outEdges.has('resource:aws:AppRole')).toBe(false);
    expect(g.edges.some(e => e.to === 'resource:aws:AppRole' || e.from === 'resource:aws:AppRole')).toBe(false);
    // The parent module's contains edge to the pruned resource is cleaned up.
    expect((g.outEdges.get('infra:mod') ?? []).some(e => e.to.includes('AppRole'))).toBe(false);
    // The witnessed lambda and its load-bearing edge survive.
    expect((g.outEdges.get('resource:aws-lambda:Fn') ?? []).some(e => e.kind === 'uses_env')).toBe(true);
  });

  it('keeps a resource witnessed only by an INCOMING load-bearing edge', () => {
    const g = makeGraph();
    // A resource whose own outgoing edges are purely structural (contains/tagged), witnessed
    // solely by an incoming non-structural edge (Fn --uses_env--> Table).
    addNode(g, { id: 'resource:aws-dynamodb:Table', type: 'runtime-resource', label: 'Table', description: 'DynamoDB' });
    addEdge(g, 'infra:mod', 'resource:aws-dynamodb:Table', 'contains');
    addEdge(g, 'resource:aws-dynamodb:Table', 'domain:infra-aws', 'tagged');
    // Fn already carries `uses_env` -> Table (line 19 of makeGraph); that is Table's only witness.

    const removed = pruneInertRuntimeResources(g, { infra: { pruneInert: true } } as DomainsConfig);

    // Only the two truly inert resources go; Table survives on its incoming edge alone.
    expect(removed).toBe(2);
    expect(resourceLabels(g)).toEqual(['Fn', 'Table']);
    expect(g.nodes.has('resource:aws-dynamodb:Table')).toBe(true);
    expect((g.inEdges.get('resource:aws-dynamodb:Table') ?? []).some(e => e.kind === 'uses_env')).toBe(true);
  });

  it('infra.keep overrides the prune for matching labels', () => {
    const g = makeGraph();
    const removed = pruneInertRuntimeResources(
      g,
      { infra: { pruneInert: true, keep: { suffixes: ['Policy'] } } } as DomainsConfig,
    );

    expect(removed).toBe(1);
    expect(resourceLabels(g)).toEqual(['AppPolicy', 'Fn']);
  });

  it('infra.keep.patterns overrides the prune via regex match (not just suffixes)', () => {
    const g = makeGraph();
    // `Rol.` is a regex (dot = any char) matching 'AppRole' but not a plain suffix; it must not
    // match 'AppPolicy'. Exercises the keep.patterns half of hasKeep and the matcher's regex arm.
    const removed = pruneInertRuntimeResources(
      g,
      { infra: { pruneInert: true, keep: { patterns: ['Rol.'] } } } as DomainsConfig,
    );

    expect(removed).toBe(1);
    expect(resourceLabels(g)).toEqual(['AppRole', 'Fn']);
  });
});
