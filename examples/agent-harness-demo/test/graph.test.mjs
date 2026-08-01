// Unit tests for the pure orchestration logic — the one place the protocol
// invariants are enforced in CODE, where a regression is SILENT (no crash): a
// wrong scopesDisjoint runs conflicting subAgents in parallel; a wrong
// normalizeScopePath recreates the outer monorepo tree inside the sandbox; a
// wrong isSyncOnlyReport re-implements already-accepted code on retry.
//
// No network, no SDKs, no repovine CLI — just the pure functions. Run: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assignSubAgentInstanceIds, planSubAgents, scopesDisjoint, scheduleStages } from '../lib/graph/plan.mjs';
import { normalizeScopePath } from '../lib/graph/planner.mjs';
import {
  complianceAccepted,
  foldRetryContext,
  groundingRejected,
  isSyncOnlyReport,
  subAgentSyncRetrySucceeded,
  mergeSyncOnlyResult,
  retryNotes,
  reviewFixSubAgentAccepted,
} from '../lib/graph/retry.mjs';
import { buildInterSubAgentTaskSection } from '../lib/handoff-loader.mjs';
import { attachmentsBrief, buildWorkerPrompt } from '../lib/workers/prompt.mjs';
import { buildSubAgentTask } from '../lib/graph/sub-agent.mjs';
import { buildPlanPrompt } from '../lib/graph/planner.mjs';
import { normalizeResult } from '../lib/claude-agent.mjs';
import { buildRunUsage, claudeUsage, totalUsage } from '../lib/workers/usage.mjs';
import {
  buildRunMcp,
  byToolFromEchoes,
  formatMcpMetrics,
  mcpMetricsFromContextQuality,
  mcpMetricsFromEchoes,
  mcpMetricsFromSessionFile,
  snapshotMcpSession,
  totalMcpMetrics,
} from '../lib/workers/mcp-telemetry.mjs';
import {
  effectiveReviewSubAgent,
  reviewGateIsOpen,
  annotationSyncTask,
  annotationSyncTargets,
  annotationSyncSkipReason,
  reviewFixEligible,
} from '../lib/graph/multi.mjs';
import { collectSubAgentSessions, mergeSessions } from '../lib/graph/sessions.mjs';
import { isGreenfieldSandbox, hasOnlyStubAnnotations, isGreenfieldContext } from '../lib/graph/workspace-state.mjs';
import { formatReply, subAgentStepLabel, isAnnotationSyncSubAgent, subAgentStatusDot } from '../lib/graph/nodes.mjs';
import { deriveAnnotationSyncScope } from '../lib/graph/multi.mjs';
import { clearWorkspaceContents } from '../lib/target-repo.mjs';
import {
  compactRunTelemetry,
  finishRunTelemetry,
  formatCurrentRunStatus,
  formatTelemetrySummary,
  formatUsageMetrics,
  readCurrentRun,
  recordRunEvent,
  runSucceeded,
  startRunTelemetry,
} from '../lib/telemetry.mjs';
import {
  clearHarnessArtifacts,
  formatPriorRunSummaryForTask,
  prepareHarnessRun,
  readPriorRunSummary,
} from '../lib/harness-run.mjs';
import {
  deriveScopeFromRuntimeLog,
  discoverPackageDirs,
  runtimeCheckBlockers,
  runtimeCheckPassed,
  runtimeCheckCommands,
  runtimeCheckFixMaxAttempts,
  failedRuntimeCheckCommand,
  canAttemptRuntimeCheckFix,
  runtimeCheckFixAttemptsForCommand,
  recordRuntimeCheckFixAttempt,
  isMissingTestScriptFailure,
  deriveRuntimeCheckFixScopes,
  buildRuntimeCheckFixTask,
  runtimeFailureLogTail,
  formatRuntimeCheckSummary,
  runRuntimeCheck,
} from '../lib/runtime-check.mjs';

// ── scopesDisjoint: "parallel only for disjoint scopes" decision ──────────────
test('scopesDisjoint: sibling paths are disjoint', () => {
  assert.equal(scopesDisjoint(['a'], ['b']), true);
  assert.equal(scopesDisjoint(['frontend'], ['backend']), true);
});

test('scopesDisjoint: identical paths overlap', () => {
  assert.equal(scopesDisjoint(['a'], ['a']), false);
});

test('scopesDisjoint: nested path overlaps its parent', () => {
  assert.equal(scopesDisjoint(['a/x'], ['a']), false);
  assert.equal(scopesDisjoint(['a'], ['a/x/y']), false);
});

test('scopesDisjoint: root "." overlaps everything', () => {
  assert.equal(scopesDisjoint(['.'], ['anything']), false);
  assert.equal(scopesDisjoint(['x'], ['.']), false);
});

test('scopesDisjoint: shared prefix that is not a path segment stays disjoint', () => {
  // "ab" is NOT under "a/" — must not be treated as nested.
  assert.equal(scopesDisjoint(['a'], ['ab']), true);
});

test('scopesDisjoint: empty scopes are vacuously disjoint', () => {
  assert.equal(scopesDisjoint([], []), true);
});

// ── scheduleStages: disjoint→one parallel stage; overlap/deps→separate stages ──
const spec = (role, scope, dependsOn = []) => ({ role, scope, dependsOn });
const roles = (stage) => stage.map((s) => s.role);

test('scheduleStages: disjoint independent subAgents share one parallel stage', () => {
  const stages = scheduleStages([
    spec('backend', ['backend']),
    spec('frontend', ['frontend']),
  ]);
  assert.equal(stages.length, 1);
  assert.deepEqual(roles(stages[0]).sort(), ['backend', 'frontend']);
});

test('scheduleStages: overlapping scopes are split into separate stages', () => {
  const stages = scheduleStages([
    spec('backend', ['.']), // root overlaps the frontend scope
    spec('frontend', ['frontend']),
  ]);
  assert.equal(stages.length, 2);
  assert.equal(stages[0].length, 1);
  assert.equal(stages[1].length, 1);
});

test('scheduleStages: dependsOn forces a later stage (with a barrier between)', () => {
  const stages = scheduleStages([
    spec('backend', ['backend']),
    spec('frontend', ['frontend'], ['backend']),
  ]);
  assert.equal(stages.length, 2);
  assert.deepEqual(roles(stages[0]), ['backend']);
  assert.deepEqual(roles(stages[1]), ['frontend']);
});

test('planSubAgents: explicit detailed client input uses subAgents', () => {
  const plan = planSubAgents({
    task: 'build feature',
    subAgents: [
      { role: 'backend', scope: ['backend'] },
      { role: 'frontend', scope: ['frontend'], dependsOn: ['backend'] },
    ],
  }, process.cwd());
  assert.equal(plan.mode, 'explicit');
  assert.deepEqual(plan.specs.map((s) => s.role), ['backend', 'frontend']);
  assert.deepEqual(plan.specs[1].dependsOn, ['backend']);
});

test('planSubAgents: the legacy `leaves` task field is not a client-facing explicit plan', () => {
  const plan = planSubAgents({ task: 'build feature', leaves: [{ role: 'backend', scope: ['backend'] }] }, process.cwd());
  assert.notEqual(plan.mode, 'explicit');
});

// ── normalizeScopePath: re-anchor planner scopes to the sandbox root ──────────
test('normalizeScopePath: plain relative path is unchanged', () => {
  assert.equal(normalizeScopePath('backend', []), 'backend');
  assert.equal(normalizeScopePath('todo/backend', []), 'todo/backend');
});

test('normalizeScopePath: strips leading slash, "." and ".." junk', () => {
  assert.equal(normalizeScopePath('/abs/x', []), 'abs/x');
  assert.equal(normalizeScopePath('../../etc/passwd', []), 'etc/passwd');
});

test('normalizeScopePath: strips the outer-monorepo prefix run', () => {
  const prefix = ['repovine', 'examples', 'agent-harness-demo'];
  assert.equal(normalizeScopePath('repovine/examples/agent-harness-demo/backend', prefix), 'backend');
});

test('normalizeScopePath: a fully-consumed prefix collapses to "."', () => {
  const prefix = ['repovine', 'examples', 'agent-harness-demo'];
  assert.equal(normalizeScopePath('repovine/examples/agent-harness-demo', prefix), '.');
  assert.equal(normalizeScopePath('', []), '.');
});

test('normalizeScopePath: a non-matching first segment is left intact', () => {
  assert.equal(normalizeScopePath('backend', ['repovine']), 'backend');
});

// ── workspace-state: planner-owned greenfield fallback ───────────────────────
test('isGreenfieldSandbox: product markers make a sandbox existing-product', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repovine-harness-'));
  const oldForceMulti = process.env.HARNESS_FORCE_MULTI;
  delete process.env.HARNESS_FORCE_MULTI;
  t.after(async () => {
    if (oldForceMulti === undefined) delete process.env.HARNESS_FORCE_MULTI;
    else process.env.HARNESS_FORCE_MULTI = oldForceMulti;
    await fs.rm(dir, { recursive: true, force: true });
  });

  assert.equal(isGreenfieldSandbox(dir), true);
  await fs.mkdir(path.join(dir, 'backend'));
  assert.equal(isGreenfieldSandbox(dir), false);
});

test('isGreenfieldSandbox: stub repovine.annots.json alone is still greenfield', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repovine-harness-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.writeFile(
    path.join(dir, 'repovine.annots.json'),
    '{"version":1,"annotations":{}}\n',
  );
  assert.equal(isGreenfieldSandbox(dir), true);
  assert.equal(hasOnlyStubAnnotations(dir), true);
});

test('isGreenfieldContext: empty orient + stub annotations', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repovine-harness-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dir, 'repovine.annots.json'), '{"version":1,"annotations":{}}\n');
  assert.equal(
    isGreenfieldContext({ repoRoot: dir, orientTrail: { graphNodes: [] } }),
    true,
  );

  await fs.mkdir(path.join(dir, 'backend'));
  assert.equal(
    isGreenfieldContext({ repoRoot: dir, orientTrail: { graphNodes: [] } }),
    true,
  );
  assert.equal(
    isGreenfieldContext({ repoRoot: dir, orientTrail: { graphNodes: ['mod:backend/x'] } }),
    false,
  );

  await fs.writeFile(
    path.join(dir, 'repovine.annots.json'),
    '{"version":1,"annotations":{"mod:x":{"annotation":{"summary":"prior"}}}}\n',
  );
  assert.equal(
    isGreenfieldContext({ repoRoot: dir, orientTrail: { graphNodes: ['mod:backend/x'] } }),
    false,
  );
});

// ── isSyncOnlyReport: don't re-implement code for an annotation-only rejection ─
// Classification routes by diagnostics[].code (Р9), not error prose. A coded report
// carries one { code, message } per error, in order.
const codedReport = (...codes) => ({
  errors: codes.map((c) => `${c} message`),
  diagnostics: codes.map((c) => ({ code: c, message: `${c} message` })),
});

