// Credential-custody origin proxy for the egress gateway.
//
// Runs inside egress-gw (shared netns with the worker) and terminates plain HTTP on
// loopback, then RE-ORIGINATES to the real upstream over HTTPS with the real secret
// injected here — the worker never holds the anthropic token or the Telegram bot token.
//
//   worker  ──http──▶  127.0.0.1:<port>  (this proxy)  ──https──▶  api.anthropic.com
//                                                        └────────▶  api.telegram.org
//
// Anthropic: the SDK points ANTHROPIC_BASE_URL at the anthropic port with a PLACEHOLDER
// token; the proxy overwrites the auth header with the real credential and streams SSE
// through unbuffered. Telegram: the adapter points TELEGRAM_API_BASE at the telegram port
// with a placeholder token in the path; the proxy injects the real token AND pins every
// outbound chat_id/from_chat_id to TELEGRAM_RECIPIENT_IDS (fail-closed) for any method.
//
// Built-ins only (no npm): the egress-gw image ships nodejs but no node_modules.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const log = (...a) => console.error('egress-proxy:', ...a);

const BIND = '127.0.0.1';
const ANTHROPIC_PORT = Number(process.env.PROXY_ANTHROPIC_PORT || 8788);
const TELEGRAM_PORT = Number(process.env.PROXY_TELEGRAM_PORT || 8789);
const HEALTH_PORT = Number(process.env.PROXY_HEALTH_PORT || 8790);

const ANTHROPIC_UPSTREAM = process.env.ANTHROPIC_UPSTREAM_HOST || 'api.anthropic.com';
const TELEGRAM_UPSTREAM = process.env.TELEGRAM_UPSTREAM_HOST || 'api.telegram.org';

// Local-model forward: a raw byte pipe from a fixed loopback address in the shared netns
// to the host-side OpenAI-compatible server. The service is the constant address
// 127.0.0.1:LOCAL_FWD_PORT, so LOCAL_BASE_URL is one string on every platform. The name
// host.docker.internal resolves via /etc/hosts only in this gateway container, so the
// worker cannot dial it directly. No header rewrite and no custodied secret here — the
// pipe is protocol-agnostic (SSE and /v1 and non-/v1 paths pass unchanged). The outbound
// leg still traverses the default-deny OUTPUT chain, so the destination is unreachable
// until EGRESS_ALLOW_HOST_DOCKER_INTERNAL=1 / EGRESS_ALLOW_CIDRS allow-lists it. The
// listener is always up (fail-closed comes from the firewall), matching the telegram
// listener that binds without a token.
const LOCAL_FWD_PORT = Number(process.env.PROXY_LOCAL_PORT || 11434);
const LOCAL_UPSTREAM_HOST = process.env.LOCAL_UPSTREAM_HOST || 'host.docker.internal';
const LOCAL_UPSTREAM_PORT = Number(process.env.LOCAL_UPSTREAM_PORT || 11434);

// Upstream transport. Defaults to HTTPS:443; the *_UPSTREAM_PORT / *_UPSTREAM_INSECURE
// knobs point at an on-prem/compatible endpoint (and let the proxy be tested against a
// local mock). ca-certificates ships in the image for the default TLS path.
function upstream(kind) {
  const A = kind === 'anthropic';
  return {
    client: (A ? process.env.ANTHROPIC_UPSTREAM_INSECURE : process.env.TELEGRAM_UPSTREAM_INSECURE) === '1' ? http : https,
    host: A ? ANTHROPIC_UPSTREAM : TELEGRAM_UPSTREAM,
    port: Number((A ? process.env.ANTHROPIC_UPSTREAM_PORT : process.env.TELEGRAM_UPSTREAM_PORT) || 443),
  };
}

