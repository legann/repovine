import type { ResolvedConfig } from '../config.js';
import { DEFAULT_MAX_RESPONSE_CHARS } from '../config.js';
import { narrowTruncation } from '../response/truncation.js';
import { hasScopePrefix } from '../graph/node-ids.js';
import { emptyNavigation } from './response/envelope.js';
import { shortenWords } from '../platform/text.js';
import { publishedRefusalMessage } from '../response/refusal.js';

export type McpResponseConfig = ResolvedConfig['mcp']['response'];
export type ResponseFormatMode = McpResponseConfig['mode'];

/** Generic guidance returned with the withheld payload; tool-agnostic so the backstop knows no tools. */
const RESPONSE_TRUNCATED_NARROW = 'reduce depth, narrow scope, or page with offset/limit';

export interface CallToolMcpResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

type JsonObject = Record<string, unknown>;
type NavigationRefMap = Record<string, string>;

const REF_MIN_LENGTH = 32;
const REF_ALWAYS_LENGTH = 96;
const MAX_REFS = 500;

/**
 * The message an errored tool result carries, or undefined when it is not an error.
 *
 * Failure has one shape: `result.error` inside the envelope, which is what `envelopeError` builds
 * and what every refusal — unknown tool, invalid arguments, unresolved scope, a handler that threw —
 * comes back as.
 *
 * Withholding a successful result for size is not a failure: it carries `truncation.result` alone.
 * A failure withheld for size carries both, and this reads the message off the pre-bounded payload.
 */
export function toolErrorMessage(result: unknown): string | undefined {
  return publishedRefusalMessage(result);
}

export function isToolErrorResult(result: unknown): boolean {
  return toolErrorMessage(result) !== undefined;
}

export class NavigationRefRegistry {
  private readonly valueToRef = new Map<string, string>();
  private readonly refToValue = new Map<string, string>();

  refFor(value: string): string {
    const existing = this.valueToRef.get(value);
    if (existing) return existing;

    const base = `$${hashString(value).slice(0, 7)}`;
    let ref = base;
    let suffix = 1;
    while (this.refToValue.has(ref) && this.refToValue.get(ref) !== value) {
      ref = `${base}${suffix}`;
      suffix++;
    }

    this.valueToRef.set(value, ref);
    this.refToValue.set(ref, value);
    this.trim();
    return ref;
  }

  resolveArgs<T>(value: T): T {
    return resolveRefs(value, this.refToValue) as T;
  }

  private trim(): void {
    while (this.refToValue.size > MAX_REFS) {
      const [ref, value] = this.refToValue.entries().next().value as [string, string];
      this.refToValue.delete(ref);
      this.valueToRef.delete(value);
    }
  }
}

export function responseConfigWithOverride(
  base: McpResponseConfig,
  responseFormat: unknown,
): McpResponseConfig {
  if (responseFormat !== 'concise' && responseFormat !== 'debug') return base;
  return {
    ...base,
    mode: responseFormat,
    pretty: responseFormat === 'debug',
  };
}

export function toCallToolMcpResult(
  result: unknown,
  response: McpResponseConfig,
  refs?: NavigationRefRegistry,
): CallToolMcpResult {
  const shaped = shapeToolResult(result, response, refs);
  const text = JSON.stringify(shaped, null, response.pretty ? 2 : undefined);
  const limitChars = response.maxChars ?? DEFAULT_MAX_RESPONSE_CHARS;
  // Whether a payload reports failure is a property of the payload, not of its size. Deciding it
  // ahead of the size branch keeps an oversized failure flagged as one, and hands the message to
  // the bounded envelope so the withheld body still says what went wrong.
  const errorMessage = toolErrorMessage(result);
  const out = text.length > limitChars
    ? boundOversizedResult(shaped, text.length, limitChars, response.pretty, errorMessage)
    : { content: [{ type: 'text' as const, text }] };
  return errorMessage === undefined ? out : { ...out, isError: true };
}

/**
 * Backstop: replace a payload that exceeds the ceiling with a small, valid envelope whose
 * `truncation.result` says how much was withheld.
 *
 * The bound is the same fact every other bound is — how much of the answer came back and how to
 * reach the rest — measured in characters rather than list entries, because the ceiling applies to
 * the serialized response and knows nothing about what the payload holds. `shown` is zero: the
 * payload is withheld whole, never cut. The remainder is reachable only by asking for less, so the
 * ceiling itself goes in the hint, where a narrower request can be aimed at it.
 *
 * Tool-agnostic and operates on the shaped object before re-serializing, so it never blind-cuts
 * JSON. Build-site pagination keeps this from firing in normal use.
 */
