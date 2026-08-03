// scripts/compose.mjs contract: structured argv per subcommand (the literal `*`
// and the `-f` pair on `down` are the host-neutrality fixes), workspace pre-create,
// host-path normalization, and dummy attach env scoped to `down`. No docker is
// started — runCompose gets an injected exec seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { planCompose, runCompose, normalizeHostPaths, workspaceHostDir } from '../scripts/compose.mjs';

const DEMO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.realpathSync(os.tmpdir());

const cap = () => {
  const calls = [];
  return { exec: (c) => (calls.push(c), 0), calls };
};

test('cli: profile run --rm --build, workspace pre-created, no dummy attach env', () => {
  const ws = fs.mkdtempSync(path.join(TMP, 'wrap-ws-'));
  fs.rmSync(ws, { recursive: true, force: true }); // ensure runCompose creates it
  const { exec, calls } = cap();
  const code = runCompose('cli', ['--goal', 'x'], { HARNESS_WORKSPACE_DIR: ws }, { exec });
  assert.equal(code, 0);
  assert.deepEqual(calls[0].args, ['compose', '--profile', 'cli', 'run', '--rm', '--build', 'cli', '--goal', 'x']);
  assert.equal(calls[0].cwd, DEMO_ROOT);
  assert.ok(fs.existsSync(ws), 'workspace dir pre-created by the wrapper');
  assert.equal(calls[0].env.HARNESS_ATTACH_WORKTREE, undefined, 'no dummy attach env on cli');
  fs.rmSync(ws, { recursive: true, force: true });
});

test('http and tg-bot: up -d --build their service', () => {
  for (const [cmd, svc] of [['http', 'http'], ['tg-bot', 'tg-bot']]) {
    const plan = planCompose(cmd, [], { HARNESS_WORKSPACE_DIR: '/tmp/ws' });
    assert.deepEqual(plan.args, ['compose', '--profile', cmd, 'up', '-d', '--build', svc]);
    assert.equal(plan.workspaceDir, '/tmp/ws');
  }
});

test('down: stacks both files, literal * profile, --remove-orphans, dummy attach env', () => {
  const plan = planCompose('down', [], {});
  assert.deepEqual(plan.args, [
    'compose',
    '-f',
    'compose.yaml',
    '-f',
    'compose.attach.yaml',
    '--profile',
    '*',
    'down',
    '--remove-orphans',
  ]);
  assert.equal(plan.workspaceDir, null, 'down pre-creates nothing');
  assert.equal(plan.env.HARNESS_ATTACH_WORKTREE, '/attach-unset');
  assert.equal(plan.env.HARNESS_ATTACH_STATE_DIR, '/attach-unset');
});

test('normalizeHostPaths: relative resolves against demo root, absolute untouched', () => {
  const out = normalizeHostPaths({
    HARNESS_WORKSPACE_DIR: './my ws',
    HARNESS_AGENTS_HOST_DIR: '/abs/agents',
  });
  assert.equal(out.HARNESS_WORKSPACE_DIR, path.join(DEMO_ROOT, 'my ws'));
  assert.equal(out.HARNESS_AGENTS_HOST_DIR, '/abs/agents', 'absolute value passes through');
});

test('normalizeHostPaths: an absolute value with spaces/colon is not mangled', () => {
  const value = '/tmp/a:b/c d';
  const out = normalizeHostPaths({ HARNESS_WORKSPACE_DIR: value });
  assert.equal(out.HARNESS_WORKSPACE_DIR, value);
});

test('workspaceHostDir: default is <demo>/.workspace', () => {
  assert.equal(workspaceHostDir({}), path.join(DEMO_ROOT, '.workspace'));
});

test('unknown subcommand throws', () => {
  assert.throws(() => planCompose('bogus', [], {}), /unknown compose subcommand/);
});
