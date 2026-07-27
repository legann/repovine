import type { ToolHandler } from '../types.js';
import type { InvestigateTag, AnnotationContent, RepositoryGraph } from '../../types.js';
import { resolveScope, parentModuleId } from '../scope/resolve.js';
import { nodeLabel, taggedDomains } from '../../graph/index.js';
import { scopeNavigation } from '../scope/navigation.js';
import { envelope, envelopeError, nav, type AttentionItem } from '../response/envelope.js';
import { DEFAULT_BODY_LIMIT } from '../response/pagination.js';
import { priorityWeight } from '../lib/investigate-refs.js';
import { deliveryMechanic } from '../../mechanics/registry.js';
import { buildInspectNodeDetail, graphEdgeCount } from '../lib/inspect-node-core.js';
import { computeRuntimeHandoff } from '../lib/runtime-handoff.js';

/** Plain-language gloss per investigate tag for the `attention` block (data, not imperative). */
const TAG_NOTE: Record<InvestigateTag, string> = {
  risk: 'consumer-scoped risk',
  boundary: 'off-limits boundary surface',
  effect: 'persistent side effect',
  wiring: 'runtime-wired — deployed topology dispatches into or binds from this node',
  'co-change': 'implements relation — contract and implementations move together',
  hub: 'shared hub — many importers',
  unannotated: 'no annotation',
};

/** Advisory structural tags: inline-only on refs, excluded from the ref-attention hoist. */
const ADVISORY_TAGS: ReadonlySet<string> = new Set(['hub', 'wiring', 'co-change']);

/**
 * Hoist open obligations — investigate-tagged refs and must-inspect pointers — to a compact top-level
 * block, deduped by node and ranked by tag priority. Data the agent can act on cheaply; never a gate.
 */
function buildAttention(
  drillDown: Array<{ id?: string; investigate?: unknown }>,
  links: Array<{ targetId?: string; investigate?: unknown }>,
  pointers: Array<{ id?: string; investigate?: unknown }>,
): AttentionItem[] {
  const byNode = new Map<string, string[]>();
  const add = (nodeId: string | undefined, tags: unknown): void => {
    if (!nodeId || !Array.isArray(tags)) return;
    // Advisory tags ("impact-check if you edit") are not obligations ("inspect before unchanged").
    // Keep them as inline ref tags only; never hoist to attention (they flood large monorepos).
    // `wiring`'s salience surface is the deliberate self item, not ref hoisting.
    const eligible = (tags as string[]).filter((tag) => !ADVISORY_TAGS.has(tag));
    if (eligible.length === 0) return;
    const existing = byNode.get(nodeId);
    if (existing) {
      for (const tag of eligible) if (!existing.includes(tag)) existing.push(tag);
    } else {
      byNode.set(nodeId, [...eligible]);
    }
  };
  for (const child of drillDown) add(child.id, child.investigate);
  for (const link of links) add(link.targetId, link.investigate);
  for (const pointer of pointers) add(pointer.id, pointer.investigate);

  const weightOf = (tags: string[]): number =>
    tags.reduce((max, tag) => Math.max(max, priorityWeight(tag as InvestigateTag)), 0);
  return [...byNode.entries()]
    .sort((a, b) => weightOf(b[1]) - weightOf(a[1]))
    .map(([nodeId, tags]) => ({
      nodeId,
      investigate: tags,
      note: tags.map((tag) => TAG_NOTE[tag as InvestigateTag] ?? tag).join('; '),
      next: { tool: 'inspect_node', args: { nodeId } },
    }));
}

/**
 * The inspected node's own boundary risk, hoisted into `attention`. `buildAttention` surfaces boundary
 * risks on a node's refs (neighbors reached through it); this surfaces the case where the inspected
 * node is itself the off-limits surface. Landing directly on a frozen edit-site is then as salient as
 * reaching it through an investigate-tagged ref, not buried among `annotation.risks`. `next` points at
 * the impact analysis — the cheap check before editing a boundary. Data, not a gate.
 */
export function selfBoundaryAttention(
  nodeId: string,
  annotation: AnnotationContent | undefined,
): AttentionItem | undefined {
  if (!deliveryMechanic('boundary').detect({ nodeId, annotation })) return undefined;
  return {
    nodeId,
    investigate: ['boundary'],
    note: `${TAG_NOTE.boundary} — this node`,
    next: { tool: 'analyze_dependencies', args: { scope: nodeId, mode: 'impact' } },
  };
}

/**
 * The inspected node's own runtime wiring, hoisted into `attention`. Deployed topology reaches a
 * handler through an `infra` in-edge, which the node's own `links` never show (`getLinks` is
 * out-edges only) — so the item names the wired resources itself. `next` bridges to the runtime
 * view. Data, not a gate.
 */
export function selfWiringAttention(
  nodeId: string,
  graph: RepositoryGraph,
): AttentionItem | undefined {
  if (!deliveryMechanic('wiring').detect({ nodeId, edgeCount: graphEdgeCount(graph) })) return undefined;
  const resourceIds: string[] = [];
  for (const e of graph.inEdges.get(nodeId) ?? []) if (e.kind === 'infra') resourceIds.push(e.from);
  for (const e of graph.outEdges.get(nodeId) ?? []) if (e.kind === 'binds_to') resourceIds.push(e.to);
  const labels = [...new Set(resourceIds)].slice(0, 2).map((id) => nodeLabel(graph, id));
  return {
    nodeId,
    investigate: ['wiring'],
    note: `${TAG_NOTE.wiring} (wired: ${labels.join(', ')})`,
    next: { tool: 'trace_flow', args: { scope: nodeId } },
  };
}

