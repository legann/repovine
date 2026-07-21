// LangGraph node functions — the protocol cycle as discrete, resumable steps.
//
//   intake → build_assignment → validate_assignment
//     → run_sub_agent → persist_result → validate_result → compliance → compose_reply
//
// Orchestrator nodes touch repovine ONLY through the CLI wrapper (lib/repovine.mjs,
// file-in / JSON-out). repovine MCP is used ONLY inside run_sub_agent, by the
// provider adapter — never for graph navigation. This keeps the protocol
// boundary explicit, so the engine (LangGraph here) stays
// swappable for Temporal / Inngest / BullMQ later.
import path from 'node:path';
import { buildAssignment } from '../assignment.mjs';
import * as rp from '../repovine.mjs';
import { snapshot, reconcile, harnessReapEnabled } from '../sandbox-procs.mjs';
import { ensureTarget, resolveTargetFromEnv } from '../target-repo.mjs';
import { prepareHarnessRun } from '../harness-run.mjs';
import { extractUserTask } from '../task-user.mjs';
import { getWorker, isSupportedProvider, resolveProvider } from '../workers/index.mjs';
import { agentsMode, resolveRole } from '../agents.mjs';
import { COMPACT_RETRY_BASE, foldRetryContext, complianceAccepted, groundingRejected } from './retry.mjs';
import { runRuntimeCheck, runtimeCheckPassed, formatRuntimeCheckSummary, runtimeCheckOverriddenByAttach } from '../runtime-check.mjs';
import { logLine } from '../log.mjs';
import {
  finishRunTelemetry,
  formatTelemetrySummary,
  recordRunEvent,
  runSucceeded,
  startRunTelemetry,
} from '../telemetry.mjs';
import { commitAttachRun } from './workspace-revision.mjs';
import { buildRunMcp, formatMcpMetrics, mcpMetricsFromSessionFile, resolveMcpMetrics } from '../workers/mcp-telemetry.mjs';
import { formatOrientVerifyReplyLines, subAgentCsqOnlyDelivered, repovineGoalOk, repovineProcessRunOk } from './repovine-process.mjs';
import { isOutOfScopeInfraBlocker, subAgentGateEffectivelyOk } from '../blockers.mjs';
import {
  subAgentAssignmentPath,
  subAgentMcpPath,
  subAgentResultPath,
  subAgentUsagePath,
  writeJsonFile,
} from '../harness-paths.mjs';

const VERBOSE = process.env.GRAPH_VERBOSE !== '0';

// Free-form chat/CLI tasks are not necessarily file edits (they may be questions),
// so we skip implementer-only field nagging — same choice the Telegram bot makes.
// A task can opt back in by carrying its own `manifest`.
const DEFAULT_MANIFEST = null;

function log(node, msg) {
  logLine(`graph:${node}`, msg, { enabled: VERBOSE, indent: '  ' });
}

function writeJson(file, value) {
  return writeJsonFile(file, value);
}

const manifestFor = (task) => (task?.manifest === undefined ? DEFAULT_MANIFEST : task.manifest);