function boundOversizedResult(
  shaped: unknown,
  originalChars: number,
  limitChars: number,
  pretty: boolean,
  errorMessage?: string,
): CallToolMcpResult {
  const base = isObject(shaped) ? shaped : {};
  const safe: JsonObject = {
    ...(typeof base.scope === 'string' ? { scope: base.scope } : {}),
    ...(base.resolvedScope !== undefined ? { resolvedScope: base.resolvedScope } : {}),
    summary: typeof base.summary === 'string'
      ? base.summary
      : 'Result withheld: exceeded the response size ceiling.',
    confidence: 'low',
    truncation: {
      result: narrowTruncation({
        shown: 0,
        total: originalChars,
        unit: 'char',
        hint: `The payload was withheld whole to stay consumable under the ${limitChars}-char response ceiling; ${RESPONSE_TRUNCATED_NARROW}.`,
      }),
    },
    // A withheld failure keeps its message, so the body matches the isError flag on the result.
    result: errorMessage === undefined ? {} : { error: errorMessage },
    gaps: [
      `Response was ${originalChars} chars, over the ${limitChars}-char ceiling, so the payload was withheld. `
        + 'Re-run with a narrower scope, lower depth, or page with offset/limit.',
    ],
    navigation: emptyNavigation(),
  };
  return { content: [{ type: 'text', text: JSON.stringify(safe, null, pretty ? 2 : undefined) }] };
}

export function shapeToolResult(
  result: unknown,
  response: McpResponseConfig,
  refs?: NavigationRefRegistry,
): unknown {
  if (response.mode === 'debug') return result;
  if (!isObject(result)) return result;
  if (!isEnvelope(result)) return result;

  const shaped: JsonObject = { ...result };

  shaped.resolvedScope = compactResolvedScope(shaped.resolvedScope);

  const refsOut: NavigationRefMap = {};
  const navigation = compactNavigation(shaped.navigation, refs, refsOut);
  if (navigation === undefined) {
    delete shaped.navigation;
  } else {
    shaped.navigation = navigation;
  }
  if (Object.keys(refsOut).length > 0) {
    shaped.refs = refsOut;
  }

  if (Array.isArray(shaped.gaps) && shaped.gaps.length === 0) {
    delete shaped.gaps;
  }

  return shaped;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnvelope(value: JsonObject): boolean {
  return 'scope' in value
    && 'resolvedScope' in value
    && 'summary' in value
    && 'confidence' in value
    && 'result' in value;
}

function compactResolvedScope(value: unknown): unknown {
  if (!isObject(value)) return value;
  const kind = value.kind;
  const id = value.id;
  if (typeof kind !== 'string' || typeof id !== 'string') return value;
  return { kind, id };
}

function compactNavigation(
  value: unknown,
  refs: NavigationRefRegistry | undefined,
  refsOut: NavigationRefMap,
): unknown {
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  const counts = countNavigationArgStrings(value);
  for (const [section, rawItems] of Object.entries(value)) {
    if (!Array.isArray(rawItems)) {
      out[section] = rawItems;
      continue;
    }
    if (rawItems.length === 0) continue;
    out[section] = rawItems.map(item => compactNavigationItem(item, refs, refsOut, counts));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function compactNavigationItem(
  value: unknown,
  refs: NavigationRefRegistry | undefined,
  refsOut: NavigationRefMap,
  counts: Map<string, number>,
): unknown {
  if (!isObject(value)) return value;
  const reason = value.reason;
  const args = isObject(value.args) ? compactArgs(value.args, refs, refsOut, counts) : value.args;
  return {
    ...value,
    ...(args !== undefined ? { args } : {}),
    ...(typeof reason === 'string' ? { reason: compactReason(reason) } : {}),
  };
}

function compactArgs(
  value: unknown,
  refs: NavigationRefRegistry | undefined,
  refsOut: NavigationRefMap,
  counts: Map<string, number>,
): unknown {
  if (typeof value === 'string') {
    if (!refs || !shouldUseRef(value, counts)) return value;
    const ref = refs.refFor(value);
    refsOut[ref] = value;
    return ref;
  }
  if (Array.isArray(value)) {
    return value.map(item => compactArgs(item, refs, refsOut, counts));
  }
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = compactArgs(item, refs, refsOut, counts);
  }
  return out;
}

function countNavigationArgStrings(navigation: JsonObject): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rawItems of Object.values(navigation)) {
    if (!Array.isArray(rawItems)) continue;
    for (const item of rawItems) {
      if (!isObject(item) || !isObject(item.args)) continue;
      collectArgStrings(item.args, counts);
    }
  }
  return counts;
}

function collectArgStrings(value: unknown, counts: Map<string, number>): void {
  if (typeof value === 'string') {
    counts.set(value, (counts.get(value) ?? 0) + 1);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectArgStrings(item, counts);
    return;
  }
  if (!isObject(value)) return;
  for (const item of Object.values(value)) collectArgStrings(item, counts);
}

function shouldUseRef(value: string, counts: Map<string, number>): boolean {
  if (value.length < REF_MIN_LENGTH) return false;
  if (!hasScopePrefix(value)) return false;
  return (counts.get(value) ?? 0) >= 2 || value.length >= REF_ALWAYS_LENGTH;
}

function resolveRefs(value: unknown, refs: Map<string, string>): unknown {
  if (typeof value === 'string') return refs.get(value) ?? value;
  if (Array.isArray(value)) return value.map(item => resolveRefs(item, refs));
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = resolveRefs(item, refs);
  }
  return out;
}

function compactReason(reason: string): string {
  return shortenWords(reason.trim().replace(/[.]+$/, ''), 5);
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
