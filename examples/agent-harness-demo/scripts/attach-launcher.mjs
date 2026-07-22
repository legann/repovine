#!/usr/bin/env node
// Attach-mode host launcher — the executable trust boundary for mounting a
// pre-created host Git worktree at /workspace (see the attach services in
// compose.yaml).
//
//   npm run attach -- preflight
//   npm run attach -- run cli [args passed to the CLI entrypoint]
//   npm run attach -- run http
//   npm run attach -- run tg-bot
//
// `preflight` validates a launch and creates NOTHING. `run` re-runs the full
// preflight every time (a prior standalone check is never trusted), creates the
// control/runtime state layout under $HARNESS_ATTACH_STATE_DIR, then invokes
// docker compose with the attach profile. Every preflight failure prints a
// one-line diagnostic naming the check and exits non-zero BEFORE any docker
// invocation.
//
// `run` also prepares a launch-scoped DISPOSABLE Git repo at
// $HARNESS_ATTACH_STATE_DIR/runtime/git: one baseline commit of the worktree
// tree at launch, tagged `attach-baseline`. The read-only /workspace/.git mount
// is a VALID pointer into that repo (the agent cannot repoint it); the source
// repository's common dir is still never mounted. Agent commits land in launch
// state and stay fetchable by the operator after the run.
//
// The launcher never removes worktrees, state dirs, branches or refs, and never
// commits/merges/pushes. Teardown is manual:
//   docker compose --profile attach-<cmd> down
//   rm -rf "$HARNESS_ATTACH_STATE_DIR" && git worktree remove <worktree>

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadEnvFile } from '../lib/env-file.mjs';
import { ATTACH_BASELINE_REF, ATTACH_GIT_POINTER_CONTENT } from '../lib/attach-guard.mjs';

const DEMO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// run <cmd> → compose profile/service. Sandbox profiles and workspace-init are
// never selected by the launcher.
const ATTACH_TARGETS = {
  // --build mirrors the sandbox docker:* scripts: the image bakes in the engine
  // and demo lib/, so a stale image silently runs old code; with the build
  // cache an unchanged tree is a seconds-long no-op.
  cli: { profile: 'attach-cli', service: 'cli-attach', compose: ['run', '--rm', '--build'] },
  http: { profile: 'attach-http', service: 'http-attach', compose: ['up', '-d', '--build'] },
  'tg-bot': { profile: 'attach-tg-bot', service: 'tg-bot-attach', compose: ['up', '-d', '--build'] },
};

export class PreflightError extends Error {
  constructor(check, detail) {
    super(`attach ${check}: ${detail}`);
    this.check = check;
  }
}

const fail = (check, detail) => {
  throw new PreflightError(check, detail);
};

// Attach trust checks are built on /proc mount topology and Unix identity.
// Every attach entry point (prepare, preflight, run, restart) fails here on
// other hosts, before any env/git/docker work; WSL2 reports 'linux' and passes.
const assertLinuxHost = () => {
  if (process.platform !== 'linux') {
    fail(
      'platform',
      `attach requires a Linux or WSL2 host (host platform: ${process.platform}). ` +
        'Native Windows: use WSL2 with an ext4 checkout. macOS attach is unsupported ' +
        'pending a separate security design (docs/usage.md, "Platform support").',
    );
  }
};

const firstLine = (s) => String(s || '').split('\n')[0];

function git(args, opts = {}) {
  const r = spawnSync('git', args, { encoding: 'utf-8', ...opts });
  if (r.error) return { ok: false, out: '', err: String(r.error.message || r.error) };
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// True when `p` equals `parent` or lives under it. Both paths must already be
// canonical (realpath) — string containment only, no filesystem access.
export function pathContains(parent, p) {
  const rel = path.relative(parent, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// Mount points (field 5 of /proc/self/mountinfo) with octal escapes decoded
// (\040 space, \011 tab, \012 newline, \134 backslash).
export function parseMountinfo(text) {
  const points = [];
  for (const line of String(text).split('\n')) {
    const fields = line.split(' ');
    if (fields.length < 5) continue;
    points.push(fields[4].replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))));
  }
  return points;
}

// Mount points STRICTLY below any of `roots`. A mount AT a root is fine (a
// worktree on its own partition/bind); one below it would shadow or leak
// through the container bind.
export function mountsBelow(mountinfoText, roots) {
  const offending = [];
  for (const mp of parseMountinfo(mountinfoText)) {
    if (roots.some((root) => mp !== root && pathContains(root, mp))) offending.push(mp);
  }
  return offending;
}

