// Contract test (§17.1): the demo builds assignments/results the NEW repovine core
// accepts, proven by spawning the real `agents` CLI — not by asserting demo internals.
//
// This closes the "green ≠ working" gap the S3/S4 schema reshape opened: the rest of
// the demo suite spawns only `delivery(['manifests'])` (no graph, no assignment schema),
// so a `buildAssignment` that drifted from AgentAssignmentSchema (missing role/version,
// string criteria) stayed green while the real dispatch would reject it before any
// worker ran. Here `buildAssignment` output goes through `delivery validate-assignment`,
// and a full AgentRunResult through `delivery compliance`, in a clean target repo.
//
// Requires the built CLI (`npm run build` at the repovine root); lib/repovine.mjs
// resolves dist/mcp/index.js by walking up from this package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildAssignment } from '../lib/assignment.mjs';
import { validateAssignment, compliance } from '../lib/repovine.mjs';

// The appendix mini-repo. Kept OUT of the repovine working tree: run in repovine's own
// cwd and `annotationsClean=true` honestly reddens from its drift (orphaned/stale nodes),
// contaminating the report. A clean target isolates the protocol check.
function makeTargetRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-contract-'));
  fs.writeFileSync(path.join(root, 'repovine.config.json'), JSON.stringify({ semantic_search_embeddings: false }));
  fs.writeFileSync(path.join(root, 'repovine.annots.json'), JSON.stringify({ version: 1, annotations: {} }));
  const pkg = path.join(root, 'packages', 'orders');
  fs.mkdirSync(path.join(pkg, 'src'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'orders', version: '0.0.0' }));
  fs.writeFileSync(path.join(pkg, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true },
    include: ['src/**/*.ts'],
  }));
  fs.writeFileSync(path.join(pkg, 'src', 'dedupe.ts'), 'export function dedupe<T>(xs: T[]): T[] { return [...new Set(xs)]; }\n');
  return root;
}

// A task carrying assignment-time acceptance criteria + a verification policy,
// the shape a harness supplies at intake.
const sampleTask = {
  id: 'e2e-1',
  task: 'Deduplicate orders and write an audit log',
  scope: ['packages/orders'],
  acceptanceCriteria: [
    { id: 'c1', statement: 'Orders are deduplicated', required: true },
    { id: 'c2', statement: 'Audit log records each transition', required: true },
  ],
  verificationPolicy: {
    version: 1,
    requirements: [
      { criterionId: 'c1', evidenceKinds: ['repository'] },
      { criterionId: 'c2', evidenceKinds: ['repository'] },
    ],
  },
};

/** A schema-complete AgentRunResult skeleton; the caller adds deliveryVerification. */
function baseResult(runId) {
  return {
    protocolVersion: '1',
    runId,
    status: 'complete',
    summary: 'Deduplicated orders; the audit log records each transition.',
    scope: ['packages/orders'],
    // Delivery verification is read-only; a non-empty filesChanged would add DELIVERY_NOT_READONLY.
    filesChanged: [],
    graphNodesTouched: [],
    contractsChanged: [],
    testsRun: [],
    annotationsWritten: [],
    compliance: {
      refreshContextRun: true,
      annotationsClean: true,
      dependencyImpactChecked: true,
      configSurfaceChecked: true,
      flowChecked: true,
      architectureChecked: false,
    },
    blockers: [],
  };
}

const repoEvidence = { kind: 'repository', file: 'packages/orders/src/dedupe.ts', explanation: 'implementation' };

function goodResult(runId) {
  return {
    ...baseResult(runId),
    deliveryVerification: {
      criteriaResults: [
        { criterionId: 'c1', status: 'covered', evidence: [repoEvidence], explanation: 'deduped' },
        { criterionId: 'c2', status: 'covered', evidence: [repoEvidence], explanation: 'audited' },
      ],
      verdict: { intentVerified: true, deliveryAccepted: true },
    },
  };
}

function badResult(runId) {
  return {
    ...baseResult(runId),
    deliveryVerification: {
      criteriaResults: [
        // c1 "covered" but cites only a test — no repository evidence, and `test` is outside the policy allowlist.
        { criterionId: 'c1', status: 'covered', evidence: [{ kind: 'test', explanation: 'a test ran' }], explanation: 'x' },
        // ghost is not a declared criterion; c2 (required) has no result at all.
        { criterionId: 'ghost', status: 'gap', evidence: [], explanation: 'undeclared' },
      ],
      // Both verdict flags claim success while a required criterion is unresolved.
      verdict: { intentVerified: true, deliveryAccepted: true },
    },
  };
}

