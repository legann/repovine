// Local-model forward (docker/egress-gw/proxy.mjs loopback pipe) behaviour.
//
// The gateway proxy exposes a fixed loopback address in the shared netns and pipes it to
// the host-side OpenAI-compatible model, so LOCAL_BASE_URL is one constant string. Tier 1
// drives proxy.mjs against a mock model with no Docker and no network. Tier 2 brings the
// real gateway up and proves the same reachability through the firewall.
//
// Tier 2 is opt-in: it brings up a container and needs host->container-gateway
// reachability, so plain `npm test` (and any machine without a Docker daemon)
// named-skips it. Set HARNESS_DOCKER_SMOKE=1 with a reachable daemon to run it;
// CI's harness-linux job does so via the `test:docker-smoke` script.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.resolve(HERE, '../docker/egress-gw/proxy.mjs');
const DEMO_ROOT = path.resolve(HERE, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

// Mock OpenAI-compatible server: GET /v1/models -> JSON list; POST /v1/chat/completions ->
// SSE chunks. `host` is 127.0.0.1 for tier 1 and 0.0.0.0 for tier 2 (container reaches it).
function startMockOpenAI(received, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({ url: req.url, method: req.method, body: Buffer.concat(chunks).toString('utf8') });
        if (req.url.startsWith('/v1/models')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen2.5-coder:32b', object: 'model' }] }));
        } else if (req.url.startsWith('/v1/chat/completions')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
          setTimeout(() => { res.write('data: [DONE]\n\n'); res.end(); }, 10);
        } else {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
        }
      });
    });
    server.listen(0, host, () => resolve(server));
  });
}

function waitHealth(port, deadline = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 400 }, (res) => { res.resume(); resolve(); });
      r.on('error', () => (Date.now() - t0 > deadline ? reject(new Error('proxy health timeout')) : setTimeout(tick, 80)));
      r.on('timeout', () => r.destroy());
    };
    tick();
  });
}

async function startProxy(env) {
  const [aPort, tPort, hPort, lPort] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  const proc = spawn(process.execPath, [PROXY], {
    env: {
      ...process.env,
      PROXY_ANTHROPIC_PORT: String(aPort), PROXY_TELEGRAM_PORT: String(tPort), PROXY_HEALTH_PORT: String(hPort),
      PROXY_LOCAL_PORT: String(lPort),
      ...env,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await waitHealth(hPort);
  return { proc, lPort };
}

function fwdReq(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers, timeout: 6000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('forward request timeout')));
    if (body) r.write(body);
    r.end();
  });
}

// ── Tier 1: no Docker, no network — proxy.mjs forward against a mock model ──

test('local endpoint (tier 1): /v1/models passes through unchanged', async () => {
  const received = [];
  const mock = await startMockOpenAI(received);
  const mockPort = mock.address().port;
  const { proc, lPort } = await startProxy({ LOCAL_UPSTREAM_HOST: '127.0.0.1', LOCAL_UPSTREAM_PORT: String(mockPort) });
  try {
    const r = await fwdReq(lPort, { path: '/v1/models' });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.data[0].id, 'qwen2.5-coder:32b');
    assert.ok(received.find((x) => x.url === '/v1/models'), 'mock model saw the forwarded request');
  } finally {
    proc.kill('SIGTERM');
    mock.close();
  }
});

test('local endpoint (tier 1): chat-completions SSE streams through', async () => {
  const received = [];
  const mock = await startMockOpenAI(received);
  const { proc, lPort } = await startProxy({ LOCAL_UPSTREAM_HOST: '127.0.0.1', LOCAL_UPSTREAM_PORT: String(mock.address().port) });
  try {
    const r = await fwdReq(lPort, {
      method: 'POST', path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' }, body: '{"model":"qwen2.5-coder:32b","stream":true}',
    });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'] || '', /text\/event-stream/);
    assert.match(r.body, /"content":"hi"/);
    assert.match(r.body, /\[DONE\]/);
  } finally {
    proc.kill('SIGTERM');
    mock.close();
  }
});

test('local endpoint (tier 1): upstream down — forward fails within the timeout guard', async () => {
  const deadPort = await freePort(); // allocated then released; nothing listens there
  const { proc, lPort } = await startProxy({ LOCAL_UPSTREAM_HOST: '127.0.0.1', LOCAL_UPSTREAM_PORT: String(deadPort) });
  try {
    const t0 = Date.now();
    await assert.rejects(fwdReq(lPort, { path: '/v1/models' }), 'forward connection is refused/torn down when the model is down');
    assert.ok(Date.now() - t0 < 6000, `forward failed in ${Date.now() - t0}ms (< 6s timeout guard)`);
  } finally {
    proc.kill('SIGTERM');
  }
});

// ── Tier 2: Docker-gated — the real gateway forwards to a host mock through the firewall ──

