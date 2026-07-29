import { asRepoRelPath } from '@repovine/plugin-sdk';
import { asHostPath } from '@repovine/plugin-sdk';
import { describe, expect, it } from '@jest/globals';
import { ingressRoutesProjector } from '@repovine/plugin-iac-kubernetes';
import type { ReadonlyFactRecord } from '@repovine/plugin-sdk';
import { composeRepositoryGraph } from '../../src/stage2/index.js';
import type {
  InfraResource,
  InfraResourceKind,
  RepositoryFactsSnapshot,
  RepositoryGraph,
} from '../../src/types.js';
import { attachProjectors } from '../helpers/plugins.js';

function k8sResource(
  originalKind: string,
  kind: InfraResourceKind,
  name: string,
  namespace?: string,
  ingressBackends?: string,
): InfraResource {
  return {
    id: name,
    kind,
    provider: 'k8s',
    // Spelled out rather than taken from the plugin's minter: this law's subject is the id, and an
    // identity computed by the code under test would agree with itself no matter what it produced.
    identity: { namespace: 'k8s', localKey: `${namespace ?? '_'}/${originalKind}/${name}` },
    refScope: `k8s/${namespace ?? '_'}`,
    contentHash: `${namespace ?? '_'}:${originalKind}:${name}`,
    attributes: {
      kind: originalKind,
      ...(namespace ? { namespace } : {}),
      ...(ingressBackends ? { ingressBackends } : {}),
    },
  };
}

/** The fact the Kubernetes parser publishes for one object, spelled here for the same reason. */
function k8sObjectFact(resource: InfraResource, backends: string[] = []): ReadonlyFactRecord {
  const [, manifestKind, name] = resource.identity.localKey.split('/');
  return {
    schema: 'kubernetes/object@1',
    subjectRef: { type: 'resource', namespace: 'k8s', localKey: resource.identity.localKey },
    value: {
      localKey: resource.identity.localKey,
      manifestKind,
      name,
      refScope: resource.refScope!,
      backends,
    },
  };
}

function graphFor(resources: InfraResource[], facts: ReadonlyFactRecord[] = []): RepositoryGraph {
  const snapshot: RepositoryFactsSnapshot = {
    repoRoot: '/repo',
    timestamp: new Date(0).toISOString(),
    packages: [],
    modules: [],
    infraModules: [{
      id: 'infra:kubernetes:manifests/test.yaml',
      kind: 'kubernetes',
      absPath: asHostPath('/repo/manifests/test.yaml'),
      repoRelPath: asRepoRelPath('manifests/test.yaml'),
      contentHash: 'infra',
      resources,
    }],
    ...(facts.length === 0 ? {} : { facts }),
  };
  if (facts.length > 0) attachProjectors(snapshot, 'kubernetes', [ingressRoutesProjector]);
  return composeRepositoryGraph(snapshot);
}

function expectDistinctRuntimeNodes(
  resources: InfraResource[],
  expectedIds: string[],
): RepositoryGraph {
  const graph = graphFor(resources);
  const ids = [...(graph.byType.get('runtime-resource') ?? [])];
  expect(ids.sort()).toEqual([...expectedIds].sort());
  expect(ids.map(id => graph.nodes.get(id)?.label)).toEqual(
    expect.arrayContaining(resources.map(resource => resource.id)),
  );
  return graph;
}

function refScopeFor(graph: RepositoryGraph, id: string): string | undefined {
  const node = graph.nodes.get(id);
  if (node?.type !== 'runtime-resource') throw new Error(`Expected runtime-resource node ${id}`);
  return node.data?.refScope;
}

describe('core-laws Kubernetes runtime-resource identity', () => {
  it('keeps a same-name Service and Ingress as distinct nodes with plain-name labels', () => {
    const graph = expectDistinctRuntimeNodes(
      [
        k8sResource('Service', 'k8s-service', 'web'),
        k8sResource('Ingress', 'k8s-service', 'web'),
      ],
      [
        'resource:k8s:_/Service/web',
        'resource:k8s:_/Ingress/web',
      ],
    );

    // The manifest kind separates them inside the id, so the node needs no field of its own for it.
    // What the node does carry is the scope both share: same namespace, different objects.
    expect(refScopeFor(graph, 'resource:k8s:_/Service/web')).toBe('k8s/_');
    expect(refScopeFor(graph, 'resource:k8s:_/Ingress/web')).toBe('k8s/_');
  });

  it('keeps the same kind and name in two namespaces as distinct nodes', () => {
    expectDistinctRuntimeNodes(
      [
        k8sResource('Service', 'k8s-service', 'web', 'blue'),
        k8sResource('Service', 'k8s-service', 'web', 'green'),
      ],
      [
        'resource:k8s:blue/Service/web',
        'resource:k8s:green/Service/web',
      ],
    );
  });

  it('keeps same-name Deployment and StatefulSet resources in the shared coarse bucket', () => {
    expectDistinctRuntimeNodes(
      [
        k8sResource('Deployment', 'k8s-deployment', 'worker'),
        k8sResource('StatefulSet', 'k8s-deployment', 'worker'),
      ],
      [
        'resource:k8s:_/Deployment/worker',
        'resource:k8s:_/StatefulSet/worker',
      ],
    );
  });

  it('routes a same-name Ingress backend to the Service instead of to the Ingress', () => {
    const ingressId = 'resource:k8s:_/Ingress/web';
    const serviceId = 'resource:k8s:_/Service/web';
    // Put the Ingress first to prove lookup does not depend on runtime-resource insertion order.
    const ingress = k8sResource('Ingress', 'k8s-service', 'web', undefined, 'web');
    const service = k8sResource('Service', 'k8s-service', 'web');
    const graph = graphFor(
      [ingress, service],
      [k8sObjectFact(ingress, ['web']), k8sObjectFact(service)],
    );

    const routes = (graph.outEdges.get(ingressId) ?? []).filter(edge => edge.kind === 'routes_to');
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ from: ingressId, to: serviceId, kind: 'routes_to' });
  });

  it('routes an Ingress only to a same-name Service in its own namespace', () => {
    // The ingress lives in the namespace that sorts *last*, so a lookup that ignored the namespace
    // would answer with the other service rather than land on the right one by ordering.
    const ingressId = 'resource:k8s:green/Ingress/web';
    const greenServiceId = 'resource:k8s:green/Service/web';
    const blueServiceId = 'resource:k8s:blue/Service/web';
    const ingress = k8sResource('Ingress', 'k8s-service', 'web', 'green', 'web');
    // Declare the wrong namespace first so insertion order cannot mask the bug either.
    const blue = k8sResource('Service', 'k8s-service', 'web', 'blue');
    const green = k8sResource('Service', 'k8s-service', 'web', 'green');
    const graph = graphFor(
      [ingress, blue, green],
      [k8sObjectFact(ingress, ['web']), k8sObjectFact(blue), k8sObjectFact(green)],
    );

    const routes = (graph.outEdges.get(ingressId) ?? []).filter(edge => edge.kind === 'routes_to');
    expect(routes).toEqual([expect.objectContaining({ from: ingressId, to: greenServiceId })]);
    expect(routes.some(edge => edge.to === blueServiceId)).toBe(false);
  });
});