// Real secrets — read ONCE, from the egress-gw container env, never logged, never
// forwarded to the worker. Prefer the subscription OAuth token (WS-G).
const OAUTH_TOKEN = (process.env.CLAUDE_CODE_OAUTH_TOKEN || '').trim();
const API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const RECIPIENTS = new Set(
  (process.env.TELEGRAM_RECIPIENT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

// Body cap for chat_id parsing on Telegram content methods (a legit sendMessage is tiny;
// this only bounds a hostile multipart upload the proxy would reject anyway).
const MAX_TELEGRAM_BODY = Number(process.env.PROXY_MAX_TELEGRAM_BODY || 32 * 1024 * 1024);

// Telegram methods that carry no chat_id and deliver no outbound content — allowed
// without a recipient check. Everything else must carry chat_id(s) inside the allow-list.
const TELEGRAM_READONLY = new Set([
  'getupdates', 'getme', 'getfile', 'answercallbackquery',
  'getwebhookinfo', 'deletewebhook', 'getmycommands', 'setmycommands', 'logout', 'close',
]);

// Hop-by-hop headers must not be forwarded across the terminate/re-originate boundary.
const HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

function forwardHeaders(headers, upstreamHost) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP.has(k.toLowerCase())) out[k] = v;
  }
  out.host = upstreamHost;
  return out;
}

function deny(res, code, message) {
  if (!res.headersSent) res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: `egress-proxy: ${message}` }));
}

// ── Anthropic: overwrite auth with the real credential, stream SSE unbuffered ──
function handleAnthropic(req, res) {
  const headers = forwardHeaders(req.headers, ANTHROPIC_UPSTREAM);
  // Inject the real credential, mirroring the scheme the SDK chose (the placeholder in
  // the worker env is the same type, so headers/endpoint already match). Prefer OAuth.
  if (OAUTH_TOKEN) {
    delete headers['x-api-key'];
    headers.authorization = `Bearer ${OAUTH_TOKEN}`;
  } else if (API_KEY) {
    delete headers.authorization;
    headers['x-api-key'] = API_KEY;
  } else {
    req.resume();
    return deny(res, 502, 'no anthropic credential configured in the gateway');
  }

  const u = upstream('anthropic');
  const req2 = u.client.request(
    { host: u.host, port: u.port, method: req.method, path: req.url, headers },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res); // unbuffered → SSE tokens flush as they arrive
    },
  );
  req2.on('error', (e) => {
    log('anthropic upstream error:', e.message);
    deny(res, 502, `anthropic upstream: ${e.message}`);
  });
  req.pipe(req2);
}

// ── Telegram: inject the real token in the path, pin chat_id, then re-originate ──
function telegramMethod(url) {
  const m = url.match(/^\/bot[^/]+\/([^/?]+)/);
  return m ? m[1].toLowerCase() : '';
}