// Complete lstat walk of the worktree. Symlinks are allowed and NEVER followed
// (lstat only; recursion only into real directories). Rejected: IPC/device
// nodes, and regular files with nlink > 1 — a hardlink shares content with a
// path that may live outside the mount.
export function walkWorktree(root) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      if (st.isSocket() || st.isFIFO() || st.isCharacterDevice() || st.isBlockDevice()) {
        return { ok: false, path: p, reason: 'special file (socket/FIFO/device)' };
      }
      if (st.isFile() && st.nlink > 1) {
        return { ok: false, path: p, reason: `hardlinked regular file (nlink=${st.nlink})` };
      }
      if (st.isDirectory()) stack.push(p);
    }
  }
  return { ok: true };
}

function readMountinfo() {
  try {
    return fs.readFileSync('/proc/self/mountinfo', 'utf-8');
  } catch (err) {
    fail('mount-table', `cannot read /proc/self/mountinfo (${err.code || err.message}); attach requires a Linux host`);
  }
}

function parseWorktreeList(out) {
  return String(out)
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => {
      const entry = { path: null, bare: false };
      for (const line of block.split('\n')) {
        if (line.startsWith('worktree ')) entry.path = line.slice('worktree '.length);
        else if (line === 'bare') entry.bare = true;
      }
      return entry;
    });
}

/** Launch pointer `prepare` writes and preflight/run read (env vars override). */
export function launchFilePath(env = process.env) {
  return env.HARNESS_ATTACH_LAUNCH_FILE
    ? path.resolve(String(env.HARNESS_ATTACH_LAUNCH_FILE))
    : path.join(DEMO_ROOT, '.attach-launch.json');
}

/**
 * Resolve the effective launch env: explicit variables win; missing worktree /
 * state fall back to the `.attach-launch.json` pointer the last `prepare`
 * wrote; missing HARNESS_HOST_UID/GID default to the launcher's own uid/gid
 * (the launcher runs as the operator — that IS the owner preflight verifies).
 */
export function resolveLaunchEnv(env = process.env) {
  const out = { ...env };
  if (!out.HARNESS_ATTACH_WORKTREE || !out.HARNESS_ATTACH_STATE_DIR) {
    const file = launchFilePath(env);
    if (fs.existsSync(file)) {
      try {
        const launch = JSON.parse(fs.readFileSync(file, 'utf-8'));
        out.HARNESS_ATTACH_WORKTREE ||= launch.worktree;
        out.HARNESS_ATTACH_STATE_DIR ||= launch.stateDir;
        out._launchName = launch.name;
      } catch {
        fail('attach-env', `${file} does not parse — re-run \`npm run attach -- prepare <checkout>\``);
      }
    }
  }
  if (!out.HARNESS_HOST_UID && typeof process.getuid === 'function') out.HARNESS_HOST_UID = String(process.getuid());
  if (!out.HARNESS_HOST_GID && typeof process.getgid === 'function') out.HARNESS_HOST_GID = String(process.getgid());
  return out;
}

