// Regression locks for the examples-audit remediation (WS A/B + coverage gaps).
// Pure/exported units only — no live SDK, network, docker, or git here
// (worktree + http integration live in their own files).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { finitePositive } from '../lib/num.mjs';
import { isOutOfScopeInfraBlocker } from '../lib/blockers.mjs';
import { scheduleStages, assignSubAgentInstanceIds } from '../lib/graph/plan.mjs';
import { runtimeCheckShortLabel } from '../lib/runtime-check.mjs';
import { normalizeResult } from '../lib/claude-agent.mjs';
import { resolveAuth } from '../lib/workers/auth.mjs';
import { buildGraph } from '../lib/graph/workflow.mjs';
import { askReadOnlyGate, ASK_DISALLOWED_TOOLS } from '../lib/workers/ask-claude.mjs';
import { resolveInSandbox, scrubbedEnv } from '../lib/workers/local.mjs';

// ── B4: NaN/negative timeout guard ─────────────────────────────────────────────
test('finitePositive: parses positive, falls back on NaN/empty/≤0', () => {
  assert.equal(finitePositive('5000', 100), 5000);
  assert.equal(finitePositive('abc', 100), 100);
  assert.equal(finitePositive('', 100), 100);
  assert.equal(finitePositive(undefined, 100), 100);
  assert.equal(finitePositive('-5', 100), 100);
  assert.equal(finitePositive('0', 100), 100);
});

// ── B3: OUT_OF_SCOPE_INFRA no longer over-matches a real blocker ────────────────
test('isOutOfScopeInfraBlocker: does not salvage a generic hard blocker', () => {
  // Previously the greedy `outside .* sub-agent scope` alternative matched this.
  assert.equal(
    isOutOfScopeInfraBlocker('blocked: this is outside my remit and needs a sub-agent scope decision', []),
    false,
  );
});

test('isOutOfScopeInfraBlocker: still recognizes genuine out-of-scope infra', () => {
  assert.equal(isOutOfScopeInfraBlocker('this is outside the infra sub-agent scope', []), true);
  assert.equal(isOutOfScopeInfraBlocker('cannot edit docker-compose.yml here', []), true);
  // In-scope for an infra/root subAgent → not treated as out-of-scope.
  assert.equal(isOutOfScopeInfraBlocker('this is outside the infra scope', ['infra']), false);
});

// ── B9: same-role instances get their own dependency depth ─────────────────────
test('scheduleStages: an independent same-role instance runs in the first stage', () => {
  const specs = assignSubAgentInstanceIds([
    { role: 'backend', scope: ['api'] },                       // no deps → stage 0
    { role: 'backend', scope: ['db'], dependsOn: ['frontend'] }, // depends → later
    { role: 'frontend', scope: ['ui'] },                       // stage 0
  ]);
  const stages = scheduleStages(specs);
  const stageOf = (pred) => stages.findIndex((st) => st.some(pred));
  const frontendStage = stageOf((s) => s.role === 'frontend');
  const indepBackendStage = stageOf((s) => s.role === 'backend' && !(s.dependsOn || []).length);
  const depBackendStage = stageOf((s) => s.role === 'backend' && (s.dependsOn || []).includes('frontend'));
  assert.equal(frontendStage, 0);
  assert.equal(indepBackendStage, 0, 'independent backend must not inherit the dependent instance depth');
  assert.ok(depBackendStage > frontendStage, 'dependent backend runs after frontend');
});

// ── B10: a single combined build+test command labels both ──────────────────────
test('runtimeCheckShortLabel: combined command reports build & test (not test-only)', () => {
  assert.equal(runtimeCheckShortLabel({ command: 'npm run build && npm test' }), 'build & test');
  // The bug case: no spaces around && so it is one unsplit command.
  assert.equal(runtimeCheckShortLabel({ command: 'npm run build&&npm test' }), 'build & test');
});

// ── B2: unrecognized/missing run status must not pass as success ────────────────
test('normalizeResult: unknown/missing status becomes failed, not complete', () => {
  const asg = { runId: 'r1', task: 'do x', scope: ['.'] };
  assert.equal(normalizeResult({ status: 'complete', summary: 's' }, asg).status, 'complete');
  assert.equal(normalizeResult({ status: 'bogus' }, asg).status, 'failed');
  assert.equal(normalizeResult({}, asg).status, 'failed');
});

