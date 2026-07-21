// Data-plane contract invariants: which payload MUST reach which subAgent.
//
// The control-plane FSM (states, transitions, gates) is covered elsewhere; this
// file pins the PAYLOAD plumbing — the class of bug where a subAgent silently loses
// the orient context, claims, custody, or its own assignment on resume/retry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSubAgentTask } from '../lib/graph/sub-agent.mjs';
import { verifyClaimsTask } from '../lib/graph/repovine-process.mjs';
import { userPrompt, supportsResume as claudeSupportsResume } from '../lib/claude-agent.mjs';
import { supportsResume as localSupportsResume } from '../lib/workers/local.mjs';
import { assembleFixBlockers } from '../lib/graph/multi.mjs';

const ORIENT_SECTION = [
  '',
  '## Repovine orient (graph scope for this run)',
  '- graphNodes: mod:backend/src/a, pkg:frontend',
  '- ANCHOR FIRST: inspect_node the graphNodes above…',
  '- claims: users can add todos',
].join('\n');

const parentTask = (over = {}) => ({
  id: 'run-1',
  task: 'Build the feature.\n## Repovine orient (embedded in parent text)\n- graphNodes: …',
  contracts: ['API: GET /todos'],
  repovineOrientSection: ORIENT_SECTION,
  contextSession: { sessionId: 'ctx-run-1', mode: 'harness', required: true },
  ...over,
});

// ── Orient payload transport ────────────────────────────────────────────────────

