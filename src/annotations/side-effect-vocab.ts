/**
 * Vocabulary for the structured `sideEffects` field on AnnotationContent.
 *
 * Each side effect is `{ kind, subtype?, description? }`. `kind` is the fundamental category
 * — what NATURE of effect happens, not what target it touches. Targets and specifics go into
 * `subtype` (free string like 'http', 'db', 'fs', 'stdout', 'sdk') and `description`.
 *
 * The vocabulary is intentionally project-type-agnostic: a web app, a CLI tool, a Node library,
 * and a build tool all describe their side effects through the same 10 kinds. The `pure` kind
 * is an explicit sentinel for libraries that have NO side effects — distinguishing intentional
 * zero-effect declarations from "I just didn't write any".
 *
 * Detectors and AI-author guidance read `kind` directly. No regex over free text.
 */

import { z } from 'zod';
import type { SemanticHints } from '@repovine/plugin-sdk';

export const SIDE_EFFECT_KINDS = [
  /**
   * Reads from an external source the caller cannot control.
   * Examples:
   *   - { kind: 'io-read', subtype: 'http', description: 'GET https://api.x.com/users' }
   *   - { kind: 'io-read', subtype: 'fs', description: 'reads config.json at startup' }
   *   - { kind: 'io-read', subtype: 'db', description: 'SELECT users WHERE id = ?' }
   *   - { kind: 'io-read', subtype: 'stdin', description: 'piped JSON input' }
   */
  'io-read',

  /**
   * Writes to an external sink. Persists effects outside the function's call frame.
   * Examples:
   *   - { kind: 'io-write', subtype: 'http', description: 'POST /api/users' }
   *   - { kind: 'io-write', subtype: 'db', description: 'INSERT into users' }
   *   - { kind: 'io-write', subtype: 'fs', description: 'writes /tmp/cache.json' }
   *   - { kind: 'io-write', subtype: 'stdout', description: 'progress messages' }
   *   - { kind: 'io-write', subtype: 'stderr', description: 'error log' }
   *   - { kind: 'io-write', subtype: 'queue', description: 'publishes to sqs:OrderQueue' }
   */
  'io-write',

  /**
   * Mutates state scoped to the module or class instance (not visible to other modules).
   * Examples:
   *   - { kind: 'state-local', description: 'increments internal counter' }
   *   - { kind: 'state-local', description: 'updates LRU cache map' }
   *   - { kind: 'state-local', description: 'accumulator in closure' }
   */
  'state-local',

  /**
   * Mutates state visible across modules: globalThis, process.env, Symbol.for registry,
   * imported singletons. Anything that breaks reference transparency outside the module.
   * Examples:
   *   - { kind: 'state-global', description: 'mutates process.env.NODE_ENV during test setup' }
   *   - { kind: 'state-global', description: 'updates Zustand store' }
   *   - { kind: 'state-global', description: 'writes to globalThis.window.__APP__' }
   */
  'state-global',

  /**
   * Controls the host process lifecycle: exit, signal handlers, throw-at-top-level,
   * uncaughtException handlers, process.kill.
   * Examples:
   *   - { kind: 'process', description: 'process.exit(1) on validation failure' }
   *   - { kind: 'process', description: 'installs SIGINT handler for graceful shutdown' }
   *   - { kind: 'process', description: 'throws at module load if config invalid' }
   */
  'process',

  /**
   * Introduces concurrency: spawns workers/threads/child processes, fans out parallel async,
   * or hands control to a scheduler-controlled pool.
   * Examples:
   *   - { kind: 'concurrency', subtype: 'worker', description: 'spawns Worker for compression' }
   *   - { kind: 'concurrency', subtype: 'child_process', description: 'spawns esbuild subprocess' }
   *   - { kind: 'concurrency', description: 'fans out N parallel fetches' }
   */
  'concurrency',

  /**
   * Schedules or depends on wall-clock time: timers, intervals, debounce, scheduled jobs,
   * polling loops. Anything where behavior depends on "when" rather than "what".
   * Examples:
   *   - { kind: 'time', description: 'setInterval 30s polling' }
   *   - { kind: 'time', description: 'setTimeout retry with backoff' }
   *   - { kind: 'time', description: 'debounce 250ms' }
   */
  'time',

  /**
   * Registers listeners/observers. Effect happens later, asynchronously, when the source fires.
   * Cleanup obligations are typical here.
   * Examples:
   *   - { kind: 'subscribe', description: "addEventListener 'beforeunload' on window" }
   *   - { kind: 'subscribe', description: 'WebSocket message handler' }
   *   - { kind: 'subscribe', description: 'AbortController.abort listener' }
   *   - { kind: 'subscribe', description: "emits 'USER_LOGIN' via APP_EVENTS bus" }
   */
  'subscribe',

  /**
   * Hands control to external SDK / RPC / native binding / shell command. Distinct from
   * io-read/io-write when the call is opaque — caller cannot easily reason about what the
   * external code does.
   * Examples:
   *   - { kind: 'external', subtype: 'sdk', description: 'aws-sdk S3.putObject' }
   *   - { kind: 'external', subtype: 'sdk', description: 'Stripe charges.create' }
   *   - { kind: 'external', subtype: 'cli', description: 'execSync git clone' }
   *   - { kind: 'external', subtype: 'native', description: 'sharp image resize (binding)' }
   */
  'external',

  /**
   * Acquires or releases a resource that needs explicit lifetime management: file handles,
   * sockets, locks, allocated buffers. The annotation flags an obligation for cleanup.
   * Examples:
   *   - { kind: 'resource', subtype: 'fs', description: 'opens file handle (must close)' }
   *   - { kind: 'resource', subtype: 'socket', description: 'opens long-lived WebSocket' }
   *   - { kind: 'resource', subtype: 'lock', description: 'acquires advisory lock on table' }
   */
  'resource',

  /**
   * Explicit zero-effect declaration. The function is intentionally pure (or at most performs
   * mathematics, type conversions, returns derived values). Use this sentinel so detectors and
   * the quality scorer can distinguish "I declare this pure" from "I forgot to fill in".
   * description is optional; useful to hint why ("read-only computations over input args").
   * Examples:
   *   - { kind: 'pure' }
   *   - { kind: 'pure', description: 'derives totals from input rows' }
   */
  'pure',
] as const;