// ── provider normalizer preserves schema-supported optional artifacts ──────────
test('normalizeResult: preserves valid optional artifacts raw (review + internalTrace), still read-only', () => {
  const asg = { runId: 'run-review-1', task: 'review', scope: ['pkg/src'], contextSession: { phase: 'explore' } };
  const review = {
    verdict: 'changes-requested', reviewedFiles: ['pkg/src/a.ts'], reviewedDiffBase: 'tree-1',
    criteriaChecked: [], testReview: { claimedTestsRun: [], reviewerTestsRun: [], coverageAssessment: 'unclear', missingTests: [] },
    findings: [], residualRisks: [],
  };
  const internalTrace = { subagentsUsed: ['subAgent-a'], handoffCount: 1 };
  const out = normalizeResult({ status: 'complete', summary: 's', review, internalTrace, filesChanged: ['pkg/src/a.ts'] }, asg, { briefName: 'repovine-code-reviewer' });
  assert.deepEqual(out.review, review, 'a code-reviewer review must reach validation intact');
  assert.deepEqual(out.internalTrace, internalTrace);
  assert.deepEqual(out.filesChanged, [], 'read-only review still forces zero filesChanged');
});

test('normalizeResult: strips a stray review from a non-code-reviewer subAgent (by manifest)', () => {
  // A verify/orient subAgent sometimes emits an approve verdict; it must NOT survive to trip the
  // review-consistency gates. Discriminated by manifest, not phase (both are phase=explore).
  const asg = { runId: 'r-verify', task: 'verify', scope: ['.'], contextSession: { phase: 'explore' } };
  const review = { verdict: 'approve', reviewedFiles: [], reviewedDiffBase: 't', criteriaChecked: [], testReview: { claimedTestsRun: [], reviewerTestsRun: [], coverageAssessment: 'not-run', missingTests: [] }, findings: [], residualRisks: [] };
  const stripped = normalizeResult({ status: 'complete', summary: 's', review }, asg, { briefName: null });
  assert.equal('review' in stripped, false, 'verify subAgent review must be stripped');
  const keptExplorer = normalizeResult({ status: 'complete', summary: 's', review }, asg, { briefName: 'repovine-repo-explorer' });
  assert.equal('review' in keptExplorer, false, 'explorer review also stripped');
  const kept = normalizeResult({ status: 'complete', summary: 's', review }, asg, { briefName: 'repovine-code-reviewer' });
  assert.deepEqual(kept.review, review, 'the code-reviewer review is preserved');
});

test('normalizeResult: does not invent absent optional artifacts', () => {
  const asg = { runId: 'r1', task: 'x', scope: ['.'] };
  const out = normalizeResult({ status: 'complete', summary: 's' }, asg);
  for (const key of ['review', 'architectureAudit', 'contextPack', 'internalTrace', 'contextQuality', 'deliveryVerification']) {
    assert.equal(key in out, false, `must not fabricate ${key}`);
  }
});

test('normalizeResult: subAgents a malformed code-reviewer review present for schema rejection', () => {
  const asg = { runId: 'r1', task: 'x', scope: ['.'], contextSession: { phase: 'explore' } };
  const out = normalizeResult({ status: 'complete', summary: 's', review: 'not an object' }, asg, { briefName: 'repovine-code-reviewer' });
  // A code-reviewer's malformed review is preserved verbatim so `agents validate-result` rejects
  // it, instead of vanishing here.
  assert.equal(out.review, 'not an object');
});

// ── provider normalizer carries a verifier's deliveryVerification to compliance ──
test('normalizeResult: preserves deliveryVerification on a read-only (explore) verifier run', () => {
  const asg = { runId: 'r-verify', task: 'verify delivery', scope: ['.'], contextSession: { phase: 'explore' } };
  const deliveryVerification = {
    criteriaResults: [
      { criterionId: 'c1', status: 'covered', evidence: [{ kind: 'repository', file: 'pkg/src/a.ts', explanation: 'impl' }], explanation: 'done' },
    ],
    verdict: { intentVerified: true, deliveryAccepted: true },
  };
  // briefName null: the verify claim-checker carries no manifest, yet its deliveryVerification
  // must survive to `agents compliance` — otherwise the core never confirms intentVerified.
  const out = normalizeResult({ status: 'complete', summary: 's', deliveryVerification, filesChanged: ['pkg/src/a.ts'] }, asg, { briefName: null });
  assert.deepEqual(out.deliveryVerification, deliveryVerification, 'a verifier deliveryVerification must reach compliance intact');
  assert.deepEqual(out.filesChanged, [], 'read-only run still forces zero filesChanged, so DELIVERY_NOT_READONLY cannot fire');
});

