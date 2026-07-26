import type { McpToolRuntime } from '../types.js';
import type { EdgeKind } from '../../types.js';
import { resolveInfraRef } from '../../graph/resolve-infra-ref.js';

export function publishTypeForRuntimeResource(serviceId: string): string {
  if (serviceId.startsWith('resource:aws-sqs:')) return 'sqs';
  if (serviceId.startsWith('resource:aws-sns:')) return 'sns';
  if (serviceId.startsWith('resource:aws-lambda:')) return 'lambda';
  if (serviceId.startsWith('resource:aws-eventbridge:') || serviceId.startsWith('resource:aws-events:')) return 'eventbridge';
  return 'resource';
}

export function projectRuntimeTopology(ctx: McpToolRuntime, args: Record<string, unknown>): unknown {
  const { graph } = ctx.getState();
  const scope = (args.scope as string) ?? 'all';
  const includeResources = args.includeResources !== false;
  const includeApiRoutes = args.includeApiRoutes !== false;

  const serviceSet = graph.byType.get('runtime-resource');
  const serviceIds = serviceSet ? Array.from(serviceSet) : [];

  const scopeIsService = scope.startsWith('resource:') && graph.nodes.has(scope);
  const scopeIsMod = scope.startsWith('mod:') && graph.nodes.has(scope);
  const scopeDomainId = scope !== 'all' && !scope.startsWith('pkg:') && !scopeIsService && !scopeIsMod
    ? (scope.startsWith('domain:') ? scope : `domain:${scope}`)
    : null;
  const scopePkg = scope.startsWith('pkg:') ? scope : null;

  const hullServiceIds = new Set<string>();
  if (scopeIsService || scopeIsMod) {
    const seeds: string[] = [];
    if (scopeIsService) {
      seeds.push(scope);
    } else {
      const inEdges = graph.inEdges.get(scope) ?? [];
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

  const isInScope = (svcId: string): boolean => {
    if (scope === 'all') return true;
    if (scopeIsService || scopeIsMod) {
      return hullServiceIds.has(svcId);
    }
    if (scopeDomainId) {
      const outEdges = graph.outEdges.get(svcId) ?? [];
      return outEdges.some(e => e.kind === 'tagged' && e.to === scopeDomainId);
    }
    if (scopePkg) {
      const outEdges = graph.outEdges.get(svcId) ?? [];
      const infraTargets = outEdges.filter(e => e.kind === 'infra').map(e => e.to);
      for (const modId of infraTargets) {
        const inEdges = graph.inEdges.get(modId) ?? [];
        if (inEdges.some(e => e.kind === 'contains' && e.from === scopePkg)) return true;
      }
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

    const domains = outEdges
      .filter(e => e.kind === 'tagged')
      .map(e => graph.nodes.get(e.to)?.label)
      .filter((d): d is string => d != null);

    // Two different facts used to share the name `handler`: what the IaC document declares, and
    // which code the resolver bound the resource to. They answer different questions and can
    // disagree, so they are reported separately. A resource can also carry several infra edges —
    // a container with more than one image reaches more than one Dockerfile — and naming the first
    // one `handler` was a guess. Only `mod:` targets are code; `infra:dockerfile:*` is a build
    // artifact, not the module that runs.
    const handlerModules = outEdges
      .filter(e => e.kind === 'infra' && e.to.startsWith('mod:'))
      .map(e => graph.nodes.get(e.to)?.label)
      .filter((label): label is string => label != null)
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
              accessSource: ref.access ? 'iam-policy' : 'not-declared',
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
      publishes.push({ type: publishTypeForRuntimeResource(edge.to), target: edge.to, label: targetNode.label });
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

  const result: Record<string, unknown> = { scope, services };
  if (includeResources && resourceMap.size > 0) {
    result.resources = [...resourceMap.values()].map(({ flowConsumers: _flowConsumers, ...entry }) => entry);
  }
  if (dataFlows.length > 0) {
    result.dataFlows = dataFlows;
  }
  return result;
}
