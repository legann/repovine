// Attach launcher contract (host trust boundary): fail-closed preflight, state
// layout, compose invocation. Real git fixtures in mkdtemp; skips cleanly when
// git is absent. Docker is never started — `run` gets an injected execCompose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PreflightError,
  parseMountinfo,
  parseWorktreeList,
  mountsBelow,
  pathContains,
  prepareLaunch,
  walkWorktree,
  preflight,
  runLaunch,
  restartLaunch,
} from '../scripts/attach-launcher.mjs';
import { ATTACH_GIT_POINTER_CONTENT } from '../lib/attach-guard.mjs';

// This suite exercises Linux attach security logic through injected seams
// (mountinfoText, pinned launch files). Pin the platform gate open so the
// suite runs on any contributor OS; CI (harness-linux) runs it on real Linux,
// and the gate itself is covered by platform-gates.test.mjs.
if (process.platform !== 'linux') {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
}

const DEMO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = path.join(DEMO_ROOT, 'scripts', 'attach-launcher.mjs');
const TMP = fs.realpathSync(os.tmpdir());

const gitOk = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const mkfifoOk = spawnSync('mkfifo', ['--version'], { encoding: 'utf-8' }).status === 0;
const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
const gid = typeof process.getgid === 'function' ? process.getgid() : -1;
const skip = !gitOk || uid < 0;

// Injected mount table: full preflights must not depend on the host's mounts.
const miLine = (mp) => `36 35 98:0 / ${mp} rw shared:1 - ext4 /dev/sda1 rw`;
const CLEAN_MOUNTINFO = `${miLine('/')}\n`;

function sh(args, cwd) {
  const r = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf-8' });
  assert.equal(r.status, 0, `${args.join(' ')} failed: ${r.stderr}`);
  return (r.stdout || '').trim();
}

// Main repo at <base>/src, clean linked worktree at <base>/wt, empty <base>/state.
function fixture() {
  const base = fs.mkdtempSync(path.join(TMP, 'attach-'));
  const src = path.join(base, 'src');
  fs.mkdirSync(src);
  sh(['git', 'init', '-q'], src);
  sh(['git', 'config', 'user.email', 't@t'], src);
  sh(['git', 'config', 'user.name', 't'], src);
  sh(['git', 'config', 'commit.gpgsign', 'false'], src);
  fs.writeFileSync(path.join(src, 'a.txt'), 'a\n');
  sh(['git', 'add', '.'], src);
  sh(['git', 'commit', '-qm', 'init'], src);
  sh(['git', 'worktree', 'add', '-q', '../wt'], src);
  const state = path.join(base, 'state');
  fs.mkdirSync(state);
  return { base, src, wt: path.join(base, 'wt'), state };
}

const envFor = (f, extra = {}) => ({
  HARNESS_ATTACH_WORKTREE: f.wt,
  HARNESS_ATTACH_STATE_DIR: f.state,
  HARNESS_HOST_UID: String(uid),
  HARNESS_HOST_GID: String(gid),
  // Pin the launch pointer at a nonexistent path so a stray real
  // .attach-launch.json in the demo dir never leaks into these fixtures.
  HARNESS_ATTACH_LAUNCH_FILE: path.join(f.base, 'no-such-launch.json'),
  ...extra,
});

const opts = (extra = {}) => ({ mountinfoText: CLEAN_MOUNTINFO, ...extra });

const rejects = (fn, re) =>
  assert.throws(fn, (err) => err instanceof PreflightError && re.test(err.message), `expected PreflightError matching ${re}`);

// ── Pure check functions ───────────────────────────────────────────────────────

test('parseMountinfo: extracts mount points + fs types, decodes octal escapes', () => {
  const text = `${miLine('/a/b')}\n${miLine('/c\\040d')}\n`;
  assert.deepEqual(parseMountinfo(text), [
    { mountPoint: '/a/b', fsType: 'ext4' },
    { mountPoint: '/c d', fsType: 'ext4' },
  ]);
  // Blank lines are skipped; any other unparseable line poisons the table.
  assert.deepEqual(parseMountinfo(`${miLine('/a/b')}\n\n  \n`), [{ mountPoint: '/a/b', fsType: 'ext4' }]);
  assert.throws(() => parseMountinfo(`${miLine('/a/b')}\nshort\n`), /fewer than 5 fields/);
});

test('mountsBelow: strictly-below only (root itself and sibling prefixes pass)', () => {
  const roots = ['/x/wt', '/x/state'];
  const points = (text) => parseMountinfo(text).map((m) => m.mountPoint);
  assert.deepEqual(mountsBelow(points(CLEAN_MOUNTINFO), roots), []);
  assert.deepEqual(mountsBelow(points(`${miLine('/x/wt')}\n`), roots), []);
  assert.deepEqual(mountsBelow(points(`${miLine('/x/wtother')}\n`), roots), []);
  assert.deepEqual(mountsBelow(points(`${miLine('/x/wt/nested')}\n`), roots), ['/x/wt/nested']);
  assert.deepEqual(mountsBelow(points(`${miLine('/x/state/runtime/home')}\n`), roots), ['/x/state/runtime/home']);
});