function writeJson(root, name, value) {
  const file = path.join(root, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

test('§17.1 contract: buildAssignment output passes `delivery validate-assignment`', () => {
  const root = makeTargetRepo();
  try {
    const assignment = buildAssignment(sampleTask);
    // The reshape S3/S4 added: role + version + structural criteria.
    assert.equal(assignment.role, 'main');
    assert.equal(assignment.version, 1);
    assert.deepEqual(assignment.acceptanceCriteria, sampleTask.acceptanceCriteria);

    const file = writeJson(root, 'assignment.json', assignment);
    const res = validateAssignment(file, root);
    assert.ok(res.json, 'no JSON from the CLI — is dist built? run `npm run build` at the repovine root');
    assert.equal(res.json.valid, true, `validate-assignment rejected: ${JSON.stringify(res.json.errors)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('§17.1 contract: buildAssignment mints structural criteria from bare strings', () => {
  const root = makeTargetRepo();
  try {
    const assignment = buildAssignment({ id: 's1', task: 'ship it', scope: ['.'], acceptanceCriteria: ['renders'] });
    assert.deepEqual(assignment.acceptanceCriteria, [{ id: 'c1', statement: 'renders', required: true }]);
    const file = writeJson(root, 'assignment-strings.json', assignment);
    assert.equal(validateAssignment(file, root).json.valid, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('§17.1 contract: the OLD assignment shape (no role/version) is rejected by the gate', () => {
  const root = makeTargetRepo();
  try {
    // What buildAssignment emitted before the reshape — the exact drift a green demo suite hid.
    const oldShape = {
      protocolVersion: '1',
      runId: 'run-old',
      task: 'ship it',
      scope: ['.'],
      acceptanceCriteria: ['renders'],
      constraints: [],
      contracts: [],
      requestedChecks: [],
    };
    const file = writeJson(root, 'assignment-old.json', oldShape);
    assert.equal(validateAssignment(file, root).json.valid, false, 'the schema gate must bite the pre-reshape shape');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('§17.1 contract: a well-formed delivery result passes `delivery compliance`', () => {
  const root = makeTargetRepo();
  try {
    const assignment = buildAssignment(sampleTask);
    const assignmentFile = writeJson(root, 'assignment.json', assignment);
    const resultFile = writeJson(root, 'result-good.json', goodResult(assignment.runId));

    const res = compliance(resultFile, { assignment: assignmentFile, repoRoot: root });
    assert.ok(res.json?.report, `no compliance report: ${res.stderr || res.stdout}`);
    assert.equal(res.json.report.valid, true, `unexpected errors: ${JSON.stringify(res.json.report.errors)}`);
    assert.deepEqual(res.json.report.diagnostics, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('§17.1 contract: a self-contradicting delivery result yields the six delivery codes', () => {
  const root = makeTargetRepo();
  try {
    const assignment = buildAssignment(sampleTask);
    const assignmentFile = writeJson(root, 'assignment.json', assignment);
    const resultFile = writeJson(root, 'result-bad.json', badResult(assignment.runId));

    const res = compliance(resultFile, { assignment: assignmentFile, repoRoot: root });
    assert.ok(res.json?.report, `no compliance report: ${res.stderr || res.stdout}`);
    assert.equal(res.json.report.valid, false);

    const codes = new Set((res.json.report.diagnostics ?? []).map((d) => d.code));
    const expected = [
      'CRITERION_RESULT_UNKNOWN',
      'CRITERION_REQUIRED_UNRESULTED',
      'INTENT_VERIFIED_WITH_OPEN_CRITERION',
      'VERDICT_INCONSISTENT_WITH_REGISTRY',
      'CRITERION_COVERED_NO_REPOSITORY_EVIDENCE',
      'EVIDENCE_KIND_NOT_IN_POLICY',
    ];
    for (const code of expected) assert.ok(codes.has(code), `missing delivery code ${code}; got ${[...codes].join(', ')}`);
    // A clean target repo adds no incidental codes — the delivery set is exactly these six.
    assert.deepEqual([...codes].sort(), [...expected].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