// ── intake ────────────────────────────────────────────────────────────────
// Normalize input, pick + validate the provider (fail fast on unknown), ensure
// the target workspace is usable, bump the per-thread turn counter.
export async function intake(state) {
  const provider = resolveProvider(state.llmProvider);
  if (!isSupportedProvider(provider)) {
    log('intake', `unknown provider "${provider}"`);
    return { error: `Unknown LLM_PROVIDER "${provider}". Use claude | local.`, llmProvider: provider };
  }

  // Resolve the target once per invoke: invoke input wins (entrypoints resolve and
  // thread targetMode/repoRoot); the environment fills the gaps so a bare graph
  // invoke still lands on the right target. Sandbox seeding is lazy and
  // non-destructive; attach is validation-only and fails here, before any
  // provider spend, when the attached workspace is missing or invalid.
  let targetMode = state.targetMode;
  let repoRoot = state.repoRoot;
  try {
    if (!targetMode || !repoRoot) {
      const envTarget = resolveTargetFromEnv();
      targetMode = targetMode || envTarget.mode;
      repoRoot = repoRoot || envTarget.repoRoot;
    }
    ensureTarget({ mode: targetMode, repoRoot });
  } catch (e) {
    log('intake', e.message);
    return {
      error: e.message,
      llmProvider: provider,
      ...(repoRoot ? { repoRoot } : {}),
      ...(targetMode ? { targetMode } : {}),
    };
  }

  const { priorRunSummaryText } = prepareHarnessRun(repoRoot);

  const task = { ...state.task };
  if (!task.id) task.id = `graph-${Date.now()}`;
  if (!Array.isArray(task.scope)) task.scope = ['.'];
  const userTask = extractUserTask(task);
  task.userTask = userTask;
  if (priorRunSummaryText) {
    task.task = `${priorRunSummaryText}\n\n${userTask}`;
  } else {
    task.task = userTask;
  }

  // Always request a harness-graded context session. repovine itself exempts a
  // greenfield first pass (no prior annotated context to use), so the harness does
  // NOT special-case the first iteration — that decision lives in the engine.
  if (task.contextSession === undefined) {
    task.contextSession = { sessionId: `ctx-${task.id}`, mode: 'harness', required: true };
  }

  const turn = (state.turn ?? 0) + 1;
  // Multi-agent (Phase 4) when the task names roles/sub-agents (explicit always wins),
  // or AGENTS=auto|keyword. Otherwise the single-sub-agent path (v1) — unchanged default.
  const explicit = Boolean(task.roles?.length || task.subAgents?.length || task.multi);
  const mode = explicit || agentsMode() !== 'single' ? 'multi' : 'single';
  // Sandbox log wording stays byte-identical; attach names its target explicitly.
  log(
    'intake',
    `provider=${provider} mode=${mode}${targetMode === 'attach' ? ' target=attach' : ''} repoRoot=${repoRoot} turn=${turn}${priorRunSummaryText ? ' prior-run-summary=yes' : ''} task="${clip(task.task, 120)}"`,
  );
  // Attach forces runtime_check off; surface (not swallow) an explicit opt-in.
  if (runtimeCheckOverriddenByAttach()) {
    log('intake', 'runtime_check disabled in attach mode — HARNESS_RUNTIME_CHECK=1 ignored (attach builds/tests happen on the host after promotion)');
  }
  startRunTelemetry(repoRoot, { runId: task.id, provider, mode, targetMode, task });
  // Reset attempts per invoke (like workerSessions): the channel is checkpointed,
  // so a reused thread would otherwise carry a stale count and starve the retry loop.
  return { llmProvider: provider, repoRoot, targetMode, task, turn, mode, attempts: 0, workerSessions: {}, error: undefined };
}

