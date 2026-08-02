// HTTP channel: bearer-auth gate (E2), /status telemetry withholding (A2), and the
// payload-too-large response actually reaching the client (B11). Starts a real
// server on a loopback ephemeral port with a stub graph (never invoked here — auth
// and body-size checks run before the graph).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startHttp } from '../lib/channels/http-adapter.mjs';
import { makeAttachWorkspace } from './fixtures/attach-workspace.mjs';

const stubGraph = { invoke: async () => ({ mode: 'single', ok: true, result: { status: 'complete' } }) };

async function withServer(token, fn, { provider = 'claude' } = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'http-'));
  const server = await startHttp({ graph: stubGraph, port: 0, host: '127.0.0.1', token, provider, repoRoot });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, repoRoot);
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

test('A2: /status withholds run telemetry without auth, includes it with auth', async () => {
  await withServer('secret', async (base) => {
    const anon = await fetch(`${base}/status`);
    assert.equal(anon.status, 200);
    const anonBody = await anon.json();
    assert.equal(anonBody.ok, true, 'liveness stays open for healthchecks');
    assert.equal('currentRun' in anonBody, false, 'run telemetry withheld without auth');

    const authed = await fetch(`${base}/status`, { headers: { authorization: 'Bearer secret' } });
    const authedBody = await authed.json();
    assert.equal('currentRun' in authedBody, true, 'run telemetry included with auth');
  });
});

test('goal is the outward surface: POST /goal accepts {"goal"}, missing body names "goal", /task+{"task"} stays accepted', async () => {
  await withServer('', async (base) => {
    // Missing body reports the outward field name.
    const missing = await fetch(`${base}/goal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /"goal"/, 'missing-field error names goal, not task');
    // Alias route + alias body key still parse to the same 400-on-empty semantics.
    const alias = await fetch(`${base}/task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"task":"   "}',
    });
    assert.equal(alias.status, 400);
    assert.match((await alias.json()).error, /"task"/, 'explicit task body key reports its own name');
  });
});

test('E2: POST /goal, /ask, /reset require the bearer token', async () => {
  await withServer('secret', async (base) => {
    for (const route of ['/goal', '/task', '/ask', '/reset']) {
      const res = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 401, `${route} without token → 401`);
    }
    // Wrong token is also rejected.
    const wrong = await fetch(`${base}/task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      body: '{"task":"x"}',
    });
    assert.equal(wrong.status, 401);
  });
});

test('B11: an over-limit body gets a 413 response, not a dropped socket', async () => {
  await withServer('secret', async (base) => {
    const huge = 'x'.repeat(1024 * 1024 + 64); // > 1 MiB MAX_BODY_BYTES
    const res = await fetch(`${base}/task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      body: `{"task":"${huge}"}`,
    });
    assert.equal(res.status, 413, 'payload-too-large reaches the client');
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /too large/i);
  });
});

test('open server (no token) still serves /status telemetry', async () => {
  await withServer('', async (base) => {
    const res = await fetch(`${base}/status`);
    const body = await res.json();
    assert.equal('currentRun' in body, true, 'no token configured → telemetry open (back-compat)');
  });
});

// ── attach target: baseline reset, status labeling ───────────────────────────

async function withAttachServer(fn) {
  const ws = makeAttachWorkspace();
  const repoRoot = ws.root;
  const server = await startHttp({
    graph: stubGraph,
    port: 0,
    host: '127.0.0.1',
    token: '',
    provider: 'claude',
    repoRoot,
    target: { mode: 'attach', repoRoot },
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, repoRoot);
  } finally {
    await new Promise((r) => server.close(r));
    ws.cleanup();
  }
}

test('attach: POST /reset requires confirm, then restores the launch baseline', async () => {
  await withAttachServer(async (base, repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'keep.txt'), 'agent-dirty\n');
    fs.writeFileSync(path.join(repoRoot, 'junk.txt'), 'x\n');

    const bare = await fetch(`${base}/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(bare.status, 400, 'destructive reset still requires {"confirm":true}');
    assert.equal(fs.readFileSync(path.join(repoRoot, 'keep.txt'), 'utf8'), 'agent-dirty\n');

    const res = await fetch(`${base}/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"confirm":true}',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(fs.readFileSync(path.join(repoRoot, 'keep.txt'), 'utf8'), 'baseline\n', 'baseline restored');
    assert.ok(!fs.existsSync(path.join(repoRoot, 'junk.txt')), 'untracked junk cleaned');
  });
});

test('attach: /status names the target mode and reset capability, not "shared sandbox"', async () => {
  await withAttachServer(async (base, repoRoot) => {
    const res = await fetch(`${base}/status`);
    const body = await res.json();
    assert.equal(body.targetMode, 'attach');
    assert.equal(body.resetAllowed, true, 'Phase 2: baseline reset is available');
    assert.equal(body.workspace, repoRoot, 'open server exposes the workspace path (no token back-compat)');
  });
});

test('sandbox: /status keeps resetAllowed true and sandbox target labeling', async () => {
  await withServer('', async (base) => {
    const res = await fetch(`${base}/status`);
    const body = await res.json();
    assert.equal(body.targetMode, 'sandbox');
    assert.equal(body.resetAllowed, true);
  });
});

test('sandbox: POST /ask lazily re-seeds the workspace emptied by POST /reset', async () => {
  await withServer('', async (base, repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'keep.txt'), 'remove me\n');

    const reset = await fetch(`${base}/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"confirm":true}',
    });
    assert.equal(reset.status, 200);
    assert.deepEqual(fs.readdirSync(repoRoot), [], 'reset leaves the sandbox empty');

    const ask = await fetch(`${base}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"question":"inspect the reset workspace"}',
    });
    assert.equal(ask.status, 502, 'unsupported provider stops after workspace initialization');
    assert.match((await ask.json()).error, /unsupported LLM_PROVIDER/);
    assert.ok(fs.existsSync(path.join(repoRoot, 'repovine.config.json')));
    assert.ok(fs.existsSync(path.join(repoRoot, 'repovine.annots.json')));
    assert.ok(fs.existsSync(path.join(repoRoot, '.git')), '/ask restored a usable sandbox cwd');
    assert.ok(!fs.existsSync(path.join(repoRoot, 'keep.txt')), 'initialization never restores reset user files');
  }, { provider: 'unsupported-test-provider' });
});
