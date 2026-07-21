import { describe, expect, it } from '@jest/globals';
import { composeRepositoryGraph } from '../../src/stage2/index.js';
import type {
  InfraResource,
  InfraResourceKind,
  RepositoryFactsSnapshot,
  RepositoryGraph,
} from '../../src/types.js';

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
    contentHash: `${namespace ?? '_'}:${originalKind}:${name}`,
    attributes: {
      kind: originalKind,
      ...(namespace ? { namespace } : {}),
      ...(ingressBackends ? { ingressBackends } : {}),
    },
  };
}

function graphFor(resources: InfraResource[]): RepositoryGraph {
  const snapshot: RepositoryFactsSnapshot = {
    repoRoot: '/repo',
    timestamp: new Date(0).toISOString(),
    packages: [],
    modules: [],
    infraModules: [{
      id: 'infra:kubernetes:manifests/test.yaml',
      kind: 'kubernetes',
      filePath: '/repo/manifests/test.yaml',
      relativeFilePath: 'manifests/test.yaml',
      contentHash: 'infra',
      resources,
    }],
  };
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

function k8sKindFor(graph: RepositoryGraph, id: string): string | undefined {
  const node = graph.nodes.get(id);
  if (node?.type !== 'runtime-resource') throw new Error(`Expected runtime-resource node ${id}`);
  return node.data?.k8sKind;
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

    expect(k8sKindFor(graph, 'resource:k8s:_/Service/web')).toBe('Service');
    expect(k8sKindFor(graph, 'resource:k8s:_/Ingress/web')).toBe('Ingress');
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
    const graph = graphFor([
      // Put the Ingress first to prove lookup does not depend on runtime-resource insertion order.
      k8sResource('Ingress', 'k8s-service', 'web', undefined, 'web'),
      k8sResource('Service', 'k8s-service', 'web'),
    ]);

    const routes = (graph.outEdges.get(ingressId) ?? []).filter(edge => edge.kind === 'routes_to');
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ from: ingressId, to: serviceId, kind: 'routes_to' });
  });

  it('routes an Ingress only to a same-name Service in its own namespace', () => {
    const ingressId = 'resource:k8s:blue/Ingress/web';
    const blueServiceId = 'resource:k8s:blue/Service/web';
    const greenServiceId = 'resource:k8s:green/Service/web';
    const graph = graphFor([
      k8sResource('Ingress', 'k8s-service', 'web', 'blue', 'web'),
      // Put the wrong namespace first so insertion order cannot mask the bug.
      k8sResource('Service', 'k8s-service', 'web', 'green'),
      k8sResource('Service', 'k8s-service', 'web', 'blue'),
    ]);

    const routes = (graph.outEdges.get(ingressId) ?? []).filter(edge => edge.kind === 'routes_to');
    expect(routes).toEqual([expect.objectContaining({ from: ingressId, to: blueServiceId })]);
    expect(routes.some(edge => edge.to === greenServiceId)).toBe(false);
  });
});
