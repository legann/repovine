// Attach over a REAL Git worktree (rollout step 7): the worktree's committed
// repovine files are authoritative and byte-preserved, root pinning is pure
// command construction (REPOVINE_ROOT + cwd = /workspace), and reset stays
// refused. Live engine behavior (graph build over the fixture) is exercised
// once by the e2e smoke, not here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureTarget, resetTarget, resolveTargetFromEnv, ATTACH_RESET_DISABLED } from '../lib/target-repo.mjs';
import { buildCliCommand } from '../lib/repovine.mjs';
import { buildRepovineMcpStdio, repovineMcpEnv } from '../lib/workers/mcp.mjs';

const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf-8' });
const gitOk = !git(['--version'], os.tmpdir()).error;

const MARKER_CONFIG = '{"build":{"scan":{"exclude":["node_modules"]}},"marker":"attach-config-7317"}\n';
const MARKER_ANNOTS = '{"version":1,"annotations":{"mod:app/core":{"summary":"attach-annots-7317"}}}\n';
const MARKER_DOMAINS = '{"version":1,"domains":[{"name":"core","marker":"attach-domains-7317"}]}\n';

/** Source repo with committed repovine files + one linked worktree. */
function sourceRepoWithWorktree() {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-src-'));
  git(['init'], source);
  git(['config', 'user.email', 'test@local'], source);
  git(['config', 'user.name', 'test'], source);
  git(['config', 'commit.gpgsign', 'false'], source);
  fs.writeFileSync(path.join(source, 'repovine.config.json'), MARKER_CONFIG);
  fs.writeFileSync(path.join(source, 'repovine.annots.json'), MARKER_ANNOTS);
  fs.writeFileSync(path.join(source, 'repovine.domains.json'), MARKER_DOMAINS);
  fs.mkdirSync(path.join(source, 'src'));
  fs.writeFileSync(path.join(source, 'src', 'core.js'), 'export const core = 1;\n');
  git(['add', '-A'], source);
  git(['commit', '-m', 'fixture'], source);
  const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'attach-wt-')), 'run-001');
  git(['worktree', 'add', wt, 'HEAD'], source);
  return { source, wt };
}

test('attach over a real worktree: startup preserves the repovine workspace byte-for-byte', { skip: !gitOk }, () => {
  const { source, wt } = sourceRepoWithWorktree();
  try {
    const target = resolveTargetFromEnv({ HARNESS_TARGET_MODE: 'attach', HARNESS_REPO_ROOT: wt });
    assert.equal(target.mode, 'attach');
    ensureTarget(target);

    assert.equal(fs.readFileSync(path.join(wt, 'repovine.config.json'), 'utf8'), MARKER_CONFIG);
    assert.equal(fs.readFileSync(path.join(wt, 'repovine.annots.json'), 'utf8'), MARKER_ANNOTS);
    assert.equal(fs.readFileSync(path.join(wt, 'repovine.domains.json'), 'utf8'), MARKER_DOMAINS);
    // .git stays the worktree pointer; no baseline commit, no harness .gitignore.
    assert.match(fs.readFileSync(path.join(wt, '.git'), 'utf8'), /^gitdir: /);
    assert.equal(git(['status', '--porcelain'], wt).stdout.trim(), '', 'worktree stays clean');
    // The SOURCE checkout is untouched.
    assert.equal(git(['status', '--porcelain'], source).stdout.trim(), '');
  } finally {
    fs.rmSync(path.dirname(wt), { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test('root pinning is pure command construction: CLI and MCP both carry REPOVINE_ROOT + cwd = /workspace', () => {
  const cli = buildCliCommand(['delivery', 'compliance', 'result.json'], { repoRoot: '/workspace' });
  assert.equal(cli.cwd, '/workspace');
  assert.equal(cli.env.REPOVINE_ROOT, '/workspace');
  assert.equal(cli.command, 'node');
  assert.ok(cli.args.includes('delivery'));

  const mcp = buildRepovineMcpStdio('/workspace', 'ctx-session-1');
  assert.equal(mcp.env.REPOVINE_ROOT, '/workspace');
  assert.equal(mcp.env.REPOVINE_CONTEXT_SESSION_ID, 'ctx-session-1');
  assert.equal(mcp.type, 'stdio');

  // The MCP env is built fresh (no ambient REPOVINE_ROOT bleed unless inherited explicitly).
  const bare = repovineMcpEnv('/workspace', undefined);
  assert.equal(bare.REPOVINE_ROOT, '/workspace');
});

test('attach annotation store: updates go to the EXISTING file path, never a stub swap', { skip: !gitOk }, () => {
  const { source, wt } = sourceRepoWithWorktree();
  try {
    ensureTarget({ mode: 'attach', repoRoot: wt });
    // The write path repovine uses is the committed file at the workspace root —
    // the same inode-path the fixture committed. Simulate an engine-side merge
    // (annotation added) and re-validate: ensureTarget still reads it as-is.
    const annPath = path.join(wt, 'repovine.annots.json');
    const merged = '{"version":1,"annotations":{"mod:app/core":{"summary":"attach-annots-7317"},"mod:app/new":{"summary":"added"}}}\n';
    fs.writeFileSync(annPath, merged);
    ensureTarget({ mode: 'attach', repoRoot: wt });
    assert.equal(fs.readFileSync(annPath, 'utf8'), merged, 'existing store evolves in place; no stub reset');
  } finally {
    fs.rmSync(path.dirname(wt), { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test('attach reset over a real worktree: refused, worktree intact', { skip: !gitOk }, () => {
  const { source, wt } = sourceRepoWithWorktree();
  try {
    assert.throws(
      () => resetTarget({ mode: 'attach', repoRoot: wt }),
      (e) => e.code === ATTACH_RESET_DISABLED,
    );
    assert.equal(git(['status', '--porcelain'], wt).stdout.trim(), '');
  } finally {
    fs.rmSync(path.dirname(wt), { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});
