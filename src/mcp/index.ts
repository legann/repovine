#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runSetup, printSetupNextSteps, runWorkspaceBootstrap, ensureWorkspaceBootstrap, resolveMcpLauncher, type ClientTarget } from '../cli/init.js';
import { runDomainsAdvisorAfterBuild, type DomainsAdvisorCliResult } from '../cli/domains-advisor.js';
import { runClear } from '../cli/clear.js';
import { runBuild } from '../cli/build.js';
import { runAgentsCli } from '../cli/agents.js';
import {
  runDoctorCli,
  runStatusCli,
} from '../cli/health.js';
import { promptLineSync } from '../cli/prompt.js';
import { cli, logCli, logPipeline, formatPipelineMuted, setPipelineLogSink, setProgressInPlace } from '../cli/ui.js';

// ── CLI dispatch ──

const args = process.argv.slice(2);
const command = args[0];

if (command === '--help' || command === '-h') {
  printUsage();
  process.exit(0);
}

if (command === '--version' || command === '-v') {
  printVersion();
  process.exit(0);
}

if (command === 'setup') {
  const setupArgs = args.slice(1);
  const allowedSetupFlags = new Set(['--force', '--replace-mcp', '--no-build', '--published', '--interactive', '-i', '--help', '-h']);
  const unknownSetupFlags = setupArgs.filter(flag => flag.startsWith('-') && !allowedSetupFlags.has(flag));
  if (unknownSetupFlags.length > 0) {
    console.error(`Unknown setup option(s): ${unknownSetupFlags.join(', ')}`);
    printSetupUsage();
    process.exit(1);
  }
  if (setupArgs.includes('--help') || setupArgs.includes('-h')) {
    printSetupUsage();
    process.exit(0);
  }
  let target = setupArgs.find(arg => !arg.startsWith('-')) as ClientTarget | undefined;
  const setupFlags = setupArgs.filter(arg => arg.startsWith('-'));
  const interactive = setupFlags.includes('--interactive') || setupFlags.includes('-i');
  const noBuild = setupFlags.includes('--no-build');
  if (!target && interactive) {
    target = promptClientTarget();
  }

  if (!target) {
    // No client: workspace-only setup (plugin mode). The marketplace plugin owns
    // client assets/updates; the CLI just writes repovine config + cache and builds.
    runWorkspaceBootstrap(repoRoot, process.cwd(), { autoBuild: !noBuild });
    if (!noBuild) {
      await runBuild(repoRoot, artifactsDir);
    }
    process.exit(0);
  }

  if (!['cursor', 'claude', 'codex', 'all'].includes(target)) {
    printSetupUsage();
    process.exit(1);
  }

  // Client given: project that client's assets + workspace config.
  // Idempotent — a re-run updates managed assets to the current repovine version.
  // Wire the MCP at whatever engine ran this setup: a contributor running their own
  // built dist/ from the source repo gets a local launcher; consumers get npx.
  const mcpLauncher = resolveMcpLauncher(repoRoot, fileURLToPath(import.meta.url), {
    forcePublished: setupFlags.includes('--published'),
  });
  if (mcpLauncher.command !== 'npx') {
    console.log(`Self-dogfood: MCP wired to local build ${mcpLauncher.args[0]} (not npx). Use --published to force npx.`);
  }
  runSetup(target, repoRoot, {
    forceBootstrap: setupFlags.includes('--force'),
    replaceMcp: setupFlags.includes('--replace-mcp'),
    interactive,
    autoBuild: !noBuild,
    mcpLauncher,
  }, process.cwd());
  // Build by default so the first MCP start is warm; --no-build defers to first MCP start.
  let domainsAdvisor: DomainsAdvisorCliResult | undefined;
  if (!noBuild) {
    const ctx = await runBuild(repoRoot, artifactsDir);
    domainsAdvisor = runDomainsAdvisorAfterBuild(repoRoot, ctx.getState(), { interactive });
  }
  printSetupNextSteps(target, { noBuild, domainsAdvisor });
  process.exit(0);
}

