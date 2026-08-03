// One protocol sub-agent run = one validated worker result.
import { buildAssignment } from '../assignment.mjs';
import * as rp from '../repovine.mjs';
import {
  subAgentAssignmentPath,
  subAgentAttemptResultPath,
  subAgentMcpPath,
  subAgentResultPath,
  subAgentUsagePath,
  writeJsonFile,
} from '../harness-paths.mjs';
import { snapshot, reconcile, harnessReapEnabled } from '../sandbox-procs.mjs';
import { getWorker } from '../workers/index.mjs';
import {
  COMPACT_RETRY_BASE,
  complianceAccepted,
  complianceReport,
  foldRetryContext,
  foldWorkerTimeoutRetry,
  isRetriable,
  isSyncOnlyReport,
  isTransientTransportBlock,
  isWorkerTimeoutBlock,
  subAgentSyncRetrySucceeded,
  mergeSyncOnlyResult,
  shouldDeferImplementAnnotationRetry,
} from './retry.mjs';
import { subAgentModelRole } from '../model-role.mjs';
import { protocolRoleForSpec } from '../agents.mjs';
import {
  buildInterSubAgentTaskSection,
  contractHandoffViolations,
  finalizeHandoff,
  interSubAgentHandoffConstraint,
} from '../handoff-loader.mjs';
import { totalUsage } from '../workers/usage.mjs';
import { formatMcpMetrics, resolveMcpMetrics, snapshotMcpSession, totalMcpMetrics } from '../workers/mcp-telemetry.mjs';
import { logLine } from '../log.mjs';
import { recordRunEvent } from '../telemetry.mjs';
import { CSQ_CALIBRATION } from '../target-repo.mjs';

const VERBOSE = process.env.GRAPH_VERBOSE !== '0';
const log = (msg) => logLine('sub-agent', msg, { enabled: VERBOSE, indent: '    ' });

function writeSubAgentJson(repoRoot, subAgentKey, kind, value, attempt = null) {
  let file;
  if (kind === 'assignment') file = subAgentAssignmentPath(repoRoot, subAgentKey, { active: true });
  else if (kind === 'result') file = subAgentResultPath(repoRoot, subAgentKey, { active: true });
  else if (kind === 'attempt') file = subAgentAttemptResultPath(repoRoot, subAgentKey, attempt, { active: true });
  else if (kind === 'usage') file = subAgentUsagePath(repoRoot, subAgentKey, { active: true });
  else if (kind === 'mcp') file = subAgentMcpPath(repoRoot, subAgentKey, { active: true });
  else throw new Error(`unknown subAgent artifact kind: ${kind}`);
  return writeJsonFile(file, value);
}

function subAgentInstanceId(spec) {
  return spec.instanceId || spec.role;
}

function subAgentContextPhase(spec) {
  if (spec.contextPhase) return spec.contextPhase;
  if (spec.manifest === 'repovine-annotation-writer') return 'annotate';
  if (spec.role === 'review') return 'explore';
  return 'implement';
}

// CSQ_CALIBRATION uses config-file field names (threshold); the assignment's
// ContextSessionPolicy names the same knob qualityThreshold.
function csqPolicyForPhase(phase) {
  const cal = CSQ_CALIBRATION[phase];
  if (!cal) return {};
  return {
    ...(cal.threshold !== undefined ? { qualityThreshold: cal.threshold } : {}),
    ...(cal.warningThreshold !== undefined ? { warningThreshold: cal.warningThreshold } : {}),
    ...(cal.byteBudget !== undefined ? { byteBudget: cal.byteBudget } : {}),
  };
}

