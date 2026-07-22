// Unsupported-platform diagnostics: each gate fails early, names its check,
// and states the supported route. Platform is faked via the writable
// process.platform descriptor; every test restores it. Launch-pointer env is
// pinned to a nonexistent file so a stray .attach-launch.json on a dev
// machine never leaks into these tests (same pattern as attach-launcher.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

import { PreflightError, preflight, prepareLaunch } from '../scripts/attach-launcher.mjs';
import { getWorker } from '../lib/workers/index.mjs';
import { runAgent } from '../lib/workers/local.mjs';

const NO_LAUNCH_ENV = {
  HARNESS_ATTACH_LAUNCH_FILE: path.join(os.tmpdir(), 'no-such-launch.json'),
};

const withPlatform = (platform, fn) => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  return Promise.resolve()
    .then(fn)
    .finally(() => Object.defineProperty(process, 'platform', original));
};

const failsPlatform = (fn, extra = /./) =>
  assert.throws(
    fn,
    (e) => e instanceof PreflightError && e.check === 'platform' && /WSL2/.test(e.message) && extra.test(e.message),
  );

test('attach preflight fails closed on macOS before any other check', async () => {
  await withPlatform('darwin', () => {
    failsPlatform(() => preflight(NO_LAUNCH_ENV, {}), /security design/);
  });
});

test('attach preflight fails closed on native Windows with the WSL2 route', async () => {
  await withPlatform('win32', () => {
    failsPlatform(() => preflight(NO_LAUNCH_ENV, {}));
  });
});

test('attach prepare fails closed on a non-Linux host before creating anything', async () => {
  await withPlatform('darwin', () => {
    failsPlatform(() => prepareLaunch('/no/such/checkout', {}, NO_LAUNCH_ENV));
  });
});

test('attach preflight on linux proceeds past the platform gate', async () => {
  // Empty env on linux must fail on the NEXT check (attach-env), proving the
  // platform gate passed and check ordering is platform → env.
  await withPlatform('linux', () => {
    assert.throws(
      () => preflight(NO_LAUNCH_ENV, {}),
      (e) => e instanceof PreflightError && e.check === 'attach-env',
    );
  });
});

test('worker dispatch refuses native Windows host mode', async () => {
  await withPlatform('win32', () => {
    assert.throws(() => getWorker('claude'), /host mode is unsupported on native Windows.*(?:WSL2|Docker sandbox)/);
    assert.throws(() => getWorker('local'), /host mode is unsupported on native Windows/);
  });
});

test('local worker run refuses native Windows host mode with the supported route', async () => {
  await withPlatform('win32', async () => {
    await assert.rejects(
      () => runAgent({ task: 'noop' }, {}, process.cwd()),
      /host mode is unsupported on native Windows.*(?:WSL2|Docker sandbox)/,
    );
  });
});
