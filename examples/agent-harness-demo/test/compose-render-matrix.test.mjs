// Config-render matrix: every compose profile is rendered against hostile host
// paths, asserting the rendered mount model — no container starts. The render is
// the contract: `docker compose config` must accept the path and place it at the
// expected mount source verbatim, so a host path with spaces, non-ASCII bytes, or
// a Windows drive-letter cannot silently shift or drop a bind at render time.
//
// The renderConfig/skip-guard helpers are copied from compose-attach.test.mjs on
// purpose. compose-attach.test.mjs asserts the attach security boundary; this file
// only READS the same compose.yaml/compose.attach.yaml and must add zero diff to
// that surface, so it duplicates the ~10-line helper instead of sharing a module.
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

const ATTACH_FILES = ['-f', 'compose.yaml', '-f', 'compose.attach.yaml'];

// Dummy attach vars so `--profiles` enumeration over the stacked overlay does not
// fail interpolation (attach volume sources reference these required variables).
const ENUM_ATTACH_ENV = {
  ...process.env,
  HARNESS_ATTACH_WORKTREE: path.join(TMP, 'enum-wt'),
  HARNESS_ATTACH_STATE_DIR: path.join(TMP, 'enum-st'),
  HARNESS_HOST_UID: '1000',
  HARNESS_HOST_GID: '1000',
};

function compose(files, args, env) {
  return spawnSync('docker', ['compose', ...files, ...args], { cwd: DEMO_ROOT, encoding: 'utf-8', env });
}