export type SideEffectKind = (typeof SIDE_EFFECT_KINDS)[number];

export interface SideEffect {
  kind: SideEffectKind;
  /** Optional sub-category like 'http' | 'db' | 'fs' | 'stdout' | 'sdk' | 'worker'. Free string. */
  subtype?: string;
  /** Optional human/AI-written context — what specifically happens. */
  description?: string;
}

export const SideEffectSchema = z.object({
  kind: z.enum(SIDE_EFFECT_KINDS),
  subtype: z.string().optional(),
  description: z.string().optional(),
}) satisfies z.ZodType<SideEffect>;

// ── Helpers ──

/** Serialize a SideEffect to short canonical text for lexical search/grep streams. */
export function serializeSideEffect(se: SideEffect): string {
  const parts: string[] = [se.kind];
  if (se.subtype) parts.push(se.subtype);
  if (se.description) parts.push(se.description);
  return parts.join(': ');
}

/** True when sideEffects explicitly declares zero effects via the 'pure' sentinel. */
export function isPure(sideEffects: readonly SideEffect[] | undefined): boolean {
  if (!sideEffects || sideEffects.length === 0) return false;
  return sideEffects.every(se => se.kind === 'pure');
}

/** True when any entry matches the given kind. */
export function hasKind(
  sideEffects: readonly SideEffect[] | undefined,
  kind: SideEffectKind,
): boolean {
  return !!sideEffects?.some(se => se.kind === kind);
}

