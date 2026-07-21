import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyVerifyOutcomes,
  claimIdFromText,
  mergeClaims,
  parseClaimsFromContracts,
  parseVerifyOutcomes,
  scopesFromGraphNodes,
} from '../lib/claims.mjs';
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

test('parseClaimsFromContracts extracts CLAIM lines', () => {
  const claims = parseClaimsFromContracts([
    'UNCHANGED: api ok',
    'CLAIM: badge clears after direct chat',
  ]);
  assert.equal(claims.length, 1);
  assert.match(claims[0].text, /badge clears/i);
});

test('scopesFromGraphNodes maps mod ids to package scopes', () => {
  const scopes = scopesFromGraphNodes([
    'mod:chat-backend/src/services/directMessageService',
    'mod:chat-frontend/src/app/services/user.service',
  ]);
  assert.deepEqual(scopes.sort(), ['chat-backend', 'chat-frontend']);
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

test('claimIdFromText slugifies', () => {
  assert.equal(claimIdFromText('Badge clears after chat'), 'c-badge-clears-after-chat');
});

test('mergeClaims dedupes by id', () => {
  const merged = mergeClaims(
    [{ id: 'c-a', text: 'first' }],
    [{ id: 'c-a', text: 'second' }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, 'first');
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
  assert.match(task, /CLAIM:/);
  assert.match(task, /flowChecked/);
  assert.match(task, /chat-backend/);
});

test('buildRepovineProcessSummary includes orient and verify', () => {
  const summary = buildRepovineProcessSummary({
    task: { id: 'run-1' },
    repovineOrientTrail: {
      graphNodes: ['mod:a', 'mod:b'],
      cliPreOrient: { flowChecked: true, traceScope: 'a' },
    },
    repovineClaims: [{ id: 'c-1', text: 'badge clears', status: 'pending' }],
    subAgents: [
      { instanceId: 'orient', ok: true, result: { compliance: { flowChecked: true } } },
      { instanceId: 'verify', ok: true, result: { summary: 'all claims covered' } },
    ],
  });
  assert.equal(summary.orient.graphNodeCount, 2);
  assert.equal(summary.orient.flowChecked, true);
  assert.equal(summary.claims.length, 1);
  assert.equal(summary.verify.ok, true);
  assert.equal(summary.artifacts.orient, 'orient.json');
});

test('parseVerifyOutcomes: reads covered/gap, ignores non-outcomes', () => {
  const out = parseVerifyOutcomes([
    'UNCHANGED: api ok',
    'VERIFY: covered — c-badge-clears — badge state resets on open',
    'VERIFY: gap — c-sound-plays — no audio path in the diff',
    'VERIFY: bogus — c-x — not an outcome',
  ]);
  assert.deepEqual(out, [
    { id: 'c-badge-clears', status: 'covered', reason: 'badge state resets on open' },
    { id: 'c-sound-plays', status: 'gap', reason: 'no audio path in the diff' },
  ]);
});

test('applyVerifyOutcomes: claim ids survive their own hyphens', () => {
  const applied = applyVerifyOutcomes(
    [
      { id: 'c-badge-clears', text: 'badge clears', status: 'pending' },
      { id: 'c-sound-plays', text: 'sound plays', status: 'pending' },
    ],
    ['VERIFY: covered — c-badge-clears — reset on open', 'VERIFY: gap — c-sound-plays — missing'],
  );
  assert.equal(applied[0].status, 'covered');
  assert.equal(applied[0].verifyReason, 'reset on open');
  assert.equal(applied[1].status, 'gap');
});

test('applyVerifyOutcomes: an unjudged claim stays pending, never covered', () => {
  const applied = applyVerifyOutcomes(
    [{ id: 'c-a', text: 'a', status: 'pending' }, { id: 'c-b', text: 'b', status: 'pending' }],
    ['VERIFY: covered — c-a — done'],
  );
  assert.equal(applied[0].status, 'covered');
  assert.equal(applied[1].status, 'pending');
});

test('applyVerifyOutcomes: tolerates a dropped c- prefix and a spaced hyphen', () => {
  const applied = applyVerifyOutcomes(
    [{ id: 'c-badge-clears', text: 'badge clears', status: 'pending' }],
    ['VERIFY: covered - badge-clears - ok'],
  );
  assert.equal(applied[0].status, 'covered');
});

test('applyVerifyOutcomes: no VERIFY lines leaves claims untouched', () => {
  const claims = [{ id: 'c-a', text: 'a', status: 'pending' }];
  assert.equal(applyVerifyOutcomes(claims, ['UNCHANGED: x']), claims);
});
