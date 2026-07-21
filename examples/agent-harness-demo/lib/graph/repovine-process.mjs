// Repovine-native harness process: orient → implement → verify-claims (no Playwright).
import fs from 'node:fs';
import { RUN_LEVEL, runLevelPath, subAgentAttemptResultPath, writeJsonFile } from '../harness-paths.mjs';
import { resolveRole } from '../agents.mjs';
import { runSubAgent } from './sub-agent.mjs';
import {
  buildOrientTrail,
  inferClaimsFromTask,
  mergeClaims,
  parseClaimsFromContracts,
} from '../claims.mjs';
import { recordRunEvent } from '../telemetry.mjs';
import { logLine } from '../log.mjs';
import { orientQuery } from '../repovine.mjs';
import { extractUserTask } from '../task-user.mjs';
import { subAgentGateEffectivelyOk } from '../blockers.mjs';
import { runtimeCheckPassed } from '../runtime-check.mjs';
import {
  hasOnlyStubAnnotations,
  isGreenfieldSandbox,
  isGreenfieldContext,
} from './workspace-state.mjs';

function uniqueRequestedChecks(checks = []) {
  return [...new Set(checks.filter(Boolean))];
}

function isAnnotationSyncSubAgent(subAgent) {
  return Boolean(subAgent?.instanceId?.endsWith('-annotations'));
}

export const ORIENT_INSTANCE_ID = 'orient';
export const VERIFY_INSTANCE_ID = 'verify';

/**
 * Read CLAIM: lines from the newest prior attempt of a sub-agent (attempt files
 * are 1-based; the accepted result is the last attempt). Returns [] when no
 * prior attempt carries claims. Read-only over run artifacts.
 */
export function recoverClaimContractsFromAttempts(repoRoot, subAgentKey, attemptsCount) {
  for (let attempt = attemptsCount - 1; attempt >= 1; attempt -= 1) {
    try {
      const file = subAgentAttemptResultPath(repoRoot, subAgentKey, attempt, { active: true });
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const lines = (parsed?.contractsChanged ?? []).filter((c) => /^CLAIM:/i.test(String(c)));
      if (lines.length) return lines;
    } catch {
      /* attempt artifact missing/corrupt — keep looking */
    }
  }
  return [];
}

const VERBOSE = process.env.GRAPH_VERBOSE !== '0';
const log = (msg) => logLine('repovine-process', msg, { enabled: VERBOSE, indent: '  ' });