function renderConfig(profile, env, { files = [] } = {}) {
  const r = compose(files, ['--profile', profile, 'config', '--format', 'json'], env);
  assert.equal(r.status, 0, `docker compose --profile ${profile} config failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// The full profile set across the base file and the attach overlay. Enumerated so
// a newly added profile trips the equality assertion below until the matrix names
// how to render it. `harness-base` is the inert extends skeleton (compose.yaml):
// it is never selected in a real run and does not render standalone because it
// depends on egress-gw, which its own profile excludes.
const SANDBOX_PROFILES = ['cli', 'http', 'tg-bot'];
const ATTACH_PROFILES = { 'attach-cli': 'cli-attach', 'attach-http': 'http-attach', 'attach-tg-bot': 'tg-bot-attach' };
const SKELETON_PROFILES = ['harness-base'];
const KNOWN_PROFILES = [...SANDBOX_PROFILES, ...Object.keys(ATTACH_PROFILES), ...SKELETON_PROFILES].sort();

const ATTACH_SERVICE_NAMES = new Set(Object.values(ATTACH_PROFILES));
const WORKSPACE_TARGET = '/app/repovine/examples/agent-harness-demo/.workspace';

// Hostile host-path fixtures. A/B are real dirs; C is render-only — a Windows
// drive-letter string that never becomes a directory on this Linux host. Its real
// mount semantics on Windows Docker Desktop stay a MANUAL check (see
// docs/usage.md "Platform support"); this asserts only that render does not mangle
// or reject the string.
function fixtures() {
  const plain = fs.mkdtempSync(path.join(TMP, 'compose-mx-'));
  const uni = path.join(fs.mkdtempSync(path.join(TMP, 'compose-mx-')), 'space-üñï', 'sub');
  fs.mkdirSync(uni, { recursive: true });
  const cases = [
    { label: 'plain', dir: plain },
    { label: 'space+unicode', dir: uni },
    { label: 'drive-letter (render-only)', dir: 'C:\\Users\\dev\\wt' },
  ];
  const cleanup = () => {
    fs.rmSync(plain, { recursive: true, force: true });
    fs.rmSync(path.dirname(path.dirname(uni)), { recursive: true, force: true });
  };
  return { cases, cleanup };
}

function sandboxEnv(dir) {
  const env = { ...process.env, HARNESS_WORKSPACE_DIR: dir };
  delete env.HARNESS_ATTACH_WORKTREE;
  delete env.HARNESS_ATTACH_STATE_DIR;
  delete env.HARNESS_HOST_UID;
  delete env.HARNESS_HOST_GID;
  return env;
}

function attachEnv(dir) {
  return {
    ...process.env,
    HARNESS_ATTACH_WORKTREE: dir,
    HARNESS_ATTACH_STATE_DIR: dir,
    HARNESS_HOST_UID: '1000',
    HARNESS_HOST_GID: '1000',
  };
}

test('profile set is exactly the known matrix — a new profile fails until named', { skip }, () => {
  const r = compose(ATTACH_FILES, ['config', '--profiles'], ENUM_ATTACH_ENV);
  assert.equal(r.status, 0, `--profiles failed: ${r.stderr}`);
  const profiles = r.stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean).sort();
  assert.deepEqual(
    profiles,
    KNOWN_PROFILES,
    'compose profile set changed: add the new profile to SANDBOX_PROFILES, ATTACH_PROFILES, or SKELETON_PROFILES and give it a fixture cell before this passes',
  );
});

test('sandbox profiles render each hostile workspace path verbatim', { skip }, () => {
  const { cases, cleanup } = fixtures();
  try {
    for (const profile of SANDBOX_PROFILES) {
      for (const { label, dir } of cases) {
        const model = renderConfig(profile, sandboxEnv(dir));
        const svc = model.services[profile];
        assert.ok(svc, `${profile}/${label}: service selected`);
        assert.ok(model.services['egress-gw'], `${profile}/${label}: egress-gw present`);
        for (const name of ATTACH_SERVICE_NAMES) {
          assert.equal(model.services[name], undefined, `${profile}/${label}: no attach service ${name}`);
        }

        const ws = svc.volumes.find((v) => v.target === WORKSPACE_TARGET);
        assert.ok(ws, `${profile}/${label}: workspace bind present`);
        assert.equal(ws.type, 'bind');
        assert.equal(ws.source, dir, `${profile}/${label}: workspace source is the fixture verbatim`);
        assert.equal(ws.target, WORKSPACE_TARGET, `${profile}/${label}: target unaffected by source`);
        assert.equal(ws.bind?.create_host_path, false, `${profile}/${label}: fails closed on missing source`);
      }
    }
  } finally {
    cleanup();
  }
});

test('attach profiles render each hostile state path verbatim', { skip }, () => {
  const { cases, cleanup } = fixtures();
  try {
    for (const [profile, service] of Object.entries(ATTACH_PROFILES)) {
      for (const { label, dir } of cases) {
        const model = renderConfig(profile, attachEnv(dir), { files: ATTACH_FILES });
        const svc = model.services[service];
        assert.ok(svc, `${profile}/${label}: ${service} selected`);
        assert.ok(model.services['egress-gw'], `${profile}/${label}: egress-gw present`);
        assert.equal(model.services['workspace-init'], undefined, `${profile}/${label}: attach never selects workspace-init`);

        const worktree = svc.volumes.find((v) => v.target === '/workspace');
        assert.ok(worktree, `${profile}/${label}: worktree bind present`);
        assert.equal(worktree.source, dir, `${profile}/${label}: worktree source is the fixture verbatim`);

        // State-derived binds append a fixed suffix to the same fixture. path.join
        // reproduces the compose `${DIR}/runtime/...` interpolation for all three
        // fixtures because backslashes are literal path bytes on this host.
        for (const [target, suffix] of [
          ['/state/home', path.join('runtime', 'home')],
          ['/state/git', path.join('runtime', 'git')],
          ['/workspace/.harness', path.join('runtime', 'harness')],
          ['/workspace/.git', path.join('control', 'git-guard')],
        ]) {
          const v = svc.volumes.find((x) => x.target === target);
          assert.ok(v, `${profile}/${label}: bind for ${target} present`);
          assert.equal(v.source, path.join(dir, suffix), `${profile}/${label}: ${target} source derives from the fixture`);
        }
      }
    }
  } finally {
    cleanup();
  }
});

test('harness-base is the inert skeleton — never selectable standalone', { skip }, () => {
  // It carries a depends_on on egress-gw but its own profile excludes egress-gw,
  // so a standalone render is an invalid project. This is why it takes no fixture
  // cell; it exists only for the attach overlay's `extends`.
  const r = compose([], ['--profile', 'harness-base', 'config'], process.env);
  assert.notEqual(r.status, 0, 'harness-base must not render as a standalone project');
});