test('isSyncOnlyReport: annotation-sync codes are sync-only', () => {
  assert.equal(isSyncOnlyReport(codedReport('ANNOTATION_COVERAGE_INCOMPLETE')), true);
  assert.equal(isSyncOnlyReport(codedReport('ANNOTATIONS_UNCLEAN', 'ANNOTATIONS_ORPHANED')), true);
  assert.equal(isSyncOnlyReport(codedReport('ANNOTATION_PROPAGATION_STALE_IN_SCOPE')), true);
});

test('isSyncOnlyReport: no errors is not sync-only', () => {
  assert.equal(isSyncOnlyReport({ errors: [] }), false);
  assert.equal(isSyncOnlyReport({}), false);
});

test('isSyncOnlyReport: an unresolved node (false claim) is not sync-only', () => {
  assert.equal(isSyncOnlyReport(codedReport('GRAPH_NODE_UNRESOLVED')), false);
  assert.equal(isSyncOnlyReport(codedReport('EVIDENCE_ANCHOR_UNRESOLVED')), false);
});

test('isSyncOnlyReport: an uncoded error is not sync-only (legacy/synthesized report)', () => {
  assert.equal(isSyncOnlyReport({ errors: ['missing GET /health route'] }), false);
});

test('isSyncOnlyReport: a contract-handoff miss is never sync-only', () => {
  // Contract-handoff errors carry no code; the harness gate appends them to `errors`
  // past the diagnostics list, so the prose match still catches them.
  assert.equal(
    isSyncOnlyReport({
      ...codedReport('ANNOTATION_PROPAGATION_STALE'),
      errors: ['ANNOTATION_PROPAGATION_STALE message', 'inter-sub-agent contract missing'],
    }),
    false,
  );
});

test('isSyncOnlyReport: any non-sync code makes the whole report non-sync', () => {
  assert.equal(
    isSyncOnlyReport(codedReport('ANNOTATION_COVERAGE_INCOMPLETE', 'APPROVE_COVERAGE_INADEQUATE')),
    false,
  );
});

// ── annotation-grounding policy: harness rejects on repovine's mode-independent facts ──
test('groundingRejected: true on ungrounded or hard-inconsistent annotations, false otherwise', () => {
  assert.equal(groundingRejected({ ungroundedAnnotations: ['mod:a'] }), true);
  assert.equal(groundingRejected({ inconsistentAnnotations: [{ nodeId: 'mod:a', issues: ['keyExports:x'] }] }), true);
  assert.equal(groundingRejected({ ungroundedAnnotations: [], inconsistentAnnotations: [] }), false);
  assert.equal(groundingRejected({}), false);
});

test('complianceAccepted: a repovine-valid run is rejected when a grounding fact is present (even as a warning)', () => {
  assert.equal(complianceAccepted({ valid: true, ungroundedAnnotations: ['mod:a'] }), false);
  assert.equal(complianceAccepted({ valid: true, inconsistentAnnotations: [{ nodeId: 'mod:a', issues: ['keyExports:x'] }] }), false);
  assert.equal(complianceAccepted({ valid: true, ungroundedAnnotations: [], inconsistentAnnotations: [] }), true);
  assert.equal(complianceAccepted({ valid: false }), false);
});

test('isSyncOnlyReport: a grounding-only rejection (no hard errors) is sync-only', () => {
  assert.equal(isSyncOnlyReport({ errors: [], ungroundedAnnotations: ['mod:a'] }), true);
  assert.equal(isSyncOnlyReport({ errors: [], inconsistentAnnotations: [{ nodeId: 'mod:a', issues: ['sideEffects:declared pure'] }] }), true);
});

test('retryNotes: folds grounding specifics so the agent gets the node ids', () => {
  const notes = retryNotes({
    errors: [],
    requiredFollowups: ['inspect_node each annotated node...'],
    ungroundedAnnotations: ['mod:a', 'mod:b'],
    inconsistentAnnotations: [{ nodeId: 'mod:c', issues: ['keyExports:ghostFn'] }],
  });
  const joined = notes.join(' ');
  assert.match(joined, /mod:a, mod:b/);
  assert.match(joined, /mod:c \(keyExports:ghostFn\)/);
});

test('mergeSyncOnlyResult: keeps accepted implementation fields from the first attempt', () => {
  const work = {
    protocolVersion: '1',
    runId: 'run-1',
    status: 'complete',
    summary: 'Implemented backend API.',
    scope: ['backend'],
    filesChanged: ['backend/src/app.ts'],
    graphNodesTouched: ['mod:backend/src/app'],
    contractsChanged: ['ADDED route: GET /api/todos'],
    testsRun: [],
    annotationsWritten: ['mod:backend/src/app'],
    compliance: { refreshContextRun: true, annotationsClean: false },
    blockers: [],
  };
  const sync = {
    protocolVersion: '1',
    runId: 'run-1',
    status: 'complete',
    summary: 'Annotation-only pass: validate_annotations is clean.',
    scope: ['backend'],
    filesChanged: [],
    graphNodesTouched: ['mod:backend/src/app', 'mod:backend/src/routes'],
    contractsChanged: [],
    testsRun: [],
    annotationsWritten: ['mod:backend/src/app', 'mod:backend/src/routes'],
    compliance: { refreshContextRun: true, annotationsClean: true },
    blockers: [],
  };

  const merged = mergeSyncOnlyResult(work, sync);
  assert.deepEqual(merged.filesChanged, ['backend/src/app.ts']);
  assert.deepEqual(merged.contractsChanged, ['ADDED route: GET /api/todos']);
  assert.deepEqual(merged.graphNodesTouched, ['mod:backend/src/app', 'mod:backend/src/routes']);
  assert.deepEqual(merged.annotationsWritten, ['mod:backend/src/app', 'mod:backend/src/routes']);
  assert.equal(merged.compliance.annotationsClean, true);
  assert.match(merged.summary, /Implemented backend API/);
  assert.match(merged.summary, /repovine sync retry completed/);
});

test('mergeSyncOnlyResult: drops phantom graphNodesTouched from work attempt', () => {
  const work = {
    summary: 'Implemented fixes.',
    filesChanged: ['frontend/vite.config.ts'],
    graphNodesTouched: ['mod:frontend/vite.config.ts'],
    contractsChanged: ['ADDED tests'],
    annotationsWritten: [],
    compliance: { refreshContextRun: true, annotationsClean: false },
  };
  const sync = {
    summary: 'Annotation sync scoped.',
    filesChanged: [],
    graphNodesTouched: ['mod:backend/src/app', 'infra:docker-compose:docker-compose.yml'],
    annotationsWritten: ['mod:backend/src/app'],
    compliance: { refreshContextRun: true, annotationsClean: true },
  };
  const merged = mergeSyncOnlyResult(work, sync);
  assert.deepEqual(merged.graphNodesTouched, sync.graphNodesTouched);
  assert.deepEqual(merged.filesChanged, work.filesChanged);
});

test('foldRetryContext: sync-only retry scopes annotation to accepted filesChanged', () => {
  const task = foldRetryContext('Fix blockers.', {
    errors: ['ANNOTATION_PROPAGATION_STALE message'],
    diagnostics: [{ code: 'ANNOTATION_PROPAGATION_STALE', message: 'ANNOTATION_PROPAGATION_STALE message' }],
  }, {
    workResult: {
      filesChanged: ['backend/src/app.ts', 'frontend/package.json'],
      graphNodesTouched: ['mod:backend/src/app'],
    },
  });
  assert.match(task, /do NOT drain the whole repo annotation queue/i);
  assert.match(task, /Drain propagation-stale in scope too/i);
  assert.match(task, /refreshImportBaseline/i);
  assert.match(task, /backend\/src\/app\.ts/);
  assert.match(task, /frontend\/package\.json/);
});

test('annotationSyncTask: drains full queue including propagation-stale', () => {
  const task = annotationSyncTask(
    { role: 'backend', result: { filesChanged: ['backend/src/a.ts'], graphNodesTouched: ['mod:backend/src/a'] } },
    ['backend'],
  );
  assert.match(task, /needsWork:0/i);
  assert.match(task, /propagation-stale is in needsWork/i);
  assert.match(task, /content-stale before propagation-stale/i);
});

test('buildInterSubAgentTaskSection: single deduped ledger, no per-subAgent contract repeat', () => {
  const section = buildInterSubAgentTaskSection(
    [
      { role: 'infra', workSummary: 'Scaffolded compose', filesChanged: ['docker-compose.yml'], contractsChanged: ['ADDED service:db port 5432'] },
      { role: 'backend', workSummary: 'Todo API', filesChanged: ['backend/src/app.ts'], contractsChanged: ['ADDED GET /api/todos', 'ADDED service:db port 5432'] },
    ],
    '/tmp',
    { baseContracts: ['ADDED env:DATABASE_URL'], currentRole: 'frontend', resuming: false },
  );
  // Ledger holds base + all prior contracts, deduped (db port appears exactly once).
  assert.match(section, /ADDED env:DATABASE_URL/);
  assert.match(section, /ADDED GET \/api\/todos/);
  assert.equal((section.match(/ADDED service:db port 5432/g) || []).length, 1);
  // Prior subAgents render summary + files, but the per-subAgent "contracts:" repeat is gone.
  assert.match(section, /\[backend\] Todo API/);
  assert.doesNotMatch(section, /^\s*contracts:/m);
});

test('buildInterSubAgentTaskSection: resume hides same-role prior subAgents but keeps the full ledger', () => {
  const prior = [
    { role: 'backend', workSummary: 'Backend turn 1', filesChanged: ['b.ts'], contractsChanged: ['ADDED GET /api/x'] },
    { role: 'infra', workSummary: 'Infra turn', filesChanged: ['compose.yml'], contractsChanged: ['ADDED service:db'] },
  ];
  const section = buildInterSubAgentTaskSection(prior, '/tmp', { baseContracts: [], currentRole: 'backend', resuming: true });
  // Same-role (backend) narrative is dropped — it is already in the resumed session.
  assert.doesNotMatch(section, /Backend turn 1/);
  // Cross-role sibling narrative stays.
  assert.match(section, /\[infra\] Infra turn/);
  // Both contracts remain in the ledger regardless of the narrative filter.
  assert.match(section, /ADDED GET \/api\/x/);
  assert.match(section, /ADDED service:db/);
});

