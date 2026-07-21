import { hasBoundaryScopedRisk, hasConsumerScopedRisk } from '../annotations/format.js';
import { hasPersistentEffect } from '../annotations/side-effect-vocab.js';
import type { InvestigateTag } from '../types.js';
import type { DeliveryMechanic, DeliveryMechanicContext } from './types.js';

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
    channels: ['pull-self', 'pull-neighbor', 'push'],
    detect: (ctx: DeliveryMechanicContext) => hasBoundaryScopedRisk(ctx.annotation),
  },
  {
    id: 'effect',
    reads: ['annotation.sideEffects'],
    direction: 'self',
    channels: ['pull-neighbor'],
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
    channels: ['pull-self', 'pull-neighbor'],
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
    // Semantically symmetric; the enum has no `symmetric` value. `propagating` keeps it out of
    // push admission. Enum extension deferred to the Phase-2 channel work.
    direction: 'propagating',
    channels: ['pull-neighbor'],
    detect: (ctx: DeliveryMechanicContext) =>
      !!ctx.edgeCount
      && (ctx.edgeCount(ctx.nodeId, 'implements', 'in') > 0 || ctx.edgeCount(ctx.nodeId, 'implements', 'out') > 0),
  },
  {
    id: 'hub',
    reads: ['topology.inDegree'],
    direction: 'self',
    channels: ['pull-neighbor'],
    detect: (ctx: DeliveryMechanicContext) =>
      !!ctx.importerCount && ctx.importerCount(ctx.nodeId) >= (ctx.hubThreshold ?? HUB_IMPORTER_FLOOR),
  },
];

/** Tag priority derived from registry order, highest first. */
export const DELIVERY_MECHANIC_PRIORITY: readonly InvestigateTag[] = DELIVERY_MECHANICS.map((m) => m.id);

/** Look up one mechanic by id. Total over `InvestigateTag` — every tag has a registered mechanic. */
export function deliveryMechanic(id: InvestigateTag): DeliveryMechanic {
  const found = DELIVERY_MECHANICS.find((m) => m.id === id);
  if (!found) throw new Error(`Unknown mechanic: ${id}`);
  return found;
}