// Fail-closed preflight (steps 1–10 of the attach plan). Pure validation: no
// directory or file is ever created here. `cmd` is set for `run` (adds the
// mode/profile check); `mountinfoText` is a test seam for the mount-table scan.
// Missing inputs resolve from the `prepare` launch pointer via resolveLaunchEnv.
export function preflight(env, { cmd, mountinfoText, existingState = false } = {}) {
  // 0. Host platform gate (see assertLinuxHost).
  assertLinuxHost();
  env = resolveLaunchEnv(env);
  // 1. Env paths: set, absolute, canonical (realpath — symlinked input accepted,
  // the canonical path is what Compose receives), distinct directories.
  const rawWt = env.HARNESS_ATTACH_WORKTREE;
  const rawState = env.HARNESS_ATTACH_STATE_DIR;
  if (!rawWt) fail('attach-env', 'HARNESS_ATTACH_WORKTREE is not set');
  if (!rawState) fail('attach-env', 'HARNESS_ATTACH_STATE_DIR is not set');
  if (!path.isAbsolute(rawWt)) fail('attach-env', `HARNESS_ATTACH_WORKTREE must be an absolute path: ${rawWt}`);
  if (!path.isAbsolute(rawState)) fail('attach-env', `HARNESS_ATTACH_STATE_DIR must be an absolute path: ${rawState}`);
  let worktree;
  let stateDir;
  try {
    worktree = fs.realpathSync(rawWt);
  } catch {
    fail('attach-env', `HARNESS_ATTACH_WORKTREE does not resolve: ${rawWt}`);
  }
  try {
    stateDir = fs.realpathSync(rawState);
  } catch {
    fail('attach-env', `HARNESS_ATTACH_STATE_DIR does not resolve: ${rawState}`);
  }
  if (worktree === stateDir) fail('attach-env', `worktree and state dir are the same directory: ${worktree}`);
  if (!fs.statSync(worktree).isDirectory()) fail('attach-env', `worktree is not a directory: ${worktree}`);
  if (!fs.statSync(stateDir).isDirectory()) fail('attach-env', `state dir is not a directory: ${stateDir}`);

  // 2. Overlap topology. First the two inputs against each other…
  if (pathContains(worktree, stateDir)) fail('path-overlap', `state dir is inside the worktree: ${stateDir}`);
  if (pathContains(stateDir, worktree)) fail('path-overlap', `worktree is inside the state dir: ${worktree}`);

  // .git pointer (step 5, pulled forward: a .git DIRECTORY is the primary
  // checkout — its git dir sits inside the mount, so reject before overlap math).
  const dotGit = path.join(worktree, '.git');
  let dotGitStat;
  try {
    dotGitStat = fs.lstatSync(dotGit);
  } catch {
    fail('git-pointer', `worktree has no .git entry: ${dotGit}`);
  }
  if (dotGitStat.isDirectory()) {
    fail('git-pointer', 'worktree .git is a directory (primary checkout); attach requires a linked worktree');
  }
  if (!dotGitStat.isFile()) fail('git-pointer', `worktree .git is not a regular file: ${dotGit}`);
  if (!fs.readFileSync(dotGit, 'utf-8').startsWith('gitdir: ')) {
    fail('git-pointer', `worktree .git does not start with "gitdir: ": ${dotGit}`);
  }

  // …then the git data locations. Per-worktree git dir + common dir, realpathed.
  const dirsOut = git(['-C', worktree, 'rev-parse', '--git-dir', '--git-common-dir']);
  if (!dirsOut.ok) fail('git-resolve', `git rev-parse --git-dir failed: ${firstLine(dirsOut.err) || 'unknown error'}`);
  const [gitDirRaw, commonDirRaw] = dirsOut.out.split('\n');
  let gitDir;
  let commonDir;
  try {
    gitDir = fs.realpathSync(path.resolve(worktree, gitDirRaw));
  } catch {
    fail('git-resolve', `per-worktree git dir does not resolve: ${gitDirRaw}`);
  }
  try {
    commonDir = fs.realpathSync(path.resolve(worktree, commonDirRaw));
  } catch {
    fail('git-resolve', `git common dir does not resolve: ${commonDirRaw}`);
  }

  const listOut = git(['-C', commonDir, 'worktree', 'list', '--porcelain']);
  if (!listOut.ok) fail('git-resolve', `git worktree list failed: ${firstLine(listOut.err)}`);
  const wtEntries = parseWorktreeList(listOut.out);

  // Source checkout toplevel. `rev-parse --show-toplevel` from the common dir
  // fails on current git ("must be run in a work tree"); the main entry of
  // `worktree list --porcelain` supplies it. null for bare repos.
  let sourceToplevel = null;
  const top = git(['-C', commonDir, 'rev-parse', '--show-toplevel']);
  if (top.ok && top.out) {
    try {
      sourceToplevel = fs.realpathSync(firstLine(top.out));
    } catch {
      sourceToplevel = null;
    }
  }
  if (!sourceToplevel && wtEntries[0] && !wtEntries[0].bare && wtEntries[0].path) {
    try {
      sourceToplevel = fs.realpathSync(wtEntries[0].path);
    } catch {
      sourceToplevel = null;
    }
  }

  // Neither bind side may contain — or sit inside — the source repo's git data.
  // The one legitimate containment: sourceToplevel ⊇ worktree (a worktree
  // physically inside the source checkout mounts only itself).
  for (const [label, d] of [
    ['git common dir', commonDir],
    ['per-worktree git dir', gitDir],
  ]) {
    if (pathContains(worktree, d)) {
      fail('path-overlap', `worktree contains the ${label} (${d}); attach requires a linked worktree with git data outside the mount`);
    }
    if (pathContains(d, worktree)) fail('path-overlap', `worktree is inside the ${label}: ${d}`);
    if (pathContains(stateDir, d)) fail('path-overlap', `state dir contains the ${label}: ${d}`);
    if (pathContains(d, stateDir)) fail('path-overlap', `state dir is inside the ${label}: ${d}`);
  }
  if (sourceToplevel) {
    if (pathContains(worktree, sourceToplevel)) fail('path-overlap', `worktree contains the source checkout: ${sourceToplevel}`);
    if (pathContains(stateDir, sourceToplevel)) fail('path-overlap', `state dir contains the source checkout: ${sourceToplevel}`);
    if (pathContains(sourceToplevel, stateDir)) fail('path-overlap', `state dir is inside the source checkout: ${sourceToplevel}`);
  }

  // The fifth bind source: the role-briefs dir (mounted ro at HARNESS_AGENTS_DIR).
  // "No bind source aliases another bind source" — it must not sit inside the
  // worktree or the launch state, nor contain them. A missing custom path is
  // rejected here so Docker cannot auto-create it as a root-owned host dir.
  const rawAgents = env.HARNESS_AGENTS_HOST_DIR || path.join(DEMO_ROOT, 'lib', 'agents');
  let agentsDir;
  try {
    agentsDir = fs.realpathSync(path.isAbsolute(rawAgents) ? rawAgents : path.resolve(DEMO_ROOT, rawAgents));
  } catch {
    fail('path-overlap', `HARNESS_AGENTS_HOST_DIR does not resolve: ${rawAgents}`);
  }
  for (const [label, p] of [
    ['worktree', worktree],
    ['state dir', stateDir],
  ]) {
    if (pathContains(p, agentsDir)) fail('path-overlap', `agents dir is inside the ${label}: ${agentsDir}`);
    if (pathContains(agentsDir, p)) fail('path-overlap', `${label} is inside the agents dir: ${agentsDir}`);
  }

  // A fresh launch (`run`) requires an empty dedicated state parent. `restart`
  // reuses an already-laid-out launch, so it instead verifies the state IS a
  // valid prior launch (control/runtime + the baseline tag) — the same layout
  // `run` would have created, never a half-written or foreign directory.
  if (existingState) {
    const control = path.join(stateDir, 'control');
    const stateGit = path.join(stateDir, 'runtime', 'git');
    for (const [label, p] of [
      ['control/git-guard', path.join(control, 'git-guard')],
      ['control/attach.json', path.join(control, 'attach.json')],
      ['runtime/git', stateGit],
    ]) {
      if (!fs.existsSync(p)) fail('state-layout', `restart: ${label} missing — not a completed launch (${stateDir}). Use \`run\` for a fresh launch.`);
    }
    const baseline = git(['--git-dir', stateGit, 'rev-parse', '--verify', `${ATTACH_BASELINE_REF}^{commit}`]);
    if (!baseline.ok) fail('state-layout', `restart: ${ATTACH_BASELINE_REF} does not resolve in ${stateGit} — launch is incomplete`);
  } else {
    const stateEntries = fs.readdirSync(stateDir);
    if (stateEntries.length > 0) {
      fail('state-empty', `state dir is not empty (${stateEntries.length} entr${stateEntries.length === 1 ? 'y' : 'ies'}): ${stateDir}`);
    }
  }

  // 3. No host mount point strictly below the worktree or the state dir.
  const offending = mountsBelow(mountinfoText !== undefined ? mountinfoText : readMountinfo(), [worktree, stateDir]);
  if (offending.length > 0) fail('mount-table', `mount point below worktree/state dir: ${offending[0]}`);

  // 4. Complete lstat walk (the .git pointer file is a regular file — fine).
  const walk = walkWorktree(worktree);
  if (!walk.ok) fail('worktree-walk', `${walk.reason}: ${walk.path}`);

  // 5. Remainder covered above: pointer format checked, per-worktree git dir
  // realpath-resolved (exists) and proven outside the worktree.

  // 6. The worktree is the checkout toplevel and a LINKED (non-first) entry in
  // the common repo's worktree list.
  const topWt = git(['-C', worktree, 'rev-parse', '--show-toplevel']);
  if (!topWt.ok) fail('worktree-registration', `git rev-parse --show-toplevel failed: ${firstLine(topWt.err)}`);
  let topReal;
  try {
    topReal = fs.realpathSync(firstLine(topWt.out));
  } catch {
    fail('worktree-registration', `checkout toplevel does not resolve: ${firstLine(topWt.out)}`);
  }
  if (topReal !== worktree) fail('worktree-registration', `worktree ${worktree} is not the checkout toplevel (${topReal})`);
  const realListed = wtEntries.map((e) => {
    if (!e.path) return null;
    try {
      return fs.realpathSync(e.path);
    } catch {
      return null;
    }
  });
  const idx = realListed.indexOf(worktree);
  if (idx < 0) fail('worktree-registration', `worktree is not registered in git worktree list: ${worktree}`);
  if (idx === 0) fail('worktree-registration', 'worktree is the main checkout entry; attach requires a LINKED worktree');

  // 7. Clean worktree — for a FRESH launch: pre-existing changes must not be
  // confusable with agent output, and the baseline snapshots the tracked set.
  // `restart` (existingState) SKIPS this: the baseline was already built from a
  // clean tree at the original `run`; the worktree is now legitimately dirty
  // with prior episodes' edits — that IS the continuation being resumed.
  if (!existingState) {
    const status = git(['-C', worktree, 'status', '--porcelain=v1', '--untracked-files=all']);
    if (!status.ok) fail('worktree-clean', `git status failed: ${firstLine(status.err)}`);
    if (status.out !== '') {
      fail('worktree-clean', `worktree is dirty (${status.out.split('\n').length} path(s)); commit or stash before attach`);
    }
  }

  // 8. No operation marker in the PER-WORKTREE git dir (--git-path resolves the
  // worktree redirection). The COMMON dir is deliberately not checked — a main
  // checkout mid-rebase is a legitimate launch condition.
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply']) {
    const gp = git(['-C', worktree, 'rev-parse', '--git-path', marker]);
    if (!gp.ok) fail('operation-marker', `git rev-parse --git-path ${marker} failed: ${firstLine(gp.err)}`);
    const p = path.resolve(worktree, firstLine(gp.out));
    if (fs.existsSync(p)) fail('operation-marker', `${marker} present (operation in progress): ${p}`);
  }

  // 9. Ownership: numeric HARNESS_HOST_UID/GID, worktree + state dir owned by
  // that uid and writable.
  const uid = env.HARNESS_HOST_UID;
  const gid = env.HARNESS_HOST_GID;
  if (!/^\d+$/.test(uid || '')) {
    fail('ownership', `HARNESS_HOST_UID must be numeric (got ${uid === undefined ? 'unset' : JSON.stringify(uid)})`);
  }
  if (!/^\d+$/.test(gid || '')) {
    fail('ownership', `HARNESS_HOST_GID must be numeric (got ${gid === undefined ? 'unset' : JSON.stringify(gid)})`);
  }
  for (const [label, p] of [
    ['worktree', worktree],
    ['state dir', stateDir],
  ]) {
    const st = fs.statSync(p);
    if (st.uid !== Number(uid)) fail('ownership', `${label} owner uid ${st.uid} != HARNESS_HOST_UID ${uid}: ${p}`);
    try {
      fs.accessSync(p, fs.constants.W_OK);
    } catch {
      fail('ownership', `${label} is not writable: ${p}`);
    }
  }

  // 10. run-only: command maps to exactly one attach profile; HARNESS_TARGET_MODE,
  // if set, must be 'attach' — rejected before any docker invocation.
  let profile = null;
  let service = null;
  if (cmd !== undefined) {
    const target = ATTACH_TARGETS[cmd];
    if (!target) fail('mode-profile', `unknown run command ${JSON.stringify(cmd)}; expected cli | http | tg-bot`);
    const mode = env.HARNESS_TARGET_MODE;
    if (mode !== undefined && mode !== '' && mode !== 'attach') {
      fail('mode-profile', `HARNESS_TARGET_MODE=${mode} conflicts with an attach launch`);
    }
    profile = target.profile;
    service = target.service;
  }

  return { worktree, stateDir, gitDir, commonDir, sourceToplevel, profile, service };
}