test('usage: claudeUsage maps tokens/cost and derives cacheHitRatio', () => {
  const c = claudeUsage({
    model: 'claude-opus-4-8',
    total_cost_usd: 0.12,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
  });
  assert.equal(c.provider, 'claude');
  assert.equal(c.inputTokens, 100);
  assert.equal(c.outputTokens, 50);
  assert.equal(c.cacheReadTokens, 900);
  assert.equal(c.costUsd, 0.12);
  assert.equal(c.cacheHitRatio, 0.9); // 900 / (900 + 0 + 100)
});

test('usage: totalUsage sums per-field, skips nulls, recomputes ratio', () => {
  const t = totalUsage([
    claudeUsage({ usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 100 } }),
    claudeUsage({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 } }),
    null,
  ]);
  assert.equal(t.attempts, 2);
  assert.equal(t.inputTokens, 110);
  assert.equal(t.outputTokens, 55);
  assert.equal(t.cacheReadTokens, 200);
  assert.equal(t.cacheCreationTokens, 100);
  assert.equal(t.provider, 'claude');
  assert.equal(t.cacheHitRatio, Number((200 / 410).toFixed(4)));
  assert.equal(totalUsage([]), null);
  assert.equal(totalUsage([null]), null);
});

test('usage: buildRunUsage totals the run and splits fresh vs resume', () => {
  const u = (input, read) => claudeUsage({
    usage: { input_tokens: input, output_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: 0 },
  });
  const rollup = buildRunUsage('tg-1-123', [
    { subAgent: 'infra', role: 'infra', fresh: true, ok: true, usage: u(20000, 0) },
    { subAgent: 'backend', role: 'backend', fresh: true, ok: true, usage: u(30000, 0) },
    { subAgent: 'backend-annotations', role: 'backend', fresh: false, ok: true, usage: u(4000, 50000) },
  ]);
  assert.equal(rollup.run, 'tg-1-123');
  assert.equal(rollup.subAgentCount, 3);
  assert.equal(rollup.subAgents[1].subAgent, 'backend');
  assert.equal('leafCount' in rollup, false, 'legacy key stays absent');
  assert.equal('leaves' in rollup, false, 'legacy key stays absent');
  assert.equal(rollup.total.inputTokens, 54000);
  assert.equal(rollup.freshTotal.inputTokens, 50000); // 20000 + 30000
  assert.equal(rollup.resumeTotal.inputTokens, 4000);
  assert.equal(rollup.resumeTotal.cacheReadTokens, 50000);
  // Empty run → null totals, no crash.
  const empty = buildRunUsage('r', []);
  assert.equal(empty.subAgentCount, 0);
  assert.equal(empty.total, null);
  assert.equal(empty.freshTotal, null);
});

test('mcp-telemetry: byToolFromEchoes and totalMcpMetrics merge sub-agents', () => {
  const echoes = [
    { seq: 1, tool: 'search_context', responseBytes: 100 },
    { seq: 2, tool: 'inspect_node', responseBytes: 200 },
    { seq: 3, tool: 'inspect_node', responseBytes: 150 },
  ];
  assert.deepEqual(byToolFromEchoes(echoes), { search_context: 1, inspect_node: 2 });
  const one = mcpMetricsFromEchoes(echoes);
  assert.equal(one.toolCallCount, 3);
  assert.equal(one.totalResponseBytes, 450);
  const total = totalMcpMetrics([
    one,
    { toolCallCount: 2, byTool: { refresh_context: 2 }, totalResponseBytes: 80 },
  ]);
  assert.equal(total.toolCallCount, 5);
  assert.equal(total.totalResponseBytes, 530);
  assert.deepEqual(total.byTool, { search_context: 1, inspect_node: 2, refresh_context: 2 });
});

test('mcp-telemetry: mcpMetricsFromContextQuality prefers requestEchoes', () => {
  const m = mcpMetricsFromContextQuality({
    sessionId: 'ctx-test',
    overall: 0.72,
    requestEchoes: [
      { seq: 1, tool: 'map_context', responseBytes: 50 },
      { seq: 2, tool: 'map_context', responseBytes: 60 },
    ],
  });
  assert.equal(m.contextSessionId, 'ctx-test');
  assert.equal(m.overall, 0.72);
  assert.deepEqual(m.byTool, { map_context: 2 });
});

test('mcp-telemetry: buildRunMcp rolls up like buildRunUsage', () => {
  const rollup = buildRunMcp('r1', [
    { subAgent: 'infra', role: 'infra', ok: true, mcp: { toolCallCount: 3, byTool: { search_context: 2, inspect_node: 1 } } },
    { subAgent: 'backend', role: 'backend', ok: false, mcp: { toolCallCount: 1, byTool: { refresh_context: 1 } } },
  ]);
  assert.equal(rollup.run, 'r1');
  assert.equal(rollup.total.toolCallCount, 4);
  assert.deepEqual(rollup.total.byTool, { search_context: 2, inspect_node: 1, refresh_context: 1 });
  assert.match(formatMcpMetrics(rollup), /mcp: 4 calls/);
  assert.match(formatMcpMetrics(rollup), /search_context×2/);
});

test('mcp-telemetry: mcpMetricsFromSessionFile reads .repovine cache', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-mcp-'));
  const sessions = path.join(root, '.repovine', '.cache', 'sessions');
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(sessions, 'ctx-subAgent.json'), JSON.stringify({
    sessionId: 'ctx-subAgent',
    requestEchoes: [{ seq: 1, tool: 'get_entrypoints', responseBytes: 42 }],
  }));
  const m = mcpMetricsFromSessionFile(root, 'ctx-subAgent');
  assert.equal(m.toolCallCount, 1);
  assert.deepEqual(m.byTool, { get_entrypoints: 1 });
});

test('mcp-telemetry: snapshot before session consume survives compliance delete', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-mcp-consume-'));
  const sessions = path.join(root, '.repovine', '.cache', 'sessions');
  await fs.mkdir(sessions, { recursive: true });
  const sessionId = 'ctx-subAgent-retry';
  const sessionFile = path.join(sessions, `${sessionId}.json`);
  await fs.writeFile(sessionFile, JSON.stringify({
    sessionId,
    requestEchoes: [
      { seq: 1, tool: 'search_context', responseBytes: 100 },
      { seq: 2, tool: 'inspect_node', responseBytes: 200 },
    ],
  }));
  const attempt1 = snapshotMcpSession(root, sessionId);
  await fs.rm(sessionFile, { force: true });
  const attempt2 = snapshotMcpSession(root, sessionId);
  assert.equal(attempt2, null);
  const merged = totalMcpMetrics([attempt1, attempt2].filter(Boolean));
  assert.equal(merged.toolCallCount, 2);
  assert.deepEqual(merged.byTool, { search_context: 1, inspect_node: 1 });
});

test('telemetry: records current run, events, and client metrics summary', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-telemetry-'));
  const usage = claudeUsage({
    total_cost_usd: 0.42,
    usage: {
      input_tokens: 1200,
      output_tokens: 80,
      cache_read_input_tokens: 3600,
      cache_creation_input_tokens: 0,
    },
  });
  const mcp = { toolCallCount: 5, byTool: { search_context: 2, inspect_node: 3 }, totalResponseBytes: 9000 };

  startRunTelemetry(root, {
    runId: 'r1',
    provider: 'claude',
    mode: 'multi',
    task: { id: 'r1', scope: ['.'], roles: ['backend'] },
  });
  recordRunEvent(root, {
    event: 'sub_agent_started',
    runId: 'r1',
    subAgent: 'backend',
    role: 'backend',
    scope: ['backend'],
  });
  recordRunEvent(root, {
    event: 'sub_agent_finished',
    runId: 'r1',
    subAgent: 'backend',
    role: 'backend',
    ok: true,
    resultStatus: 'complete',
    durationMs: 1234,
    attempts: 1,
    usage,
    mcp,
  });

  const current = readCurrentRun(root);
  assert.equal(current.runId, 'r1');
  assert.equal(current.subAgents[0].subAgent, 'backend');
  assert.equal(current.subAgents[0].usage.inputTokens, 1200);
  assert.equal(current.subAgents[0].mcp.toolCallCount, 5);
  assert.match(formatUsageMetrics(usage), /tokens: in 1,200/);

  const mcpRollup = buildRunMcp('r1', [{ subAgent: 'backend', role: 'backend', ok: true, mcp }]);
  const final = finishRunTelemetry(root, {
    task: { id: 'r1' },
    mode: 'multi',
    ok: true,
    subAgents: [{ role: 'backend', ok: true, result: { status: 'complete' } }],
    usageRollup: { total: usage, freshTotal: usage, subAgents: [{ subAgent: 'backend', role: 'backend', usage }] },
    mcpRollup,
    signals: { runSucceeded: true, processOk: true, goalOk: true, reviewRequired: false, reviewAccepted: null, runtimeStatus: 'skipped', verificationStatus: 'passed' },
  });
  assert.match(formatTelemetrySummary(final), /episode:/);
  assert.match(formatTelemetrySummary(final), /tokens: in/);
  assert.match(formatTelemetrySummary(final), /mcp: 5 calls/);
  assert.match(formatTelemetrySummary(final), /inspect_node×3/);
  assert.match(formatTelemetrySummary(final), /fresh sub-agents tokens:/);
  assert.match(formatCurrentRunStatus(final), /last: r1/);
  const compact = compactRunTelemetry(final);
  assert.equal(compact.usage.total.costUsd, 0.42);
  assert.equal(compact.mcp.total.toolCallCount, 5);
  assert.equal(compact.subAgents[0].subAgent, 'backend');
  assert.equal(compact.subAgents[0].mcp.toolCallCount, 5);
  assert.equal('leaves' in compact, false, 'legacy key stays absent');
  assert.equal('slowestLeaf' in compact, false, 'legacy key stays absent');

  const eventsText = await fs.readFile(path.join(root, '.harness', 'runs', 'r1', 'events.jsonl'), 'utf8');
  assert.match(eventsText, /"event":"run_started"/);
  assert.match(eventsText, /"event":"sub_agent_finished"/);
  assert.match(eventsText, /"toolCallCount":5/);
  const summary = JSON.parse(await fs.readFile(
    path.join(root, '.harness', 'runs', 'r1', 'summary.json'),
    'utf8',
  ));
  assert.equal(summary.artifacts.summary, 'summary.json');
  assert.equal(summary.mcp.total.toolCallCount, 5);
  assert.match(summary.metricsSummary, /mcp: 5 calls/);
  assert.match(summary.metricsSummary, /tokens: in/);
  // Gate signal block is persisted so an archived run says which gate decided the outcome.
  assert.equal(summary.signals.processOk, true);
  assert.equal(summary.signals.reviewAccepted, null);
  assert.equal(summary.signals.runtimeStatus, 'skipped');
});

