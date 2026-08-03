// REAL agent worker — built on the Claude Agent SDK.
//
// Provider worker for the LangGraph harness. It launches repovine as an MCP
// server scoped to repoRoot, lets Claude gather context + edit files, then asks
// it to emit a protocol AgentRunResult. The graph still runs that result through
// `delivery compliance`, so the model is never trusted blindly.
//
// Requires:  npm install   (inside this demo dir; adds @anthropic-ai/claude-agent-sdk)
// Auth — pick ONE (in .env or export):
//   ANTHROPIC_API_KEY=sk-ant-...
//   CLAUDE_CODE_OAUTH_TOKEN=...   # from `claude setup-token`
// Optional env:
//   PLANNER_REASONING / IMPLEMENTER_REASONING / VERIFY_REASONING / ASK_REASONING
//   (see lib/model-role.mjs — legacy CLAUDE_AGENT_MODEL still overrides worker model)
//   CLAUDE_AGENT_MAX_TURNS  (default 40)
//   CLAUDE_AGENT_TIMEOUT_MS (default 600000 — hard abort so a run can't hang)
//   CLAUDE_AGENT_VERBOSE    ("0" to silence the per-tool trace)
import fs from 'node:fs';
import path from 'node:path';
import { resolveAuth, authBlockedReason } from './workers/auth.mjs';
import { policyForAssignment, attachmentsBrief, resolveHarnessBrief } from './workers/prompt.mjs';
import { REPOVINE_WORKER_MCP_TOOLS, buildRepovineMcpStdio } from './workers/mcp.mjs';
import { claudeSandbox, claudeTimeoutMs } from './workers/claude-config.mjs';
import { resolveClaudeRole } from './model-role.mjs';
import { claudeUsage } from './workers/usage.mjs';
import { logBullet } from './log.mjs';
const MAX_TURNS = Number(process.env.CLAUDE_AGENT_MAX_TURNS || 40);
const VERBOSE = process.env.CLAUDE_AGENT_VERBOSE !== '0';

const RUN_STATUSES = ['complete', 'partial', 'blocked', 'failed'];

// Conversation resume via the Agent SDK `resume` option: retries may send the
// compact pointer base instead of re-folding the full task (subAgent.mjs reads this).
export const supportsResume = true;

// The implementer brief is the SINGLE-SOURCE autonomous harness brief, fetched
// from `repovine delivery run-brief` (authored once in the engine). We do not
// hand-maintain a copy here. A tiny fallback keeps the demo runnable if an older
// CLI lacks the command.
function systemAppend(repoRoot, assignment, briefName) {
  // Brief resolution + stub fallback are shared with the local worker prompt (single source).
  const brief = resolveHarnessBrief(repoRoot, assignment, briefName);
  // Same phase policy the local worker prompt carries (single source).
  return `${policyForAssignment(assignment)}\n\n${brief}`;
}

export function userPrompt(task, assignment, resuming) {
  const attachments = attachmentsBrief(task);
  if (resuming) {
    // Continuing an existing conversation — but THIS message is a NEW assignment:
    // the resumed history may hold a DIFFERENT subAgent (same-role resume, annotate
    // handover), so the new subAgent's own scope/criteria/constraints/checks must be
    // restated instead of assumed from history.
    return [
      task.task,
      ...(attachments ? ['', attachments] : []),
      '',
      `(Same sandbox, continuing our conversation. THIS message is a NEW assignment — runId "${assignment.runId}".`,
      `Scope (stay within): ${JSON.stringify(assignment.scope)}`,
      `Acceptance criteria: ${JSON.stringify(assignment.acceptanceCriteria)}`,
      `Constraints: ${JSON.stringify(assignment.constraints)}`,
      ...(task?.embedsContracts ? [] : [`Contracts: ${JSON.stringify(assignment.contracts)}`]),
      `Requested checks: ${JSON.stringify(assignment.requestedChecks)}`,
      'Emit the AgentRunResult JSON block when done.)',
    ].join('\n');
  }
  return [
    `Task: ${task.task}`,
    `runId: ${assignment.runId}`,
    `Scope (stay within): ${JSON.stringify(assignment.scope)}`,
    `Acceptance criteria: ${JSON.stringify(assignment.acceptanceCriteria)}`,
    `Constraints: ${JSON.stringify(assignment.constraints)}`,
    // When task.task embeds the inter-sub-agent section it already lists the full contract
    // ledger (=== assignment.contracts); skip the duplicate JSON line — single source.
    ...(task?.embedsContracts ? [] : [`Contracts: ${JSON.stringify(assignment.contracts)}`]),
    `Requested checks: ${JSON.stringify(assignment.requestedChecks)}`,
    ...(attachments ? ['', attachments] : []),
    '',
    'Implement it now, then emit the AgentRunResult JSON block.',
  ].join('\n');
}