function clip(s, max) {
  const t = String(s ?? '');
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

// ── build_assignment ──────────────────────────────────────────────────────────
export async function buildAssignmentNode(state) {
  const startedAtMs = Date.now();
  const assignment = buildAssignment(state.task);
  const file = writeJson(subAgentAssignmentPath(state.repoRoot, state.task.id, { active: true }), assignment);
  log('build_assignment', `runId=${assignment.runId} -> ${path.basename(file)}`);
  recordRunEvent(state.repoRoot, {
    event: 'phase_finished',
    runId: state.task.id,
    phase: 'build_assignment',
    ok: true,
    durationMs: Date.now() - startedAtMs,
  });
  return { assignment, assignmentFile: file };
}

// ── validate_assignment (repovine CLI — hard gate before any worker spend) ────
export async function validateAssignmentNode(state) {
  const startedAtMs = Date.now();
  const res = rp.validateAssignment(state.assignmentFile, state.repoRoot);
  const valid = Boolean(res.json?.valid);
  log('validate_assignment', `valid=${valid}`);
  recordRunEvent(state.repoRoot, {
    event: 'phase_finished',
    runId: state.task.id,
    phase: 'validate_assignment',
    ok: valid,
    durationMs: Date.now() - startedAtMs,
  });
  if (!valid) {
    const errs = res.json?.errors?.join('; ') || res.stderr?.trim() || 'schema invalid';
    return { assignmentValid: false, error: `Assignment rejected: ${errs}` };
  }
  return { assignmentValid: true };
}

// ── run_sub_agent (the seam — real LLM provider, repovine MCP inside the adapter) ──
export async function runSubAgent(state, config) {
  const provider = state.llmProvider;
  const worker = await getWorker(provider);
  // Cancellation + session capture come from the invoke config (not graph state:
  // an AbortSignal isn't serializable for the checkpointer). The channel passes
  // its own `capture` object so it can read the provider sessionId even when the
  // run is aborted before the graph commits state — that powers /stop + resume.
  const signal = config?.signal || config?.configurable?.signal;
  const capture = config?.configurable?.capture || {};

  // On a compliance-retry re-entry, fold the prior blockers into the task text so
  // the (resumed) worker knows what to fix. foldRetryContext makes a sync-only
  // rejection (annotation coverage/quality/orphans) tell the agent NOT to redo
  // code. Resume handle carries conversation memory.
  let task = state.task;
  if (state.report && state.ok === false) {
    // When a prior session exists to resume, it already holds the full task — fold the
    // blockers onto a compact base instead of restating the whole assignment.
    const resumable = Boolean(state.workerSessions?.default);
    const retryText = foldRetryContext(resumable ? COMPACT_RETRY_BASE : task.task, state.report);
    if (retryText) {
      task = { ...task, task: retryText };
      log('run_sub_agent', resumable ? 'retry with compact blocker context' : 'retry with sync-aware blocker context');
    }
  }

  const procSnap = snapshot(state.repoRoot);
  // Single-sub-agent path: give the worker the same default project-subagent prose the
  // multi path injects per sub-agent (client-toned role brief). The autonomous harness
  // mandate is layered on top inside the adapter via the harness brief.
  const { agentPrompt } = resolveRole('default', state.repoRoot);
  // Resume the single-sub-agent conversation under role 'default' (the multi path keys
  // by real role). Survives /stop: the shared `capture` is by-reference, so the
  // sessionId persists even when the graph aborts before committing state.
  const resume = state.workerSessions?.default;
  log('run_sub_agent', `provider=${provider}${resume ? ' (resume)' : ''}…`);
  const attemptNo = (state.attempts ?? 0) + 1;
  const startedAtMs = Date.now();
  recordRunEvent(state.repoRoot, {
    event: 'sub_agent_started',
    runId: state.task.id,
    subAgent: 'default',
    role: 'default',
    scope: state.task.scope,
    resumed: Boolean(resume),
  });
  const result = await worker.runAgent(task, state.assignment, state.repoRoot, {
    resume,
    capture,
    signal,
    agentPrompt,
    modelRole: 'implementer',
  });
  if (capture.sessionId) (capture.sessions ??= {}).default = capture.sessionId;
  log('run_sub_agent', `status=${result.status} files=${result.filesChanged?.length ?? 0}`);
  // Observe (and optionally reap) anything the worker left running in the sandbox.
  const recon = await reconcile(state.repoRoot, procSnap, { label: 'single', reap: harnessReapEnabled() });
  const durationMs = Date.now() - startedAtMs;
  const usage = capture.usage ?? null;
  if (usage) {
    writeJson(subAgentUsagePath(state.repoRoot, state.task.id, { active: true }), {
      run: state.task.id,
      provider,
      total: usage,
      attempts: [{ attempt: attemptNo, ok: !['blocked', 'failed'].includes(result.status), usage }],
    });
  }
  recordRunEvent(state.repoRoot, {
    event: 'sub_agent_finished',
    runId: state.task.id,
    subAgent: 'default',
    role: 'default',
    ok: !['blocked', 'failed'].includes(result.status),
    resultStatus: result.status,
    durationMs,
    attempts: attemptNo,
    filesChanged: result.filesChanged?.length ?? 0,
    blockers: result.blockers?.length ?? 0,
    usage,
  });
  return {
    result,
    leftRunning: recon.leftRunning,
    reaped: recon.reaped,
    workerSessions: capture.sessionId ? { default: capture.sessionId } : undefined,
    agentArgs: { resume, capture },
    attempts: attemptNo,
    usage,
    usageRollup: usage ? { total: usage } : undefined,
    usageRecords: [{ subAgent: 'default', role: 'default', ok: !['blocked', 'failed'].includes(result.status), durationMs, usage }],
  };
}

// ── persist_result ─────────────────────────────────────────────────────────────
export async function persistResult(state) {
  const file = writeJson(subAgentResultPath(state.repoRoot, state.task.id, { active: true }), state.result);
  log('persist_result', path.basename(file));
  return { resultFile: file };
}

// ── validate_result (repovine CLI — schema gate on the worker's claims) ─────────
export async function validateResultNode(state) {
  const startedAtMs = Date.now();
  const res = rp.validateResult(state.resultFile, {
    assignment: state.assignmentFile,
    manifest: manifestFor(state.task),
    repoRoot: state.repoRoot,
  });
  const schemaValid = Boolean(res.json?.schemaValid);
  log('validate_result', `schemaValid=${schemaValid}`);
  recordRunEvent(state.repoRoot, {
    event: 'phase_finished',
    runId: state.task.id,
    phase: 'validate_result',
    ok: schemaValid,
    durationMs: Date.now() - startedAtMs,
  });
  return { schemaValid };
}

// ── compliance (repovine CLI — claims re-checked against observable repo state) ─
export async function complianceNode(state) {
  const startedAtMs = Date.now();
  const contextSessionId = state.result?.contextSessionId ?? state.assignment?.contextSession?.sessionId;
  const mcpBeforeConsume = contextSessionId
    ? mcpMetricsFromSessionFile(state.repoRoot, contextSessionId)
    : null;

  const res = rp.compliance(state.resultFile, {
    assignment: state.assignmentFile,
    manifest: manifestFor(state.task),
    repoRoot: state.repoRoot,
  });
  const report = res.json?.report;
  // Harness policy: repovine `valid` (no hard errors) AND no annotation-grounding fact
  // (provenance / hard consistency) the strict harness rejects on. See retry.complianceAccepted.
  const ok = complianceAccepted(report);
  log('compliance', `valid=${ok}${report?.errors?.length ? ` errors=${report.errors.length}` : ''}${groundingRejected(report) ? ' grounding=rejected' : ''}`);

  const mcp = mcpBeforeConsume ?? resolveMcpMetrics({
    contextQuality: report?.contextQuality,
    repoRoot: state.repoRoot,
    contextSessionId,
  });
  if (mcp && contextSessionId && !mcp.contextSessionId) mcp.contextSessionId = contextSessionId;
  let mcpRollup;
  if (mcp) {
    writeJson(subAgentMcpPath(state.repoRoot, state.task.id, { active: true }), {
      subAgent: state.task.id,
      role: 'default',
      scope: state.task.scope,
      provider: state.llmProvider,
      contextSessionId: mcp.contextSessionId ?? contextSessionId ?? null,
      total: mcp,
    });
    mcpRollup = buildRunMcp(state.task.id, [{
      subAgent: 'default',
      role: 'default',
      ok,
      contextSessionId: mcp.contextSessionId ?? contextSessionId ?? null,
      mcp,
    }]);
    log('compliance', formatMcpMetrics(mcp));
    recordRunEvent(state.repoRoot, {
      event: 'sub_agent_mcp',
      runId: state.task.id,
      subAgent: 'default',
      role: 'default',
      mcp,
    });
    recordRunEvent(state.repoRoot, { event: 'run_mcp', runId: state.task.id, mcp: mcpRollup });
  }

  recordRunEvent(state.repoRoot, {
    event: 'phase_finished',
    runId: state.task.id,
    phase: 'compliance',
    ok,
    durationMs: Date.now() - startedAtMs,
    errors: report?.errors?.length ?? 0,
    warnings: report?.warnings?.length ?? 0,
  });
  return { report, ok, mcp, mcpRollup };
}

/** Orchestrator build/test in the product sandbox (single-sub-agent path). */
export async function runtimeCheckNode(state) {
  const blocked = state.result?.status === 'blocked' || state.result?.status === 'failed';
  if (!state.ok || blocked || !state.repoRoot) {
    const runtimeCheck = { ok: true, skipped: true, reason: 'worker-not-ok' };
    if (state.repoRoot) {
      recordRunEvent(state.repoRoot, {
        event: 'runtime_check_finished',
        runId: state.task.id,
        ok: true,
        skipped: true,
        durationMs: 0,
      });
    }
    return { runtimeCheck };
  }
  recordRunEvent(state.repoRoot, { event: 'runtime_check_started', runId: state.task.id });
  const runtimeCheck = runRuntimeCheck(state.repoRoot);
  const ok = Boolean(state.ok) && runtimeCheckPassed(runtimeCheck);
  log('runtime_check', runtimeCheck.skipped ? 'skipped' : runtimeCheck.ok ? 'ok' : `failed exit=${runtimeCheck.exitCode}`);
  recordRunEvent(state.repoRoot, {
    event: 'runtime_check_finished',
    runId: state.task.id,
    ok: runtimeCheck.ok,
    skipped: runtimeCheck.skipped,
    command: runtimeCheck.command,
    commands: runtimeCheck.commands,
    exitCode: runtimeCheck.exitCode,
    durationMs: runtimeCheck.durationMs,
    fixAttempts: runtimeCheck.fixAttempts,
  });
  return { runtimeCheck, ok };
}

/** Trim long prose so Telegram (4096) and other channels stay readable. */
export function clipText(text, max = 280) {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/** First-sentence, high-level sub-agent summary for compact channel replies. */
export function subAgentBriefSummary(text, max = 72) {
  const s = String(text ?? '').trim();
  if (!s) return 'done';
  const dot = s.indexOf('. ');
  const first = dot >= 0 && dot <= max ? s.slice(0, dot + 1) : s;
  return clipText(first, max);
}

/** Status dot for a sub-agent line: green = orchestrator accepted, red = failed/rejected. */
export function subAgentStatusDot(subAgent) {
  const blocked = subAgent?.result?.status === 'blocked' || subAgent?.result?.status === 'failed';
  // Delivered work rejected ONLY for a weak context session is advisory (🟡):
  // outcome gates own correctness; the epistemic signal stays visible.
  if (!blocked && subAgentCsqOnlyDelivered(subAgent)) return '🟡';
  if (blocked || !subAgent?.ok) return '🔴';
  return '🟢';
}

/** Full per-sub-agent detail (files, contracts) — default off for Telegram readability. */
export function replyVerbose() {
  const raw = process.env.HARNESS_REPLY_VERBOSE ?? '';
  return /^(1|true|yes|on|verbose)$/i.test(String(raw).trim());
}

export function isAnnotationSyncSubAgent(subAgent) {
  return Boolean(subAgent?.instanceId?.endsWith('-annotations'));
}

/** Short step label for multi-agent Telegram summaries. */
export function subAgentStepLabel(subAgent) {
  if (!subAgent) return 'sub-agent';
  if (isAnnotationSyncSubAgent(subAgent)) return null;
  if (subAgent.role === 'default' && !subAgent.instanceId) return 'review-fix';
  return subAgent.instanceId || subAgent.role;
}

function enospcHint(subAgents) {
  const hit = (subAgents || []).some((l) => {
    const text = [l.result?.summary, ...(l.report?.errors ?? []), ...(l.result?.blockers ?? [])].join(' ');
    return /ENOSPC|no space left on device/i.test(text);
  });
  if (!hit) return null;
  return (
    '⚠️ disk: provider transcript cache ran out of space inside the container. ' +
    'Restart with HOME on the workspace bind mount (default in compose) or raise HARNESS_NODE_TMPFS.'
  );
}

function blockerKey(text) {
  const s = String(text ?? '').trim();
  const firstSentenceEnd = s.indexOf('. ');
  const firstSentence = firstSentenceEnd >= 0 ? s.slice(0, firstSentenceEnd + 1) : s;
  return firstSentence.toLowerCase().replace(/\s+/g, ' ');
}

function uniqueBlockers(blockers) {
  const seen = new Set();
  return blockers.filter((b) => {
    const key = blockerKey(b);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── compose_reply (map the outcome to channel-safe text) ──────────────────────
export async function composeReply(state) {
  const replyText = formatReply(state);
  // Attach promotion hook: a successful run is snapshotted into the disposable
  // repo as `attach/run-<id>` so the operator can fetch/merge it from the
  // checkout. Operator convenience, never custody — a failure logs and moves on;
  // the changes stay in the working tree either way.
  let commitLine = null;
  if (state.targetMode === 'attach' && state.repoRoot && runSucceeded(state)) {
    const snapshot = commitAttachRun(state.repoRoot, state.task?.id);
    if (snapshot?.committed) {
      commitLine = `📦 ${snapshot.branch} @ ${snapshot.oid.slice(0, 12)} — fetch from the checkout to promote`;
      log('compose_reply', `attach commit ${snapshot.branch} ${snapshot.oid.slice(0, 12)}`);
      recordRunEvent(state.repoRoot, {
        event: 'attach_commit',
        runId: state.task?.id,
        branch: snapshot.branch,
        oid: snapshot.oid,
      });
    } else if (snapshot === null) {
      log('compose_reply', 'attach commit failed — changes remain uncommitted in the workspace');
    }
  }
  const telemetry = finishRunTelemetry(state.repoRoot, state);
  const metrics = formatTelemetrySummary(telemetry);
  const parts = [replyText, ...(commitLine ? [commitLine] : []), ...(metrics ? [metrics] : [])];
  return { telemetry, replyText: parts.join('\n') };
}

/**
 * Build the human-facing verdict from graph state. Mirrors the Telegram channel's
 * verdictText so the LangGraph reply reads the same. Plain text (no Markdown) so
 * it is safe for any channel; the Telegram adapter sends it as-is.
 */
function formatPropagationFollowupLine(subAgents) {
  for (const l of subAgents) {
    const w = (l.report?.warnings ?? []).find((x) => /propagation-stale/i.test(x));
    if (w) return `ℹ️ ${clipText(w, 160)}`;
  }
  return null;
}

export function formatReply(state) {
  if (state.error && !state.result && !state.subAgents) {
    return `❌ ${state.error}`;
  }
  if (state.mode === 'multi' && Array.isArray(state.subAgents)) {
    return formatMultiReply(state);
  }
  const r = state.result || {};
  const report = state.report;
  const ok = Boolean(state.ok);
  // A blocked/failed worker is not a success even if compliance "passed" (it made
  // no false claims). Only complete/partial runs that pass compliance get a ✅.
  const blocked = r.status === 'blocked' || r.status === 'failed';
  const mark = blocked ? '⛔' : ok ? '✅' : '❌';
  const lines = [];
  lines.push(r.summary ? `${mark} ${clipText(r.summary)}` : `${mark} ${ok ? 'accepted' : 'rejected'}`);
  lines.push(`status: ${r.status ?? 'n/a'} · compliance: ${report?.valid ? 'valid' : 'invalid'}`);
  if (r.filesChanged?.length) lines.push(`📝 ${r.filesChanged.join(', ')}`);
  if (report?.errors?.length) lines.push(`⚠️ ${report.errors.join('; ')}`);
  // Skip blockers already shown as the summary (blocked results echo the reason).
  const blockers = (r.blockers ?? []).filter((b) => b !== r.summary);
  if (blockers.length) lines.push(`⛔ ${clipText(blockers.join('; '), 360)}`);
  const notes = [...(report?.warnings ?? []), ...(report?.requiredFollowups ?? [])];
  if (notes.length) lines.push(`ℹ️ ${notes.join('; ')}`);
  if (state.runtimeCheck) {
    lines.push(formatRuntimeCheckSummary(state.runtimeCheck, { clip: clipText, verbose: replyVerbose() }));
  }
  if (state.leftRunning?.length) {
    lines.push(`${state.reaped ? '🧹 reaped' : '🧟 left running'}: ${state.leftRunning.join(', ')}`);
  }
  return lines.join('\n');
}

/** Aggregate a multi-agent run: compact step summary by default; verbose with HARNESS_REPLY_VERBOSE=1. */
function formatMultiReply(state) {
  const subAgents = state.subAgents || [];
  const verbose = replyVerbose();
  const summaryMax = verbose ? 280 : 72;
  const isDone = (l) =>
    (l.ok || subAgentGateEffectivelyOk(l) || subAgentCsqOnlyDelivered(l))
    && (l.result?.status === 'complete' || l.result?.status === 'partial');
  const subAgentBlockers = (l) => {
    const scope = l.scope ?? l.result?.scope ?? [];
    return uniqueBlockers(
      (l.handoff?.blockers ?? l.result?.blockers ?? [])
        .filter((b) => b && b !== l.result?.summary)
        .filter((b) => !isOutOfScopeInfraBlocker(b, scope)),
    );
  };
  // An annotation-sync sub-agent that "completed" but did not converge (ok=false, no
  // real blockers) is a sync non-convergence, not a blocked worker: its residual is
  // eligible to be swept by a later scope's sub-agent, and any real leftover debt
  // surfaces in the end-state needsWork signal — not as a blocked worker in the head.
  const isSyncNonConvergence = (l) =>
    isAnnotationSyncSubAgent(l)
    && !l.ok
    && l.result?.status === 'complete'
    && subAgentBlockers(l).length === 0;
  const isBlocked = (l) =>
    !subAgentGateEffectivelyOk(l)
    && !subAgentCsqOnlyDelivered(l)
    && !isSyncNonConvergence(l)
    && (l.result?.status === 'blocked' || l.result?.status === 'failed' || (!l.ok && l.result?.status === 'complete'));
  const cleanPostFixReviewIndex = subAgents.findIndex(
    (l) => l.instanceId === 'post-review' && isDone(l) && subAgentBlockers(l).length === 0,
  );
  const blockerSubAgentIndexes = subAgents.map((l, index) => [index, subAgentBlockers(l)]).filter(([, blockers]) => blockers.length);
  const resolvedBlockerSubAgentIndexes =
    cleanPostFixReviewIndex >= 0 ? blockerSubAgentIndexes.filter(([index]) => index < cleanPostFixReviewIndex) : [];
  const unresolvedBlockerSubAgentIndexes =
    cleanPostFixReviewIndex >= 0 ? blockerSubAgentIndexes.filter(([index]) => index > cleanPostFixReviewIndex) : blockerSubAgentIndexes;
  const resolvedBlockerIndexes = new Set(resolvedBlockerSubAgentIndexes.map(([index]) => index));
  const unresolvedBlockerReports = unresolvedBlockerSubAgentIndexes.length;
  const resolvedBlockerReports = resolvedBlockerSubAgentIndexes.length;
  const completed = subAgents.filter(isDone).length;
  const blocked = subAgents.filter(isBlocked).length;
  const runtimeFailed = state.runtimeCheck && !runtimeCheckPassed(state.runtimeCheck);
  const goalOk = state.goalOk ?? repovineGoalOk({ subAgents, runtimeCheck: state.runtimeCheck });
  const processOk = state.processOk ?? state.ok ?? repovineProcessRunOk({
    subAgents,
    runtimeCheck: state.runtimeCheck,
    reviewGateOpen: true,
  });
  const taskMark = runtimeFailed || goalOk === false ? '❌' : goalOk ? '✅' : '❓';
  const processMark = runtimeFailed || processOk === false ? '⚠️' : processOk ? '✅' : '❓';
  // Two lines with a word verdict: a bare "✅ goal · ✅ process" reads as one glyph
  // wall and the middot gets lost. The word says what the mark means at a glance.
  const goalWord = runtimeFailed || goalOk === false ? 'not delivered' : goalOk ? 'delivered' : 'unverified';
  const processWord = runtimeFailed || processOk === false ? 'has issues' : processOk ? 'clean' : 'unverified';
  const changedFileCount = state.signals?.treeDiff?.captured ? state.signals.treeDiff.changedFiles.length : null;
  const goalHead = `${taskMark} Goal ${goalWord}${changedFileCount != null ? ` — ${changedFileCount} file(s) changed` : ''}`;
  const processHead =
    `${processMark} Process ${processWord} — ${completed}/${subAgents.length} sub-agents` +
    (blocked ? `, ${blocked} blocked` : '') +
    ` (${state.execution || 'sequential'})`;
  const lines = [goalHead, processHead];
  for (const extra of formatOrientVerifyReplyLines(state)) {
    lines.push(extra);
  }
  const diskHint = enospcHint(subAgents);
  if (diskHint) lines.push(diskHint);
  if (unresolvedBlockerReports || resolvedBlockerReports) {
    // A blocker from an annotation-sync sub-agent that still COMPLETED is a soft advisory,
    // not a failure: it flags repo-wide annotation staleness in nodes OUTSIDE its own
    // scope, which it is not allowed to fix (drained by the matching scope's sub-agent). Show
    // 🟡 only when every unresolved blocker is one of those; any other unresolved blocker
    // (a real handoff blocker, a blocked/failed sub-agent) keeps the hard 🔴.
    const isSoftAdvisory = (l) => isDone(l) && isAnnotationSyncSubAgent(l);
    const hardUnresolved = unresolvedBlockerSubAgentIndexes.some(([index]) => !isSoftAdvisory(subAgents[index]));
    const blockerDot = unresolvedBlockerReports ? (hardUnresolved ? '🔴' : '🟡') : '●';
    lines.push(`${blockerDot} blockers: ${unresolvedBlockerReports} unresolved`);
    if (resolvedBlockerReports) lines.push(`🛠 fixed blocker reports: ${resolvedBlockerReports} OK`);
  }
  if (state.runtimeCheck) {
    lines.push(formatRuntimeCheckSummary(state.runtimeCheck, { clip: clipText, verbose }));
  }
  // Run-level changed files come from the harness tree-diff, not subAgent self-reports.
  if (state.signals?.treeDiff) {
    const td = state.signals.treeDiff;
    lines.push(td.captured
      ? `📝 diff: ${td.changedFiles.length} file(s) (tree-diff)`
      : '📝 diff: unavailable — capture failed (fail-closed, no clean-diff claim)');
  }
  for (const b of [...(state.signals?.testFloorBlockers ?? []), ...(state.signals?.artifactFloorBlockers ?? [])]) {
    lines.push(`🔴 ${clipText(b, 200)}`);
  }

  const annotationSubAgents = subAgents.filter(isAnnotationSyncSubAgent);
  const stepSubAgents = verbose ? subAgents : subAgents.filter((l) => !isAnnotationSyncSubAgent(l));

  for (const [index, l] of stepSubAgents.entries()) {
    const subAgentIndex = verbose ? index : subAgents.indexOf(l);
    // A subAgent whose blockers were cleared by a later fix + clean post-fix review is not a failure:
    // paint it 🟡 (found and fixed), not 🔴 (still broken). Genuine failures keep subAgentStatusDot's 🔴.
    const blockerResolved = resolvedBlockerIndexes.has(subAgentIndex);
    const label = verbose
      ? (l.instanceId ? `${l.role}/${l.instanceId}` : l.role)
      : subAgentStepLabel(l);
    if (!label) continue;
    const rawSummary = l.result?.summary || (l.ok ? 'accepted' : 'rejected');
    const summary = verbose ? clipText(rawSummary, summaryMax) : subAgentBriefSummary(rawSummary, summaryMax);
    const dot = blockerResolved ? '🟡' : subAgentStatusDot(l);
    lines.push(`${dot} [${label}] ${summary}`);
    if (verbose && l.result?.filesChanged?.length) lines.push(`    📝 ${l.result.filesChanged.join(', ')}`);
    if (verbose && l.handoff?.contractsChanged?.length) {
      lines.push(`    📜 ${clipText(l.handoff.contractsChanged.join('; '), 240)}`);
    }
    if (!l.ok && l.report?.errors?.length) {
      lines.push(`    ${clipText(l.report.errors.join('; '), verbose ? 240 : 120)}`);
    }
    const blockers = subAgentBlockers(l);
    if (blockers.length) {
      if (verbose || !blockerResolved) {
        const blockerPrefix = blockerResolved ? '🟡 resolved' : '🔴 blocker';
        lines.push(`    ${blockerPrefix}: ${clipText(blockers.join('; '), verbose ? 360 : 120)}`);
      }
    }
    if (l.leftRunning?.length) {
      lines.push(`    ${l.reaped ? '🧹 reaped' : '🧟 left running'}: ${l.leftRunning.join(', ')}`);
    }
  }

  if (!verbose && annotationSubAgents.length) {
    const annDone = annotationSubAgents.filter(isDone).length;
    const total = annotationSubAgents.length;
    // Severity follows the END-STATE annotation debt (needsWork after the join
    // cleanup), not whether each sub-agent converged alone: a residual one leaves
    // and a later scope's sub-agent sweeps is not run debt. Fall back to the
    // per-sub-agent tally when the engine health snapshot is unavailable.
    const health = state.signals?.annotationHealth;
    const scopes = annotationSubAgents.map((l) => (l.instanceId || '').replace(/-annotations$/, '') || l.role);
    // Every sync sub-agent that reached compliance-valid means annotations are
    // clean WITHIN ITS SCOPE. `needsWork` is a REPO-WIDE count that also includes
    // stale/unannotated nodes this run never touched — colouring the line 🔴 for
    // that pre-existing debt reads as "this run failed" on a glance. So: the line
    // reflects what THIS run delivered (in-scope), and repo-wide debt is a
    // separate neutral ℹ️ fact.
    const inScopeClean = annDone === total;
    if (inScopeClean) {
      lines.push(`✅ annotations: in-scope clean (${scopes.join(', ')})`);
      if (health && health.needsWork > 0) {
        lines.push(`ℹ️ repo carries ${health.needsWork} pre-existing stale/unannotated node(s) outside this run — not introduced here`);
      }
    } else {
      // A sync sub-agent that did not converge and was not swept by a later
      // scope is a real in-scope shortfall — keep the hard signal.
      const debtClean = health ? health.needsWork === 0 : false;
      let line = `${debtClean ? '🟢' : '🔴'} [annotation-sync] ${annDone}/${total} (${scopes.join(', ')})`;
      if (debtClean) line += ' · debt clean (residual swept)';
      else if (health && health.needsWork > 0) line += ` · needsWork ${health.needsWork} (in-scope debt remains)`;
      lines.push(line);
    }
  }

  // Propagation triggers (upstream node names) are useful detail but verbose;
  // the compact card already states repo-wide debt above.
  if (verbose) {
    const propagationLine = formatPropagationFollowupLine(subAgents);
    if (propagationLine) lines.push(propagationLine);
  }

  return lines.join('\n');
}
