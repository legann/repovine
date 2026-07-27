import { z } from 'zod';
import type { ResolvedScope } from '../../scope/resolved.js';
import { scopeNavigation } from '../scope/navigation.js';
import { inlineTruncation, truncationMap, TruncationMapSchema, type TruncationMap } from '../../response/truncation.js';
import { ProvenanceSchema } from '../../response/provenance.js';

export type Confidence = 'high' | 'medium' | 'low';
export type NavigationSection = 'deeper' | 'sideways' | 'up' | 'crossLayer' | 'validate';
export type NavigationItem = {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
};
export type Navigation = Record<NavigationSection, NavigationItem[]>;

/**
 * One open obligation hoisted to the envelope top so primacy catches it. Data, not imperative — the
 * fact plus the cheapest next call; never a stop condition. Capped at {@link ATTENTION_LIMIT}.
 */
export type AttentionItem = {
  nodeId: string;
  investigate?: string[];
  note: string;
  next: { tool: string; args: Record<string, unknown> };
};

/** Max obligations surfaced in the top-level `attention` block. */
export const ATTENTION_LIMIT = 3;

/**
 * The shape every tool answers in.
 *
 * `result` is the tool's own payload and stays open apart from the two facts every payload can
 * carry: the fields around it are the same for all eighteen tools, so a caller reads scope,
 * confidence, gaps and navigation without knowing which tool produced the response. Build it with
 * {@link envelope} or {@link envelopeError} — the type is exported so a handler's return is checked,
 * not so responses are assembled by hand.
 *
 * `truncation` at this level bounds what the envelope itself holds: `attention`, which is capped,
 * and `result`, which the transport withholds whole when it exceeds the response ceiling.
 */
export interface ToolResponse {
  scope: string;
  resolvedScope: Record<string, unknown>;
  summary: string;
  confidence: Confidence;
  attention?: AttentionItem[];
  truncation?: TruncationMap;
  result: unknown;
  gaps: string[];
  navigation: Navigation;
}

const NavigationItemSchema = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  reason: z.string(),
});

const NavigationSchema = z.object({
  deeper: z.array(NavigationItemSchema),
  sideways: z.array(NavigationItemSchema),
  up: z.array(NavigationItemSchema),
  crossLayer: z.array(NavigationItemSchema),
  validate: z.array(NavigationItemSchema),
});

/**
 * Runtime shape of {@link ToolResponse}. Strict on purpose: a field added beside `result` instead of
 * inside it is a new top-level contract for every tool, and this is what refuses it.
 */
/**
 * The payload slot.
 *
 * Open, because eighteen tools answer eighteen different questions and no field is common to all of
 * them — the type stays `unknown` for that reason. Three are described anyway: how a payload reports
 * a bound it applied, what backs a claim it makes, and how it reports failure. Those are the fields
 * that grew a new spelling per tool, so those are the ones held to one shape.
 */
export const ToolResultSchema = z.looseObject({
  truncation: TruncationMapSchema.optional(),
  provenance: ProvenanceSchema.optional(),
  error: z.string().optional(),
});

export const ToolResponseSchema = z.strictObject({
  scope: z.string(),
  resolvedScope: z.record(z.string(), z.unknown()),
  summary: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  attention: z.array(z.object({
    nodeId: z.string(),
    investigate: z.array(z.string()).optional(),
    note: z.string(),
    next: z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) }),
  })).optional(),
  truncation: TruncationMapSchema.optional(),
  result: ToolResultSchema,
  gaps: z.array(z.string()),
  navigation: NavigationSchema,
});

export function publicResolvedScope(scope: ResolvedScope | string | undefined): Record<string, unknown> {
  if (!scope) return { kind: 'all', id: 'all', raw: 'all' };
  if (typeof scope === 'string') return { kind: scope === 'all' ? 'all' : 'unknown', id: scope, raw: scope };
  return {
    kind: scope.kind,
    id: scope.resolvedScope,
    raw: scope.raw,
    ...(scope.nodeId ? { nodeId: scope.nodeId } : {}),
    ...(scope.domainId ? { domainId: scope.domainId } : {}),
    ...(scope.packageId ? { packageId: scope.packageId } : {}),
    ...(scope.query ? { query: scope.query } : {}),
  };
}