if (command === 'build') {
  const buildFlags = args.slice(1);
  const allowedBuildFlags = new Set<string>(['--cleanup-orphans']);
  const unknownBuildFlags = buildFlags.filter(flag => flag.startsWith('--') && !allowedBuildFlags.has(flag));
  if (unknownBuildFlags.length > 0) {
    console.error(`Unknown build option(s): ${unknownBuildFlags.join(', ')}`);
    console.error('Usage: repovine build [--cleanup-orphans]');
    process.exit(1);
  }
  await runBuild(repoRoot, artifactsDir, { cleanupOrphans: buildFlags.includes('--cleanup-orphans') });
  process.exit(0);
}

if (command === 'clear') {
  const clearArgs = args.slice(1);
  const allowedClearFlags = new Set(['--dry-run', '--help', '-h']);
  if (clearArgs.includes('--help') || clearArgs.includes('-h')) {
    printClearUsage();
    process.exit(0);
  }
  const unknownClearFlags = clearArgs.filter(flag => !allowedClearFlags.has(flag));
  if (unknownClearFlags.length > 0) {
    console.error(`Unknown clear option(s): ${unknownClearFlags.join(', ')}`);
    printClearUsage();
    process.exit(1);
  }
  await runClear(repoRoot, {
    dryRun: clearArgs.includes('--dry-run'),
  }, process.cwd());
  process.exit(0);
}

if (command === 'status') {
  const exitCode = await runStatusCli(args.slice(1), { repoRoot, artifactsDir });
  process.exit(exitCode);
}

if (command === 'doctor') {
  const exitCode = await runDoctorCli(args.slice(1), { repoRoot, artifactsDir });
  process.exit(exitCode);
}

if (command === 'agents') {
  const exitCode = await runAgentsCli(args.slice(1), { repoRoot, artifactsDir });
  process.exit(exitCode);
}

if (command) {
  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}

function printClearUsage(): void {
  console.error('Usage: repovine clear [--dry-run]');
  console.error('  Prints the plan, then asks for y/N before removing generated setup.');
  console.error('  Preserves repovine.annots.json, repovine.config.json, repovine.domains.json, and unrelated merged settings.');
}

function printSetupUsage(): void {
  console.error('Usage: repovine setup [cursor|claude|codex|all] [-i|--interactive] [--force] [--replace-mcp] [--no-build] [--published]');
  console.error('  No client: workspace-only setup (repovine.config.json, repovine.domains.json, .repovine/, .gitignore).');
  console.error('             Use this with the marketplace plugin, which owns client agents/skills/hooks/MCP.');
  console.error('  With a client: also project that client scaffold. Re-run to update assets to the current version.');
  console.error('  Detects existing MCP servers → merge mode (other servers kept).');
  console.error('  Builds the graph after writing config (default), so the first MCP start is warm.');
  console.error('  -i, --interactive: choose a client when omitted and confirm updates to existing files.');
  console.error('  --force: overwrite generated instructions/client assets; project config files are preserved.');
  console.error('  --replace-mcp: replace MCP config when safe; refused if other servers would be removed.');
  console.error('  --no-build: skip the graph build; it will run on first MCP start instead.');
  console.error('  --published: force the published npx launcher even when run from the repovine source repo (self-dogfood otherwise wires the local dist).');
}

function promptLine(prompt: string): string {
  return promptLineSync(
    prompt,
    'Interactive setup requires a TTY. Pass a client explicitly, e.g. repovine setup codex.',
  );
}

function promptClientTarget(): ClientTarget {
  logCli(`${cli.bold('repovine setup')}`);
  logCli('Choose which client files to install:');
  logCli('  1. all');
  logCli('  2. codex');
  logCli('  3. claude');
  logCli('  4. cursor');
  for (;;) {
    const answer = promptLine('Target [all]: ').toLowerCase();
    const normalized = answer || 'all';
    if (normalized === '1' || normalized === 'all') return 'all';
    if (normalized === '2' || normalized === 'codex') return 'codex';
    if (normalized === '3' || normalized === 'claude') return 'claude';
    if (normalized === '4' || normalized === 'cursor') return 'cursor';
    logCli(cli.warn('Please choose all, codex, claude, or cursor.'));
  }
}

