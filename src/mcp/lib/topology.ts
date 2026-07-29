import type { McpToolRuntime } from '../types.js';
import type { EdgeKind, RepositoryGraph } from '../../types.js';
import { ALL_SCOPE, type ResolvedScope, type ScopeKind } from '../../scope/resolved.js';
import { handlerModuleIds, infraTargetIds, isTaggedInto, modulePackageId, nodeLabel, nodesOfType, taggedDomains } from '../../graph/index.js';
import { resolveInfraRef } from '../../graph/resolve-infra-ref.js';
import { provenance } from '../../response/provenance.js';

/**
 * The service label published beside a publish edge.
 *
 * The graph carries what the resource's plugin declared its kind to be. A resource whose ecosystem
 * declared no service label is reported as a plain resource rather than guessed at from its id.
 */
export function publishTypeForRuntimeResource(graph: RepositoryGraph, serviceId: string): string {
  const node = graph.nodes.get(serviceId);
  const service = node?.type === 'runtime-resource' ? node.data?.service : undefined;
  return service ?? 'resource';
}

/**
 * The scope kinds runtime topology can narrow to.
 *
 * A kind belongs here when it decides membership for a runtime resource: the resource itself and a
 * module reach it through the infra hull, a package through the modules it contains, a domain
 * through its tags, a query by name. An `export-symbol`, `template` or `infra` scope decides nothing
 * about a resource — projecting the repository under that name reported every service in the graph
 * as that scope's runtime topology.
 */
export const RUNTIME_TOPOLOGY_SCOPE_KINDS: readonly ScopeKind[] =
  ['all', 'runtime-resource', 'module', 'package', 'domain', 'query'];

export function topologyCanScope(kind: ScopeKind): boolean {
  return RUNTIME_TOPOLOGY_SCOPE_KINDS.includes(kind);
}

