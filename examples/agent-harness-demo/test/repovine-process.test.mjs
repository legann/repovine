import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVerificationPolicy,
  criterionIdFromStatement,
  deliveryVerificationAccepted,
  mergeCriteria,
  parseAcceptanceCriteria,
  scopesFromGraphNodes,
} from '../lib/delivery.mjs';
import {
  isOrientSubAgent,
  isRunGateSubAgent,
  isIgnorableOrientFailure,
  orientTask,
  repovineProcessEnabled,
  repovineProcessRunOk,
  repovineGoalOk,
} from '../lib/graph/repovine-process.mjs';
import { buildRepovineProcessSummary } from '../lib/telemetry.mjs';

test('parseAcceptanceCriteria reads JSON objects, skips non-JSON, mints ids', () => {
  const criteria = parseAcceptanceCriteria([
    'UNCHANGED: api ok',
    '{"statement":"badge clears after direct chat","required":true}',
    '{"id":"c-audit","statement":"audit log records each transition"}',
  ]);
  assert.equal(criteria.length, 2);
  assert.equal(criteria[0].id, 'c-badge-clears-after-direct-chat');
  assert.equal(criteria[0].required, true);
  assert.equal(criteria[1].id, 'c-audit');
  assert.equal(criteria[1].required, true);
});

test('parseAcceptanceCriteria accepts object entries and dedupes by id', () => {
  const criteria = parseAcceptanceCriteria([
    { id: 'c-a', statement: 'first' },
    { id: 'c-a', statement: 'second' },
    { statement: '   ' },
  ]);
  assert.equal(criteria.length, 1);
  assert.equal(criteria[0].statement, 'first');
});

test('scopesFromGraphNodes maps mod ids to package scopes', () => {
  const scopes = scopesFromGraphNodes([
    'mod:chat-backend/src/services/directMessageService',
    'mod:chat-frontend/src/app/services/user.service',
  ]);
  assert.deepEqual(scopes.sort(), ['chat-backend', 'chat-frontend']);
});

test('criterionIdFromStatement slugifies', () => {
  assert.equal(criterionIdFromStatement('Badge clears after chat'), 'c-badge-clears-after-chat');
});

test('mergeCriteria dedupes by id and defaults required', () => {
  const merged = mergeCriteria(
    [{ id: 'c-a', statement: 'first' }],
    [{ id: 'c-a', statement: 'second' }, { statement: 'user request fallback' }],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].statement, 'first');
  assert.equal(merged[0].required, true);
});

test('buildVerificationPolicy: repository per criterion, version 1', () => {
  const policy = buildVerificationPolicy([
    { id: 'c-a', statement: 'a', required: true },
    { id: 'c-b', statement: 'b', required: false },
  ]);
  assert.equal(policy.version, 1);
  assert.equal(policy.assuranceProfile, 'repository');
  assert.deepEqual(policy.requirements, [
    { criterionId: 'c-a', evidenceKinds: ['repository'] },
    { criterionId: 'c-b', evidenceKinds: ['repository'] },
  ]);
});

// ── deliveryVerificationAccepted: the enforcing gate predicate ─────────────────
const coveredResult = (id) => ({
  criterionId: id, status: 'covered',
  evidence: [{ kind: 'repository', graphNodeId: 'mod:a', explanation: 'x' }], explanation: 'x',
});

test('deliveryVerificationAccepted: all required covered + intentVerified → true', () => {
  const criteria = [{ id: 'c-a', statement: 'a', required: true }, { id: 'c-b', statement: 'b', required: false }];
  const dv = { criteriaResults: [coveredResult('c-a')], verdict: { protocolValid: true, intentVerified: true } };
  assert.equal(deliveryVerificationAccepted(dv, criteria), true);
});

test('deliveryVerificationAccepted: a required-criterion gap → false (enforcing)', () => {
  const criteria = [{ id: 'c-a', statement: 'a', required: true }];
  const dv = { criteriaResults: [{ criterionId: 'c-a', status: 'gap', evidence: [], explanation: 'x' }], verdict: { protocolValid: true, intentVerified: true } };
  assert.equal(deliveryVerificationAccepted(dv, criteria), false);
});

test('deliveryVerificationAccepted: intentVerified=false → false', () => {
  const criteria = [{ id: 'c-a', statement: 'a', required: true }];
  const dv = { criteriaResults: [coveredResult('c-a')], verdict: { protocolValid: true, intentVerified: false } };
  assert.equal(deliveryVerificationAccepted(dv, criteria), false);
});

test('deliveryVerificationAccepted: absent deliveryVerification → false (fail-closed)', () => {
  assert.equal(deliveryVerificationAccepted(null, [{ id: 'c-a', statement: 'a', required: true }]), false);
});

test('deliveryVerificationAccepted: a required criterion with no result → false', () => {
  const criteria = [{ id: 'c-a', statement: 'a', required: true }, { id: 'c-b', statement: 'b', required: true }];
  const dv = { criteriaResults: [coveredResult('c-a')], verdict: { protocolValid: true, intentVerified: true } };
  assert.equal(deliveryVerificationAccepted(dv, criteria), false);
});

test('repovineProcessRunOk ignores annotation-sync failures', () => {
  const subAgents = [
    { instanceId: 'orient', ok: true, role: 'repo-explorer' },
    { role: 'backend', ok: true, result: { status: 'complete' } },
    { role: 'frontend', ok: true, result: { status: 'complete' } },
    { instanceId: 'backend-annotations', ok: false, role: 'backend', result: { status: 'complete' } },
    { instanceId: 'verify', ok: true, role: 'review', result: { status: 'complete', summary: 'ok' } },
  ];
  assert.equal(
    repovineProcessRunOk({ subAgents, runtimeCheck: { ok: true, skipped: false }, reviewGateOpen: true }),
    true,
  );
});