function printUsage(): void {
  const version = readPackageVersion();
  logCli(`${cli.bold(`repovine v${version}`)}

${cli.bold('Usage:')}
  repovine                    Start MCP server (stdio)
  repovine setup [client|-i]  Set up repo: config + cache (+ client scaffold); re-run to update
  repovine build              Eagerly build the graph and save snapshot cache
  repovine status             Unified graph/config/annotation health snapshot
  repovine doctor             Diagnose MCP setup, cache, annotations, and client projections
  repovine clear              Preview and confirm removing generated setup
  repovine agents <cmd>       Harness/CI Agent Protocol CLI (repovine agents --help)

${cli.bold('Setup clients:')}
  cursor    .cursor/mcp.json + .cursor capabilities
  claude    .mcp.json + .claude/settings.json + .claude/hooks + AGENTS.md
  codex     .codex/config.toml + .codex/hooks + .codex/agents + AGENTS.md
  all       All of the above
  (none)    Workspace-only setup

${cli.bold('Setup options:')}
  -i, --interactive   Prompt before updating existing files (created files still write)
  --force             Overwrite generated client assets; preserve project config files
  --replace-mcp       Replace MCP config only when no other servers would be lost
  --no-build          Skip graph build; first MCP start builds instead

${cli.bold('Other options:')}
  --dry-run   Preview \`repovine clear\` without prompting
  --help      Show this help
  --version   Show version
`);
}

function readPackageVersion(): string {
  const entrypoint = process.argv[1];
  const entrypointDir = entrypoint
    ? path.dirname(fs.existsSync(entrypoint) ? fs.realpathSync(entrypoint) : path.resolve(entrypoint))
    : undefined;
  const candidates = [
    entrypointDir ? path.resolve(entrypointDir, '..', '..', 'package.json') : undefined,
    path.resolve(process.cwd(), 'package.json'),
    path.resolve(process.cwd(), 'repovine', 'package.json'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const pkgPath of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.name === 'repovine') return pkg.version ?? 'unknown';
    } catch {
      // Try the next likely package root.
    }
  }
  return 'unknown';
}

function printVersion(): void {
  console.log(readPackageVersion());
}

// ── MCP server mode (default — no subcommand) ──

const envStdioVerbose = process.env.REPOVINE_VERBOSE === '1';
let stdioVerbose = envStdioVerbose;
const stdioShowLogs = typeof process.stderr?.isTTY === 'boolean' ? process.stderr.isTTY : false;

/** Grace period for a shutdown drain (save chain + hooks + transport close) before a hard exit. */
const SHUTDOWN_DEADLINE_MS = 8_000;
/** Set once shutdown begins; new tool calls are refused so in-flight work drains against a stable state. */
let admissionClosed = false;
/** Annotation-mutating tools, refused while a config reload swaps the runtime (writes would hit a drained store). */
const MUTATING_ANNOTATION_TOOLS = new Set(['write_annotation', 'merge_annotations']);
/** In-flight tool executions; shutdown waits for these to finish before draining and exiting. */
let inFlightToolCalls = 0;

function refreshPipelineLogSink(): void {
  const showLogs = stdioShowLogs || stdioVerbose;
  setPipelineLogSink(showLogs ? 'stderr' : 'silent');
  // Cursor MCP pipes stderr (isTTY=false); `\r` still updates one line in the log panel.
  setProgressInPlace(showLogs);
}

refreshPipelineLogSink();

