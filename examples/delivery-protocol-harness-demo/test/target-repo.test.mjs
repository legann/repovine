// Target contract: sandbox characterization + attach resolver/policy/validation.
//
// Part 1 pins the sandbox seed/reset behavior (rollout step 1 characterization):
// the assertions were written against the pre-refactor ensureRepovineWorkspace/
// clearWorkspaceContents implementation and must stay green byte-for-byte through
// the target-contract refactor. The shim below calls the new API when present so
// the same assertions prove behavior preservation across the change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as target from '../lib/target-repo.mjs';
import { ATTACH_GIT_POINTER_CONTENT } from '../lib/attach-guard.mjs';
import { makeAttachWorkspace } from './fixtures/attach-workspace.mjs';
import { commitAttachRun } from '../lib/graph/workspace-revision.mjs';

const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf-8' });
const gitOk = !git(['--version'], os.tmpdir()).error;

const tmpWorkspace = () => fs.mkdtempSync(path.join(os.tmpdir(), 'target-ws-'));
const sandboxRootIn = (ws) => path.join(ws, 'sandbox');

// Shim: same observable contract before and after the refactor.
const ensureSandboxAt = (root) =>
  target.ensureTarget
    ? target.ensureTarget({ mode: 'sandbox', repoRoot: root })
    : target.ensureRepovineWorkspace(root);
const resetSandboxAt = (root) =>
  target.resetTarget
    ? target.resetTarget({ mode: 'sandbox', repoRoot: root })
    : target.clearWorkspaceContents(root);

const ANNOTS_STUB = '{"version":1,"annotations":{}}\n';

