// Workspace revision capture (Demo design C).
//
// SubAgent unions are not proof of the final filesystem. Multi mode captures an
// observable, run-specific workspace revision by writing a Git *tree object* for
// the current non-ignored contents — WITHOUT touching HEAD, the user's index, or
// the working tree. The baseline..current pair bounds an authoritative diff that
// drives filesChanged and review freshness. One backend serves both target
// modes: sandbox is its own repo, attach carries the launch-scoped DISPOSABLE
// repo (`gitdir: /state/git`, baseline commit = worktree tree at launch), so
// git-tree capture works identically behind the read-only pointer. A capture
// failure makes multi finalization fail closed rather than fall back to
// optimistic subAgent unions.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureGitRepo } from './worktree.mjs';

// repovine's OWN committed artifacts. Excluded from `changedFiles` and from the
// reviewable diff: they are the harness's graph memory/config, maintained by
// annotation-sync and refresh rather than authored as solution code — their effect
// is already represented in the parent result through `annotationsWritten` (the
// annotation-writer read-only contract). The `.repovine/` cache is already absent
// via sandbox ignore rules; these three are deliberately NOT engine-ignored (the
// engine commits and reads them), so this exclusion is a demo-side filter over the
// tree diff. The filename set mirrors repovine's public committed-artifact names
// (repovine `src/paths.ts`: ANNOTATIONS_FILENAME, DOMAINS_CONFIG_FILENAME, and the
// config filename); the demo carries this constant with that provenance rather than
// importing engine internals across the CLI process boundary.
export const REPOVINE_COMMITTED_ARTIFACTS = [
  'repovine.annots.json',
  'repovine.domains.json',
  'repovine.config.json',
];

// Engine-written annotation backups (`annotations.backup.<iso>.json`) land at the
// repo root and are NOT agent product — they must never count as a changed file.
export const REPOVINE_ARTIFACT_RE = /(^|\/)annotations\.backup\..*\.json$/;

function git(args, cwd, extraEnv) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: (res.stderr || '').trim(), error: res.error };
}

/** Repository-relative POSIX: `\\`→`/`, collapse duplicate separators, strip leading `./`. */
function normalizeRel(p) {
  return p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '');
}

// Harness/runtime internals excluded from capture and diff by PATHSPEC, not by
// trusting the workspace .gitignore: a pre-existing or agent-rewritten .gitignore
// without these entries must not leak .harness ledgers or node_modules into the
// tree oid (which would stale every review and pollute changedFiles).
const HARNESS_INTERNAL_DIRS = ['.harness', '.repovine', '.worktrees', 'node_modules', 'dist'];
const HARNESS_INTERNAL_PREFIX_RE = new RegExp(
  `^(?:${HARNESS_INTERNAL_DIRS.map(d => d.replace('.', '\\.')).join('|')})(?:/|$)`,
);
const internalExcludePathspecs = () => HARNESS_INTERNAL_DIRS.map(d => `:(exclude)${d}`);

/**
 * Drop harness-internal dirs from an index. `git add -A` with an explicit
 * exclude pathspec cannot do this: the companion `.` pathspec makes git error
 * out on gitignored matches (exit 1, "paths are ignored"), so internal dirs are
 * removed from the index AFTER a plain `add -A` instead.
 */
function dropInternalDirsFromIndex(repoRoot, env) {
  const r = git(
    ['rm', '-r', '--cached', '--ignore-unmatch', '--quiet', '--', ...HARNESS_INTERNAL_DIRS],
    repoRoot,
    env,
  );
  return r.code === 0;
}

/**
 * Write a Git tree object for the current non-ignored contents without moving
 * HEAD, the user's index, or the working tree. Seeds a throwaway GIT_INDEX_FILE
 * outside the workspace from HEAD, stages every non-ignored change into it
 * (`git add -A`), then `git write-tree`. The temp index is always removed.
 * Returns the tree oid, or null if the repo has no HEAD or any git step fails
 * (capture fails closed).
 */