const ts = () => new Date().toISOString().slice(11, 23);
console.log = (...args: unknown[]) => {
  if (stdioShowLogs || stdioVerbose) process.stderr.write(`[${ts()}] ${util.format(...args)}\n`);
};
console.error = (...args: unknown[]) => {
  process.stderr.write(`[${ts()}] ${util.format(...args)}\n`);
};
import { repoRoot, artifactsDir } from '../paths.js';
import { toolHandlers } from './tools/registry.js';
import { toolDefs, getRequiredArgs } from './tool-defs.js';
import { RepovineRuntime } from './context.js';
import { IndexBuildController } from './build-controller.js';
import { getSourcePlugins } from '../stage1/source/registry.js';
import { loadConfig, type ResolvedConfig } from '../config.js';
import { ContextSessionStore, bootstrapContextSessionsOnMcpStart } from '../context-quality/session-store.js';
import {
  isToolErrorResult,
  NavigationRefRegistry,
  responseConfigWithOverride,
  toCallToolMcpResult,
} from './response-format.js';
import { contextSessionIdFromArgs } from './context-session.js';
import { appendSemanticScopeSuggestions } from './response/semantic-scope-suggestions.js';
import { ReloadConfigRunner } from './reload-config.js';
import { abortMcpBuilds, createShutdownSequence } from './shutdown.js';

// ── Tool definitions derived from single source of truth (tool-defs.ts) ──

const navigationRefs = new NavigationRefRegistry();

interface McpProcessState {
  cfg: ResolvedConfig;
  contextQualityStore: ContextSessionStore;
  /** Single-flight reloadConfig swap; constructed in main() (needs the controller). */
  reloadConfig?: ReloadConfigRunner<ResolvedConfig, RepovineRuntime>;
}

// ── Tool execution ──

/** Shown in initialize.instructions — guides models on tools/list and tools/call. */
const REPOVINE_MCP_INSTRUCTIONS =
  'repovine exposes MCP tools for repository graph and annotations. ' +
  'Discover tools with method tools/list (each entry: name, description, inputSchema). ' +
  'Call a tool with method tools/call and params { name: "<tool_name>", arguments: { ... } }. ' +
  'Always pass arguments as a JSON object; if a tool has no parameters, pass {}. ' +
  'Required argument names are listed in inputSchema.required. ' +
  'Optional responseFormat:"concise"|"debug" overrides the response shape for one call. ' +
  'Concise navigation args may use refs like "$abc123"; copy them as-is in the same MCP session, or expand them from the response refs map. ' +
  'Successful results and structured errors are JSON in content[0].text; if isError is true, fix arguments or server state. ' +
  'Build state: tool calls before the graph finishes building return a successful response (not an error) with status:"building" and fields stage, pct, done_packages/total_packages, eta_sec, retry_after_sec. ' +
  'When you see status:"building": (1) do not retry the same tool in a tight loop — respect retry_after_sec; ' +
  '(2) call get_build_status (always available); pass waitSec (e.g. { waitSec: 45 }) to long-poll — one waiting call that returns as soon as the build settles, instead of repeated polling; ' +
  '(3) if eta_sec < 60 and your task strictly needs the graph, wait via get_build_status({ waitSec: eta_sec }) and retry once; ' +
  '(4) if eta_sec >= 60, tell the user the graph is still building and fall back to direct file reads instead of polling. ' +
  'search_context: emptyDiagnostic is present only when totalResults is 0 (and no config/entrypoint aux matches). '
  + 'OR-relax hits omit emptyDiagnostic — check result.matches.strategy (used, relaxedFrom, strongTokens, weakTokenOnlySuppressed), gaps, topResults[].matchedTokenCount/score, summary, and confidence before inspect_node. '
  + 'relaxedFrom:"and" means auto fell back from AND to bounded OR (not an exact multi-token match). '
  + 'matchedTokenCount:1 on a multi-token query or low top score after relax is a weak signal — narrow the query or retry match:"and". '
  + 'match auto|and|or controls token combination; weak tokens (package, route, handler, module, …) are down-weighted.';

function logToolError(toolName: string, message: string): void {
  console.error(`  [${toolName}] error: ${message}`);
}

/** L4 cooldown: keep the last "building" payload per tool name for a few seconds so
 * repeated calls during a long build don't recompute the snapshot. */
const BUILDING_RESPONSE_TTL_MS = 5000;
const lastBuildingResponse = new Map<string, { expiresAt: number; payload: unknown }>();
const CONTEXT_QUALITY_META_TOOLS = new Set([
  'get_build_status',
  'get_context_session_quality',
]);

