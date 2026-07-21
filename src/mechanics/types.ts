/**
 * Contract for the mechanics registry — the dispatch SSOT for the mechanics that surface
 * edit-relevant signals (risk, impact, side-effect, gap) to an agent.
 *
 * A mechanic is one detect ⊕ deliver unit. Its trigger is `reads` + `detect`; its delivery is
 * `channels` + `direction`. v1 dispatches detection only (`tagsForTarget`, `selfBoundaryAttention`);
 * delivery machinery stays bespoke in `applyInvestigateTags` / `buildBoundaryIndex`.
 *
 * The registry composes the rule predicates (`format.ts`, `side-effect-vocab.ts`); it does not own
 * them and is not their sole caller.
 */

import type { AnnotationContent, EdgeKind, InvestigateTag } from '../types.js';

/**
 * Graph primitive a mechanic reads. Declares applicability: a mechanic is language-scoped by
 * reading a primitive only some plugins emit, never by a language conditional. When the primitive
 * is absent, `detect` returns false — the mechanic self-gates.
 */
export type Primitive =
  | 'annotation.scope:consumer'
  | 'annotation.scope:boundary'
  | 'annotation.sideEffects'
  | 'annotation:absent'
  | 'topology.inDegree'
  | 'topology.runtimeEdges'
  | 'topology.implementsEdges';

/**
 * Delivery surface a mechanic's signal reaches. Documentation in v1 — channels are not yet
 * dispatched from the registry; each surface still calls into detection itself.
 */
export type Channel = 'pull-self' | 'pull-neighbor' | 'pull-carrier' | 'push' | 'advisory';

/** Inputs available to {@link DeliveryMechanic.detect}. Only `nodeId` is guaranteed. */
export interface DeliveryMechanicContext {
  nodeId: string;
  annotation?: AnnotationContent;
  /** Topology input for `hub`: 1-hop `imports` in-edge count for a node. */
  importerCount?: (id: string) => number;
  /** Adaptive `hub` threshold; `hub.detect` falls back to `HUB_IMPORTER_FLOOR` when absent. */
  hubThreshold?: number;
  /** Topology input for edge-scoped mechanics (`wiring`, `co-change`): 1-hop kind+direction edge count. */
  edgeCount?: (id: string, kind: EdgeKind, dir: 'in' | 'out') => number;
}

export interface DeliveryMechanic {
  /** Emitted signal id — rendered per channel as tag / attention / index entry / advisory. */
  id: InvestigateTag;
  /** Declared primitives the trigger reads. Documentation + future applicability engine. */
  reads: readonly Primitive[];
  /** `self`: the signal describes the node itself; `propagating`: it obligates consumers. */
  direction: 'self' | 'propagating';
  /** Delivery surfaces the signal reaches today. */
  channels: readonly Channel[];
  /** Total detection predicate; false when the mechanic's primitive is absent from ctx. */
  detect(ctx: DeliveryMechanicContext): boolean;
}
