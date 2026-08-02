// Structured acceptance criteria + delivery verification for this demo harness.
// Orient records the sharpened criteria before implementation; the read-only
// verify sub-agent reports coverage claims that repovine re-checks against the
// assignment and observable repository state.
import { extractUserTask, stripPriorRunBlock } from './task-user.mjs';

/** @typedef {{ id: string, statement: string, required: boolean }} AcceptanceCriterion */

/** Stable id from a criterion statement (short slug). */
export function criterionIdFromStatement(statement, index = 0) {
  const slug = String(statement)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return slug ? `c-${slug}` : `c-${index + 1}`;
}

/**
 * Parse acceptance criteria orient emits as JSON objects in contractsChanged.
 * Each entry is `{ id?, statement, required? }` (object, or a JSON string once the
 * result normalizer has coerced it). Non-JSON / statement-less entries are skipped;
 * ids are minted from the statement when absent; deduped by id.
 */
// Invariant kind is EXPLICIT only: orient tags a regression guard {"kind":"invariant"}. No prose
// heuristic classifies it — a regex over "stays unchanged / не менялся" silently mislabels (a
// mislabelled delivery becomes a false exempt), and orient owns intent. An untagged regression guard
// stays a required delivery and honestly fails the run rather than passing on an untouched node.

export function parseAcceptanceCriteria(contracts = []) {
  /** @type {AcceptanceCriterion[]} */
  const out = [];
  for (const raw of contracts) {
    let obj = null;
    if (raw && typeof raw === 'object') {
      obj = raw;
    } else {
      const line = String(raw ?? '').trim();
      if (!line || line[0] !== '{') continue;
      try { obj = JSON.parse(line); } catch { continue; }
    }
    if (!obj || typeof obj !== 'object') continue;
    const statement = String(obj.statement ?? '').trim();
    if (!statement) continue;
    const id = obj.id ? String(obj.id) : criterionIdFromStatement(statement, out.length);
    if (out.some((c) => c.id === id)) continue;
    // Invariant only when orient tagged it explicitly; otherwise delivery. An invariant is advisory
    // (required:false, does not gate) and exempt from the change-set check.
    const kind = obj.kind === 'invariant' ? 'invariant' : 'delivery';
    out.push({ id, statement, required: kind === 'invariant' ? false : (obj.required ?? true), kind });
  }
  return out;
}

/** Default criteria from the user task when orient emitted none. */
export function inferCriteriaFromTask(taskOrText = '') {
  const t = typeof taskOrText === 'object'
    ? extractUserTask(taskOrText)
    : stripPriorRunBlock(String(taskOrText ?? '')).trim();
  if (!t) return [];
  return [{ id: 'c-user-request', statement: t.slice(0, 480), required: true }];
}

/** Merge orient criteria with the user-task fallback; dedupe by id. */
export function mergeCriteria(primary = [], fallback = []) {
  const byId = new Map();
  for (const c of [...primary, ...fallback]) {
    const statement = String(c?.statement ?? '').trim();
    if (!statement) continue;
    const id = c.id || criterionIdFromStatement(statement, byId.size);
    if (byId.has(id)) continue;
    byId.set(id, { id, statement, required: c.required ?? true, ...(c.kind === 'invariant' ? { kind: 'invariant' } : {}) });
  }
  return [...byId.values()];
}

/**
 * Build this demo's verification policy for a criteria set. The read-only verify
 * phase only produces repository anchors (no shell/tests/build), so the demo allows
 * only `repository`. repovine can re-check those anchors' graph grounding and optional
 * changed-set membership, not whether an anchor semantically proves the criterion.
 * `version` is set to the assignment counter compliance checks it against.
 */
export function buildVerificationPolicy(criteria = [], { version = 1 } = {}) {
  return {
    assuranceProfile: 'repository',
    version,
    requirements: criteria.map((c) => ({ criterionId: c.id, evidenceKinds: ['repository'] })),
  };
}

/**
 * Harness acceptance of a delivery verdict (fail-closed). False when the verdict is
 * absent, intentVerified is not true, or any REQUIRED criterion lacks a `covered`
 * result. This is the gate the harness threads into goal acceptance.
 */
export function deliveryVerificationAccepted(deliveryVerification, criteria = []) {
  if (!deliveryVerification || typeof deliveryVerification !== 'object') return false;
  if (deliveryVerification.verdict?.intentVerified !== true) return false;
  const byId = new Map((deliveryVerification.criteriaResults ?? []).map((r) => [r.criterionId, r]));
  for (const c of criteria) {
    if (!c?.required) continue;
    const r = byId.get(c.id);
    if (!r || r.status !== 'covered') return false;
  }
  return true;
}

/**
 * Roll criteria + their results into a display list for the card and telemetry.
 * `status` is display-only here: a criterion the verifier never resulted reads
 * `pending` (= not judged). The protocol CriterionResult.status the verifier emits
 * is only covered|gap|needs-developer — `pending` never leaves this display roll-up.
 */
export function mergeCriteriaResults(criteria = [], deliveryVerification = null) {
  const byId = new Map((deliveryVerification?.criteriaResults ?? []).map((r) => [r.criterionId, r]));
  return criteria.map((c) => {
    const r = byId.get(c.id);
    return {
      id: c.id,
      statement: c.statement,
      required: c.required ?? true,
      status: r?.status ?? 'pending',
    };
  });
}

/** Suggested implement scopes from graph node ids (pkg/backend/frontend/infra). */
export function scopesFromGraphNodes(nodeIds = []) {
  const scopes = new Set();
  for (const id of nodeIds) {
    if (!id || typeof id !== 'string') continue;
    const kind = id.split(':')[0];
    const tail = id.slice(id.indexOf(':') + 1);
    if (kind === 'infra' || (kind === 'domain' && tail.startsWith('infra-'))) {
      scopes.add('infra');
    } else if (kind === 'mod' || kind === 'pkg') {
      const slash = tail.indexOf('/');
      if (slash > 0) scopes.add(tail.slice(0, slash));
    }
  }
  if (!scopes.size) return [];
  return [...scopes];
}

/** Compact orient trail for assignment injection and human reply. */
export function buildOrientTrail(orientSubAgent, criteria = []) {
  const result = orientSubAgent?.result ?? {};
  const nodes = (result.graphNodesTouched ?? []).filter(Boolean);
  const scopes = scopesFromGraphNodes(nodes);
  const mcp = orientSubAgent?.mcp?.byTool ?? {};
  return {
    query: orientSubAgent?.orientQuery ?? null,
    summary: result.summary ?? '',
    graphNodes: nodes,
    suggestedScopes: scopes,
    criteria,
    mcpTools: Object.keys(mcp).sort(),
    contextSessionId: result.contextSessionId ?? orientSubAgent?.mcp?.contextSessionId ?? null,
  };
}