export const handleInspectNode: ToolHandler = async (ctx, args) => {
  const explicitNode = typeof args.nodeId === 'string' ? args.nodeId : undefined;
  const scope = resolveScope(ctx, explicitNode ?? args.scope);
  if (!scope.nodeId && scope.kind !== 'domain') {
    return envelopeError(scope, 'inspect_node requires nodeId or a scope that resolves to a concrete graph node', {
      scope: scope.raw,
      resolvedScope: scope.resolvedScope,
      emptyDiagnostic: {
        reason: 'scope_unresolved',
        message: `"${scope.raw}" did not resolve to a concrete graph node.`,
        confidence: 'high',
        nextActions: [
          { when: 'if this is a symbol or path', tool: 'search_context', args: { query: scope.query ?? scope.raw } },
          { when: 'to browse from the repository root', tool: 'map_context', args: { scope: 'all', view: 'summary' } },
        ],
      },
    });
  }
  const nodeId = scope.nodeId ?? scope.domainId;
  if (!nodeId) return envelopeError(scope, `Could not resolve node: ${scope.raw}`);

  const result = await buildInspectNodeDetail(ctx, {
    nodeId,
    includeBody: args.includeBody,
    bodyOffset: args.bodyOffset,
    bodyLimit: args.bodyLimit,
    grepBody: args.grepBody,
    includePrivate: args.includePrivate,
    includeInternals: args.includeInternals,
    exportLimit: args.exportLimit,
    exportOffset: args.exportOffset,
  }) as Record<string, unknown>;

  if (result.error) {
    return envelope(scope, `Could not inspect ${nodeId}.`, result, {
      confidence: 'low',
      gaps: [String(result.error)],
      navigation: scopeNavigation(scope),
    });
  }

  const { graph } = ctx.getState();
  const node = graph.nodes.get(nodeId);
  const navigation = scopeNavigation(scope);
  if (node?.type === 'runtime-resource') {
    const handoff = computeRuntimeHandoff(ctx, { scope, serviceIds: [nodeId] });
    if (handoff.items.length > 0) {
      result.runtimeHandoff = handoff;
      navigation.deeper.unshift(...handoff.items.map(item =>
        nav(
          'inspect_node',
          { nodeId: item.handlerModuleId },
          `Runtime handoff - handler module for ${item.resourceId}; inspect before editing code.`,
        ),
      ));
    }
  }
  // Must-inspect: integrationPoints dependencies carrying an obligation tag lead the deeper hints.
  // Advisory-only pointers (wiring/co-change/hub) stay inline; they are not must-inspect.
  const investigatePointers = Array.isArray(result.investigatePointers)
    ? result.investigatePointers as Array<{ id?: string; investigate?: string[] }>
    : [];
  const obligationPointers = investigatePointers.filter(
    (pointer) => pointer.investigate?.some((tag) => !ADVISORY_TAGS.has(tag)),
  );
  for (const pointer of obligationPointers.slice(0, 8)) {
    if (pointer.id) navigation.deeper.push(nav('inspect_node', { nodeId: pointer.id }, `Inspect ${pointer.id} — integrationPoints dependency carrying a consumer-scoped risk (must-inspect).`));
  }
  const drillDown = Array.isArray(result.drillDown) ? result.drillDown as Array<{ id?: string; label?: string; type?: string; investigate?: unknown }> : [];
  for (const child of drillDown.slice(0, 8)) {
    if (child.id) navigation.deeper.push(nav('inspect_node', { nodeId: child.id }, `Inspect child ${child.label ?? child.id}.`));
  }
  if ((node?.type === 'module' || node?.type === 'export-symbol') && args.includeBody !== true) {
    navigation.deeper.push(nav('inspect_node', { nodeId, includeBody: true, bodyLimit: DEFAULT_BODY_LIMIT }, 'Read a bounded source slice now that the node is narrowed.'));
  }
  const parent = graph.inEdges.get(nodeId)?.find(e => e.kind === 'contains')?.from;
  if (parent) navigation.up.push(nav('map_context', { scope: parent }, 'Return to the parent scope.'));
  const domainIds = taggedDomains(graph, parentModuleId(graph, nodeId) ?? nodeId).ids.slice(0, 3);
  for (const d of domainIds) {
    navigation.up.push(nav('map_context', { scope: d }, 'Return to a broader domain containing this node.'));
  }
  navigation.crossLayer.push(nav('trace_flow', { scope: nodeId }, 'Look for runtime/data-flow links around this node.'));

  const links = Array.isArray(result.links) ? result.links as Array<{ targetId?: string; investigate?: unknown }> : [];
  const refAttention = buildAttention(drillDown, links, investigatePointers as Array<{ id?: string; investigate?: unknown }>);
  // Lead with the inspected node's own boundary risk and runtime wiring, so a frozen edit-site or a
  // deployed handler is salient even when the agent lands on it directly rather than reaching it
  // through an investigate-tagged ref.
  const selfBoundary = selfBoundaryAttention(nodeId, result.annotation as AnnotationContent | undefined);
  const selfWiring = selfWiringAttention(nodeId, graph);
  const selfItems = [selfBoundary, selfWiring].filter((item): item is AttentionItem => item !== undefined);
  const attention = selfItems.length > 0
    ? [...selfItems, ...refAttention.filter((item) => item.nodeId !== nodeId)]
    : refAttention;

  return envelope(scope, `Inspected ${nodeId}.`, result, {
    confidence: 'high',
    navigation,
    ...(attention.length ? { attention } : {}),
  });
};
