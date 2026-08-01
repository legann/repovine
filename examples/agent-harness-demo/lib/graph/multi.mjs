// Multi-agent orchestration node (Phase 4) — LangGraph as the MAIN agent.
//
// Owns the sub-agent sequence: plan → schedule → run each internal worker as its OWN
// validated protocol worker → refresh barrier between stages → join. The rule's
// invariants are enforced HERE in code (disjoint-scope batching, flat internal
// workers, refresh barrier, threaded handoffs), while each sub-agent's prose comes
// from the projected agent rules. repovine validates every sub-agent independently.
//
// Execution within a stage:
//   - sequential in the shared sandbox (default; always race-free), OR
//   - greenfield runs fan implement roles out in git worktrees, merged at join
//     (HARNESS_GREENFIELD_PARALLEL=0 disables; continuation is always sequential)
//     (honors "parallel only for disjoint scopes" without shared-tree races).
import { RUN_LEVEL, runLevelPath, writeJsonFile } from '../harness-paths.mjs';
import * as rp from '../repovine.mjs';
import { runSubAgent } from './sub-agent.mjs';
import { captureWorkspaceRevision, diffChangedFiles, revisionsEqual } from './workspace-revision.mjs';
import { missingTestFloorBlockers } from './test-floor.mjs';
import { missingReferencedArtifacts } from './artifact-floor.mjs';
import { collectAnnotationObligations, obligationsSection, readAnnotationsSnapshot } from './annotation-obligations.mjs';
import { applyGreenfieldParallelStages, assignSubAgentInstanceIds, overPlannedRoles, planSubAgentsAsync, scheduleStages } from './plan.mjs';
import { collectSubAgentSessions } from './sessions.mjs';
import { buildRunUsage } from '../workers/usage.mjs';
import { buildRunMcp, formatMcpMetrics } from '../workers/mcp-telemetry.mjs';
import { resolveRole } from '../agents.mjs';
import { deliveryVerificationAccepted } from '../delivery.mjs';
import {
  available as gitAvailable,
  ensureGitRepo,
  addWorktree,
  commitWorktree,
  mergeWorktree,
  removeWorktree,
  preserveWorktreeArtifacts,
} from './worktree.mjs';
import { targetPolicy } from '../target-repo.mjs';
import {
  runRuntimeCheck,
  runtimeCheckPassed,
  runtimeRequired,
  runtimeStatusOf,
  runtimeAcceptedOf,
  runtimeCheckBlockers,
  runtimeCheckFixEnabled,
  runtimeCheckFixMaxAttempts,
  failedRuntimeCheckCommand,
  canAttemptRuntimeCheckFix,
  runtimeCheckFixAttemptsForCommand,
  recordRuntimeCheckFixAttempt,
  deriveRuntimeCheckFixScopes,
  buildRuntimeCheckFixTask,
} from '../runtime-check.mjs';
import { reviewFixSubAgentAccepted } from './retry.mjs';
import { logLine } from '../log.mjs';
import { recordRunEvent } from '../telemetry.mjs';
import {
  formatOrientVerifyReplyLines,
  subAgentCsqOnlyDelivered,
  repovineProcessEnabled,
  repovineProcessRunOk,
  repovineGoalOk,
  runOrientPhase,
  runVerifyClaimsPhase,
  verificationStatusOf,
  verificationAcceptedOf,
} from './repovine-process.mjs';

// Custody backend for both target modes: sandbox is its own repo, attach
// carries the launch-scoped disposable repo behind the read-only pointer —
// git-tree capture works identically (Phase 2 removed the filesystem backend).
const REVISION_BACKEND = 'git-tree';

const VERBOSE = process.env.GRAPH_VERBOSE !== '0';
const log = (msg) => logLine('multi', msg, { enabled: VERBOSE, indent: '  ' });

function wantReview(task) {
  if (task.review === true) return true;
  if (Array.isArray(task.roles) && task.roles.includes('review')) return true;
  if (Array.isArray(task.subAgents) && task.subAgents.some((l) => (l.role || l) === 'review')) return true;
  return false;
}

function reviewFixEnabled() {
  return process.env.HARNESS_REVIEW_FIX !== '0';
}

function postFixReviewEnabled() {
  return process.env.HARNESS_POST_FIX_REVIEW !== '0';
}

function postReviewAnnotationsEnabled() {
  return process.env.HARNESS_POST_REVIEW_ANNOTATIONS !== '0';
}

/** Roll per-sub-agent usage into one .harness/<run>.run.usage.json so a single file
 *  answers the cost/cache questions for the whole /task. */
function writeRunUsage(task, repoRoot, subAgents) {
  if (!subAgents.length) return null;
  const runId = task?.id || 'run';
  const rollup = buildRunUsage(
    runId,
    subAgents.map((l) => ({
      subAgent: l.instanceId || l.role,
      role: l.role,
      fresh: !l.resumed,
      ok: l.ok,
      usage: l.usage ?? null,
    })),
  );
  try {
    writeJsonFile(runLevelPath(repoRoot, runId, RUN_LEVEL.rollupUsage, { active: true }), rollup);
  } catch {
    /* usage logging is best-effort — never fail a run over it */
  }
  const t = rollup.total;
  if (t) {
    const f = rollup.freshTotal;
    log(
      `run usage: in=${t.inputTokens ?? '–'} out=${t.outputTokens ?? '–'} cacheRead=${t.cacheReadTokens ?? '–'} `
        + `hit=${t.cacheHitRatio ?? '–'}${t.costUsd != null ? ` $${t.costUsd.toFixed(4)}` : ''} `
        + `| fresh sub-agents in=${f?.inputTokens ?? '–'} hit=${f?.cacheHitRatio ?? '–'}`,
    );
  }
  recordRunEvent(repoRoot, { event: 'run_usage', runId, usage: rollup });
  return rollup;
}

/** Roll per-sub-agent MCP tool counts into `.harness/<run>.run.mcp.json`. */
function writeRunMcpUsage(task, repoRoot, subAgents) {
  if (!subAgents.length) return null;
  const runId = task?.id || 'run';
  const rollup = buildRunMcp(
    runId,
    subAgents.map((l) => ({
      subAgent: l.instanceId || l.role,
      role: l.role,
      ok: l.ok,
      contextSessionId: l.mcp?.contextSessionId ?? l.result?.contextSessionId ?? null,
      mcp: l.mcp ?? null,
    })),
  );
  if (!rollup.total) return null;
  try {
    writeJsonFile(runLevelPath(repoRoot, runId, RUN_LEVEL.rollupMcp, { active: true }), rollup);
  } catch {
    /* MCP logging is best-effort */
  }
  log(formatMcpMetrics(rollup));
  recordRunEvent(repoRoot, { event: 'run_mcp', runId, mcp: rollup });
  return rollup;
}

function refreshGraph(repoRoot, task, label, opts) {
  const startedAtMs = Date.now();
  recordRunEvent(repoRoot, { event: 'phase_started', runId: task.id, phase: 'refresh_context', label });
  const result = rp.refreshGraph(repoRoot, opts);
  recordRunEvent(repoRoot, {
    event: 'phase_finished',
    runId: task.id,
    phase: 'refresh_context',
    label,
    ok: true,
    durationMs: Date.now() - startedAtMs,
  });
  return result;
}

function findLastReviewSubAgent(subAgents) {
  for (let i = subAgents.length - 1; i >= 0; i -= 1) {
    if (subAgents[i].role === 'review') return subAgents[i];
  }
  return null;
}

function findPostFixReviewSubAgent(subAgents) {
  return subAgents.find((l) => l.instanceId === 'post-review') ?? null;
}

/** Review sub-agent that gates runtime_check / annotation-sync (post-fix wins over stale pre-fix review). */
export function effectiveReviewSubAgent(subAgents) {
  return findPostFixReviewSubAgent(subAgents) ?? findLastReviewSubAgent(subAgents);
}

function subAgentBlockers(subAgent) {
  return (subAgent?.handoff?.blockers ?? subAgent?.result?.blockers ?? []).filter(Boolean);
}

/**
 * The review sub-agent's PRODUCT verdict: a readable result that reports zero blockers.
 *
 * Deliberately not gated on the subAgent's own `ok`. A reviewer that approved the code but
 * botched its own AgentRunResult (e.g. omitted the required `review` object) failed the
 * harness protocol, not the product — that stays visible in the subAgent's `ok:false` and in
 * the run status. Holding the annotation sync back for it throws away a clean review and
 * subAgents the graph unannotated; annotations are durable memory, not a merge decision.
 *
 * Two results are unusable as an approval: one that failed schema validation (the verdict
 * cannot be read at all) and one whose own status is `blocked` / `failed`.
 */