test('sandbox seed: stubs, runtime dir, git repo with HEAD (characterization)', { skip: !gitOk }, () => {
  const ws = tmpWorkspace();
  const root = sandboxRootIn(ws);
  try {
    const out = ensureSandboxAt(root);
    assert.equal(out, root, 'returns the sandbox root');
    assert.ok(fs.statSync(root).isDirectory());

    // Annotation stub: exact bytes.
    assert.equal(fs.readFileSync(path.join(root, 'repovine.annots.json'), 'utf8'), ANNOTS_STUB);

    // Config stub: scan excludes + harness contextQuality block.
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'repovine.config.json'), 'utf8'));
    assert.deepEqual(cfg.build.scan.exclude, [
      'node_modules', '.git', 'dist', '.repovine', '.harness', '.attachments', '.claude', '.worktrees',
    ]);
    assert.equal(cfg.contextQuality.enforcement.mode, 'harness');
    assert.equal(cfg.contextQuality.thresholds.explore.threshold, 0.3);
    assert.equal(cfg.contextQuality.thresholds.implement.threshold, 0.3);
    assert.equal(cfg.contextQuality.recoveryWindow, 8);

    // Provider runtime dir on the workspace parent.
    assert.ok(fs.statSync(path.join(ws, '.harness-home')).isDirectory());

    // Own git repo with a baseline HEAD and the harness .gitignore.
    assert.equal(git(['rev-parse', '--git-dir'], root).stdout.trim(), '.git');
    assert.equal(git(['rev-parse', '--verify', 'HEAD'], root).status, 0);
    assert.equal(
      fs.readFileSync(path.join(root, '.gitignore'), 'utf8'),
      ['node_modules/', '.repovine/', '.harness/', '.worktrees/', 'dist/', ''].join('\n'),
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('sandbox seed is lazy and non-destructive: existing files preserved (characterization)', { skip: !gitOk }, () => {
  const ws = tmpWorkspace();
  const root = sandboxRootIn(ws);
  try {
    fs.mkdirSync(root, { recursive: true });
    const annots = '{"version":1,"annotations":{"mod:app/x":{"summary":"real"}}}\n';
    const config = '{"build":{"scan":{"exclude":["custom"]}}}\n';
    fs.writeFileSync(path.join(root, 'repovine.annots.json'), annots);
    fs.writeFileSync(path.join(root, 'repovine.config.json'), config);
    fs.writeFileSync(path.join(root, 'app.txt'), 'user data\n');

    ensureSandboxAt(root);
    ensureSandboxAt(root); // idempotent second pass

    assert.equal(fs.readFileSync(path.join(root, 'repovine.annots.json'), 'utf8'), annots, 'annotations untouched');
    assert.equal(fs.readFileSync(path.join(root, 'repovine.config.json'), 'utf8'), config, 'config untouched');
    assert.equal(fs.readFileSync(path.join(root, 'app.txt'), 'utf8'), 'user data\n', 'user files untouched');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('sandbox reset: wipes contents, keeps the root, next seed restores stubs (characterization)', { skip: !gitOk }, () => {
  const ws = tmpWorkspace();
  const root = sandboxRootIn(ws);
  try {
    ensureSandboxAt(root);
    fs.writeFileSync(path.join(root, 'junk.txt'), 'x');

    resetSandboxAt(root);
    assert.ok(fs.existsSync(root), 'root dir survives the wipe');
    assert.deepEqual(fs.readdirSync(root), [], 'contents removed');

    ensureSandboxAt(root);
    assert.equal(fs.readFileSync(path.join(root, 'repovine.annots.json'), 'utf8'), ANNOTS_STUB, 're-seeded');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ── resolveTargetFromEnv ─────────────────────────────────────────────────────

test('resolveTargetFromEnv: unset mode is sandbox with the default root', () => {
  const t = target.resolveTargetFromEnv({});
  assert.equal(t.mode, 'sandbox');
  assert.ok(t.repoRoot.endsWith(path.join('.workspace', 'sandbox')));
});

test('resolveTargetFromEnv: unknown mode fails before provider resolution', () => {
  assert.throws(() => target.resolveTargetFromEnv({ HARNESS_TARGET_MODE: 'shared' }), /Unknown HARNESS_TARGET_MODE/);
});

test('resolveTargetFromEnv: attach requires HARNESS_REPO_ROOT', () => {
  assert.throws(() => target.resolveTargetFromEnv({ HARNESS_TARGET_MODE: 'attach' }), /HARNESS_REPO_ROOT/);
});

test('resolveTargetFromEnv: Docker attach pins the root to /workspace', () => {
  assert.throws(
    () => target.resolveTargetFromEnv({ HARNESS_TARGET_MODE: 'attach', HARNESS_REPO_ROOT: '/tmp/elsewhere', REPOVINE_IN_DOCKER: '1' }),
    /\/workspace/,
  );
  const ok = target.resolveTargetFromEnv({ HARNESS_TARGET_MODE: 'attach', HARNESS_REPO_ROOT: '/workspace', REPOVINE_IN_DOCKER: '1' });
  assert.deepEqual(ok, { mode: 'attach', repoRoot: '/workspace' });
});

test('resolveTargetFromEnv: conflicting REPOVINE_ROOT fails; an equal one passes', () => {
  assert.throws(
    () => target.resolveTargetFromEnv({ HARNESS_TARGET_MODE: 'attach', HARNESS_REPO_ROOT: '/workspace', REPOVINE_ROOT: '/somewhere/else' }),
    /REPOVINE_ROOT/,
  );
  const ok = target.resolveTargetFromEnv({ HARNESS_TARGET_MODE: 'attach', HARNESS_REPO_ROOT: '/workspace', REPOVINE_ROOT: '/workspace' });
  assert.equal(ok.repoRoot, '/workspace');
  // Sandbox mode enforces the same consistency rule.
  assert.throws(
    () => target.resolveTargetFromEnv({ REPOVINE_ROOT: '/somewhere/else' }),
    /REPOVINE_ROOT/,
  );
});

// ── targetPolicy ─────────────────────────────────────────────────────────────

test('targetPolicy: pure capability map, no environment input', () => {
  assert.deepEqual(target.targetPolicy('sandbox'), { resetAllowed: true, gitOperationsAllowed: true });
  // Phase 2: attach reset restores the launch baseline; gitOperationsAllowed
  // scopes only the harness-internal Git-parallel execution and stays false.
  assert.deepEqual(target.targetPolicy('attach'), { resetAllowed: true, gitOperationsAllowed: false });
  assert.throws(() => target.targetPolicy('shared'), /Unknown target mode/);
  // targetPolicy(mode).length — the function takes ONLY the mode; nothing else can feed it.
  assert.equal(target.targetPolicy.length, 1);
});

// ── attach validation ────────────────────────────────────────────────────────

const WORKTREE_POINTER = 'gitdir: /real/repo/.git/worktrees/run-001\n';
const REAL_ANNOTS = '{"version":1,"annotations":{"mod:app/x":{"summary":"real note"}}}\n';
const REAL_CONFIG = '{"build":{"scan":{"exclude":["node_modules"]}},"contextQuality":{"thresholds":{}}}\n';

function attachFixture({ config = REAL_CONFIG, annots = REAL_ANNOTS, git = WORKTREE_POINTER } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-'));
  if (config !== null) fs.writeFileSync(path.join(root, 'repovine.config.json'), config);
  if (annots !== null) fs.writeFileSync(path.join(root, 'repovine.annots.json'), annots);
  if (git !== null) fs.writeFileSync(path.join(root, '.git'), git);
  return root;
}

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });

test('ensureTarget(attach): accepts a worktree-shaped root and preserves every byte', () => {
  const root = attachFixture();
  try {
    const out = target.ensureTarget({ mode: 'attach', repoRoot: root });
    assert.equal(out, root);
    assert.equal(fs.readFileSync(path.join(root, 'repovine.config.json'), 'utf8'), REAL_CONFIG);
    assert.equal(fs.readFileSync(path.join(root, 'repovine.annots.json'), 'utf8'), REAL_ANNOTS);
    assert.equal(fs.readFileSync(path.join(root, '.git'), 'utf8'), WORKTREE_POINTER);
    // No stub, no Git init, no baseline commit, no .gitignore.
    assert.deepEqual(fs.readdirSync(root).sort(), ['.git', 'repovine.annots.json', 'repovine.config.json']);
  } finally {
    rmrf(root);
  }
});

test('ensureTarget(attach): rejects missing root, missing/invalid repovine files, wrong .git shapes', () => {
  assert.throws(() => target.ensureTarget({ mode: 'attach', repoRoot: '/nonexistent/attach-root' }), /does not exist/);

  for (const [patch, re] of [
    [{ config: null }, /repovine\.config\.json/],
    [{ annots: null }, /repovine\.annots\.json/],
    [{ annots: '{broken' }, /does not parse/],
    [{ git: null }, /missing \.git/],
    [{ git: 'not a pointer\n' }, /worktree pointer/],
  ]) {
    const root = attachFixture(patch);
    try {
      assert.throws(() => target.ensureTarget({ mode: 'attach', repoRoot: root }), re);
      // Fail-closed AND write-free: nothing was created or repaired.
      if (patch.config === null) assert.ok(!fs.existsSync(path.join(root, 'repovine.config.json')), 'no config stub written');
      if (patch.annots === null) assert.ok(!fs.existsSync(path.join(root, 'repovine.annots.json')), 'no annots stub written');
    } finally {
      rmrf(root);
    }
  }

  // A .git DIRECTORY is a primary checkout — never attach it.
  const primary = attachFixture({ git: null });
  fs.mkdirSync(path.join(primary, '.git'));
  try {
    assert.throws(() => target.ensureTarget({ mode: 'attach', repoRoot: primary }), /primary checkout/);
  } finally {
    rmrf(primary);
  }
});

test('validateAttachedWorkspace (Docker branch): pointer bytes, write probe, disposable repo, runtime mounts', { skip: process.getuid?.() === 0 || !gitOk }, () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-home-'));
  const ws = makeAttachWorkspace();
  const root = ws.root;
  const gitPath = path.join(root, '.git');
  try {
    fs.mkdirSync(path.join(root, '.harness'));
    // Docker shape: the pointer byte-equals the spec constant; the disposable
    // repo is probed via the injected stateGitDir (in-container: /state/git).
    fs.writeFileSync(gitPath, ATTACH_GIT_POINTER_CONTENT);
    fs.chmodSync(gitPath, 0o400);

    const dockerOpts = { inDocker: true, requiredRoot: root, stateHome, stateGitDir: ws.gitDir };
    assert.equal(target.validateAttachedWorkspace(root, dockerOpts), root);

    // Divergent pointer bytes → rejected.
    fs.chmodSync(gitPath, 0o600);
    fs.writeFileSync(gitPath, 'gitdir: /somewhere/real\n');
    fs.chmodSync(gitPath, 0o400);
    assert.throws(() => target.validateAttachedWorkspace(root, dockerOpts), /pointer/);

    // Correct bytes but WRITABLE pointer → the read-only mount is missing → rejected.
    fs.chmodSync(gitPath, 0o600);
    fs.writeFileSync(gitPath, ATTACH_GIT_POINTER_CONTENT);
    assert.throws(() => target.validateAttachedWorkspace(root, dockerOpts), /writable/);
    fs.chmodSync(gitPath, 0o400);

    // Missing or headless disposable repo → rejected.
    assert.throws(
      () => target.validateAttachedWorkspace(root, { ...dockerOpts, stateGitDir: path.join(ws.gitDir, 'missing') }),
      /disposable repo/,
    );
    const emptyGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-emptygit-'));
    try {
      assert.throws(
        () => target.validateAttachedWorkspace(root, { ...dockerOpts, stateGitDir: emptyGitDir }),
        /HEAD/,
      );
    } finally {
      rmrf(emptyGitDir);
    }

    // Default requiredRoot is /workspace: a fixture root cannot pass the Docker pin.
    assert.throws(
      () => target.validateAttachedWorkspace(root, { inDocker: true, stateHome, stateGitDir: ws.gitDir }),
      /\/workspace/,
    );

    // Missing runtime HOME mount → rejected.
    assert.throws(
      () => target.validateAttachedWorkspace(root, { ...dockerOpts, stateHome: path.join(stateHome, 'missing') }),
      /runtime mount/,
    );
  } finally {
    try { fs.chmodSync(gitPath, 0o600); } catch { /* fixture cleanup */ }
    ws.cleanup();
    rmrf(stateHome);
  }
});

// ── graph intake over the target contract ───────────────────────────────────

test('intake: attach invoke carries targetMode and leaves the routing mode channel untouched', { skip: !gitOk }, async () => {
  const { intake } = await import('../lib/graph/nodes.mjs');
  const root = attachFixture();
  const ws = tmpWorkspace();
  try {
    const attachOut = await intake({
      task: { id: 'intake-attach-1', task: 'describe the config surface' },
      repoRoot: root,
      targetMode: 'attach',
      llmProvider: 'claude',
    });
    assert.equal(attachOut.error, undefined);
    assert.equal(attachOut.targetMode, 'attach');
    assert.ok(['single', 'multi'].includes(attachOut.mode), 'routing mode stays single|multi');

    const sandboxOut = await intake({
      task: { id: 'intake-sandbox-1', task: 'describe the config surface' },
      repoRoot: sandboxRootIn(ws),
      llmProvider: 'claude',
    });
    assert.equal(attachOut.mode, sandboxOut.mode, 'targetMode does not alter the routing mode');
    // Attach intake preserved the workspace files byte-for-byte.
    assert.equal(fs.readFileSync(path.join(root, 'repovine.annots.json'), 'utf8'), REAL_ANNOTS);
    assert.equal(fs.readFileSync(path.join(root, 'repovine.config.json'), 'utf8'), REAL_CONFIG);
  } finally {
    rmrf(root);
    rmrf(ws);
  }
});

test('intake: an invalid attach workspace errors before provider spend and writes nothing', async () => {
  const { intake } = await import('../lib/graph/nodes.mjs');
  const root = attachFixture({ config: null });
  try {
    const before = fs.readdirSync(root).sort();
    const out = await intake({
      task: { id: 'intake-attach-2', task: 'anything' },
      repoRoot: root,
      targetMode: 'attach',
      llmProvider: 'claude',
    });
    assert.match(out.error, /repovine\.config\.json/);
    assert.deepEqual(fs.readdirSync(root).sort(), before, 'no stub, no .harness — failed before any write');
  } finally {
    rmrf(root);
  }
});

// ── resetTarget ──────────────────────────────────────────────────────────────

test('resetTarget(attach): without the baseline tag it fails loud and touches no file', { skip: !gitOk }, () => {
  const root = attachFixture();
  try {
    const before = fs.readdirSync(root).sort();
    assert.throws(
      () => target.resetTarget({ mode: 'attach', repoRoot: root }),
      (e) => e.code === target.ATTACH_RESET_DISABLED && /baseline tag/.test(e.message),
    );
    assert.deepEqual(fs.readdirSync(root).sort(), before, 'no baseline → no deletion');
    assert.equal(fs.readFileSync(path.join(root, 'repovine.annots.json'), 'utf8'), REAL_ANNOTS);
  } finally {
    rmrf(root);
  }
});

test('resetTarget(attach): restores the launch baseline, keeps harness runtime and run branches', { skip: !gitOk }, () => {
  // `generated.d.ts` is tracked-but-gitignored — the class of launch-time
  // content `clean -x` would delete if the baseline were not a FULL snapshot
  // (add -A -f); the smoke run-003 regression.
  const ws = makeAttachWorkspace({
    files: {
      '.gitignore': 'generated.d.ts\n',
      'generated.d.ts': 'declare const x: 1;\n',
    },
  });
  try {
    // Agent activity after launch: edit a tracked file, add junk (including a
    // gitignored-class artifact), write runtime state, commit a run snapshot.
    fs.writeFileSync(path.join(ws.root, 'keep.txt'), 'agent-edited\n');
    fs.writeFileSync(path.join(ws.root, 'junk.txt'), 'x\n');
    fs.mkdirSync(path.join(ws.root, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(ws.root, '.harness', 'events.jsonl'), '{}\n');
    fs.mkdirSync(path.join(ws.root, '.repovine'), { recursive: true });
    fs.writeFileSync(path.join(ws.root, '.repovine', 'cache.json'), '{}\n');
    // The real promotion path: commitAttachRun drops harness internals from the
    // index, so the run snapshot never tracks .harness/.repovine.
    const snapshot = commitAttachRun(ws.root, '1');
    assert.equal(snapshot?.committed, true);
    assert.equal(snapshot.branch, 'attach/run-1');

    const out = target.resetTarget({ mode: 'attach', repoRoot: ws.root });
    assert.equal(out, ws.root);
    assert.equal(fs.readFileSync(path.join(ws.root, 'keep.txt'), 'utf8'), 'baseline\n', 'tracked file restored');
    assert.ok(!fs.existsSync(path.join(ws.root, 'junk.txt')), 'untracked junk cleaned');
    assert.ok(fs.existsSync(path.join(ws.root, '.harness', 'events.jsonl')), '.harness runtime survives');
    assert.ok(fs.existsSync(path.join(ws.root, '.repovine', 'cache.json')), '.repovine cache survives');
    assert.equal(
      fs.readFileSync(path.join(ws.root, 'generated.d.ts'), 'utf8'),
      'declare const x: 1;\n',
      'tracked-but-gitignored launch content survives clean -x (full baseline snapshot)',
    );
    // Committed run snapshot stays fetchable after the reset.
    assert.equal(ws.git(['rev-parse', '--verify', 'attach/run-1']).status, 0);
    assert.equal(
      ws.git(['rev-parse', 'HEAD']).stdout.trim(),
      ws.baselineOid,
      'HEAD back on the baseline commit',
    );
  } finally {
    ws.cleanup();
  }
});