/** True when any entry has the given subtype (case-insensitive). */
export function hasSubtype(
  sideEffects: readonly SideEffect[] | undefined,
  subtype: string,
): boolean {
  const target = subtype.toLowerCase();
  return !!sideEffects?.some(se => se.subtype?.toLowerCase() === target);
}

/** True when any entry's (kind, subtype) matches the given (kind, subtypeOptional). */
export function hasKindSubtype(
  sideEffects: readonly SideEffect[] | undefined,
  kind: SideEffectKind,
  subtype?: string,
): boolean {
  const target = subtype?.toLowerCase();
  return !!sideEffects?.some(se =>
    se.kind === kind && (target === undefined || se.subtype?.toLowerCase() === target),
  );
}

/** io-write subtypes that are diagnostic console streams, not persistence/migration sinks. */
const CONSOLE_WRITE_SUBTYPES = new Set(['stdout', 'stderr']);

/**
 * True when an effect persists past the call frame: a non-console `io-write` (any subtype other than
 * `stdout`/`stderr`, including no subtype) or a `state-global` mutation. The structured source for the
 * investigate `effect` tag — an in-place edit of such a sink reaches state other code observes.
 */
export function hasPersistentEffect(sideEffects: readonly SideEffect[] | undefined): boolean {
  return !!sideEffects?.some(se =>
    se.kind === 'state-global' ||
    (se.kind === 'io-write' && !CONSOLE_WRITE_SUBTYPES.has(se.subtype?.toLowerCase() ?? '')),
  );
}

/** Truncate description to keep MCP/refactor responses bounded. */
export function truncateSideEffect(se: SideEffect, maxDescriptionChars: number): SideEffect {
  if (!se.description || se.description.length <= maxDescriptionChars) return se;
  return { ...se, description: se.description.slice(0, maxDescriptionChars - 1) + '…' };
}

/**
 * Derive the side-effect KINDS the graph can HONESTLY detect from a module's SemanticHints.
 * Feeds the annotation consistency axis (declared-`pure` vs detected effects).
 *
 * Conservative by design: only hints that unambiguously imply a real behavioral effect are mapped.
 * Structural-only hints (route declarations, render conditions, framework name, env-var references)
 * are deliberately NOT mapped — declaring them is not itself a behavioral effect, and over-mapping
 * would false-flag legitimately pure modules. Returns `undefined` when there is no reliable signal,
 * so the pure-vs-hints consistency check simply does not fire. Never fabricate detected effects.
 */
export function detectSideEffectKindsFromHints(hints: SemanticHints | undefined): string[] | undefined {
  if (!hints) return undefined;
  const kinds = new Set<SideEffectKind>();

  // Detected runtime messaging sends (sqs/sns/eventbridge/lambda SDK calls) — never pure.
  if (hints.runtimeActions?.length) kinds.add('io-write');

  // Unambiguous effect-implying imports reported by source plugins without full content
  // analysis (e.g. Python `subprocess` / `requests`). Kinds outside the vocabulary are
  // ignored rather than fabricated.
  for (const e of hints.effectImports ?? []) {
    if (e.kind !== 'pure' && (SIDE_EFFECT_KINDS as readonly string[]).includes(e.kind)) {
      kinds.add(e.kind as SideEffectKind);
    }
  }

  const fe = hints.ui;
  if (fe) {
    // Network / storage data access: reads vs writes.
    for (const d of fe.dataAccess ?? []) {
      if (d.kind === 'mutation' || d.kind === 'storage') kinds.add('io-write');
      else kinds.add('io-read');
    }
    // Timers and subscriptions are behavioral effects by definition.
    if (fe.timers?.length) kinds.add('time');
    if (fe.subscriptions?.length) kinds.add('subscribe');
  }

  return kinds.size > 0 ? [...kinds] : undefined;
}
