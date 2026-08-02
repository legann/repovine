// Capability gates on the green baseline: tri-state runtime/verification,
// review acceptance + freshness, exact goal status, full-stack frame,
// scope-grounded test floor, continuation planning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runtimeStatusOf, runtimeAcceptedOf, runtimeRequired } from '../lib/runtime-check.mjs';
import {
  subAgentCsqOnlyDelivered,
  repovineProcessRunOk,
  repovineGoalOk,
  verificationStatusOf,
  verificationAcceptedOf,
} from '../lib/graph/repovine-process.mjs';
import {
  assembleFixBlockers,
  deriveMultiRunStatus,
  gradePlanFindings,
  findAcceptanceReviewSubAgent,
  markReviewedRevision,
  reviewIsFresh,
  reviewProcessValid,
  reviewAcceptedOf,
} from '../lib/graph/multi.mjs';
import { normalizeResult } from '../lib/claude-agent.mjs';
import { synthResult } from '../lib/workers/local.mjs';
import {
  TEST_FILE_RE,
  subAgentTestScanDirs,
  missingTestFloorBlockers,
} from '../lib/graph/test-floor.mjs';
import { appFrameRoles, roleRequiresTests } from '../lib/agents.mjs';
import { planSubAgentsAsync, applyAppFrame, applyGreenfieldParallelStages, greenfieldParallelEnabled, planSubAgents, scheduleStages, assignSubAgentInstanceIds, stripAnnotationStages } from '../lib/graph/plan.mjs';
import { collectAnnotationObligations } from '../lib/graph/annotation-obligations.mjs';
import { isGreenfieldContext } from '../lib/graph/workspace-state.mjs';
import { captureWorkspaceRevision, diffChangedFiles } from '../lib/graph/workspace-revision.mjs';
import { ensureGitRepo } from '../lib/graph/worktree.mjs';
import { readPriorRunSummary } from '../lib/harness-run.mjs';

const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
// Sandbox-mode custody backend, matching multi.mjs REVISION_BACKEND.
const captureTree = (root) => captureWorkspaceRevision(root, { backend: 'git-tree' });
const write = (root, rel, body = 'x\n') => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};

function applyEnv(overrides) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

function withEnv(overrides, fn) {
  const restore = applyEnv(overrides);
  try {
    return fn();
  } finally {
    restore();
  }
}

async function withEnvAsync(overrides, fn) {
  const restore = applyEnv(overrides);
  try {
    return await fn();
  } finally {
    restore();
  }
}

// ── B2: tri-state runtime + verification ───────────────────────────────────────

test('runtimeStatusOf/runtimeAcceptedOf: truth table incl. required+skipped ≠ accepted', () => {
  assert.equal(runtimeStatusOf(null, true), 'failed');
  assert.equal(runtimeStatusOf(null, false), 'skipped');
  assert.equal(runtimeStatusOf({ ok: true, skipped: false }, true), 'passed');
  assert.equal(runtimeStatusOf({ ok: false, skipped: false }, false), 'failed');
  assert.equal(runtimeStatusOf({ ok: true, skipped: true }, true), 'skipped');

  assert.equal(runtimeAcceptedOf({ ok: true, skipped: false }, true), true);
  assert.equal(runtimeAcceptedOf({ ok: true, skipped: true }, true), false, 'required + skipped is not accepted');
  assert.equal(runtimeAcceptedOf({ ok: true, skipped: true }, false), true);
  assert.equal(runtimeAcceptedOf(null, true), false, 'phase never ran but required → fail-closed');
  assert.equal(runtimeAcceptedOf(null, false), true);
  assert.equal(runtimeAcceptedOf({ ok: false, skipped: false }, false), false);
});