function rewriteTelegramPath(url) {
  if (/^\/file\/bot[^/]+\//.test(url)) return { path: url.replace(/^\/file\/bot[^/]+\//, `/file/bot${BOT_TOKEN}/`), file: true };
  if (/^\/bot[^/]+\//.test(url)) return { path: url.replace(/^\/bot[^/]+\//, `/bot${BOT_TOKEN}/`), file: false };
  return null;
}

// Extract every chat_id / from_chat_id the request would deliver to, across the encodings
// Telegram accepts: URL query, JSON body, urlencoded body, and multipart form fields.
function extractChatIds(url, contentType, bodyBuf) {
  const ids = [];
  const push = (v) => { if (v !== null && v !== undefined && String(v).trim() !== '') ids.push(String(v).trim()); };
  const q = new URL(url, 'http://x').searchParams;
  push(q.get('chat_id'));
  push(q.get('from_chat_id'));
  const ct = (contentType || '').toLowerCase();
  if (!bodyBuf || bodyBuf.length === 0) return ids;
  if (ct.includes('application/json')) {
    try {
      const j = JSON.parse(bodyBuf.toString('utf8'));
      push(j.chat_id);
      push(j.from_chat_id);
    } catch {
      return null; // unparseable JSON body on a content method → fail closed
    }
  } else if (ct.includes('application/x-www-form-urlencoded')) {
    const p = new URLSearchParams(bodyBuf.toString('utf8'));
    push(p.get('chat_id'));
    push(p.get('from_chat_id'));
  } else if (ct.includes('multipart/form-data')) {
    const text = bodyBuf.toString('latin1');
    for (const name of ['chat_id', 'from_chat_id']) {
      const m = text.match(new RegExp(`name="${name}"\\r?\\n\\r?\\n([^\\r\\n]*)`, 'i'));
      if (m) push(m[1]);
    }
  }
  return ids;
}

function originateTelegram(res, method, path, headers, bodyBuf) {
  const u = upstream('telegram');
  const up = u.client.request(
    { host: u.host, port: u.port, method, path, headers },
    (resp) => {
      res.writeHead(resp.statusCode || 502, resp.headers);
      resp.pipe(res);
    },
  );
  up.on('error', (e) => {
    log('telegram upstream error:', e.message);
    deny(res, 502, `telegram upstream: ${e.message}`);
  });
  if (bodyBuf && bodyBuf.length) up.end(bodyBuf);
  else up.end();
}

function handleTelegram(req, res) {
  if (!BOT_TOKEN) {
    req.resume();
    return deny(res, 502, 'no telegram bot token configured in the gateway');
  }
  const rewritten = rewriteTelegramPath(req.url);
  if (!rewritten) {
    req.resume();
    return deny(res, 404, 'unrecognized Telegram path');
  }
  const headers = forwardHeaders(req.headers, TELEGRAM_UPSTREAM);

  // File downloads (getFile → /file/bot<token>/<path>) deliver no outbound content and
  // carry no chat_id — stream them through after the token rewrite.
  if (rewritten.file) {
    return originateTelegram(res, req.method, rewritten.path, headers, null);
  }

  const method = telegramMethod(req.url);
  // Read-only, no-chat methods: forward without buffering.
  if (TELEGRAM_READONLY.has(method)) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => originateTelegram(res, req.method, rewritten.path, headers, Buffer.concat(chunks)));
    req.on('error', () => deny(res, 502, 'request stream error'));
    return;
  }

  // Content-delivering method: buffer the body, pin every chat_id to the allow-list.
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    if (aborted) return;
    size += c.length;
    if (size > MAX_TELEGRAM_BODY) {
      aborted = true;
      deny(res, 413, 'telegram body exceeds cap');
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('error', () => { if (!aborted) deny(res, 502, 'request stream error'); });
  req.on('end', () => {
    if (aborted) return;
    const bodyBuf = Buffer.concat(chunks);
    const ids = extractChatIds(req.url, req.headers['content-type'], bodyBuf);
    if (ids === null) return deny(res, 400, `unparseable body on "${method}"`);
    if (ids.length === 0) return deny(res, 403, `"${method}" delivers content but carries no chat_id (recipient pinning, fail-closed)`);
    const bad = ids.filter((id) => !RECIPIENTS.has(id));
    if (bad.length) {
      log(`BLOCKED ${method}: chat_id(s) [${bad.join(', ')}] not in TELEGRAM_RECIPIENT_IDS`);
      return deny(res, 403, `chat_id ${bad.join(', ')} is not an allowed recipient`);
    }
    originateTelegram(res, req.method, rewritten.path, headers, bodyBuf);
  });
}

// ── Servers ──
http.createServer(handleAnthropic).listen(ANTHROPIC_PORT, BIND, () => log(`anthropic proxy on ${BIND}:${ANTHROPIC_PORT} → ${ANTHROPIC_UPSTREAM}`));
http.createServer(handleTelegram).listen(TELEGRAM_PORT, BIND, () => log(`telegram proxy on ${BIND}:${TELEGRAM_PORT} → ${TELEGRAM_UPSTREAM} (${RECIPIENTS.size} recipient(s))`));
http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); }).listen(HEALTH_PORT, BIND, () => log(`health on ${BIND}:${HEALTH_PORT}`));
net.createServer((client) => {
  const up = net.connect({ host: LOCAL_UPSTREAM_HOST, port: LOCAL_UPSTREAM_PORT });
  up.setTimeout(5000, () => up.destroy(new Error('connect timeout')));
  up.on('connect', () => { up.setTimeout(0); client.pipe(up); up.pipe(client); });
  const drop = () => { client.destroy(); up.destroy(); };
  client.on('error', drop);
  up.on('error', drop);
  client.on('close', () => up.destroy());
  up.on('close', () => client.destroy());
}).listen(LOCAL_FWD_PORT, BIND, () => log(`local model forward on ${BIND}:${LOCAL_FWD_PORT} -> ${LOCAL_UPSTREAM_HOST}:${LOCAL_UPSTREAM_PORT}`));

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