test('normalizeResult: read-only review (explore) forces files/nodes/annotations empty + annClean=false', () => {
  // A read-only review must not echo reviewed files as filesChanged nor assert clean —
  // doing so trips the annotation gate and mis-routes it into annotation-writing on retry.
  const assignment = { runId: 'r', scope: ['backend', 'frontend'], task: 't', contextSession: { phase: 'explore', sessionId: 's' } };
  const r = normalizeResult({
    status: 'complete', summary: 'cross-stack review',
    filesChanged: ['backend/src/a.ts', 'frontend/src/b.tsx'],
    graphNodesTouched: ['mod:backend/src/a'],
    annotationsWritten: ['mod:backend/src/a'],
    compliance: { annotationsClean: true },
  }, assignment);
  assert.deepEqual(r.filesChanged, []);
  assert.deepEqual(r.graphNodesTouched, []);
  assert.deepEqual(r.annotationsWritten, []);
  assert.equal(r.compliance.annotationsClean, false);
});

test('normalizeResult: implement subAgent forces annotationsClean=false even when model claims true', () => {
  const assignment = { runId: 'r', scope: ['backend'], task: 't', contextSession: { phase: 'implement', sessionId: 's' } };
  const r = normalizeResult({
    status: 'complete', summary: 'impl',
    filesChanged: ['backend/src/a.ts'],
    graphNodesTouched: ['mod:backend/src/a'],
    compliance: { annotationsClean: true },
  }, assignment);
  assert.equal(r.compliance.annotationsClean, false);
});

test('normalizeResult: implement subAgent keeps files/nodes and honors its annotationsClean=false defer', () => {
  const assignment = { runId: 'r', scope: ['backend'], task: 't', contextSession: { phase: 'implement', sessionId: 's' } };
  const r = normalizeResult({
    status: 'complete', summary: 'impl',
    filesChanged: ['backend/src/a.ts'],
    graphNodesTouched: ['mod:backend/src/a'],
    compliance: { annotationsClean: false },
  }, assignment);
  assert.deepEqual(r.filesChanged, ['backend/src/a.ts']);
  assert.deepEqual(r.graphNodesTouched, ['mod:backend/src/a']);
  assert.equal(r.compliance.annotationsClean, false);
});

test('assignSubAgentInstanceIds: unique roles keep clean labels; repeated role disambiguated by scope', () => {
  const out = assignSubAgentInstanceIds([
    { role: 'backend', scope: ['backend'] },
    { role: 'annotation-writer', scope: ['frontend'] },
    { role: 'annotation-writer', scope: ['backend'] },
  ]);
  assert.equal(out[0].instanceId, undefined); // unique role → clean label, no instanceId
  assert.equal(out[1].instanceId, 'annotation-writer-frontend');
  assert.equal(out[2].instanceId, 'annotation-writer-backend');
});

test('assignSubAgentInstanceIds: same role + non-disambiguating scope falls back to numeric suffix', () => {
  const out = assignSubAgentInstanceIds([
    { role: 'annotation-writer', scope: ['.'] },
    { role: 'annotation-writer', scope: ['.'] },
  ]);
  assert.equal(out[0].instanceId, 'annotation-writer');
  assert.equal(out[1].instanceId, 'annotation-writer-2');
});

test('formatRuntimeCheckSummary: plain OK vs red→green recovery note', () => {
  const cmd = 'npm run build && npm test';
  assert.match(formatRuntimeCheckSummary({ ok: true, command: cmd }), /build & test OK$/);
  const rec = formatRuntimeCheckSummary({ ok: true, fixAttempts: 1, command: cmd });
  assert.match(rec, /auto-fixed in 1 pass,/);
  assert.match(rec, /now green/);
  assert.match(formatRuntimeCheckSummary({ ok: true, fixAttempts: 2, command: cmd }), /2 passes/);
});

test('reviewFixSubAgentAccepted: true when sync-only retry passed even if merged ok false', () => {
  const subAgent = {
    ok: false,
    attempts: [
      { ok: false, syncOnlyRejection: true },
      { ok: true, syncOnlyRejection: false },
    ],
  };
  assert.equal(reviewFixSubAgentAccepted(subAgent), true);
  assert.equal(subAgentSyncRetrySucceeded(subAgent.attempts), true);
});

test('subAgentSyncRetrySucceeded: false when last attempt failed or first was not sync-only', () => {
  assert.equal(subAgentSyncRetrySucceeded([{ ok: false, syncOnlyRejection: true }, { ok: false }]), false);
  assert.equal(subAgentSyncRetrySucceeded([{ ok: false, syncOnlyRejection: false }, { ok: true }]), false);
});

test('reviewGateIsOpen: opens after accepted review-fix before post-fix review runs', () => {
  const review = {
    role: 'review',
    ok: true,
    handoff: { blockers: ['missing tests'] },
    result: { blockers: ['missing tests'] },
  };
  const fixSubAgent = {
    ok: false,
    attempts: [{ ok: false, syncOnlyRejection: true }, { ok: true, syncOnlyRejection: true }],
  };
  assert.equal(reviewGateIsOpen([review], fixSubAgent), true);
});

test('reviewGateIsOpen: a CSQ-only delivered review-fix opens the gate for the re-review', () => {
  const review = {
    role: 'review',
    ok: true,
    handoff: { blockers: ['jest-dom missing'] },
    result: { blockers: ['jest-dom missing'], review: { verdict: 'changes-requested' } },
  };
  const csqFix = {
    role: 'default', ok: false,
    result: { status: 'complete', filesChanged: ['frontend/package.json', 'frontend/vite.config.ts'] },
    report: { errors: ['Context session quality rejected handoff: overall=0.18, reasons=QUALITY_BELOW_THRESHOLD, OR_WITHOUT_RECOVERY.'] },
  };
  assert.equal(reviewGateIsOpen([review], csqFix), true);
  assert.equal(
    reviewGateIsOpen([review], { ...csqFix, result: { status: 'complete', filesChanged: [] } }),
    false,
    'undelivered fix keeps the gate closed',
  );
  assert.equal(
    reviewGateIsOpen([review], {
      ...csqFix,
      report: { errors: ['Context session quality rejected handoff: overall=0.18.', 'graphNodesTouched contains unknown node id.'] },
    }),
    false,
    'non-CSQ compliance errors keep the gate closed',
  );
});

test('reviewGateIsOpen: uses post-fix review when present', () => {
  const review = {
    role: 'review',
    ok: true,
    schemaValid: true,
    handoff: { blockers: ['old blocker'] },
  };
  const postFix = {
    role: 'review',
    instanceId: 'post-review',
    ok: true,
    schemaValid: true,
    handoff: { blockers: [] },
    result: { status: 'complete', blockers: [] },
  };
  assert.equal(reviewGateIsOpen([review, postFix], null), true);
  assert.equal(effectiveReviewSubAgent([review, postFix]), postFix);
});

// The gate reads the review's PRODUCT verdict. A reviewer that approved the code but botched
// its own AgentRunResult (here: omitted the required `review` object, so ok=false) used to
// close the gate — no annotation sync, and repovine.annots.json silently stayed empty.
test('reviewGateIsOpen: a compliance-rejected review with no blockers still opens the gate', () => {
  const postFix = {
    role: 'review',
    instanceId: 'post-review',
    ok: false,
    schemaValid: true,
    handoff: { blockers: [] },
    result: { status: 'complete', blockers: [] },
  };
  assert.equal(reviewGateIsOpen([postFix], null), true);
});

test('reviewGateIsOpen: an unreadable review verdict closes the gate', () => {
  const review = {
    role: 'review',
    ok: false,
    schemaValid: false,
    result: { status: 'complete', blockers: [] },
  };
  assert.equal(reviewGateIsOpen([review], null), false);
  assert.equal(
    annotationSyncSkipReason([review], null, null),
    'review result failed schema validation — its verdict is unreadable',
  );
});

test('reviewGateIsOpen: unresolved blockers close the gate', () => {
  const review = {
    role: 'review',
    ok: true,
    schemaValid: true,
    handoff: { blockers: ['missing Dockerfile'] },
    result: { status: 'complete', blockers: ['missing Dockerfile'] },
  };
  assert.equal(reviewGateIsOpen([review], null), false);
  assert.equal(annotationSyncSkipReason([review], null, null), 'review reported 1 unresolved blocker(s)');
});

test('reviewGateIsOpen: a review that declares itself blocked is not an approval', () => {
  const review = {
    role: 'review',
    ok: true,
    schemaValid: true,
    handoff: { blockers: [] },
    result: { status: 'blocked', blockers: [] },
  };
  assert.equal(reviewGateIsOpen([review], null), false);
  assert.equal(annotationSyncSkipReason([review], null, null), 'review sub-agent ended blocked');
});

// ── worker session map: intra-task resume keys ───────────────────────────────
test('collectSubAgentSessions: keys finished subAgents by role', () => {
  const subAgents = [
    { role: 'backend', workerSessionId: 'sid-be' },
    { role: 'frontend', workerSessionId: 'sid-fe' },
  ];
  assert.deepEqual(collectSubAgentSessions(subAgents), { backend: 'sid-be', frontend: 'sid-fe' });
});

test('collectSubAgentSessions: skips subAgents that produced no session', () => {
  const subAgents = [
    { role: 'backend', workerSessionId: 'sid-be' },
    { role: 'frontend' }, // blocked before a session existed
    { workerSessionId: 'orphan' }, // no role
  ];
  assert.deepEqual(collectSubAgentSessions(subAgents), { backend: 'sid-be' });
});

test('collectSubAgentSessions: empty / missing input is an empty map', () => {
  assert.deepEqual(collectSubAgentSessions([]), {});
  assert.deepEqual(collectSubAgentSessions(), {});
});

test('mergeSessions: fresh handles win over prior keys', () => {
  const prior = { backend: 'old-be', frontend: 'old-fe' };
  const next = { backend: 'new-be' };
  assert.deepEqual(mergeSessions(prior, next), { backend: 'new-be', frontend: 'old-fe' });
});

test('mergeSessions: tolerates missing sides', () => {
  assert.deepEqual(mergeSessions(undefined, { a: '1' }), { a: '1' });
  assert.deepEqual(mergeSessions({ a: '1' }, undefined), { a: '1' });
  assert.deepEqual(mergeSessions(), {});
});

// ── formatReply: protocol compliance is separate from blocker status ─────────
const doneSubAgent = (role, overrides = {}) => {
  const { result = {}, handoff = {}, ...rest } = overrides;
  return {
    role,
    ok: true,
    result: {
      status: 'complete',
      summary: `${role} done`,
      filesChanged: [],
      blockers: [],
      ...result,
    },
    handoff: {
      blockers: [],
      contractsChanged: [],
      ...handoff,
    },
    ...rest,
  };
};