function getBuildingResponse(name: string, controller: IndexBuildController): unknown {
  const cached = lastBuildingResponse.get(name);
  if (cached && Date.now() < cached.expiresAt) return cached.payload;
  const snapshot = controller.snapshot();
  const payload = {
    status: snapshot.status,
    stage: snapshot.stage,
    pct: snapshot.pct,
    done_packages: snapshot.donePackages,
    total_packages: snapshot.totalPackages,
    done_modules: snapshot.doneModules,
    total_modules: snapshot.totalModules,
    done_semantic_cards: snapshot.doneSemanticCards,
    total_semantic_cards: snapshot.totalSemanticCards,
    current_package: snapshot.currentPackage,
    elapsed_sec: snapshot.elapsedSec,
    eta_sec: snapshot.etaSec,
    retry_after_sec: snapshot.retryAfterSec,
    message: snapshot.message,
    next_action: 'Call get_build_status (always available) for live progress — pass waitSec (e.g. { waitSec: 45 }) to wait server-side until the build settles instead of polling; then retry this tool.',
    errorMessage: snapshot.errorMessage,
  };
  lastBuildingResponse.set(name, { expiresAt: Date.now() + BUILDING_RESPONSE_TTL_MS, payload });
  return payload;
}

async function executeTool(
  controller: IndexBuildController,
  name: string,
  args: Record<string, unknown>,
  processState: McpProcessState,
  signal?: AbortSignal,
): Promise<unknown> {
  const def = toolDefs.find(d => d.name === name);
  if (!def) {
    return { error: `Unknown tool: ${name}` };
  }

  // Refuse new work once shutdown has begun; in-flight saves drain against a stable state.
  if (admissionClosed) {
    return { error: 'repovine MCP server is shutting down; retry after restart.' };
  }

  // While a config reload swaps the runtime, refuse annotation writes so none land on the outgoing store
  // after it was drained (they would be lost on the swap). Reads are unaffected.
  if (processState.reloadConfig?.isInFlight && MUTATING_ANNOTATION_TOOLS.has(name)) {
    return { error: 'repovine is reloading its config; retry this write in a moment.' };
  }

  // get_build_status is always callable, even during build / on failure.
  // With waitSec it long-polls: holds the request until the build settles or the wait
  // expires, so agents make one waiting call instead of a polling loop.
  if (name === 'get_build_status') {
    // Mutating branch: stop the in-flight startup build and return the resulting status. Ignores
    // waitSec; a no-op (current snapshot) when no build is running. Reachable here because
    // get_build_status is special-cased before the not-ready gate, so it works mid-build.
    if (args['cancel'] === true) {
      return await controller.cancel();
    }
    const waitSecRaw = args['waitSec'];
    const waitSec = typeof waitSecRaw === 'number' && Number.isFinite(waitSecRaw)
      // Cap below the MCP SDK client's 60s default request timeout: a longer long-poll would always
      // time out client-side and auto-cancel while the server pends and discards the eventual reply.
      ? Math.min(55, Math.max(0, Math.floor(waitSecRaw)))
      : 0;
    const snapshot = waitSec > 0 ? await controller.waitForSettled(waitSec, signal) : controller.snapshot();
    if (snapshot.status !== 'ready') return snapshot;
    const domainsSuggestions = controller.getCtx()?.getState().domainsSuggestions;
    return {
      ...snapshot,
      ...(domainsSuggestions ? {
        domainsSuggestions: {
          count: domainsSuggestions.count,
          axes: domainsSuggestions.axes,
          declinedHidden: domainsSuggestions.declinedHidden,
        },
      } : {}),
    };
  }

  // A cancelled (bare-tree) server has no graph and refresh_context's handler can't run. Re-trigger
  // a fresh build instead, so the cancel→rebuild cycle stays inside MCP tools. Special-cased before
  // the not-ready gate (like get_build_status); only fires from the terminal `cancelled` state.
  if (name === 'refresh_context' && controller.isCancelled()) {
    return controller.rebuild();
  }

  // L1+L3: if the graph isn't ready yet, return an informational success-shape payload
  // (NOT an error) so harness retry-logic doesn't spin. Identical shape per tool until TTL.
  if (!controller.isReady()) {
    return getBuildingResponse(name, controller);
  }

  args = navigationRefs.resolveArgs(args);

  const required = getRequiredArgs(def);
  const missing = required.filter(k => args[k] == null || args[k] === '');
  if (missing.length > 0) {
    return {
      error: `Missing required argument(s): ${missing.join(', ')}. `
        + `Pass them in the "arguments" object of the tools/call request; inputSchema.required lists them.`,
      fix: `tools/call { "name": "${name}", "arguments": { ${required.map(k => `"${k}": "..."`).join(', ')} } }`,
    };
  }
  const parsed = def.schema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { error: `Invalid arguments: ${issues}` };
  }
  const parsedArgs = parsed.data as Record<string, unknown>;
  // Resolve the context-session id BEFORE stripping it from handler args, so handlers that need it
  // (e.g. write_annotation's pre-handoff provenance hint) read it from the context, not the args.
  const callContextSessionId = contextSessionIdFromArgs(parsedArgs);
  const {
    responseFormat: _responseFormat,
    contextSessionId: _contextSessionId,
    ...handlerArgs
  } = parsedArgs;
  args = handlerArgs;

  const handler = toolHandlers[name];
  if (!handler) {
    return { error: `Unknown tool: ${name}` };
  }

  const toolCtx = {
    ...(signal ? { signal } : {}),
    getState: () => {
      const current = controller.getCtx();
      if (!current) throw new Error('Repovine runtime is not ready.');
      return current.getState();
    },
    getConfig: () => processState.cfg,
    refreshRepoState: async (options?: { reloadConfig?: boolean }) => {
      const current = controller.getCtx();
      if (!current) throw new Error('Repovine runtime is not ready.');
      if (options?.reloadConfig) {
        // Single-flight runner (see reload-config.ts): concurrent calls coalesce onto one swap;
        // annotation writes are refused while it runs (see executeTool). The request signal makes
        // the rebuild cancellable; checkpoints keep a late cancel from swapping the runtime.
        const runner = processState.reloadConfig;
        if (!runner) throw new Error('Config reload is unavailable in this mode.');
        return runner.run(signal);
      }
      await current.refresh(signal);
    },
    repoRoot,
    contextQualityStore: processState.contextQualityStore,
    ...(callContextSessionId ? { contextSessionId: callContextSessionId } : {}),
  };
  const response = await handler(toolCtx, args);
  // Advisory recovery: unresolved scopes get up to three semantic retry suggestions.
  await appendSemanticScopeSuggestions(toolCtx, name, args, response);
  return response;
}

