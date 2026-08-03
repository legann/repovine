// Shared attach-workspace fixture: a workspace whose `.git` is
// a pointer FILE into a separate disposable repo with a baseline commit and the
// `attach-baseline` tag — the same layout the launcher prepares, with host
// paths instead of /state/git (the non-Docker validation branch accepts any
// `gitdir:` target). Used by reset/custody/channel tests.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ATTACH_BASELINE_REF } from '../../lib/attach-guard.mjs';

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return (r.stdout || '').trim();
};

/**
 * Build an attach workspace in tmp.
 * `files` seeds the baseline tree (repovine config/annots included by default).
 * Returns { root, gitDir, baselineOid, git(args), cleanup }.
 */
export function makeAttachWorkspace({ files = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-ws-'));
  const root = path.join(base, 'workspace');
  const gitDir = path.join(base, 'gitdir');
  fs.mkdirSync(root);

  const seeded = {
    'repovine.config.json': '{"build":{"scan":{"exclude":["node_modules"]}}}\n',
    'repovine.annots.json': '{"version":1,"annotations":{"mod:app/x":{"summary":"baseline note"}}}\n',
    'keep.txt': 'baseline\n',
    ...files,
  };
  for (const [rel, body] of Object.entries(seeded)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }

  // Launcher-style prep: repo lives OUTSIDE the workspace, workspace carries a
  // pointer file. core.worktree points at the workspace so in-place git works.
  const env = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: root };
  run('git', ['init', '-b', 'attach/work'], { cwd: root, env });
  run('git', ['config', 'user.email', 'harness@attach'], { cwd: root, env });
  run('git', ['config', 'user.name', 'harness'], { cwd: root, env });
  run('git', ['config', 'commit.gpgsign', 'false'], { cwd: root, env });
  // Launcher parity: the baseline is the source's TRACKED SET, not the physical
  // working tree. Stage exactly the seeded paths (with -f, mirroring the
  // launcher's `add -f --pathspec-from-file` over `git ls-files`) — this
  // includes tracked-but-gitignored seeds and excludes any untracked-gitignored
  // cache a test materializes after this call.
  run('git', ['add', '-f', '--', ...Object.keys(seeded)], { cwd: root, env });
  run('git', ['commit', '-m', 'attach baseline'], { cwd: root, env });
  run('git', ['tag', ATTACH_BASELINE_REF], { cwd: root, env });
  run('git', ['config', 'core.worktree', root], { cwd: root, env });
  fs.writeFileSync(path.join(root, '.git'), `gitdir: ${gitDir}\n`);
  const baselineOid = run('git', ['-C', root, 'rev-parse', ATTACH_BASELINE_REF]);

  return {
    root,
    gitDir,
    baselineOid,
    git: (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf-8' }),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}