function captureGitTreeOid(repoRoot) {
  if (!ensureGitRepo(repoRoot)) return null;
  // Unique per-capture temp index OUTSIDE the workspace: an in-workspace index
  // would be staged by its own `git add -A` when the workspace .gitignore does
  // not cover it. pid + high-resolution time avoid collisions across concurrent
  // captures without depending on Date.now/Math.random.
  const indexFile = path.join(os.tmpdir(), `repovine-tree-index-${process.pid}-${process.hrtime.bigint().toString(36)}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    if (git(['read-tree', 'HEAD'], repoRoot, env).code !== 0) return null;
    if (git(['add', '-A'], repoRoot, env).code !== 0) return null;
    if (!dropInternalDirsFromIndex(repoRoot, env)) return null;
    const wt = git(['write-tree'], repoRoot, env);
    if (wt.code !== 0) return null;
    const oid = wt.stdout.trim();
    return oid || null;
  } finally {
    try { fs.rmSync(indexFile, { force: true }); } catch { /* best-effort */ }
  }
}

/**
 * Capture the current workspace revision: `{ backend: 'git-tree', repoRoot,
 * digest }` — digest is the tree oid. Returns null when capture fails (callers
 * fail closed; never a subAgent-reported union fallback). The `backend` option
 * is part of the revision identity contract; anything other than `git-tree` is
 * a caller bug and throws (the `filesystem` backend was removed with
 * the disposable-repo design).
 */
export function captureWorkspaceRevision(repoRoot, { backend = 'git-tree' } = {}) {
  if (backend !== 'git-tree') {
    throw new Error(`captureWorkspaceRevision: unknown backend "${backend}"`);
  }
  const digest = captureGitTreeOid(repoRoot);
  return digest ? { backend, repoRoot, digest } : null;
}

/** Revision identity is `{ backend, digest }` — never JavaScript object identity. */
export function revisionsEqual(a, b) {
  return Boolean(a && b) && a.backend === b.backend && a.digest === b.digest;
}

/**
 * Changed files between two revisions: normalized repository-relative POSIX,
 * stable-sorted, unique, with harness-internal dirs dropped. `exclude` (default:
 * repovine's committed artifacts) names extra exact paths to drop — review
 * freshness passes a narrower set so config/domain edits still stale a review.
 * Returns null on a falsy revision, a backend mismatch, or a git failure so the
 * caller can fail closed.
 */
export function diffChangedFiles(baseline, current, { exclude = REPOVINE_COMMITTED_ARTIFACTS } = {}) {
  if (!baseline || !current || baseline.backend !== current.backend) return null;
  const r = git(['diff', '--name-only', '--no-ext-diff', baseline.digest, current.digest], baseline.repoRoot);
  if (r.code !== 0) return null;
  const excluded = new Set(exclude);
  const set = new Set(
    r.stdout
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .map(normalizeRel)
      .filter(p => !excluded.has(p) && !HARNESS_INTERNAL_PREFIX_RE.test(p) && !REPOVINE_ARTIFACT_RE.test(p)),
  );
  return [...set].sort();
}

/**
 * Reviewable diff bytes between two revisions (binary-safe), excluding the same
 * repovine committed artifacts and harness-internal dirs as {@link diffChangedFiles}
 * so the patch bytes and `changedFiles` agree. Returns '' when there is no diff;
 * null on a falsy revision, backend mismatch, or git failure.
 */
export function diffReviewablePatch(baseline, current) {
  if (!baseline || !current || baseline.backend !== current.backend) return null;
  const excludes = [
    ...REPOVINE_COMMITTED_ARTIFACTS.map(name => `:(exclude)${name}`),
    ':(exclude,glob)**/annotations.backup.*.json',
    ':(exclude,glob)annotations.backup.*.json',
    ...internalExcludePathspecs(),
  ];
  const r = git(['diff', '--binary', '--no-ext-diff', baseline.digest, current.digest, '--', '.', ...excludes], baseline.repoRoot);
  if (r.code !== 0) return null;
  return r.stdout;
}

/**
 * Attach promotion hook: snapshot the workspace into the disposable repo's REAL
 * index as one commit and label it `attach/run-<runId>`, so the operator can
 * `git fetch <state>/runtime/git attach/run-<runId>` from the checkout.
 * Harness-internal dirs are dropped from the commit like from capture. Returns
 * `{ committed: true, oid, branch }`, `{ committed: false }` when the tree
 * matches HEAD (nothing to commit), or null on any git failure — the commit is
 * an operator convenience, never custody, so callers log and continue.
 */
export function commitAttachRun(repoRoot, runId, message) {
  const branch = `attach/run-${String(runId ?? 'run').replace(/[^A-Za-z0-9._-]+/g, '-')}`;
  if (git(['add', '-A'], repoRoot).code !== 0) return null;
  // Pin harness-internal dirs to their HEAD (=attach-baseline) state: drop
  // agent-materialized entries (a mid-run `npm install` node_modules, a build
  // dist/) from the promotion index, then restore whatever HEAD tracks. A repo
  // that COMMITS a root-level dist/ keeps it (baseline has it, `reset HEAD`
  // re-stages it) instead of the promotion branch spuriously recording its
  // deletion; an agent cache HEAD does not track simply stays dropped. Symmetric
  // with the baseline, so a no-op run diffs empty against HEAD.
  if (!dropInternalDirsFromIndex(repoRoot)) return null;
  if (git(['reset', '-q', 'HEAD', '--', ...HARNESS_INTERNAL_DIRS], repoRoot).code !== 0) return null;
  // Nothing staged beyond HEAD → no commit, no branch label.
  if (git(['diff', '--cached', '--quiet', 'HEAD'], repoRoot).code === 0) return { committed: false };
  const msg = message || `attach run ${runId ?? ''}`.trim();
  if (git(['commit', '--no-verify', '-m', msg], repoRoot).code !== 0) return null;
  const head = git(['rev-parse', 'HEAD'], repoRoot);
  if (head.code !== 0) return null;
  const oid = head.stdout.trim();
  if (git(['branch', '-f', branch, oid], repoRoot).code !== 0) return null;
  return { committed: true, oid, branch };
}