export function buildSubAgentTask(parentTask, spec, priorHandoffs = [], repoRoot, { resuming = false, greenfieldRun = false } = {}) {
  const instanceId = subAgentInstanceId(spec);
  const baseContracts = parentTask.contracts ?? [];
  const lines = [spec.task || parentTask.task];
  // Data-plane contract: the orient payload (anchors, claims, guidance) reaches
  // EVERY subAgent. Fallback subAgents embed it via the parent task text; a spec.task
  // override (LLM plan, fix, sync, review specs) would silently drop it without
  // this append.
  if (spec.task && parentTask.repovineOrientSection) {
    lines.push(parentTask.repovineOrientSection);
  }
  // Role stack: the brief's frontmatter declares the role's technology; the
  // ASSIGNMENT delivers it (brief prose loses to scaffold-template inertia —
  // observed 0/3 for Tailwind; the assignment channel held 10/10 for frameworks).
  // Greenfield only: continuation matches the stack already in the codebase.
  if (greenfieldRun && spec.stack) {
    lines.push('', '## Role stack (greenfield scaffold)', `Use this stack: ${spec.stack}. Do not substitute.`);
  }
  // Embed the inter-sub-agent section whenever there is ANY contract ledger or prior sub-agent
  // to carry. The section renders the full deduped contract ledger, so it doubles as
  // the single contract channel (survives Claude resume, where only task.task is sent).
  const hasHandoff = priorHandoffs.length > 0 || baseContracts.length > 0;
  if (hasHandoff) {
    lines.push('', buildInterSubAgentTaskSection(priorHandoffs, repoRoot, {
      baseContracts,
      currentRole: spec.role,
      resuming,
    }));
  }
  const contracts = [
    ...baseContracts,
    ...priorHandoffs.flatMap((h) => h.contractsChanged ?? []),
  ];
  return {
    id: `${parentTask.id}.${instanceId}`,
    // Delivery Protocol role for the assignment schema — the spec's manifest resolves
    // it (buildAssignment reads task.role). The demo planner label on `spec.role`
    // stays separate; it never reaches the schema.
    role: protocolRoleForSpec(spec),
    task: lines.join('\n'),
    scope: spec.scope,
    acceptanceCriteria: parentTask.acceptanceCriteria ?? [],
    // The parent verification policy rides down to every sub-agent assignment so the
    // verifier's evidence is checked against the same allowlist; buildAssignment passes it through.
    ...(parentTask.verificationPolicy ? { verificationPolicy: parentTask.verificationPolicy } : {}),
    ...(parentTask.delivery ? { delivery: parentTask.delivery } : {}),
    constraints: [
      interSubAgentHandoffConstraint(spec.role, repoRoot),
      `You are the ${spec.role} sub-agent. Stay strictly within scope ${JSON.stringify(spec.scope)}; do not edit other areas.`,
      ...(parentTask.constraints ?? []),
    ],
    contracts,
    // When the inter-sub-agent section is embedded in `task`, it already renders the full
    // contract ledger (=== `contracts`). Prompt builders read this to skip the
    // duplicate `Contracts:` JSON line. Stripped by buildAssignment (known fields only).
    embedsContracts: hasHandoff,
    requestedChecks: parentTask.requestedChecks ?? [],
    // Carry the parent /task's attachments (e.g. a Telegram reference photo) down to
    // EVERY sub-agent so the actual implementer opens the image with its Read tool — not
    // just the planner, which only sees text and would paraphrase it. The worker
    // prompt builders render these via attachmentsBrief; buildAssignment strips the
    // field (unknown to the schema), so it rides only on the task object.
    ...(Array.isArray(parentTask.attachments) && parentTask.attachments.length
      ? { attachments: parentTask.attachments }
      : {}),
    ...(parentTask.contextSession
      ? {
          contextSession: {
            ...parentTask.contextSession,
            phase: subAgentContextPhase(spec),
            sessionId: `${parentTask.contextSession.sessionId}.${instanceId}`,
            // Harness-owned gate calibration rides the assignment so it reaches
            // compliance in BOTH target modes; in attach the workspace config
            // belongs to the target repo and may carry no contextQuality at all
            // (engine defaults would grade the gate: implement 0.55 vs our 0.30).
            ...csqPolicyForPhase(subAgentContextPhase(spec)),
            // Annotate-phase subAgents run CSQ as ADVISORY (score/warnings still
            // computed and reported): the funnel score models explore/implement
            // navigation, while a write-heavy sync subAgent is held by its own hard
            // gates — written-annotation existence/freshness, provenance
            // grounding, and the scope coverage drain.
            ...(subAgentContextPhase(spec) === 'annotate' ? { required: false } : {}),
          },
        }
      : {}),
  };
}

