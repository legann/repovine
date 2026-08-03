// Git worktree isolation lifecycle + artifact preservation + cleanup.
// Exercises real git in a throwaway temp repo; skips cleanly when git is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  available,
  ensureGitRepo,
  addWorktree,
  commitWorktree,
  mergeWorktree,
  removeWorktree,
  preserveWorktreeArtifacts,
} from '../lib/graph/worktree.mjs';

const gitOk = available(os.tmpdir());
const worktreeList = (root) =>
  spawnSync('git', ['worktree', 'list'], { cwd: root, encoding: 'utf-8' }).stdout || '';

test('worktree lifecycle: add → commit → merge back → remove (no leak)', { skip: !gitOk }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  try {
    assert.equal(ensureGitRepo(root), true, 'repo initializes with a HEAD');

    const wt = addWorktree(root, 'backend');
    assert.ok(wt && fs.existsSync(wt.dir), 'worktree dir created');
    assert.ok(worktreeList(root).includes(wt.dir), 'git registers the worktree');

    // Sub-agent edits its isolated worktree, commits, merges back into root.
    fs.writeFileSync(path.join(wt.dir, 'feature.txt'), 'work');
    commitWorktree(wt.dir, 'backend: add feature');
    const m = mergeWorktree(root, wt.branch);
    assert.equal(m.ok, true, 'clean merge succeeds');
    assert.ok(fs.existsSync(path.join(root, 'feature.txt')), 'merged file lands in root');

    // Removal cleans up dir + branch, leaving no worktree behind.
    removeWorktree(root, wt.dir, wt.branch);
    assert.equal(fs.existsSync(wt.dir), false, 'worktree dir removed');
    assert.equal(worktreeList(root).includes(wt.dir), false, 'git no longer lists it');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preserveWorktreeArtifacts: copies .harness ledger into the durable sandbox', { skip: !gitOk }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  try {
    ensureGitRepo(root);
    const wt = addWorktree(root, 'frontend');
    assert.ok(wt);
    // Simulate a subAgent writing its cost/audit ledger into the throwaway worktree.
    fs.mkdirSync(path.join(wt.dir, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(wt.dir, '.harness', 'run.usage.json'), '{"cost":1}');

    preserveWorktreeArtifacts(wt.dir, root);
    assert.ok(
      fs.existsSync(path.join(root, '.harness', 'run.usage.json')),
      'ledger preserved before the worktree is removed',
    );

    removeWorktree(root, wt.dir, wt.branch);
    assert.ok(fs.existsSync(path.join(root, '.harness', 'run.usage.json')), 'ledger survives worktree removal');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('addWorktree: two same-time worktrees get distinct branches/dirs', { skip: !gitOk }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  try {
    ensureGitRepo(root);
    const a = addWorktree(root, 'backend');
    const b = addWorktree(root, 'frontend');
    assert.ok(a && b);
    assert.notEqual(a.branch, b.branch);
    assert.notEqual(a.dir, b.dir);
    removeWorktree(root, a.dir, a.branch);
    removeWorktree(root, b.dir, b.branch);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
