import type { InvestigateTag, NodeView, RepositoryGraph } from '../../types.js';
import { pathFromRoot } from '../../graph/index.js';
import { priorityWeight } from '../lib/investigate-refs.js';
import {
  narrowTruncation,
  pageTruncation,
  type Truncation,
  type TruncationUnit,
} from '../../response/truncation.js';

export const DEFAULT_SEARCH_LIMIT = 10;
export const DEFAULT_MAP_LIMIT = 10;
export const DEFAULT_INSPECT_CHILD_LIMIT = 20;
export const DEFAULT_LIST_LIMIT = 20;
export const DEFAULT_ARCHITECTURE_LIMIT = 12;
/** Keeps a broad architecture report below the MCP response ceiling; use category/scope narrowing beyond it. */
export const MAX_ARCHITECTURE_LIMIT = 30;
export const DEFAULT_SEMANTIC_LIMIT = 10;
export const DEFAULT_VALIDATE_LIMIT = 10;
export const DEFAULT_BODY_LIMIT = 12_000;
export const MAX_BODY_LIMIT = 50_000;
export const MAX_INSPECT_CHILD_LIMIT = 100;

/**
 * Bound a built list at its source: slice to a page and report the bound so the caller pages the
 * rest. `noun`/`narrow` make the hint say how to get more, never imply the page is the whole set.
 *
 * An offset past the end pages to nothing, so the answer is to restart rather than to advance — a
 * `nextOffset` there would point back at the offset that already returned nothing.
 */
export function paginateList<T>(
  items: T[],
  options: { limit: number; offset?: number; noun?: string; narrow?: string; arg?: string; unit?: TruncationUnit },
): { page: T[]; truncation?: Truncation } {
  const offset = Math.max(0, options.offset ?? 0);
  const total = items.length;
  const page = items.slice(offset, offset + options.limit);
  const nextOffset = offset + page.length;
  const noun = options.noun ?? 'item';
  const narrow = options.narrow ?? 'narrow the scope or reduce depth to shrink the set';
  const arg = options.arg ?? 'offset';
  return {
    page,
    truncation: pageTruncation({
      shown: page.length,
      total,
      offset,
      arg,
      noun,
      unit: options.unit,
      hint: `${total} ${noun}(s). Showing ${offset + 1}-${nextOffset}. Pass ${arg} ${nextOffset} with the same limit for the next page; ${narrow}.`,
    }),
  };
}

export type PaginatedNodeView = NodeView & {
  topChildren?: NodeView['drillDown'];
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
function salienceOrderedChildren(children: NodeView['drillDown']): NodeView['drillDown'] {
  if (!children.some((child) => child.investigate?.length)) return children;
  return children
    .map((child, index) => ({ child, index, weight: childSalienceWeight(child.investigate) }))
    .sort((a, b) => (b.weight - a.weight) || (a.index - b.index))
    .map((entry) => entry.child);
}

export function paginateNodeViewChildren(
  view: NodeView,
  options: { limit: number; offset?: number; summaryOnly?: boolean; arg?: string; pageable?: boolean },
): PaginatedNodeView {
  const offset = Math.max(0, options.offset ?? 0);
  const ordered = salienceOrderedChildren(view.drillDown);
  const total = ordered.length;
  const page = ordered.slice(offset, offset + options.limit);
  const arg = options.arg ?? 'offset';
  // Ancestors on a `map_context` path carry a fixed five-child preview with no offset of their own;
  // the whole child set is what `map_context`/`inspect_node` on that ancestor returns.
  const children = options.pageable === false
    ? (total > page.length
      ? narrowTruncation({
        shown: page.length,
        total,
        hint: `Ancestor previews are capped at ${page.length} child node(s); call map_context or inspect_node on this node for the full set.`,
      })
      : undefined)
    : pageTruncation({
      shown: page.length,
      total,
      offset,
      arg,
      noun: 'child node',
      hint: `${total} child node(s). Showing ${offset + 1}-${offset + page.length}. Pass ${arg} ${offset + page.length} with the same limit for the next page.`,
    });
  const truncation = children ? { ...view.truncation, children } : view.truncation;
  return {
    ...view,
    drillDown: options.summaryOnly ? [] : page,
    ...(truncation ? { truncation } : {}),
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
      pageable: false,
    })),
    focus: paginateNodeViewChildren(result.focus, options),
  };
}
