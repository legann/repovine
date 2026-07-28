// Retry-context folding for rejected runs (single sub-agent + multi sub-agent share this).
//
// The HARNESS — not the main agent — drives retries: when repovine compliance
// rejects a run, the orchestrator re-runs the SAME worker session (conversation
// resumed) with the blockers folded into the task text. The key nuance: if the
// rejection is sync-only (annotation coverage/quality/orphans/refresh), the code
// is already accepted, so we tell the agent explicitly NOT to redo the work —
// just finish the repovine sync. That keeps a one-line annotation miss from
// triggering a full re-implementation.

// A retry always RESUMES the just-run session, which already holds the full task,
// scope, contracts, and inter-sub-agent handoff. Re-sending all of that is pure overhead —
// use this compact base so the retry message carries only the pointer + folded blockers.
export const COMPACT_RETRY_BASE =
  'Continue the SAME assignment in this resumed session — its scope, contracts, and inter-sub-agent handoff are already in our conversation above; do not restate or redo them.';

// Errors that are fixable WITHOUT touching code (just the repovine sync step).
//
// `coverage` is absent on purpose: bare, it also matched the engine's review-verdict error
// (`testReview.coverageAssessment="insufficient"`), so a reviewer that approved a change with
// inadequate tests was retried with "the code is accepted, just finish the annotation sync".
// Dropping it costs nothing here — the annotation-coverage error the harness gate raises reads
// "Annotation coverage incomplete in scope (N node(s) unannotated/stale)", which `annotation`
// already carries.
const SYNC_ONLY = /annotation|orphan|tier|refresh_context|annotationsClean|graphNodesTouched|stale|missing fields|recommendedFields/i;

// Harness contract-handoff failures require code or contractsChanged — never sync-only skip.
const CONTRACT_HANDOFF = /inter-sub-agent contract|contractsChanged/i;

// A node id the graph does not have is a FALSE CLAIM about the result, not an
// annotation-sync gap — even though the message names graphNodesTouched and so
// matches SYNC_ONLY. Sync-only rejections are deferred to the post-review
// annotation subAgent and never retried, which would let an invented node id ride
// through unchallenged. Retry instead: the agent re-reads the graph and corrects
// the id list.
const FALSE_CLAIM = /not found in graph|do not exist|invented/i;

// Manifest-required result fields (repovine reports them as requiredFollowups, not
// errors — a general validator stays advisory). The HARNESS applies the policy: a
// role that omits its required field has not delivered its result. Same shape as
// the annotation-grounding policy below.
const MISSING_REQUIRED_FIELDS = /Populate required result field/i;

/** True when the result omits a field its manifest role requires. */
export function requiredFieldsRejected(report) {
  return (report?.requiredFollowups ?? []).some((f) => MISSING_REQUIRED_FIELDS.test(String(f)));
}

/**
 * Compliance report for one attempt. `agents compliance` answers a schema failure
 * with `{schemaValid:false, schemaErrors}` and NO report — an undefined report
 * carries no retry notes, so the malformed result would be accepted as final and
 * the sub-agent would never learn its JSON was rejected. Synthesize a report so
 * the schema errors reach the retry the same way compliance errors do.
 */
export function complianceReport(complianceJson) {
  if (complianceJson?.report) return complianceJson.report;
  const schemaErrors = complianceJson?.schemaErrors ?? [];
  if (complianceJson?.schemaValid === false) {
    return {
      valid: false,
      errors: schemaErrors.map((e) => `AgentRunResult failed schema validation: ${e}`),
      warnings: [],
      requiredFollowups: [
        'Re-emit the AgentRunResult with the field types the schema declares'
          + ' (every list field is a flat string array — testsRun entries are strings, not objects).',
      ],
    };
  }
  return undefined;
}
const SUMMARY_SYNC_ONLY =
  /annotation|tier|validate_annotations|orphan|graph refreshed|refresh_context|write_annotation|annotations clean/i;

