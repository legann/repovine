// Credential-custody egress proxy (docker/egress-gw/proxy.mjs) security contract.
//
// Drives the proxy against a local mock upstream (no real secrets / no network) and
// asserts the WS-A/WS-B invariants: the real credential is injected and the placeholder
// never subAgents; SSE streams through; every outbound Telegram chat_id/from_chat_id is
// pinned to the recipient allow-list for ANY method (fail-closed), across JSON,
// urlencoded and multipart bodies; read-only methods and file downloads pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROXY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docker/egress-gw/proxy.mjs');

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

function startMock(received) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        if (req.url.startsWith('/v1/messages')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('event: message_start\ndata: {}\n\n');
          setTimeout(() => res.write('event: content_block_delta\ndata: {"delta":{"text":"hi"}}\n\n'), 10);
          setTimeout(() => { res.write('event: message_stop\ndata: {}\n\n'); res.end(); }, 20);
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
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
  const [aPort, tPort, hPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const proc = spawn(process.execPath, [PROXY], {
    env: {
      ...process.env,
      PROXY_ANTHROPIC_PORT: String(aPort), PROXY_TELEGRAM_PORT: String(tPort), PROXY_HEALTH_PORT: String(hPort),
      ...env,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await waitHealth(hPort);
  return { proc, aPort, tPort, hPort };
}

function req(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const UPSTREAM = (mockPort) => ({
  ANTHROPIC_UPSTREAM_HOST: '127.0.0.1', ANTHROPIC_UPSTREAM_PORT: String(mockPort), ANTHROPIC_UPSTREAM_INSECURE: '1',
  TELEGRAM_UPSTREAM_HOST: '127.0.0.1', TELEGRAM_UPSTREAM_PORT: String(mockPort), TELEGRAM_UPSTREAM_INSECURE: '1',
});

test('egress proxy: anthropic OAuth injection + placeholder strip + SSE streaming', async () => {
  const received = [];
  const mock = await startMock(received);
  const mockPort = mock.address().port;
  const { proc, aPort } = await startProxy({ ...UPSTREAM(mockPort), CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-SECRET' });
  try {
    const r = await req(aPort, {
      method: 'POST', path: '/v1/messages?beta=true',
      headers: { 'content-type': 'application/json', authorization: 'Bearer placeholder', 'x-api-key': 'leak?' },
      body: '{"model":"claude"}',
    });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'] || '', /text\/event-stream/);
    assert.match(r.body, /message_start/);
    assert.match(r.body, /"text":"hi"/);
    const up = received.find((x) => x.url.startsWith('/v1/messages'));
    assert.equal(up.headers.authorization, 'Bearer real-oauth-SECRET');
    assert.equal(up.headers['x-api-key'], undefined);
    assert.ok(!JSON.stringify(up.headers).includes('placeholder'));
  } finally {
    proc.kill('SIGTERM');
    mock.close();
  }
});

test('egress proxy: anthropic API-key mode injects x-api-key, strips authorization', async () => {
  const received = [];
  const mock = await startMock(received);
  const { proc, aPort } = await startProxy({ ...UPSTREAM(mock.address().port), ANTHROPIC_API_KEY: 'real-key-SECRET' });
  try {
    const r = await req(aPort, {
      method: 'POST', path: '/v1/messages',
      headers: { 'content-type': 'application/json', 'x-api-key': 'placeholder' }, body: '{}',
    });
    assert.equal(r.status, 200);
    const up = received.find((x) => x.url.startsWith('/v1/messages'));
    assert.equal(up.headers['x-api-key'], 'real-key-SECRET');
    assert.equal(up.headers.authorization, undefined);
  } finally {
    proc.kill('SIGTERM');
    mock.close();
  }
});

test('egress proxy: Telegram recipient pinning across encodings + token injection', async () => {
  const received = [];
  const mock = await startMock(received);
  const { proc, tPort } = await startProxy({
    ...UPSTREAM(mock.address().port),
    TELEGRAM_BOT_TOKEN: 'real-bot-SECRET', TELEGRAM_RECIPIENT_IDS: '111,-100222',
  });
  const drain = () => received.splice(0);
  try {
    // allowed recipient (JSON) → forwarded with real token in the path
    drain();
    let r = await req(tPort, { method: 'POST', path: '/botPH/sendMessage', headers: { 'content-type': 'application/json' }, body: '{"chat_id":111,"text":"hi"}' });
    assert.equal(r.status, 200);
    assert.equal(received[0].url, '/botreal-bot-SECRET/sendMessage');

    // foreign chat_id (JSON) → 403, upstream untouched
    drain();
    r = await req(tPort, { method: 'POST', path: '/botPH/sendMessage', headers: { 'content-type': 'application/json' }, body: '{"chat_id":999,"text":"x"}' });
    assert.equal(r.status, 403);
    assert.equal(received.length, 0);

    // multipart sendDocument to a foreign chat (file exfil) → blocked before upstream
    drain();
    const b = '----X';
    const mp = `--${b}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n888\r\n--${b}\r\nContent-Disposition: form-data; name="document"; filename="s.txt"\r\n\r\nSECRET\r\n--${b}--\r\n`;
    r = await req(tPort, { method: 'POST', path: '/botPH/sendDocument', headers: { 'content-type': `multipart/form-data; boundary=${b}` }, body: mp });
    assert.equal(r.status, 403);
    assert.equal(received.length, 0);

    // forwardMessage: from_chat_id also validated
    drain();
    r = await req(tPort, { method: 'POST', path: '/botPH/forwardMessage', headers: { 'content-type': 'application/json' }, body: '{"chat_id":111,"from_chat_id":777,"message_id":5}' });
    assert.equal(r.status, 403);

    // content method with no chat_id → fail-closed
    drain();
    r = await req(tPort, { method: 'POST', path: '/botPH/sendMessage', headers: { 'content-type': 'application/json' }, body: '{"text":"x"}' });
    assert.equal(r.status, 403);

    // read-only method (getUpdates) → allowed without chat_id
    drain();
    r = await req(tPort, { method: 'POST', path: '/botPH/getUpdates', headers: { 'content-type': 'application/json' }, body: '{"offset":0}' });
    assert.equal(r.status, 200);
    assert.equal(received[0].url, '/botreal-bot-SECRET/getUpdates');

    // urlencoded body, negative group id in the allow-list → allowed
    drain();
    r = await req(tPort, { method: 'POST', path: '/botPH/sendMessage', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'chat_id=-100222&text=hi' });
    assert.equal(r.status, 200);

    // file download path → forwarded with token injected (no chat check)
    drain();
    r = await req(tPort, { method: 'GET', path: '/file/botPH/photos/f_1.jpg' });
    assert.equal(r.status, 200);
    assert.equal(received[0].url, '/file/botreal-bot-SECRET/photos/f_1.jpg');
  } finally {
    proc.kill('SIGTERM');
    mock.close();
  }
});