// Named-skip only when the flag is unset (plain `npm test`); with the flag set
// the test RUNS and a missing daemon is asserted inside, so an explicit
// container smoke reddens the gate instead of passing green.
const dockerSmokeSkip = process.env.HARNESS_DOCKER_SMOKE !== '1'
  ? 'tier 2 not run: set HARNESS_DOCKER_SMOKE=1 with a Docker daemon available'
  : false;

// Async on purpose: the mock model lives in THIS process, so a spawnSync exec
// would block the event loop and the mock could never answer the very request
// the exec'd curl is waiting on — every probe would time out against a healthy
// stack (and a fail-open denied-leg would go unnoticed for the same reason).
function dc(project, args, env) {
  return new Promise((resolve) => {
    const p = spawn('docker', ['compose', '-p', project, ...args], { cwd: DEMO_ROOT, env });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c) => { stdout += c; });
    p.stderr.on('data', (c) => { stderr += c; });
    p.on('error', (e) => resolve({ status: -1, stdout, stderr: `${stderr}\n${e.message}` }));
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('local endpoint (tier 2): gateway forwards loopback to the host model, default-deny intact',
  { skip: dockerSmokeSkip, timeout: 300000 }, async () => {
    assert.equal(
      spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status, 0,
      'HARNESS_DOCKER_SMOKE=1 but docker compose is not available',
    );
    // The worker runs with network_mode: service:egress-gw, so loopback reachability inside
    // the gateway container IS the worker's view of 127.0.0.1:11434 (the `-o lo ACCEPT` rule
    // is uid-agnostic). Testing from inside egress-gw therefore proves the worker's route.
    const project = `rv-local-${process.pid}`;
    const received = [];
    const mock = await startMockOpenAI(received, '0.0.0.0');
    const mockPort = mock.address().port;
    const httpPort = await freePort();
    const baseEnv = {
      ...process.env,
      LLM_PROVIDER: 'local',
      EGRESS_ALLOW_HOST_DOCKER_INTERNAL: '1',
      LOCAL_UPSTREAM_PORT: String(mockPort),
      EGRESS_SELF_TEST: '0',
      HARNESS_HTTP_PORT: String(httpPort),
    };
    try {
      // Build only the small alpine gateway image, never the heavy harness image.
      const up = await dc(project, ['--profile', 'cli', 'up', '-d', '--build', 'egress-gw'], baseEnv);
      assert.equal(up.status, 0, `gateway up failed: ${up.stderr}`);

      // Poll until the loopback forward resolves the mock model. Every probe is
      // time-bounded (--max-time) so a dropped forward leg cannot stall the
      // deadline loop on a hanging reply.
      let modelsBody = '';
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const r = await dc(project, ['--profile', 'cli', 'exec', '-T', 'egress-gw', 'curl', '-sf', '--max-time', '5', 'http://127.0.0.1:11434/v1/models'], baseEnv);
        if (r.status === 0) { modelsBody = r.stdout; break; }
        await new Promise((res) => setTimeout(res, 2000));
      }
      assert.ok(modelsBody, 'loopback forward never reached the host model (a host firewall dropping INPUT on the docker bridge would cause this)');
      assert.equal(JSON.parse(modelsBody).data[0].id, 'qwen2.5-coder:32b');
      assert.ok(received.find((x) => x.url === '/v1/models'), 'host mock recorded the forwarded request');

      // Default-deny still holds: an unlisted host is unreachable (DNS sinkhole, offline-safe).
      const blocked = await dc(project, ['--profile', 'cli', 'exec', '-T', 'egress-gw', 'curl', '-s', '--max-time', '3', 'https://example.com/'], baseEnv);
      assert.notEqual(blocked.status, 0, 'default-deny must block an unlisted destination');

      // Fail-closed leg: without the allow flag the forward leg is dropped and the mock stays quiet.
      const before = received.length;
      const recreate = await dc(project, ['--profile', 'cli', 'up', '-d', '--force-recreate', 'egress-gw'],
        { ...baseEnv, EGRESS_ALLOW_HOST_DOCKER_INTERNAL: '0' });
      assert.equal(recreate.status, 0, `gateway recreate failed: ${recreate.stderr}`);
      const denied = await dc(project, ['--profile', 'cli', 'exec', '-T', 'egress-gw', 'curl', '-sf', '--max-time', '8', 'http://127.0.0.1:11434/v1/models'],
        { ...baseEnv, EGRESS_ALLOW_HOST_DOCKER_INTERNAL: '0' });
      assert.notEqual(denied.status, 0, 'forward leg must be dropped when EGRESS_ALLOW_HOST_DOCKER_INTERNAL=0');
      // Let any in-flight (fail-open) request reach the mock's handlers before
      // asserting silence — the event loop is free here, so a leak WOULD land.
      await new Promise((res) => setTimeout(res, 500));
      assert.equal(received.length, before, 'the host mock must not be reached while the forward leg is denied');
    } finally {
      await dc(project, ['--profile', 'cli', 'down', '--remove-orphans', '-t', '2'], baseEnv);
      mock.close();
    }
  });