/** Default on for multi-agent runs; set HARNESS_REPOVINE_PROCESS=0 to disable. */
export function repovineProcessEnabled() {
  const raw = process.env.HARNESS_REPOVINE_PROCESS;
  if (raw === undefined || raw === '') return true;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

export function isOrientSubAgent(subAgent) {
  return subAgent?.instanceId === ORIENT_INSTANCE_ID;
}

export function isVerifyClaimsSubAgent(subAgent) {
  return subAgent?.instanceId === VERIFY_INSTANCE_ID;
}

export function isRepovineSupportSubAgent(subAgent) {
  return isOrientSubAgent(subAgent) || isVerifyClaimsSubAgent(subAgent);
}

/** Core implement/review-fix/runtime-fix subAgents — gate run ok. Review subAgents
 *  (first review and the post-fix re-review) are judged by the review gate and
 *  acceptance instead: a reviewer that botched its own AgentRunResult fails the
 *  verdict, not the run's process. */
export function isRunGateSubAgent(subAgent) {
  if (!subAgent) return false;
  if (isRepovineSupportSubAgent(subAgent)) return false;
  if (isAnnotationSyncSubAgent(subAgent)) return false;
  if (subAgent.role === 'review') return false;
  return true;
}

export function orientTask(userTask, cliOrient = null, { greenfield = false } = {}) {
  const cliSection = cliOrient?.graphNodes?.length
    ? [
      '',
      '## CLI pre-orient (deterministic — validate or extend via MCP)',
      `- graphNodes: ${cliOrient.graphNodes.slice(0, 12).join(', ')}${cliOrient.graphNodes.length > 12 ? ' …' : ''}`,
      cliOrient.search?.summary ? `- search: ${cliOrient.search.summary}` : '',
      cliOrient.traceFlow?.summary ? `- trace (${cliOrient.traceScope}): ${cliOrient.traceFlow.summary}` : '',
      '- Emit CLAIM: lines in contractsChanged (one per claim).',
      '- Set compliance.flowChecked: true after you confirm trace_flow on touched scope.',
    ].filter(Boolean).join('\n')
    : '';
  const greenfieldSection = greenfield
    ? [
      '',
      '## New project (greenfield sandbox)',
      'No product code and/or empty repovine graph — expected after /reset.',
      '- graphNodesTouched may be [] when the graph is empty; that is honest, not a failure.',
      '- Emit CLAIM: lines from the user request; implement sub-agents will scaffold the app.',
      '- Set compliance.flowChecked: false when trace_flow has nothing meaningful to trace yet.',
      '- annotationsClean: false; do not write annotations during orient.',
    ].join('\n')
    : '';
  return [
    'Repovine orient phase (read-only): map the user request to graph nodes and flows.',
    'Do not edit any files. Use search_context → map_context → inspect_node → trace_flow.',
    'Emit structured handoff the implementer sub-agents need:',
    '- graphNodesTouched: canonical mod:/domain: ids you inspected (minimum 3 when graph is non-empty; [] ok when graph is empty)',
    '- contractsChanged: one string per claim prefixed with CLAIM: (plain language, what the user expects)',
    '- SHARPEN the request into decided claims: the user task may be one vague sentence — you own turning it into an unambiguous spec. For every ambiguity pick a sensible default and emit it as its OWN CLAIM: line: inverse/undo transitions (what un-doing an action does), empty/absent cases (entity with no children, empty list), defaults, and boundary behavior. Implementers follow your claims; the verifier checks exactly them — an undecided ambiguity becomes a review blocker later.',
    '- Sharpen PRODUCT BEHAVIOR only — never decide technology, framework, or architecture (client-side vs server-side, storage engine): the planner owns the stack. A CLAIM that pins a stack choice will conflict with the plan and read as a verification gap.',
    '- summary: one paragraph — graph path from entrypoint to persistence/SSE/client patch (or "greenfield — no product graph yet")',
    '- compliance.flowChecked: true after trace_flow on realtime/API scope when a graph exists',
    greenfieldSection,
    cliSection,
    '',
    'User request:',
    String(userTask ?? '').trim() || '(empty)',
  ].join('\n');
}

export function verifyClaimsTask({ claims = [], orientTrail = null, implementSummaries = [], treeDiffSection = '', graphObligationsSection = '' }) {
  const claimLines = claims.map((c) => `- [${c.id}] ${c.text}`).join('\n') || '- (none)';
  const nodes = (orientTrail?.graphNodes ?? []).map((n) => `- ${n}`).join('\n') || '- (none)';
  const impl = implementSummaries.filter(Boolean).join('\n\n') || '(none)';
  return [
    'Repovine verify-claims phase (read-only): check implementer work against orient scope and claims.',
    'Do not edit files. Use inspect_node, trace_flow, validate_annotations on touched scope.',
    'ANCHOR FIRST: inspect_node the orient graph nodes below before any free-text search — resolved anchors, not broad OR searches, pass the context-session gate on continuation runs.',
    'For each CLAIM, say covered or gap in contractsChanged as VERIFY: covered|gap — <claim id> — <reason>.',
    'Blockers only for clear contract violations (wrong nodes untouched, annotation invariants contradict claim).',
    'Do not run shell, npm test, or Playwright.',
    '',
    'Claims:',
    claimLines,
    '',
    'Orient graph nodes:',
    nodes,
    '',
    'Implementer summaries:',
    impl,
    treeDiffSection,
    graphObligationsSection,
  ].filter(Boolean).join('\n');
}

function writeOrientArtifact(repoRoot, runId, payload) {
  try {
    writeJsonFile(runLevelPath(repoRoot, runId, RUN_LEVEL.orient, { active: true }), payload);
  } catch {
    /* best-effort */
  }
}

/** Run repo-explorer orient subAgent; returns { subAgent, trail, claims, enrichedTask }. */
export async function runOrientPhase({
  task, repoRoot, provider, signal, priorSessions, onSession,
}) {
  log('orient sub-agent (repo-explorer)');
  recordRunEvent(repoRoot, { event: 'phase_started', runId: task.id, phase: 'repovine_orient' });
  const startedAtMs = Date.now();

  let cliOrient = null;
  const orientQueryText = extractUserTask(task);
  const greenfieldBeforeOrient = isGreenfieldSandbox(repoRoot) || hasOnlyStubAnnotations(repoRoot);
  try {
    const cliRes = orientQuery(repoRoot, orientQueryText);
    if (cliRes.json && !cliRes.json.error) cliOrient = cliRes.json;
  } catch {
    /* CLI pre-orient is best-effort */
  }

  const spec = {
    ...resolveRole('repo-explorer', repoRoot, {
      scope: ['.'],
      task: orientTask(orientQueryText, cliOrient, { greenfield: greenfieldBeforeOrient }),
    }),
    instanceId: ORIENT_INSTANCE_ID,
    contextPhase: 'explore',
    modelRole: 'ask',
  };

  const subAgent = await runSubAgent({
    parentTask: task,
    spec,
    repoRoot,
    provider,
    priorHandoffs: [],
    signal,
    resume: priorSessions?.['repo-explorer'],
    onSession,
    telemetryRoot: repoRoot,
    // Same greenfield exemption as every other subAgent: orient is the one subAgent that
    // RUNS BEFORE greenfield is derived, so it uses the pre-orient sandbox check.
    greenfieldRun: greenfieldBeforeOrient,
  });
  subAgent.orientQuery = orientQueryText;

  let claimContracts = (subAgent.result?.contractsChanged ?? []).filter((c) =>
    /^CLAIM:/i.test(String(c)),
  );
  // CSQ-retry payload loss: a retry that repairs the navigation funnel may not
  // re-emit the CLAIM lines the rejected attempt already carried (observed live:
  // 12 claims on attempt 1, 0 on the accepted attempt 2). Recover the newest
  // prior attempt's claims ONLY when the accepted result carries none — never a
  // union, so a revised/retracted claim set is left alone.
  if (claimContracts.length === 0) {
    const recovered = recoverClaimContractsFromAttempts(
      repoRoot,
      `${task.id}.${ORIENT_INSTANCE_ID}`,
      subAgent.attempts?.length ?? 1,
    );
    if (recovered.length) {
      log(`orient claims recovered from a rejected attempt (${recovered.length} CLAIM line(s))`);
      claimContracts = recovered;
    }
  }
  const claims = mergeClaims(
    parseClaimsFromContracts(claimContracts),
    inferClaimsFromTask(task),
  );
  const trail = buildOrientTrail(subAgent, claims);
  subAgent.orientTrail = trail;
  const greenfieldContext = isGreenfieldContext({ repoRoot, orientTrail: trail });
  subAgent.greenfield = greenfieldContext;
  if (cliOrient?.graphNodes?.length) {
    trail.graphNodes = [...new Set([...trail.graphNodes, ...cliOrient.graphNodes])];
    trail.cliPreOrient = {
      flowChecked: cliOrient.flowChecked,
      traceScope: cliOrient.traceScope,
      mcpTools: cliOrient.mcpTools,
    };
  }
  writeOrientArtifact(repoRoot, task.id, {
    runId: task.id,
    trail,
    orientOk: subAgent.ok,
    cliPreOrient: cliOrient,
    greenfield: greenfieldContext,
  });

  recordRunEvent(repoRoot, {
    event: 'phase_finished',
    runId: task.id,
    phase: 'repovine_orient',
    ok: subAgent.ok,
    durationMs: Date.now() - startedAtMs,
    graphNodeCount: trail.graphNodes.length,
    claimCount: claims.length,
  });

  const orientSection = [
    '',
    '## Repovine orient (graph scope for this run)',
    greenfieldContext ? '- mode: NEW PROJECT (greenfield — empty graph/annotations expected)' : '',
    trail.summary ? `- summary: ${trail.summary}` : '- summary: (none)',
    trail.graphNodes.length
      ? `- graphNodes: ${trail.graphNodes.slice(0, 12).join(', ')}${trail.graphNodes.length > 12 ? ' …' : ''}`
      : '- graphNodes: (none)',
    // Continuation runs are session-quality gated (harness mode): anchor-first
    // navigation is what passes it — resolved inspects, not broad OR searches.
    trail.graphNodes.length
      ? '- ANCHOR FIRST: inspect_node the graphNodes above for your layer BEFORE any free-text search_context; a broad OR-relaxed search without a narrowed follow-up scores poorly and can fail the context-session gate.'
      : '',
    claims.length ? `- claims: ${claims.map((c) => c.text).join('; ')}` : '',
  ].filter(Boolean).join('\n');

  const enrichedTask = {
    ...task,
    task: `${task.task}${orientSection}`,
    // Structured transport for the orient payload: buildSubAgentTask appends this to
    // every subAgent whose spec.task OVERRIDES the parent task text (LLM-planned,
    // fix, sync, review specs) — the section embedded in `task` above only
    // survives for subAgents that fall back to the parent text. Without this field
    // a planner-authored subAgent silently loses anchors, claims, and guidance.
    repovineOrientSection: orientSection,
    repovineOrient: trail,
    repovineClaims: claims,
    greenfield: greenfieldContext,
    requestedChecks: uniqueRequestedChecks([
      ...(task.requestedChecks ?? []),
      'runtime-flow',
      'dependencies',
    ]),
  };

  return { subAgent, trail, claims, enrichedTask, greenfield: greenfieldContext };
}

/** Weak orient on greenfield (empty graphNodes) must not fail the run gate. */
export function isIgnorableOrientFailure(orientSubAgent, greenfield = false) {
  if (!greenfield || !orientSubAgent || orientSubAgent.ok) return false;
  const nodes = orientSubAgent.orientTrail?.graphNodes ?? orientSubAgent.result?.graphNodesTouched ?? [];
  return nodes.length === 0;
}

/** Read-only verify after runtime_check. */
export async function runVerifyClaimsPhase({
  task, repoRoot, provider, claims, orientTrail, implementSubAgents, handoffs, signal, priorSessions, onSession, greenfieldRun, treeDiffSection = '', graphObligationsSection = '',
}) {
  if (!claims.length && !orientTrail?.graphNodes?.length) return null;

  const implementSummaries = implementSubAgents
    .filter((l) => l.ok && l.result?.summary)
    .map((l) => `[${l.instanceId || l.role}] ${l.result.summary}`);

  const spec = {
    ...resolveRole('review', repoRoot, {
      scope: ['.'],
      task: verifyClaimsTask({ claims, orientTrail, implementSummaries, treeDiffSection, graphObligationsSection }),
      // Claim-verifier, not a diff review: it emits VERIFY: lines in contractsChanged and
      // blockers, never the code-reviewer `review` object. Holding it to repovine-code-reviewer's
      // required `review` field hard-fails it for a field its task never asks for. summary-only
      // floor; its real gate is blockers (reviewPassed) + the goal gate.
      manifest: null,
    }),
    instanceId: VERIFY_INSTANCE_ID,
    contextPhase: 'explore',
    modelRole: 'verify',
  };
  log('verify-claims sub-agent (code-reviewer)');
  recordRunEvent(repoRoot, { event: 'phase_started', runId: task.id, phase: 'repovine_verify' });
  const startedAtMs = Date.now();

  const subAgent = await runSubAgent({
    parentTask: task,
    spec,
    repoRoot,
    provider,
    priorHandoffs: handoffs,
    signal,
    // No resume: the role-keyed session map would hand verify the REVIEWER's
    // provider conversation — a different subAgent's history contaminates the
    // independent claim check. Verify starts fresh by design.
    onSession,
    telemetryRoot: repoRoot,
    greenfieldRun,
  });

  recordRunEvent(repoRoot, {
    event: 'phase_finished',
    runId: task.id,
    phase: 'repovine_verify',
    ok: subAgent.ok,
    durationMs: Date.now() - startedAtMs,
  });

  try {
    writeJsonFile(runLevelPath(repoRoot, task.id, RUN_LEVEL.verify, { active: true }), {
      runId: task.id,
      ok: subAgent.ok,
      summary: subAgent.result?.summary ?? '',
      blockers: subAgent.result?.blockers ?? [],
      contractsChanged: subAgent.result?.contractsChanged ?? [],
    });
  } catch {
    /* best-effort */
  }

  return subAgent;
}

/**
 * Tri-state verify-claims outcome for the run's signal block. A missing subAgent
 * (gates closed, abort, process disabled) fails closed when verification is
 * required — a run that never verified its claims cannot claim a verified product.
 */
export function verificationStatusOf(verifySubAgent, required) {
  if (!verifySubAgent) return required ? 'failed' : 'skipped';
  return verifySubAgent.ok ? 'passed' : 'failed';
}

/** Required + skipped ≠ accepted (same acceptance rule as the runtime tri-state). */
export function verificationAcceptedOf(verifySubAgent, required) {
  const status = verificationStatusOf(verifySubAgent, required);
  return status === 'passed' || (status === 'skipped' && !required);
}

/**
 * Goal gate. With a `signals` block (multi mode) the exact formula decides:
 * runtimeAccepted && verificationAccepted && (!reviewRequired || reviewAccepted).
 * Without signals (single mode / legacy callers) the delivery heuristic below applies.
 */
export function repovineGoalOk({ subAgents, runtimeCheck, signals }) {
  if (signals) {
    return Boolean(signals.runtimeAccepted)
      && Boolean(signals.verificationAccepted)
      && (!signals.reviewRequired || signals.reviewAccepted === true);
  }
  if (runtimeCheck && runtimeCheck.skipped !== true && !runtimeCheckPassed(runtimeCheck)) return false;

  const verify = subAgents.find(isVerifyClaimsSubAgent);
  if (verify && !verify.ok) return false;

  const codeSubAgents = subAgents.filter(
    (l) => (l.role === 'backend' || l.role === 'frontend') && !isAnnotationSyncSubAgent(l),
  );
  const delivering = codeSubAgents.filter((l) => (l.result?.filesChanged ?? []).length > 0);

  if (delivering.length > 0) {
    return delivering.some((l) => {
      const statusOk = l.result?.status === 'complete' || l.result?.status === 'partial';
      return statusOk && (l.ok || subAgentGateEffectivelyOk(l));
    });
  }

  if (verify) return false;

  return repovineProcessRunOk({ subAgents, runtimeCheck, reviewGateOpen: true });
}

const CSQ_ERROR_RE = /^Context session quality rejected handoff/;

/**
 * Delivered work whose ONLY compliance failure is a weak context session.
 * Outcome gates (review, verify + graph obligations, test floor) own
 * correctness; the epistemic signal stays visible (yellow subAgent in the reply,
 * `signals.contextQualityRejections`) and the retry pressure stays — the subAgent already
 * retried to recover. It no longer fails the run's process axis. Mirrors the
 * subAgentGateEffectivelyOk precedent for out-of-scope blocker noise. Any other
 * compliance error (false claims, schema, required fields) still fails.
 */
export function subAgentCsqOnlyDelivered(subAgent) {
  if (!subAgent || subAgent.ok) return false;
  const status = subAgent.result?.status;
  if (status !== 'complete' && status !== 'partial') return false;
  // "Delivered" is role-shaped: implementers ship files, reviewers ship a parsed
  // review payload, annotation writers ship annotationsWritten, verify sub-agents
  // ship contractsChanged verdicts. A no-file sub-agent rejected only for a thin
  // funnel is delivered work, not a broken sub-agent.
  const delivered = (subAgent.result?.filesChanged ?? []).length > 0
    || (subAgent.result?.review && typeof subAgent.result.review === 'object' && subAgent.schemaValid !== false)
    || (subAgent.result?.annotationsWritten ?? []).length > 0
    || (subAgent.result?.contractsChanged ?? []).length > 0;
  if (!delivered) return false;
  const errors = subAgent.report?.errors ?? [];
  if (!errors.length) return false;
  return errors.every((e) => CSQ_ERROR_RE.test(String(e)));
}

/** Multi-agent ok: implement + runtime + verify; annotation-sync is advisory. */
export function repovineProcessRunOk({
  subAgents,
  runtimeCheck,
  reviewGateOpen = true,
  greenfield = false,
}) {
  const gateSubAgents = subAgents.filter(isRunGateSubAgent);
  if (!gateSubAgents.length) return false;
  if (!gateSubAgents.every((l) => l.ok || subAgentGateEffectivelyOk(l) || subAgentCsqOnlyDelivered(l))) return false;
  if (!reviewGateOpen) return false;
  if (runtimeCheck && runtimeCheck.skipped !== true && !runtimeCheck.ok) return false;
  const verify = subAgents.find(isVerifyClaimsSubAgent);
  if (verify && !verify.ok) return false;
  const orient = subAgents.find(isOrientSubAgent);
  if (orient && !orient.ok && !isIgnorableOrientFailure(orient, greenfield)) return false;
  return true;
}

export function formatOrientVerifyReplyLines(state) {
  const lines = [];
  if (state.greenfield) {
    lines.push('🆕 new project (greenfield — empty graph/annotations ok)');
  }
  const orient = state.repovineOrient ?? state.subAgents?.find(isOrientSubAgent)?.orientTrail;
  const trail = orient ?? state.repovineOrientTrail;
  if (trail?.graphNodes?.length) {
    const preview = trail.graphNodes.slice(0, 6).join(', ');
    lines.push(`🧭 lore: ${trail.graphNodes.length} node(s) — ${preview}${trail.graphNodes.length > 6 ? '…' : ''}`);
  }
  if (state.repovineClaims?.length) {
    lines.push(`📋 claims: ${state.repovineClaims.length}`);
  }
  const verify = state.subAgents?.find(isVerifyClaimsSubAgent);
  if (verify?.result?.summary) {
    const mark = verify.ok ? '✓' : '✗';
    lines.push(`${mark} verify: ${verify.result.summary.slice(0, 120)}${verify.result.summary.length > 120 ? '…' : ''}`);
  }
  return lines;
}