test('repovineProcessRunOk ignores empty orient failure on new project', () => {
  const orient = {
    instanceId: 'orient',
    ok: false,
    orientTrail: { graphNodes: [] },
    role: 'repo-explorer',
    result: { status: 'complete', graphNodesTouched: [] },
  };
  const subAgents = [
    orient,
    { role: 'default', ok: true, result: { status: 'complete', filesChanged: ['package.json'] } },
  ];
  assert.equal(isIgnorableOrientFailure(orient, true), true);
  assert.equal(
    repovineProcessRunOk({ subAgents, runtimeCheck: { ok: true }, reviewGateOpen: true, greenfield: true }),
    true,
  );
  assert.equal(
    repovineProcessRunOk({ subAgents, runtimeCheck: { ok: true }, reviewGateOpen: true, greenfield: false }),
    false,
  );
});

test('repovineProcessRunOk fails when implement subAgent fails', () => {
  const subAgents = [
    { role: 'backend', ok: false, result: { status: 'complete' } },
  ];
  assert.equal(repovineProcessRunOk({ subAgents, runtimeCheck: { ok: true }, reviewGateOpen: true }), false);
});

test('repovineGoalOk passes when verify/runtime/code ok despite implement compliance fail', () => {
  const subAgents = [
    { instanceId: 'verify', ok: true, role: 'review', result: { status: 'complete', summary: 'ok' } },
    { role: 'backend', ok: false, result: { status: 'complete', filesChanged: ['backend/src/a.ts'] } },
    { role: 'frontend', ok: true, result: { status: 'complete', filesChanged: ['frontend/src/b.tsx'] } },
  ];
  assert.equal(repovineGoalOk({ subAgents, runtimeCheck: { ok: true } }), true);
  assert.equal(repovineProcessRunOk({ subAgents, runtimeCheck: { ok: true }, reviewGateOpen: true }), false);
});

test('repovineGoalOk fails when verify fails', () => {
  const subAgents = [
    { instanceId: 'verify', ok: false, role: 'review', result: { status: 'complete' } },
    { role: 'backend', ok: true, result: { status: 'complete', filesChanged: ['backend/src/a.ts'] } },
  ];
  assert.equal(repovineGoalOk({ subAgents, runtimeCheck: { ok: true } }), false);
});

test('isRunGateSubAgent excludes orient and annotation sync', () => {
  assert.equal(isRunGateSubAgent({ instanceId: 'orient', ok: true }), false);
  assert.equal(isRunGateSubAgent({ instanceId: 'backend-annotations', ok: true }), false);
  assert.equal(isRunGateSubAgent({ role: 'backend', ok: true }), true);
});

test('repovineProcessEnabled defaults on', () => {
  const prev = process.env.HARNESS_REPOVINE_PROCESS;
  delete process.env.HARNESS_REPOVINE_PROCESS;
  assert.equal(repovineProcessEnabled(), true);
  process.env.HARNESS_REPOVINE_PROCESS = '0';
  assert.equal(repovineProcessEnabled(), false);
  if (prev === undefined) delete process.env.HARNESS_REPOVINE_PROCESS;
  else process.env.HARNESS_REPOVINE_PROCESS = prev;
});

test('isOrientSubAgent', () => {
  assert.equal(isOrientSubAgent({ instanceId: 'orient' }), true);
  assert.equal(isOrientSubAgent({ role: 'repo-explorer' }), false);
});

test('orientTask includes greenfield section when greenfield', () => {
  const task = orientTask('build chat from scratch', null, { greenfield: true });
  assert.match(task, /New project \(greenfield sandbox\)/);
  assert.match(task, /graphNodesTouched may be \[\]/);
});

test('orientTask includes CLI pre-orient hints', () => {
  const task = orientTask('fix unread badge', {
    graphNodes: ['mod:chat-backend/src/routes/messages'],
    search: { summary: 'Found messages route' },
    traceFlow: { summary: 'Traced SSE' },
    traceScope: 'chat-backend',
  });
  assert.match(task, /CLI pre-orient/);
  assert.match(task, /acceptance criteria/i);
  assert.match(task, /flowChecked/);
  assert.match(task, /chat-backend/);
});

test('buildRepovineProcessSummary includes orient criteria and verify verdict', () => {
  const summary = buildRepovineProcessSummary({
    task: { id: 'run-1' },
    repovineOrientTrail: {
      graphNodes: ['mod:a', 'mod:b'],
      cliPreOrient: { flowChecked: true, traceScope: 'a' },
    },
    repovineCriteria: [{ id: 'c-1', statement: 'badge clears', required: true }],
    subAgents: [
      { instanceId: 'orient', ok: true, result: { compliance: { flowChecked: true } } },
      {
        instanceId: 'verify', ok: true,
        result: {
          summary: 'all criteria covered',
          deliveryVerification: { criteriaResults: [coveredResult('c-1')], verdict: { protocolValid: true, intentVerified: true } },
        },
      },
    ],
  });
  assert.equal(summary.orient.graphNodeCount, 2);
  assert.equal(summary.orient.flowChecked, true);
  assert.equal(summary.criteria.length, 1);
  assert.equal(summary.criteria[0].status, 'covered');
  assert.equal(summary.verify.verdict.intentVerified, true);
  assert.equal(summary.artifacts.orient, 'orient.json');
});