test('runtimeRequired: enabled + package.json present', () => {
  const root = tmpDir('rt-req-');
  try {
    withEnv({ HARNESS_RUNTIME_CHECK: undefined }, () => {
      assert.equal(runtimeRequired(root), false, 'no package.json → not required');
      write(root, 'package.json', '{}');
      assert.equal(runtimeRequired(root), true);
    });
    withEnv({ HARNESS_RUNTIME_CHECK: '0' }, () => {
      assert.equal(runtimeRequired(root), false, 'disabled → not required');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verificationStatusOf/verificationAcceptedOf: missing subAgent fails closed when required', () => {
  assert.equal(verificationStatusOf(null, true), 'failed');
  assert.equal(verificationStatusOf(null, false), 'skipped');
  assert.equal(verificationStatusOf({ ok: true }, true), 'passed');
  assert.equal(verificationStatusOf({ ok: false }, false), 'failed');

  assert.equal(verificationAcceptedOf({ ok: true }, true), true);
  assert.equal(verificationAcceptedOf(null, true), false);
  assert.equal(verificationAcceptedOf(null, false), true);
  assert.equal(verificationAcceptedOf({ ok: false }, false), false, 'a failed verify is never accepted');
});

// ── B3: review process vs acceptance + freshness ───────────────────────────────

const validReviewSubAgent = (over = {}) => ({
  role: 'review',
  ok: true,
  result: {
    status: 'complete',
    review: { verdict: 'approve', findings: [], ...(over.review ?? {}) },
    ...(over.result ?? {}),
  },
  ...over.subAgent,
});

test('reviewProcessValid: subAgent accepted + complete + review present + fresh', () => {
  assert.equal(reviewProcessValid(validReviewSubAgent(), { fresh: true }), true);
  assert.equal(reviewProcessValid(validReviewSubAgent(), { fresh: false }), false, 'stale tree invalidates the review');
  assert.equal(reviewProcessValid(validReviewSubAgent({ subAgent: { ok: false } }), { fresh: true }), false);
  assert.equal(reviewProcessValid(validReviewSubAgent({ result: { status: 'partial' } }), { fresh: true }), false);
  const noReview = { role: 'review', ok: true, result: { status: 'complete' } };
  assert.equal(reviewProcessValid(noReview, { fresh: true }), false, 'verdict unreadable without a review object');
  assert.equal(reviewProcessValid(null, { fresh: true }), false);
});

test('reviewAcceptedOf: verdict is read; blocker/major findings close acceptance', () => {
  assert.equal(reviewAcceptedOf(validReviewSubAgent(), { fresh: true }), true);
  assert.equal(reviewAcceptedOf(validReviewSubAgent(), { fresh: false }), false, 'post-review mutation ≠ accepted');
  assert.equal(
    reviewAcceptedOf(validReviewSubAgent({ review: { verdict: 'changes-requested' } }), { fresh: true }),
    false,
  );
  assert.equal(
    reviewAcceptedOf(validReviewSubAgent({ review: { findings: [{ severity: 'major', summary: 'x' }] } }), { fresh: true }),
    false,
  );
  assert.equal(
    reviewAcceptedOf(validReviewSubAgent({ review: { findings: [{ severity: 'minor', summary: 'x' }] } }), { fresh: true }),
    true,
    'minor/nit findings do not close acceptance',
  );
});

test('assembleFixBlockers: floor blockers join the fix ledger; unparseable review blockers dropped', () => {
  const review = { role: 'review', ok: true, schemaValid: true, handoff: { blockers: ['review blocker'] }, result: {} };
  assert.deepEqual(assembleFixBlockers(review, ['floor blocker']), ['review blocker', 'floor blocker']);
  const cleanReview = { role: 'review', ok: true, schemaValid: true, handoff: { blockers: [] }, result: {} };
  assert.deepEqual(assembleFixBlockers(cleanReview, ['floor blocker']), ['floor blocker'], 'clean review + red floor still enters the fix cycle');
  const invalid = { role: 'review', ok: false, schemaValid: false, handoff: { blockers: ['untrusted'] }, result: {} };
  assert.deepEqual(assembleFixBlockers(invalid, []), [], 'schema-invalid review blockers are untrustworthy');
  assert.deepEqual(assembleFixBlockers(invalid, ['floor blocker']), ['floor blocker'], 'deterministic blockers survive an unreadable review');
});

test('assembleFixBlockers: a changes-requested verdict delivers ALL its findings to the fix cycle', () => {
  // The reviewer's requested changes ARE its findings — a minor-only
  // changes-requested must not be terminal (acceptance closed, fix input empty).
  const subAgent = (verdict, findings) => ({
    role: 'review', ok: true, schemaValid: true,
    handoff: { blockers: [] },
    result: { status: 'complete', review: { verdict, findings } },
  });
  const findings = [
    { severity: 'major', summary: 'zero coverage for new behaviors', recommendation: 'add RTL cases' },
    { severity: 'minor', summary: 'style nit' },
  ];

  const changesRequested = assembleFixBlockers(subAgent('changes-requested', findings), []);
  assert.equal(changesRequested.length, 2, 'changes-requested: every finding is actionable');
  assert.match(changesRequested[0], /\[review:major\] zero coverage/);
  assert.match(changesRequested[0], /fix: add RTL cases/);
  assert.match(changesRequested[1], /\[review:minor\] style nit/);

  const minorOnly = assembleFixBlockers(subAgent('changes-requested', [{ severity: 'minor', summary: 'style nit' }]), []);
  assert.equal(minorOnly.length, 1, 'minor-only changes-requested gets a fix transition');

  const needsHuman = assembleFixBlockers(subAgent('needs-human', findings), []);
  assert.equal(needsHuman.length, 1, 'other verdicts: only blocker/major findings are actionable');

  const schemaInvalid = { ...subAgent('changes-requested', findings), schemaValid: false };
  assert.deepEqual(assembleFixBlockers(schemaInvalid, []), [], 'unparseable result contributes nothing');
});

test('findAcceptanceReviewSubAgent: the freshest full review owns acceptance (post-fix re-review wins)', () => {
  const first = validReviewSubAgent();
  const reReview = { ...validReviewSubAgent(), instanceId: 'post-review' };
  assert.equal(findAcceptanceReviewSubAgent([{ role: 'backend' }, first, reReview]), reReview);
  assert.equal(findAcceptanceReviewSubAgent([{ role: 'backend' }, first]), first);
  assert.equal(findAcceptanceReviewSubAgent([]), null);
});

test('reviewIsFresh: harness revisions; annotation-only mutation stays fresh; fail-closed on nulls', () => {
  const root = tmpDir('rev-fresh-');
  try {
    write(root, 'a.txt', 'alpha\n');
    write(root, 'repovine.annots.json', '{"version":1,"annotations":{}}\n');
    assert.equal(ensureGitRepo(root), true);
    const reviewed = captureTree(root);
    assert.ok(reviewed);
    assert.equal(reviewIsFresh({ repoRoot: root, reviewedRevision: reviewed, currentTree: reviewed }), true);

    // Annotation sync mutates only repovine.annots.json → excluded from the diff → still fresh.
    write(root, 'repovine.annots.json', '{"version":1,"annotations":{"mod:a":1}}\n');
    const afterAnnots = captureTree(root);
    assert.notEqual(afterAnnots.digest, reviewed.digest, 'tree oid moves');
    assert.equal(reviewIsFresh({ repoRoot: root, reviewedRevision: reviewed, currentTree: afterAnnots }), true);

    // A code mutation after review is stale.
    write(root, 'a.txt', 'alpha-edited\n');
    const afterCode = captureTree(root);
    assert.equal(reviewIsFresh({ repoRoot: root, reviewedRevision: reviewed, currentTree: afterCode }), false);

    assert.equal(reviewIsFresh({ repoRoot: root, reviewedRevision: null, currentTree: afterCode }), false);
    assert.equal(reviewIsFresh({ repoRoot: root, reviewedRevision: reviewed, currentTree: null }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── B1: fail-closed capture ─────────────────────────────────────────────────────

test('captureWorkspaceRevision/diffChangedFiles: uncapturable workspace fails closed (null)', () => {
  const missing = path.join(os.tmpdir(), 'ws-rev-does-not-exist-xyz');
  assert.equal(captureTree(missing), null);
  const root = tmpDir('rev-null-');
  try {
    const rev = { backend: 'git-tree', repoRoot: root, digest: 'deadbeef' };
    assert.equal(diffChangedFiles(null, rev), null);
    assert.equal(diffChangedFiles(rev, null), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── B5: exact goal status ────────────────────────────────────────────────────

test('repovineGoalOk(signals): runtime && verification && (!reviewRequired || reviewAccepted)', () => {
  const ok = { runtimeAccepted: true, verificationAccepted: true, reviewRequired: false, reviewAccepted: null };
  assert.equal(repovineGoalOk({ signals: ok }), true);
  assert.equal(repovineGoalOk({ signals: { ...ok, runtimeAccepted: false } }), false);
  assert.equal(repovineGoalOk({ signals: { ...ok, verificationAccepted: false } }), false);
  assert.equal(repovineGoalOk({ signals: { ...ok, reviewRequired: true } }), false, 'required review, verdict null → not ok');
  assert.equal(repovineGoalOk({ signals: { ...ok, reviewRequired: true, reviewAccepted: false } }), false);
  assert.equal(repovineGoalOk({ signals: { ...ok, reviewRequired: true, reviewAccepted: true } }), true);
});

test('repovineGoalOk without signals keeps the legacy delivery heuristic', () => {
  const delivering = {
    role: 'backend', ok: true,
    result: { status: 'complete', filesChanged: ['backend/a.ts'] },
  };
  assert.equal(repovineGoalOk({ subAgents: [delivering], runtimeCheck: null }), true);
  assert.equal(
    repovineGoalOk({ subAgents: [delivering], runtimeCheck: { ok: false, skipped: false } }),
    false,
  );
});

// ── WS-C: full-stack frame ──────────────────────────────────────────────────────

test('appFrameRoles: defaults to infra/backend/frontend; HARNESS_APP_FRAME overrides', () => {
  withEnv({ HARNESS_APP_FRAME: undefined }, () => {
    assert.deepEqual(appFrameRoles().sort(), ['backend', 'frontend', 'infra']);
  });
  withEnv({ HARNESS_APP_FRAME: 'none' }, () => assert.deepEqual(appFrameRoles(), []));
  withEnv({ HARNESS_APP_FRAME: '0' }, () => assert.deepEqual(appFrameRoles(), []));
  withEnv({ HARNESS_APP_FRAME: 'backend,frontend' }, () => {
    assert.deepEqual(appFrameRoles().sort(), ['backend', 'frontend']);
  });
});

test('stripAnnotationStages: planner annotate stages drop; all-annotation and clean plans pass through', () => {
  const plan = {
    mode: 'auto',
    specs: [
      { role: 'backend', scope: ['backend'] },
      { role: 'annotation-writer', scope: ['backend'] },
      { role: 'annotation-writer', scope: ['frontend'] },
      { role: 'review', scope: ['.'] },
    ],
  };
  const stripped = stripAnnotationStages(plan);
  assert.deepEqual(stripped.specs.map((s) => s.role), ['backend', 'review']);
  assert.deepEqual(stripped.droppedAnnotationRoles, ['annotation-writer', 'annotation-writer']);
  // Degenerate all-annotation plan is left unchanged (stripping would empty the run).
  const allAnnot = { mode: 'auto', specs: [{ role: 'annotation-writer', scope: ['.'] }] };
  assert.equal(stripAnnotationStages(allAnnot), allAnnot);
  // A plan with no annotate stage is returned as-is.
  const clean = { mode: 'auto', specs: [{ role: 'backend', scope: ['backend'] }] };
  assert.equal(stripAnnotationStages(clean), clean);
});

test('collectAnnotationObligations: run-start snapshot wins over the on-disk store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obligations-snapshot-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'repovine.annots.json'),
      JSON.stringify({ annotations: { 'mod:a': { annotation: { invariants: ['REWRITTEN mid-run'] } } } }),
    );
    const snapshot = { 'mod:a': { annotation: { invariants: ['PRIOR run contract'] } } };
    const fromSnapshot = collectAnnotationObligations(dir, ['mod:a'], { snapshot });
    assert.equal(fromSnapshot.length, 1);
    assert.match(fromSnapshot[0].text, /PRIOR run contract/);
    const fromDisk = collectAnnotationObligations(dir, ['mod:a']);
    assert.match(fromDisk[0].text, /REWRITTEN mid-run/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applyAppFrame: greenfield build plan gets missing frame roles injected, canonical order', () => {
  const root = tmpDir('frame-gf-');
  try {
    withEnv({ HARNESS_APP_FRAME: undefined, HARNESS_FORCE_MULTI: undefined }, () => {
      const task = { task: 'Build a todo app with a backend API and a frontend UI' };
      const plan = planSubAgents(task, root);
      assert.deepEqual(plan.specs.map((s) => s.role), ['backend', 'frontend']);
      const framed = applyAppFrame(plan, task, root);
      assert.deepEqual([...framed.specs.map((s) => s.role)].sort(), ['backend', 'frontend', 'infra']);
      assert.deepEqual(framed.injectedFrameRoles, ['infra']);
      // scheduleStages orders the frame canonically without dependsOn.
      const stages = scheduleStages(assignSubAgentInstanceIds(framed.specs));
      assert.deepEqual(stages.map((s) => s.map((x) => x.role)), [['infra'], ['backend'], ['frontend']]);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('applyAppFrame: a plan with no frame role (question/doc task) is not a build plan', () => {
  const root = tmpDir('frame-doc-');
  try {
    withEnv({ HARNESS_APP_FRAME: undefined, HARNESS_FORCE_MULTI: undefined }, () => {
      const task = { task: 'Summarize the architecture decisions in a doc' };
      const plan = planSubAgents(task, root);
      assert.deepEqual(plan.specs.map((s) => s.role), ['default']);
      const framed = applyAppFrame(plan, task, root);
      assert.deepEqual(framed.specs.map((s) => s.role), ['default'], 'frame does not fire');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('applyAppFrame: continuation (existing product) is never force-framed', () => {
  const root = tmpDir('frame-cont-');
  try {
    write(root, 'package.json', '{}');
    write(root, 'backend/src/index.ts');
    write(root, 'frontend/src/main.tsx');
    write(root, 'repovine.annots.json', JSON.stringify({ version: 1, annotations: { 'mod:backend/src/index': { summary: 'x' } } }));
    withEnv({ HARNESS_APP_FRAME: undefined, HARNESS_FORCE_MULTI: undefined }, () => {
      const task = { task: 'Add subtasks support to the backend API and the frontend list UI' };
      assert.equal(isGreenfieldContext({ repoRoot: root }), false);
      const plan = planSubAgents(task, root);
      const framed = applyAppFrame(plan, task, root);
      assert.deepEqual(framed.specs.map((s) => s.role), ['backend', 'frontend'], 'no infra re-scaffold');
      assert.equal(framed.injectedFrameRoles, undefined);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('planSubAgentsAsync: frame injected on greenfield; HARNESS_GREENFIELD_SINGLE still collapses; explicit exempt', async () => {
  const root = tmpDir('frame-async-');
  try {
    await withEnvAsync(
      { AGENTS: undefined, HARNESS_APP_FRAME: undefined, HARNESS_FORCE_MULTI: undefined, HARNESS_GREENFIELD_SINGLE: undefined },
      async () => {
        const task = { task: 'Build a todo app with a backend API and a frontend UI' };
        const plan = await planSubAgentsAsync(task, root, 'mock');
        assert.deepEqual([...plan.specs.map((s) => s.role)].sort(), ['backend', 'frontend', 'infra']);

        process.env.HARNESS_GREENFIELD_SINGLE = '1';
        const single = await planSubAgentsAsync(task, root, 'mock');
        assert.equal(single.mode, 'greenfield-single', 'single-agent override wins over the frame');
        assert.deepEqual(single.specs.map((s) => s.role), ['default']);
        delete process.env.HARNESS_GREENFIELD_SINGLE;

        const explicit = await planSubAgentsAsync({ task: 'build it', roles: ['backend'] }, root, 'mock');
        assert.deepEqual(explicit.specs.map((s) => s.role), ['backend'], 'explicit role list is user-pinned');
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── WS-D: scope-grounded test floor ────────────────────────────────────────────

test('TEST_FILE_RE: matches test/spec sources only', () => {
  for (const f of ['a.test.ts', 'b.spec.tsx', 'c.test.mjs', 'd.spec.js', 'e.test.cjs']) {
    assert.match(f, TEST_FILE_RE);
  }
  for (const f of ['atest.ts', 'x.testify.ts', 'spec.ts', 'test.md', 'y.spec.css']) {
    assert.doesNotMatch(f, TEST_FILE_RE);
  }
});

test('subAgentTestScanDirs: top-level dirs of filesChanged; root-level files yield none', () => {
  assert.deepEqual(
    subAgentTestScanDirs({ result: { filesChanged: ['backend/src/a.ts', 'backend/package.json', 'frontend/src/b.tsx'] } }),
    ['backend', 'frontend'],
  );
  assert.deepEqual(subAgentTestScanDirs({ result: { filesChanged: ['README.md', 'package.json'] } }), []);
  assert.deepEqual(subAgentTestScanDirs({ result: { filesChanged: [] } }), []);
});

test('missingTestFloorBlockers: require-tests scope with no test file → blocker; fix clears it', () => {
  const root = tmpDir('floor-');
  try {
    withEnv({ HARNESS_REQUIRE_TESTS_ROLES: undefined }, () => {
      write(root, 'backend/src/store.ts');
      const subAgent = { role: 'backend', instanceId: 'backend', result: { filesChanged: ['backend/src/store.ts'] } };
      const blockers = missingTestFloorBlockers(root, [subAgent]);
      assert.equal(blockers.length, 1);
      assert.match(blockers[0], /grounded tests gate/);
      assert.match(blockers[0], /backend/);

      write(root, 'backend/src/store.test.ts');
      assert.deepEqual(missingTestFloorBlockers(root, [subAgent]), [], 'a test file anywhere in scope clears the gate');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missingTestFloorBlockers: annotation subAgents, root-level-only, empty, and non-required roles skipped', () => {
  const root = tmpDir('floor-skip-');
  try {
    withEnv({ HARNESS_REQUIRE_TESTS_ROLES: undefined }, () => {
      write(root, 'backend/src/store.ts');
      const annotation = { role: 'backend', instanceId: 'backend-annotations', result: { filesChanged: ['backend/src/store.ts'] } };
      const rootOnly = { role: 'backend', instanceId: 'backend', result: { filesChanged: ['README.md'] } };
      const empty = { role: 'frontend', instanceId: 'frontend', result: { filesChanged: [] } };
      const infra = { role: 'infra', instanceId: 'infra', result: { filesChanged: ['infra/docker-compose.yml'] } };
      const review = { role: 'review', instanceId: 'review', result: { filesChanged: ['backend/src/store.ts'] } };
      assert.deepEqual(missingTestFloorBlockers(root, [annotation, rootOnly, empty, infra, review]), []);
    });
    withEnv({ HARNESS_REQUIRE_TESTS_ROLES: 'none' }, () => {
      const subAgent = { role: 'backend', instanceId: 'backend', result: { filesChanged: ['backend/src/store.ts'] } };
      assert.deepEqual(missingTestFloorBlockers(root, [subAgent]), [], 'override disables the floor');
      assert.equal(roleRequiresTests('backend'), false);
    });
    withEnv({ HARNESS_REQUIRE_TESTS_ROLES: 'frontend' }, () => {
      const subAgent = { role: 'backend', instanceId: 'backend', result: { filesChanged: ['backend/src/store.ts'] } };
      assert.deepEqual(missingTestFloorBlockers(root, [subAgent]), [], 'role list override re-targets the floor');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── B1 consumer: prior-run summary prefers the tree-diff over the subAgent union ───

test('readPriorRunSummary: archived signals.treeDiff wins over the optimistic subAgent union', () => {
  const root = tmpDir('prior-');
  try {
    const runDir = path.join(root, '.harness', 'runs', 'run-1');
    write(path.join(runDir, 'sub-agents', 'backend'), 'result.json', JSON.stringify({
      status: 'complete',
      summary: 'backend work',
      filesChanged: ['backend/self-reported.ts', 'backend/never-written.ts'],
    }));
    write(runDir, 'summary.json', JSON.stringify({
      runId: 'run-1',
      signals: {
        treeDiff: { captured: true, changedFiles: ['backend/observed.ts'] },
      },
    }));
    const prior = readPriorRunSummary(root);
    assert.ok(prior);
    assert.deepEqual(prior.filesChanged, ['backend/observed.ts'], 'observed diff, not self-reports');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readPriorRunSummary: legacy archives without signals fall back to the subAgent union', () => {
  const root = tmpDir('prior-legacy-');
  try {
    const runDir = path.join(root, '.harness', 'runs', 'run-1');
    write(path.join(runDir, 'sub-agents', 'backend'), 'result.json', JSON.stringify({
      status: 'complete',
      summary: 'backend work',
      filesChanged: ['backend/a.ts'],
    }));
    const prior = readPriorRunSummary(root);
    assert.ok(prior);
    assert.deepEqual(prior.filesChanged, ['backend/a.ts']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── Review remediation: freshness exemptions, capture custody, status derivation ──

test('reviewIsFresh: harness runtime-window paths exempt; config/domains edits still stale', () => {
  const root = tmpDir('fresh-exempt-');
  try {
    write(root, 'a.txt', 'alpha\n');
    write(root, 'repovine.config.json', '{"build":{}}\n');
    assert.equal(ensureGitRepo(root), true);
    const reviewed = captureTree(root);

    // npm-install materialization after review: exempt via excludePaths only.
    write(root, 'backend/package-lock.json', '{"lockfileVersion":3}\n');
    const afterInstall = captureTree(root);
    assert.equal(
      reviewIsFresh({ repoRoot: root, reviewedRevision: reviewed, currentTree: afterInstall }),
      false,
      'unexempted lockfile stales the review',
    );
    assert.equal(
      reviewIsFresh({
        repoRoot: root, reviewedRevision: reviewed, currentTree: afterInstall,
        excludePaths: ['backend/package-lock.json'],
      }),
      true,
      'runtime-window custody exempts harness-materialized paths',
    );

    // repovine.config.json is NOT exempt from freshness (unlike the run-level diff).
    write(root, 'repovine.config.json', '{"build":{"scan":{}}}\n');
    const afterConfig = captureTree(root);
    assert.equal(
      reviewIsFresh({
        repoRoot: root, reviewedRevision: reviewed, currentTree: afterConfig,
        excludePaths: ['backend/package-lock.json'],
      }),
      false,
      'a post-review graph-config edit stales the review',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('captureWorkspaceRevision(git-tree): .harness/node_modules/dist excluded by pathspec, not .gitignore trust', () => {
  const root = tmpDir('capture-pathspec-');
  try {
    write(root, 'a.txt', 'alpha\n');
    write(root, '.gitignore', '# no harness entries here\n');
    assert.equal(ensureGitRepo(root), true);
    const baseline = captureTree(root);

    write(root, '.harness/active/run-1/subAgents/backend/result.json', '{}');
    write(root, 'node_modules/dep/index.js', 'x');
    write(root, 'dist/out.js', 'x');
    write(root, '.repovine/cache.json', '{}');
    const current = captureTree(root);
    assert.equal(current.digest, baseline.digest, 'harness-internal writes do not move the tree oid');
    assert.deepEqual(diffChangedFiles(baseline, current), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('markReviewedRevision: custody capture, forced diff base re-persisted, fail-closed in shared stages', () => {
  const root = tmpDir('mark-rev-');
  try {
    write(root, 'a.txt', 'alpha\n');
    assert.equal(ensureGitRepo(root), true);
    const baselineTree = captureTree(root);
    const resultFile = path.join(root, 'review-result.json');
    const subAgent = {
      role: 'review',
      ok: true,
      resultFile,
      result: { status: 'complete', review: { verdict: 'approve', reviewedDiffBase: 'model-lie', findings: [] } },
    };
    fs.writeFileSync(resultFile, JSON.stringify(subAgent.result));

    markReviewedRevision(subAgent, root, baselineTree, { soleInStage: true });
    assert.ok(subAgent.reviewedRevision, 'reviewedRevision captured');
    // Persisted diff base stays a digest STRING (engine compliance reads a git oid).
    assert.equal(subAgent.result.review.reviewedDiffBase, baselineTree.digest, 'model diff base overwritten by custody');
    const persisted = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    assert.equal(persisted.review.reviewedDiffBase, baselineTree.digest, 'forced base re-persisted to the subAgent artifact');

    const shared = { role: 'review', ok: true, result: { status: 'complete', review: { verdict: 'approve', findings: [] } } };
    markReviewedRevision(shared, root, baselineTree, { soleInStage: false });
    assert.equal(shared.reviewedRevision, null, 'stage-sharing review gets no revision (freshness fails closed)');

    const postfix = { role: 'review', instanceId: 'post-review', result: { status: 'complete' } };
    markReviewedRevision(postfix, root, baselineTree, { soleInStage: true });
    assert.ok(postfix.reviewedRevision, 'the post-fix re-review gets custody marks — its verdict owns acceptance');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('synthResult (local worker): carries the model review through the normalizer, by brief', () => {
  const ctx = {
    filesChanged: new Set(),
    nodes: new Set(),
    annotations: new Set(),
    observed: {
      refreshContextRun: false, dependencyImpactChecked: false, configSurfaceChecked: false,
      flowChecked: false, architectureChecked: false,
    },
  };
  const review = {
    verdict: 'approve', reviewedFiles: ['backend/a.ts'], reviewedDiffBase: 't',
    criteriaChecked: [], testReview: { claimedTestsRun: [], reviewerTestsRun: [], coverageAssessment: 'adequate', missingTests: [] },
    findings: [], residualRisks: [],
  };
  const finalText = '```json\n' + JSON.stringify({ status: 'complete', summary: 'reviewed', review }) + '\n```';
  const assignment = { runId: 'r1', task: 'review it', scope: ['.'], contextSession: { phase: 'explore' } };

  const kept = synthResult({ assignment, ctx, finalText, stopReason: 'complete', briefName: 'repovine-code-reviewer' });
  assert.deepEqual(kept.review, review, 'local code-reviewer review reaches validation intact');

  const stripped = synthResult({ assignment, ctx, finalText, stopReason: 'complete', briefName: null });
  assert.equal('review' in stripped, false, 'non-code-reviewer briefs cannot smuggle a review');
});

test('normalizeResult: annotate phase forces filesChanged empty, keeps annotation grounding', () => {
  const asg = { runId: 'r1', task: 'sync', scope: ['backend'], contextSession: { phase: 'annotate' } };
  const out = normalizeResult({
    status: 'complete',
    summary: 'annotated',
    filesChanged: ['backend/a.ts'],
    graphNodesTouched: ['mod:backend/a'],
    annotationsWritten: ['mod:backend/a'],
  }, asg);
  assert.deepEqual(out.filesChanged, [], 'annotate phase is source-read-only');
  assert.deepEqual(out.annotationsWritten, ['mod:backend/a']);
  assert.deepEqual(out.graphNodesTouched, ['mod:backend/a'], 'grounding node ids survive');
});

test('readPriorRunSummary: capture-failed treeDiff claims no files (never the subAgent union)', () => {
  const root = tmpDir('prior-failclosed-');
  try {
    const runDir = path.join(root, '.harness', 'runs', 'run-1');
    write(path.join(runDir, 'sub-agents', 'backend'), 'result.json', JSON.stringify({
      status: 'complete',
      summary: 'backend work',
      filesChanged: ['backend/self-reported.ts'],
    }));
    write(runDir, 'summary.json', JSON.stringify({
      runId: 'run-1',
      signals: { treeDiff: { captured: false, changedFiles: null } },
    }));
    const prior = readPriorRunSummary(root);
    assert.ok(prior);
    assert.deepEqual(prior.filesChanged, [], 'fail-closed: no optimistic union fallback');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('subAgentTestScanDirs: parent-relative and absolute self-reports cannot escape the sandbox', () => {
  assert.deepEqual(
    subAgentTestScanDirs({ result: { filesChanged: ['../outside/a.ts', '/etc/passwd', './backend/b.ts'] } }),
    ['backend'],
  );
});

test('applyAppFrame: stub annotations without orient evidence never frame a continuation workspace', () => {
  const root = tmpDir('frame-noorient-');
  try {
    write(root, 'package.json', '{}');
    write(root, 'backend/src/index.ts');
    // No repovine.annots.json (stub state), NO orient trail on the task.
    withEnv({ HARNESS_APP_FRAME: undefined, HARNESS_FORCE_MULTI: undefined }, () => {
      const task = { task: 'extend the backend API and the frontend UI' };
      const plan = planSubAgents(task, root);
      const framed = applyAppFrame(plan, task, root);
      assert.equal(framed.injectedFrameRoles, undefined, 'no orient evidence + product markers → no injection');

      // With orient evidence confirming an empty graph, the full predicate applies.
      const framedWithOrient = applyAppFrame(plan, { ...task, repovineOrient: { graphNodes: [] } }, root);
      assert.deepEqual(framedWithOrient.injectedFrameRoles, ['infra'], 'orient-confirmed empty graph frames the build');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deriveMultiRunStatus: signals wiring — happy path, test-floor conjunction, review freshness', () => {
  const root = tmpDir('derive-');
  try {
    withEnv({ HARNESS_REPOVINE_PROCESS: undefined, HARNESS_RUNTIME_CHECK: undefined, HARNESS_REQUIRE_TESTS_ROLES: undefined }, () => {
      write(root, 'README.md', 'seed\n');
      assert.equal(ensureGitRepo(root), true);
      const baselineTree = captureTree(root);
      write(root, 'backend/src/a.ts', 'export const a = 1;\n');
      write(root, 'backend/src/a.test.ts', 'test\n');

      const backendSubAgent = {
        role: 'backend', ok: true,
        result: { status: 'complete', filesChanged: ['backend/src/a.ts', 'backend/src/a.test.ts'] },
      };
      const base = {
        repoRoot: root,
        allSubAgents: [backendSubAgent],
        subAgents: [backendSubAgent],
        runtimeCheck: { ok: true, skipped: false },
        verifySubAgent: {
          ok: true, instanceId: 'verify',
          result: { deliveryVerification: { criteriaResults: [{ criterionId: 'c1', status: 'covered', evidence: [{ kind: 'repository', graphNodeId: 'mod:a', explanation: 'x' }], explanation: 'x' }], verdict: { intentVerified: true } } },
        },
        acceptanceCriteria: [{ id: 'c1', statement: 'x', required: true }],
        baselineTree,
        reviewRequired: false,
      };
      const happy = deriveMultiRunStatus(base);
      assert.equal(happy.goalOk, true);
      assert.equal(happy.signals.verificationStatus, 'passed');
      assert.deepEqual(happy.signals.testFloorBlockers, []);
      assert.equal(happy.signals.treeDiff.captured, true);
      assert.deepEqual(happy.signals.treeDiff.changedFiles, ['backend/src/a.test.ts', 'backend/src/a.ts']);
      assert.equal(happy.signals.runSucceeded, happy.processOk && happy.goalOk);
      assert.deepEqual(happy.signals.idleImplementers, [], 'a delivering implementer is not idle');

      // Idle-implementer telemetry: ok + complete + zero files = planner width probe.
      const idle = { role: 'infra', ok: true, result: { status: 'complete', filesChanged: [] } };
      const withIdle = deriveMultiRunStatus({ ...base, allSubAgents: [backendSubAgent, idle], subAgents: [backendSubAgent, idle] });
      assert.deepEqual(withIdle.signals.idleImplementers, ['infra']);

      // Deleting the test file must close verificationAccepted → goalOk.
      fs.rmSync(path.join(root, 'backend/src/a.test.ts'));
      const floored = deriveMultiRunStatus(base);
      assert.equal(floored.signals.verificationAccepted, false, 'test floor closes verification');
      assert.equal(floored.goalOk, false);
      assert.equal(floored.signals.testFloorBlockers.length, 1);
      write(root, 'backend/src/a.test.ts', 'test\n');

      // Fresh approved review → accepted; a post-review mutation flips it.
      const reviewSubAgent = {
        role: 'review', ok: true,
        reviewedRevision: captureTree(root),
        result: { status: 'complete', review: { verdict: 'approve', findings: [] } },
      };
      const withReview = deriveMultiRunStatus({ ...base, subAgents: [backendSubAgent, reviewSubAgent], allSubAgents: [backendSubAgent, reviewSubAgent], reviewRequired: true });
      assert.equal(withReview.signals.reviewAccepted, true);
      assert.equal(withReview.goalOk, true);

      write(root, 'backend/src/late-edit.ts', 'x\n');
      const stale = deriveMultiRunStatus({ ...base, subAgents: [backendSubAgent, reviewSubAgent], allSubAgents: [backendSubAgent, reviewSubAgent], reviewRequired: true });
      assert.equal(stale.signals.reviewAccepted, false, 'post-review mutation stales acceptance');
      assert.equal(stale.goalOk, false);

      // The bounded fix cycle re-earns acceptance: a FRESH approved post-fix
      // re-review (custody-marked) owns the verdict over the stale first review.
      const reReview = {
        role: 'review', instanceId: 'post-review', ok: true,
        reviewedRevision: captureTree(root),
        result: { status: 'complete', review: { verdict: 'approve', findings: [] } },
      };
      const reEarned = deriveMultiRunStatus({
        ...base,
        subAgents: [backendSubAgent, reviewSubAgent, reReview],
        allSubAgents: [backendSubAgent, reviewSubAgent, reReview],
        reviewRequired: true,
      });
      assert.equal(reEarned.signals.reviewAccepted, true, 'fresh re-review verdict grants acceptance');
      assert.equal(reEarned.goalOk, true);
      fs.rmSync(path.join(root, 'backend/src/late-edit.ts'));

      // Required runtime that never ran fails closed.
      write(root, 'package.json', '{}');
      const noRuntime = deriveMultiRunStatus({ ...base, runtimeCheck: null });
      assert.equal(noRuntime.signals.runtimeStatus, 'failed');
      assert.equal(noRuntime.goalOk, false);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── Annotate-phase CSQ policy: advisory, hard gates unchanged ──────────────────

test('buildSubAgentTask: annotate-phase subAgents carry contextSession.required=false (CSQ advisory)', async () => {
  const { buildSubAgentTask } = await import('../lib/graph/sub-agent.mjs');
  const parentTask = {
    id: 'run-1',
    task: 'sync annotations',
    contextSession: { sessionId: 'ctx-run-1', mode: 'harness', required: true },
  };
  const annotate = buildSubAgentTask(parentTask, { role: 'backend', scope: ['backend'], manifest: 'repovine-annotation-writer', instanceId: 'backend-annotations', contextPhase: 'annotate' }, [], '/tmp');
  assert.equal(annotate.contextSession.required, false, 'annotate phase: CSQ advisory');
  assert.equal(annotate.contextSession.phase, 'annotate');

  const implement = buildSubAgentTask(parentTask, { role: 'backend', scope: ['backend'] }, [], '/tmp');
  assert.equal(implement.contextSession.required, true, 'implement phase inherits the parent policy');
  assert.equal(implement.contextSession.phase, 'implement');
});

// ── Referenced-artifact floor: declared file references must exist ─────────────

test('missingReferencedArtifacts: compose dockerfile/env_file and tsconfig extends checked on disk', async () => {
  const { missingReferencedArtifacts } = await import('../lib/graph/artifact-floor.mjs');
  const root = tmpDir('artifact-floor-');
  try {
    write(root, 'docker-compose.yml', [
      'services:',
      '  backend:',
      '    build:',
      '      context: ./backend',
      '      dockerfile: Dockerfile',
      '    env_file:',
      '      - .env',
      '  frontend:',
      '    build:',
      '      context: ./frontend',
      '      dockerfile: Dockerfile',
    ].join('\n'));
    write(root, 'backend/Dockerfile', 'FROM node:20\n');
    write(root, 'backend/tsconfig.json', JSON.stringify({ extends: './tsconfig.base', compilerOptions: {} }));

    const blockers = missingReferencedArtifacts(root);
    assert.equal(blockers.length, 3, 'frontend Dockerfile + .env + tsconfig.base missing');
    assert.ok(blockers.some((b) => /frontend[/\\]Dockerfile/.test(b)));
    assert.ok(blockers.some((b) => /\.env/.test(b)));
    assert.ok(blockers.some((b) => /tsconfig\.base/.test(b)));

    write(root, 'frontend/Dockerfile', 'FROM node:20\n');
    write(root, '.env', 'PORT=3001\n');
    write(root, 'backend/tsconfig.base.json', '{}');
    assert.deepEqual(missingReferencedArtifacts(root), [], 'materialized references clear the floor');

    assert.deepEqual(missingReferencedArtifacts(tmpDir('artifact-none-')), [], 'no manifests → no blockers');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missingReferencedArtifacts: long-syntax env_file honors required:false; required entries still flagged', async () => {
  const { missingReferencedArtifacts } = await import('../lib/graph/artifact-floor.mjs');
  const root = tmpDir('artifact-envfile-');
  try {
    // compose's sanctioned optional-env pattern: a missing optional file is not a defect.
    write(root, 'docker-compose.yml', [
      'services:',
      '  app:',
      '    env_file:',
      '      - path: .env',
      '        required: false',
    ].join('\n'));
    assert.deepEqual(missingReferencedArtifacts(root), [], 'required:false → missing optional file is clean');

    // required:true (explicit) keeps the reference; the target is the parsed path, not the raw "path: X" line.
    write(root, 'docker-compose.yml', [
      'services:',
      '  app:',
      '    env_file:',
      '      - path: .env',
      '        required: true',
    ].join('\n'));
    let blockers = missingReferencedArtifacts(root);
    assert.equal(blockers.length, 1);
    assert.match(blockers[0], /declares "\.env"/, 'target is the parsed path');

    // Long syntax without `required` defaults to required — flagged.
    write(root, 'docker-compose.yml', [
      'services:',
      '  app:',
      '    env_file:',
      '      - path: .env',
      '      - .env.local',
    ].join('\n'));
    blockers = missingReferencedArtifacts(root);
    assert.equal(blockers.length, 2, 'defaulted-required map entry + plain entry both flagged');
    assert.ok(blockers.some((b) => /declares "\.env"/.test(b)));
    assert.ok(blockers.some((b) => /declares "\.env\.local"/.test(b)));

    write(root, '.env', 'PORT=1\n');
    write(root, '.env.local', 'PORT=2\n');
    assert.deepEqual(missingReferencedArtifacts(root), [], 'materialized files clear the floor');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('annotationSyncTask: verified criteria ride into the sync brief with a curation contract', async () => {
  const { annotationSyncTask } = await import('../lib/graph/multi.mjs');
  const subAgent = { role: 'backend', result: { filesChanged: ['backend/src/store.ts'], graphNodesTouched: ['mod:backend/src/store'] } };
  const withCriteria = annotationSyncTask(subAgent, ['backend'], [{ id: 'c1', statement: 'completing the last open child auto-closes the parent' }]);
  assert.match(withCriteria, /Behavior contracts decided in this run/);
  assert.match(withCriteria, /auto-closes the parent/);
  assert.match(withCriteria, /curate the owning module's `invariants`/);
  const withoutCriteria = annotationSyncTask(subAgent, ['backend'], []);
  assert.doesNotMatch(withoutCriteria, /Behavior contracts/);
});

// ── Plan-quality gates: over-plan advisory + bounded plan review ───────────────

test('overPlannedRoles: flags scope with zero orient evidence; conservative everywhere else', async () => {
  const { overPlannedRoles } = await import('../lib/graph/plan.mjs');
  const orient = {
    graphNodes: ['mod:todo-frontend/src/App', 'mod:todo-frontend/src/hooks/useTodos'],
    suggestedScopes: ['frontend'],
    criteria: [{ statement: 'Two frontend tests fail on selector anchoring.' }],
  };
  const backend = { role: 'backend', scope: ['backend'] };
  const frontend = { role: 'frontend', scope: ['frontend'] };
  const review = { role: 'review', scope: ['e2e'] };
  const rootFix = { role: 'default', scope: ['.'] };

  assert.deepEqual(
    overPlannedRoles([backend, frontend, review, rootFix], orient, { greenfield: false }),
    ['backend'],
    'backend has no orient token; frontend matches; review exempt; root scope clears',
  );
  assert.deepEqual(overPlannedRoles([backend], orient, { greenfield: true }), [], 'greenfield never fires');
  assert.deepEqual(overPlannedRoles([backend], {}, { greenfield: false }), [], 'no orient evidence → silent');
  // Evidence naming the scope token anywhere (criteria included) clears the role.
  const orientWithBackend = { ...orient, criteria: [{ statement: 'PATCH /todos in the backend must accept text.' }] };
  assert.deepEqual(overPlannedRoles([backend], orientWithBackend, { greenfield: false }), []);
});

test('gradePlanFindings: drop-class findings reconcile against episode end state', () => {
  const idleInfra = { role: 'infra', ok: true, result: { status: 'complete', filesChanged: [] } };
  const busyBackend = { role: 'backend', ok: true, result: { status: 'complete', filesChanged: ['backend/a.ts'] } };
  const blockedFrontend = { role: 'frontend', ok: false, result: { status: 'blocked', filesChanged: [] } };
  const subAgents = [idleInfra, busyBackend, blockedFrontend];
  const idleImplementers = ['infra'];

  const outcomes = gradePlanFindings({
    overPlanAdvisories: ['infra', 'backend'],
    planReview: {
      verdict: 'revise',
      revisions: [
        { role: 'frontend', action: 'drop', evidence: 'mod:x', reason: 'r' },
        { role: 'backend', action: 'rescope', evidence: 'mod:y', reason: 'r' },
        { role: 'ghost', action: 'drop', evidence: 'mod:z', reason: 'r' },
      ],
    },
    subAgents,
    idleImplementers,
  });

  assert.deepEqual(outcomes, [
    { source: 'advisory', role: 'infra', action: 'drop', outcome: 'confirmed' },
    { source: 'advisory', role: 'backend', action: 'drop', outcome: 'refuted' },
    { source: 'critic', role: 'frontend', action: 'drop', outcome: 'ungradable' },
    { source: 'critic', role: 'backend', action: 'rescope', outcome: 'ungradable' },
    { source: 'critic', role: 'ghost', action: 'drop', outcome: 'ungradable' },
  ]);
  assert.deepEqual(gradePlanFindings({}), [], 'no findings → empty outcomes');
});

test('parsePlanReview: uncited revisions are discarded; empty revise coerces to approve', async () => {
  const { parsePlanReview, buildPlanReviewPrompt } = await import('../lib/graph/planner.mjs');
  const cited = parsePlanReview('```json\n{"verdict":"revise","revisions":[{"role":"backend","action":"drop","evidence":"mod:todo-frontend/src/App","reason":"no claim owns backend"}]}\n```');
  assert.equal(cited.verdict, 'revise');
  assert.equal(cited.revisions.length, 1);

  const uncited = parsePlanReview('```json\n{"verdict":"revise","revisions":[{"role":"backend","action":"drop","reason":"feels unnecessary"}]}\n```');
  assert.equal(uncited.verdict, 'approve', 'evidence-free findings are the critic-bias class — discarded');
  assert.equal(uncited.revisions.length, 0);

  assert.equal(parsePlanReview('no json here'), null);

  const prompt = buildPlanReviewPrompt(
    { task: 'fix tests', repovineOrient: { claims: [{ text: 'c1' }], graphNodes: ['mod:x'] } },
    [{ role: 'frontend', scope: ['frontend'] }],
  );
  assert.match(prompt, /VALID only when its `evidence` cites/);
  assert.match(prompt, /Do NOT rewrite it/);
  assert.match(prompt, /mod:x/);
});

// ── Greenfield-only worktree parallelism: stage collapse + hard sequential elsewhere ─

test('applyGreenfieldParallelStages: greenfield batches implementers by scope-disjointness; overlapping scope stays separate', () => {
  const prev = process.env.HARNESS_GREENFIELD_PARALLEL;
  delete process.env.HARNESS_GREENFIELD_PARALLEL;
  try {
    const infra = { role: 'infra', scope: ['.'] };
    const backend = { role: 'backend', scope: ['backend'] };
    const frontend = { role: 'frontend', scope: ['frontend'] };
    const review = { role: 'review', scope: ['e2e'] };
    // Frame roles overlap on root scope → scheduleStages keeps them one-per-stage.
    const sequential = [[infra], [backend], [frontend], [review]];

    const parallel = applyGreenfieldParallelStages(sequential, { greenfield: true, planMode: 'auto' });
    assert.deepEqual(
      parallel.map((s) => s.map((x) => x.role)),
      [['infra'], ['backend', 'frontend'], ['review']],
      'infra (root scope ".") overlaps the layers → own stage; disjoint backend+frontend batch parallel; review sequential',
    );

    // Continuation NEVER parallelizes — there is no override.
    assert.deepEqual(
      applyGreenfieldParallelStages(sequential, { greenfield: false, planMode: 'auto' }),
      sequential,
      'continuation keeps sequential stages',
    );
    // Explicit user-pinned plans keep their stage order even on greenfield.
    assert.deepEqual(
      applyGreenfieldParallelStages(sequential, { greenfield: true, planMode: 'explicit' }),
      sequential,
      'explicit plans are exempt',
    );
    // A single implementer has nothing to batch.
    assert.deepEqual(
      applyGreenfieldParallelStages([[backend], [review]], { greenfield: true, planMode: 'auto' }),
      [[backend], [review]],
      'single implementer stays as-is',
    );

    // Env kill-switch: =0 disables even on greenfield.
    process.env.HARNESS_GREENFIELD_PARALLEL = '0';
    assert.equal(greenfieldParallelEnabled(), false);
    assert.deepEqual(
      applyGreenfieldParallelStages(sequential, { greenfield: true, planMode: 'auto' }),
      sequential,
      'HARNESS_GREENFIELD_PARALLEL=0 forces sequential',
    );
    delete process.env.HARNESS_GREENFIELD_PARALLEL;
    assert.equal(greenfieldParallelEnabled(), true, 'default is on');
  } finally {
    if (prev === undefined) delete process.env.HARNESS_GREENFIELD_PARALLEL;
    else process.env.HARNESS_GREENFIELD_PARALLEL = prev;
  }
});

// ── Transient transport failures: the one retriable `blocked` class ────────────

test('isTransientTransportBlock + isRetriable: proxy/SDK transport death retries fresh; real blocks stay terminal', async () => {
  const { isTransientTransportBlock, isRetriable } = await import('../lib/graph/retry.mjs');
  const zlib = {
    status: 'blocked', filesChanged: [],
    summary: 'Agent SDK error: Claude Code returned an error result: API Error: ZlibError fetching "http://127.0.0.1:8788/v1/messages"',
    blockers: ['Agent SDK error: … ZlibError fetching …'],
  };
  assert.equal(isTransientTransportBlock(zlib), true);
  assert.equal(isRetriable(zlib, { valid: false, errors: [] }, {}), true, 'transport death gets a fresh attempt');

  const overloaded = { status: 'blocked', filesChanged: [], summary: 'API Error: 529 overloaded', blockers: [] };
  assert.equal(isTransientTransportBlock(overloaded), true);

  const realBlock = { status: 'blocked', filesChanged: [], summary: 'Cannot proceed: parent contract contradicts the graph', blockers: ['contract conflict'] };
  assert.equal(isTransientTransportBlock(realBlock), false);
  assert.equal(isRetriable(realBlock, { valid: false, errors: ['x'] }, {}), false, 'a genuine blocker stays terminal');

  const workedThenDied = { status: 'blocked', filesChanged: ['a.ts'], summary: 'ECONNRESET', blockers: [] };
  assert.equal(isTransientTransportBlock(workedThenDied), false, 'delivered files → not a pure transport death');
});

// ── CSQ-only rejection on delivered work: advisory (yellow), not a process fail ─

test('subAgentCsqOnlyDelivered: delivered + CSQ-only errors → advisory; anything else stays hard', () => {
  const csqSubAgent = {
    role: 'frontend', ok: false,
    result: { status: 'complete', filesChanged: ['frontend/src/App.tsx'] },
    report: { errors: ['Context session quality rejected handoff: overall=0.36, reasons=QUALITY_BELOW_THRESHOLD.'] },
  };
  assert.equal(subAgentCsqOnlyDelivered(csqSubAgent), true);
  assert.equal(subAgentCsqOnlyDelivered({ ...csqSubAgent, ok: true }), false, 'accepted subAgent needs no forgiveness');
  assert.equal(
    subAgentCsqOnlyDelivered({ ...csqSubAgent, result: { status: 'complete', filesChanged: [] } }),
    false,
    'no delivery → no forgiveness',
  );
  assert.equal(
    subAgentCsqOnlyDelivered({ ...csqSubAgent, result: { status: 'blocked', filesChanged: ['a.ts'] } }),
    false,
    'non-terminal status stays hard',
  );
  assert.equal(
    subAgentCsqOnlyDelivered({
      ...csqSubAgent,
      report: { errors: ['Context session quality rejected handoff: …', 'Declared node mod:x not found in graph.'] },
    }),
    false,
    'any non-CSQ error keeps the subAgent red',
  );
});

test('subAgentCsqOnlyDelivered: delivery is role-shaped — review payload and annotationsWritten count', () => {
  const csqErrors = { errors: ['Context session quality rejected handoff: overall=0.37, reasons=QUALITY_BELOW_THRESHOLD.'] };
  const reviewSubAgent = {
    role: 'review', ok: false,
    result: { status: 'complete', filesChanged: [], review: { verdict: 'needs-human', findings: [] } },
    report: csqErrors,
  };
  assert.equal(subAgentCsqOnlyDelivered(reviewSubAgent), true, 'a parsed review payload is delivered work');
  assert.equal(
    subAgentCsqOnlyDelivered({ ...reviewSubAgent, schemaValid: false }),
    false,
    'an unparseable review is not delivered',
  );
  assert.equal(
    subAgentCsqOnlyDelivered({
      ...reviewSubAgent,
      report: { errors: ['Requested check "code-review" is missing AgentRunResult.review.'] },
    }),
    false,
    'non-CSQ errors on a review stay hard',
  );
  const writerSubAgent = {
    role: 'annotation-writer', ok: false,
    result: { status: 'complete', filesChanged: [], annotationsWritten: ['mod:frontend/src/App'] },
    report: csqErrors,
  };
  assert.equal(subAgentCsqOnlyDelivered(writerSubAgent), true, 'annotationsWritten is delivered work');
});

test('repovineProcessRunOk: a CSQ-only delivered subAgent no longer fails the run gate', () => {
  const csqSubAgent = {
    role: 'frontend', ok: false, instanceId: 'frontend',
    result: { status: 'complete', filesChanged: ['frontend/src/App.tsx'] },
    report: { errors: ['Context session quality rejected handoff: overall=0.36.'] },
  };
  const healthy = { role: 'backend', ok: true, result: { status: 'complete' } };
  assert.equal(repovineProcessRunOk({ subAgents: [healthy, csqSubAgent], runtimeCheck: null }), true);
  const hardRed = { ...csqSubAgent, report: { errors: ['Declared node mod:x not found in graph.'] } };
  assert.equal(repovineProcessRunOk({ subAgents: [healthy, hardRed], runtimeCheck: null }), false);
});

// ── WS-E: continuation decomposes across existing layers ───────────────────────

test('continuation: seeded workspace decomposes across touched layers, no re-scaffold, frame off', async () => {
  const root = tmpDir('cont-');
  try {
    write(root, 'package.json', JSON.stringify({ name: 'todo', workspaces: ['backend', 'frontend'] }));
    write(root, 'backend/src/index.ts');
    write(root, 'backend/package.json', '{}');
    write(root, 'frontend/src/main.tsx');
    write(root, 'frontend/package.json', '{}');
    write(root, 'repovine.annots.json', JSON.stringify({
      version: 1,
      annotations: { 'mod:backend/src/index': { summary: 'todo API' } },
    }));
    await withEnvAsync(
      { AGENTS: undefined, HARNESS_APP_FRAME: undefined, HARNESS_FORCE_MULTI: undefined, HARNESS_GREENFIELD_SINGLE: undefined },
      async () => {
        const task = { task: 'Add subtasks: extend the backend API and the frontend list UI' };
        assert.equal(isGreenfieldContext({ repoRoot: root }), false);
        const plan = await planSubAgentsAsync(task, root, 'mock');
        assert.deepEqual([...plan.specs.map((s) => s.role)].sort(), ['backend', 'frontend'], 'delta over existing layers');
        assert.ok(!plan.specs.some((s) => s.role === 'infra'), 'no re-scaffold');
        assert.equal(plan.injectedFrameRoles, undefined, 'frame guarantee does not fire on continuation');
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── Post-ladder batch: delivery forms, claims recovery, sync dedup, role stack ──

test('subAgentCsqOnlyDelivered: a deliveryVerification verdict is delivered work (verify shape)', () => {
  const verifyLeaf = {
    role: 'review', ok: false, instanceId: 'verify',
    result: { status: 'complete', filesChanged: [], deliveryVerification: { criteriaResults: [{ criterionId: 'c1', status: 'covered', evidence: [{ kind: 'repository', graphNodeId: 'mod:a', explanation: 'x' }], explanation: 'x' }], verdict: { intentVerified: true } } },
    report: { errors: ['Context session quality rejected handoff: overall=0.39, reasons=QUALITY_BELOW_THRESHOLD.'] },
  };
  assert.equal(subAgentCsqOnlyDelivered(verifyLeaf), true);
});

test('deriveMultiRunStatus: a CSQ-only delivered verify still passes the verification axis', () => {
  const root = tmpDir('derive-verify-csq-');
  try {
    withEnv({ HARNESS_REPOVINE_PROCESS: undefined, HARNESS_RUNTIME_CHECK: undefined, HARNESS_REQUIRE_TESTS_ROLES: undefined }, () => {
      write(root, 'README.md', 'seed\n');
      assert.equal(ensureGitRepo(root), true);
      const baselineTree = captureTree(root);
      const passingDelivery = { criteriaResults: [{ criterionId: 'c1', status: 'covered', evidence: [{ kind: 'repository', graphNodeId: 'mod:a', explanation: 'x' }], explanation: 'x' }], verdict: { intentVerified: true } };
      const csqVerify = {
        role: 'review', ok: false, instanceId: 'verify',
        result: { status: 'complete', filesChanged: [], deliveryVerification: passingDelivery },
        report: { errors: ['Context session quality rejected handoff: overall=0.39, reasons=QUALITY_BELOW_THRESHOLD.'] },
      };
      const derived = deriveMultiRunStatus({
        repoRoot: root,
        allSubAgents: [],
        subAgents: [],
        runtimeCheck: { ok: true, skipped: false },
        verifySubAgent: csqVerify,
        acceptanceCriteria: [{ id: 'c1', statement: 'x', required: true }],
        baselineTree,
        reviewRequired: false,
      });
      assert.equal(derived.signals.verificationStatus, 'passed', 'delivered verdicts pass the axis');
      // A verify with a NON-CSQ error stays failed.
      const hardVerify = { ...csqVerify, report: { errors: ['Declared node mod:x not found in graph.'] } };
      const hard = deriveMultiRunStatus({
        repoRoot: root, allSubAgents: [], subAgents: [], runtimeCheck: { ok: true, skipped: false },
        verifySubAgent: hardVerify, acceptanceCriteria: [{ id: 'c1', statement: 'x', required: true }], baselineTree, reviewRequired: false,
      });
      assert.equal(hard.signals.verificationStatus, 'failed');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recoverCriteriaContractsFromAttempts: newest prior attempt with criteria wins; none → []', async () => {
  const { recoverCriteriaContractsFromAttempts } = await import('../lib/graph/repovine-process.mjs');
  const { subAgentAttemptResultPath } = await import('../lib/harness-paths.mjs');
  const root = tmpDir('criteria-recover-');
  try {
    const key = 'run-1.orient';
    const writeAttempt = (n, contracts) => {
      const file = subAgentAttemptResultPath(root, key, n, { active: true });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ contractsChanged: contracts }));
    };
    const criterion = '{"id":"c-old","statement":"old decision","required":true}';
    writeAttempt(1, [criterion, 'note: not a criterion']);
    writeAttempt(2, ['nothing here']);
    // Accepted attempt is 3 (carried no criteria) → recover from 2 (none) → 1.
    assert.deepEqual(recoverCriteriaContractsFromAttempts(root, key, 3), [criterion]);
    // No prior attempts → [] (single-attempt orients never recover).
    assert.deepEqual(recoverCriteriaContractsFromAttempts(root, key, 1), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('groupAnnotationSyncTargets: identical derived scopes collapse into one union sync target', async () => {
  const { groupAnnotationSyncTargets } = await import('../lib/graph/multi.mjs');
  const t = (id, files, nodes) => ({
    role: 'default', instanceId: id,
    result: { status: 'complete', filesChanged: files, graphNodesTouched: nodes },
  });
  const fix1 = t('runtime-fix', ['backend/a.ts'], ['mod:backend/a']);
  const fix2 = t('runtime-fix-2', ['backend/b.ts'], ['mod:backend/b']);
  const solo = t('frontend', ['frontend/c.ts'], ['mod:frontend/c']);
  const groups = groupAnnotationSyncTargets(
    [fix1, fix2, solo],
    (target) => (target.instanceId === 'frontend' ? ['frontend'] : ['backend', 'frontend']),
  );
  assert.equal(groups.length, 2, 'three targets, two unique scopes');
  const merged = groups[0].subAgent;
  assert.equal(merged.instanceId, 'runtime-fix', 'primary member names the sync sub-agent');
  assert.deepEqual(merged.result.filesChanged, ['backend/a.ts', 'backend/b.ts'], 'files unioned');
  assert.deepEqual(merged.result.graphNodesTouched, ['mod:backend/a', 'mod:backend/b'], 'nodes unioned');
  assert.equal(groups[1].subAgent, solo, 'single-member group passes through untouched');
});

test('role stack: frontmatter declares it; greenfield assignments carry it; continuation does not', async () => {
  const { resolveRole } = await import('../lib/agents.mjs');
  const { buildSubAgentTask } = await import('../lib/graph/sub-agent.mjs');
  const agentsDir = tmpDir('stack-agents-');
  try {
    fs.writeFileSync(path.join(agentsDir, 'frontend.md'), [
      '---', 'name: frontend', 'stack: Vue 3 + Vite; styling: UnoCSS', '---', '', 'Frontend brief body.',
    ].join('\n'));
    withEnv({ HARNESS_AGENTS_DIR: agentsDir }, () => {
      const spec = resolveRole('frontend', process.cwd(), { task: 'build the UI' });
      assert.equal(spec.stack, 'Vue 3 + Vite; styling: UnoCSS', 'frontmatter stack reaches the spec');
      const parent = { task: 'parent task', contracts: [] };
      const greenfield = buildSubAgentTask(parent, spec, [], process.cwd(), { greenfieldRun: true });
      assert.match(greenfield.task, /## Role stack \(greenfield scaffold\)/);
      assert.match(greenfield.task, /Vue 3 \+ Vite.*Do not substitute/);
      const continuation = buildSubAgentTask(parent, spec, [], process.cwd(), { greenfieldRun: false });
      assert.doesNotMatch(continuation.task, /Role stack/);
    });
  } finally {
    fs.rmSync(agentsDir, { recursive: true, force: true });
  }
});

test('worker timeout kill: own retriable class with a time-box fold, not a transport death', async () => {
  const { isTransientTransportBlock, isWorkerTimeoutBlock, isRetriable, foldWorkerTimeoutRetry } =
    await import('../lib/graph/retry.mjs');
  const timeoutKill = {
    status: 'blocked', filesChanged: [],
    summary: 'Agent run timed out after 600s (override with CLAUDE_AGENT_TIMEOUT_MS or WORKER_TIMEOUT_MS).',
    blockers: ['Agent run timed out after 600s (override with CLAUDE_AGENT_TIMEOUT_MS or WORKER_TIMEOUT_MS).'],
  };
  // The worker was ALIVE for the full budget (reasoning spiral) — this is not a
  // transport death, and an identical fresh replay reproduces the spiral.
  assert.equal(isTransientTransportBlock(timeoutKill), false, 'timeout is not a transport death');
  assert.equal(isWorkerTimeoutBlock(timeoutKill), true, 'timeout is its own class');
  assert.equal(isRetriable(timeoutKill, { valid: false, errors: [] }, {}), true, 'still retriable — once, time-boxed');

  const folded = foldWorkerTimeoutRetry('Fix the failing frontend test.', timeoutKill);
  assert.match(folded, /^Fix the failing frontend test\./, 'original task kept');
  assert.match(folded, /TIME-BOXED RETRY: .* killed at the 600s limit/);
  assert.match(folded, /start editing within your first few actions/i);

  const workedThenTimedOut = { ...timeoutKill, filesChanged: ['a.ts'] };
  assert.equal(isWorkerTimeoutBlock(workedThenTimedOut), false, 'delivered files → not a pure hang');
  assert.equal(isTransientTransportBlock(workedThenTimedOut), false, 'delivered files → not a transport death');

  // ETIMEDOUT (socket-level) stays in the transport class, not the worker-timeout class.
  const etimedout = { status: 'blocked', filesChanged: [], summary: 'Agent SDK error: ETIMEDOUT', blockers: [] };
  assert.equal(isTransientTransportBlock(etimedout), true);
  assert.equal(isWorkerTimeoutBlock(etimedout), false);
});

// ── Observability + runtime-mode review + artifact-floor extensions batch ──

test('artifact-floor: npm ci without a lockfile and import.meta.env without vite/client are blockers', async () => {
  const { missingReferencedArtifacts } = await import('../lib/graph/artifact-floor.mjs');
  const root = tmpDir('artifact-floor-ext-');
  try {
    // frontend package: Dockerfile RUN npm ci, no lockfile; src uses import.meta.env, no vite-env.d.ts
    write(root, 'frontend/package.json', '{"name":"f"}');
    write(root, 'frontend/Dockerfile', 'FROM node:20\nRUN npm ci\n');
    write(root, 'frontend/src/api.ts', 'const u = import.meta.env.VITE_API_URL;\n');
    let blockers = missingReferencedArtifacts(root);
    assert.ok(blockers.some((b) => /npm ci.*no package-lock/.test(b)), 'npm ci without lockfile flagged');
    assert.ok(blockers.some((b) => /import\.meta\.env.*vite\/client/.test(b)), 'import.meta.env without vite/client flagged');

    // Add the lockfile and a vite-env.d.ts → both clear.
    write(root, 'frontend/package-lock.json', '{}');
    write(root, 'frontend/src/vite-env.d.ts', '/// <reference types="vite/client" />\n');
    blockers = missingReferencedArtifacts(root);
    assert.ok(!blockers.some((b) => /npm ci/.test(b)), 'lockfile clears npm ci blocker');
    assert.ok(!blockers.some((b) => /import\.meta\.env/.test(b)), 'vite-env.d.ts clears import.meta.env blocker');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tree-diff excludes engine annotation backups (annotations.backup.*.json)', async () => {
  const { REPOVINE_ARTIFACT_RE } = await import('../lib/graph/workspace-revision.mjs');
  assert.equal(REPOVINE_ARTIFACT_RE.test('annotations.backup.2026-07-17T03-32-35-041Z.json'), true);
  assert.equal(REPOVINE_ARTIFACT_RE.test('src/annotations.ts'), false);
  const root = tmpDir('backup-exclude-');
  try {
    write(root, 'README.md', 'seed\n');
    assert.equal(ensureGitRepo(root), true);
    const base = captureTree(root);
    write(root, 'src/app.ts', 'export const a = 1;\n');
    write(root, 'annotations.backup.2026-07-17T03-32-35-041Z.json', '{}');
    const changed = diffChangedFiles(base, captureTree(root));
    assert.deepEqual(changed, ['src/app.ts'], 'backup file excluded, real change kept');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
