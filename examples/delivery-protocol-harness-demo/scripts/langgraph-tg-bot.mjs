#!/usr/bin/env node
// Telegram entry for the LangGraph orchestrator.
// Prefer Docker (security in compose.yaml): docker compose --profile tg-bot up -d tg-bot
//
//   TELEGRAM_BOT_TOKEN=<from @BotFather> LLM_PROVIDER=claude node scripts/langgraph-tg-bot.mjs
//   # or put TELEGRAM_BOT_TOKEN=... in ~/telegram.env
//
// Thin: build the compiled graph (MemorySaver, thread per chat) and start the
// Telegram channel. All orchestration is in lib/graph; the channel is transport
// + allowlist only. Real workers only — no mock path here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGraph } from '../lib/graph/workflow.mjs';
import { startTelegram } from '../lib/channels/telegram-adapter.mjs';
import { resolveProvider, isSupportedProvider } from '../lib/workers/index.mjs';
import { ensureTarget, resolveTargetFromEnv } from '../lib/target-repo.mjs';
import { initCatalogForTarget } from '../lib/roles-catalog.mjs';
import { getProtocol, REPOVINE_CLI } from '../lib/repovine.mjs';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../lib/env-file.mjs';
import { logLine } from '../lib/log.mjs';

const DEMO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Project .env (docker compose) then optional ~/telegram.env for local runs.
loadEnvFile(path.join(DEMO_ROOT, '.env'));
loadEnvFile(path.join(os.homedir(), 'telegram.env'));

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  logLine(
    'telegram',
    'Set TELEGRAM_BOT_TOKEN (from @BotFather) in .env, ~/telegram.env, or the environment, then re-run.',
  );
  process.exit(1);
}

// Allowlist — a Telegram bot is publicly messageable, so this is fail-closed:
// the allowlist is EMPTY by default (accepts nobody) and MUST be passed explicitly
// at launch via TELEGRAM_ALLOWED_IDS. No hardcoded owner id — a stray launch can
// never accidentally accept anyone. Everyone not listed is silently dropped.
const allowedIds = (process.env.TELEGRAM_ALLOWED_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (allowedIds.length === 0) {
  logLine(
    'telegram',
    'TELEGRAM_ALLOWED_IDS is empty — the allowlist accepts nobody, so the bot would ignore every message.\n' +
      'Pass it explicitly, e.g. TELEGRAM_ALLOWED_IDS=123456789 (find your id via @userinfobot).',
  );
  process.exit(1);
}

const provider = resolveProvider();
if (!isSupportedProvider(provider)) {
  logLine('telegram', `Unknown LLM_PROVIDER "${provider}". Use claude | local.`);
  process.exit(2);
}

let target;
try {
  target = resolveTargetFromEnv();
  ensureTarget(target);
  initCatalogForTarget(target);
} catch (e) {
  logLine('telegram', e.message);
  process.exit(2);
}
const repoRoot = target.repoRoot;

if (!getProtocol(repoRoot)) {
  const cliMissing = !fs.existsSync(REPOVINE_CLI);
  logLine(
    'telegram',
    cliMissing
      ? `repovine CLI not found at ${REPOVINE_CLI}.\nRebuild the image after:  (cd repovine && npm run build)`
      : `repovine CLI failed at ${REPOVINE_CLI} (agents protocol).\nRebuild: docker compose build --no-cache`,
  );
  process.exit(1);
}

const graph = buildGraph(); // MemorySaver checkpointer; thread per chat in the adapter

startTelegram({ graph, token, allowedIds, provider, repoRoot, target }).catch((e) => {
  logLine('telegram', e?.stack || e?.message || e);
  process.exit(1);
});