test('normalizeResult: strips deliveryVerification outside a read-only phase (by phase, not manifest)', () => {
  const deliveryVerification = {
    criteriaResults: [{ criterionId: 'c1', status: 'covered', evidence: [{ kind: 'repository', file: 'a.ts', explanation: 'x' }], explanation: 'x' }],
    verdict: { intentVerified: true },
  };
  const run = (phase) => normalizeResult(
    { status: 'complete', summary: 's', deliveryVerification },
    { runId: 'r1', task: 'x', scope: ['.'], contextSession: { phase } },
    { briefName: 'repovine-code-reviewer' },
  );
  // An implement/annotate result echoing a delivery verdict would be mis-failed for a field its
  // role never owns — strip it. explore keeps it even for a manifest-bearing reviewer.
  assert.equal('deliveryVerification' in run('implement'), false, 'implement-phase result must not carry deliveryVerification');
  assert.equal('deliveryVerification' in run('annotate'), false, 'annotate-phase result must not carry deliveryVerification');
  assert.deepEqual(run('explore').deliveryVerification, deliveryVerification, 'explore keeps it even for a manifest-bearing reviewer');
});

// ── E4: resolveAuth is fail-closed for cloud providers ─────────────────────────
test('resolveAuth: cloud provider blocks with no key, passes with one', () => {
  const saved = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  try {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    assert.equal(resolveAuth('claude').ok, false, 'no key → blocked (no silent spend)');
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const ok = resolveAuth('claude');
    assert.equal(ok.ok, true);
    assert.equal(ok.source, 'ANTHROPIC_API_KEY');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.equal(resolveAuth('nope').ok, false, 'unknown provider → blocked');
});

// ── E9: the graph actually compiles into an invokable object ───────────────────
test('buildGraph: compiles to an invokable StateGraph', () => {
  const g = buildGraph();
  assert.ok(g && typeof g.invoke === 'function');
});

// ── E1 / A1: the /ask read-only gate denies writes, allows reads ───────────────
test('askReadOnlyGate: allows read tools, denies writes and command exec', async () => {
  for (const t of ['Read', 'Glob', 'Grep', 'mcp__repovine__search_context', 'mcp__repovine__inspect_node']) {
    assert.equal((await askReadOnlyGate(t, {})).behavior, 'allow', `${t} should be allowed`);
  }
  for (const t of ['Write', 'Edit', 'Bash', 'mcp__repovine__write_annotation', 'mcp__repovine__refresh_context']) {
    assert.equal((await askReadOnlyGate(t, {})).behavior, 'deny', `${t} should be denied`);
  }
  assert.ok(ASK_DISALLOWED_TOOLS.includes('Write') && ASK_DISALLOWED_TOOLS.includes('Bash'));
  assert.ok(ASK_DISALLOWED_TOOLS.includes('mcp__repovine__write_annotation'));
});

// ── E6: sandbox containment (path traversal / absolute / .git / symlink) ───────
test('resolveInSandbox: keeps paths inside the sandbox', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsb-'));
  try {
    assert.equal(resolveInSandbox(root, 'notes.txt').rel, 'notes.txt');
    // Absolute path INSIDE the sandbox is accepted (weak models echo the root).
    assert.equal(resolveInSandbox(root, path.join(root, 'a', 'b.txt')).rel, path.join('a', 'b.txt'));
    assert.throws(() => resolveInSandbox(root, '../escape.txt'), /inside the repo root/);
    assert.throws(() => resolveInSandbox(root, '/etc/passwd'), /inside the repo root/);
    assert.throws(() => resolveInSandbox(root, '.git/config', { forWrite: true }), /\.git/);
    // Symlink escape: a dir symlink pointing outside must be rejected.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
    fs.symlinkSync(outside, path.join(root, 'link'));
    assert.throws(() => resolveInSandbox(root, 'link/x.txt'), /symlink/);
    fs.rmSync(outside, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── E7: the model-facing shell env strips provider secrets ─────────────────────
test('scrubbedEnv: removes secret-like vars, keeps benign ones', () => {
  const scrubbed = scrubbedEnv({
    ANTHROPIC_API_KEY: 'y',
    SOME_API_KEY: 'sk-x',
    HARNESS_HTTP_TOKEN: 'z',
    SOME_SECRET: 'c',
    PATH: '/usr/bin',
    HOME: '/home/node',
    NODE_OPTIONS: '--max-old-space-size=4096',
  });
  assert.equal(scrubbed.ANTHROPIC_API_KEY, undefined);
  assert.equal(scrubbed.SOME_API_KEY, undefined);
  assert.equal(scrubbed.HARNESS_HTTP_TOKEN, undefined);
  assert.equal(scrubbed.SOME_SECRET, undefined);
  assert.equal(scrubbed.PATH, '/usr/bin');
  assert.equal(scrubbed.HOME, '/home/node');
  assert.equal(scrubbed.NODE_OPTIONS, '--max-old-space-size=4096');
});