function recordContextQualityCall(
  store: ContextSessionStore,
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  responseText: string,
): void {
  if (CONTEXT_QUALITY_META_TOOLS.has(toolName)) return;
  const sessionId = contextSessionIdFromArgs(args);
  if (!sessionId) return;
  store.recordToolCall({
    sessionId,
    tool: toolName,
    args,
    result,
    responseText,
  });
}

// ── Usage tracking ──

const usage = {
  startedAt: new Date().toISOString(),
  totalCalls: 0,
  totalResponseChars: 0,
  byTool: {} as Record<string, { calls: number; chars: number }>,
};

function trackCall(toolName: string, responseText: string): void {
  const chars = responseText.length;
  usage.totalCalls++;
  usage.totalResponseChars += chars;

  if (!usage.byTool[toolName]) usage.byTool[toolName] = { calls: 0, chars: 0 };
  usage.byTool[toolName].calls++;
  usage.byTool[toolName].chars += chars;

  const approxTokens = Math.ceil(chars / 4);
  console.log(`    → ${chars} chars (~${approxTokens} tokens) | total: ${usage.totalCalls} calls, ~${Math.ceil(usage.totalResponseChars / 4)} tokens`);
}

// ── Stdio mode (MCP SDK) ──

async function runStdio(
  controller: IndexBuildController,
  processState: McpProcessState,
): Promise<McpServer> {
  const mcpServer = new McpServer(
    { name: 'repovine', version: '0.1.0', title: 'repovine' },
    { instructions: REPOVINE_MCP_INSTRUCTIONS },
  );

  for (const def of toolDefs) {
    const name = def.name;
    mcpServer.registerTool(name, {
      description: def.description,
      inputSchema: def.schema,
    }, async (args: unknown, extra: { signal?: AbortSignal }) => {
      const safeArgs = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
      if (stdioShowLogs || stdioVerbose) console.error(`  tool: ${name}(${JSON.stringify(safeArgs)})`);
      inFlightToolCalls++;
      try {
        const responseConfig = responseConfigWithOverride(processState.cfg.mcp.response, safeArgs.responseFormat);
        // extra.signal is the SDK's per-request AbortSignal (aborted on notifications/cancelled);
        // thread it so long-running tools stop work when the client cancels.
        const result = await Promise.resolve(executeTool(controller, name, safeArgs, processState, extra?.signal));
        if (isToolErrorResult(result)) logToolError(name, result.error);
        const out = toCallToolMcpResult(result, responseConfig, navigationRefs);
        recordContextQualityCall(processState.contextQualityStore, name, safeArgs, result, out.content[0].text);
        trackCall(name, out.content[0].text);
        return out;
      } catch (e) {
        const message = (e as Error).message;
        logToolError(name, message);
        const text = JSON.stringify({ error: message }, null, 2);
        trackCall(name, text);
        return {
          content: [{ type: 'text' as const, text }],
          isError: true,
        };
      } finally {
        inFlightToolCalls--;
      }
    });
  }

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  if (stdioShowLogs || stdioVerbose) console.error('\nrepovine MCP server (stdio) ready');
  return mcpServer;
}