test('formatReply: multi header separates protocol compliance from unresolved blockers', () => {
  const reply = formatReply({
    mode: 'multi',
    execution: 'sequential',
    subAgents: [
      doneSubAgent('backend', {
        handoff: { blockers: ['Dockerfile still runs src/server.js'], contractsChanged: [] },
      }),
      doneSubAgent('review', {
        handoff: { blockers: ['Backend Dockerfile cannot run TypeScript directly'], contractsChanged: [] },
      }),
    ],
  });

  assert.match(reply, /✅ Goal delivered/);
  assert.match(reply, /✅ Process clean — 2\/2 sub-agents/);
  assert.match(reply, /🔴 blockers: 2 unresolved/);
  assert.match(reply, /🔴 blocker: Dockerfile still runs src\/server\.js/);
});

test('formatReply: compact mode omits file lists and shortens step labels', () => {
  const prev = process.env.HARNESS_REPLY_VERBOSE;
  delete process.env.HARNESS_REPLY_VERBOSE;
  try {
    const reply = formatReply({
      mode: 'multi',
      execution: 'sequential',
      subAgents: [
        doneSubAgent('infra', {
          result: {
            summary: 'Scaffold workspaces and docker-compose for todo app',
            filesChanged: ['package.json', 'docker-compose.yml'],
          },
          handoff: { contractsChanged: ['ADDED: root workspaces'] },
        }),
        doneSubAgent('infra', {
          instanceId: 'infra-annotations',
          result: { summary: 'Annotated infra modules' },
        }),
      ],
    });
    assert.doesNotMatch(reply, /📝 package\.json/);
    assert.doesNotMatch(reply, /📜 ADDED/);
    assert.match(reply, /🟢 \[infra\] Scaffold workspaces/);
    assert.match(reply, /✅ annotations: in-scope clean \(infra\)/);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_REPLY_VERBOSE;
    else process.env.HARNESS_REPLY_VERBOSE = prev;
  }
});

// An annotation-sync sub-agent can end ok=false (it did not drain its scope alone)
// while a LATER scope's sub-agent sweeps the residual. The head must not call that
// "blocked" (it has no blockers), and the annotation-sync severity follows the
// end-state needsWork, not the per-sub-agent ok flag.
const nonConvergedAnnotations = (role, instanceId) => ({
  role,
  instanceId,
  ok: false,
  result: { status: 'complete', summary: `${role} annotations`, filesChanged: [], blockers: [] },
  handoff: { blockers: [], contractsChanged: [] },
});

test('formatReply: annotation-sync non-convergence with clean end-state is not "blocked"', () => {
  const prev = process.env.HARNESS_REPLY_VERBOSE;
  delete process.env.HARNESS_REPLY_VERBOSE;
  try {
    const reply = formatReply({
      mode: 'multi',
      execution: 'sequential',
      signals: { annotationHealth: { needsWork: 0, clean: true } },
      subAgents: [
        doneSubAgent('backend'),
        nonConvergedAnnotations('infra', 'infra-annotations'),
        doneSubAgent('backend', { instanceId: 'backend-annotations', result: { summary: 'backend annotations' } }),
      ],
    });
    // The non-converged annotation sub-agent has no blockers → never "N blocked" in the head.
    assert.doesNotMatch(reply, /, \d+ blocked/);
    assert.match(reply, /Process .* — 2\/3 sub-agents/);
    // End-state debt is clean → green, and the line says the residual was swept.
    assert.match(reply, /🟢 \[annotation-sync\] 1\/2 \(infra, backend\) · debt clean \(residual swept\)/);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_REPLY_VERBOSE;
    else process.env.HARNESS_REPLY_VERBOSE = prev;
  }
});

test('formatReply: annotation-sync residual debt shows needsWork, still not "blocked"', () => {
  const prev = process.env.HARNESS_REPLY_VERBOSE;
  delete process.env.HARNESS_REPLY_VERBOSE;
  try {
    const reply = formatReply({
      mode: 'multi',
      execution: 'sequential',
      signals: { annotationHealth: { needsWork: 2, clean: false } },
      subAgents: [
        doneSubAgent('backend'),
        nonConvergedAnnotations('infra', 'infra-annotations'),
        doneSubAgent('backend', { instanceId: 'backend-annotations', result: { summary: 'backend annotations' } }),
      ],
    });
    // Advisory debt is surfaced on the annotation-sync line, not as a blocked worker.
    assert.doesNotMatch(reply, /, \d+ blocked/);
    assert.match(reply, /🔴 \[annotation-sync\] 1\/2 \(infra, backend\) · needsWork 2/);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_REPLY_VERBOSE;
    else process.env.HARNESS_REPLY_VERBOSE = prev;
  }
});

test('formatReply: all sync sub-agents converged → in-scope clean ✅, repo-wide debt is a separate ℹ️ (not 🔴)', () => {
  const prev = process.env.HARNESS_REPLY_VERBOSE;
  delete process.env.HARNESS_REPLY_VERBOSE;
  try {
    const reply = formatReply({
      mode: 'multi',
      execution: 'sequential',
      // Every annotation sub-agent reached compliance-valid → in-scope clean;
      // needsWork 81 is pre-existing repo debt outside this run's scopes.
      signals: { annotationHealth: { needsWork: 81, clean: false } },
      subAgents: [
        doneSubAgent('backend'),
        doneSubAgent('infra', { instanceId: 'infra-annotations', result: { summary: 'infra annotations' } }),
        doneSubAgent('backend', { instanceId: 'backend-annotations', result: { summary: 'backend annotations' } }),
      ],
    });
    assert.match(reply, /✅ annotations: in-scope clean \(infra, backend\)/);
    assert.match(reply, /ℹ️ repo carries 81 pre-existing stale\/unannotated node\(s\) outside this run/);
    assert.doesNotMatch(reply, /🔴 \[annotation-sync\]/);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_REPLY_VERBOSE;
    else process.env.HARNESS_REPLY_VERBOSE = prev;
  }
});

test('subAgentStatusDot: green when accepted, red on fail', () => {
  const okSubAgent = { ok: true, result: { status: 'complete' }, attempts: [{ attempt: 1, ok: true }] };
  assert.equal(subAgentStatusDot(okSubAgent), '🟢');

  const reviewWithBlockers = {
    ok: true,
    result: { status: 'complete', blockers: ['npm ci without lockfile'] },
    handoff: { blockers: ['npm ci without lockfile'] },
    attempts: [{ attempt: 1, ok: true }],
  };
  assert.equal(subAgentStatusDot(reviewWithBlockers), '🟢');

  const retried = { ok: true, result: { status: 'complete' }, attempts: [{ attempt: 1, ok: false }, { attempt: 2, ok: true }] };
  assert.equal(subAgentStatusDot(retried), '🟢');

  assert.equal(subAgentStatusDot({ ok: false, result: { status: 'complete' } }), '🔴');
  assert.equal(subAgentStatusDot({ ok: true, result: { status: 'failed' } }), '🔴');
});

test('subAgentStepLabel: maps orchestrator instance ids to short names', () => {
  assert.equal(subAgentStepLabel({ role: 'review', instanceId: 'post-review' }), 'post-review');
  assert.equal(subAgentStepLabel({ role: 'default', instanceId: 'runtime-fix-2' }), 'runtime-fix-2');
  assert.equal(isAnnotationSyncSubAgent({ instanceId: 'backend-annotations' }), true);
});

test('formatReply: failed runtime_check forces ❌ header even when all subAgents pass', () => {
  const reply = formatReply({
    mode: 'multi',
    execution: 'sequential',
    runtimeCheck: { ok: false, command: 'npm test', exitCode: 1, logTail: 'Missing script: "test"' },
    subAgents: [doneSubAgent('infra'), doneSubAgent('backend'), doneSubAgent('frontend')],
  });

  assert.match(reply, /^❌ Goal not delivered/m);
  assert.match(reply, /⚠️ Process has issues — 3\/3 sub-agents/);
  assert.match(reply, /runtime_check: test failed \(exit 1\)/);
  assert.doesNotMatch(reply, /^❌ runtime_check:/);
});

