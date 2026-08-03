import { z } from 'zod';

/**
 * One call an answer offers to make next.
 *
 * Every surface that steers an agent to its next call says the same three things: which tool, with
 * which arguments, and why now. They had grown five spellings of that triple — `{tool, args, reason}`
 * on the envelope, `{tool, args}` under `attention`, `{when?, tool?, args?, note?}` inside an empty
 * diagnostic, a rendered call string in a finding's detail, and free prose in annotation health — so
 * a caller parsed a different shape per field and a new carrier invented a sixth.
 *
 * One form, several deliveries: this type says what a next call looks like, not where it ships. The
 * envelope's `navigation`, an obligation's `next`, a diagnostic's `nextActions` and a finding's
 * `nextCalls` each keep their own slot and their own trigger.
 *
 * `tool` absent means the same tool the caller just used, with different arguments — the shape a page
 * or a widened bound takes. `args` absent means the call needs none. `reason` is never absent: a call
 * offered without a reason to make it is noise the caller has to rank on its own.
 */
export interface NextCall {
  /** Tool to call. Absent when it is the same tool the caller just used, with different arguments. */
  tool?: string;
  /** Arguments for the call. Absent when it takes none. */
  args?: Record<string, unknown>;
  /** Why this call is worth making now, or the condition under which it is the right one. */
  reason: string;
}

export const NextCallSchema = z.object({
  tool: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  reason: z.string(),
});

/** One next call. The argument order matches how it reads: call this, with this, because of that. */
export function nextCall(
  tool: string | undefined,
  args: Record<string, unknown> | undefined,
  reason: string,
): NextCall {
  return {
    ...(tool !== undefined ? { tool } : {}),
    ...(args !== undefined ? { args } : {}),
    reason,
  };
}

/**
 * The call as an agent would type it, for surfaces that carry text rather than structure — CLI
 * output and the `gaps` line an annotation-health check contributes. Arguments are rendered as the
 * JSON object the MCP client sends.
 */
export function renderNextCall(call: NextCall): string {
  if (!call.tool) return call.reason;
  const args = call.args ? JSON.stringify(call.args) : '{}';
  return `${call.tool}(${args}) — ${call.reason}`;
}

/** Drop repeats of the same tool+args pair, keeping the first reason given for it. */
export function dedupeNextCalls(calls: NextCall[]): NextCall[] {
  if (calls.length < 2) return calls;
  const seen = new Set<string>();
  const out: NextCall[] = [];
  for (const call of calls) {
    const key = `${call.tool ?? ''}|${JSON.stringify(call.args ?? {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(call);
  }
  return out;
}