export function emptyNavigation(): Navigation {
  return { deeper: [], sideways: [], up: [], crossLayer: [], validate: [] };
}

export function nav(tool: string, args: Record<string, unknown>, reason: string): NavigationItem {
  return { tool, args, reason };
}

export function dedupeNavItems(items: NavigationItem[]): NavigationItem[] {
  if (items.length < 2) return items;
  const seen = new Set<string>();
  const out: NavigationItem[] = [];
  for (const item of items) {
    const key = `${item.tool}|${JSON.stringify(item.args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function dedupeNavigation(nav: Navigation): Navigation {
  const NAV_SECTION_LIMIT = 4;
  return {
    deeper: dedupeNavItems(nav.deeper).slice(0, NAV_SECTION_LIMIT),
    sideways: dedupeNavItems(nav.sideways).slice(0, NAV_SECTION_LIMIT),
    up: dedupeNavItems(nav.up).slice(0, NAV_SECTION_LIMIT),
    crossLayer: dedupeNavItems(nav.crossLayer).slice(0, NAV_SECTION_LIMIT),
    validate: dedupeNavItems(nav.validate).slice(0, NAV_SECTION_LIMIT),
  };
}

export function envelope(
  scope: ResolvedScope | string | undefined,
  summary: string,
  result: unknown,
  options: {
    /**
     * Whether the request resolved to something, not how much the answer is to be trusted.
     * `high` means the scope resolved and the tool produced a result; `low` means it did not.
     *
     * Completeness, recall ceilings and unread evidence are separate facts and belong in `gaps`,
     * where a reader can act on them. Grading trust here would need a per-tool signal no tool has.
     */
    confidence?: Confidence;
    gaps?: string[];
    navigation?: Partial<Navigation>;
    attention?: AttentionItem[];
  } = {},
): ToolResponse {
  const rawScope = typeof scope === 'string' ? scope : scope?.raw ?? 'all';
  const baseNav = emptyNavigation();
  for (const [section, items] of Object.entries(options.navigation ?? {}) as Array<[NavigationSection, NavigationItem[] | undefined]>) {
    if (items?.length) baseNav[section] = items;
  }
  const allAttention = options.attention ?? [];
  const attention = allAttention.slice(0, ATTENTION_LIMIT);
  // The block is a reading order, not a filter: every obligation in it was read off lists that ship
  // inside `result`, so what did not fit at the top is still down the page as an `investigate` tag.
  const truncation = truncationMap({
    attention: allAttention.length > attention.length
      ? inlineTruncation({
        shown: attention.length,
        total: allAttention.length,
        hint: 'Obligations past the first few stay as investigate tags on result.drillDown, result.links and result.investigatePointers in this same response.',
      })
      : undefined,
  });
  return {
    scope: rawScope,
    resolvedScope: publicResolvedScope(scope),
    summary,
    confidence: options.confidence ?? 'medium',
    ...(attention.length ? { attention } : {}),
    ...(truncation ? { truncation } : {}),
    result,
    gaps: options.gaps ?? [],
    navigation: dedupeNavigation(baseNav),
  };
}

export function resultError(message: string, details?: Record<string, unknown>): Record<string, unknown> {
  return details ? { error: message, ...details } : { error: message };
}

export function envelopeError(scope: ResolvedScope | string | undefined, message: string, details?: Record<string, unknown>): ToolResponse {
  return envelope(scope, message, resultError(message, details), {
    confidence: 'low',
    gaps: [message],
    navigation: typeof scope === 'object' && scope ? scopeNavigation(scope) : emptyNavigation(),
  });
}