test('formatReply: clean post-fix review marks earlier blocker reports resolved', () => {
  const reply = formatReply({
    mode: 'multi',
    execution: 'sequential',
    subAgents: [
      doneSubAgent('backend', {
        handoff: { blockers: ['Dockerfile still runs src/server.js'], contractsChanged: [] },
      }),
      doneSubAgent('review', {
        handoff: { blockers: ['Backend Dockerfile cannot run TypeScript directly'], contractsChanged: [] },
      }),
      doneSubAgent('default', {
        result: { summary: 'Fixed backend Dockerfile' },
      }),
      doneSubAgent('review', {
        instanceId: 'post-review',
        result: { summary: 'Post-fix review: prior blocker is resolved' },
      }),
    ],
  });

  assert.match(reply, /✅ Goal delivered/);
  assert.match(reply, /✅ Process clean — 4\/4 sub-agents/);
  assert.match(reply, /● blockers: 0 unresolved/);
  assert.match(reply, /🛠 fixed blocker reports: 2 OK/);
  // Compact replies hide resolved blocker sub-lines (header still reports the count).
  assert.doesNotMatch(reply, /🔴 blocker: Dockerfile/);
  // A subAgent whose blocker was cleared by the post-fix review paints 🟡 (found+fixed), not 🔴.
  assert.match(reply, /🟡 \[/);
  assert.doesNotMatch(reply, /🔴 \[/);

  const prev = process.env.HARNESS_REPLY_VERBOSE;
  process.env.HARNESS_REPLY_VERBOSE = '1';
  try {
    const verbose = formatReply({
      mode: 'multi',
      execution: 'sequential',
      subAgents: [
        doneSubAgent('backend', {
          handoff: { blockers: ['Dockerfile still runs src/server.js'], contractsChanged: [] },
        }),
        doneSubAgent('review', {
          handoff: { blockers: ['Backend Dockerfile cannot run TypeScript directly'], contractsChanged: [] },
        }),
        doneSubAgent('default', {
          result: { summary: 'Fixed backend Dockerfile' },
        }),
        doneSubAgent('review', {
          instanceId: 'post-review',
          result: { summary: 'Post-fix review: prior blocker is resolved' },
        }),
      ],
    });
    assert.match(verbose, /🟡 resolved: Dockerfile still runs src\/server\.js/);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_REPLY_VERBOSE;
    else process.env.HARNESS_REPLY_VERBOSE = prev;
  }
});

// ── runSucceeded: a resolved review blocker is not a run failure ─────────────
test('runSucceeded: green goal/process gates win even when a review subAgent is ok:false', () => {
  // The exact case: review FOUND a blocker (ok:false), review-fix cleared it, goal+process
  // gates are green. Old logic (subAgents.every(l.ok)) archived this green run as "failed".
  const state = {
    mode: 'multi',
    processOk: true,
    goalOk: true,
    subAgents: [
      { role: 'frontend', ok: true, result: { status: 'complete' } },
      { role: 'review', ok: false, result: { status: 'complete', blockers: ['no tests'] } },
      { role: 'default', ok: true, result: { status: 'complete' } },
    ],
  };
  assert.equal(runSucceeded(state), true);
});

test('runSucceeded: a genuinely failed process gate stays failed', () => {
  const state = {
    mode: 'multi',
    processOk: false,
    goalOk: false,
    subAgents: [{ role: 'frontend', ok: false, result: { status: 'blocked' } }],
  };
  assert.equal(runSucceeded(state), false);
});

// ── runtime_check helpers ────────────────────────────────────────────────────
test('deriveScopeFromRuntimeLog: infers backend/frontend/infra from compiler output', () => {
  assert.deepEqual(
    deriveScopeFromRuntimeLog('backend/src/controllers/todoController.ts(22,28): error TS2345'),
    ['backend'],
  );
  assert.deepEqual(
    deriveScopeFromRuntimeLog('> frontend@0.0.0 build\nfrontend/src/App.tsx(3,1): error'),
    ['frontend'],
  );
  assert.deepEqual(
    deriveScopeFromRuntimeLog('failed to solve: Dockerfile: no such file'),
    ['infra'],
  );
  assert.deepEqual(deriveScopeFromRuntimeLog('something opaque'), ['.']);
});

test('deriveScopeFromRuntimeLog: infers workspace package names and npm error paths', () => {
  const log = [
    '> todo-backend@1.0.0 build',
    '> tsc',
    'src/controllers/todoController.ts(17,41): error TS2345',
    'npm error path /app/sandbox/backend',
    'npm error workspace todo-backend@1.0.0',
  ].join('\n');
  assert.deepEqual(deriveScopeFromRuntimeLog(log), ['backend']);

  assert.deepEqual(
    deriveScopeFromRuntimeLog('npm error workspace todo-frontend@1.0.0\nsrc/App.tsx(1,1): error TS6306'),
    ['frontend'],
  );
});

test('runtimeFailureLogTail: keeps errors from multiple workspace build failures', () => {
  const log = [
    '> todo-app@1.0.0 build',
    '> npm run build --workspaces --if-present',
    '> todo-backend@1.0.0 build',
    '> tsc',
    'src/controllers/todoController.ts(17,41): error TS2345: bad backend',
    'npm error Lifecycle script `build` failed with error:',
    'npm error workspace todo-backend@1.0.0',
    '> todo-frontend@1.0.0 build',
    '> tsc && vite build',
    'tsconfig.json(21,18): error TS6310: frontend composite',
    'npm error Lifecycle script `build` failed with error:',
    'npm error workspace todo-frontend@1.0.0',
    'lots of noise line 1',
    'lots of noise line 2',
  ].join('\n');
  const tail = runtimeFailureLogTail(log, 40);
  assert.match(tail, /todo-backend@/);
  assert.match(tail, /TS2345/);
  assert.match(tail, /todo-frontend@/);
  assert.match(tail, /TS6310/);
});

test('runtimeCheckFixMaxAttempts: defaults to 2', () => {
  const prev = process.env.HARNESS_RUNTIME_CHECK_FIX_MAX;
  delete process.env.HARNESS_RUNTIME_CHECK_FIX_MAX;
  assert.equal(runtimeCheckFixMaxAttempts(), 2);
  if (prev === undefined) delete process.env.HARNESS_RUNTIME_CHECK_FIX_MAX;
  else process.env.HARNESS_RUNTIME_CHECK_FIX_MAX = prev;
});

test('failedRuntimeCheckCommand: returns failing step command', () => {
  assert.equal(failedRuntimeCheckCommand({ ok: true }), null);
  assert.equal(failedRuntimeCheckCommand({ skipped: true }), null);
  assert.equal(
    failedRuntimeCheckCommand({ ok: false, command: 'npm test', exitCode: 1 }),
    'npm test',
  );
});

test('canAttemptRuntimeCheckFix: per-command budget is independent', () => {
  const attempts = new Map([['npm run build', 2]]);
  assert.equal(canAttemptRuntimeCheckFix('npm run build', attempts, 2), false);
  assert.equal(canAttemptRuntimeCheckFix('npm test', attempts, 2), true);
  assert.equal(canAttemptRuntimeCheckFix('npm test', attempts, 0), false);
});

test('recordRuntimeCheckFixAttempt: tracks attempts per command', () => {
  const attempts = new Map();
  assert.equal(recordRuntimeCheckFixAttempt('npm run build', attempts), 1);
  assert.equal(recordRuntimeCheckFixAttempt('npm run build', attempts), 2);
  assert.equal(recordRuntimeCheckFixAttempt('npm test', attempts), 1);
  assert.equal(runtimeCheckFixAttemptsForCommand('npm run build', attempts), 2);
  assert.equal(runtimeCheckFixAttemptsForCommand('npm test', attempts), 1);
});

test('runtimeCheckBlockers: empty when ok or skipped', () => {
  assert.deepEqual(runtimeCheckBlockers({ ok: true, command: 'npm run build' }), []);
  assert.deepEqual(runtimeCheckBlockers({ skipped: true }), []);
  assert.equal(runtimeCheckBlockers({ ok: false, command: 'npm run build', exitCode: 2, logTail: 'TS2345' }).length, 1);
});

test('runtimeCheckPassed: treats skipped as pass', () => {
  assert.equal(runtimeCheckPassed({ skipped: true }), true);
  assert.equal(runtimeCheckPassed({ ok: false }), false);
  assert.equal(runtimeCheckPassed(null), true);
});

test('runRuntimeCheck: skips when disabled or no package.json anywhere', async () => {
  const prev = process.env.HARNESS_RUNTIME_CHECK;
  const prevCmd = process.env.HARNESS_RUNTIME_CHECK_CMD;
  process.env.HARNESS_RUNTIME_CHECK = '0';
  assert.equal(runRuntimeCheck('/tmp').skipped, true);
  process.env.HARNESS_RUNTIME_CHECK = '1';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-rc-'));
  assert.equal(runRuntimeCheck(dir).reason, 'no-package-json');
  process.env.HARNESS_RUNTIME_CHECK = prev;
  process.env.HARNESS_RUNTIME_CHECK_CMD = prevCmd;
});

test('isMissingTestScriptFailure: detects absent npm test script', () => {
  assert.equal(
    isMissingTestScriptFailure({ logTail: 'npm error Missing script: "test"' }),
    true,
  );
  assert.equal(isMissingTestScriptFailure({ logTail: 'TS6310: error' }), false);
});

test('deriveRuntimeCheckFixScopes: widens to root and app packages for missing test', () => {
  assert.deepEqual(
    deriveRuntimeCheckFixScopes({ logTail: 'npm error Missing script: "test"' }),
    ['.', 'backend', 'frontend'],
  );
  assert.deepEqual(
    deriveRuntimeCheckFixScopes({ logTail: 'frontend/src/App.tsx(3,1): error TS2345' }),
    ['frontend'],
  );
});

test('buildRuntimeCheckFixTask: adds test-script guidance for missing test failures', () => {
  const check = { command: 'npm test', logTail: 'npm error Missing script: "test"' };
  const task = buildRuntimeCheckFixTask(check);
  assert.match(task, /Missing test script/);
  assert.match(task, /npm run test --workspaces --if-present/);
  assert.match(task, /backend\/package\.json/);
  assert.match(task, /frontend\/package\.json/);
});

test('buildRuntimeCheckFixTask: declares the wall-clock time-box up front', () => {
  const task = buildRuntimeCheckFixTask({ command: 'npm test', logTail: 'FAIL src/App.test.tsx' });
  assert.match(task, /TIME-BOXED by a wall-clock limit/);
  assert.match(task, /smallest targeted fix/);
  assert.match(task, /start editing within your first few actions/);
});

test('runtimeCheckCommands: default is build then test', () => {
  const prevCmd = process.env.HARNESS_RUNTIME_CHECK_CMD;
  const prevCmds = process.env.HARNESS_RUNTIME_CHECK_CMDS;
  delete process.env.HARNESS_RUNTIME_CHECK_CMD;
  delete process.env.HARNESS_RUNTIME_CHECK_CMDS;
  assert.deepEqual(runtimeCheckCommands(), ['npm run build', 'npm test']);
  process.env.HARNESS_RUNTIME_CHECK_CMDS = 'npm run build; npm test';
  assert.deepEqual(runtimeCheckCommands(), ['npm run build', 'npm test']);
  process.env.HARNESS_RUNTIME_CHECK_CMD = 'npm run lint';
  delete process.env.HARNESS_RUNTIME_CHECK_CMDS;
  assert.deepEqual(runtimeCheckCommands(), ['npm run lint']);
  if (prevCmd === undefined) delete process.env.HARNESS_RUNTIME_CHECK_CMD;
  else process.env.HARNESS_RUNTIME_CHECK_CMD = prevCmd;
  if (prevCmds === undefined) delete process.env.HARNESS_RUNTIME_CHECK_CMDS;
  else process.env.HARNESS_RUNTIME_CHECK_CMDS = prevCmds;
});

test('runRuntimeCheck: runs each command in nested packages', async () => {
  const prev = process.env.HARNESS_RUNTIME_CHECK;
  const prevCmd = process.env.HARNESS_RUNTIME_CHECK_CMD;
  const prevCmds = process.env.HARNESS_RUNTIME_CHECK_CMDS;
  process.env.HARNESS_RUNTIME_CHECK = '1';
  delete process.env.HARNESS_RUNTIME_CHECK_CMD;
  process.env.HARNESS_RUNTIME_CHECK_CMDS = 'node -e "process.exit(0)"; node -e "process.exit(0)"';

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-rc-multi-'));
  await fs.mkdir(path.join(root, 'pkg'));
  await fs.writeFile(path.join(root, 'pkg', 'package.json'), '{"name":"pkg"}');

  const result = runRuntimeCheck(root);
  assert.equal(result.skipped, false);
  assert.equal(result.ok, true);
  assert.equal(result.steps.filter((s) => s.command.startsWith('node -e')).length, 2);

  process.env.HARNESS_RUNTIME_CHECK = prev;
  if (prevCmd === undefined) delete process.env.HARNESS_RUNTIME_CHECK_CMD;
  else process.env.HARNESS_RUNTIME_CHECK_CMD = prevCmd;
  if (prevCmds === undefined) delete process.env.HARNESS_RUNTIME_CHECK_CMDS;
  else process.env.HARNESS_RUNTIME_CHECK_CMDS = prevCmds;
});

test('runRuntimeCheck: scrubs provider keys from executed commands', async (t) => {
  const prevEnabled = process.env.HARNESS_RUNTIME_CHECK;
  const prevCmd = process.env.HARNESS_RUNTIME_CHECK_CMD;
  const prevCmds = process.env.HARNESS_RUNTIME_CHECK_CMDS;
  const prevOpenAi = process.env.OPENAI_API_KEY;
  const prevNpmToken = process.env.npm_config__authToken;

  t.after(() => {
    if (prevEnabled === undefined) delete process.env.HARNESS_RUNTIME_CHECK;
    else process.env.HARNESS_RUNTIME_CHECK = prevEnabled;
    if (prevCmd === undefined) delete process.env.HARNESS_RUNTIME_CHECK_CMD;
    else process.env.HARNESS_RUNTIME_CHECK_CMD = prevCmd;
    if (prevCmds === undefined) delete process.env.HARNESS_RUNTIME_CHECK_CMDS;
    else process.env.HARNESS_RUNTIME_CHECK_CMDS = prevCmds;
    if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAi;
    if (prevNpmToken === undefined) delete process.env.npm_config__authToken;
    else process.env.npm_config__authToken = prevNpmToken;
  });

  process.env.HARNESS_RUNTIME_CHECK = '1';
  process.env.HARNESS_RUNTIME_CHECK_CMD = [
    'node -e "process.stdout.write([',
    'process.env.OPENAI_API_KEY,',
    'process.env.npm_config__authToken',
    '].filter(Boolean).join(\\\":\\\"))"',
  ].join('');
  delete process.env.HARNESS_RUNTIME_CHECK_CMDS;
  process.env.OPENAI_API_KEY = 'sk-test-secret';
  process.env.npm_config__authToken = 'npm-token-secret';

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-rc-env-'));
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"pkg"}');
  await fs.mkdir(path.join(root, 'node_modules'));

  const result = runRuntimeCheck(root);
  assert.equal(result.ok, true);
  assert.equal(result.combined, '');
});

test('runRuntimeCheck: runs check in each nested package when root has no package.json', async () => {
  const prev = process.env.HARNESS_RUNTIME_CHECK;
  const prevCmd = process.env.HARNESS_RUNTIME_CHECK_CMD;
  const prevCmds = process.env.HARNESS_RUNTIME_CHECK_CMDS;
  process.env.HARNESS_RUNTIME_CHECK = '1';
  process.env.HARNESS_RUNTIME_CHECK_CMD = 'node -e "process.exit(0)"';
  delete process.env.HARNESS_RUNTIME_CHECK_CMDS;

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-rc-nested-'));
  await fs.mkdir(path.join(root, 'backend'));
  await fs.mkdir(path.join(root, 'frontend'));
  await fs.writeFile(path.join(root, 'backend', 'package.json'), '{"name":"backend"}');
  await fs.writeFile(path.join(root, 'frontend', 'package.json'), '{"name":"frontend"}');

  const result = runRuntimeCheck(root);
  assert.equal(result.skipped, false);
  assert.equal(result.ok, true);
  assert.deepEqual(result.packages, ['backend', 'frontend']);
  assert.equal(result.steps.filter((s) => s.command === 'node -e "process.exit(0)"').length, 2);

  process.env.HARNESS_RUNTIME_CHECK = prev;
  if (prevCmd === undefined) delete process.env.HARNESS_RUNTIME_CHECK_CMD;
  else process.env.HARNESS_RUNTIME_CHECK_CMD = prevCmd;
  if (prevCmds === undefined) delete process.env.HARNESS_RUNTIME_CHECK_CMDS;
  else process.env.HARNESS_RUNTIME_CHECK_CMDS = prevCmds;
});

test('discoverPackageDirs: finds root and nested package.json dirs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-pkg-'));
  await fs.mkdir(path.join(root, 'backend'));
  await fs.mkdir(path.join(root, 'frontend'));
  await fs.writeFile(path.join(root, 'package.json'), '{}');
  await fs.writeFile(path.join(root, 'backend', 'package.json'), '{}');
  await fs.writeFile(path.join(root, 'frontend', 'package.json'), '{}');
  const dirs = discoverPackageDirs(root).map((d) => path.relative(root, d) || '.');
  assert.deepEqual(dirs, ['.', 'backend', 'frontend']);
});