function reviewPassed(reviewSubAgent) {
  if (!reviewSubAgent?.schemaValid) return false;
  const status = reviewSubAgent.result?.status;
  if (status === 'blocked' || status === 'failed') return false;
  return subAgentBlockers(reviewSubAgent).length === 0;
}

/**
 * Review subAgent that owns ACCEPTANCE: the LAST full review — the post-fix re-review
 * when a fix cycle ran, else the first review. The freshest verdict decides; a
 * stale or verdict-free subAgent fails `reviewProcessValid` (fail-closed). This is the
 * bounded generic transition that lets a run re-earn acceptance after a fix, for
 * ANY blocker class — acceptance is never pinned to a pre-fix verdict. The
 * verify-claims subAgent shares the role but lives in processSubAgents and never enters
 * this list.
 */
export function findAcceptanceReviewSubAgent(subAgents) {
  for (let i = subAgents.length - 1; i >= 0; i -= 1) {
    if (subAgents[i].role === 'review') return subAgents[i];
  }
  return null;
}

/**
 * Review freshness from HARNESS-captured revisions, never a model field. Equal
 * digests are fresh; otherwise fresh means the diff between the reviewed revision
 * and the current tree is empty after two exemptions: `repovine.annots.json`
 * (the post-review annotation sync writes it by design) and `excludePaths` —
 * files the harness's own runtime check materialized (npm install lockfiles,
 * build/test outputs). Edits to repovine.config.json / repovine.domains.json and
 * any fix-subAgent code edit still stale the review. A failed capture or diff is
 * stale (fail-closed).
 */
export function reviewIsFresh({ reviewedRevision, currentTree, excludePaths = [] }) {
  if (!reviewedRevision || !currentTree) return false;
  if (revisionsEqual(reviewedRevision, currentTree)) return true;
  const changed = diffChangedFiles(reviewedRevision, currentTree, {
    exclude: ['repovine.annots.json', ...excludePaths],
  });
  return Array.isArray(changed) && changed.length === 0;
}

/**
 * The review ran under contract AND its verdict is readable against the current
 * tree: subAgent accepted, terminal complete, `review` object present, no mutation
 * since the review (freshness). Distinct from `reviewPassed` (the process-flow
 * gate over blockers): a changes-requested review with blocker findings is a
 * VALID process — acceptance, not validity, owns the verdict.
 */
export function reviewProcessValid(reviewSubAgent, { fresh = false } = {}) {
  if (!reviewSubAgent?.ok) return false;
  if (reviewSubAgent.result?.status !== 'complete') return false;
  const review = reviewSubAgent.result?.review;
  if (!review || typeof review !== 'object') return false;
  return fresh === true;
}

/**
 * Strict acceptance: process valid AND `verdict === 'approve'` AND no blocker/major
 * findings. Test coverage is NOT a clause here — the grounded test floor owns test
 * existence; `testReview` is the reviewer's advisory quality lens.
 */
export function reviewAcceptedOf(reviewSubAgent, { fresh = false } = {}) {
  if (!reviewProcessValid(reviewSubAgent, { fresh })) return false;
  const review = reviewSubAgent.result.review;
  if (review.verdict !== 'approve') return false;
  return !(review.findings ?? []).some((f) => f?.severity === 'blocker' || f?.severity === 'major');
}

/** True when review-fix landed and blockers are cleared (or post-fix review will run). */
/**
 * A fix sub-agent keeps the pipeline moving when its work is accepted outright OR
 * delivered with only CSQ noise. Opening the gate grants nothing by itself: the
 * staleness guard still dispatches a full re-review, and acceptance comes only from
 * that fresh verdict. An undelivered fix (no files) or one with non-CSQ compliance
 * errors keeps the gate closed.
 */
function fixSubAgentDelivered(fixSubAgent) {
  return reviewFixSubAgentAccepted(fixSubAgent) || subAgentCsqOnlyDelivered(fixSubAgent);
}

export function reviewGateIsOpen(subAgents, fixSubAgent) {
  const postFix = findPostFixReviewSubAgent(subAgents);
  if (postFix) return reviewPassed(postFix);
  if (fixSubAgentDelivered(fixSubAgent)) return true;
  const review = findLastReviewSubAgent(subAgents);
  return !review || reviewPassed(review);
}

/** After review blockers, run one fix sub-agent that consumes the full inter-sub-agent handoff. */
/**
 * Blockers are actionable as long as the review result PARSED. Gating the fix on the
 * review's own compliance (`ok`) conflates two different failures: a review that found
 * real blockers, and a review that botched its own AgentRunResult. The second one used to
 * close the gate permanently — no fix sub-agent, no post-review annotation sync, no
 * explanation. A schema-invalid result is the one case where the blockers cannot be trusted.
 */
export function reviewFixEligible(reviewSubAgent) {
  if (!subAgentBlockers(reviewSubAgent).length) return false;
  return Boolean(reviewSubAgent?.ok || reviewSubAgent?.schemaValid);
}

/**
 * The fix subAgent's blocker ledger: the review's blockers (only when the review
 * result parsed — schema-invalid blockers are untrustworthy), the review's
 * SERIOUS findings, and deterministic harness blockers (the grounded test
 * floor). Serious blocker/major findings enter even when the reviewer did not
 * mirror them into top-level blockers — they close `reviewAccepted`, so without
 * a fix transition a findings-only changes-requested verdict would be terminal.
 * The floor gets its transition here too instead of silently closing goalOk
 * at final status; the final re-scan in deriveMultiRunStatus verifies the fix.
 */
export function assembleFixBlockers(reviewSubAgent, extraBlockers = []) {
  const reviewBlockers = reviewFixEligible(reviewSubAgent) ? subAgentBlockers(reviewSubAgent) : [];
  const review = reviewSubAgent?.schemaValid !== false ? reviewSubAgent?.result?.review : null;
  const findings = review && typeof review === 'object' ? (review.findings ?? []) : [];
  // A changes-requested verdict means the reviewer's requested changes ARE its
  // findings — ALL of them enter the ledger, whatever their severity: a
  // minor-only changes-requested would otherwise be terminal (acceptance closed
  // with nothing delivered to the fix transition). Under any other verdict only
  // blocker/major findings are actionable; minors stay advisory noise.
  const changesRequested = review?.verdict === 'changes-requested';
  const actionableFindings = findings
    .filter((f) => changesRequested || f?.severity === 'blocker' || f?.severity === 'major')
    .map((f) => `[review:${f.severity}] ${f.summary}${f.recommendation ? ` — fix: ${f.recommendation}` : ''}`);
  return [...new Set([...reviewBlockers, ...actionableFindings, ...extraBlockers.filter(Boolean)])];
}

async function maybeRunReviewFix({ task, repoRoot, provider, reviewSubAgent, handoffs, signal, priorSessions, onSession, greenfieldRun, extraBlockers = [] }) {
  if (!reviewFixEnabled()) return null;
  const blockers = assembleFixBlockers(reviewSubAgent, extraBlockers);
  if (!blockers.length) return null;
  if (subAgentBlockers(reviewSubAgent).length && !reviewFixEligible(reviewSubAgent)) {
    log('review blockers dropped from fix input — review result failed schema validation; its blockers are not trustworthy');
  }
  if (reviewSubAgent && !reviewSubAgent.ok && reviewFixEligible(reviewSubAgent)) {
    log('review-fix on a compliance-rejected review — blockers parsed, acting on them');
  }

  const spec = resolveRole('default', repoRoot, {
    scope: ['.'],
    task: [
      'Fix the blockers below (write-only). Consume inter-sub-agent contracts from prior phases.',
      'Align frontend client with backend response envelope when applicable.',
      'List any API or wiring changes in contractsChanged.',
      'graphNodesTouched is REQUIRED and must resolve in the graph: after refresh_context, list the',
      'canonical ids covering your edits — module ids (mod:…), or the owning package id (pkg:<dir>)',
      'when you only touched package/config files that are not graph modules (e.g. vite.config.ts).',
      '',
      'Blockers:',
      ...blockers.map((b) => `- ${b}`),
    ].join('\n'),
  });
  log('review-fix sub-agent');
  return runSubAgent({
    parentTask: task, spec, repoRoot, provider, priorHandoffs: handoffs, signal,
    resume: priorSessions?.[spec.role], onSession, telemetryRoot: repoRoot, greenfieldRun,
  });
}

function postReviewGatesPassed(subAgents, fixSubAgent, runtimeCheck) {
  if (!reviewGateIsOpen(subAgents, fixSubAgent)) return false;
  return runtimeCheckPassed(runtimeCheck);
}

