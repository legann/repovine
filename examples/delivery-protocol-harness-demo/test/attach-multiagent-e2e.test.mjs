// End-to-end policy threading through the REAL multiAgent (delete-guard for the
// wiring): an attach invoke must reach finalization with git-tree custody
// through the disposable-repo pointer, non-collapsed stages, and zero
// Git-parallel side effects — deleting the gitOperationsAllowed threading turns
// the greenfield batch back on and fails this test. Workers run the local
// provider without LOCAL_BASE_URL and block instantly (no network); the
// repovine CLI gates still execute for real against the fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeAttachWorkspace } from './fixtures/attach-workspace.mjs';

const ENV_KEYS = ['HARNESS_REPOVINE_PROCESS', 'AGENTS', 'LOCAL_BASE_URL', 'HARNESS_GREENFIELD_PARALLEL', 'LLM_PROVIDER'];

test('multiAgent(attach): git-tree custody via the pointer, sequential non-collapsed stages, no Git-parallel side effects', async () => {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  // Orient/verify off (no provider), heuristic planner, blocked local workers,
  // greenfield parallel left ON — the policy gate, not the env, must prevent
  // collapsing.
  process.env.HARNESS_REPOVINE_PROCESS = '0';
  process.env.AGENTS = 'keyword';
  delete process.env.LOCAL_BASE_URL;
  process.env.HARNESS_GREENFIELD_PARALLEL = '1';

  // Greenfield-classifying attach workspace (no product source markers): the
  // exact case where an unthreaded policy would collapse stages and fan out
  // worktrees against the disposable repo.
  const ws = makeAttachWorkspace();
  const pointerBytes = fs.readFileSync(path.join(ws.root, '.git'), 'utf8');
  try {
    const { multiAgent } = await import('../lib/graph/multi.mjs');
    const out = await multiAgent(
      {
        task: { id: 'attach-e2e-1', task: 'update the backend and frontend', scope: ['.'] },
        repoRoot: ws.root,
        targetMode: 'attach',
        llmProvider: 'local',
        workerSessions: {},
      },
      {},
    );

    // Custody captured through the pointer into the disposable repo.
    assert.equal(out.signals.treeDiff.backend, 'git-tree');
    assert.equal(out.signals.treeDiff.captured, true, 'authoritative diff captured through the pointer');
    assert.equal(out.execution, 'sequential');

    // Stages stayed non-collapsed (refresh barriers preserved): the recorded
    // plan has one role per stage — the app-frame guarantee injects `infra` on
    // greenfield build plans; collapsed would be one 3-role batch.
    const events = fs.readFileSync(path.join(ws.root, '.harness', 'active', 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    const plan = events.find((e) => e.event === 'plan_finished');
    assert.ok(plan, 'plan_finished recorded');
    assert.deepEqual(plan.stages, [['infra'], ['backend'], ['frontend']], 'no greenfield batch under attach policy');

    // Zero Git-parallel side effects: pointer intact, no worktree fan-out, no
    // harness .gitignore, HEAD still on the baseline (no stray commits).
    assert.equal(fs.readFileSync(path.join(ws.root, '.git'), 'utf8'), pointerBytes);
    assert.ok(!fs.existsSync(path.join(ws.root, '.worktrees')), 'no worktree fan-out');
    assert.ok(!fs.existsSync(path.join(ws.root, '.gitignore')), 'ensureGitRepo wrote nothing');
    assert.equal(ws.git(['rev-parse', 'HEAD']).stdout.trim(), ws.baselineOid, 'HEAD untouched by the run');
    // Workers blocked (no LOCAL_BASE_URL) — the run reports that honestly.
    assert.ok(out.subAgents.length >= 2);
    assert.ok(out.subAgents.every((l) => l.result?.status === 'blocked'), 'local workers blocked without a base URL');
  } finally {
    ws.cleanup();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
