// Host-path render matrix: hostile source values (spaces, Unicode, a colon in
// the name, Windows drive letters) must reach the rendered Compose model VERBATIM
// — long-form binds treat `source:` as an opaque scalar, so no colon split and no
// drive-letter mangling occur. Render-only (never `up`), so Windows-style fixtures
// render fine on Linux CI; `docker compose config` does not stat sources. Skips
// cleanly when docker compose is unavailable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEMO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ATTACH_FILES = ['-f', 'compose.yaml', '-f', 'compose.attach.yaml'];

const composeOk = spawnSync('docker', ['compose', 'version'], { encoding: 'utf-8' }).status === 0;
const skip = !composeOk;

function render(files, profile, env) {
  const r = spawnSync('docker', ['compose', ...files, '--profile', profile, 'config', '--format', 'json'], {
    cwd: DEMO_ROOT,
    encoding: 'utf-8',
    env,
  });
  assert.equal(r.status, 0, `docker compose --profile ${profile} config failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// Verified by hand on docker compose v5.1.4: each value survives interpolation
// and long-form binding unchanged.
const HOSTILE = [
  ['absolute with space', '/tmp/host path/ws'],
  ['absolute Unicode', '/tmp/пап ка/проект'],
  ['colon in the name', '/tmp/a:b/c'],
  ['Windows drive with space', 'C:\\Users\\dev\\my proj'],
  ['forward-slash drive', 'C:/Users/dev/proj'],
];

function findByTarget(vols, target) {
  const v = vols.find((x) => x.target === target);
  assert.ok(v, `no mount for target ${target}`);
  return v;
}

for (const [label, value] of HOSTILE) {
  test(`sandbox cli carries a ${label} workspace source verbatim`, { skip }, () => {
    const env = {
      ...process.env,
      HARNESS_WORKSPACE_DIR: value,
      HARNESS_AGENTS_HOST_DIR: value,
    };
    const cli = render([], 'cli', env).services.cli;
    const ws = findByTarget(cli.volumes, '/app/repovine/examples/delivery-protocol-harness-demo/.workspace');
    assert.equal(ws.source, value, 'workspace source unchanged: no resolution, no split');
    assert.notEqual(ws.bind?.create_host_path, true);
    const agents = cli.volumes.find((v) => String(v.target).endsWith('lib/agents'));
    assert.equal(agents.source, value, 'agents source unchanged');
    assert.notEqual(agents.bind?.create_host_path, true);
  });

  test(`attach cli carries a ${label} worktree source verbatim`, { skip }, () => {
    const env = {
      ...process.env,
      HARNESS_ATTACH_WORKTREE: value,
      HARNESS_ATTACH_STATE_DIR: value,
      HARNESS_HOST_UID: '1000',
      HARNESS_HOST_GID: '1000',
    };
    const svc = render(ATTACH_FILES, 'attach-cli', env).services['cli-attach'];
    const wt = findByTarget(svc.volumes, '/workspace');
    assert.equal(wt.source, value, 'worktree source unchanged: no resolution, no split');
    assert.notEqual(wt.bind?.create_host_path, true);
    // The state dir is suffixed inside the bind source; the prefix stays verbatim.
    const home = findByTarget(svc.volumes, '/state/home');
    assert.equal(home.source, `${value}/runtime/home`, 'state prefix unchanged, suffix appended');
    assert.notEqual(home.bind?.create_host_path, true);
  });
}
