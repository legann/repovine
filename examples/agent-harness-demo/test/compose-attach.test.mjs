// Rendered Compose model for the attach profiles — the mount topology IS the
// filesystem isolation boundary, so the assertions are on the exact mount list.
// Skips cleanly when docker compose is unavailable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEMO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.realpathSync(os.tmpdir());

const composeOk = spawnSync('docker', ['compose', 'version'], { encoding: 'utf-8' }).status === 0;
const skip = !composeOk;

// Attach services live in compose.attach.yaml (overlay); attach profiles render
// with both files stacked, exactly as scripts/attach-launcher.mjs invokes them.
const ATTACH_FILES = ['-f', 'compose.yaml', '-f', 'compose.attach.yaml'];

function composeConfig(files, args, env) {
  return spawnSync('docker', ['compose', ...files, ...args], { cwd: DEMO_ROOT, encoding: 'utf-8', env });
}

function renderConfig(profile, env, { files = [] } = {}) {
  const r = composeConfig(files, ['--profile', profile, 'config', '--format', 'json'], env);
  assert.equal(r.status, 0, `docker compose --profile ${profile} config failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// Every long-form host bind sets create_host_path:false — a missing source fails
// closed rather than auto-creating a root-owned host dir.
function assertNoAutoCreate(vols, label) {
  for (const v of vols) {
    if (v.type !== 'bind') continue;
    assert.equal(v.bind?.create_host_path, false, `${label}: ${v.source} must set create_host_path:false`);
  }
}

function attachEnv() {
  const wt = fs.mkdtempSync(path.join(TMP, 'compose-wt-'));
  const st = fs.mkdtempSync(path.join(TMP, 'compose-st-'));
  return {
    wt,
    st,
    env: {
      ...process.env,
      HARNESS_ATTACH_WORKTREE: wt,
      HARNESS_ATTACH_STATE_DIR: st,
      HARNESS_HOST_UID: '1000',
      HARNESS_HOST_GID: '1000',
    },
    cleanup: () => {
      fs.rmSync(wt, { recursive: true, force: true });
      fs.rmSync(st, { recursive: true, force: true });
    },
  };
}

test('attach-cli renders exactly the attach mount set and hardened service shape', { skip }, () => {
  const { wt, st, env, cleanup } = attachEnv();
  try {
    const model = renderConfig('attach-cli', env, { files: ATTACH_FILES });
    const services = model.services;
    assert.ok(services['cli-attach'], 'cli-attach selected');
    assert.ok(services['egress-gw'], 'egress-gw selected (depends_on target)');
    assert.equal(services['workspace-init'], undefined, 'workspace-init is sandbox-only');

    const svc = services['cli-attach'];
    const vols = svc.volumes;
    assert.equal(vols.length, 6, `exactly 6 mounts, got: ${JSON.stringify(vols)}`);
    const expected = [
      [wt, '/workspace', false],
      [path.join(st, 'runtime/home'), '/state/home', false],
      [path.join(st, 'runtime/harness'), '/workspace/.harness', false],
      // Disposable repo: rw by design (sandbox-parity posture); the read-only
      // git-guard pointer is what keeps the agent from repointing /workspace/.git.
      [path.join(st, 'runtime/git'), '/state/git', false],
      [path.join(st, 'control/git-guard'), '/workspace/.git', true],
    ];
    for (const [source, target, ro] of expected) {
      const v = vols.find((x) => x.source === source);
      assert.ok(v, `missing mount for ${source}`);
      assert.equal(v.type, 'bind');
      assert.equal(v.target, target);
      assert.equal(Boolean(v.read_only), ro, `${source} read_only`);
    }
    const agents = vols.find((v) => String(v.target).endsWith('lib/agents'));
    assert.ok(agents, 'role-briefs mount kept');
    assert.equal(agents.read_only, true);
    assertNoAutoCreate(vols, 'cli-attach');

    // Only the single guard FILE from the state tree; parent/control/attach.json
    // never mounted; no sandbox workspace, docker.sock, SSH or $HOME.
    assert.ok(!vols.some((v) => v.source === st), 'state parent not mounted');
    assert.ok(!vols.some((v) => v.source === path.join(st, 'control')), 'control/ not mounted');
    assert.ok(!vols.some((v) => String(v.source).includes('attach.json')));
    assert.ok(!vols.some((v) => String(v.source).includes('.workspace')));
    assert.ok(!vols.some((v) => String(v.source).includes('docker.sock')));
    assert.ok(!vols.some((v) => String(v.source).includes('.ssh')));
    assert.ok(!vols.some((v) => v.source === os.homedir()), 'user HOME not mounted');

    assert.equal(svc.user, '1000:1000');
    assert.equal(svc.read_only, true);
    assert.equal(svc.network_mode, 'service:egress-gw');
    assert.deepEqual(svc.cap_drop, ['ALL']);
    assert.equal(svc.cap_add, undefined, 'no CHOWN or any other cap added');
    assert.deepEqual(Object.keys(svc.depends_on || {}), ['egress-gw'], 'attach never waits on workspace-init');

    assert.equal(svc.environment.HARNESS_TARGET_MODE, 'attach');
    assert.equal(svc.environment.HARNESS_REPO_ROOT, '/workspace');
    assert.equal(svc.environment.HOME, '/state/home');
  } finally {
    cleanup();
  }
});

test('attach-http and attach-tg-bot render their twin services with the same mount set', { skip }, () => {
  const { st, env, cleanup } = attachEnv();
  try {
    for (const [profile, name] of [
      ['attach-http', 'http-attach'],
      ['attach-tg-bot', 'tg-bot-attach'],
    ]) {
      const model = renderConfig(profile, env, { files: ATTACH_FILES });
      const svc = model.services[name];
      assert.ok(svc, `${name} selected by ${profile}`);
      assert.equal(model.services['workspace-init'], undefined);
      assert.equal(svc.volumes.length, 6);
      assertNoAutoCreate(svc.volumes, name);
      const gitMount = svc.volumes.find((v) => v.target === '/state/git');
      assert.ok(gitMount, `${name} mounts the disposable repo`);
      assert.equal(gitMount.source, path.join(st, 'runtime/git'));
      assert.equal(Boolean(gitMount.read_only), false, '/state/git is rw');
      assert.equal(svc.environment.HARNESS_TARGET_MODE, 'attach');
      assert.equal(svc.environment.HOME, '/state/home');
      assert.ok(svc.healthcheck, `${name} keeps its sandbox twin's healthcheck`);
    }
    // Pin the knob explicitly: `docker compose config` reads the demo .env for
    // unset interpolations, so an operator's local HARNESS_HTTP_PORT must not
    // decide this assertion.
    const httpModel = renderConfig('attach-http', { ...env, HARNESS_HTTP_PORT: '18099' }, { files: ATTACH_FILES });
    assert.equal(httpModel.services['http-attach'].environment.PORT, '18099');
  } finally {
    cleanup();
  }
});