// ── Graceful shutdown ──

function createShutdownHandler(
  controller: IndexBuildController,
  processState: McpProcessState,
  afterFlushHooks: Array<() => Promise<void>> = [],
  options: { closeTransport?: () => Promise<void> } = {},
): (reason: string) => Promise<void> {
  // The ordered sequence lives in shutdown.ts (unit-tested there); this wires the live process state.
  return createShutdownSequence({
    closeAdmission: () => { admissionClosed = true; },
    // Abort every active build kind: the startup build via the controller, an in-flight refresh via
    // the runtime's force-abort (bypasses the caller refcount — at shutdown nobody gets the result),
    // and a reloadConfig swap via its runner. Each settles only after its worker pool is destroyed,
    // i.e. worker isolates have reaped their python children.
    abortActiveBuilds: () => abortMcpBuilds({
      abortStartup: () => controller.cancel(),
      abortRefresh: () => controller.getCtx()?.abortActiveRefresh() ?? Promise.resolve(),
      abortReloadConfig: () => processState.reloadConfig?.abortActive() ?? Promise.resolve(),
      logError: message => console.error(message),
    }),
    inFlightToolCalls: () => inFlightToolCalls,
    // Fallback for INLINE-path children on the main thread (SDK teardown contract). Pooled children
    // are owned by worker isolates and are reaped by the pool destroy inside the build aborts above.
    terminateInlinePluginChildren: async () => {
      for (const plugin of getSourcePlugins()) {
        try {
          await Promise.resolve(plugin.terminateInFlight?.());
        } catch (e) {
          console.error('  [shutdown] plugin subprocess teardown error:', (e as Error).message);
        }
      }
    },
    drainAnnotations: async () => {
      const ctx = controller.getCtx();
      if (!ctx) return;
      // Async drain (not sync flush): persists pending saves and waits for the save chain without
      // busy-blocking the event loop against an in-flight async writer holding the file lock.
      await ctx.getState().annotations.drain();
    },
    afterFlushHooks,
    closeTransport: options.closeTransport,
    exit: code => process.exit(code),
    log: msg => console.log(msg),
    logError: msg => console.error(msg),
    deadlineMs: SHUTDOWN_DEADLINE_MS,
  });
}

