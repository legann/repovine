import type { ResolvedScope } from '../scope/resolve.js';
import { scopeNavigation } from '../scope/navigation.js';

export type Confidence = 'high' | 'medium' | 'low';
export type NavigationSection = 'deeper' | 'sideways' | 'up' | 'cross_layer' | 'validate';
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
  return { deeper: [], sideways: [], up: [], cross_layer: [], validate: [] };
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
    cross_layer: dedupeNavItems(nav.cross_layer).slice(0, NAV_SECTION_LIMIT),
    validate: dedupeNavItems(nav.validate).slice(0, NAV_SECTION_LIMIT),
  };
}

export function envelope(
  scope: ResolvedScope | string | undefined,
  summary: string,
  result: unknown,
  options: {
    confidence?: Confidence;
    gaps?: string[];
    navigation?: Partial<Navigation>;
    attention?: AttentionItem[];
  } = {},
): Record<string, unknown> {
  const rawScope = typeof scope === 'string' ? scope : scope?.raw ?? 'all';
  const baseNav = emptyNavigation();
  for (const [section, items] of Object.entries(options.navigation ?? {}) as Array<[NavigationSection, NavigationItem[] | undefined]>) {
    if (items?.length) baseNav[section] = items;
  }
  const attention = options.attention?.slice(0, ATTENTION_LIMIT);
  return {
    scope: rawScope,
    resolvedScope: publicResolvedScope(scope),
    summary,
    confidence: options.confidence ?? 'medium',
    ...(attention?.length ? { attention } : {}),
    result,
    gaps: options.gaps ?? [],
    navigation: dedupeNavigation(baseNav),
  };
}

export function resultError(message: string, details?: Record<string, unknown>): Record<string, unknown> {
  return details ? { error: message, ...details } : { error: message };
}

export function envelopeError(scope: ResolvedScope | string | undefined, message: string, details?: Record<string, unknown>): Record<string, unknown> {
  return envelope(scope, message, resultError(message, details), {
    confidence: 'low',
    gaps: [message],
    navigation: typeof scope === 'object' && scope ? scopeNavigation(scope) : emptyNavigation(),
  });
}