const orderedUnion = (...lists) => {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const key = typeof item === 'string' ? item : JSON.stringify(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
};

// ── Annotation-grounding policy (HARNESS, not engine) ──────────────────────────
// repovine is a general validator: it reports annotation-grounding FACTS — provenance
// (ungroundedAnnotations) and hard consistency (inconsistentAnnotations: keyExports/sideEffects;
// env stays advisory and is never in these arrays) — as structured observations regardless of
// enforcement mode. The engine knows nothing about this harness. The harness, a strict
// superstructure, applies the POLICY: any such fact rejects the run so the retry loop fixes it.
// Mode-independent — works whether repovine surfaced them as errors (harness+annotate) or warnings.

/** True when repovine observed an annotation-grounding fact this run (provenance or hard consistency). */
export function groundingRejected(report) {
  return (report?.ungroundedAnnotations?.length ?? 0) > 0
    || (report?.inconsistentAnnotations?.length ?? 0) > 0;
}

/** Harness compliance acceptance: repovine valid, no grounding rejection, required fields present. */
export function complianceAccepted(report) {
  return Boolean(report?.valid) && !groundingRejected(report) && !requiredFieldsRejected(report);
}

/** Compliance notes worth folding into a retry (hard errors + required followups + grounding facts). */
export function retryNotes(report) {
  const notes = [...(report?.errors ?? []), ...(report?.requiredFollowups ?? [])];
  // Grounding facts may arrive as warnings (engine's general policy), so fold their specifics in
  // explicitly — the agent needs the node ids even when they were not hard errors.
  const ungrounded = report?.ungroundedAnnotations ?? [];
  if (ungrounded.length) {
    notes.push(
      `Annotations written without inspect/edit in this session (provenance): ${ungrounded.join(', ')}. `
      + 'inspect_node each (or edit its file) in the same contextSessionId, then re-write.',
    );
  }
  const inconsistent = report?.inconsistentAnnotations ?? [];
  if (inconsistent.length) {
    notes.push(
      'Annotations contradicting graph facts: '
      + `${inconsistent.map((i) => `${i.nodeId} (${(i.issues ?? []).join(', ')})`).join('; ')}. `
      + 'Fix the named keyExports/sideEffects to match the current graph, then re-write.',
    );
  }
  return notes;
}

/**
 * Shared retry policy for BOTH retry paths — the single sub-agent graph edge
 * (workflow.mjs routeAfterCompliance) and the multi sub-agent loop (subAgent.mjs). Retry
 * only a run worth re-running: NOT `blocked` (never started) and NOT `failed` (the
 * worker itself gave up) — neither self-heals — AND compliance left actionable
 * notes to fold into the next attempt. Callers filter `ok` (passed) runs and the
 * attempt-count bound separately.
 */
/**
 * Implement-phase code is accepted; annotation sync is deferred to post-review subAgents.
 * Do not sync-only retry and overwrite a good implementation pass.
 */
export function shouldDeferImplementAnnotationRetry(result, report, assignment) {
  const phase = assignment?.contextSession?.phase ?? 'implement';
  if (phase !== 'implement') return false;
  const files = (result?.filesChanged ?? []).filter(Boolean);
  if (!files.length) return false;
  return isSyncOnlyReport(report);
}

// Provider/proxy transport failures: the SDK stream died before the agent did
// any work. These are the one `blocked` class worth retrying — the retry is a
// fresh attempt, not a resumed conversation about a rejected result.
const TRANSIENT_TRANSPORT_RE =
  /ZlibError|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network|overloaded|Internal server error|API Error: 5\d\d|529/i;

/** True when a blocked result is a transport-level provider failure, not agent work. */
export function isTransientTransportBlock(result) {
  if (result?.status !== 'blocked') return false;
  if ((result.filesChanged ?? []).length > 0) return false;
  const text = [...(result.blockers ?? []), result.summary ?? ''].join(' ');
  return TRANSIENT_TRANSPORT_RE.test(text);
}

// The harness's own wall-clock kill ("Agent run timed out after Ns"). Unlike a
// transport death, the worker was ALIVE and working — the observed failure mode
// is an investigation/reasoning spiral that never reaches an edit. An identical
// fresh replay reproduces the spiral deterministically, so the retry must fold a
// time-box directive (see foldWorkerTimeoutRetry) instead of re-running verbatim.
const WORKER_TIMEOUT_RE = /timed out after \d+s/i;

/** True when a blocked result is the harness wall-clock kill of a live worker. */
export function isWorkerTimeoutBlock(result) {
  if (result?.status !== 'blocked') return false;
  if ((result.filesChanged ?? []).length > 0) return false;
  const text = [...(result.blockers ?? []), result.summary ?? ''].join(' ');
  return WORKER_TIMEOUT_RE.test(text);
}

/**
 * Retry task for a worker killed at the wall-clock limit with nothing delivered:
 * the original assignment plus a hard time-box directive. Fresh session — resuming
 * the killed session would hand the spiral its own context back.
 */
export function foldWorkerTimeoutRetry(baseTaskText, result) {
  const limit = String(result?.summary ?? '').match(/timed out after (\d+)s/i)?.[1];
  return [
    baseTaskText,
    '',
    `TIME-BOXED RETRY: the previous attempt was killed at the ${limit ? `${limit}s` : 'wall-clock'} limit`,
    'while still investigating — no files were delivered. Do not repeat that pattern:',
    '- Go straight to the smallest change that fixes the failure; start editing within your first few actions.',
    '- Skip broad exploration and long deliberation; prefer a minimal targeted fix over completeness.',
    '- Emit the AgentRunResult as soon as the fix is in place.',
  ].join('\n');
}

export function isRetriable(result, report, assignment) {
  if (shouldDeferImplementAnnotationRetry(result, report, assignment)) return false;
  if (isTransientTransportBlock(result) || isWorkerTimeoutBlock(result)) return true;
  if (!result || result.status === 'blocked' || result.status === 'failed') return false;
  return retryNotes(report).length > 0;
}

/**
 * Build the retry task text from a compliance report, or null when there is
 * nothing actionable to fold (caller should then stop retrying).
 */
/** True when compliance rejection is annotation/graph sync only (code accepted). */
export function isSyncOnlyReport(report) {
  const errors = report?.errors ?? [];
  // A missing required field is the result itself being incomplete — the agent must
  // re-emit it, and no annotation subAgent can do that for them.
  if (requiredFieldsRejected(report)) return false;
  // Grounding-only rejection (no hard errors, just provenance/consistency facts surfaced as
  // warnings) is always annotation-sync fixable — the code was accepted.
  if (errors.length === 0) return groundingRejected(report);
  if (errors.some((e) => CONTRACT_HANDOFF.test(e))) return false;
  if (errors.some((e) => FALSE_CLAIM.test(e))) return false;
  return errors.every((e) => SYNC_ONLY.test(e));
}

function syncOnlyAnnotationScope(workResult = {}) {
  const files = (workResult.filesChanged ?? []).filter(Boolean);
  const nodes = (workResult.graphNodesTouched ?? []).filter(Boolean);
  if (files.length) {
    return `Annotate ONLY graph nodes for these accepted filesChanged paths — do NOT drain the whole repo annotation queue: ${files.join(', ')}.`;
  }
  if (nodes.length) {
    return `Annotate ONLY these graphNodesTouched from the accepted attempt — do NOT drain the whole repo queue: ${nodes.join(', ')}.`;
  }
  return 'Annotate ONLY the node(s) named in the repovine issues below — do NOT drain the whole repo queue.';
}

export function subAgentSyncRetrySucceeded(attempts = []) {
  if (attempts.length < 2) return false;
  const last = attempts[attempts.length - 1];
  if (!last.ok) return false;
  // syncOnlyRejection is recorded on failed attempts; a passing retry has syncOnlyRejection=false.
  return attempts.slice(0, -1).some((a) => a.syncOnlyRejection);
}

/** Review-fix (or any sub-agent) code accepted when compliance passed or sync-only retry passed. */
export function reviewFixSubAgentAccepted(subAgent) {
  if (!subAgent) return false;
  if (subAgent.ok) return true;
  return subAgentSyncRetrySucceeded(subAgent.attempts);
}

export function foldRetryContext(baseTaskText, report, { workResult } = {}) {
  const errors = report?.errors ?? [];
  const notes = retryNotes(report);
  if (notes.length === 0) return null;

  const syncOnly = isSyncOnlyReport(report);
  const preamble = syncOnly
    ? 'Your CODE CHANGES were ACCEPTED — do NOT re-edit code, re-run tests, or redo the task. '
      + 'ONLY the repovine annotation sync is incomplete. '
      + `${syncOnlyAnnotationScope(workResult)} `
      + 'Use get_annotation_status({ "view": "queue", "scope": "<your subAgent scope>" }) — do NOT fail the run for infra:docker-compose or other nodes outside your assignment scope. '
      + 'Finish: refresh_context, write_annotation on those scoped nodes to `detailed` tier (fill missing fields), '
      + 'then refresh_context({ "cleanupOrphans": true }) and validate_annotations hard checks, then re-emit the result. '
      + 'Drain propagation-stale in scope too (refreshImportBaseline when upstream contract unchanged). '
      + 'Emit annotationsWritten only for nodes you actually wrote; omit phantom graph node ids.'
    : 'The previous attempt was rejected by repovine. Fix the issues below, then re-emit the result.';

  return `${baseTaskText}\n\n${preamble}\nrepovine issues: ${notes.join('; ')}`;
}

/**
 * A sync-only retry should prove graph/annotation cleanup without erasing the
 * accepted implementation attempt. Keep the latest compliance/status fields, but
 * union implementation-facing fields so handoffs and final replies stay honest.
 */
export function mergeSyncOnlyResult(workResult = {}, syncResult = {}) {
  const merged = {
    ...workResult,
    ...syncResult,
    compliance: {
      ...(workResult.compliance ?? {}),
      ...(syncResult.compliance ?? {}),
    },
  };

  const unionFields = [
    'scope',
    'filesChanged',
    'contractsChanged',
    'testsRun',
    'annotationsWritten',
    'blockers',
  ];
  for (const field of unionFields) {
    merged[field] = orderedUnion(workResult[field], syncResult[field]);
  }

  // Sync retry owns graph claims — unioning keeps phantom ids from the work attempt.
  const syncNodes = syncResult.graphNodesTouched ?? [];
  const workNodes = workResult.graphNodesTouched ?? [];
  merged.graphNodesTouched = syncNodes.length > 0 ? syncNodes : workNodes;

  const workSummary = String(workResult.summary ?? '').trim();
  const syncSummary = String(syncResult.summary ?? '').trim();
  if (workSummary && syncSummary && workSummary !== syncSummary) {
    merged.summary = SUMMARY_SYNC_ONLY.test(syncSummary)
      ? `${workSummary} repovine sync retry completed: ${syncSummary}`
      : `${workSummary} Follow-up retry completed: ${syncSummary}`;
  } else {
    merged.summary = syncSummary || workSummary || merged.summary;
  }

  return merged;
}
