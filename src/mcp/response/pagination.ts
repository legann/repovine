import type { InvestigateTag, NodeView, RepositoryGraph } from '../../types.js';
import { pathFromRoot } from '../../graph/index.js';
import { priorityWeight } from '../lib/investigate-refs.js';

export const DEFAULT_SEARCH_LIMIT = 10;
export const DEFAULT_MAP_LIMIT = 10;
export const DEFAULT_INSPECT_CHILD_LIMIT = 20;
export const DEFAULT_LIST_LIMIT = 20;
export const DEFAULT_ARCHITECTURE_LIMIT = 12;
export const DEFAULT_SEMANTIC_LIMIT = 10;
export const DEFAULT_VALIDATE_LIMIT = 10;
export const DEFAULT_BODY_LIMIT = 12_000;
export const MAX_BODY_LIMIT = 50_000;
export const MAX_INSPECT_CHILD_LIMIT = 100;

export type ChildPagination = {
  total: number;
  returned: number;
  offset: number;
  truncated: boolean;
  nextOffset?: number;
  hint?: string;
};

export type ListPagination = {
  total: number;
  returned: number;
  offset: number;
  truncated: boolean;
  nextOffset?: number;
  hint?: string;
};

/**
 * Bound a built list at its source: slice to a page and report total/nextOffset so the caller
 * pages the rest. `noun`/`narrow` make the truncation hint say how to get more, never imply the
 * page is the whole set.
 */
export function paginateList<T>(
  items: T[],
  options: { limit: number; offset?: number; noun?: string; narrow?: string },
): { page: T[]; pagination: ListPagination } {
  const offset = Math.max(0, options.offset ?? 0);
  const total = items.length;
  const page = items.slice(offset, offset + options.limit);
  const nextOffset = offset + page.length;
  const truncated = nextOffset < total;
  const noun = options.noun ?? 'item';
  const narrow = options.narrow ?? 'narrow the scope or reduce depth to shrink the set';
  return {
    page,
    pagination: {
      total,
      returned: page.length,
      offset,
      truncated,
      ...(truncated ? { nextOffset } : {}),
      ...(truncated
        ? { hint: `${total} ${noun}(s). Showing ${offset + 1}-${nextOffset}. Pass offset ${nextOffset} with the same limit for the next page; ${narrow}.` }
        : {}),
    },
  };
}

export type PaginatedNodeView = NodeView & {
  childPagination: ChildPagination;
  topChildren?: NodeView['drill_down'];
};

export function limitFrom(args: Record<string, unknown>, fallback: number, max = 200): number {
  const raw = args.limit;
  return Math.min(max, Math.max(1, typeof raw === 'number' ? raw : fallback));
}

export function offsetFrom(args: Record<string, unknown>): number {
  const raw = args.offset;
  return Math.max(0, typeof raw === 'number' ? raw : 0);
}

export function namedLimitFrom(args: Record<string, unknown>, name: string, fallback: number, max = 200): number {
  const raw = args[name];
  return Math.min(max, Math.max(1, typeof raw === 'number' ? raw : fallback));
}

export function namedOffsetFrom(args: Record<string, unknown>, name: string): number {
  const raw = args[name];
  return Math.max(0, typeof raw === 'number' ? raw : 0);
}

/** Strongest tag weight on a child, 0 when untagged. */
function childSalienceWeight(investigate: InvestigateTag[] | undefined): number {
  if (!investigate?.length) return 0;
  let max = 0;
  for (const tag of investigate) {
    const weight = priorityWeight(tag);
    if (weight > max) max = weight;
  }
  return max;
}

/**
 * Float investigate-tagged children to the front by descending tag priority so a boundary/risk
 * affordance is never paginated off page 1; untagged children keep declaration order. Stable
 * partition keyed (priorityWeight desc, originalIndex asc) — deterministic, so `exportOffset` paging
 * stays well-defined. No-op when no child carries a tag, so paginators that never tag
 * (`map_context`/`trace_flow`) preserve source order.
 */
function salienceOrderedChildren(children: NodeView['drill_down']): NodeView['drill_down'] {
  if (!children.some((child) => child.investigate?.length)) return children;
  return children
    .map((child, index) => ({ child, index, weight: childSalienceWeight(child.investigate) }))
    .sort((a, b) => (b.weight - a.weight) || (a.index - b.index))
    .map((entry) => entry.child);
}

export function paginateNodeViewChildren(
  view: NodeView,
  options: { limit: number; offset?: number; summaryOnly?: boolean },
): PaginatedNodeView {
  const offset = Math.max(0, options.offset ?? 0);
  const ordered = salienceOrderedChildren(view.drill_down);
  const total = ordered.length;
  const page = ordered.slice(offset, offset + options.limit);
  const nextOffset = offset + page.length;
  const truncated = nextOffset < total;
  const pagination: ChildPagination = {
    total,
    returned: page.length,
    offset,
    truncated,
    ...(truncated ? { nextOffset } : {}),
    ...(truncated
      ? { hint: `${total} child node(s). Showing ${offset + 1}-${nextOffset}. Pass offset/exportOffset ${nextOffset} with the same limit for the next page.` }
      : {}),
  };
  return {
    ...view,
    drill_down: options.summaryOnly ? [] : page,
    childPagination: pagination,
    ...(options.summaryOnly && page.length > 0 ? { topChildren: page } : {}),
  };
}

export function pathFromRootPaginated(
  graph: RepositoryGraph,
  focusId: string,
  options: { limit: number; offset: number; summaryOnly: boolean },
): { path: PaginatedNodeView[]; focus: PaginatedNodeView } | null {
  const result = pathFromRoot(graph, focusId);
  if (!result) return null;
  const ancestorLimit = Math.min(5, options.limit);
  return {
    path: result.path.map(view => paginateNodeViewChildren(view, {
      limit: ancestorLimit,
      offset: 0,
      summaryOnly: true,
    })),
    focus: paginateNodeViewChildren(result.focus, options),
  };
}