function registerProcessSignals(requestShutdown: (reason: string) => Promise<void>): void {
  process.on('SIGINT', () => {
    void requestShutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void requestShutdown('SIGTERM');
  });
}

/**
 * When the MCP host disables the server it usually closes the stdio pipe (stdin EOF) without SIGTERM.
 * Without this, Node keeps running because open handles hold the event loop.
 */
function registerStdioDisconnectShutdown(requestShutdown: (reason: string) => Promise<void>): void {
  const stdin = process.stdin;
  stdin.on('end', () => {
    void requestShutdown('stdin-closed');
  });
  stdin.on('error', () => {
    void requestShutdown('stdin-error');
  });
}

// ── Main ──

async function main(): Promise<void> {
  const bootstrapped = ensureWorkspaceBootstrap(repoRoot).filter(r => r.status === 'created');
  for (const r of bootstrapped) {
    console.error(`  Bootstrap: created ${path.relative(repoRoot, r.path)}`);
  }

  const cfg = loadConfig(repoRoot);
  const processState: McpProcessState = {
    cfg,
    contextQualityStore: new ContextSessionStore({ repoRoot, config: cfg.contextQuality }),
  };
  const sessionBootstrap = bootstrapContextSessionsOnMcpStart(
    processState.contextQualityStore,
    processState.cfg.contextQuality,
  );
  if (!sessionBootstrap.skipped && sessionBootstrap.purged > 0) {
    logPipeline(formatPipelineMuted(
      `Context sessions: purged ${sessionBootstrap.purged} file(s) on MCP start (${processState.cfg.contextQuality.enforcement.mode} mode).`,
    ));
  }
  stdioVerbose = envStdioVerbose || processState.cfg.mcp.verbose;
  refreshPipelineLogSink();
  const controller = new IndexBuildController();

  // Single-flight reloadConfig swap. Deps read the CURRENT runtime at run time (controller.getCtx()),
  // so drain hits the outgoing store even if the ready runtime changed since construction.
  processState.reloadConfig = new ReloadConfigRunner<ResolvedConfig, RepovineRuntime>({
    loadNextConfig: () => loadConfig(repoRoot),
    buildRuntime: (cfg, signal) => RepovineRuntime.create(repoRoot, artifactsDir, cfg, { signal }),
    drainOutgoing: async () => {
      const current = controller.getCtx();
      if (!current) return undefined;
      await current.getState().annotations.drain();
      return current.getState().annotations.lastSaveError ?? undefined;
    },
    reloadIncoming: nextCtx => nextCtx.getState().annotations.reloadFromDisk(),
    publish: (nextCtx, nextCfg) => {
      controller.replaceReadyContext(nextCtx);
      processState.cfg = nextCfg;
      processState.contextQualityStore = new ContextSessionStore({ repoRoot, config: nextCfg.contextQuality });
      stdioVerbose = envStdioVerbose || nextCfg.mcp.verbose;
      refreshPipelineLogSink();
    },
    onDrainWarning: message => {
      console.error(`  [ALERT] reloadConfig: outgoing annotation store failed to drain (${message}); pending writes may be stranded.`);
    },
  });

  const shutdownHooks: Array<() => Promise<void>> = [];
  const serverHolder: { server?: McpServer } = {};
  const requestShutdown = createShutdownHandler(controller, processState, shutdownHooks, {
    closeTransport: () => serverHolder.server?.close() ?? Promise.resolve(),
  });
  registerProcessSignals(requestShutdown);

  // Connect the MCP transport BEFORE building so the `initialize` handshake
  // never blocks on the cold-cache path. Tool calls received before the build finishes
  // return success-shape `status:"building"` payloads (see executeTool).
  registerStdioDisconnectShutdown(requestShutdown);
  serverHolder.server = await runStdio(controller, processState);

  logPipeline(formatPipelineMuted(`Building repovine context for: ${repoRoot}`));
  controller
    .start(signal => RepovineRuntime.create(repoRoot, artifactsDir, processState.cfg, { hooks: controller, signal }))
    .catch(err => {
      console.error('[FATAL] repovine build failed:', (err as Error).message);
    });
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