function defaultExecCompose({ args, env, cwd }) {
  const r = spawnSync('docker', args, { cwd, env, stdio: 'inherit' });
  if (r.error) {
    console.error(`attach run: docker failed to start: ${r.error.message}`);
    return 1;
  }
  return r.status === null ? 1 : r.status;
}

// Full preflight, then state layout, then docker compose. `execCompose` is the
// injectable seam so tests never start docker.
export function runLaunch(cmd, passthroughArgs, env, { execCompose = defaultExecCompose, mountinfoText } = {}) {
  env = resolveLaunchEnv(env);
  if (env._launchName) console.error(`attach run: using prepared launch "${env._launchName}" (env vars override)`);
  const ctx = preflight(env, { cmd, mountinfoText });
  const target = ATTACH_TARGETS[cmd];

  // Fail-on-exist, non-recursive mkdir: a symlink planted at the final
  // component yields EEXIST instead of being followed.
  const control = path.join(ctx.stateDir, 'control');
  const runtime = path.join(ctx.stateDir, 'runtime');
  const stateGit = path.join(runtime, 'git');
  for (const d of [control, runtime, path.join(runtime, 'home'), path.join(runtime, 'harness'), stateGit]) {
    fs.mkdirSync(d, { mode: 0o700 });
  }
  fs.writeFileSync(path.join(control, 'git-guard'), ATTACH_GIT_POINTER_CONTENT, { flag: 'wx', mode: 0o400 });

  const head = git(['-C', ctx.worktree, 'rev-parse', 'HEAD']);
  if (!head.ok) fail('git-resolve', `git rev-parse HEAD failed: ${firstLine(head.err)}`);
  const baseOid = firstLine(head.out);

  // Disposable baseline repo (the pointer target): one commit of the source
  // worktree's TRACKED SET at launch, tagged attach-baseline. GIT_WORK_TREE
  // overrides core.worktree during this host-side prep, so the container path
  // core.worktree=/workspace is set LAST.
  //
  // The baseline is the source's tracked set, not the physical working tree.
  // `git ls-files` (source's native .git — no disposable env) yields exactly
  // that: it INCLUDES tracked-but-gitignored files (committed .d.ts / .backup /
  // .env.example) and EXCLUDES untracked-gitignored agent cache (a `.repovine`
  // built by a prior run on a reused worktree, a pre-installed `node_modules`).
  // A plain `add -A` in the fresh disposable repo would drop the tracked-but-
  // gitignored files (it has no history that marks them tracked); `add -A -f`
  // would over-include the agent cache and make reset-to-baseline revert it.
  // Staging the explicit ls-files pathspec (with -f to bypass the .gitignore the
  // fresh repo applies to every path) captures precisely the tracked set. A root
  // `.git` entry is never tracked, so the pointer file cannot leak in.
  const gitState = (args, opts = {}) =>
    git(args, { cwd: ctx.worktree, env: { ...process.env, GIT_DIR: stateGit, GIT_WORK_TREE: ctx.worktree }, ...opts });
  // Raw NUL-separated tracked list from the source's NATIVE git (no disposable
  // env, no trim — the pathspec stream is binary). git() would trim the trailing
  // NUL and hand back `out`, not the buffer we need here.
  const trackedRes = spawnSync('git', ['-C', ctx.worktree, 'ls-files', '-z'], { maxBuffer: 256 * 1024 * 1024 });
  if (trackedRes.status !== 0) {
    fail('baseline-repo', `git ls-files failed: ${firstLine(String(trackedRes.stderr || '')) || 'unknown error'}`);
  }
  const initSteps = [
    ['init', '-b', 'attach/work'],
    ['config', 'user.email', 'harness@attach'],
    ['config', 'user.name', 'harness'],
    ['config', 'commit.gpgsign', 'false'],
  ];
  const finalizeSteps = [
    ['commit', '-m', `attach baseline ${baseOid}`],
    ['tag', ATTACH_BASELINE_REF],
    ['config', 'core.worktree', '/workspace'],
  ];
  for (const args of initSteps) {
    const r = gitState(args);
    if (!r.ok) fail('baseline-repo', `git ${args.join(' ')} failed: ${firstLine(r.err) || firstLine(r.out) || 'unknown error'}`);
  }
  const add = gitState(['add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], {
    input: trackedRes.stdout,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (!add.ok) fail('baseline-repo', `git add (tracked set) failed: ${firstLine(add.err) || 'unknown error'}`);
  for (const args of finalizeSteps) {
    const r = gitState(args);
    if (!r.ok) fail('baseline-repo', `git ${args.join(' ')} failed: ${firstLine(r.err) || firstLine(r.out) || 'unknown error'}`);
  }
  const baseline = gitState(['rev-parse', '--verify', `${ATTACH_BASELINE_REF}^{commit}`]);
  if (!baseline.ok) fail('baseline-repo', `${ATTACH_BASELINE_REF} does not resolve: ${firstLine(baseline.err)}`);
  const baselineOid = firstLine(baseline.out);

  // Operator record. No lock semantics; nothing reads it at runtime; host paths
  // are fine here because control/ is never mounted.
  const record = {
    worktree: ctx.worktree,
    gitDir: ctx.gitDir,
    commonDir: ctx.commonDir,
    sourceToplevel: ctx.sourceToplevel,
    baseOid,
    baselineOid,
    profile: ctx.profile,
    service: ctx.service,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(control, 'attach.json'), `${JSON.stringify(record, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });

  return execCompose({
    args: ['compose', '--profile', ctx.profile, ...target.compose, ctx.service, ...passthroughArgs],
    env: {
      ...env,
      HARNESS_ATTACH_WORKTREE: ctx.worktree,
      HARNESS_ATTACH_STATE_DIR: ctx.stateDir,
      HARNESS_TARGET_MODE: 'attach',
      HARNESS_HOST_UID: env.HARNESS_HOST_UID,
      HARNESS_HOST_GID: env.HARNESS_HOST_GID,
    },
    cwd: DEMO_ROOT,
  });
}

/**
 * Restart the ACTIVE launch (the `.attach-launch.json` pointer) on its existing
 * worktree + state: full preflight minus the empty-state check, then
 * `docker compose up --build`. Continuation-preserving — the worktree keeps the
 * prior episodes' edits; only the image is rebuilt (e.g. new demo code). No
 * state layout, no baseline commit: both already exist from the original `run`.
 *
 * The compose topology has ONE active attach container per profile, so restart
 * always targets the active launch. To continue a DIFFERENT launch, point the
 * launch file at it (prepare or an explicit HARNESS_ATTACH_* override) first.
 */
export function restartLaunch(cmd, passthroughArgs, env, { execCompose = defaultExecCompose, mountinfoText } = {}) {
  env = resolveLaunchEnv(env);
  if (env._launchName) console.error(`attach restart: active launch "${env._launchName}"`);
  const ctx = preflight(env, { cmd, mountinfoText, existingState: true });
  const target = ATTACH_TARGETS[cmd];
  return execCompose({
    args: ['compose', '--profile', ctx.profile, ...target.compose, ctx.service, ...passthroughArgs],
    env: {
      ...env,
      HARNESS_ATTACH_WORKTREE: ctx.worktree,
      HARNESS_ATTACH_STATE_DIR: ctx.stateDir,
      HARNESS_TARGET_MODE: 'attach',
      HARNESS_HOST_UID: env.HARNESS_HOST_UID,
      HARNESS_HOST_GID: env.HARNESS_HOST_GID,
    },
    cwd: DEMO_ROOT,
  });
}

/**
 * ADDITIVE launch preparation from a checkout path: a detached linked worktree
 * plus a fresh empty state dir, auto-named `<repo>-run-NNN` next to the
 * checkout's parent (`.repovine-harness-worktrees/` and `.repovine-harness-state/`), or under
 * `$HARNESS_ATTACH_ROOT/{worktrees,state}` when that is set. The one
 * source-side write is git's own worktree registration (`.git/worktrees/…`) —
 * inherent to `git worktree add`. Nothing is ever removed here: teardown stays
 * a manual operator action, same as before.
 */
export function prepareLaunch(checkoutPath, { base = 'HEAD', name } = {}, env = process.env) {
  assertLinuxHost();
  if (!checkoutPath) fail('prepare', 'checkout path is required: npm run attach -- prepare <checkout> [--base <ref>] [--name <run-name>]');
  let checkout;
  try {
    checkout = fs.realpathSync(path.resolve(String(checkoutPath)));
  } catch {
    fail('prepare', `checkout path does not resolve: ${checkoutPath}`);
  }
  const repoProbe = git(['-C', checkout, 'rev-parse', '--git-dir']);
  if (!repoProbe.ok) fail('prepare', `${checkout} is not a Git repository: ${firstLine(repoProbe.err)}`);

  const parent = path.dirname(checkout);
  // Placement: HARNESS_ATTACH_ROOT (one knob, .env-settable — main() loads the
  // demo .env before dispatch) or the checkout's parent by default.
  const attachRoot = env.HARNESS_ATTACH_ROOT ? path.resolve(String(env.HARNESS_ATTACH_ROOT)) : null;
  const wtRoot = attachRoot ? path.join(attachRoot, 'worktrees') : path.join(parent, '.repovine-harness-worktrees');
  const stRoot = attachRoot ? path.join(attachRoot, 'state') : path.join(parent, '.repovine-harness-state');

  let runName = name;
  if (runName) {
    if (fs.existsSync(path.join(wtRoot, runName)) || fs.existsSync(path.join(stRoot, runName))) {
      fail('prepare', `launch name "${runName}" already exists under ${wtRoot} or ${stRoot} — pick another or tear the old one down`);
    }
  } else {
    const repoBase = path.basename(checkout);
    for (let n = 1; n <= 999; n += 1) {
      const candidate = `${repoBase}-run-${String(n).padStart(3, '0')}`;
      if (!fs.existsSync(path.join(wtRoot, candidate)) && !fs.existsSync(path.join(stRoot, candidate))) {
        runName = candidate;
        break;
      }
    }
    if (!runName) fail('prepare', `no free run name under ${wtRoot} (001..999 taken) — tear old launches down`);
  }

  fs.mkdirSync(wtRoot, { recursive: true });
  fs.mkdirSync(stRoot, { recursive: true });
  const worktree = path.join(wtRoot, runName);
  const stateDir = path.join(stRoot, runName);

  // --detach: a base that names a currently-checked-out branch would otherwise
  // refuse ("already checked out"); the worktree is disposable, it needs no
  // source-side branch — promotion rides the disposable repo's attach/run-*.
  const add = git(['-C', checkout, 'worktree', 'add', '--detach', worktree, base]);
  if (!add.ok) fail('prepare', `git worktree add failed: ${firstLine(add.err) || firstLine(add.out)}`);
  fs.mkdirSync(stateDir); // fail-on-exist: the empty-state-per-launch rule starts here

  const baseOid = git(['-C', worktree, 'rev-parse', 'HEAD']);
  const prepared = { worktree, stateDir, name: runName, baseOid: baseOid.ok ? firstLine(baseOid.out) : null };
  // Current-launch pointer: preflight/run pick it up when the env vars are
  // unset, so a prepare→run pair needs no export step. The latest prepare wins.
  fs.writeFileSync(launchFilePath(env), `${JSON.stringify({ ...prepared, checkout, preparedAt: new Date().toISOString() }, null, 2)}\n`);
  return prepared;
}

const USAGE = `Usage:
  npm run attach -- prepare <checkout> [--base <ref>] [--name <run-name>]
  npm run attach -- preflight
  npm run attach -- run cli [args passed to the CLI entrypoint]
  npm run attach -- run http
  npm run attach -- run tg-bot
  npm run attach -- restart tg-bot        (rebuild image + restart the ACTIVE launch; keeps worktree)

prepare creates a detached linked worktree + empty state dir (auto-named
<repo>-run-NNN) and records it as the current launch in .attach-launch.json, so
preflight/run need no arguments after it. run starts a FRESH launch (empty
state); restart continues the ACTIVE launch on its existing worktree/state
(image rebuilt, prior episodes preserved) — one active attach container per
profile, so restart always targets the current launch. Placement: next to the checkout, or
under $HARNESS_ATTACH_ROOT/{worktrees,state} when set (.env works). Explicit
HARNESS_ATTACH_WORKTREE / HARNESS_ATTACH_STATE_DIR override the pointer;
HARNESS_HOST_UID/GID default to the launcher's own uid/gid. Teardown is manual: docker compose --profile
attach-<cmd> down, then remove the state dir and the worktree.`;

function main() {
  // Demo .env first, mirroring the sandbox entrypoints; inline env wins
  // (lib/env-file.mjs fills only unset/empty vars).
  loadEnvFile(path.join(DEMO_ROOT, '.env'));
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === 'prepare' && rest.length >= 1) {
      const flag = (nameArg) => {
        const i = rest.indexOf(nameArg);
        return i > 0 ? rest[i + 1] : undefined;
      };
      const prepared = prepareLaunch(rest[0], { base: flag('--base') ?? 'HEAD', name: flag('--name') });
      console.log(`attach prepare OK: ${prepared.name} @ ${prepared.baseOid ?? '?'}`);
      console.log(`  worktree: ${prepared.worktree}`);
      console.log(`  state:    ${prepared.stateDir}`);
      console.log('This launch is now the default; no exports needed. Next:');
      console.log('  npm run attach -- run cli --goal "…"   (or: run http | run tg-bot)');
      process.exit(0);
    }
    if (command === 'preflight' && rest.length === 0) {
      const ctx = preflight(process.env);
      console.log(`attach preflight OK: worktree=${ctx.worktree} state=${ctx.stateDir}`);
      process.exit(0);
    }
    if (command === 'run' && rest.length >= 1 && ATTACH_TARGETS[rest[0]]) {
      const target = rest[0];
      const passthrough = rest.slice(1);
      if (target !== 'cli' && passthrough.length > 0) {
        console.error(`attach run ${target} takes no extra arguments`);
        process.exit(2);
      }
      process.exit(runLaunch(target, passthrough, process.env));
    }
    if (command === 'restart' && rest.length >= 1 && ATTACH_TARGETS[rest[0]]) {
      const target = rest[0];
      const passthrough = rest.slice(1);
      if (target !== 'cli' && passthrough.length > 0) {
        console.error(`attach restart ${target} takes no extra arguments`);
        process.exit(2);
      }
      process.exit(restartLaunch(target, passthrough, process.env));
    }
  } catch (err) {
    console.error(err instanceof PreflightError ? err.message : `attach: ${err.message}`);
    process.exit(1);
  }
  console.error(USAGE);
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
