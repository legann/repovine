import { hasBoundaryScopedRisk, hasConsumerScopedRisk } from '../annotations/format.js';
import { hasPersistentEffect } from '../annotations/side-effect-vocab.js';
import type { InvestigateTag } from '../types.js';
import type { Channel, DeliveryMechanic, DeliveryMechanicContext } from './types.js';

/**
 * Absolute minimum importer count for the `hub` mechanic, and the floor under the adaptive
 * threshold so a tiny repo still needs a real count. The live threshold is
 * `max(HUB_IMPORTER_FLOOR, percentile)` — see `computeHubInDegreeThreshold` in
 * `mcp/lib/investigate-refs.ts`, which re-exports this constant.
 */
export const HUB_IMPORTER_FLOOR = 8;

/**
 * The mechanics registry — dispatch SSOT: which mechanics exist, their priority, and their
 * detection dispatch. Array order IS the tag priority (`INVESTIGATE_PRIORITY` aliases
 * {@link DELIVERY_MECHANIC_PRIORITY}). Detection predicates are referenced from the rule SSOT
 * (`format.ts`, `side-effect-vocab.ts`), not relocated.
 *
 * Inherited naming skew kept as-is: the consumer mechanic emits the tag `risk` (API-visible in
 * `inspect_node` responses).
 */
export const DELIVERY_MECHANICS: readonly DeliveryMechanic[] = [
  {
    id: 'risk',
    reads: ['annotation.scope:consumer'],
    direction: 'propagating',
    channels: ['pull-neighbor', 'pull-carrier', 'advisory'],
    detect: (ctx: DeliveryMechanicContext) => hasConsumerScopedRisk(ctx.annotation),
  },
  {
    id: 'boundary',
    reads: ['annotation.scope:boundary'],
    direction: 'self',
    channels: ['pull-self', 'pull-neighbor', 'pull-carrier', 'push', 'advisory'],
    detect: (ctx: DeliveryMechanicContext) => hasBoundaryScopedRisk(ctx.annotation),
  },
  {
    id: 'effect',
    reads: ['annotation.sideEffects'],
    direction: 'self',
    channels: ['pull-neighbor', 'pull-carrier'],
    detect: (ctx: DeliveryMechanicContext) => hasPersistentEffect(ctx.annotation?.sideEffects),
  },
  {
    // RESERVED — holds its priority slot, produced by no channel yet.
    id: 'unannotated',
    reads: ['annotation:absent'],
    direction: 'self',
    channels: [],
    detect: () => false,
  },
  {
    id: 'wiring',
    reads: ['topology.runtimeEdges'],
    direction: 'self',
    channels: ['pull-self', 'pull-neighbor', 'pull-carrier'],
    // Resource → handler dispatch (`infra` in-edge) or handler → resource binding (`binds_to`
    // out-edge). Resource-side kinds (`publishes`/`consumes`/`routes_to`) never touch code nodes
    // and belong to `trace_flow`, not this mechanic.
    detect: (ctx: DeliveryMechanicContext) =>
      !!ctx.edgeCount
      && (ctx.edgeCount(ctx.nodeId, 'infra', 'in') > 0 || ctx.edgeCount(ctx.nodeId, 'binds_to', 'out') > 0),
  },
  {
    id: 'co-change',
    reads: ['topology.implementsEdges'],
    // Semantically symmetric; the enum has no `symmetric` value, and `propagating` is the closer of
    // the two. It carries no dispatch: push admission is `channels`, not `direction`.
    direction: 'propagating',
    channels: ['pull-neighbor', 'pull-carrier'],
    detect: (ctx: DeliveryMechanicContext) =>
      !!ctx.edgeCount
      && (ctx.edgeCount(ctx.nodeId, 'implements', 'in') > 0 || ctx.edgeCount(ctx.nodeId, 'implements', 'out') > 0),
  },
  {
    id: 'hub',
    reads: ['topology.inDegree'],
    direction: 'self',
    channels: ['pull-neighbor', 'pull-carrier'],
    detect: (ctx: DeliveryMechanicContext) =>
      !!ctx.importerCount && ctx.importerCount(ctx.nodeId) >= (ctx.hubThreshold ?? HUB_IMPORTER_FLOOR),
  },
];

/**
 * Mechanics a channel carries, in registry (priority) order.
 *
 * The lookup a delivery surface uses instead of walking the whole registry. It is what makes
 * `channels` load-bearing: before this, the field documented an intent no code read, so a mechanic
 * could declare a channel it never reached and a surface could carry one it never declared.
 *
 * Resolved once per channel: the ref-tagging path calls this per reference, and the registry is a
 * module constant, so filtering it again per call would allocate on a hot path for a fixed answer.
 */
const MECHANICS_BY_CHANNEL = new Map<Channel, readonly DeliveryMechanic[]>();

export function mechanicsForChannel(channel: Channel): readonly DeliveryMechanic[] {
  const cached = MECHANICS_BY_CHANNEL.get(channel);
  if (cached) return cached;
  const carried = DELIVERY_MECHANICS.filter((m) => m.channels.includes(channel));
  MECHANICS_BY_CHANNEL.set(channel, carried);
  return carried;
}

/**
 * Where each channel is produced. One entry per {@link Channel}, and the reason totality is
 * checkable in both directions: a channel with no surface and a surface with no channel are both
 * visible from here.
 */
export const CHANNEL_SURFACES: Record<Channel, {
  /** Functions that emit the signal on this channel. */
  producers: readonly string[];
  /** Where a caller reads it. */
  field: string;
}> = {
  'pull-self': {
    producers: ['mcp/tools/inspect-node.ts:selfAttention'],
    field: 'attention[]',
  },
  'pull-neighbor': {
    producers: ['mcp/lib/investigate-refs.ts:applyInvestigateTags', 'mcp/lib/runtime-handoff.ts:computeRuntimeHandoff'],
    // The handoff entry carries the same signal without an `investigate` tag: it names the handler
    // module and why to read it (`trigger`, `note`), because the neighbour is reached across a
    // runtime edge rather than a ref the caller can already see.
    field: 'result.links[].investigate, result.drillDown[].investigate; result.runtimeHandoff.items[].trigger',
  },
  'pull-carrier': {
    producers: ['mcp/lib/investigate-refs.ts:applyInvestigateTags'],
    field: 'result.investigatePointers[]',
  },
  push: {
    producers: ['mcp/boundary-index.ts:buildBoundaryIndex'],
    field: '.repovine/boundary-index.json',
  },
  advisory: {
    producers: ['annotations/carrier-links.ts:computeCarrierLinkGaps', 'annotations/risk-scope-candidates.ts:computeRiskScopeCandidates'],
    field: 'result.validation.nextActions[], result.carrierGaps, result.riskScopeCandidates',
  },
};

/** Tag priority derived from registry order, highest first. */
export const DELIVERY_MECHANIC_PRIORITY: readonly InvestigateTag[] = DELIVERY_MECHANICS.map((m) => m.id);

/** Look up one mechanic by id. Total over `InvestigateTag` — every tag has a registered mechanic. */
export function deliveryMechanic(id: InvestigateTag): DeliveryMechanic {
  const found = DELIVERY_MECHANICS.find((m) => m.id === id);
  if (!found) throw new Error(`Unknown mechanic: ${id}`);
  return found;
}