export function projectRuntimeTopology(
  ctx: McpToolRuntime,
  args: { scope?: ResolvedScope; includeResources?: boolean; includeApiRoutes?: boolean },
): unknown {
  const { graph } = ctx.getState();
  const scope = args.scope ?? ALL_SCOPE;
  const includeResources = args.includeResources !== false;
  const includeApiRoutes = args.includeApiRoutes !== false;

  const serviceIds = nodesOfType(graph, 'runtime-resource');

  const hullSeedId = scope.kind === 'runtime-resource' || scope.kind === 'module' ? scope.nodeId : undefined;

  const hullServiceIds = new Set<string>();
  if (hullSeedId) {
    const seeds: string[] = [];
    if (scope.kind === 'runtime-resource') {
      seeds.push(hullSeedId);
    } else {
      const inEdges = graph.inEdges.get(hullSeedId) ?? [];
      for (const edge of inEdges) {
        if (edge.kind === 'infra' && edge.from.startsWith('resource:')) seeds.push(edge.from);
      }
    }
    const expandKinds: ReadonlySet<string> = new Set(['uses_env', 'publishes', 'consumes', 'routes_to'] as const satisfies readonly EdgeKind[]);
    for (const seed of seeds) {
      hullServiceIds.add(seed);
      const out = graph.outEdges.get(seed) ?? [];
      for (const edge of out) {
        if (expandKinds.has(edge.kind) && edge.to.startsWith('resource:')) hullServiceIds.add(edge.to);
      }
      const inc = graph.inEdges.get(seed) ?? [];
      for (const edge of inc) {
        if (expandKinds.has(edge.kind) && edge.from.startsWith('resource:')) hullServiceIds.add(edge.from);
      }
    }
  }

  // Membership per scope kind. A kind outside RUNTIME_TOPOLOGY_SCOPE_KINDS falls through to false:
  // it narrows to nothing rather than to everything.
  const isInScope = (svcId: string): boolean => {
    if (scope.kind === 'all') return true;
    if (hullSeedId) return hullServiceIds.has(svcId);
    if (scope.kind === 'domain' && scope.domainId) {
      return isTaggedInto(graph, svcId, scope.domainId);
    }
    if (scope.kind === 'package' && scope.packageId) {
      const infraTargets = infraTargetIds(graph, svcId);
      if (infraTargets.some(modId => modulePackageId(graph, modId) === scope.packageId)) return true;
    }
    if (scope.kind === 'query' && scope.query) {
      const q = scope.query.toLowerCase();
      return svcId.toLowerCase().includes(q) || (graph.nodes.get(svcId)?.label.toLowerCase().includes(q) ?? false);
    }
    return false;
  };

  type RuntimeResourceEntry = {
    id: string;
    type: string;
    consumers: string[];
    producers: string[];
    flowConsumers: string[];
  };

  const services: unknown[] = [];
  const resourceMap = new Map<string, RuntimeResourceEntry>();
  const dataFlows: unknown[] = [];
  const pushUnique = (arr: string[], value: string): void => {
    if (!arr.includes(value)) arr.push(value);
  };

  for (const svcId of serviceIds) {
    if (!isInScope(svcId)) continue;
    const node = graph.nodes.get(svcId);
    if (!node || node.type !== 'runtime-resource') continue;

    const svcData = node.data;
    const outEdges = graph.outEdges.get(svcId) ?? [];
    const inEdges = graph.inEdges.get(svcId) ?? [];

    const domains = taggedDomains(graph, svcId).labels;

    // Two different facts used to share the name `handler`: what the IaC document declares, and
    // which code the resolver bound the resource to. They answer different questions and can
    // disagree, so they are reported separately. A resource can also carry several infra edges —
    // a container with more than one image reaches more than one Dockerfile — and naming the first
    // one `handler` was a guess. Only `mod:` targets are code; `infra:dockerfile:*` is a build
    // artifact, not the module that runs.
    // Sorted by label, which is what the reader sees; the resolver sorts by id, and the two orders
    // differ once a label is a truncated display form of a longer path.
    const handlerModules = handlerModuleIds(graph, svcId)
      .map(id => nodeLabel(graph, id))
      .sort();

    const triggers: unknown[] = [];
    if (svcData?.triggers) {
      for (const t of svcData.triggers) {
        if (!includeApiRoutes && t.type === 'api') continue;
        triggers.push(t);
      }
    }

    // References resolve against the document that declares this service, the same scope the graph
    // builder used. A global label scan here would re-introduce the cross-template match the
    // builder refused.
    const refScope = {
      declaredIn: svcData?.declaredIn,
      namespace: svcData?.namespace,
      provider: svcData?.provider,
    };

    const resources: unknown[] = [];
    if (svcData?.envRefs) {
      for (const ref of svcData.envRefs) {
        if (ref.targetLogicalId) {
          const resolution = resolveInfraRef(graph, ref.targetLogicalId, refScope);
          const targetNode = resolution.status === 'resolved' ? resolution.serviceId : undefined;
          if (targetNode) {
            const targetGraphNode = graph.nodes.get(targetNode);
            resources.push({
              id: targetNode,
              logicalId: ref.targetLogicalId,
              // `access` reports the grant the IaC document declares. When no grant document was
              // parsed for this target the mode stays 'unknown' — a binding without a readable
              // verb is an unread fact, and reporting a default here would state one.
              access: ref.access ?? 'unknown',
              provenance: provenance(ref.access ? 'iam-policy' : 'not-declared'),
              envVar: ref.varName,
            });
            if (!resourceMap.has(targetNode)) {
              resourceMap.set(targetNode, {
                id: targetNode,
                type: targetGraphNode?.description ?? 'unknown',
                consumers: [],
                producers: [],
                flowConsumers: [],
              });
            }
            pushUnique(resourceMap.get(targetNode)!.consumers, node.label);
          }
        }
      }
    }

    const publishes: unknown[] = [];
    const consumedBy = inEdges.filter(e => e.kind === 'consumes');
    for (const edge of consumedBy) {
      const producerNode = graph.nodes.get(edge.from);
      if (producerNode) {
        if (!resourceMap.has(edge.from)) {
          resourceMap.set(edge.from, { id: edge.from, type: producerNode.description, consumers: [], producers: [], flowConsumers: [] });
        }
        pushUnique(resourceMap.get(edge.from)!.consumers, node.label);
        pushUnique(resourceMap.get(edge.from)!.flowConsumers, node.label);
      }
    }

    const producesTo = outEdges.filter(e => e.kind === 'publishes');
    for (const edge of producesTo) {
      const targetNode = graph.nodes.get(edge.to);
      if (!targetNode) continue;
      publishes.push({ type: publishTypeForRuntimeResource(graph, edge.to), target: edge.to, label: targetNode.label });
      if (!resourceMap.has(edge.to)) {
        resourceMap.set(edge.to, { id: edge.to, type: targetNode.description, consumers: [], producers: [], flowConsumers: [] });
      }
      pushUnique(resourceMap.get(edge.to)!.producers, node.label);
    }

    // `routes_to`: a request-routing hop (e.g. a k8s Ingress to its backend Service). Unlike the
    // queue-mediated publish/consume flows above, this is a direct resource→resource edge. Surfacing
    // it here is what makes the edge witnessed by a query — `routesTo` answers "where does this route
    // to?", `routedFrom` answers "what routes into this service?".
    const routesTo: unknown[] = [];
    for (const edge of outEdges.filter(e => e.kind === 'routes_to')) {
      const targetNode = graph.nodes.get(edge.to);
      if (targetNode) routesTo.push({ target: edge.to, label: targetNode.label });
    }
    const routedFrom: unknown[] = [];
    for (const edge of inEdges.filter(e => e.kind === 'routes_to')) {
      const sourceNode = graph.nodes.get(edge.from);
      if (sourceNode) routedFrom.push({ source: edge.from, label: sourceNode.label });
    }

    services.push({
      id: svcId,
      label: node.label,
      kind: svcData?.kind,
      provider: svcData?.provider,
      // As the IaC document declares it (`handlers/user.main`), absent when it declares none.
      handler: svcData?.handler,
      // Code the resolver bound this resource to; empty when nothing resolved.
      handlerModules: handlerModules.length > 0 ? handlerModules : undefined,
      domains,
      triggers: triggers.length > 0 ? triggers : undefined,
      resources: resources.length > 0 ? resources : undefined,
      // References the declaring document names but resolution refused to bind. Reported so the
      // absence of an edge reads as a known gap rather than as an absent reference.
      unresolvedRefs: svcData?.unresolvedRefs?.length ? svcData.unresolvedRefs : undefined,
      publishes: publishes.length > 0 ? publishes : undefined,
      routesTo: routesTo.length > 0 ? routesTo : undefined,
      routedFrom: routedFrom.length > 0 ? routedFrom : undefined,
    });
  }

  // Every producer of a shared resource is paired with every consumer of it. Each pair is a real
  // static possibility — the producer writes where the consumer reads — but nothing here observes
  // that a given message travels from this producer to this consumer. `relation` carries that
  // distinction so the pair is not read as a witnessed route.
  for (const [queueId, entry] of resourceMap) {
    if (entry.producers.length > 0 && entry.flowConsumers.length > 0) {
      for (const from of entry.producers) {
        for (const to of entry.flowConsumers) {
          if (from !== to) {
            dataFlows.push({ from, through: queueId, to, relation: 'possible-via-shared-resource' });
          }
        }
      }
    }
  }

  const result: Record<string, unknown> = { scope: scope.resolvedScope, services };
  if (includeResources && resourceMap.size > 0) {
    result.resources = [...resourceMap.values()].map(({ flowConsumers: _flowConsumers, ...entry }) => entry);
  }
  if (dataFlows.length > 0) {
    result.dataFlows = dataFlows;
  }
  return result;
}
