import { deliveryMechanic } from '../../mechanics/registry.js';
import { compareCodeUnits } from '../../platform/ordering.js';
import type { RepositoryGraph } from '../../types.js';
import { handlerModuleIds, isNodeType, nodesOfType } from '../../graph/index.js';
import type { McpToolRuntime } from '../types.js';
import type { ResolvedScope } from '../../scope/resolved.js';
import { narrowTruncation, truncationMap, type TruncationMap } from '../../response/truncation.js';

export const RUNTIME_HANDOFF_LIMIT = 3;

export const RUNTIME_HANDOFF_NOTE =
  'Handler module owns editable code; inspect it for consumer/boundary obligations before editing.';

export type RuntimeHandoffTrigger = 'annotation' | 'secret-binding' | 'scoped-resource';

export interface RuntimeHandoffEntry {
  resourceId: string;
  handlerModuleId: string;
  trigger: RuntimeHandoffTrigger;
  note: string;
}

export interface RuntimeHandoffResult {
  items: RuntimeHandoffEntry[];
  truncation?: TruncationMap;
}

const TRIGGER_PRIORITY: Record<RuntimeHandoffTrigger, number> = {
  'secret-binding': 0,
  annotation: 1,
  'scoped-resource': 2,
};

export function resolveHandlerModuleId(graph: RepositoryGraph, resourceId: string): string | undefined {
  const [infraMod] = handlerModuleIds(graph, resourceId);
  if (infraMod) return infraMod;

  const resourceNode = graph.nodes.get(resourceId);
  const handler = resourceNode?.type === 'runtime-resource' ? resourceNode.data?.handler : undefined;
  if (!handler) return undefined;
  if (handler.startsWith('mod:') && isNodeType(graph, handler, 'module')) return handler;

  return nodesOfType(graph, 'module')
    .filter((moduleId) => {
      const node = graph.nodes.get(moduleId);
      if (!node) return false;
      const data = node.data as {
        absPath?: string;
        pkgRelPath?: string;
        repoRelPath?: string;
      } | undefined;
      return node.label === handler
        || moduleId === handler
        || data?.pkgRelPath === handler
        || data?.repoRelPath === handler
        || data?.absPath === handler;
    })
    .sort()[0];
}

function hasScopedAnnotationRisk(ctx: McpToolRuntime, nodeId: string): boolean {
  const annotation = ctx.getState().annotations.get(nodeId)?.annotation;
  // Through the registry, not the rule predicates: the handoff item is `risk`/`boundary` delivered
  // on a third node, and reading the predicates directly let the two drift apart.
  return deliveryMechanic('risk').detect({ nodeId, annotation })
    || deliveryMechanic('boundary').detect({ nodeId, annotation });
}

function pointsToSecret(graph: RepositoryGraph, sourceId: string): boolean {
  return (graph.outEdges.get(sourceId) ?? []).some((edge) => {
    if (edge.kind !== 'binds_to' && edge.kind !== 'uses_env') return false;
    const target = graph.nodes.get(edge.to);
    return target?.type === 'runtime-resource' && target.data?.kind === 'secret';
  });
}

function hasSecretBindingForPair(graph: RepositoryGraph, resourceId: string, handlerModuleId: string): boolean {
  return pointsToSecret(graph, resourceId) || pointsToSecret(graph, handlerModuleId);
}

function primaryResourceSeedsForModule(graph: RepositoryGraph, moduleId: string): string[] {
  return (graph.inEdges.get(moduleId) ?? [])
    .filter(edge => edge.kind === 'infra' && edge.from.startsWith('resource:'))
    .map(edge => edge.from)
    .sort();
}

function chooseTrigger(args: {
  hasSecretBinding: boolean;
  hasAnnotationRisk: boolean;
  isScopedResource: boolean;
}): RuntimeHandoffTrigger | undefined {
  if (args.hasSecretBinding) return 'secret-binding';
  if (args.hasAnnotationRisk) return 'annotation';
  if (args.isScopedResource) return 'scoped-resource';
  return undefined;
}

export function computeRuntimeHandoff(
  ctx: McpToolRuntime,
  args: {
    scope: ResolvedScope;
    serviceIds: string[];
  },
): RuntimeHandoffResult {
  const { graph } = ctx.getState();
  const candidateResourceIds = new Set(
    args.serviceIds.filter(id => isNodeType(graph, id, 'runtime-resource')),
  );
  const scopedResourceIds = new Set<string>();

  if (args.scope.kind === 'runtime-resource') {
    const resourceId = args.scope.nodeId ?? args.scope.resolvedScope;
    if (isNodeType(graph, resourceId, 'runtime-resource')) {
      candidateResourceIds.add(resourceId);
      scopedResourceIds.add(resourceId);
    }
  }

  if (args.scope.kind === 'module') {
    const moduleId = args.scope.nodeId ?? args.scope.resolvedScope;
    const primarySeeds = primaryResourceSeedsForModule(graph, moduleId);
    if (primarySeeds.length === 1) {
      candidateResourceIds.add(primarySeeds[0]);
      scopedResourceIds.add(primarySeeds[0]);
    }
  }

  const entries: RuntimeHandoffEntry[] = [];
  const seenPairs = new Set<string>();

  for (const resourceId of candidateResourceIds) {
    const handlerModuleId = resolveHandlerModuleId(graph, resourceId);
    if (!handlerModuleId) continue;
    const pairKey = `${resourceId}\0${handlerModuleId}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    const trigger = chooseTrigger({
      hasSecretBinding: hasSecretBindingForPair(graph, resourceId, handlerModuleId),
      hasAnnotationRisk: hasScopedAnnotationRisk(ctx, resourceId) || hasScopedAnnotationRisk(ctx, handlerModuleId),
      isScopedResource: scopedResourceIds.has(resourceId),
    });
    if (!trigger) continue;

    entries.push({
      resourceId,
      handlerModuleId,
      trigger,
      note: RUNTIME_HANDOFF_NOTE,
    });
  }

  entries.sort((a, b) =>
    TRIGGER_PRIORITY[a.trigger] - TRIGGER_PRIORITY[b.trigger]
    || compareCodeUnits(a.resourceId, b.resourceId)
    || compareCodeUnits(a.handlerModuleId, b.handlerModuleId),
  );

  const items = entries.slice(0, RUNTIME_HANDOFF_LIMIT);
  // The list leads the response so the highest-priority handler is never paged off; the rest is
  // reached by narrowing the traced scope, not by advancing an offset this list does not have.
  const truncation = truncationMap({
    items: entries.length > items.length
      ? narrowTruncation({
        shown: items.length,
        total: entries.length,
        hint: 'Handler handoffs are capped per response; page trace_flow with offset/limit or inspect_node each remaining resource individually.',
      })
      : undefined,
  });
  return { items, ...(truncation ? { truncation } : {}) };
}
