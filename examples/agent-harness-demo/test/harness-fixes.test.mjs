import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUserTask, stripPriorRunBlock } from '../lib/task-user.mjs';
import { isOutOfScopeInfraBlocker, subAgentGateEffectivelyOk } from '../lib/blockers.mjs';
import {
  complianceAccepted,
  complianceReport,
  isRetriable,
  isSyncOnlyReport,
  requiredFieldsRejected,
  shouldDeferImplementAnnotationRetry,
} from '../lib/graph/retry.mjs';
import { knownRoles, manifestForRole } from '../lib/agents.mjs';
import { agents, harnessBrief } from '../lib/repovine.mjs';
import { resolveHarnessBrief } from '../lib/workers/prompt.mjs';

test('stripPriorRunBlock keeps user typing task', () => {
  const raw = '## Prior harness run (compact)\nmeta\n\nDirect chat: typing indicator.\nThrottle 300ms.';
  assert.match(stripPriorRunBlock(raw), /Direct chat: typing/);
  assert.doesNotMatch(stripPriorRunBlock(raw), /Prior harness run/);
});

test('extractUserTask prefers task.userTask', () => {
  const t = extractUserTask({
    userTask: 'Direct chat: typing',
    task: '## Prior harness run\n\nDirect chat: typing',
  });
  assert.equal(t, 'Direct chat: typing');
});

test('isOutOfScopeInfraBlocker detects docker-compose outside frontend', () => {
  assert.equal(
    isOutOfScopeInfraBlocker(
      'validate_annotations reports needsWork=1 for infra:docker-compose:docker-compose.yml (infra scope, outside frontend sub-agent)',
      ['frontend'],
    ),
    true,
  );
  assert.equal(isOutOfScopeInfraBlocker('infra:docker-compose stale', ['infra']), false);
});

test('subAgentGateEffectivelyOk accepts implement with only out-of-scope infra blockers', () => {
  const subAgent = {
    ok: false,
    scope: ['frontend'],
    result: {
      status: 'complete',
      filesChanged: ['frontend/src/app/services/direct-chat.service.ts'],
      blockers: [
        'validate_annotations reports needsWork=1 for infra:docker-compose:docker-compose.yml outside frontend sub-agent',
      ],
    },
  };
  assert.equal(subAgentGateEffectivelyOk(subAgent), true);
});

test('shouldDeferImplementAnnotationRetry skips sync-only retry after code delivery', () => {
  const result = { status: 'complete', filesChanged: ['backend/src/routes/direct.ts'] };
  const report = { valid: false, errors: ['Annotation coverage incomplete in scope (1 node(s) unannotated/stale): mod:x (stale).'] };
  const assignment = { contextSession: { phase: 'implement' } };
  assert.equal(shouldDeferImplementAnnotationRetry(result, report, assignment), true);
});

// ── Brief resolution: every role's manifest must exist in the engine ───────────
// The bug this guards: the harness asked run-brief for role "repo-explorer" while the
// engine enum says "explorer". No manifest resolved, the brief silently degraded to a
// 4-line stub, and the orient + review sub-agents ran without the honesty rules or the
// result-block contract. A name that resolves to nothing must fail here, not in a run.
test('every ROLES manifest name resolves to a built-in engine manifest', () => {
  const listed = agents(['manifests'], { repoRoot: process.cwd() });
  const manifests = listed.json?.manifests ?? listed.json ?? [];
  assert.ok(Array.isArray(manifests) && manifests.length > 0, 'engine listed no manifests');
  const names = new Set(manifests.map((m) => m.name));

  for (const role of knownRoles()) {
    const name = manifestForRole(role);
    assert.ok(name, `role "${role}" has no manifest — its result is unchecked and its brief is a stub`);
    assert.ok(names.has(name), `role "${role}" points at unknown manifest "${name}" (known: ${[...names].join(', ')})`);
  }
});

test('run-brief resolves a real brief for every role manifest', () => {
  for (const role of knownRoles()) {
    const brief = harnessBrief(process.cwd(), { name: manifestForRole(role) });
    assert.ok(brief && brief.length > 500, `role "${role}" got no engine brief (fell back to the stub)`);
    assert.match(brief, /AgentRunResult/, `role "${role}" brief carries no result-block contract`);
    assert.match(brief, /Honesty rules/, `role "${role}" brief carries no honesty rules`);
  }
});

// The phase fallback (used when a spec carries no manifest) must name roles the engine
// knows. "repo-explorer" is not one of them — that name resolved to nothing and shipped
// the stub brief to the orient and review sub-agents without a word in the log.
test('resolveHarnessBrief: every assignment phase falls back to a real engine brief', () => {
  for (const phase of ['explore', 'implement', 'annotate']) {
    const brief = resolveHarnessBrief(process.cwd(), { contextSession: { phase } }, undefined);
    assert.match(brief, /Honesty rules/, `phase "${phase}" degraded to the stub brief`);
    assert.match(brief, /AgentRunResult/, `phase "${phase}" degraded to the stub brief`);
  }
});

// ── An invented node id is a false claim, not an annotation-sync gap ───────────
test('isSyncOnlyReport: an unresolved graph node is NOT sync-only (it gets retried)', () => {
  const report = { valid: false, errors: ['Declared graphNodesTouched not found in graph: pkg:todo-app.'] };
  assert.equal(isSyncOnlyReport(report), false);
  // ...so the implement sub-agent retries and fixes the id instead of deferring it.
  const result = { status: 'complete', filesChanged: ['package.json'] };
  const assignment = { contextSession: { phase: 'implement' } };
  assert.equal(shouldDeferImplementAnnotationRetry(result, report, assignment), false);
  assert.equal(isRetriable(result, report, assignment), true);
});

// ── Missing manifest-required fields reject the run ────────────────────────────
test('requiredFieldsRejected: a role that omits its required field is not accepted', () => {
  const report = {
    valid: true,
    errors: [],
    requiredFollowups: ['Populate required result field(s): review.'],
  };
  assert.equal(requiredFieldsRejected(report), true);
  assert.equal(complianceAccepted(report), false);
  assert.equal(isSyncOnlyReport(report), false, 'no annotation subAgent can re-emit a missing field');
});

// ── A schema-invalid result must reach the retry, not pass as final ────────────
test('complianceReport: schema failure becomes a retriable report', () => {
  const cc = {
    schemaValid: false,
    schemaErrors: ['testsRun.0: Invalid input: expected string, received object'],
  };
  const report = complianceReport(cc);
  assert.equal(complianceAccepted(report), false);
  assert.match(report.errors[0], /schema validation/);
  const result = { status: 'complete', filesChanged: [] };
  assert.equal(isRetriable(result, report, { contextSession: { phase: 'explore' } }), true);
});

test('complianceReport: a normal report passes through untouched', () => {
  const report = { valid: true, errors: [] };
  assert.equal(complianceReport({ schemaValid: true, report }), report);
});