function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Pull the AgentRunResult object out of the model's final text. */
export function extractResultObject(text) {
  if (!text) return null;
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
  for (let i = fences.length - 1; i >= 0; i -= 1) {
    const obj = tryParse(fences[i]);
    if (obj && typeof obj === 'object') return obj;
  }
  const whole = tryParse(text.trim());
  if (whole && typeof whole === 'object') return whole;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return tryParse(text.slice(start, end + 1));
  return null;
}

const asArray = (v, fallback) => (Array.isArray(v) ? v : fallback);

// The protocol declares contracts / contractsChanged as string[]. LLMs often
// emit a contract as a structured object (e.g. { path, method, request }), which
// would (a) fail result-schema validation and (b) poison downstream sub-agent
// assignments (contracts must be strings). Coerce non-strings to a compact JSON
// string so the contract survives as readable text instead of breaking the run.
export function toContractStrings(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((c) => (typeof c === 'string' ? c : (() => { try { return JSON.stringify(c); } catch { return String(c); } })()))
    .filter((s) => typeof s === 'string' && s.length > 0);
}

// Schema-supported optional AgentRunResult artifacts. The normalizer preserves
// them RAW when the model returned one: it never invents an absent artifact and
// never coerces a malformed shape into a valid-looking object. A malformed optional
// artifact must survive to `delivery validate-result` rejection, not silently vanish
// here. contextSessionId is handled separately (harness-forced linkage).
const OPTIONAL_ARTIFACT_KEYS = ['contextQuality', 'contextPack', 'architectureAudit', 'review', 'deliveryVerification', 'internalTrace'];

/** Copy through schema-supported optional artifacts the model actually returned, unchanged. */
export function preserveOptionalArtifacts(parsed) {
  const out = {};
  if (!parsed || typeof parsed !== 'object') return out;
  for (const key of OPTIONAL_ARTIFACT_KEYS) {
    if (parsed[key] !== undefined) out[key] = parsed[key];
  }
  return out;
}