test('contract: a spec.task override (LLM plan / fix / sync) still receives the orient section', () => {
  const subAgent = buildSubAgentTask(parentTask(), { role: 'backend', scope: ['backend'], task: 'Planner-authored: add the API.' }, [], '/tmp');
  assert.match(subAgent.task, /Planner-authored: add the API\./);
  assert.match(subAgent.task, /## Repovine orient \(graph scope for this run\)/, 'orient section appended');
  assert.match(subAgent.task, /ANCHOR FIRST/, 'guidance travels with the section');
});

test('contract: a fallback subAgent (no spec.task) carries the orient context exactly once', () => {
  const subAgent = buildSubAgentTask(parentTask(), { role: 'backend', scope: ['backend'] }, [], '/tmp');
  const occurrences = subAgent.task.split('## Repovine orient').length - 1;
  assert.equal(occurrences, 1, 'parent text already embeds it — no duplicate append');
});

test('contract: the orient PRODUCER subAgent gets no orient section (field absent pre-orient)', () => {
  const preOrient = parentTask({ repovineOrientSection: undefined, task: 'raw user task' });
  const subAgent = buildSubAgentTask(preOrient, { role: 'repo-explorer', scope: ['.'], task: 'Orient the repo.' }, [], '/tmp');
  assert.doesNotMatch(subAgent.task, /## Repovine orient/);
});

test('contract: orient claims in the handoff LEDGER survive a spec.task override', () => {
  // multiAgent pushes the orient subAgent handoff into `handoffs`; buildSubAgentTask folds
  // every prior handoff's contractsChanged into assignment contracts + the
  // inter-subAgent section — the one channel that survives task overrides.
  const orientHandoff = { role: 'repo-explorer', workSummary: 'oriented', contractsChanged: ['CLAIM: users can add todos'], filesChanged: [], blockers: [] };
  const subAgent = buildSubAgentTask(parentTask(), { role: 'backend', scope: ['backend'], task: 'Planner text.' }, [orientHandoff], '/tmp');
  assert.ok(subAgent.contracts.includes('CLAIM: users can add todos'), 'claim entered the contract ledger');
  assert.match(subAgent.task, /CLAIM: users can add todos/, 'ledger renders in the inter-subAgent section');
});

// ── Custody ────────────────────────────────────────────────────────────────────

test('contract: annotate-phase subAgents stay CSQ-advisory; implement subAgents inherit policy', () => {
  const annotate = buildSubAgentTask(parentTask(), { role: 'backend', scope: ['backend'], instanceId: 'backend-annotations', contextPhase: 'annotate', task: 'sync' }, [], '/tmp');
  assert.equal(annotate.contextSession.required, false);
  const implement = buildSubAgentTask(parentTask(), { role: 'backend', scope: ['backend'] }, [], '/tmp');
  assert.equal(implement.contextSession.required, true);
});

// ── Resume/retry honesty ───────────────────────────────────────────────────────

test('contract: the resuming claude prompt restates the NEW subAgent assignment (scope/criteria/constraints/checks)', () => {
  const task = { task: 'New subAgent task text', embedsContracts: false };
  const assignment = {
    runId: 'r2',
    scope: ['frontend'],
    acceptanceCriteria: ['renders'],
    constraints: ['stay in scope'],
    contracts: ['API: GET /todos'],
    requestedChecks: ['dependencies'],
  };
  const prompt = userPrompt(task, assignment, true);
  assert.match(prompt, /NEW assignment/);
  assert.match(prompt, /"frontend"/, 'scope restated');
  assert.match(prompt, /renders/, 'criteria restated');
  assert.match(prompt, /stay in scope/, 'constraints restated');
  assert.match(prompt, /dependencies/, 'requested checks restated');
});

test('contract: provider resume capability is declared (stateless workers re-fold the full task on retry)', () => {
  assert.equal(claudeSupportsResume, true);
  assert.equal(localSupportsResume, false);
});

// ── Verify and fix inputs ──────────────────────────────────────────────────────

test('contract: verify-claims task embeds the harness tree-diff when provided', () => {
  const withDiff = verifyClaimsTask({
    claims: [{ id: 'c1', text: 'adds todos' }],
    orientTrail: { graphNodes: ['mod:backend/src/a'] },
    implementSummaries: ['[backend] did it'],
    treeDiffSection: '\n## Harness tree-diff (authoritative changed files)\n- backend/src/a.ts',
  });
  assert.match(withDiff, /Harness tree-diff/);
  const withoutDiff = verifyClaimsTask({ claims: [{ id: 'c1', text: 'adds todos' }] });
  assert.doesNotMatch(withoutDiff, /Harness tree-diff/);
});

test('contract: verify receives prior-run graph contracts for touched nodes (read-only)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { collectAnnotationObligations, obligationsSection } = await import('../lib/graph/annotation-obligations.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obl-'));
  try {
    fs.writeFileSync(path.join(root, 'repovine.annots.json'), JSON.stringify({
      version: 1,
      annotations: {
        'mod:backend/src/store': {
          annotation: {
            summary: 'store',
            invariants: ['completing the last open child auto-closes the parent'],
            risks: [{ text: 'in-memory state lost on restart', scope: 'local' }],
            sideEffects: [{ kind: 'state-local', description: 'mutates todos array' }],
          },
        },
        'mod:untouched/module': { annotation: { invariants: ['must not appear'] } },
      },
    }));
    const obligations = collectAnnotationObligations(root, ['mod:backend/src/store', 'mod:missing/node']);
    assert.equal(obligations.length, 3, 'invariant + risk + sideEffect from the touched node only');
    assert.ok(obligations.some((o) => o.kind === 'invariant' && /auto-closes/.test(o.text)));
    assert.ok(!obligations.some((o) => /must not appear/.test(o.text)), 'untouched nodes excluded');

    const section = obligationsSection(obligations);
    assert.match(section, /Graph memory obligations/);
    assert.match(section, /OBLIGATION: preserved\|violated/);
    assert.equal(obligationsSection([]), '', 'no obligations → no section');

    const { verifyClaimsTask } = await import('../lib/graph/repovine-process.mjs');
    const task = verifyClaimsTask({ claims: [{ id: 'c1', text: 'x' }], graphObligationsSection: section });
    assert.match(task, /auto-closes the parent/, 'obligations reach the verify task');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('contract: the floor has a fix transition even with NO review subAgent', () => {
  assert.deepEqual(
    assembleFixBlockers(null, ['grounded tests gate: backend wrote under backend but no test file exists']),
    ['grounded tests gate: backend wrote under backend but no test file exists'],
  );
});
