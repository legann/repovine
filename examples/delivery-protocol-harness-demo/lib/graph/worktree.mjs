// Git worktree isolation for parallel sub-agents (Phase 4).
//
// The orchestration rule allows "parallel runs only for disjoint scopes" — but in
// this harness every sub-agent edits ONE working tree (the sandbox), so two LLM workers
// running at once would race on shared files. The fix: give each parallel sub-agent its
// OWN git worktree (a checkout of the same repo on a temp branch), run it there,
// validate its compliance against that worktree, then merge the branches back at
// join. Sequential stages don't need this and skip it.
//
// All git calls are best-effort and synchronous; `available()` lets the caller
// fall back to sequential-in-sandbox when git is absent.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
  return { code: res.status, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim(), error: res.error };
}

/** Is git usable here? */
export function available(repoRoot) {
  const r = git(['--version'], repoRoot);
  return !r.error && r.code === 0;
}

function isRepo(repoRoot) {
  // Must be repoRoot's OWN repository, not merely some enclosing one. The sandbox
  // lives INSIDE the monorepo, so `--is-inside-work-tree` is fooled — it reports
  // true off the outer .git and we'd never init the sandbox as its own repo,
  // letting a git-aware agent resolve its workspace up to the monorepo root.
  // A root `.git` ENTRY (dir in sandbox, gitfile pointer in attach — the
  // disposable-repo pointer at /workspace/.git) marks an own repo; discovery
  // must still resolve it.
  if (!fs.existsSync(path.join(repoRoot, '.git'))) return false;
  return git(['rev-parse', '--git-dir'], repoRoot).code === 0;
}

/**
 * Ensure repoRoot is a git repo with at least one commit, so worktrees can branch
 * off HEAD. Uses a local identity + no signing so it works on headless hosts.
 * Returns true if the repo is ready.
 */
export function ensureGitRepo(repoRoot) {
  if (!available(repoRoot)) return false;
  let inited = false;
  if (!isRepo(repoRoot)) {
    if (git(['init'], repoRoot).code !== 0) return false;
    inited = true;
  }
  // Local identity (don't touch global config).
  git(['config', 'user.email', 'harness@local'], repoRoot);
  git(['config', 'user.name', 'harness'], repoRoot);
  git(['config', 'commit.gpgsign', 'false'], repoRoot);
  // Keep baseline + merges lean: never commit deps / runtime dirs into worktrees
  // (a real worker may `npm install`). FRESH init only — writing a harness
  // .gitignore into an attached workspace would surface as an agent edit.
  if (inited) {
    const gitignore = path.join(repoRoot, '.gitignore');
    if (!fs.existsSync(gitignore)) {
      fs.writeFileSync(gitignore, ['node_modules/', '.repovine/', '.harness/', '.worktrees/', 'dist/', ''].join('\n'));
    }
  }
  // Baseline commit if HEAD is unborn.
  if (git(['rev-parse', '--verify', 'HEAD'], repoRoot).code !== 0) {
    git(['add', '-A'], repoRoot);
    git(['commit', '--allow-empty', '-m', 'harness baseline'], repoRoot);
  }
  return git(['rev-parse', '--verify', 'HEAD'], repoRoot).code === 0;
}

const WT_ROOT = '.worktrees';

/** Add a worktree on a fresh branch for `role`. Returns { dir, branch } or null. */
export function addWorktree(repoRoot, role) {
  const branch = `sub-agent/${role}-${Date.now().toString(36)}`;
  const dir = path.join(repoRoot, WT_ROOT, branch.replace(/\//g, '__'));
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const r = git(['worktree', 'add', '-b', branch, dir, 'HEAD'], repoRoot);
  if (r.code !== 0) return null;
  return { dir, branch };
}

/** Commit everything in a worktree (allow-empty so a no-op sub-agent still has a ref). */
export function commitWorktree(dir, message) {
  git(['add', '-A'], dir);
  git(['commit', '--allow-empty', '-m', message], dir);
}

/**
 * Merge a sub-agent branch back into repoRoot's current branch.
 * Returns { ok, conflict }. On conflict the merge is aborted (caller records a
 * blocker) so the working tree stays clean for the next merge.
 */
export function mergeWorktree(repoRoot, branch) {
  const r = git(['merge', '--no-ff', '-m', `merge ${branch}`, branch], repoRoot);
  if (r.code === 0) return { ok: true, conflict: false };
  const conflict = /conflict/i.test(r.stdout + r.stderr);
  git(['merge', '--abort'], repoRoot);
  return { ok: false, conflict };
}

/** Remove a worktree and delete its branch. Best-effort cleanup. */
export function removeWorktree(repoRoot, dir, branch) {
  git(['worktree', 'remove', '--force', dir], repoRoot);
  if (branch) git(['branch', '-D', branch], repoRoot);
}

/**
 * Copy a worktree's `.harness` ledger into the durable sandbox before the worktree
 * is removed. `commitWorktree` stages everything and excludes nothing: `.harness` stays out
 * of the branch while the `.gitignore` written at fresh init lists it. This copy carries the
 * per-sub-agent cost/audit artifacts across parallel runs.
 */
export function preserveWorktreeArtifacts(wtDir, repoRoot) {
  if (!wtDir || wtDir === repoRoot) return;
  const src = path.join(wtDir, '.harness');
  const dst = path.join(repoRoot, '.harness');
  try {
    if (fs.existsSync(src)) fs.cpSync(src, dst, { recursive: true });
  } catch { /* best-effort */ }
}
