// Demo design C — workspace revision capture (git-tree, both target modes).
// Sandbox: real git in a throwaway repo; asserts baseline/current diffs detect
// tracked/untracked/modified/deleted/reverted files WITHOUT moving HEAD, the
// user index, or the working tree, and that repovine's own committed artifacts
// and ignored paths are excluded. Attach: the same capture works through the
// disposable-repo pointer; commitAttachRun snapshots runs without harness
// internals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureGitRepo } from '../lib/graph/worktree.mjs';
import {
  captureWorkspaceRevision,
  commitAttachRun,
  diffChangedFiles,
  diffReviewablePatch,
  revisionsEqual,
  REPOVINE_COMMITTED_ARTIFACTS,
} from '../lib/graph/workspace-revision.mjs';
import { makeAttachWorkspace } from './fixtures/attach-workspace.mjs';

const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf-8' });
const write = (root, rel, body) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};
const gitCapture = (root) => captureWorkspaceRevision(root, { backend: 'git-tree' });

function tmpRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-rev-'));
  write(root, 'a.txt', 'alpha\n');
  write(root, 'b.txt', 'bravo\n');
  write(root, 'repovine.annots.json', '{"version":1,"annotations":{}}\n');
  assert.equal(ensureGitRepo(root), true, 'ensureGitRepo should establish HEAD');
  return root;
}