test('formatReply: includes runtime_check summary in multi mode', () => {
  const prev = process.env.HARNESS_REPLY_VERBOSE;
  process.env.HARNESS_REPLY_VERBOSE = '1';
  try {
    const reply = formatReply({
      mode: 'multi',
      execution: 'sequential',
      runtimeCheck: { ok: false, command: 'npm run build', exitCode: 2, logTail: 'backend/src/app.ts: error' },
      subAgents: [doneSubAgent('backend')],
    });
    assert.match(reply, /runtime_check: build failed \(exit 2\)/);
    assert.match(reply, /backend\/src\/app\.ts/);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_REPLY_VERBOSE;
    else process.env.HARNESS_REPLY_VERBOSE = prev;
  }
});

test('formatRuntimeCheckSummary: ok line', () => {
  const line = formatRuntimeCheckSummary({ ok: true, command: 'npm run build && npm test' });
  assert.match(line, /^runtime_check: build & test OK$/);
});

// ── deriveAnnotationSyncScope: per-role annotation ownership ─────────────────
test('deriveAnnotationSyncScope: planner-narrow scopes pass through unchanged', () => {
  const subAgent = {
    role: 'backend',
    scope: ['backend'],
    result: {
      scope: ['backend'],
      filesChanged: ['backend/src/server.ts'],
      graphNodesTouched: ['mod:backend/src/server'],
    },
  };
  assert.deepEqual(deriveAnnotationSyncScope(subAgent), ['backend']);
});

test('deriveAnnotationSyncScope: root implementer scope maps to role graph-kind scope', () => {
  const subAgent = {
    role: 'infra',
    scope: ['.'],
    result: {
      scope: ['.'],
      filesChanged: ['docker-compose.yml', 'backend/Dockerfile'],
      graphNodesTouched: ['root'],
    },
  };
  assert.deepEqual(deriveAnnotationSyncScope(subAgent), ['infra']);
});

test('deriveAnnotationSyncScope: default review-fix maps to infra graph-kind scope', () => {
  const subAgent = {
    role: 'default',
    scope: ['.'],
    result: {
      scope: ['.'],
      filesChanged: ['backend/Dockerfile', 'docker-compose.yml'],
      graphNodesTouched: ['infra:dockerfile:backend/Dockerfile'],
    },
  };
  assert.deepEqual(deriveAnnotationSyncScope(subAgent), ['infra']);
});

test('deriveAnnotationSyncScope: default backend code fix maps to backend scope', () => {
  const fromGraph = {
    role: 'default',
    scope: ['.'],
    result: {
      scope: ['.'],
      filesChanged: ['backend/src/app.ts', 'backend/src/routes/todoRoutes.ts'],
      graphNodesTouched: ['mod:backend/src/app', 'mod:backend/src/routes/todoRoutes'],
    },
  };
  assert.deepEqual(deriveAnnotationSyncScope(fromGraph), ['backend']);

  const fromFilesOnly = {
    role: 'default',
    scope: ['.'],
    result: {
      scope: ['.'],
      filesChanged: ['backend/src/services/todoService.ts'],
      graphNodesTouched: ['root'],
    },
  };
  assert.deepEqual(deriveAnnotationSyncScope(fromFilesOnly), ['backend']);
});

test('clearWorkspaceContents: removes children but keeps the workspace root dir', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-ws-'));
  await fs.mkdir(path.join(root, 'sandbox'), { recursive: true });
  await fs.writeFile(path.join(root, 'sandbox', 'app.txt'), 'x');
  await fs.mkdir(path.join(root, '.harness-home'), { recursive: true });
  clearWorkspaceContents(root);
  const entries = await fs.readdir(root);
  assert.deepEqual(entries, []);
  const stat = await fs.stat(root);
  assert.ok(stat.isDirectory());
});

// ── harness run boundary (prior summary + active wipe) ─────────────────────
test('prepareHarnessRun: reads prior summary then clears active only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-run-'));
  const prefix = 'tg-1-100';
  const runDir = path.join(root, '.harness', 'runs', prefix, 'sub-agents');
  await fs.mkdir(path.join(runDir, 'backend'), { recursive: true });
  await fs.mkdir(path.join(runDir, 'frontend'), { recursive: true });
  await fs.writeFile(
    path.join(runDir, 'backend', 'result.json'),
    JSON.stringify({
      status: 'complete',
      summary: 'Added todo API',
      filesChanged: ['backend/src/routes/todos.ts'],
      contractsChanged: ['ADDED GET /api/todos'],
    }),
  );
  await fs.writeFile(
    path.join(runDir, 'frontend', 'result.json'),
    JSON.stringify({
      status: 'complete',
      summary: 'Todo UI',
      filesChanged: ['frontend/src/App.tsx'],
      contractsChanged: ['ADDED page:/'],
    }),
  );

  const { priorRunSummary, priorRunSummaryText } = prepareHarnessRun(root);
  assert.equal(priorRunSummary.runId, prefix);
  assert.equal(priorRunSummary.filesChanged.length, 2);
  assert.equal(priorRunSummary.contractsChanged.length, 2);
  assert.match(priorRunSummaryText, /Prior harness run/);
  assert.ok(Buffer.byteLength(priorRunSummaryText, 'utf8') <= 2048);
  const activeEntries = await fs.readdir(path.join(root, '.harness', 'active'));
  assert.deepEqual(activeEntries, []);
  const runs = await fs.readdir(path.join(root, '.harness', 'runs'));
  assert.deepEqual(runs, [prefix]);
});

test('formatPriorRunSummaryForTask: truncates large contract lists', () => {
  const text = formatPriorRunSummaryForTask({
    runId: 'tg-1-200',
    status: 'complete',
    subAgentCount: 3,
    summary: 'x'.repeat(800),
    filesChanged: Array.from({ length: 30 }, (_, i) => `file${i}.ts`),
    contractsChanged: Array.from({ length: 40 }, (_, i) => `ADDED contract-${i}`),
    blockers: [],
  });
  assert.ok(Buffer.byteLength(text, 'utf8') <= 2048);
  assert.match(text, /…\+/);
});

test('readPriorRunSummary: null on empty harness dir', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-empty-'));
  await fs.mkdir(path.join(root, '.harness', 'active'), { recursive: true });
  await fs.mkdir(path.join(root, '.harness', 'runs'), { recursive: true });
  assert.equal(readPriorRunSummary(root), null);
  clearHarnessArtifacts(root);
});

// ── attachmentsBrief: /task photo attachments surface to every worker ─────────
test('attachmentsBrief: empty when no attachments', () => {
  assert.equal(attachmentsBrief({ task: 'x' }), '');
  assert.equal(attachmentsBrief({ task: 'x', attachments: [] }), '');
  assert.equal(attachmentsBrief(null), '');
});