test('sandbox regression: --profile cli renders with NO attach env vars set', { skip }, () => {
  const env = { ...process.env };
  delete env.HARNESS_ATTACH_WORKTREE;
  delete env.HARNESS_ATTACH_STATE_DIR;
  delete env.HARNESS_HOST_UID;
  delete env.HARNESS_HOST_GID;

  const model = renderConfig('cli', env);
  assert.ok(model.services.cli);
  assert.ok(model.services['workspace-init'], 'sandbox init unchanged');
  assert.ok(model.services['egress-gw']);
  assert.equal(model.services['cli-attach'], undefined);
  assert.equal(model.services['harness-base'], undefined, 'the extends skeleton is never selected');
  assert.ok(
    model.services.cli.volumes.some((v) => String(v.target).endsWith('/.workspace')),
    'sandbox workspace mount intact',
  );
  assertNoAutoCreate(model.services.cli.volumes, 'cli');

  // workspace-init: the HARNESS_UID/GID knobs are wired (were dead config), and
  // its own binds also fail closed on a missing source.
  const init = model.services['workspace-init'];
  assert.equal(init.environment.HARNESS_UID, '1000');
  assert.equal(init.environment.HARNESS_GID, '1000');
  assertNoAutoCreate(init.volumes, 'workspace-init');
  // Content assertions, not presence-only: the attach services merge the shared
  // x-harness-app/x-harness-env anchors, so anchor drift would surface here.
  const cli = model.services.cli;
  assert.equal(cli.read_only, true);
  assert.deepEqual(cli.cap_drop, ['ALL']);
  assert.equal(cli.user, undefined, 'sandbox runs as the image user, no uid override');
  assert.equal(cli.network_mode, 'service:egress-gw');
  assert.deepEqual(Object.keys(cli.depends_on || {}).sort(), ['egress-gw', 'workspace-init']);
  assert.equal(cli.environment.HARNESS_TARGET_MODE, undefined, 'sandbox services never set the mode');
  assert.equal(cli.environment.REPOVINE_CLI, '/app/repovine/dist/mcp/index.js');
  assert.match(cli.environment.HOME, /\.workspace\/\.harness-home$/);
  assert.equal(cli.environment.REPOVINE_IN_DOCKER, '1');
});

test('bypass gate: attach profile on the main file alone selects no service', { skip }, () => {
  // Attach lives only in the overlay, so a bare `--profile attach-cli` (no `-f`
  // pair) starts nothing — the pre-overlay bypass is structurally impossible.
  const { env, cleanup } = attachEnv();
  try {
    const r = composeConfig([], ['--profile', 'attach-cli', 'config', '--services'], env);
    assert.equal(r.status, 0, `config failed: ${r.stderr}`);
    assert.equal(r.stdout.trim(), '', 'no service selected from the main file alone');
  } finally {
    cleanup();
  }
});

test('fail-closed: stacked attach render without HARNESS_ATTACH_* exits non-zero', { skip }, () => {
  const env = { ...process.env };
  delete env.HARNESS_ATTACH_WORKTREE;
  delete env.HARNESS_ATTACH_STATE_DIR;
  const r = composeConfig(ATTACH_FILES, ['--profile', 'attach-cli', 'config'], env);
  assert.notEqual(r.status, 0, 'unset attach vars must fail the render');
  assert.match(r.stderr, /required variable/, 'compose names the missing required variable');
});

test('anchor parity: cli-attach inherits the sandbox hardening via extends', { skip }, () => {
  // The extends restructure must not drift the shared ceilings/hardening. Render
  // sandbox cli and attach-cli, compare the inherited fields byte-for-byte.
  const { env, cleanup } = attachEnv();
  try {
    const sandbox = renderConfig('cli', env).services.cli;
    const attach = renderConfig('attach-cli', env, { files: ATTACH_FILES }).services['cli-attach'];
    assert.equal(attach.mem_limit, sandbox.mem_limit);
    assert.equal(attach.pids_limit, sandbox.pids_limit);
    assert.deepEqual(attach.tmpfs, sandbox.tmpfs);
    assert.deepEqual(attach.security_opt, sandbox.security_opt);
    assert.deepEqual(attach.cap_drop, sandbox.cap_drop);
    assert.equal(attach.cap_add, undefined);
    assert.equal(attach.read_only, sandbox.read_only);
    assert.equal(attach.network_mode, sandbox.network_mode);
  } finally {
    cleanup();
  }
});
