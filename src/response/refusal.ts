/**
 * How the engine says it will not do what was asked.
 *
 * Three conventions, and the boundary between them is the contract:
 *
 * - **`Refusal`** — an expected failure. The caller has to handle it and can carry on: a scope that
 *   names nothing, a file the process may not read, bytes whose shape is wrong, a rule that forbids
 *   the write. Every one of these is reachable from an argument a caller chose, so it travels as a
 *   value with a reason attached.
 * - **`throw`** — a programmer error. An invariant the engine itself broke: a registry that was
 *   never populated, a discriminant with no arm, an internal helper handed the wrong type. Crashing
 *   is the correct answer, and no caller is expected to recover.
 * - **emptiness** — the request was answered and the answer is nothing. It has its own form in
 *   `mcp/response/empty-diagnostics.ts`; it is not a refusal, and a site that returns one for the
 *   other reports the wrong fact.
 *
 * The engine had grown a spelling per site instead: `{ok:false,error}`, `{status:'failed',error}`,
 * `T | {error}`, `{kind:'invalid',error}`, `{valid,errors}`, a bare `undefined`, an empty array, and
 * a sentence pushed into `gaps` with nothing in the value to mark it. Each hop between two of them
 * re-encoded the fact, and each re-encode dropped whatever the next shape had no slot for.
 *
 * One form, several deliveries. This type says what a refusal is, not where it ships: the MCP
 * envelope publishes it as `result.error`, the CLI prints it and picks an exit code, the build
 * records it on the snapshot so a silenced pipeline log is not its only channel.
 */
/**
 * Why the engine refused. Closed so a consumer can be held to all of them, and so a new site picks
 * an existing reason rather than inventing a synonym.
 *
 * The list holds what the converted perimeter produces and nothing else. A reason no site produces
 * is a name nobody had to choose between, so the next site invents a synonym rather than picking
 * one; the list grows when a converting site needs a word that is not here, not before.
 *
 * `not-found` — the id, name or record the caller named does not exist.
 * `unsupported` — the operation is not defined for this kind of input; a different call answers it.
 * `unreadable` — the bytes could not be obtained: an errno, a missing file, a path off limits.
 * `rejected-by-policy` — a rule the engine enforces forbids it: a path outside the workspace, a
 *   file the scan configuration excludes, a value a write rule rejects.
 * `conflict` — state outside this call disagrees: two producers claiming one file, a held lock, a
 *   file another writer changed underneath.
 * `not-ready` — what the call needs has not been built yet; it can succeed later unchanged.
 * `incomplete` — the work started and could not finish, so the result would be partial.
 */
export const REFUSAL_REASONS = [
  'not-found',
  'unsupported',
  'unreadable',
  'rejected-by-policy',
  'conflict',
  'not-ready',
  'incomplete',
] as const;

export type RefusalReason = typeof REFUSAL_REASONS[number];

/** One expected failure. `message` is what a reader is shown; `reason` is what a caller branches on. */
export interface Refusal {
  reason: RefusalReason;
  /**
   * Which refusal this is, among the ones its producer makes. `reason` says what kind of failure it
   * was; `kind` says which site made it, so a reader picks one out of a list by name instead of by
   * whichever field it happens to carry.
   */
  kind: string;
  /** One sentence naming what was refused and what would make it work. Reaches the user verbatim. */
  message: string;
  /** The values that decided it — the argument, the path, the id — so the message needs no parsing. */
  details?: Record<string, unknown>;
}

/** A value that was produced, or the refusal that stands in its place. */
export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: Refusal };

/** The value arrived. */
export function delivered<T>(value: T): Outcome<T> {
  return { ok: true, value };
}

/** A refusal on its own, for a slot that carries one without an accompanying value. */
export function refusal(
  reason: RefusalReason,
  kind: string,
  message: string,
  details?: Record<string, unknown>,
): Refusal {
  return {
    reason,
    kind,
    message,
    ...(details !== undefined ? { details } : {}),
  };
}

/** The value did not arrive, and this is why. Assignable wherever an `Outcome<T>` is expected. */
export function refused(
  reason: RefusalReason,
  kind: string,
  message: string,
  details?: Record<string, unknown>,
): { ok: false; refusal: Refusal } {
  return { ok: false, refusal: refusal(reason, kind, message, details) };
}

/** True when the outcome carries a refusal instead of a value. Narrows both arms. */
export function isRefused<T>(outcome: Outcome<T>): outcome is { ok: false; refusal: Refusal } {
  return outcome.ok === false;
}

/**
 * The value, at a call site where a refusal would be a programmer error — one whose arguments the
 * caller has already established are answerable, so there is no branch left to write. The throw is
 * the convention for exactly that case, and naming it here keeps the boundary between the two
 * conventions in the code instead of in each caller's head.
 */
export function deliveredValue<T>(outcome: Outcome<T>): T {
  if (outcome.ok === false) {
    throw new Error(
      `expected a delivered value, got a refusal: ${outcome.refusal.reason} — ${outcome.refusal.message}`,
    );
  }
  return outcome.value;
}

/**
 * The refusal message off an already-published tool result, or undefined when it carries none.
 *
 * A refusal leaves the engine as a value and reaches a client as `result.error` inside the envelope.
 * Anything reading a serialized response — the transport's error flag, the session score — reads it
 * through here, so the published spelling is declared once and a change to it is a compile error at
 * every reader rather than a predicate that silently stops matching.
 */
export function publishedRefusalMessage(toolResult: unknown): string | undefined {
  if (typeof toolResult !== 'object' || toolResult === null) return undefined;
  const inner = (toolResult as { result?: unknown }).result;
  if (typeof inner !== 'object' || inner === null) return undefined;
  const message = (inner as { error?: unknown }).error;
  return typeof message === 'string' ? message : undefined;
}