/** Wrap the model's claims in a schema-valid envelope; linkage fields are forced. */
export function normalizeResult(parsed, assignment, { briefName } = {}) {
  const c = parsed.compliance && typeof parsed.compliance === 'object' ? parsed.compliance : {};
  // Only the code-reviewer may carry a `review` object. A verify/orient subAgent (read-only, role
  // "review"/repo-explorer) sometimes emits an approve verdict; preserving it then trips
  // the review-consistency gates and fails that subAgent for a field it was never meant to produce.
  // Strip a stray review by MANIFEST — not by phase, since the real code-reviewer is also
  // phase=explore, so a phase strip would drop the legitimate review (dropping the legitimate review).
  const optional = preserveOptionalArtifacts(parsed);
  if (briefName !== 'repovine-code-reviewer') delete optional.review;
  // deliveryVerification is a read-only verifier artifact: the core hard-fails
  // DELIVERY_NOT_READONLY against a non-empty filesChanged, so an implement/annotate-phase
  // result echoing one would be mis-failed for a field its role never owns. Keep it only on a
  // read-only (explore) run — the verify/code-review path. Strip by PHASE, not manifest: the
  // verify claim-checker carries no manifest but is a legitimate emitter, so a manifest strip
  // (like `review`) would wrongly drop it.
  if (assignment.contextSession?.phase !== 'explore') delete optional.deliveryVerification;
  // A read-only review (explore phase) changes no files, touches no graph nodes, writes no
  // annotations, and runs BEFORE the post-review annotation-sync phase. Models sometimes
  // echo the files they REVIEWED into filesChanged and assert annotationsClean=true — but
  // at review time the implement sub-agents' annotations are legitimately deferred (stale), so
  // that claim contradicts observable state, fails compliance, and mis-routes the read-only
  // sub-agent into annotation-writing on the sync retry (where it can't finish, then blocks the
  // real annotation-sync phase). Force the read-only invariants so review reports honestly.
  const readOnly = assignment.contextSession?.phase === 'explore';
  const implementPhase = assignment.contextSession?.phase === 'implement';
  // Annotate-phase subAgents are source-read-only (the engine gate hard-errors a
  // non-empty filesChanged there): a model echoing the files it annotated must
  // not fail the sync subAgent. annotationsWritten/graphNodesTouched stay intact —
  // they are the annotate phase's real effects and grounding.
  const annotatePhase = assignment.contextSession?.phase === 'annotate';
  const filesChanged = readOnly || annotatePhase ? [] : asArray(parsed.filesChanged, []);
  const scope = asArray(parsed.scope, assignment.scope);
  const defaultAnnotationsClean = assignment.contextSession?.phase === 'annotate' || filesChanged.length === 0;
  return {
    protocolVersion: '1',
    runId: assignment.runId,
    // Fail safe: an unrecognized/missing status must not be rubber-stamped as
    // 'complete' (which passes the success gate) — treat the anomaly as failed.
    status: RUN_STATUSES.includes(parsed.status) ? parsed.status : 'failed',
    summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary : `Implemented: ${assignment.task}`,
    scope: scope.length ? scope : assignment.scope,
    filesChanged,
    graphNodesTouched: readOnly ? [] : asArray(parsed.graphNodesTouched, []),
    contractsChanged: toContractStrings(parsed.contractsChanged),
    testsRun: asArray(parsed.testsRun, []),
    annotationsWritten: readOnly ? [] : asArray(parsed.annotationsWritten, []),
    // Echo the assignment's context session id (when present) so repovine links
    // the run to the session it scored. Forcing it here means an iteration-2 run
    // that ignored the session is caught (session empty/not-found) rather than
    // silently dropping the field.
    ...(assignment.contextSession?.sessionId
      ? { contextSessionId: assignment.contextSession.sessionId }
      : (typeof parsed.contextSessionId === 'string' ? { contextSessionId: parsed.contextSessionId } : {})),
    compliance: {
      refreshContextRun: typeof c.refreshContextRun === 'boolean' ? c.refreshContextRun : filesChanged.length > 0,
      // Read-only review and implement phases must not assert clean — annotations are
      // deferred to post-review annotation-sync; claiming true trips global compliance.
      annotationsClean: readOnly || implementPhase
        ? false
        : (typeof c.annotationsClean === 'boolean' ? c.annotationsClean : defaultAnnotationsClean),
      dependencyImpactChecked: !!c.dependencyImpactChecked,
      configSurfaceChecked: !!c.configSurfaceChecked,
      flowChecked: !!c.flowChecked,
      architectureChecked: !!c.architectureChecked,
    },
    blockers: asArray(parsed.blockers, []),
    // Preserve schema-supported optional artifacts (review, architectureAudit, contextPack,
    // contextQuality, deliveryVerification, internalTrace) RAW so a code-reviewer's `review`, an
    // auditor's `architectureAudit`, and a verifier's `deliveryVerification` reach validation
    // intact. Malformed shapes stay present for `validate-result` to reject rather than being
    // laundered away. Placed last: it must not overwrite the harness-forced linkage/phase fields
    // above (its keys never collide). `review` is stripped above for any non-code-reviewer
    // subAgent; `deliveryVerification` for any non-read-only (non-explore) phase.
    ...optional,
  };
}

export function blockedResult(assignment, reason) {
  return {
    protocolVersion: '1',
    runId: assignment.runId,
    status: 'blocked',
    summary: reason,
    scope: assignment.scope,
    filesChanged: [],
    graphNodesTouched: [],
    contractsChanged: [],
    testsRun: [],
    annotationsWritten: [],
    compliance: {
      refreshContextRun: false,
      annotationsClean: true,
      dependencyImpactChecked: false,
      configSurfaceChecked: false,
      flowChecked: false,
      architectureChecked: false,
    },
    blockers: [reason],
  };
}

/**
 * Real implementer run.
 * `opts.resume` continues a prior Claude session (conversation memory); the new
 * session id is written to `opts.capture.sessionId` for the caller to persist.
 */
