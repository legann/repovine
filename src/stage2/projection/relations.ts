import { SEMANTIC_LINK_RELATIONS } from '@repovine/plugin-sdk';
import type { SemanticLinkRelation } from '@repovine/plugin-sdk';
import type { EdgeKind } from '../../types.js';

/**
 * Public relation name → internal edge kind.
 *
 * The contract publishes kebab-case relation names and the graph model spells its edge kinds with
 * underscores. The two vocabularies are separate on purpose: the model is free to change spelling
 * without moving a published name. This map is the one place they meet, and it is total over
 * `SEMANTIC_LINK_RELATIONS` — a relation added to the contract without an edge kind is a compile
 * error here rather than a link the composer silently drops.
 */
export const RELATION_EDGE_KINDS: Readonly<Record<SemanticLinkRelation, EdgeKind>> = Object.freeze({
  'publishes': 'publishes',
  'consumes': 'consumes',
  'binds-to': 'binds_to',
  'uses-env': 'uses_env',
  'routes-to': 'routes_to',
  'builds-from': 'infra',
});

/** Every published relation has an edge kind. Read by the totality law and by the composer. */
export function relationEdgeKind(relation: SemanticLinkRelation): EdgeKind {
  return RELATION_EDGE_KINDS[relation];
}

/** The published relations, in contract order. */
export const PUBLISHED_RELATIONS: readonly SemanticLinkRelation[] = SEMANTIC_LINK_RELATIONS;
