// Target policy in scheduling and custody (Phase 2 shape): attach keeps
// sequential stages regardless of env toggles, and git-tree custody + in-repo
// patch apply work against the disposable repo behind the read-only pointer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { applyGreenfieldParallelStages } from '../lib/graph/plan.mjs';
import { deriveMultiRunStatus, useWorktreeExecution } from '../lib/graph/multi.mjs';
import { captureWorkspaceRevision } from '../lib/graph/workspace-revision.mjs';
import { execApplyPatch } from '../lib/workers/local.mjs';
import { runtimeCheckEnabled, runtimeCheckOverriddenByAttach } from '../lib/runtime-check.mjs';
import { makeAttachWorkspace } from './fixtures/attach-workspace.mjs';

const STAGES = [
  [{ role: 'infra', scope: ['infra'] }],
  [{ role: 'backend', scope: ['backend'] }],
  [{ role: 'frontend', scope: ['frontend'] }],
];

test('applyGreenfieldParallelStages: no Git-parallel capability → layout preserved, env override powerless', () => {
  const prev = process.env.HARNESS_GREENFIELD_PARALLEL;
  process.env.HARNESS_GREENFIELD_PARALLEL = '1';
  try {
    const out = applyGreenfieldParallelStages(STAGES, { greenfield: true, planMode: 'llm', gitOperationsAllowed: false });
    assert.deepEqual(out, STAGES, 'stages not collapsed');
    const collapsed = applyGreenfieldParallelStages(STAGES, { greenfield: true, planMode: 'llm', gitOperationsAllowed: true });
    assert.equal(collapsed[0].length, 3, 'sandbox still collapses implementers into one batch');
  } finally {
    if (prev === undefined) delete process.env.HARNESS_GREENFIELD_PARALLEL;
    else process.env.HARNESS_GREENFIELD_PARALLEL = prev;
  }
});

test('useWorktreeExecution: attach policy short-circuits before any Git probe or init', () => {
  let ensureRepoCalled = false;
  const out = useWorktreeExecution({
    greenfield: true,
    hasBatch: true,
    gitOperationsAllowed: false,
    ensureRepo: () => { ensureRepoCalled = true; return true; },
  });
  assert.equal(out, false);
  assert.equal(ensureRepoCalled, false, 'ensureGitRepo path never invoked under attach');
  assert.equal(
    useWorktreeExecution({ greenfield: true, hasBatch: true, gitOperationsAllowed: true, ensureRepo: () => true }),
    true,
  );
});

test('deriveMultiRunStatus: git-tree custody captures authoritative changed files behind the pointer', () => {
  const ws = makeAttachWorkspace();
  try {
    const baselineTree = captureWorkspaceRevision(ws.root, { backend: 'git-tree' });
    assert.ok(baselineTree, 'baseline captured through the disposable repo');
    fs.writeFileSync(path.join(ws.root, 'keep.txt'), 'v2\n');
    fs.writeFileSync(path.join(ws.root, 'new.txt'), 'n\n');

    const { signals } = deriveMultiRunStatus({
      repoRoot: ws.root,
      allSubAgents: [],
      subAgents: [],
      baselineTree,
    });
    assert.equal(signals.treeDiff.captured, true);
    assert.equal(signals.treeDiff.backend, 'git-tree');
    assert.deepEqual(signals.treeDiff.changedFiles, ['keep.txt', 'new.txt']);
    assert.equal(typeof signals.treeDiff.baselineTree, 'string', 'digest projection, not a revision object');
  } finally {
    ws.cleanup();
  }
});

const CREATE_PATCH = [
  '--- /dev/null',
  '+++ b/hello.txt',
  '@@ -0,0 +1 @@',
  '+hi',
  '',
].join('\n');

test('execApplyPatch: in-repo apply works in the attach workspace through the pointer', () => {
  const ws = makeAttachWorkspace();
  try {
    const r = execApplyPatch(ws.root, { patch: CREATE_PATCH });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.files_changed, ['hello.txt']);
    assert.equal(fs.readFileSync(path.join(ws.root, 'hello.txt'), 'utf8'), 'hi\n');
  } finally {
    ws.cleanup();
  }
});

test('runtime_check: attach forces it off (fails closed under locked egress); sandbox honors the flag', () => {
  const saved = { mode: process.env.HARNESS_TARGET_MODE, rc: process.env.HARNESS_RUNTIME_CHECK };
  try {
    // Attach + explicit opt-in → still off, and the override is reported.
    process.env.HARNESS_TARGET_MODE = 'attach';
    process.env.HARNESS_RUNTIME_CHECK = '1';
    assert.equal(runtimeCheckEnabled(), false, 'attach forces runtime_check off even with =1');
    assert.equal(runtimeCheckOverriddenByAttach(), true, 'the ignored opt-in is surfaced, not swallowed');

    // Sandbox honors the flag both ways.
    process.env.HARNESS_TARGET_MODE = 'sandbox';
    assert.equal(runtimeCheckEnabled(), true, 'sandbox respects HARNESS_RUNTIME_CHECK=1');
    assert.equal(runtimeCheckOverriddenByAttach(), false);
    process.env.HARNESS_RUNTIME_CHECK = '0';
    assert.equal(runtimeCheckEnabled(), false, 'sandbox respects HARNESS_RUNTIME_CHECK=0');
  } finally {
    if (saved.mode === undefined) delete process.env.HARNESS_TARGET_MODE;
    else process.env.HARNESS_TARGET_MODE = saved.mode;
    if (saved.rc === undefined) delete process.env.HARNESS_RUNTIME_CHECK;
    else process.env.HARNESS_RUNTIME_CHECK = saved.rc;
  }
});

test('execApplyPatch: path escapes stay rejected by the sandbox validation', () => {
  const ws = makeAttachWorkspace();
  const evil = [
    '--- /dev/null',
    '+++ b/../evil.txt',
    '@@ -0,0 +1 @@',
    '+x',
    '',
  ].join('\n');
  try {
    const r = execApplyPatch(ws.root, { patch: evil });
    assert.equal(r.ok, false);
    assert.match(r.error ?? r.rejected ?? '', /disallowed|apply/);
    assert.ok(!fs.existsSync(path.join(path.dirname(ws.root), 'evil.txt')), 'nothing written outside the workspace');
  } finally {
    ws.cleanup();
  }
});