test('pathContains: equality and descent, no sibling-prefix false positives, case-sensitive', () => {
  assert.equal(pathContains('/a', '/a'), true);
  assert.equal(pathContains('/a', '/a/b/c'), true);
  assert.equal(pathContains('/a/b', '/a'), false);
  assert.equal(pathContains('/a', '/ab'), false);
  assert.equal(pathContains('/x/Repo', '/x/repo/f'), false, 'byte-exact comparison, no case-folding');
});

test('parseWorktreeList: byte-exact paths — a trailing \\r is path data, not a line ending', () => {
  const lf = 'worktree /a/src\nHEAD abc\nbranch refs/heads/main\n\nworktree /a/wt\nHEAD def\ndetached\n\nworktree /a/bare\nbare\n';
  assert.deepEqual(parseWorktreeList(lf), [
    { path: '/a/src', bare: false },
    { path: '/a/wt', bare: false },
    { path: '/a/bare', bare: true },
  ]);
  // Git porcelain is LF-delimited on supported hosts; a \r before the LF is a
  // legal byte of the path and must survive parsing.
  assert.deepEqual(parseWorktreeList('worktree /a/wt\r\nbare\n'), [{ path: '/a/wt\r', bare: true }]);
});

test('walkWorktree: rejects hardlinked regular files, allows symlinks unfollowed', () => {
  const base = fs.mkdtempSync(path.join(TMP, 'walk-'));
  try {
    const sub = path.join(base, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(base, 'plain.txt'), 'x\n');
    // Symlinks (even to a device node or dangling) are lstat'ed, never followed.
    fs.symlinkSync('/dev/null', path.join(base, 'to-dev-null'));
    fs.symlinkSync(path.join(base, 'missing'), path.join(sub, 'dangling'));
    assert.deepEqual(walkWorktree(base), { ok: true });

    fs.linkSync(path.join(base, 'plain.txt'), path.join(sub, 'hardlink.txt'));
    const r = walkWorktree(base);
    assert.equal(r.ok, false);
    assert.match(r.reason, /hardlinked/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── Preflight against real git fixtures ────────────────────────────────────────

test('preflight: accepts a clean registered linked worktree and creates nothing', { skip }, () => {
  const f = fixture();
  try {
    const ctx = preflight(envFor(f), opts());
    assert.equal(ctx.worktree, fs.realpathSync(f.wt));
    assert.equal(ctx.stateDir, fs.realpathSync(f.state));
    assert.equal(ctx.commonDir, fs.realpathSync(path.join(f.src, '.git')));
    assert.ok(pathContains(ctx.commonDir, ctx.gitDir), 'per-worktree git dir under the common dir');
    assert.equal(ctx.sourceToplevel, fs.realpathSync(f.src));
    assert.equal(ctx.profile, null, 'standalone preflight selects no profile');
    // Standalone preflight creates NOTHING.
    assert.deepEqual(fs.readdirSync(f.state), []);
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('run cli: exact state layout, modes, pointer bytes, disposable repo, compose call', { skip }, () => {
  const f = fixture();
  try {
    const calls = [];
    let baselineAtCompose = -1;
    const code = runLaunch(
      'cli',
      ['--task', 'demo'],
      envFor(f),
      opts({
        execCompose: (c) => {
          // Order: the disposable repo must exist BEFORE docker is invoked.
          baselineAtCompose = spawnSync(
            'git',
            [`--git-dir=${path.join(fs.realpathSync(f.state), 'runtime', 'git')}`, 'rev-parse', '--verify', 'attach-baseline^{commit}'],
            { encoding: 'utf-8' },
          ).status;
          calls.push(c);
          return 0;
        },
      }),
    );
    assert.equal(code, 0);
    assert.equal(baselineAtCompose, 0, 'disposable repo exists before docker is invoked');

    const state = fs.realpathSync(f.state);
    const mode = (p) => fs.lstatSync(p).mode & 0o777;
    assert.deepEqual(fs.readdirSync(state).sort(), ['control', 'runtime']);
    assert.deepEqual(fs.readdirSync(path.join(state, 'control')).sort(), ['attach.json', 'git-guard']);
    assert.deepEqual(fs.readdirSync(path.join(state, 'runtime')).sort(), ['git', 'harness', 'home']);
    assert.deepEqual(fs.readdirSync(path.join(state, 'runtime', 'home')), []);
    assert.deepEqual(fs.readdirSync(path.join(state, 'runtime', 'harness')), []);
    for (const d of ['control', 'runtime', 'runtime/home', 'runtime/harness', 'runtime/git']) {
      assert.equal(mode(path.join(state, d)), 0o700, `${d} is 0700`);
    }
    const guard = path.join(state, 'control', 'git-guard');
    assert.equal(mode(guard), 0o400);
    assert.equal(fs.readFileSync(guard, 'utf-8'), ATTACH_GIT_POINTER_CONTENT);

    // The disposable repo is REAL: baseline tag, work branch, container-path
    // worktree config, pinned identity, and a baseline tree that matches the
    // worktree content (the root .git pointer file is never tracked).
    const gd = `--git-dir=${path.join(state, 'runtime', 'git')}`;
    const baselineOid = sh(['git', gd, 'rev-parse', '--verify', 'attach-baseline^{commit}']);
    assert.match(baselineOid, /^[0-9a-f]{40}$/);
    assert.equal(sh(['git', gd, 'rev-parse', '--abbrev-ref', 'HEAD']), 'attach/work');
    assert.equal(sh(['git', gd, 'config', 'core.worktree']), '/workspace');
    assert.equal(sh(['git', gd, 'config', 'user.email']), 'harness@attach');
    assert.equal(sh(['git', gd, 'ls-tree', '--name-only', 'attach-baseline']), 'a.txt');
    const shown = spawnSync('git', [gd, 'show', 'attach-baseline:a.txt'], { encoding: 'utf-8' });
    assert.equal(shown.status, 0);
    assert.equal(shown.stdout, fs.readFileSync(path.join(f.wt, 'a.txt'), 'utf-8'), 'baseline blob matches worktree bytes');

    const recPath = path.join(state, 'control', 'attach.json');
    assert.equal(mode(recPath), 0o600);
    const rec = JSON.parse(fs.readFileSync(recPath, 'utf-8'));
    assert.equal(rec.worktree, fs.realpathSync(f.wt));
    assert.equal(rec.commonDir, fs.realpathSync(path.join(f.src, '.git')));
    assert.equal(rec.sourceToplevel, fs.realpathSync(f.src));
    assert.equal(rec.baseOid, sh(['git', '-C', f.wt, 'rev-parse', 'HEAD']));
    assert.match(rec.baselineOid, /^[0-9a-f]{40}$/);
    assert.equal(rec.baselineOid, baselineOid);
    assert.equal(rec.profile, 'attach-cli');
    assert.equal(rec.service, 'cli-attach');
    assert.ok(Number.isFinite(Date.parse(rec.createdAt)), 'createdAt is ISO');

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['compose', '-f', 'compose.yaml', '-f', 'compose.attach.yaml', '--profile', 'attach-cli', 'run', '--rm', '--build', 'cli-attach', '--task', 'demo']);
    assert.equal(calls[0].cwd, DEMO_ROOT);
    assert.equal(calls[0].env.HARNESS_TARGET_MODE, 'attach');
    assert.equal(calls[0].env.HARNESS_ATTACH_WORKTREE, fs.realpathSync(f.wt));
    assert.equal(calls[0].env.HARNESS_ATTACH_STATE_DIR, state);
    assert.equal(calls[0].env.HARNESS_HOST_UID, String(uid));
    assert.equal(calls[0].env.HARNESS_HOST_GID, String(gid));
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('restart: reuses the laid-out launch (no re-layout, no baseline rewrite), invokes compose up --build', { skip }, () => {
  const f = fixture();
  try {
    // First a real run lays out state + builds the baseline repo.
    const runCalls = [];
    assert.equal(runLaunch('tg-bot', [], envFor(f), opts({ execCompose: (c) => (runCalls.push(c), 0) })), 0);
    const guard = fs.readFileSync(path.join(f.state, 'control', 'git-guard'), 'utf-8');
    const attachJson = fs.readFileSync(path.join(f.state, 'control', 'attach.json'), 'utf-8');

    // The worktree is now dirty (an episode ran) — the continuation state restart
    // exists to resume. `run` refuses it two ways; restart accepts it.
    fs.writeFileSync(path.join(f.wt, 'episode-edit.txt'), 'agent output\n');
    rejects(() => runLaunch('tg-bot', [], envFor(f), opts({ execCompose: () => 0 })), /state dir is not empty|worktree is dirty/);

    // restart accepts the existing layout + dirty worktree, invokes compose without touching state.
    const calls = [];
    const code = restartLaunch('tg-bot', [], envFor(f), opts({ execCompose: (c) => (calls.push(c), 0) }));
    assert.equal(code, 0);
    assert.deepEqual(calls[0].args, ['compose', '-f', 'compose.yaml', '-f', 'compose.attach.yaml', '--profile', 'attach-tg-bot', 'up', '-d', '--build', 'tg-bot-attach']);
    assert.equal(calls[0].env.HARNESS_TARGET_MODE, 'attach');
    // State untouched: guard bytes + record identical, baseline tag still resolves.
    assert.equal(fs.readFileSync(path.join(f.state, 'control', 'git-guard'), 'utf-8'), guard);
    assert.equal(fs.readFileSync(path.join(f.state, 'control', 'attach.json'), 'utf-8'), attachJson);
    const baseline = spawnSync('git', [`--git-dir=${path.join(fs.realpathSync(f.state), 'runtime', 'git')}`, 'rev-parse', '--verify', 'attach-baseline^{commit}'], { encoding: 'utf-8' });
    assert.equal(baseline.status, 0);
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('restart: refuses an empty/incomplete state (never a fresh launch)', { skip }, () => {
  const f = fixture();
  try {
    // f.state is empty (no prior run) → restart must not treat it as a launch.
    rejects(() => restartLaunch('tg-bot', [], envFor(f), opts({ execCompose: () => 0 })), /not a completed launch|missing/);
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('run: http and tg-bot map to their profile/service with up -d', { skip }, () => {
  for (const [cmd, profile, service] of [
    ['http', 'attach-http', 'http-attach'],
    ['tg-bot', 'attach-tg-bot', 'tg-bot-attach'],
  ]) {
    const f = fixture();
    try {
      const calls = [];
      const code = runLaunch(cmd, [], envFor(f), opts({ execCompose: (c) => (calls.push(c), 0) }));
      assert.equal(code, 0);
      assert.deepEqual(calls[0].args, ['compose', '-f', 'compose.yaml', '-f', 'compose.attach.yaml', '--profile', profile, 'up', '-d', '--build', service]);
      const rec = JSON.parse(fs.readFileSync(path.join(f.state, 'control', 'attach.json'), 'utf-8'));
      assert.equal(rec.profile, profile);
      assert.equal(rec.service, service);
    } finally {
      fs.rmSync(f.base, { recursive: true, force: true });
    }
  }
});

test('run: baseline includes tracked-but-gitignored files (full launch snapshot)', { skip }, () => {
  // Committed-then-gitignored files (.d.ts, .backup patterns) keep the worktree
  // clean but are invisible to a plain `add -A` — without -f they would miss
  // the baseline and reset-to-baseline's `clean -x` would delete them.
  const base = fs.mkdtempSync(path.join(TMP, 'attach-'));
  try {
    const src = path.join(base, 'src');
    fs.mkdirSync(src);
    sh(['git', 'init', '-q'], src);
    sh(['git', 'config', 'user.email', 't@t'], src);
    sh(['git', 'config', 'user.name', 't'], src);
    sh(['git', 'config', 'commit.gpgsign', 'false'], src);
    fs.writeFileSync(path.join(src, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(src, 'generated.d.ts'), 'declare const x: 1;\n');
    sh(['git', 'add', '-A'], src);
    sh(['git', 'commit', '-qm', 'init'], src);
    fs.writeFileSync(path.join(src, '.gitignore'), 'generated.d.ts\nnode_modules/\n.repovine/\n');
    sh(['git', 'add', '.gitignore'], src);
    sh(['git', 'commit', '-qm', 'ignore generated'], src);
    sh(['git', 'worktree', 'add', '-q', '../wt'], src);
    const state = path.join(base, 'state');
    fs.mkdirSync(state);
    const f = { base, src, wt: path.join(base, 'wt'), state };

    // Untracked-gitignored cache present at launch (reused worktree / pre-install):
    // must NOT enter the baseline, or reset-to-baseline would revert it and every
    // run would phantom-commit its deletion.
    fs.mkdirSync(path.join(f.wt, '.repovine'));
    fs.writeFileSync(path.join(f.wt, '.repovine', 'cache.json'), '{}\n');
    fs.mkdirSync(path.join(f.wt, 'node_modules'));
    fs.writeFileSync(path.join(f.wt, 'node_modules', 'dep.js'), 'x\n');

    const code = runLaunch('cli', [], envFor(f), opts({ execCompose: () => 0 }));
    assert.equal(code, 0);
    const listed = sh(['git', `--git-dir=${path.join(fs.realpathSync(f.state), 'runtime', 'git')}`, 'ls-tree', '-r', '--name-only', 'attach-baseline'])
      .split('\n');
    assert.ok(listed.includes('generated.d.ts'), `baseline carries the tracked-but-gitignored file, got: ${listed.join(', ')}`);
    assert.ok(listed.includes('a.txt'));
    assert.ok(!listed.some((p) => p.startsWith('.repovine/')), 'untracked-gitignored .repovine cache stays out of the baseline');
    assert.ok(!listed.some((p) => p.startsWith('node_modules/')), 'untracked-gitignored node_modules stays out of the baseline');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('run: second launch re-runs the full preflight and fails on populated state', { skip }, () => {
  const f = fixture();
  try {
    assert.equal(runLaunch('cli', [], envFor(f), opts({ execCompose: () => 0 })), 0);
    const calls = [];
    rejects(() => runLaunch('cli', [], envFor(f), opts({ execCompose: (c) => (calls.push(c), 0) })), /state-empty/);
    assert.equal(calls.length, 0, 'docker never invoked on preflight failure');
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('run: HARNESS_TARGET_MODE other than attach is rejected before docker', { skip }, () => {
  const f = fixture();
  try {
    const calls = [];
    rejects(
      () => runLaunch('cli', [], envFor(f, { HARNESS_TARGET_MODE: 'sandbox' }), opts({ execCompose: (c) => (calls.push(c), 0) })),
      /mode-profile/,
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(fs.readdirSync(f.state), [], 'no state created on mode mismatch');
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('run: baseline-repo failure is fail-closed (no attach.json, docker never invoked)', { skip }, () => {
  // Deterministic trigger without mocking: a linked worktree of an EMPTY tree —
  // `git add -A` stages nothing, so the baseline `git commit` refuses.
  const base = fs.mkdtempSync(path.join(TMP, 'attach-'));
  try {
    const src = path.join(base, 'src');
    fs.mkdirSync(src);
    sh(['git', 'init', '-q'], src);
    sh(['git', 'config', 'user.email', 't@t'], src);
    sh(['git', 'config', 'user.name', 't'], src);
    sh(['git', 'config', 'commit.gpgsign', 'false'], src);
    sh(['git', 'commit', '-q', '--allow-empty', '-m', 'init'], src);
    sh(['git', 'worktree', 'add', '-q', '../wt'], src);
    const state = path.join(base, 'state');
    fs.mkdirSync(state);
    const env = {
      HARNESS_ATTACH_WORKTREE: path.join(base, 'wt'),
      HARNESS_ATTACH_STATE_DIR: state,
      HARNESS_HOST_UID: String(uid),
      HARNESS_HOST_GID: String(gid),
    };
    const calls = [];
    rejects(() => runLaunch('cli', [], env, opts({ execCompose: (c) => (calls.push(c), 0) })), /baseline-repo/);
    assert.equal(calls.length, 0, 'docker never invoked on baseline failure');
    assert.ok(!fs.existsSync(path.join(state, 'control', 'attach.json')), 'no operator record on baseline failure');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('preflight: rejects a primary checkout (.git directory)', { skip }, () => {
  const f = fixture();
  try {
    rejects(() => preflight(envFor(f, { HARNESS_ATTACH_WORKTREE: f.src }), opts()), /linked worktree/);
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('preflight: rejects a dirty worktree (untracked file)', { skip }, () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.wt, 'untracked.txt'), 'x\n');
    rejects(() => preflight(envFor(f), opts()), /worktree-clean/);
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('preflight: rejects an unregistered/stale .git pointer', { skip }, () => {
  const base = fs.mkdtempSync(path.join(TMP, 'attach-'));
  try {
    const fake = path.join(base, 'fake');
    const state = path.join(base, 'state');
    fs.mkdirSync(fake);
    fs.mkdirSync(state);
    fs.writeFileSync(path.join(fake, '.git'), `gitdir: ${path.join(base, 'nowhere')}\n`);
    rejects(
      () =>
        preflight(
          { HARNESS_ATTACH_WORKTREE: fake, HARNESS_ATTACH_STATE_DIR: state, HARNESS_HOST_UID: String(uid), HARNESS_HOST_GID: String(gid) },
          opts(),
        ),
      /git-resolve/,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('preflight: rejects an active per-worktree merge marker', { skip }, () => {
  const f = fixture();
  try {
    const p = sh(['git', '-C', f.wt, 'rev-parse', '--git-path', 'MERGE_HEAD']);
    fs.writeFileSync(path.resolve(f.wt, p), 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n');
    rejects(() => preflight(envFor(f), opts()), /operation-marker: MERGE_HEAD/);
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('preflight: a main checkout mid-rebase does not block a clean linked worktree', { skip }, () => {
  const f = fixture();
  try {
    // Rebase state in the MAIN repo's git dir; --git-path from the worktree
    // resolves rebase-merge to the per-worktree git dir, so this must not trip.
    fs.mkdirSync(path.join(f.src, '.git', 'rebase-merge'));
    const ctx = preflight(envFor(f), opts());
    assert.equal(ctx.worktree, fs.realpathSync(f.wt));
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('preflight: rejects relative or missing paths', { skip }, () => {
  const f = fixture();
  try {
    rejects(() => preflight(envFor(f, { HARNESS_ATTACH_WORKTREE: 'relative/wt' }), opts()), /attach-env.*absolute/);
    rejects(() => preflight(envFor(f, { HARNESS_ATTACH_STATE_DIR: 'state' }), opts()), /attach-env.*absolute/);
    rejects(() => preflight(envFor(f, { HARNESS_ATTACH_WORKTREE: '' }), opts()), /attach-env/);
    rejects(() => preflight(envFor(f, { HARNESS_ATTACH_STATE_DIR: path.join(f.base, 'missing') }), opts()), /attach-env.*resolve/);
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('preflight: rejects wrong-owner and non-numeric uid/gid; missing defaults to the process owner', { skip }, () => {
  const f = fixture();
  try {
    rejects(() => preflight(envFor(f, { HARNESS_HOST_UID: String(uid + 1) }), opts()), /ownership.*uid/);
    rejects(() => preflight(envFor(f, { HARNESS_HOST_UID: 'abc' }), opts()), /ownership.*HARNESS_HOST_UID/);
    rejects(() => preflight(envFor(f, { HARNESS_HOST_GID: '1.5' }), opts()), /ownership.*HARNESS_HOST_GID/);
    // Missing uid/gid now default to the launcher's own uid/gid (it runs as the
    // operator, who owns the prepared worktree) — no error, ownership passes.
    const ctx = preflight(envFor(f, { HARNESS_HOST_UID: undefined, HARNESS_HOST_GID: undefined }), opts());
    assert.equal(ctx.worktree, fs.realpathSync(f.wt), 'missing uid/gid resolves via the process owner');
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('prepare: creates a registered detached worktree + empty state, auto-names, chains into preflight', { skip }, () => {
  const f = fixture();
  const launchFile = path.join(f.base, 'launch.json');
  const roots = {
    HARNESS_ATTACH_ROOT: path.join(f.base, 'launches'),
    HARNESS_ATTACH_LAUNCH_FILE: launchFile,
  };
  try {
    const p1 = prepareLaunch(f.src, {}, roots);
    assert.equal(p1.name, 'src-run-001', 'auto-named from the checkout basename');
    assert.equal(p1.worktree, path.join(roots.HARNESS_ATTACH_ROOT, 'worktrees', 'src-run-001'), 'root derives worktrees/');
    assert.equal(p1.stateDir, path.join(roots.HARNESS_ATTACH_ROOT, 'state', 'src-run-001'), 'root derives state/');
    assert.match(fs.readFileSync(path.join(p1.worktree, '.git'), 'utf-8'), /^gitdir: /, 'linked worktree, not a copy');
    assert.equal(sh(['git', '-C', p1.worktree, 'status', '--porcelain', '--untracked-files=all']), '', 'clean');
    assert.equal(p1.baseOid, sh(['git', '-C', f.src, 'rev-parse', 'HEAD']), 'detached at the requested base');
    assert.deepEqual(fs.readdirSync(p1.stateDir), [], 'state dir exists and is empty');

    // prepare recorded the current launch; preflight resolves it with NO
    // worktree/state env (preflight creates nothing, so p1 stays reusable), and
    // HARNESS_HOST_UID/GID default to the process owner.
    const pointer = JSON.parse(fs.readFileSync(launchFile, 'utf-8'));
    assert.equal(pointer.worktree, fs.realpathSync(p1.worktree));
    assert.equal(pointer.stateDir, fs.realpathSync(p1.stateDir));
    const fromPointer = preflight({ HARNESS_ATTACH_LAUNCH_FILE: launchFile }, opts());
    assert.equal(fromPointer.worktree, fs.realpathSync(p1.worktree), 'preflight resolves the recorded launch without env');

    // Explicit env overrides the pointer (p1 is still clean — nothing ran on it).
    const overridden = preflight(
      { HARNESS_ATTACH_LAUNCH_FILE: launchFile, HARNESS_ATTACH_WORKTREE: p1.worktree, HARNESS_ATTACH_STATE_DIR: p1.stateDir },
      opts(),
    );
    assert.equal(overridden.worktree, fs.realpathSync(p1.worktree), 'env wins over the pointer');

    // Auto-increment; the latest prepare becomes the current launch.
    const p2 = prepareLaunch(f.src, {}, roots);
    assert.equal(p2.name, 'src-run-002');
    assert.equal(JSON.parse(fs.readFileSync(launchFile, 'utf-8')).name, 'src-run-002', 'latest prepare wins');
    rejects(() => prepareLaunch(f.src, { name: 'src-run-001' }, roots), /prepare.*already exists/);
    rejects(() => prepareLaunch(f.base, {}, roots), /prepare.*not a Git repository/);

    // run resolves the current pointer (now p2) and invokes compose — this
    // consumes p2's state, so p2 is not reused after.
    const calls = [];
    runLaunch('cli', ['--task', 'x'], { HARNESS_ATTACH_LAUNCH_FILE: launchFile }, opts({ execCompose: (c) => (calls.push(c), 0) }));
    assert.equal(calls.length, 1, 'run resolves the recorded launch and invokes compose');

    // --base: a branch name works even while checked out in the source (detach).
    sh(['git', '-C', f.src, 'branch', 'b1'], f.src);
    const p3 = prepareLaunch(f.src, { base: 'b1' }, roots);
    assert.equal(p3.baseOid, sh(['git', '-C', f.src, 'rev-parse', 'b1']));

    // Without HARNESS_ATTACH_ROOT the default is the checkout's parent
    // (.repovine-harness-worktrees/.repovine-harness-state next to it).
    const p4 = prepareLaunch(f.src, {}, { HARNESS_ATTACH_LAUNCH_FILE: launchFile });
    assert.equal(p4.worktree, path.join(path.dirname(f.src), '.repovine-harness-worktrees', 'src-run-001'));
    assert.equal(p4.stateDir, path.join(path.dirname(f.src), '.repovine-harness-state', 'src-run-001'));
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('preflight: rejects an agents dir aliasing the worktree or state bind sources', { skip }, () => {
  const f = fixture();
  try {
    const insideWt = path.join(f.wt, 'agents-sub');
    fs.mkdirSync(insideWt);
    // Committed? No — an untracked dir would also fail worktree-clean later, but
    // the overlap check fires first (step 2 precedes step 7).
    rejects(
      () => preflight(envFor(f, { HARNESS_AGENTS_HOST_DIR: insideWt }), opts()),
      /path-overlap.*agents dir is inside the worktree/,
    );
    rejects(
      () => preflight(envFor(f, { HARNESS_AGENTS_HOST_DIR: f.base }), opts()),
      /path-overlap.*inside the agents dir/,
    );
    rejects(
      () => preflight(envFor(f, { HARNESS_AGENTS_HOST_DIR: path.join(f.base, 'no-such-dir') }), opts()),
      /path-overlap.*does not resolve/,
    );
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('preflight: rejects ancestor/descendant/alias overlaps', { skip }, () => {
  // State inside the worktree.
  const a = fixture();
  try {
    const inside = path.join(a.wt, 'state-sub');
    fs.mkdirSync(inside);
    rejects(() => preflight(envFor(a, { HARNESS_ATTACH_STATE_DIR: inside }), opts()), /path-overlap.*inside the worktree/);
  } finally {
    fs.rmSync(a.base, { recursive: true, force: true });
  }

  // Worktree inside the state dir.
  const b = fixture();
  try {
    const state2 = path.join(b.base, 'state2');
    fs.mkdirSync(state2);
    sh(['git', 'worktree', 'add', '-q', '../state2/wt2'], b.src);
    rejects(
      () =>
        preflight(
          envFor(b, { HARNESS_ATTACH_WORKTREE: path.join(state2, 'wt2'), HARNESS_ATTACH_STATE_DIR: state2 }),
          opts(),
        ),
      /path-overlap.*worktree is inside the state dir/,
    );
  } finally {
    fs.rmSync(b.base, { recursive: true, force: true });
  }

  // State dir containing the git common dir (and the source checkout).
  const base = fs.mkdtempSync(path.join(TMP, 'attach-'));
  try {
    const hold = path.join(base, 'hold');
    const src = path.join(hold, 'src');
    fs.mkdirSync(src, { recursive: true });
    sh(['git', 'init', '-q'], src);
    sh(['git', 'config', 'user.email', 't@t'], src);
    sh(['git', 'config', 'user.name', 't'], src);
    sh(['git', 'config', 'commit.gpgsign', 'false'], src);
    fs.writeFileSync(path.join(src, 'a.txt'), 'a\n');
    sh(['git', 'add', '.'], src);
    sh(['git', 'commit', '-qm', 'init'], src);
    sh(['git', 'worktree', 'add', '-q', '../../wt'], src);
    rejects(
      () =>
        preflight(
          {
            HARNESS_ATTACH_WORKTREE: path.join(base, 'wt'),
            HARNESS_ATTACH_STATE_DIR: hold,
            HARNESS_HOST_UID: String(uid),
            HARNESS_HOST_GID: String(gid),
          },
          opts(),
        ),
      /path-overlap.*state dir contains/,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }

  // Worktree === state via symlink (realpath alias).
  const c = fixture();
  try {
    const link = path.join(c.base, 'statelink');
    fs.symlinkSync(c.wt, link);
    rejects(() => preflight(envFor(c, { HARNESS_ATTACH_STATE_DIR: link }), opts()), /attach-env.*same directory/);
  } finally {
    fs.rmSync(c.base, { recursive: true, force: true });
  }
});

test('preflight: rejects a mount point below the worktree or state dir', { skip }, () => {
  const f = fixture();
  try {
    const wtReal = fs.realpathSync(f.wt);
    const stReal = fs.realpathSync(f.state);
    rejects(
      () => preflight(envFor(f), { mountinfoText: `${CLEAN_MOUNTINFO}${miLine(path.join(wtReal, 'sub'))}\n` }),
      /mount-table/,
    );
    rejects(
      () => preflight(envFor(f), { mountinfoText: `${CLEAN_MOUNTINFO}${miLine(path.join(stReal, 'runtime'))}\n` }),
      /mount-table/,
    );
    // Mount AT the worktree root is fine.
    const ctx = preflight(envFor(f), { mountinfoText: `${CLEAN_MOUNTINFO}${miLine(wtReal)}\n` });
    assert.equal(ctx.worktree, wtReal);
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('preflight: WSL branch enforces ext4 on the worktree mount (seam-injected)', { skip }, () => {
  const typedLine = (mp, fsType) => `36 35 98:0 / ${mp} rw shared:1 - ${fsType} /dev/sda1 rw`;
  const f = fixture();
  try {
    const wtReal = fs.realpathSync(f.wt);
    // Worktree on its own btrfs mount: fine on plain Linux, rejected under WSL.
    const btrfsTable = `${CLEAN_MOUNTINFO}${typedLine(wtReal, 'btrfs')}\n`;
    const ctx = preflight(envFor(f), { mountinfoText: btrfsTable, wslHost: false });
    assert.equal(ctx.worktree, wtReal);
    rejects(
      () => preflight(envFor(f), { mountinfoText: btrfsTable, wslHost: true }),
      /fs-type.*ext4/,
    );
    // Same shape with ext4 passes under WSL — the type decides, not the path.
    const ext4Table = `${CLEAN_MOUNTINFO}${typedLine(wtReal, 'ext4')}\n`;
    const ok = preflight(envFor(f), { mountinfoText: ext4Table, wslHost: true });
    assert.equal(ok.worktree, wtReal);
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('preflight: fs-type is proven for the state dir too, and docker stays unreached', { skip }, () => {
  const typedLine = (mp, fsType) => `36 35 98:0 / ${mp} rw shared:1 - ${fsType} /dev/sda1 rw`;
  const f = fixture();
  try {
    const stReal = fs.realpathSync(f.state);
    const table = `${CLEAN_MOUNTINFO}${typedLine(stReal, '9p')}\n`;
    rejects(() => preflight(envFor(f), { mountinfoText: table }), /fs-type.*9p/);
    const calls = [];
    rejects(
      () => runLaunch('cli', [], envFor(f), { execCompose: (a) => { calls.push(a); return { status: 0 }; }, mountinfoText: table }),
      /fs-type/,
    );
    assert.equal(calls.length, 0, 'docker must not run when a bind source sits on an unprovable filesystem');
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('preflight: a mount table that cannot be enumerated forbids docker', { skip }, () => {
  const f = fixture();
  try {
    // Empty table reads as cannot-enumerate, never as "no mounts to check".
    rejects(() => preflight(envFor(f), { mountinfoText: '' }), /mount-table/);
    // One malformed line (mandatory fields but no '-' separator) poisons the
    // whole table — skipping it could hide exactly the mount that matters.
    const malformed = `${CLEAN_MOUNTINFO}37 35 98:0 / /somewhere rw\n`;
    rejects(() => preflight(envFor(f), { mountinfoText: malformed }), /mount-table/);
    // runLaunch with the same tables: the compose seam is NEVER reached.
    for (const mountinfoText of ['', malformed]) {
      const calls = [];
      rejects(
        () => runLaunch('cli', [], envFor(f), { mountinfoText, execCompose: (c) => (calls.push(c), 0) }),
        /mount-table/,
      );
      assert.equal(calls.length, 0, 'docker never invoked when mounts cannot be enumerated');
    }
    assert.deepEqual(fs.readdirSync(f.state), [], 'no state created on mount-table failure');
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('preflight: rejects a worktree on a projection filesystem (type decides, not path)', { skip }, () => {
  const f = fixture();
  try {
    const wtReal = fs.realpathSync(f.wt);
    // Native-looking path, projection fs-type: a mount AT the worktree root
    // passes mountsBelow, so the rejection is purely the 9p type.
    const table = `${CLEAN_MOUNTINFO}40 35 98:0 / ${wtReal} rw shared:1 - 9p tank rw\n`;
    const calls = [];
    rejects(
      () => runLaunch('cli', [], envFor(f), { mountinfoText: table, execCompose: (c) => (calls.push(c), 0) }),
      /fs-type/,
    );
    assert.equal(calls.length, 0, 'docker never invoked on an unprovable filesystem');
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('preflight: case-variant sibling paths are distinct strings (no case-folding)', { skip }, () => {
  const f = fixture();
  try {
    const wtReal = fs.realpathSync(f.wt);
    // A mount below a case-variant of the worktree path is a different
    // directory on a case-sensitive filesystem; identity checks compare exact
    // bytes, so it is neither the worktree nor below it.
    const variant = path.join(path.dirname(wtReal), path.basename(wtReal).toUpperCase());
    assert.notEqual(variant, wtReal);
    const ctx = preflight(envFor(f), { mountinfoText: `${CLEAN_MOUNTINFO}${miLine(path.join(variant, 'nested'))}\n` });
    assert.equal(ctx.worktree, wtReal);
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('preflight: rejects a FIFO in the worktree (walk runs before status)', { skip: skip || !mkfifoOk }, () => {
  const f = fixture();
  try {
    assert.equal(spawnSync('mkfifo', [path.join(f.wt, 'pipe')]).status, 0);
    rejects(() => preflight(envFor(f), opts()), /worktree-walk.*(FIFO|special)/);
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('preflight: rejects a non-empty state parent', { skip }, () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.state, 'junk'), 'x\n');
    rejects(() => preflight(envFor(f), opts()), /state-empty/);
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

// ── CLI surface ────────────────────────────────────────────────────────────────

test('cli: usage exit 2 for unknown/malformed commands, exit 1 for preflight failure', () => {
  const runCli = (args, extraEnv = {}) =>
    spawnSync(process.execPath, [LAUNCHER, ...args], { encoding: 'utf-8', env: { ...process.env, ...extraEnv } });

  assert.equal(runCli([]).status, 2);
  assert.equal(runCli(['bogus']).status, 2);
  assert.equal(runCli(['run', 'bogus']).status, 2);
  assert.equal(runCli(['preflight', 'extra']).status, 2);
  assert.equal(runCli(['run', 'http', 'extra-arg']).status, 2, 'up-style commands take no passthrough');

  // Inline non-empty env beats the demo .env; a relative path fails step 1
  // deterministically with the check name on stderr.
  const r = runCli(['preflight'], { HARNESS_ATTACH_WORKTREE: 'not-absolute', HARNESS_ATTACH_STATE_DIR: '/nonexistent-state' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /attach attach-env/);
});
