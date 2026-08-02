#!/usr/bin/env node
// Host-neutral `docker compose` front end for the sandbox profiles. Structured
// argv (no shell), so the literal `*` in `down` and any path with spaces reach
// compose un-globbed on Linux, macOS, and Windows alike. npm scripts call this:
//
//   node scripts/compose.mjs cli [args passed to the CLI entrypoint]
//   node scripts/compose.mjs http
//   node scripts/compose.mjs tg-bot
//   node scripts/compose.mjs down
//
// Attach mode has its own entry (scripts/attach-launcher.mjs); this wrapper never
// touches the attach services except to tear them down via `down`.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEMO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Host-path overrides that name a workspace/agents source. Long-form binds carry
// the source verbatim (no colon split, no drive-letter mangling), so native
// absolute paths — including spaces, Unicode, or a `C:\…` drive letter — pass
// through unchanged. The only fix needed is resolving a relative value against
// the demo dir on the host where the path is native (a bare `.\workspace` would
// otherwise render as `<project>/.\workspace`).
const HOST_PATH_VARS = ['HARNESS_WORKSPACE_DIR', 'HARNESS_AGENTS_HOST_DIR'];

// `down` stacks the attach overlay so it also removes attach containers. The
// overlay's `${VAR:?}` bind sources must interpolate; `down` mounts nothing, so
// dummy values are safe and never create a directory.
const ATTACH_FILES = ['-f', 'compose.yaml', '-f', 'compose.attach.yaml'];
const DUMMY_ATTACH_ENV = {
  HARNESS_ATTACH_WORKTREE: '/attach-unset',
  HARNESS_ATTACH_STATE_DIR: '/attach-unset',
};

const SUBCOMMANDS = {
  cli: { args: ['compose', '--profile', 'cli', 'run', '--rm', '--build', 'cli'], workspace: true },
  http: { args: ['compose', '--profile', 'http', 'up', '-d', '--build', 'http'], workspace: true },
  'tg-bot': { args: ['compose', '--profile', 'tg-bot', 'up', '-d', '--build', 'tg-bot'], workspace: true },
  down: { args: ['compose', ...ATTACH_FILES, '--profile', '*', 'down', '--remove-orphans'], dummyAttach: true },
};

// Resolve relative workspace/agents overrides against the demo dir; leave
// absolute values (any host, any character) untouched.
export function normalizeHostPaths(env) {
  const out = { ...env };
  for (const key of HOST_PATH_VARS) {
    if (out[key]) out[key] = path.resolve(DEMO_ROOT, out[key]);
  }
  return out;
}

// Absolute host path of the sandbox workspace dir the wrapper pre-creates.
export function workspaceHostDir(env = process.env) {
  return path.resolve(DEMO_ROOT, env.HARNESS_WORKSPACE_DIR || '.workspace');
}

// Build the compose invocation for a subcommand: structured argv, the child env
// (normalized host paths, dummy attach env only on `down`), the cwd, and the
// workspace dir to pre-create (null when none).
export function planCompose(cmd, passthrough = [], baseEnv = process.env) {
  const spec = SUBCOMMANDS[cmd];
  if (!spec) throw new Error(`unknown compose subcommand ${JSON.stringify(cmd)}; expected cli | http | tg-bot | down`);
  let env = normalizeHostPaths(baseEnv);
  if (spec.dummyAttach) env = { ...env, ...DUMMY_ATTACH_ENV };
  return {
    args: [...spec.args, ...passthrough],
    env,
    cwd: DEMO_ROOT,
    workspaceDir: spec.workspace ? workspaceHostDir(env) : null,
  };
}

function defaultExec({ args, env, cwd }) {
  const r = spawnSync('docker', args, { cwd, env, stdio: 'inherit' });
  if (r.error) {
    console.error(`compose: docker failed to start: ${r.error.message}`);
    return 1;
  }
  return r.status === null ? 1 : r.status;
}

// Pre-create the workspace host dir as the invoking user (create_host_path:false
// no longer auto-creates it), then run compose. `exec` is the injectable seam so
// tests never start docker.
export function runCompose(cmd, passthrough, baseEnv = process.env, { exec = defaultExec } = {}) {
  const plan = planCompose(cmd, passthrough, baseEnv);
  if (plan.workspaceDir) fs.mkdirSync(plan.workspaceDir, { recursive: true });
  return exec({ args: plan.args, env: plan.env, cwd: plan.cwd });
}

function main() {
  const [cmd, ...passthrough] = process.argv.slice(2);
  if (!cmd || !SUBCOMMANDS[cmd]) {
    console.error('Usage: node scripts/compose.mjs <cli|http|tg-bot|down> [args]');
    process.exit(2);
  }
  process.exit(runCompose(cmd, passthrough, process.env));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