/** Which gate held the annotation sync back. */
export function annotationSyncSkipReason(subAgents, fixSubAgent, runtimeCheck) {
  if (!reviewGateIsOpen(subAgents, fixSubAgent)) {
    const review = effectiveReviewSubAgent(subAgents);
    if (!review) return 'review gate closed';
    if (!review.schemaValid) return 'review result failed schema validation — its verdict is unreadable';
    const status = review.result?.status;
    if (status === 'blocked' || status === 'failed') return `review sub-agent ended ${status}`;
    return `review reported ${subAgentBlockers(review).length} unresolved blocker(s)`;
  }
  if (!runtimeCheckPassed(runtimeCheck)) return 'runtime_check did not pass';
  return 'unknown';
}

/**
 * Annotations are the run's durable graph memory, and the post-review sync subAgent is the
 * ONLY writer — implement sub-agents are told to defer. A skipped sync therefore subAgents
 * repovine.annots.json untouched, which looks identical to "nothing needed annotating".
 * Say so in the log and in the run's event ledger.
 */
function logAnnotationSyncSkipped(repoRoot, task, reason) {
  log(`post-review annotation sync SKIPPED — ${reason}; repovine.annots.json is unchanged for this run`);
  recordRunEvent(repoRoot, {
    event: 'annotation_sync_skipped',
    runId: task.id,
    reason,
  });
}

/** After runtime_check failure, run one fix sub-agent scoped from compiler/test log paths. */
async function maybeRunRuntimeCheckFix({
  task, repoRoot, provider, check, handoffs, signal, priorSessions, onSession, attempt = 1, greenfieldRun,
}) {
  if (!runtimeCheckFixEnabled()) return null;
  const blockers = runtimeCheckBlockers(check);
  if (!blockers.length) return null;

  const scopes = deriveRuntimeCheckFixScopes(check);
  const singleScope = scopes.length === 1 ? scopes[0] : null;
  const role =
    singleScope === 'infra' ? 'infra'
      : singleScope === 'backend' ? 'backend'
        : singleScope === 'frontend' ? 'frontend'
          : 'default';

  const spec = {
    ...resolveRole(role, repoRoot, {
      scope: scopes,
      task: buildRuntimeCheckFixTask(check, blockers),
    }),
    instanceId: attempt > 1 ? `runtime-fix-${attempt}` : 'runtime-fix',
  };
  log(`runtime-fix sub-agent scope=[${scopes.join(', ')}]`);
  return runSubAgent({
    parentTask: task, spec, repoRoot, provider, priorHandoffs: handoffs, signal,
    resume: priorSessions?.[spec.role], onSession, telemetryRoot: repoRoot, greenfieldRun,
  });
}

/**
 * Run the runtime check with tree custody: files the CHECK COMMANDS themselves
 * materialize (npm-install lockfiles, build/test outputs not covered by ignore
 * rules) are recorded into `harnessMutatedPaths` so review freshness can exempt
 * harness-induced mutation. Fix-subAgent edits happen outside these windows and
 * still stale a review. A failed window capture records nothing — fail-closed:
 * the review may go stale, never falsely fresh.
 */
function runRuntimeCheckWithCustody(repoRoot, harnessMutatedPaths) {
  const pre = captureWorkspaceRevision(repoRoot, { backend: REVISION_BACKEND });
  const check = runRuntimeCheck(repoRoot);
  const post = captureWorkspaceRevision(repoRoot, { backend: REVISION_BACKEND });
  const mutated = pre && post ? diffChangedFiles(pre, post, { exclude: [] }) : null;
  for (const p of mutated ?? []) harnessMutatedPaths.add(p);
  return check;
}

/** Run runtime_check (+ optional fix/re-check loop) after review-fix, before annotation sync. */
async function runRuntimeCheckPhase({
  task, repoRoot, provider, subAgents, handoffs, signal, priorSessions, onSession, greenfieldRun,
}) {
  const harnessMutatedPaths = new Set();
  recordRunEvent(repoRoot, { event: 'runtime_check_started', runId: task.id });
  let check = runRuntimeCheckWithCustody(repoRoot, harnessMutatedPaths);
  recordRunEvent(repoRoot, {
    event: 'runtime_check_finished',
    runId: task.id,
    ok: check.ok,
    skipped: check.skipped,
    command: check.command,
    commands: check.commands,
    exitCode: check.exitCode,
    durationMs: check.durationMs,
    fixAttempts: 0,
  });
  let totalFixSubAgents = 0;
  const fixAttemptsByCommand = new Map();
  const maxFix = runtimeCheckFixMaxAttempts();

  while (!runtimeCheckPassed(check) && runtimeCheckFixEnabled() && !signal?.aborted) {
    const failedCommand = failedRuntimeCheckCommand(check);
    if (!canAttemptRuntimeCheckFix(failedCommand, fixAttemptsByCommand, maxFix)) {
      if (failedCommand) {
        log(`runtime-fix budget exhausted for "${failedCommand}" (${maxFix}/${maxFix})`);
      }
      break;
    }

    totalFixSubAgents += 1;
    const cmdAttempt = runtimeCheckFixAttemptsForCommand(failedCommand, fixAttemptsByCommand) + 1;
    log(`runtime-fix for "${failedCommand}" attempt ${cmdAttempt}/${maxFix}`);
    const fixSubAgent = await maybeRunRuntimeCheckFix({
      task, repoRoot, provider, check, handoffs, signal, priorSessions, onSession,
      attempt: totalFixSubAgents, greenfieldRun,
    });
    if (!fixSubAgent) break;
    subAgents.push(fixSubAgent);
    handoffs.push(fixSubAgent.handoff);
    if (!fixSubAgent.ok && !subAgentCsqOnlyDelivered(fixSubAgent)) break;
    refreshGraph(repoRoot, task, 'after runtime-fix');
    log('refresh barrier after runtime-fix');
    recordRuntimeCheckFixAttempt(failedCommand, fixAttemptsByCommand);
    recordRunEvent(repoRoot, { event: 'runtime_check_started', runId: task.id });
    check = runRuntimeCheckWithCustody(repoRoot, harnessMutatedPaths);
    recordRunEvent(repoRoot, {
      event: 'runtime_check_finished',
      runId: task.id,
      ok: check.ok,
      skipped: check.skipped,
      command: check.command,
      commands: check.commands,
      exitCode: check.exitCode,
      durationMs: check.durationMs,
      fixAttempts: totalFixSubAgents,
    });
  }

  check.fixAttempts = totalFixSubAgents;
  if (fixAttemptsByCommand.size) {
    check.fixAttemptsByCommand = Object.fromEntries(fixAttemptsByCommand);
  }
  // Custody set for review freshness: what the check commands themselves wrote.
  check.harnessMutatedPaths = [...harnessMutatedPaths].sort();
  return check;
}

/**
 * Full post-stabilization re-review: the bounded generic transition that lets a
 * run re-earn review acceptance after the tree mutated past the standing verdict
 * (review-fix OR runtime-fix), for ANY blocker class. The CALLER owns the trigger
 * (review gate open + verdict stale); this dispatch carries the code-reviewer
 * manifest and the harness tree-diff (same contract as the first review), and
 * custody marks make its fresh verdict the acceptance verdict
 * (findAcceptanceReviewSubAgent reads the LAST review). It never triggers another
 * fix — one re-review per run.
 */
async function maybeRunPostFixReview({ task, repoRoot, provider, handoffs, signal, priorSessions, onSession, greenfieldRun, baselineTree, priorBlockers = [] }) {
  if (!postFixReviewEnabled()) return null;
  const spec = {
    ...withReviewTreeDiff(
      resolveRole('review', repoRoot, {
        scope: ['.'],
        task: [
          'Post-fix code review (read-only, full verdict): the previous review requested changes and the tree has since been fixed.',
          'Review the CURRENT implementation against the original task, the contracts, and the prior blockers below.',
          'Do not execute shell commands, tests, builds, Docker, curl, or dev servers.',
          'Emit the full CodeReviewResult in AgentRunResult.review: verdict "approve" ONLY when the prior blockers are resolved and no new blocker/major issue exists; otherwise "changes-requested" with the remaining blockers.',
          '',
          '## Prior blockers to re-judge',
          ...(priorBlockers.length ? priorBlockers.map((b) => `- ${b}`) : ['- (none recorded — judge the current tree on its own merits)']),
        ].join('\n'),
      }),
      task, repoRoot, baselineTree,
    ),
    instanceId: 'post-review',
  };
  log('post-fix review sub-agent (full re-review)');
  const subAgent = await runSubAgent({
    parentTask: task, spec, repoRoot, provider, priorHandoffs: handoffs, signal,
    resume: priorSessions?.[spec.role], onSession, telemetryRoot: repoRoot, greenfieldRun,
  });
  markReviewedRevision(subAgent, repoRoot, baselineTree, { soleInStage: true });
  return subAgent;
}