test('attachmentsBrief: lists relative path, media type, and caption', () => {
  const brief = attachmentsBrief({
    attachments: [{ path: '.attachments/tg-1-2.jpg', mediaType: 'image/jpeg', caption: '/task fix this' }],
  });
  assert.match(brief, /open them with your file\/Read tool/);
  assert.match(brief, /\.attachments\/tg-1-2\.jpg/);
  assert.match(brief, /image\/jpeg/);
  assert.match(brief, /\/task fix this/);
});

test('buildWorkerPrompt: includes the attachments section when present', () => {
  const task = { task: 'do it', attachments: [{ path: '.attachments/a.png', mediaType: 'image/png' }] };
  const assignment = { runId: 'r1', scope: ['.'], acceptanceCriteria: [], constraints: [], contracts: [], requestedChecks: [] };
  const prompt = buildWorkerPrompt(task, assignment, { repoRoot: '/tmp' });
  assert.match(prompt, /\.attachments\/a\.png/);
  // No attachments → no section.
  const plain = buildWorkerPrompt({ task: 'do it' }, assignment, { repoRoot: '/tmp' });
  assert.doesNotMatch(plain, /Attachments \(/);
});

// ── multi-agent: the reference photo reaches the IMPLEMENTER subAgent, not just the planner ─
test('buildSubAgentTask: propagates parent /task attachments down to the subAgent', () => {
  const parentTask = {
    id: 'tg-1-2',
    task: 'scale the UI to match the reference photo',
    attachments: [{ path: '.attachments/tg-1-2.jpg', mediaType: 'image/jpeg', caption: '/task make it big' }],
  };
  const spec = { role: 'frontend', scope: ['frontend'], task: 'enlarge frontend/src/index.css' };
  const subAgentTask = buildSubAgentTask(parentTask, spec, [], '/tmp');
  assert.deepEqual(subAgentTask.attachments, parentTask.attachments);
  // The subAgent worker prompt now renders the actual file path for the implementer to open.
  assert.match(buildWorkerPrompt(subAgentTask, { runId: 'r', scope: ['frontend'] }, { repoRoot: '/tmp' }), /\.attachments\/tg-1-2\.jpg/);
});

test('buildSubAgentTask: no attachments field when the parent task has none', () => {
  const subAgentTask = buildSubAgentTask({ id: 'p', task: 'do x' }, { role: 'frontend', scope: ['frontend'], task: 'edit x' }, [], '/tmp');
  assert.equal('attachments' in subAgentTask, false);
});

// The assignment carries the harness CSQ calibration so the gate is graded by
// harness-owned thresholds in BOTH target modes. In attach the workspace config
// belongs to the target repo and may have no contextQuality section at all —
// without this carrier the engine defaults (implement 0.55 / explore 0.40 /
// byteBudget 120k) grade the gate, double-failing honest deliverers.
test('buildSubAgentTask: contextSession carries harness CSQ calibration per phase', () => {
  const parent = { id: 'p', task: 'do x', contextSession: { sessionId: 'ctx-p', mode: 'harness', required: true } };
  const impl = buildSubAgentTask(parent, { role: 'backend', scope: ['b'], task: 't' }, [], '/tmp').contextSession;
  assert.equal(impl.phase, 'implement');
  assert.equal(impl.qualityThreshold, 0.3);
  assert.equal(impl.warningThreshold, 0.55);
  assert.equal(impl.byteBudget, 200_000);

  const review = buildSubAgentTask(parent, { role: 'review', scope: ['.'], task: 't' }, [], '/tmp').contextSession;
  assert.equal(review.phase, 'explore');
  assert.equal(review.qualityThreshold, 0.3);
  assert.equal(review.warningThreshold, 0.4);

  // Annotate: advisory CSQ (required:false), byteBudget threaded, thresholds
  // stay engine-side (the calibration sets none for this phase).
  const annot = buildSubAgentTask(
    parent,
    { role: 'backend-annotations', scope: ['b'], task: 't', manifest: 'repovine-annotation-writer' },
    [],
    '/tmp',
  ).contextSession;
  assert.equal(annot.phase, 'annotate');
  assert.equal(annot.required, false);
  assert.equal(annot.byteBudget, 200_000);
  assert.equal('qualityThreshold' in annot, false);
});

test('buildPlanPrompt: routes an attached reference image instead of paraphrasing it', () => {
  const task = { task: 'match the photo', attachments: [{ path: '.attachments/a.jpg', mediaType: 'image/jpeg' }] };
  const prompt = buildPlanPrompt(task, 'RULE', '/tmp');
  assert.match(prompt, /\.attachments\/a\.jpg/);
  assert.match(prompt, /open the image file with its Read tool/);
  // No attachment line when there's nothing attached.
  assert.doesNotMatch(buildPlanPrompt({ task: 'plain' }, 'RULE', '/tmp'), /reference image is attached/);
  assert.match(buildPlanPrompt({ task: 'plain' }, 'RULE', '/tmp'), /PLAN SELF-CHECK/, 'planner prompt carries the role-ownership self-check');
  assert.match(buildPlanPrompt({ task: 'plain' }, 'RULE', '/tmp'), /Drop any role that owns none/);
});

// ── blocker dot: completed-subAgent advisory is 🟡, a real blocked/failed subAgent is 🔴 ─
test('formatReply: out-of-scope advisory from a COMPLETED subAgent is a 🟡, not 🔴', () => {
  const subAgents = [
    { role: 'frontend', ok: true, result: { status: 'complete', summary: 'did css', blockers: [] } },
    {
      role: 'default',
      instanceId: 'frontend-annotations',
      ok: true,
      result: {
        status: 'complete',
        summary: 'annotated frontend',
        blockers: ['Repo-wide validate needs-review: backend-scoped nodes stale, out of frontend scope'],
      },
    },
  ];
  const reply = formatReply({ mode: 'multi', subAgents, execution: 'sequential' });
  assert.match(reply, /^✅ Goal delivered/m);
  assert.match(reply, /✅ Process clean — 2\/2 sub-agents/);
  assert.match(reply, /🟡 blockers: 1 unresolved/);
  assert.doesNotMatch(reply, /🔴/);
});

test('formatReply: an unresolved blocker on a BLOCKED subAgent stays 🔴', () => {
  const subAgents = [
    { role: 'frontend', ok: true, result: { status: 'complete', summary: 'did css', blockers: [] } },
    { role: 'backend', ok: false, result: { status: 'blocked', summary: 'blocked', blockers: ['could not write file X'] } },
  ];
  const reply = formatReply({ mode: 'multi', subAgents, execution: 'sequential' });
  assert.match(reply, /🔴 blockers: 1 unresolved/);
});

// ── /ask photo support: the attachment path reaches the read-only ask prompt ──
test('buildAskPrompt: renders the attached image path for the ask agent to open', async () => {
  const { buildAskPrompt } = await import('../lib/workers/ask-prompt.mjs');
  const withPhoto = buildAskPrompt('what does this UI show?', {
    contextSessionId: 'ctx-ask-1',
    attachments: [{ path: '.attachments/ask/tg-1-2.jpg', mediaType: 'image/jpeg', caption: '/ask what is this' }],
  });
  assert.match(withPhoto, /Question: what does this UI show\?/);
  assert.match(withPhoto, /\.attachments\/ask\/tg-1-2\.jpg/);
  assert.match(withPhoto, /open them with your file\/Read tool/);
  // No attachments → no section, ask prompt unchanged.
  const plain = buildAskPrompt('plain question', { contextSessionId: 'ctx-ask-2' });
  assert.doesNotMatch(plain, /Attachments \(/);
});

// ── Post-review annotation sync: the ONLY writer of repovine.annots.json ───────
// Implement sub-agents are told to defer annotations, so every gate below decides
// whether the repo gets graph memory at all. A closed gate used to leave an empty
// annots file and no explanation anywhere.

test('annotationSyncTargets includes a sub-agent whose annotations were deferred', () => {
  // Deferral means "code accepted, annotations owed" — the sub-agent must still be
  // annotated, or the sync it was deferred to skips the very work it was deferred for.
  const subAgents = [
    { role: 'backend', ok: true, annotationSyncDeferred: true, result: { filesChanged: ['backend/src/store/index.ts'] } },
    { role: 'review', ok: true, result: { filesChanged: [] } },
  ];
  const targets = annotationSyncTargets(subAgents);
  assert.deepEqual(targets.map((l) => l.role), ['backend']);
});

test('annotationSyncTargets drops a genuinely rejected sub-agent', () => {
  const subAgents = [{ role: 'backend', ok: false, result: { filesChanged: ['backend/src/store/index.ts'] } }];
  assert.deepEqual(annotationSyncTargets(subAgents), []);
});

test('annotationSyncTargets keeps a protocol-red subAgent that DELIVERED (terminal status + files)', () => {
  // A CSQ-rejected implementer whose code the review gate approved must still get
  // annotation sync — otherwise the graph memory goes stale for the next run.
  const subAgents = [
    { role: 'frontend', ok: false, result: { status: 'complete', filesChanged: ['frontend/src/App.tsx'] } },
    { role: 'backend', ok: false, result: { status: 'blocked', filesChanged: ['backend/src/a.ts'] } },
    { role: 'infra', ok: false, result: { status: 'failed', filesChanged: ['Dockerfile'] } },
  ];
  assert.deepEqual(annotationSyncTargets(subAgents).map((l) => l.role), ['frontend']);
});

test('reviewFixEligible acts on parsed blockers even when the review itself was rejected', () => {
  const blockers = ['Frontend workspace has no test script'];
  assert.equal(
    reviewFixEligible({ role: 'review', ok: false, schemaValid: true, result: { blockers } }),
    true,
    'a compliance-rejected but parsed review still reports real blockers',
  );
  assert.equal(
    reviewFixEligible({ role: 'review', ok: false, schemaValid: false, result: { blockers } }),
    false,
    'a schema-invalid review result is not trustworthy',
  );
  assert.equal(reviewFixEligible({ role: 'review', ok: true, schemaValid: true, result: { blockers: [] } }), false);
});

test('annotationSyncSkipReason names the gate that held the sync back', () => {
  const unreadableReview = [{
    role: 'review',
    ok: false,
    schemaValid: false,
    result: { blockers: ['no frontend tests'] },
    handoff: { blockers: ['no frontend tests'] },
  }];
  assert.match(annotationSyncSkipReason(unreadableReview, null, null), /failed schema validation/);

  const blockedReview = [{
    role: 'review',
    ok: true,
    schemaValid: true,
    result: { status: 'complete', blockers: ['no frontend tests'] },
    handoff: { blockers: ['no frontend tests'] },
  }];
  assert.match(annotationSyncSkipReason(blockedReview, null, null), /1 unresolved blocker/);
});
