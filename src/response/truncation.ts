/**
 * The one shape a bounded answer is reported in.
 *
 * Layer-neutral by construction: the node-view projection under `src/graph` and the MCP response
 * layer both bound their output, so this module imports from neither. Nothing here reaches for a
 * graph, a runtime, or a tool.
 */
import { z } from 'zod';

/**
 * The scale `shown` and `total` are counted on.
 *
 * A page of ten list entries and ten thousand withheld characters are both part of an answer, on
 * scales that do not compare. Naming the scale is what lets one pair of counters carry both.
 */
export type TruncationUnit = 'item' | 'char' | 'line' | 'match' | 'name';

/**
 * How the rest is reached.
 *
 * This is the fact a caller acts on, and the one the previous shapes said with the same word for
 * opposite situations: a body slice pages, and a call-name list does not, because the dropped names
 * were never kept. `page` is machine-actionable, and so is `arg` where the tool declares the named
 * argument. `narrow` needs a different request, `inline` says the rest is elsewhere in this same
 * response, and `unavailable` says no call returns it at any price.
 *
 * `page` names its offset argument because three of them exist — `offset`, `exportOffset`,
 * `bodyOffset` — and a caller that guesses pages the wrong list.
 */
export type TruncationMore =
  | { kind: 'page'; arg: string; nextOffset: number; hint?: string }
  | { kind: 'arg'; arg: string; value: string | number | boolean; hint?: string }
  | { kind: 'narrow'; hint: string }
  | { kind: 'inline'; hint: string }
  | { kind: 'unavailable'; hint: string };

/**
 * One bounded answer: how much came back, how much exists, on what scale, and how to reach the rest.
 *
 * Emitted only when something was dropped, so its presence is the signal and `more` always says what
 * to do next. `total` is absent when the full count is not computable where the bound was applied —
 * a cap that ran during extraction leaves nothing behind to count. Absent means unknown, never zero.
 */
export interface Truncation {
  shown: number;
  total?: number;
  unit: TruncationUnit;
  more: TruncationMore;
}

/**
 * Every bound that bit in one object, keyed by what it bounded.
 *
 * One response object can bound several things at once — `trace_flow` bounds services, resources and
 * data flows in one answer — so the block is a map and the field name stays `truncation` everywhere.
 * Keys name the bounded field beside it; where the bounded thing is not a field, they name it
 * directly, as a search token names its own posting list.
 */
export type TruncationMap = Record<string, Truncation>;

const MoreSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('page'),
    arg: z.string(),
    nextOffset: z.number().int().nonnegative(),
    hint: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('arg'),
    arg: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()]),
    hint: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal('narrow'), hint: z.string() }),
  z.strictObject({ kind: z.literal('inline'), hint: z.string() }),
  z.strictObject({ kind: z.literal('unavailable'), hint: z.string() }),
]);

export const TruncationSchema = z.strictObject({
  shown: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().optional(),
  unit: z.enum(['item', 'char', 'line', 'match', 'name']),
  more: MoreSchema,
});

export const TruncationMapSchema = z.record(z.string(), TruncationSchema);

/**
 * Bound a page of a list whose full size is known. The whole paging rule lives here.
 *
 * Returns nothing when the page reaches the end: a `truncation` block on a complete answer reports a
 * bound that never bit. The end is decided by where the page ends, not by `shown` — a last page
 * requested at an offset is smaller than the whole list and still holds everything that is left.
 *
 * A page that came back empty while the list is not is answered by a restart, never by an advance:
 * `nextOffset` there would hand back the offset that just returned nothing.
 */
export function pageTruncation(options: {
  shown: number;
  total: number;
  offset: number;
  arg?: string;
  unit?: TruncationUnit;
  hint?: string;
  noun?: string;
}): Truncation | undefined {
  const arg = options.arg ?? 'offset';
  const noun = options.noun ?? 'item';
  const restart = (hint: string): Truncation => argTruncation({
    shown: 0,
    total: options.total,
    unit: options.unit,
    arg,
    value: 0,
    hint,
  });
  if (options.total > 0 && options.offset >= options.total) {
    return restart(`Offset ${options.offset} is past the end of ${options.total} ${noun}(s); restart at 0.`);
  }
  const nextOffset = options.offset + options.shown;
  if (nextOffset >= options.total) return undefined;
  if (options.shown === 0) {
    return restart(`No ${noun}(s) came back at offset ${options.offset} of ${options.total}; restart at 0.`);
  }
  return {
    shown: options.shown,
    total: options.total,
    unit: options.unit ?? 'item',
    more: {
      kind: 'page',
      arg,
      nextOffset,
      ...(options.hint ? { hint: options.hint } : {}),
    },
  };
}

/**
 * Bound whose remainder a different value of the named argument returns.
 *
 * The caller can act on it where the tool's schema declares that argument. A tool schema drops what
 * it does not declare, so an internal argument named here reaches no handler and the same bound comes
 * back; where a tool bounds on an argument it does not expose, {@link narrowTruncation} says so.
 */
export function argTruncation(options: {
  shown: number;
  total?: number;
  unit?: TruncationUnit;
  arg: string;
  value: string | number | boolean;
  hint?: string;
}): Truncation {
  return {
    shown: options.shown,
    ...(options.total === undefined ? {} : { total: options.total }),
    unit: options.unit ?? 'item',
    more: {
      kind: 'arg',
      arg: options.arg,
      value: options.value,
      ...(options.hint ? { hint: options.hint } : {}),
    },
  };
}

/** Bound whose remainder needs a narrower request, or a tool that traverses without the cap. */
export function narrowTruncation(options: {
  shown: number;
  total?: number;
  unit?: TruncationUnit;
  hint: string;
}): Truncation {
  return {
    shown: options.shown,
    ...(options.total === undefined ? {} : { total: options.total }),
    unit: options.unit ?? 'item',
    more: { kind: 'narrow', hint: options.hint },
  };
}

/**
 * Bound whose remainder is already in this response, under a different field.
 *
 * The hoisted block is a reading order, not a filter: what did not fit at the top is still down the
 * page. The hint names where.
 */
export function inlineTruncation(options: {
  shown: number;
  total?: number;
  unit?: TruncationUnit;
  hint: string;
}): Truncation {
  return {
    shown: options.shown,
    ...(options.total === undefined ? {} : { total: options.total }),
    unit: options.unit ?? 'item',
    more: { kind: 'inline', hint: options.hint },
  };
}

/**
 * Bound whose remainder no call returns.
 *
 * The dropped part was never kept — a cap that ran during extraction discards the values and keeps
 * only their count. The hint says what would have to change to recover them.
 */
export function unavailableTruncation(options: {
  shown: number;
  total?: number;
  unit?: TruncationUnit;
  hint: string;
}): Truncation {
  return {
    shown: options.shown,
    ...(options.total === undefined ? {} : { total: options.total }),
    unit: options.unit ?? 'item',
    more: { kind: 'unavailable', hint: options.hint },
  };
}

/** Collect the bounds that bit into one block, or nothing when none did. */
export function truncationMap(entries: Record<string, Truncation | undefined>): TruncationMap | undefined {
  const out: TruncationMap = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