test('git-tree: detects modified/deleted/untracked, excludes ignored + repovine artifacts', () => {
  const root = tmpRepo();
  try {
    const headBefore = git(['rev-parse', 'HEAD'], root).stdout.trim();
    const baseline = gitCapture(root);
    assert.ok(baseline, 'baseline revision captured');
    assert.equal(baseline.backend, 'git-tree');

    // Mutations across every class.
    write(root, 'a.txt', 'alpha-edited\n');      // tracked modified
    fs.rmSync(path.join(root, 'b.txt'));          // tracked deleted
    write(root, 'c.txt', 'charlie\n');            // untracked new
    write(root, 'node_modules/dep.js', 'x\n');    // ignored → absent
    write(root, 'repovine.annots.json', '{"version":1,"annotations":{"mod:x":1}}\n'); // excluded

    const current = gitCapture(root);
    assert.ok(current, 'current revision captured');
    assert.notEqual(current.digest, baseline.digest, 'a real change moves the tree oid');
    assert.equal(revisionsEqual(current, baseline), false);

    const changed = diffChangedFiles(baseline, current);
    assert.deepEqual(changed, ['a.txt', 'b.txt', 'c.txt'], 'sorted, unique, ignored+repovine excluded');
    assert.ok(!changed.includes('node_modules/dep.js'));
    for (const artifact of REPOVINE_COMMITTED_ARTIFACTS) assert.ok(!changed.includes(artifact));

    // Reviewable patch agrees with changedFiles and excludes repovine artifacts.
    const patch = diffReviewablePatch(baseline, current);
    assert.match(patch, /c\.txt/);
    assert.match(patch, /a\.txt/);
    assert.doesNotMatch(patch, /repovine\.annots\.json/);

    // HEAD, real index, and working tree are untouched by capture.
    assert.equal(git(['rev-parse', 'HEAD'], root).stdout.trim(), headBefore, 'HEAD not moved');
    assert.equal(git(['diff', '--cached', '--name-only'], root).stdout.trim(), '', 'real index not staged');
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf-8'), 'alpha-edited\n', 'working tree intact');
    assert.ok(fs.existsSync(path.join(root, 'c.txt')), 'untracked file still present');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('git-tree: a reverted file does not appear in the diff', () => {
  const root = tmpRepo();
  try {
    const baseline = gitCapture(root);
    write(root, 'a.txt', 'alpha-edited\n');
    write(root, 'a.txt', 'alpha\n'); // reverted to original content
    const current = gitCapture(root);
    assert.equal(current.digest, baseline.digest, 'reverted tree equals baseline');
    assert.equal(revisionsEqual(current, baseline), true, 'equality is {backend, digest}, not identity');
    assert.deepEqual(diffChangedFiles(baseline, current), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('attach: capture and patch work through the disposable-repo pointer; ensureGitRepo writes nothing', () => {
  const ws = makeAttachWorkspace();
  try {
    const baseline = gitCapture(ws.root);
    assert.ok(baseline, 'capture works through the gitfile pointer');
    write(ws.root, 'keep.txt', 'v2\n');
    const current = gitCapture(ws.root);
    assert.deepEqual(diffChangedFiles(baseline, current), ['keep.txt']);
    assert.match(diffReviewablePatch(baseline, current), /keep\.txt/, 'reviewer patch text returns in attach');
    // Capture ran ensureGitRepo — the attach workspace must gain NO harness
    // .gitignore and NO extra commit from it.
    assert.ok(!fs.existsSync(path.join(ws.root, '.gitignore')), 'no harness .gitignore in an attached workspace');
    assert.equal(ws.git(['rev-parse', 'HEAD']).stdout.trim(), ws.baselineOid, 'no baseline re-commit');
  } finally {
    ws.cleanup();
  }
});

test('commitAttachRun: snapshots the run without harness internals; empty tree change is a no-op', () => {
  const ws = makeAttachWorkspace();
  try {
    // Nothing changed yet → no commit, no branch.
    assert.deepEqual(commitAttachRun(ws.root, 'noop'), { committed: false });
    assert.notEqual(ws.git(['rev-parse', '--verify', 'attach/run-noop']).status, 0);

    write(ws.root, 'keep.txt', 'agent work\n');
    write(ws.root, '.harness/events.jsonl', '{}\n');
    write(ws.root, 'node_modules/dep.js', 'x\n');
    const snapshot = commitAttachRun(ws.root, 'tg-1 2', 'attach run demo');
    assert.equal(snapshot?.committed, true, JSON.stringify(snapshot));
    assert.equal(snapshot.branch, 'attach/run-tg-1-2', 'runId sanitized into a ref-safe branch');
    assert.match(snapshot.oid, /^[0-9a-f]{40}$/);

    const shown = ws.git(['ls-tree', '-r', '--name-only', snapshot.branch]).stdout.trim().split('\n');
    assert.ok(shown.includes('keep.txt'));
    assert.ok(!shown.some((p) => p.startsWith('.harness/')), 'harness runtime never committed');
    assert.ok(!shown.some((p) => p.startsWith('node_modules/')), 'deps never committed');
  } finally {
    ws.cleanup();
  }
});

test('commitAttachRun: a committed root dist/ is not spuriously deleted in the promotion branch', () => {
  // Review finding 1: baseline retains a tracked root-level dist/ (ls-files), but
  // commitAttachRun dropped it from the promotion index → the promoted branch
  // recorded `D dist/out.js`, deleting it from the operator's checkout on merge.
  const ws = makeAttachWorkspace({
    files: {
      'dist/out.js': 'committed bundle\n',
      'src/app.js': 'v1\n',
    },
  });
  try {
    // Agent edits product AND materializes a mid-run cache/build (untracked).
    write(ws.root, 'src/app.js', 'v2\n');
    write(ws.root, 'node_modules/dep.js', 'installed\n');
    write(ws.root, 'dist/fresh.js', 'rebuilt\n');
    const snapshot = commitAttachRun(ws.root, 'run-1');
    assert.equal(snapshot?.committed, true, JSON.stringify(snapshot));

    const nameStatus = ws.git(['diff', '--name-status', 'attach-baseline', snapshot.branch]).stdout.trim();
    assert.equal(nameStatus, 'M\tsrc/app.js', `only the product edit promotes, got: ${nameStatus}`);
    // The committed dist/out.js survives (pinned to HEAD, not deleted); the
    // agent-materialized node_modules/dist artifacts never enter the branch.
    const tree = ws.git(['ls-tree', '-r', '--name-only', snapshot.branch]).stdout.trim().split('\n');
    assert.ok(tree.includes('dist/out.js'), 'committed dist/out.js preserved in the promotion branch');
    assert.ok(!tree.some((p) => p.startsWith('node_modules/')), 'agent node_modules never promoted');
    assert.ok(!tree.includes('dist/fresh.js'), 'agent-built dist artifact never promoted');
  } finally {
    ws.cleanup();
  }
});

test('commitAttachRun: a run that only touched agent cache is a no-op (no phantom promotion)', () => {
  const ws = makeAttachWorkspace({ files: { 'dist/out.js': 'bundle\n', 'src/app.js': 'v1\n' } });
  try {
    write(ws.root, 'node_modules/dep.js', 'x\n');
    write(ws.root, '.repovine/cache.json', '{}\n');
    assert.deepEqual(commitAttachRun(ws.root, 'noop'), { committed: false });
    assert.notEqual(ws.git(['rev-parse', '--verify', 'attach/run-noop']).status, 0, 'no phantom branch');
  } finally {
    ws.cleanup();
  }
});

test('capture contract: unknown backend throws; falsy/cross-backend diffs are null', () => {
  assert.throws(() => captureWorkspaceRevision('/tmp', { backend: 'filesystem' }), /unknown backend/);
  assert.equal(diffChangedFiles(null, { backend: 'git-tree', digest: 'x', repoRoot: '/tmp' }), null);
  assert.equal(
    diffChangedFiles(
      { backend: 'git-tree', digest: 'x', repoRoot: '/tmp' },
      { backend: 'other', digest: 'x', repoRoot: '/tmp' },
    ),
    null,
  );
  assert.equal(diffReviewablePatch(null, null), null);
});