/**
 * Annotation sync targets DELIVERED work, not protocol-clean work: a subAgent that
 * wrote files and reached a terminal complete/partial status is annotated even
 * when its own compliance was rejected (e.g. a weak context session) — the code
 * is in the tree and the caller's review gate already approved the run. Skipping
 * it would leave the graph memory stale for the next run's orient/review. A subAgent
 * with no terminal delivery (blocked/failed, or no files) is never annotated.
 */
export function annotationSyncTargets(subAgents) {
  const targets = [];
  const seen = new Set();
  for (const subAgent of subAgents) {
    if (!subAgent || subAgent.role === 'review') continue;
    if (!subAgent.result?.filesChanged?.length) continue;
    const deliveredStatus = subAgent.result?.status === 'complete' || subAgent.result?.status === 'partial';
    if (!subAgent.ok && !deliveredStatus) continue;
    const key = subAgent.instanceId || subAgent.role;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(subAgent);
  }
  return targets;
}

function inheritsWholeGraph(scope = []) {
  return scope.length === 0 || scope.includes('.');
}

function normChangedPath(file) {
  return String(file).replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

/** Container / compose artifacts live under app dirs but annotate as infra graph kinds. */
function isInfraArtifactPath(filePath) {
  const base = filePath.split('/').pop() ?? filePath;
  return base === 'Dockerfile'
    || base === 'docker-compose.yml'
    || base === 'compose.yaml'
    || base === 'compose.yml'
    || base === 'nginx.conf'
    || base === '.dockerignore';
}

/** Derive scope hints from canonical graph node ids reported by the implementer sub-agent. */
function deriveScopeFromGraphNodesTouched(nodeIds = []) {
  const scopes = new Set();
  for (const id of nodeIds) {
    if (!id || id === 'root') continue;
    const colon = String(id).indexOf(':');
    if (colon === -1) continue;
    const kind = String(id).slice(0, colon);
    const tail = String(id).slice(colon + 1);
    if (kind === 'infra') scopes.add('infra');
    else if (kind === 'service') scopes.add('service');
    else if (kind === 'domain' && tail.startsWith('infra-')) scopes.add('infra');
    else if (kind === 'mod' || kind === 'pkg') {
      const slash = tail.indexOf('/');
      if (slash > 0) scopes.add(tail.slice(0, slash));
    }
  }
  return [...scopes];
}

/** Fallback when graphNodesTouched is weak (e.g. only "root"): infer from changed paths. */
function deriveScopeFromFilesChanged(files = []) {
  const scopes = new Set();
  for (const raw of files) {
    const p = normChangedPath(raw);
    if (!p) continue;
    if (isInfraArtifactPath(p)) {
      scopes.add('infra');
      continue;
    }
    const slash = p.indexOf('/');
    if (slash > 0) scopes.add(p.slice(0, slash));
    else scopes.add('infra');
  }
  return [...scopes];
}

/** Root-scoped sub-agents (default review-fix, etc.): scope from graph claims, else changed paths. */
function deriveRootScopedAnnotationScope(subAgent) {
  const fromNodes = deriveScopeFromGraphNodesTouched(subAgent.result?.graphNodesTouched ?? []);
  if (fromNodes.length) return fromNodes;
  const fromFiles = deriveScopeFromFilesChanged(subAgent.result?.filesChanged ?? []);
  if (fromFiles.length) return fromFiles;
  return ['.'];
}

/** Fixed graph-kind scopes for planner-named implementer roles. */
const ROLE_ANNOTATION_SCOPE = {
  infra: ['infra'],
  backend: ['backend'],
  frontend: ['frontend'],
};

/**
 * Annotation-sync scope: inherit the implementer sub-agent scope when already narrow
 * (backend, frontend). Root-scope sub-agents use role kind (infra) or derive from
 * graphNodesTouched / filesChanged (default review-fix may touch infra or app code).
 */
export function deriveAnnotationSyncScope(subAgent) {
  const inherited = subAgent.scope?.length
    ? subAgent.scope
    : (subAgent.result?.scope?.length ? subAgent.result.scope : ['.']);
  if (!inheritsWholeGraph(inherited)) return inherited;
  if (ROLE_ANNOTATION_SCOPE[subAgent.role]) return ROLE_ANNOTATION_SCOPE[subAgent.role];
  return deriveRootScopedAnnotationScope(subAgent);
}

export function annotationSyncTask(subAgent, scope, criteria = []) {
  const files = (subAgent.result?.filesChanged ?? []).map((f) => `- ${f}`).join('\n') || '- (none reported)';
  const nodes = (subAgent.result?.graphNodesTouched ?? []).map((n) => `- ${n}`).join('\n') || '- (none reported)';
  // Criteria → invariants bridge (write side): behavior contracts this run decided
  // and verification covered belong in the owning module's structured
  // `invariants` — the field the graph-obligations channel delivers to future
  // runs. CURATION, not accumulation: the invariant set reflects the CURRENT
  // contract state.
  const criteriaSection = criteria.length
    ? [
      '',
      'Behavior contracts decided in this run (acceptance criteria):',
      ...criteria.map((c) => `- ${c.statement ?? c}`),
      'For the ones your scope OWNS, curate the owning module\'s `invariants`: rewrite the set to the current contract state — behavior contracts go into invariants (not summary prose); no duplicates; drop invariants the code no longer honors.',
    ]
    : [];
  return [
    `Post-review annotation sync for the already-approved ${subAgent.role} sub-agent.`,
    'Do not edit application code, configs, tests, Dockerfiles, package manifests, or docs.',
    'Use the current provider session context plus the current repovine graph to write annotations only.',
    `repovine annotation scope for this sub-agent: ${JSON.stringify(scope)}. Annotate only nodes in this scope — do not drain backend/frontend code modules from a sibling sub-agent.`,
    'Run refresh_context, inspect/get_annotation_status({ "view": "queue" }) for this scope and the nodes/files below, write_annotation to detailed tier, then refresh_context({ "cleanupOrphans": true }) and validate_annotations hard checks. Drain the queue to needsWork:0 in scope (content-stale before propagation-stale; propagation-stale is in needsWork).',
    'A domain roll-up in the queue went stale because a member moved, not because its own text did — the member can be a runtime resource, not only a module. Take the members first: a roll-up rewritten before them is stale again by the end of the pass.',
    'Emit an annotation-only AgentRunResult with filesChanged: [], contractsChanged: [], and annotationsWritten containing the canonical node ids you wrote.',
    ...criteriaSection,
    '',
    'Prior sub-agent filesChanged:',
    files,
    '',
    'Prior sub-agent graphNodesTouched:',
    nodes,
  ].join('\n');
}

/**
 * Group sync targets by their DERIVED scope: N delivered sub-agents draining the
 * same scope (three runtime fixers over [backend, frontend]) get ONE sync
 * sub-agent, not one each — the queue is shared, so per-target syncs duplicate
 * cost and leave honest-but-useless "not yet clean" reds on the earlier passes.
 * The merged view unions filesChanged/graphNodesTouched so the sync task text
 * covers every member's work; role/instance come from the first member.
 */
export function groupAnnotationSyncTargets(targets, deriveScope) {
  const groups = [];
  const byScope = new Map();
  for (const target of targets) {
    const scope = deriveScope(target);
    const key = [...scope].map(String).sort().join('|');
    const existing = byScope.get(key);
    if (existing) {
      existing.members.push(target);
      continue;
    }
    const group = { scope, members: [target] };
    byScope.set(key, group);
    groups.push(group);
  }
  return groups.map(({ scope, members }) => {
    const primary = members[0];
    if (members.length === 1) return { scope, subAgent: primary };
    return {
      scope,
      subAgent: {
        ...primary,
        result: {
          ...primary.result,
          filesChanged: [...new Set(members.flatMap((m) => m.result?.filesChanged ?? []))],
          graphNodesTouched: [...new Set(members.flatMap((m) => m.result?.graphNodesTouched ?? []))],
        },
      },
    };
  });
}

async function runPostReviewAnnotationSync({ task, repoRoot, provider, subAgents, handoffs, signal, priorSessions, onSession, greenfieldRun, criteria = [] }) {
  if (!postReviewAnnotationsEnabled() || signal?.aborted) return [];
  const targets = annotationSyncTargets(subAgents);
  if (!targets.length) return [];

  // Serialize annotation-sync — one writer at a time, NEVER Promise.all. Even though targets have
  // disjoint code scopes, every write_annotation goes through the one shared repovine.annots.json
  // store; concurrent writers gain no throughput (the MCP server serializes them) and can race the
  // store's debounced save/merge. This sequential for-await loop is load-bearing — do not parallelize
  // annotation-sync the way implementer stages fan out via runStageWorktrees.
  const out = [];
  for (const { scope, subAgent } of groupAnnotationSyncTargets(targets, deriveAnnotationSyncScope)) {
    if (signal?.aborted) break;
    const instance = subAgent.instanceId || subAgent.role;
    const spec = {
      ...resolveRole(subAgent.role, repoRoot, {
        scope,
        // Built-in manifest NAME (repovine agents manifests) — it requires annotationsWritten,
        // so a sync subAgent that writes nothing is rejected instead of passing quietly.
        manifest: 'repovine-annotation-writer',
        task: annotationSyncTask(subAgent, scope, criteria),
      }),
      instanceId: `${instance}-annotations`,
      contextPhase: 'annotate',
      modelRole: 'ask',
    };
    log(`annotation-sync sub-agent (${instance})`);
    const syncSubAgent = await runSubAgent({
      parentTask: task,
      spec,
      repoRoot,
      provider,
      priorHandoffs: handoffs,
      signal,
      resume: priorSessions?.[subAgent.role],
      onSession,
      telemetryRoot: repoRoot,
      greenfieldRun,
    });
    out.push(syncSubAgent);
    handoffs.push(syncSubAgent.handoff);
  }
  return out;
}

/** Harness tree-diff section for a review subAgent's task: the review reads the observed diff, not subAgent self-reports. */
function reviewTreeDiffSection(repoRoot, baselineTree) {
  const current = captureWorkspaceRevision(repoRoot, { backend: REVISION_BACKEND });
  const files = baselineTree && current ? diffChangedFiles(baselineTree, current) : null;
  if (!Array.isArray(files)) {
    return [
      '',
      '## Harness tree-diff (authoritative changed files)',
      '- capture unavailable — fail closed: treat the change set as unknown and review the workspace broadly.',
    ].join('\n');
  }
  return [
    '',
    '## Harness tree-diff (authoritative changed files)',
    'Harness-observed change set since the run baseline (git tree diff; repovine artifacts excluded).',
    'Review THESE files and their contracts; subAgent self-reported filesChanged is a hint, not the source of truth.',
    ...(files.length ? files.map((f) => `- ${f}`) : ['- (no changed files observed)']),
  ].join('\n');
}

/**
 * Materialize a review spec's task with the tree-diff section appended, and pin
 * the custody diff base on the spec — runSubAgent forces `review.reviewedDiffBase`
 * to it BEFORE compliance, so validation never evaluates a model-invented base.
 */
function runtimeModeReviewNote(repoRoot) {
  // When the harness runs install+build+test itself, the sealed-mode reviewer prose
  // ("operator must run npm install") is stale: an empty node_modules is not a
  // blocker. Data-plane note, not a brief edit — prose adherence is probabilistic.
  if (!runtimeRequired(repoRoot)) return '';
  return [
    '',
    '## Runtime note (HARNESS_RUNTIME_CHECK on)',
    'The harness runs `npm install`, `npm run build`, and `npm test` after this review.',
    'Do NOT block on an empty node_modules or unbuilt dist — dependency/build/test',
    'execution is the harness runtime phase\'s job, verified there. Review source, contracts, and the tree-diff.',
  ].join('\n');
}

function withReviewTreeDiff(spec, parentTask, repoRoot, baselineTree) {
  if (spec.role !== 'review') return spec;
  return {
    ...spec,
    task: `${spec.task ?? parentTask.task}\n${reviewTreeDiffSection(repoRoot, baselineTree)}${runtimeModeReviewNote(repoRoot)}`,
    // spec.reviewDiffBase stays a STRING (sub-agent.mjs forces it into
    // review.reviewedDiffBase, where the protocol schema types it as a plain string
    // and compliance never reads the value).
    ...(baselineTree ? { reviewDiffBase: baselineTree.digest } : {}),
  };
}

/**
 * Harness custody right after a full review subAgent: capture the tree the reviewer
 * actually saw (`reviewedRevision`, drives freshness) and force the diff base the
 * harness delivered — `review.reviewedDiffBase` is never trusted from the model.
 * A review that shared its stage with other subAgents gets NO reviewedRevision: the
 * post-stage tree folds sibling edits the reviewer never saw (worktree merge or
 * later-in-stage sequential runs), so freshness fails closed instead of blessing
 * an unseen tree. The forced diff base is re-persisted so the on-disk subAgent
 * result agrees with the in-memory acceptance state. Applies to every full
 * review, including the post-fix re-review that owns acceptance after a fix.
 */
export function markReviewedRevision(subAgent, repoRoot, baselineTree, { soleInStage = true } = {}) {
  if (subAgent.role !== 'review') return;
  if (!soleInStage) {
    subAgent.reviewedRevision = null;
    log('review shared its stage with sibling subAgents — reviewedRevision withheld (freshness fails closed)');
    return;
  }
  subAgent.reviewedRevision = captureWorkspaceRevision(repoRoot, { backend: REVISION_BACKEND });
  // reviewedRevision is the in-memory revision OBJECT; the persisted diff base stays a
  // digest STRING — the protocol schema types it as a plain string and compliance never
  // reads the value.
  subAgent.reviewedDiffBase = baselineTree?.digest ?? null;
  if (baselineTree && subAgent.result?.review && typeof subAgent.result.review === 'object') {
    subAgent.result.review.reviewedDiffBase = baselineTree.digest;
    if (subAgent.resultFile) {
      try {
        writeJsonFile(subAgent.resultFile, subAgent.result);
      } catch {
        /* custody re-persist is best-effort — acceptance reads the in-memory subAgent */
      }
    }
  }
}

/** Run one stage sequentially in the shared sandbox. */
async function runStageSequential(stage, { task, repoRoot, provider, priorHandoffs, signal, priorSessions, onSession, greenfieldRun }) {
  const out = [];
  for (const spec of stage) {
    if (signal?.aborted) break;
    out.push(await runSubAgent({
      parentTask: task, spec, repoRoot, provider, priorHandoffs, signal,
      resume: priorSessions?.[spec.role], onSession, telemetryRoot: repoRoot, greenfieldRun,
    }));
  }
  return out;
}

/** Run one stage in parallel, each sub-agent isolated in a git worktree, merged after. */
async function runStageWorktrees(stage, { task, repoRoot, provider, priorHandoffs, signal, priorSessions, onSession, greenfieldRun }) {
  // Fold any uncommitted working-tree changes from a prior sequential stage into HEAD
  // so each worktree branches off the latest state and merge-back does not clobber it.
  commitWorktree(repoRoot, 'harness: fold pre-worktree-stage state');
  const runs = stage.map((spec) => ({ spec, wt: addWorktree(repoRoot, spec.role) }));
  try {
    // Fan out concurrently; each sub-agent validates against its own worktree.
    // Session continuity is severed across the worktree boundary BY CONSTRUCTION:
    // provider sessions are namespaced by their cwd, so a sandbox-born session cannot
    // be resumed from a worktree and a worktree-born session cannot be resumed from
    // the sandbox (observed live: every post-parallel annotation-sync resume died in
    // ~2 s with zero tokens). Fresh sessions in, no session capture out; intra-run
    // retries still resume within the same worktree cwd.
    const ran = await Promise.all(
      runs.map(async ({ spec, wt }) => {
        const root = wt?.dir || repoRoot;
        const subAgent = await runSubAgent({
          parentTask: task, spec, repoRoot: root, provider, priorHandoffs, signal,
          resume: wt ? undefined : priorSessions?.[spec.role],
          onSession: wt ? undefined : onSession,
          telemetryRoot: repoRoot, greenfieldRun,
        });
        if (wt) commitWorktree(wt.dir, `${spec.role}: ${subAgent.result?.summary || 'no-op'}`);
        return { subAgent, wt };
      }),
    );
    // Merge branches back sequentially; a conflict aborts that merge and is recorded.
    const out = [];
    for (const { subAgent, wt } of ran) {
      if (wt) {
        const m = mergeWorktree(repoRoot, wt.branch);
        subAgent.merge = m;
        if (!m.ok) {
          subAgent.ok = false;
          subAgent.handoff.blockers = [...(subAgent.handoff.blockers || []), `merge ${m.conflict ? 'conflict' : 'failed'} on ${wt.branch}`];
          log(`merge ${m.conflict ? 'conflict' : 'failed'}: ${wt.branch}`);
        }
      }
      out.push(subAgent);
    }
    return out;
  } finally {
    // Always run, even if a sub-agent threw mid-fan-out: preserve each subAgent's .harness
    // ledger into the durable sandbox, then remove the worktree + temp branch so neither
    // dirs nor branches leak.
    for (const { wt } of runs) {
      if (!wt) continue;
      preserveWorktreeArtifacts(wt.dir, repoRoot);
      removeWorktree(repoRoot, wt.dir, wt.branch);
    }
  }
}

/**
 * Derive the run's gate signals and process/goal status from observable
 * primitives. Pure over its inputs plus the workspace (one tree capture, the
 * test-floor filesystem scan): captures `currentTree`, computes the
 * baseline..current diff, the runtime/verification tri-states, the grounded
 * test floor, and review freshness + acceptance. The `signals` block is
 * persisted into summary.json — demo semantics, not Agent Protocol fields.
 */
/**
 * Grade plan-quality findings against the episode end state. Findings are
 * timestamped predictions — they are never rewritten, only reconciled here.
 * Drop-class findings (critic `drop`, deterministic over-plan advisories) grade
 * deterministically: the flagged role ending idle confirms the finding; delivered
 * surviving work refutes it. Other actions (add/rescope/retask) need fuzzy
 * claim↔blocker matching and stay `ungradable` — recorded, never guessed.
 */
export function gradePlanFindings({ planReview = null, overPlanAdvisories = [], subAgents = [], idleImplementers = [] } = {}) {
  const idle = new Set(idleImplementers);
  const byKey = new Map(subAgents.map((l) => [l.instanceId || l.role, l]));
  const byRole = new Map();
  for (const l of subAgents) if (!byRole.has(l.role)) byRole.set(l.role, l);
  const gradeDrop = (roleKey) => {
    const subAgent = byKey.get(roleKey) ?? byRole.get(roleKey);
    if (!subAgent) return 'ungradable'; // flagged role never ran
    if (idle.has(subAgent.instanceId || subAgent.role)) return 'confirmed';
    if (subAgent.ok && (subAgent.result?.filesChanged ?? []).length) return 'refuted';
    return 'ungradable'; // blocked/failed says nothing about plan width
  };
  const out = [];
  for (const role of overPlanAdvisories) {
    out.push({ source: 'advisory', role, action: 'drop', outcome: gradeDrop(role) });
  }
  for (const r of planReview?.revisions ?? []) {
    out.push({
      source: 'critic',
      role: r.role,
      action: r.action,
      outcome: r.action === 'drop' ? gradeDrop(r.role) : 'ungradable',
    });
  }
  return out;
}

export function deriveMultiRunStatus({
  repoRoot,
  allSubAgents,
  subAgents,
  fixSubAgent = null,
  runtimeCheck = null,
  verifySubAgent = null,
  acceptanceCriteria = [],
  repovineOrientTrail = null,
  baselineTree = null,
  reviewRequired = false,
  greenfield = false,
  annotationHealth = null,
  planReview = null,
  overPlanAdvisories = [],
}) {
  // Post-mutation workspace revision → the run's authoritative changed-file set.
  // null revision/diff = capture failed = no clean-diff claim (fail-closed).
  const currentTree = captureWorkspaceRevision(repoRoot, { backend: REVISION_BACKEND });
  const changedFiles = baselineTree && currentTree ? diffChangedFiles(baselineTree, currentTree) : null;

  const runtimeReq = runtimeRequired(repoRoot);
  const runtimeStatus = runtimeStatusOf(runtimeCheck, runtimeReq);
  const runtimeAccepted = runtimeAcceptedOf(runtimeCheck, runtimeReq);
  const verificationReq = repovineProcessEnabled()
    && ((acceptanceCriteria?.length ?? 0) > 0 || (repovineOrientTrail?.graphNodes?.length ?? 0) > 0);
  // Deterministic floors: a require-tests scope with no test source file, or a
  // declared file reference whose target does not exist, is a verification
  // blocker — it closes verificationAccepted, hence goalOk.
  const testFloorBlockers = missingTestFloorBlockers(repoRoot, subAgents);
  const artifactFloorBlockers = missingReferencedArtifacts(repoRoot);
  // A verify sub-agent rejected ONLY for a weak context session, with its verdict
  // delivered (deliveryVerification), counts as a delivered verification: the
  // verification axis judges the verdict. The engine emits that rejection as a
  // compliance error only behind a context-quality hard gate that is currently off, so
  // a weak session reaches compliance as a warning and the csq branch reads false on
  // every real report; it takes effect when the gate turns on.
  //
  // The delivery verdict is itself the verification axis: a verify sub-agent that RAN
  // cleanly but reported a required-criterion gap (or emitted no deliveryVerification)
  // is process-clean, goal-failed. deliveryVerificationAccepted is fail-closed.
  const verifyRawOk = Boolean(verifySubAgent && (verifySubAgent.ok || subAgentCsqOnlyDelivered(verifySubAgent)));
  const verdictAccepted = deliveryVerificationAccepted(verifySubAgent?.result?.deliveryVerification, acceptanceCriteria);
  const verifyEffective = verifySubAgent
    ? { ...verifySubAgent, ok: verifyRawOk && verdictAccepted }
    : verifySubAgent;
  const verificationStatus = verificationStatusOf(verifyEffective, verificationReq);
  const verificationAccepted = verificationAcceptedOf(verifyEffective, verificationReq)
    && testFloorBlockers.length === 0
    && artifactFloorBlockers.length === 0;
  const acceptanceReview = findAcceptanceReviewSubAgent(subAgents);
  const reviewFresh = reviewIsFresh({
    repoRoot,
    reviewedRevision: acceptanceReview?.reviewedRevision,
    currentTree,
    excludePaths: runtimeCheck?.harnessMutatedPaths ?? [],
  });
  const reviewValid = reviewRequired ? reviewProcessValid(acceptanceReview, { fresh: reviewFresh }) : null;
  const reviewAccepted = reviewRequired ? reviewAcceptedOf(acceptanceReview, { fresh: reviewFresh }) : null;

  const processOk =
    allSubAgents.length > 0
    && repovineProcessRunOk({
      subAgents: allSubAgents,
      runtimeCheck,
      reviewGateOpen: reviewGateIsOpen(subAgents, fixSubAgent),
      greenfield,
    });
  const goalOk = repovineGoalOk({
    subAgents: allSubAgents,
    runtimeCheck,
    signals: { runtimeAccepted, verificationAccepted, reviewRequired, reviewAccepted },
  });
  // Implement-phase sub-agents that completed ok with zero delivered files —
  // shared by the idle-telemetry signal and the plan-finding grader.
  const idleImplementers = allSubAgents
    .filter((l) => !['review', 'repo-explorer'].includes(l.role)
      && !(l.instanceId ?? '').endsWith('-annotations')
      && l.ok && l.result?.status === 'complete'
      && !(l.result?.filesChanged ?? []).length)
    .map((l) => l.instanceId || l.role);
  const signals = {
    runSucceeded: Boolean(processOk && goalOk),
    processOk,
    goalOk,
    runtimeRequired: runtimeReq,
    runtimeStatus,
    runtimeAccepted,
    verificationRequired: verificationReq,
    verificationStatus,
    verificationAccepted,
    testFloorBlockers,
    artifactFloorBlockers,
    // Delivered subAgents rejected ONLY for a weak context session — advisory
    // (yellow) in the reply, forgiven by the run gate, listed here. Empty while the
    // context-quality hard gate is off: a weak session reaches compliance as a warning.
    contextQualityRejections: subAgents.filter(subAgentCsqOnlyDelivered).map((l) => l.instanceId || l.role),
    // Over-plan tax telemetry: implement-phase sub-agents that completed ok with
    // zero delivered files ("already correct" verdicts) — planner width probes.
    idleImplementers,
    // Plan-quality findings reconciled against the episode end state (see
    // gradePlanFindings): confirmed / refuted / ungradable per finding.
    planReviewOutcomes: gradePlanFindings({ planReview, overPlanAdvisories, subAgents: allSubAgents, idleImplementers }),
    // End-state annotation debt after the join cleanup: { needsWork, clean } or null
    // (unknown). Drives the reply's annotation-sync severity — a sub-agent that did
    // not converge alone is not run debt once a later sweep clears its residual.
    annotationHealth,
    reviewRequired,
    reviewProcessValid: reviewValid,
    reviewAccepted,
    treeDiff: {
      captured: Boolean(baselineTree && currentTree && Array.isArray(changedFiles)),
      // Persisted telemetry stores the digest projection, never revision objects
      // (a filesystem manifest must not leak per-file hashes into summary.json).
      backend: baselineTree?.backend ?? REVISION_BACKEND,
      baselineTree: baselineTree?.digest ?? null,
      currentTree: currentTree?.digest ?? null,
      changedFiles: Array.isArray(changedFiles) ? changedFiles : null,
    },
  };
  return { processOk, goalOk, signals };
}

/**
 * Worktree fan-out decision. Git execution requires the target policy to allow
 * Git operations — attach returns false BEFORE any Git probe or `ensureGitRepo`
 * init runs, so no environment override can point Git at a guarded workspace.
 */
export function useWorktreeExecution({ greenfield, hasBatch, gitOperationsAllowed, ensureRepo }) {
  if (!greenfield || !hasBatch) return false;
  if (gitOperationsAllowed !== true) return false;
  return Boolean(ensureRepo());
}

export async function multiAgent(state, config) {
  const { task, repoRoot, llmProvider: provider } = state;
  // Capabilities come from targetPolicy over the graph-threaded targetMode —
  // never from an environment variable. Since Phase 2 the policy carries
  // { resetAllowed, gitOperationsAllowed }; custody is git-tree in both modes.
  const policy = targetPolicy(state.targetMode ?? 'sandbox');
  // /stop signal (from the channel via invoke config): stop scheduling new sub-agents.
  const signal = config?.signal || config?.configurable?.signal;

  // Resume each sub-agent's provider conversation within ONE graph invoke (compliance
  // retries, implement → annotation-sync). Cross-/task sessions are always fresh
  // (intake sets workerSessions: {}).
  const priorSessions = state.workerSessions || {};
  const liveSessions = { ...priorSessions };
  const shared = config?.configurable?.capture;
  const onSession = (role, sid) => {
    liveSessions[role] = sid;
    if (shared) (shared.sessions ??= {})[role] = sid;
  };

  let workingTask = task;
  let repovineOrientTrail = null;
  let acceptanceCriteria = [];
  let greenfield = false;
  const processSubAgents = [];
  const subAgents = [];
  const handoffs = [];

  if (repovineProcessEnabled() && !signal?.aborted) {
    const orient = await runOrientPhase({
      task: workingTask,
      repoRoot,
      provider,
      signal,
      priorSessions: liveSessions,
      onSession,
    });
    processSubAgents.push(orient.subAgent);
    // Orient's criteria contracts enter the handoff LEDGER — the one channel that
    // survives spec.task overrides and provider resume. Without this, criteria ride
    // only as task prose and vanish for planner-authored subAgents.
    if (orient.subAgent.handoff) handoffs.push(orient.subAgent.handoff);
    repovineOrientTrail = orient.trail;
    acceptanceCriteria = orient.criteria;
    greenfield = orient.greenfield ?? false;
    workingTask = orient.enrichedTask;
    if (!signal?.aborted && orient.subAgent.ok) {
      refreshGraph(repoRoot, workingTask, 'after repovine orient');
      log('refresh barrier after repovine orient');
    }
  }

  // planMode is the decomposition mode (explicit | keyword | auto | single | greenfield-single); do NOT
  // return it as `mode` — that channel is the graph routing mode ('multi') set by
  // intake, and clobbering it would break compose_reply's multi-agent rendering.
  const planStartedAtMs = Date.now();
  const { mode: planMode, specs: plannedSpecs, droppedAnnotationRoles } = await planSubAgentsAsync(workingTask, repoRoot, provider);
  // Give same-role sub-agents unique instanceIds so their .harness files + context sessions
  // don't collide (e.g. two annotation-writer sub-agents for frontend vs backend).
  const specs = assignSubAgentInstanceIds(plannedSpecs);
  const stages = applyGreenfieldParallelStages(scheduleStages(specs), {
    greenfield,
    planMode,
    gitOperationsAllowed: policy.gitOperationsAllowed,
  });
  log(`plan=${planMode} sub-agents=[${specs.map((s) => s.role).join(', ')}] stages=${stages.map((s) => s.map((x) => x.role).join('+')).join(' → ')}`);
  // Over-plan advisory (deterministic, continuation only): implement roles with zero
  // orient grounding in scope. Advisory — logged + recorded for precision telemetry;
  // nothing is dropped.
  const overPlanAdvisories = overPlannedRoles(specs, workingTask.repovineOrient, { greenfield });
  if (overPlanAdvisories.length) {
    log(`plan advisory: no orient evidence in scope for [${overPlanAdvisories.join(', ')}] — possible over-plan`);
  }
  // Bounded LLM plan review (HARNESS_PLAN_REVIEW=1, advisory): one call, findings
  // must cite a claim/node (uncited ones are discarded in parse). No veto until
  // telemetry proves precision. Lazy import keeps the offline path dependency-free.
  let planReview = null;
  if (process.env.HARNESS_PLAN_REVIEW === '1' && !signal?.aborted) {
    const { reviewPlanWithLLM } = await import('./planner.mjs');
    planReview = await reviewPlanWithLLM(workingTask, specs, provider);
  }
  recordRunEvent(repoRoot, {
    event: 'plan_finished',
    runId: task.id,
    planMode,
    subAgentCount: specs.length,
    stages: stages.map((s) => s.map((x) => x.role)),
    // Observability: whether the annotate-stage strip fired (planner proposed
    // annotation roles) or the plan was already clean — invisible otherwise.
    ...(droppedAnnotationRoles?.length ? { droppedAnnotationRoles } : {}),
    ...(overPlanAdvisories.length ? { overPlanAdvisories } : {}),
    ...(planReview ? { planReview } : {}),
    durationMs: Date.now() - planStartedAtMs,
  });

  // Decide execution: worktree-parallel is a GREENFIELD-ONLY property (orient-confirmed
  // new project, batch present, git usable). Continuation always runs sequentially and
  // no override exists — the inter-stage refresh barrier is the contract-propagation
  // channel, and parallel execution would sever it. Sequential is always correct.
  const hasBatch = stages.some((s) => s.length > 1);
  const useWorktrees = useWorktreeExecution({
    greenfield,
    hasBatch,
    gitOperationsAllowed: policy.gitOperationsAllowed,
    ensureRepo: () => gitAvailable(repoRoot) && ensureGitRepo(repoRoot),
  });
  if (greenfield && hasBatch && !useWorktrees) {
    log(policy.gitOperationsAllowed
      ? 'greenfield parallel: git unavailable — falling back to sequential'
      : 'greenfield parallel: disabled by target policy (attach) — sequential stages, barriers preserved');
  }

  // A review is required when the task asks for one or the planner scheduled one.
  const reviewRequired = wantReview(task) || specs.some((s) => s.role === 'review');
  // Pre-implementation workspace revision. baselineTree..currentTree is the
  // authoritative run diff for filesChanged and review freshness; a failed capture
  // means the run does not claim a clean diff (fail-closed), never a subAgent-union fallback.
  const baselineTree = captureWorkspaceRevision(repoRoot, { backend: REVISION_BACKEND });
  if (!baselineTree) log('workspace revision capture unavailable — run will not claim a clean diff (fail-closed)');
  // Run-start annotation snapshot: verify obligations must reflect PRIOR runs'
  // contracts even if a sub-agent writes annotations mid-run.
  const baselineAnnotations = readAnnotationsSnapshot(repoRoot);

  for (let i = 0; i < stages.length; i += 1) {
    if (signal?.aborted) { log('stopped — skipping remaining stages'); break; }
    // Review subAgents get the harness tree-diff appended at dispatch time (post prior stages).
    const stage = stages[i].map((spec) => withReviewTreeDiff(spec, workingTask, repoRoot, baselineTree));
    const ctx = { task: workingTask, repoRoot, provider, priorHandoffs: handoffs, signal, priorSessions: liveSessions, onSession, greenfieldRun: greenfield };
    const stageSubAgents =
      useWorktrees && stage.length > 1
        ? await runStageWorktrees(stage, ctx)
        : await runStageSequential(stage, ctx);
    for (const subAgent of stageSubAgents) {
      markReviewedRevision(subAgent, repoRoot, baselineTree, { soleInStage: stageSubAgents.length === 1 });
    }
    subAgents.push(...stageSubAgents);
    handoffs.push(...stageSubAgents.map((l) => l.handoff));

    // refresh barrier between stages so the next phase's sub-agents see these edits.
    if (!signal?.aborted && (i < stages.length - 1 || wantReview(task))) {
      refreshGraph(repoRoot, task, `after stage ${i + 1}/${stages.length}`);
      log(`refresh barrier after stage ${i + 1}/${stages.length}`);
    }
  }

  // Optional read-only review sub-agent when the task asks for it and the planner did not already include one.
  if (wantReview(task) && !signal?.aborted && !specs.some((s) => s.role === 'review')) {
    const spec = withReviewTreeDiff(resolveRole('review', repoRoot), workingTask, repoRoot, baselineTree);
    log('review sub-agent (explicit)');
    const reviewSubAgent = await runSubAgent({
      parentTask: workingTask, spec, repoRoot, provider, priorHandoffs: handoffs, signal,
      resume: liveSessions?.[spec.role], onSession, telemetryRoot: repoRoot, greenfieldRun: greenfield,
    });
    markReviewedRevision(reviewSubAgent, repoRoot, baselineTree);
    subAgents.push(reviewSubAgent);
    handoffs.push(reviewSubAgent.handoff);
  }

  const reviewSubAgent = findLastReviewSubAgent(subAgents);
  let fixSubAgent = null;
  // Deterministic harness blockers join the fix ledger: the grounded test floor
  // and the referenced-artifact floor get their fix transition even when NO
  // review subAgent exists — otherwise a deterministic gap silently closes
  // goalOk with no subAgent ever told.
  const preFixFloorBlockers = [
    ...missingTestFloorBlockers(repoRoot, subAgents),
    ...missingReferencedArtifacts(repoRoot),
  ];
  if ((reviewSubAgent || preFixFloorBlockers.length) && reviewFixEnabled() && !signal?.aborted) {
    fixSubAgent = await maybeRunReviewFix({
      task: workingTask, repoRoot, provider, reviewSubAgent, handoffs, signal, priorSessions: liveSessions,
      onSession, greenfieldRun: greenfield, extraBlockers: preFixFloorBlockers,
    });
    if (fixSubAgent) {
      subAgents.push(fixSubAgent);
      handoffs.push(fixSubAgent.handoff);
      if (!signal?.aborted && fixSubAgentDelivered(fixSubAgent)) {
        refreshGraph(repoRoot, task, 'after review-fix');
        log('refresh barrier after review-fix');
      }
    }
  }

  let runtimeCheck = null;
  if (!signal?.aborted && reviewGateIsOpen(subAgents, fixSubAgent)) {
    runtimeCheck = await runRuntimeCheckPhase({
      task: workingTask, repoRoot, provider, subAgents, handoffs, signal,
      priorSessions: liveSessions, onSession, greenfieldRun: greenfield,
    });
  }

  let verifySubAgent = null;
  // Verify runs on an OPEN review gate regardless of runtime_check: it is read-only and
  // its delivery verdict is the verification axis, separate from the build/test axis. A
  // failed runtime still fails the goal (runtimeAccepted feeds goalOk independently), but
  // the criteria verdict stays visible instead of being skipped whenever generated tests
  // break. The post-review annotation sync below stays runtime-gated — it mutates durable
  // graph memory and must not write a broken tree.
  if (!signal?.aborted && reviewGateIsOpen(subAgents, fixSubAgent) && repovineProcessEnabled()) {
    const implementSubAgents = subAgents.filter(
      (l) => l.role === 'backend' || l.role === 'frontend' || l.role === 'infra' || l.role === 'default',
    );
    // Prior-run contracts on the touched modules, read from the RUN-START
    // annotation snapshot — mid-run writes cannot rewrite the memory verify
    // is about to check against. Verification stops depending on the current
    // orient having re-declared every interaction.
    const touchedNodeIds = [...new Set(implementSubAgents.flatMap((l) => l.result?.graphNodesTouched ?? []))];
    const graphObligations = collectAnnotationObligations(repoRoot, touchedNodeIds, { snapshot: baselineAnnotations });
    verifySubAgent = await runVerifyClaimsPhase({
      task: workingTask,
      repoRoot,
      provider,
      criteria: acceptanceCriteria,
      orientTrail: repovineOrientTrail,
      implementSubAgents,
      handoffs,
      signal,
      priorSessions: liveSessions,
      onSession,
      greenfieldRun: greenfield,
      // Verify judges the OBSERVED change set, not implementer self-reports.
      treeDiffSection: reviewTreeDiffSection(repoRoot, baselineTree),
      graphObligationsSection: obligationsSection(graphObligations),
    });
    if (verifySubAgent) {
      processSubAgents.push(verifySubAgent);
      handoffs.push(verifySubAgent.handoff);
      // The verifier's deliveryVerification rides on verifySubAgent.result: the gate
      // reads it in deriveMultiRunStatus, and the card/telemetry read it off the verify
      // sub-agent record. No write-back onto the criteria set.
    }
  }

  // Bounded generic re-review AFTER runtime(+fix) and verify: when the acceptance
  // verdict went stale (a review-fix or runtime-fix mutated the tree), ONE full
  // re-review against the stabilized tree re-earns (or re-denies) acceptance —
  // for any blocker class. A still-fresh verdict stands; a closed review gate
  // (unfixed blockers) keeps the standing changes-requested verdict.
  if (!signal?.aborted && postFixReviewEnabled() && reviewGateIsOpen(subAgents, fixSubAgent)) {
    const acceptance = findAcceptanceReviewSubAgent(subAgents);
    if (acceptance) {
      const staleNow = !reviewIsFresh({
        reviewedRevision: acceptance.reviewedRevision,
        currentTree: captureWorkspaceRevision(repoRoot, { backend: REVISION_BACKEND }),
        excludePaths: runtimeCheck?.harnessMutatedPaths ?? [],
      });
      if (staleNow) {
        const reReviewSubAgent = await maybeRunPostFixReview({
          task: workingTask, repoRoot, provider, handoffs, signal, priorSessions: liveSessions,
          onSession, greenfieldRun: greenfield, baselineTree,
          // The blockers the re-review re-judges are delivered EXPLICITLY — the
          // handoff section renders contracts/summaries, never blockers.
          priorBlockers: assembleFixBlockers(acceptance, preFixFloorBlockers),
        });
        if (reReviewSubAgent) {
          subAgents.push(reReviewSubAgent);
          handoffs.push(reReviewSubAgent.handoff);
        }
      }
    }
  }

  if (!signal?.aborted && postReviewGatesPassed(subAgents, fixSubAgent, runtimeCheck)) {
    refreshGraph(repoRoot, task, 'before post-review annotation sync');
    log('refresh barrier before post-review annotation sync');
    const annotationSubAgents = await runPostReviewAnnotationSync({
      task: workingTask,
      repoRoot,
      provider,
      subAgents,
      handoffs,
      signal,
      priorSessions: liveSessions,
      onSession,
      greenfieldRun: greenfield,
      // Write side of the criteria↔graph bridge: verified behavior contracts are
      // curated into the owning modules' `invariants` by the sync subAgents.
      criteria: acceptanceCriteria,
    });
    if (!annotationSubAgents.length) {
      logAnnotationSyncSkipped(repoRoot, task, 'no accepted sub-agent changed files');
    }
    subAgents.push(...annotationSubAgents);
  } else if (!signal?.aborted) {
    logAnnotationSyncSkipped(repoRoot, task, annotationSyncSkipReason(subAgents, fixSubAgent, runtimeCheck));
  }

  // Join barrier: final rebuild + orphan sweep so the graph is left clean for the
  // next task in this sandbox (sub-agents clean their own scope; this is the safety net).
  if (!signal?.aborted) {
    refreshGraph(repoRoot, task, 'join cleanup', { cleanupOrphans: true });
    log('join: refresh + orphan cleanup');
  }

  // End-state annotation debt, read off the just-rebuilt graph. Authoritative for
  // whether the run left annotation work undone — separate from whether each
  // annotation-sync sub-agent converged alone (a residual one leaves can be swept
  // by a later scope's sub-agent). null on abort / CLI-unavailable (unknown).
  const annotationHealth = signal?.aborted ? null : rp.annotationHealth(repoRoot);

  // Run-level usage rollup → one .harness file with the whole-/task cost + fresh/resume
  // split. Best-effort; written even on /stop so partial runs are still measured.
  const allSubAgents = [...processSubAgents, ...subAgents];
  const runUsage = writeRunUsage(task, repoRoot, allSubAgents);
  const runMcp = writeRunMcpUsage(task, repoRoot, allSubAgents);

  const { processOk, goalOk, signals } = deriveMultiRunStatus({
    repoRoot,
    allSubAgents,
    subAgents,
    fixSubAgent,
    runtimeCheck,
    verifySubAgent,
    acceptanceCriteria,
    repovineOrientTrail,
    baselineTree,
    reviewRequired,
    greenfield,
    annotationHealth,
    planReview,
    overPlanAdvisories,
  });
  for (const b of signals.testFloorBlockers) log(b);
  recordRunEvent(repoRoot, { event: 'run_signals', runId: task.id, signals });
  // role→sessionId from this run (intra-task only; intake clears on next /task).
  const workerSessions = collectSubAgentSessions(allSubAgents);
  return {
    mode: 'multi',
    planMode,
    subAgents: allSubAgents,
    ok: processOk,
    goalOk,
    processOk,
    signals,
    runtimeCheck,
    repovineOrientTrail,
    repovineCriteria: acceptanceCriteria,
    greenfield,
    usage: runUsage?.total ?? null,
    usageRollup: runUsage ?? null,
    mcpRollup: runMcp ?? null,
    execution: useWorktrees ? 'worktree-parallel' : 'sequential',
    workerSessions,
  };
}
