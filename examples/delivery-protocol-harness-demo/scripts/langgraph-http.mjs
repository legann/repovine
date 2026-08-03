#!/usr/bin/env node
// HTTP entry for the LangGraph orchestrator — a Telegram-free "handle".
// Prefer Docker (security in compose.yaml): docker compose --profile http up -d http
// Same compiled graph as the bot and the CLI; only the trigger differs. Drive it
// from another console with curl (see lib/channels/http-adapter.mjs for the API).
//
//   node scripts/langgraph-http.mjs                                   # listens on :8080
//   PORT=9000 LLM_PROVIDER=local node scripts/langgraph-http.mjs
//   HARNESS_HTTP_TOKEN=secret node scripts/langgraph-http.mjs         # require a bearer token
//
//   curl -s localhost:8080/goal -H 'content-type: application/json' \
//     -d '{"goal":"add a GET /health route returning { ok: true }"}'
//   curl -s localhost:8080/ask -H 'content-type: application/json' \
//     -d '{"question":"how is theme switching implemented?"}'
//
// Real workers only — without credentials the worker returns `blocked` and the
// graph still validates + reports it (ok:false in the response, no silent spend).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph } from '../lib/graph/workflow.mjs';
import { startHttp } from '../lib/channels/http-adapter.mjs';
import { resolveProvider, isSupportedProvider } from '../lib/workers/index.mjs';
import { ensureTarget, resolveTargetFromEnv } from '../lib/target-repo.mjs';
import { initCatalogForTarget } from '../lib/roles-catalog.mjs';
import { getProtocol, REPOVINE_CLI } from '../lib/repovine.mjs';
import { loadEnvFile } from '../lib/env-file.mjs';
import { logLine } from '../lib/log.mjs';

const DEMO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Project .env (docker compose writes provider keys here) before env vars.
loadEnvFile(path.join(DEMO_ROOT, '.env'));

const provider = resolveProvider();
if (!isSupportedProvider(provider)) {
  logLine('http', `Unknown LLM_PROVIDER "${provider}". Use claude | local.`);
  process.exit(2);
}

let target;
try {
  target = resolveTargetFromEnv();
  ensureTarget(target);
  initCatalogForTarget(target);
} catch (e) {
  logLine('http', e.message);
  process.exit(2);
}
const repoRoot = target.repoRoot;

// Protocol gates run on the built CLI — fail early with a clear message if absent.
if (!getProtocol(repoRoot)) {
  logLine(
    'http',
    `Could not reach the repovine CLI at ${REPOVINE_CLI}.\n` +
      'Rebuild the image, or on the host:  (cd repovine && npm run build)',
  );
  process.exit(1);
}

const port = Number(process.env.PORT || 8080);
const token = process.env.HARNESS_HTTP_TOKEN || '';

// Bind address. In Docker the container must listen on 0.0.0.0 (the published
// port is delivered on the container interface, and the host exposure is already
// restricted by HARNESS_HTTP_BIND at the compose publish layer). On the host,
// default to loopback and refuse a routable bind without a token so a bare
// `node scripts/langgraph-http.mjs` cannot expose /goal,/ask,/reset to the network.
const inDocker = process.env.REPOVINE_IN_DOCKER === '1';
const host = inDocker ? '0.0.0.0' : process.env.HARNESS_HTTP_BIND || '127.0.0.1';
const isLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
if (!inDocker && !isLoopback && !token) {
  logLine(
    'http',
    `Refusing to bind ${host} without HARNESS_HTTP_TOKEN.\n` +
      'Set a token before exposing /goal, /ask and /reset off loopback, or bind 127.0.0.1.',
  );
  process.exit(2);
}
if (!token) {
  logLine(
    'http',
    'HARNESS_HTTP_TOKEN is unset — POST /goal and POST /ask are OPEN to anyone who can reach the port.\n' +
      `Bound to ${host} (loopback/isolated net only without a token); set a token to expose it wider.`,
  );
}

const graph = buildGraph(); // MemorySaver checkpointer; thread per `thread` value

startHttp({ graph, port, host, token, provider, repoRoot, target }).catch((e) => {
  logLine('http', e?.stack || e?.message || e);
  process.exit(1);
});
