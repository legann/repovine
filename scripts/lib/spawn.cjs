'use strict';
/**
 * Shell-neutral process helpers for maintainer scripts and test setup.
 *
 * Node children run under the current executable (`process.execPath`). npm runs
 * through its JS entrypoint under the same Node; a Windows install that ships
 * only `npm.cmd` falls back to the single registered ComSpec adapter (Node 22
 * refuses `.cmd` under `shell:false`). argv stays an array end to end — no
 * string-concatenated commands, no `sh -c`.
 *
 * CJS on purpose: `require`-able from test/jest.global-setup.cjs and
 * importable from ESM scripts/*.mjs. Production code (src/) never depends on
 * this module.
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** npm's JS entrypoint, or null when only a shim is installed. The static
 * candidates prefer the Node-bundled npm; a separately installed newer npm is
 * used only when npm itself set npm_execpath. */
function resolveNpmCli() {
  const candidates = [];
  // Set by npm for every script it runs; absent when a script is invoked
  // directly. Trust it only when it IS npm — yarn sets yarn.js and npx sets
  // npx-cli.js here, and running those with npm argv executes the wrong CLI
  // (`node npx-cli.js audit --json` would install and run a package named
  // `audit` from the registry).
  const fromEnv = process.env.npm_execpath;
  if (fromEnv && path.basename(fromEnv) === 'npm-cli.js') {
    candidates.push(fromEnv);
  }
  const nodeDir = path.dirname(process.execPath);
  candidates.push(
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows layout
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // POSIX layout
  );
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* unreadable candidate — keep looking */
    }
  }
  return null;
}

/** Last-resort adapter safety: reject args cmd.exe could reinterpret
 * (metacharacters and newlines — libuv leaves a newline-bearing arg unquoted,
 * where it splits the command). Call sites pass simple tokens and temp paths;
 * paths with spaces survive via libuv per-arg quoting, `%` in a path does not
 * (documented limitation of the .cmd-only fallback). */
function assertComSpecSafe(args) {
  for (const a of args) {
    if (/[&|<>^%"\r\n]/.test(String(a))) {
      throw new Error(`ComSpec adapter refuses argument with cmd metacharacters: ${a}`);
    }
  }
}

/** spawnSync npm with an argv array. Result shape = spawnSync's. */
function runNpm(args, options = {}) {
  const cli = resolveNpmCli();
  if (cli) return spawnSync(process.execPath, [cli, ...args], options);
  if (process.platform === 'win32') {
    // Registered ComSpec adapter — the one sanctioned shell path.
    assertComSpecSafe(args);
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args], options);
  }
  return spawnSync('npm', args, options);
}

/** runNpm that throws on failure and returns trimmed stdout. The thrown error
 * carries `.stderr`/`.status`, mirroring execFileSync's error surface. */
function npmOutput(args, options = {}) {
  const res = runNpm(args, { encoding: 'utf-8', ...options });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const err = new Error(`npm ${args.join(' ')} exited ${res.status}`);
    err.stderr = res.stderr;
    err.status = res.status;
    throw err;
  }
  return String(res.stdout ?? '').trim();
}

/** spawnSync the current Node with an argv array. */
function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, options);
}

/** runNode that throws on failure and returns trimmed stdout. The thrown error
 * carries `.stderr`/`.status`, mirroring execFileSync's error surface. */
function nodeOutput(args, options = {}) {
  const res = runNode(args, { encoding: 'utf-8', ...options });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const err = new Error(`node ${args.join(' ')} exited ${res.status}`);
    err.stderr = res.stderr;
    err.status = res.status;
    throw err;
  }
  return String(res.stdout ?? '').trim();
}

/** Async spawn of the current Node with an argv array. */
function spawnNode(args, options = {}) {
  return spawn(process.execPath, args, options);
}

module.exports = { resolveNpmCli, assertComSpecSafe, runNpm, npmOutput, runNode, nodeOutput, spawnNode };