export async function runAgent(task, assignment, repoRoot, opts = {}) {
  let query;
  try {
    ({ query } = await import('@anthropic-ai/claude-agent-sdk'));
  } catch {
    return blockedResult(
      assignment,
      'Claude Agent SDK not installed. Run `npm install` in examples/delivery-protocol-harness-demo, then retry with --real.',
    );
  }
  // Real spend must be DELIBERATE — explicit env keys in .env only (lib/workers/auth.mjs).
  // CLI run or any allowlisted Telegram message can't spend silently.
  const auth = resolveAuth('claude');
  if (!auth.ok) {
    return blockedResult(assignment, authBlockedReason('claude', auth));
  }

  // Hard backstop: the agent must never hang the harness. Abort after a cap.
  // An external opts.signal (e.g. Telegram /stop) also aborts the run; `timedOut`
  // lets the blocked reason distinguish a user stop from a timeout.
  const abortController = new AbortController();
  const timeoutMs = claudeTimeoutMs();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abortController.abort(); }, timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) abortController.abort();
    else opts.signal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  const modelRole = opts.modelRole || 'implementer';
  const claudeModel = resolveClaudeRole(modelRole);
  const sandbox = claudeSandbox({ autoAllowBashIfSandboxed: true });

  const response = query({
    prompt: userPrompt(task, assignment, Boolean(opts.resume)),
    options: {
      cwd: repoRoot,
      model: claudeModel.model,
      ...(claudeModel.effort ? { effort: claudeModel.effort } : {}),
      maxTurns: MAX_TURNS,
      abortController,
      // Hang diagnosis: HARNESS_WORKER_STDERR=1 appends the Claude Code process
      // stderr (incl. ANTHROPIC_LOG=debug HTTP lines) to .harness/worker-stderr.log.
      ...(process.env.HARNESS_WORKER_STDERR === '1'
        ? {
          stderr: (data) => {
            try {
              fs.appendFileSync(path.join(repoRoot, '.harness', 'worker-stderr.log'), data);
            } catch { /* diagnostics only */ }
          },
        }
        : {}),
      ...(opts.resume ? { resume: opts.resume } : {}),
      // Keep Claude Code's strong tool-use defaults, append our implementer brief.
      // opts.agentPrompt adds the sub-agent's role specialization on top.
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: [opts.agentPrompt, systemAppend(repoRoot, assignment, opts.briefName)].filter(Boolean).join('\n\n'),
      },
      // Autonomous: edit + run tools without interactive approval (target repo is a throwaway).
      permissionMode: 'bypassPermissions',
      ...(sandbox ? { sandbox } : {}),
      // repovine graph, scoped to the target repo, exposed as mcp__repovine__*.
      // Built via the shared helper (lib/workers/mcp.mjs) so the MCP env policy lives
      // in one place; it pins REPOVINE_CONTEXT_SESSION_ID so every tool call is
      // attributed to the run's session without the model passing it.
      // inheritProcessEnv: the Claude Agent SDK REPLACES the child env with what we
      // pass, so the MCP child needs PATH/HOME/etc.; inheritProcessEnv:true forwards
      // them through the shared helper.
      mcpServers: {
        repovine: buildRepovineMcpStdio(repoRoot, assignment.contextSession?.sessionId, { inheritProcessEnv: true }),
      },
      // Built-in file/bash tools + the shared implementer repovine MCP set (read
      // tools + refresh/annotation sync, incl. the self-audit tools that let the
      // agent satisfy the harness coverage gate). Sourced from lib/workers/mcp.mjs
      // so this list never drifts from the /ask + local worker MCP wiring.
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', ...REPOVINE_WORKER_MCP_TOOLS],
    },
  });

  let resultText = '';
  let assistantText = '';
  try {
    for await (const message of response) {
      if (message.session_id && opts.capture) opts.capture.sessionId = message.session_id;
      if (message.type === 'assistant') {
        for (const block of message.message?.content ?? []) {
          if (block.type === 'text') assistantText += block.text;
          else if (block.type === 'tool_use') logBullet(block.name, { enabled: VERBOSE, scope: 'claude' });
        }
      } else if (message.type === 'result') {
        if (typeof message.result === 'string') resultText = message.result;
        // Final result message carries cumulative token usage + cost for the turn.
        // Capture it so the harness logs measured cost (incl. cache hit ratio), not bytes.
        if (opts.capture) opts.capture.usage = claudeUsage(message);
        if (message.is_error) logBullet(`run ended: ${message.subtype}`, { enabled: VERBOSE, scope: 'claude' });
      }
    }
  } catch (e) {
    const reason = abortController.signal.aborted
      ? (timedOut
          ? `Agent run timed out after ${Math.round(timeoutMs / 1000)}s (override with CLAUDE_AGENT_TIMEOUT_MS or WORKER_TIMEOUT_MS).`
          : 'Stopped by /stop. Send a message in this chat to continue from where it left off.')
      : `Agent SDK error: ${e.message}`;
    return blockedResult(assignment, reason);
  } finally {
    clearTimeout(timer);
  }

  const parsed = extractResultObject(resultText || assistantText);
  if (!parsed) {
    return blockedResult(assignment, 'Agent finished but did not emit a parseable AgentRunResult JSON block.');
  }
  return normalizeResult(parsed, assignment, { briefName: opts.briefName });
}
