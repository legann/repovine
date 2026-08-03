#!/usr/bin/env node
// CLI trigger for the LangGraph orchestrator — Telegram-free (CI / local debug).
// Prefer Docker (security in compose.yaml): docker compose --profile cli run --rm cli --goal "…"   (--task is an alias)
//
//   node scripts/langgraph-cli.mjs --goal "initialize an express project"
//   LLM_PROVIDER=local node scripts/langgraph-cli.mjs --goal "add a GET /health route"
//
// Reads the project .env (same as the HTTP and Telegram entries) so credentials
// configured there are picked up; inline env vars still override it.
//
//   # Multi-agent — LangGraph is the main agent, fans out to sub-agents:
//   node scripts/langgraph-cli.mjs --goal "build the feature" --roles frontend,backend,infra
//   node scripts/langgraph-cli.mjs --goal "…" --roles backend:src/api,frontend:src/ui --review
//   # Greenfield runs fan scaffold roles out in parallel worktrees automatically;
//   # HARNESS_GREENFIELD_PARALLEL=0 disables. Continuation is always sequential.
//
// Same compiled graph as the Telegram bot; only the trigger differs. The graph
// drives the full Delivery Protocol cycle (validate-assignment → worker → validate-
// result → compliance) with every protocol gate on the real `repovine agents`
// CLI. Real workers only: without credentials the worker returns `blocked` and
// the graph still validates + reports it (no silent spend, no mock here). In
// multi-agent mode EACH sub-agent is its own validated assignment + compliance.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph, invokeGraph } from '../lib/graph/workflow.mjs';
import { resolveProvider, isSupportedProvider } from '../lib/workers/index.mjs';
import { agentsMode } from '../lib/agents.mjs';
import { ensureTarget, resolveTargetFromEnv } from '../lib/target-repo.mjs';
import { initCatalogForTarget } from '../lib/roles-catalog.mjs';
import { loadEnvFile } from '../lib/env-file.mjs';
import * as rp from '../lib/repovine.mjs';

const DEMO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Project .env (docker compose writes provider keys here) before reading env vars,
// mirroring scripts/langgraph-http.mjs and scripts/langgraph-tg-bot.mjs so
// `npm run dev:cli` behaves like the other two entries. Inline env still wins.
loadEnvFile(path.join(DEMO_ROOT, '.env'));

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
// --goal is the vocabulary-level name; --task is the alias (the wire keeps `task`).
const taskText = flagValue('--goal') ?? flagValue('--task');
// --roles frontend,backend  OR  --roles backend:src/api,frontend:src/ui  (":scope" optional)
const roles = (flagValue('--roles') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const review = argv.includes('--review');

if (!taskText) {
  console.error(
    'Usage: node scripts/langgraph-cli.mjs --goal "<your goal>" [--roles frontend,backend[:scope]] [--review]\n' +
      '       Docker: docker compose --profile cli run --rm cli --goal "…"   (--task is an alias)\n' +
      '       [LLM_PROVIDER=claude|local] [HARNESS_GREENFIELD_PARALLEL=0]',
  );
  process.exit(2);
}

let target;
try {
  target = resolveTargetFromEnv();
  ensureTarget(target);
  initCatalogForTarget(target);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const repoRoot = target.repoRoot;

// Protocol gates run on the built CLI — fail early with a clear message if absent.
if (!rp.getProtocol(repoRoot)) {
  console.error(
    `Could not reach the repovine CLI at ${rp.REPOVINE_CLI}.\n` +
      'Build it first:  (cd repovine && npm run build)',
  );
  process.exit(1);
}

const provider = resolveProvider();
if (!isSupportedProvider(provider)) {
  console.error(`Unknown LLM_PROVIDER "${provider}". Use claude | local.`);
  process.exit(2);
}

const multi = roles.length > 0 || review || agentsMode() !== 'single';
const proto = rp.getProtocol(repoRoot);
console.log(`repovine Delivery Protocol v${proto.protocol.protocolVersion}`);
console.log(`Orchestrator: LangGraph`);
console.log(`Provider:     ${provider}`);
const modeLabel = multi
  ? `multi-agent (${roles.length ? 'explicit' : agentsMode()})${roles.length ? ` [${roles.join(', ')}]` : ''}${review ? ' +review' : ''}`
  : 'single';
console.log(`Mode:         ${modeLabel}`);
if (target.mode === 'attach') {
  console.log('Target mode:  attach');
  console.log(`Workspace:    ${repoRoot}`);
} else {
  console.log(`Sandbox:      ${repoRoot}`);
}
console.log('');

const graph = buildGraph();
const task = {
  id: `cli-${Date.now()}`,
  task: taskText,
  scope: ['.'],
  requestedChecks: [],
  ...(roles.length ? { roles } : {}),
  ...(review ? { review: true } : {}),
};
const final = await invokeGraph(
  graph,
  { task, repoRoot, targetMode: target.mode, llmProvider: provider },
  { threadId: `cli:${task.id}` },
);

console.log('─'.repeat(60));
console.log(final.replyText || '(no reply produced)');
console.log('─'.repeat(60));

let succeeded;
if (final.mode === 'multi' && Array.isArray(final.subAgents)) {
  for (const l of final.subAgents) {
    if (l.result?.graphNodesTouched?.length) {
      console.log(`[${l.role}] graph nodes: ${l.result.graphNodesTouched.join(', ')}`);
    }
  }
  // Every sub-agent must have completed AND passed compliance.
  succeeded = final.subAgents.length > 0 && final.subAgents.every((l) => l.ok && ['complete', 'partial'].includes(l.result?.status));
} else {
  if (final.result?.graphNodesTouched?.length) {
    console.log(`graph nodes: ${final.result.graphNodesTouched.join(', ')}`);
  }
  // Exit 0 only when the task actually completed AND passed compliance — a blocked
  // run (e.g. missing credentials) is a non-zero outcome CI should catch.
  succeeded = final.ok && ['complete', 'partial'].includes(final.result?.status);
}
console.log(`artifacts:   ${repoRoot}/.harness/active (live) · ${repoRoot}/.harness/runs (archive)`);
process.exit(succeeded ? 0 : 1);