function applyHarnessContractGate(spec, result, report, ok, repoRoot) {
  const violations = contractHandoffViolations(spec, result, repoRoot);
  if (!violations.length || !ok) return { ok, report };
  return {
    ok: false,
    report: {
      ...report,
      valid: false,
      errors: [...(report?.errors ?? []), ...violations],
    },
  };
}

export async function runSubAgent({
  parentTask,
  spec,
  repoRoot,
  provider,
  priorHandoffs = [],
  signal,
  resume: initialResume,
  onSession,
  telemetryRoot = repoRoot,
  greenfieldRun = false,
}) {
  const subAgentTask = buildSubAgentTask(parentTask, spec, priorHandoffs, repoRoot, { resuming: Boolean(initialResume), greenfieldRun });
  const base = { role: spec.role, scope: spec.scope, agentSource: spec.agentSource, ...(spec.instanceId ? { instanceId: spec.instanceId } : {}) };
  const subAgentStartedAtMs = Date.now();
  recordRunEvent(telemetryRoot, {
    event: 'sub_agent_started',
    runId: parentTask.id,
    subAgent: spec.instanceId || spec.role,
    role: spec.role,
    scope: spec.scope,
    resumed: Boolean(initialResume),
    // Prompt provenance: which catalog the role came from and exactly which
    // brief bytes went into the worker prompt (as-is consumption).
    roleSource: spec.roleSource ?? 'bundled',
    ...(spec.briefHash ? { briefHash: spec.briefHash } : {}),
    ...(spec.agentSource ? { briefPath: spec.agentSource } : {}),
    ...(spec.manifest ? { manifest: spec.manifest } : {}),
  });

  const assignment = buildAssignment(subAgentTask);
  const assignmentFile = writeSubAgentJson(repoRoot, subAgentTask.id, 'assignment', assignment);
  const av = rp.validateAssignment(assignmentFile, repoRoot);
  if (!av.json?.valid) {
    const reason = av.json?.errors?.join('; ') || 'assignment schema invalid';
    const result = { status: 'blocked', summary: `Assignment rejected: ${reason}`, blockers: [reason] };
    recordRunEvent(telemetryRoot, {
      event: 'sub_agent_finished',
      runId: parentTask.id,
      subAgent: spec.instanceId || spec.role,
      role: spec.role,
      ok: false,
      resultStatus: result.status,
      durationMs: Date.now() - subAgentStartedAtMs,
      attempts: 0,
      blockers: 1,
    });
    return {
      ...base,
      ok: false,
      schemaValid: false,
      result,
      report: { valid: false, errors: [reason] },
      handoff: finalizeHandoff(spec, result, false, repoRoot),
      assignmentFile,
    };
  }

  log(`${spec.role} → worker (${provider}) scope=${JSON.stringify(spec.scope)}`);
  const worker = await getWorker(provider);
  // A provider without conversation resume must get the FULL task re-folded on a
  // retry: the compact pointer base assumes the session history holds the
  // assignment, which is false for stateless workers — their retry attempt would
  // otherwise carry no task, no orient payload, and no handoff at all.
  const workerSupportsResume = worker.supportsResume !== false;
  // Guard non-numeric/negative env: NaN would make `attempt <= maxRetries` false on
  // the first iteration, leaving result/vr undefined and crashing runSubAgent below.
  const maxRetriesRaw = Number(process.env.HARNESS_MAX_RETRIES ?? 1);
  const maxRetries = Number.isInteger(maxRetriesRaw) && maxRetriesRaw >= 0 ? maxRetriesRaw : 1;

  let capture = {};
  let procSnap;
  let result;
  let resultFile;
  let vr;
  let report;
  let ok = false;
  let recon;
  const attempts = [];
  let syncAcceptedResult;
  let annotationSyncDeferred = false;
  const contextSessionId = subAgentTask.contextSession?.sessionId;
  const mcpSnapshots = [];
  // First attempt resumes the prior /task's conversation for THIS role (cross-invoke
  // resume); retries below resume the just-run session (within-invoke).
  let resume = initialResume;
  let runTask = subAgentTask;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const attemptStartedAtMs = Date.now();
    capture = {};
    procSnap = snapshot(repoRoot);
    try {
      result = await worker.runAgent(runTask, assignment, repoRoot, {
        agentPrompt: spec.agentPrompt,
        capture,
        signal,
        modelRole: spec.modelRole || subAgentModelRole(spec.role),
        // The manifest selects the engine-authored brief (`delivery run-brief --name`), so
        // each sub-agent is briefed for the role it is validated against.
        briefName: spec.manifest,
        ...(resume ? { resume } : {}),
      });
    } catch (workerErr) {
      // Leak-safety: reap servers/containers the failed attempt spawned before the throw propagates.
      try { await reconcile(repoRoot, procSnap, { label: spec.role, reap: harnessReapEnabled() }); } catch {}
      throw workerErr;
    }
    // Custody BEFORE validation: the harness-delivered diff base overwrites the
    // model's self-report so compliance and the persisted attempt evaluate the
    // true base (spec.reviewDiffBase is set by the review dispatch wrapper).
    if (spec.reviewDiffBase && result?.review && typeof result.review === 'object') {
      result.review.reviewedDiffBase = spec.reviewDiffBase;
    }
  // Report the session id outward as soon as it exists, so a /stop before the
  // graph commits state still lets the next /task resume this sub-agent by role.
    if (capture.sessionId) onSession?.(spec.role, capture.sessionId);
    resultFile = writeSubAgentJson(repoRoot, subAgentTask.id, 'attempt', result, attempt + 1);

    // Compliance consumes the context session file after each check — snapshot MCP
    // metrics while the worker's repovine MCP ledger is still on disk.
    if (contextSessionId) {
      const snap = snapshotMcpSession(repoRoot, contextSessionId);
      if (snap) mcpSnapshots.push(snap);
    }

    vr = rp.validateResult(resultFile, { assignment: assignmentFile, manifest: spec.manifest, repoRoot });
    const cc = rp.compliance(resultFile, { assignment: assignmentFile, manifest: spec.manifest, repoRoot, greenfieldRun });
    report = complianceReport(cc.json);
    ok = complianceAccepted(report);
    ({ ok, report } = applyHarnessContractGate(spec, result, report, ok, repoRoot));
    recon = await reconcile(repoRoot, procSnap, { label: spec.role, reap: harnessReapEnabled() });
    const syncOnlyRejection = !ok && isSyncOnlyReport(report);
    const deferAnnotationSync = !ok && shouldDeferImplementAnnotationRetry(result, report, subAgentTask);
    // Per-attempt token/cost usage (provider-normalized; null fields = provider doesn't
    // report them). This turns the handoff/caching analysis from byte estimates into
    // measured input/output/cache_read tokens.
    attempts.push({ attempt: attempt + 1, resultFile, ok, syncOnlyRejection, usage: capture.usage ?? null });
    recordRunEvent(telemetryRoot, {
      event: 'sub_agent_attempt_finished',
      runId: parentTask.id,
      subAgent: spec.instanceId || spec.role,
      role: spec.role,
      attempt: attempt + 1,
      ok,
      status: result.status,
      durationMs: Date.now() - attemptStartedAtMs,
      syncOnlyRejection,
      deferredAnnotationSync: deferAnnotationSync,
      complianceErrors: report?.errors?.length ?? 0,
      // First error texts so a rejection/hang is diagnosable from the event stream
      // itself — no offline recompliance, and the "ok=false / 0 errors" surprise is
      // resolved (a manifest-layer reject shows its message here).
      complianceErrorTexts: (report?.errors ?? []).slice(0, 5).map((e) => String(e).slice(0, 240)),
      usage: capture.usage ?? null,
    });
    log(`${spec.role} → status=${result.status} compliance=${ok ? 'valid' : 'invalid'}${attempt > 0 ? ` (retry ${attempt})` : ''}`);

    // Deferral is an ACCEPTANCE, not a rejection: the code passed and only the annotation
    // sync is outstanding, which the post-review annotation subAgent owns. Leaving ok=false
    // here would fail the run for accepted work AND drop this sub-agent from
    // annotationSyncTargets — so the sync it was deferred to would skip it too.
    if (deferAnnotationSync) {
      annotationSyncDeferred = true;
      ok = true;
      log(`${spec.role} → code accepted; annotation sync deferred to the post-review subAgent`);
      break;
    }

    if (ok || signal?.aborted || !isRetriable(result, report, subAgentTask)) break;
    if (attempt >= maxRetries) break;
    if (syncOnlyRejection && !syncAcceptedResult) syncAcceptedResult = result;
    // A transient transport failure gets a FRESH attempt of the original
    // assignment: no session to resume (the stream died before work started)
    // and nothing to fold — a compact "continue our conversation" pointer would
    // reach a session that never happened.
    if (isWorkerTimeoutBlock(result)) {
      // Wall-clock kill of a LIVE worker: an identical replay reproduces the
      // investigation spiral deterministically. Fresh session + time-box fold.
      resume = undefined;
      runTask = { ...subAgentTask, task: foldWorkerTimeoutRetry(subAgentTask.task, result) };
      log(`${spec.role} → retry (worker timeout, fresh time-boxed attempt)`);
    } else if (isTransientTransportBlock(result)) {
      resume = undefined;
      runTask = subAgentTask;
      log(`${spec.role} → retry (transient transport failure, fresh attempt)`);
    } else {
      resume = workerSupportsResume ? capture.sessionId : undefined;
      runTask = {
        ...subAgentTask,
        task: foldRetryContext(
          workerSupportsResume ? COMPACT_RETRY_BASE : subAgentTask.task,
          report,
          { workResult: syncAcceptedResult ?? result },
        ),
      };
      log(`${spec.role} → retry (${workerSupportsResume ? 'session resumed, compact blocker context' : 'stateless worker, full task re-folded'})`);
    }
  }

  const syncRetryPassed = subAgentSyncRetrySucceeded(attempts);
  const loopPassed = ok;
  if (syncAcceptedResult && (loopPassed || syncRetryPassed)) {
    result = mergeSyncOnlyResult(syncAcceptedResult, result);
    resultFile = writeSubAgentJson(repoRoot, subAgentTask.id, 'result', result);
    vr = rp.validateResult(resultFile, { assignment: assignmentFile, manifest: spec.manifest, repoRoot });
    const cc = rp.compliance(resultFile, { assignment: assignmentFile, manifest: spec.manifest, repoRoot, greenfieldRun });
    report = complianceReport(cc.json);
    ok = complianceAccepted(report);
    ({ ok, report } = applyHarnessContractGate(spec, result, report, ok, repoRoot));
    // Sync-only retry passed on the last attempt — keep sub-agent ok even if merged re-check is noisy.
    if (!ok && syncRetryPassed) ok = true;
  } else if (!loopPassed) {
    resultFile = writeSubAgentJson(repoRoot, subAgentTask.id, 'result', result);
    vr = rp.validateResult(resultFile, { assignment: assignmentFile, manifest: spec.manifest, repoRoot });
    const cc = rp.compliance(resultFile, { assignment: assignmentFile, manifest: spec.manifest, repoRoot, greenfieldRun });
    report = complianceReport(cc.json);
    ok = complianceAccepted(report);
    ({ ok, report } = applyHarnessContractGate(spec, result, report, ok, repoRoot));
  } else {
    // Loop already passed compliance — re-running consumes the context session and can flip ok→false.
    resultFile = writeSubAgentJson(repoRoot, subAgentTask.id, 'result', result);
  }

  // Roll per-attempt usage into a sub-agent total and drop a sidecar next to the result, so
  // .harness becomes a measured cost ledger (input/output/cache_read tokens, $), not an
  // estimate. multi.mjs can sum sub-agent usage for a run-level total.
  const usage = totalUsage(attempts.map((a) => a.usage));
  const usageFile = writeSubAgentJson(repoRoot, subAgentTask.id, 'usage', {
    subAgent: subAgentTask.id,
    role: spec.role,
    scope: spec.scope,
    provider,
    total: usage,
    attempts: attempts.map((a) => ({ attempt: a.attempt, ok: a.ok, usage: a.usage })),
  });
  if (usage) {
    log(
      `${spec.role} → usage in=${usage.inputTokens ?? '–'} out=${usage.outputTokens ?? '–'} `
        + `cacheRead=${usage.cacheReadTokens ?? '–'} hit=${usage.cacheHitRatio ?? '–'}`
        + `${usage.costUsd != null ? ` $${usage.costUsd.toFixed(4)}` : ''}`,
    );
  }

  const contextSessionIdFinal = result.contextSessionId ?? contextSessionId;
  const mcp = totalMcpMetrics(mcpSnapshots)
    ?? resolveMcpMetrics({
      contextQuality: report?.contextQuality,
      repoRoot,
      contextSessionId: contextSessionIdFinal,
    });
  if (mcp && contextSessionIdFinal && !mcp.contextSessionId) {
    mcp.contextSessionId = contextSessionIdFinal;
  }
  const mcpFile = mcp
    ? writeSubAgentJson(repoRoot, subAgentTask.id, 'mcp', {
      subAgent: subAgentTask.id,
      role: spec.role,
      scope: spec.scope,
      provider,
      contextSessionId: mcp.contextSessionId ?? contextSessionIdFinal ?? null,
      total: mcp,
    })
    : null;
  if (mcp) {
    log(`${spec.role} → ${formatMcpMetrics(mcp)}`);
  }
  recordRunEvent(telemetryRoot, {
    event: 'sub_agent_finished',
    runId: parentTask.id,
    subAgent: spec.instanceId || spec.role,
    role: spec.role,
    ok,
    resultStatus: result.status,
    durationMs: Date.now() - subAgentStartedAtMs,
    attempts: attempts.length,
    filesChanged: result.filesChanged?.length ?? 0,
    blockers: result.blockers?.length ?? 0,
    usage,
    mcp,
  });

  const handoff = finalizeHandoff(spec, result, ok, repoRoot);

  return {
    ...base,
    ok,
    // Fresh = no prior session for this role at dispatch (first sub-agent of its role in the
    // run); subsequent same-role sub-agents resume. The run rollup uses this to separate
    // cold-cache fresh sub-agents (where the contract ledger is paid in full) from resumes.
    resumed: Boolean(initialResume),
    schemaValid: vr.json?.schemaValid ?? false,
    // Code accepted, annotations owed to the post-review sync subAgent (which reads this).
    annotationSyncDeferred,
    result,
    report,
    handoff,
    attempts,
    usage,
    usageFile,
    mcp,
    mcpFile,
    leftRunning: recon?.leftRunning ?? [],
    reaped: recon?.reaped ?? false,
    workerSessionId: capture.sessionId,
    assignmentFile,
    resultFile,
  };
}
