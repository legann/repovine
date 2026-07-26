// Config templates for `setup` CLI subcommand.
// Stored as template strings -- they end up in dist/ alongside the JS.

import { REPOVINE_MCP_SERVER_NAME } from './merge-config.js';
import { renderMainAgentProtocolSection, renderContextQualityGuidance } from './agent-projection.js';
import {
  CLIENT_CAPABILITIES,
  hookDispatcherPath,
  shellHookCommand,
  type ClientId,
  type HookAction,
} from './client-capabilities.js';
import { CLIENT_DISPATCHER_FILENAME } from './dispatcher/index.js';

/**
 * How a generated MCP config launches the engine.
 * Default (consumer): the published package via `npx`. Self-dogfood (a contributor
 * running their own built `dist/` from the repovine source repo): the local node
 * binary + dist entry, so the MCP exercises their checkout instead of silently
 * pulling the published version. See resolveMcpLauncher in init.ts.
 */
export interface McpLauncher {
  command: string;
  args: string[];
}

/** Default consumer launcher: published package via npx. */
export const NPX_LAUNCHER: McpLauncher = { command: 'npx', args: ['-y', 'repovine'] };

function buildJsonMcpServer(client: ClientId, launcher: McpLauncher): Record<string, unknown> {
  const mcp = CLIENT_CAPABILITIES[client].mcp;
  return {
    // Emitted first when the client's MCP schema requires it (Cursor).
    ...(mcp.stdioTypeField === 'required' ? { type: 'stdio' } : {}),
    command: launcher.command,
    args: [...launcher.args],
    env: { REPOVINE_ROOT: mcp.projectRootValue },
  };
}

export function buildCursorMcpServer(launcher: McpLauncher = NPX_LAUNCHER): Record<string, unknown> {
  return buildJsonMcpServer('cursor', launcher);
}

export function buildClaudeMcpServer(launcher: McpLauncher = NPX_LAUNCHER): Record<string, unknown> {
  return buildJsonMcpServer('claude', launcher);
}

export function buildCursorMcpJson(launcher: McpLauncher = NPX_LAUNCHER): string {
  return JSON.stringify({ mcpServers: { [REPOVINE_MCP_SERVER_NAME]: buildCursorMcpServer(launcher) } }, null, 2) + '\n';
}

export function buildClaudeMcpJson(launcher: McpLauncher = NPX_LAUNCHER): string {
  return JSON.stringify({ mcpServers: { [REPOVINE_MCP_SERVER_NAME]: buildClaudeMcpServer(launcher) } }, null, 2) + '\n';
}

// npx defaults (consumed by clear.ts, plugin-render.ts, and as the setup default).
export const CURSOR_MCP_JSON = buildCursorMcpJson();
export const CLAUDE_MCP_JSON = buildClaudeMcpJson();

export const REPOVINE_CONFIG_JSON = JSON.stringify(
  {
    workspace: {
      annotationsFile: 'repovine.annots.json',
    },
    build: {
      scan: {
        include: [],
        exclude: [],
      },
      linking: {
        handlers: {
          searchRoots: [],
        },
        bundles: {
          scripts: [],
          autoDetect: true,
        },
        containers: {
          dockerfileRoots: [],
        },
      },
    },
    mcp: {
      verbose: false,
      response: {
        mode: 'concise',
        pretty: false,
      },
    },
    // Fuzzy NL entry for search_context. Omitted on purpose: with no value here the engine follows
    // whether the optional `@huggingface/transformers` peer resolves. Set it explicitly to force
    // either behaviour — `true` also turns a missing peer into an actionable install error.
    // Config block for the architecture analyzers behind the `analyze_architecture`
    // MCP tool. The engine only reports candidates; it never refactors code.
    //
    // strictness: "loose" | "normal" | "strict" (default "normal").
    //   "loose"  -> more findings, lower signal/noise (catches smaller cases).
    //   "normal" -> calibrated defaults.
    //   "strict" -> fewer findings, higher confidence.
    //
    // Optional `thresholds.<category>.<knob>` lets you override individual
    // values on top of the preset. Add only when one knob doesn't fit the
    // preset for your repo. Tunable categories:
    //   duplicateLike, godModule, godDomain, lowCohesion, flowConvergence,
    //   effectSpaghetti, propDrillingOrchestration, serviceWrapperExplosion, uiDomainCoupling,
    //   routeConvergence, annotationRisk, unclearArchitecture, secretConfigBoundary,
    //   authorizationPolicyDrift, trustBoundaryValidation, privilegedClientSideEffect,
    //   sensitiveBrowserStorage, serverClientBoundary, sourceDisclosureSurface,
    //   annotationSecretHygiene.
    analyze_architecture: {
      strictness: 'normal',
      thresholds: {},
    },
  },
  null,
  2,
) + '\n';

/** Starter shape -- customize domains, excludes, and package grouping for your repo. */
export const REPOVINE_DOMAINS_JSON = JSON.stringify(
  {
    domains: {},
    infra: { excludeSuffixes: [], excludePatterns: [] },
    basename: { files: { include: [], exclude: [] } },
    packages: { enabled: true, exclude: [], rename: {}, merge: {} },
    structuralDirs: [],
  },
  null,
  2,
) + '\n';

/** Appended to an existing Codex config when merging (no file header). */
export function buildCodexMcpServerBlock(launcher: McpLauncher = NPX_LAUNCHER): string {
  const argsToml = launcher.args.map(a => JSON.stringify(a)).join(', ');
  return `# repovine MCP (added by: npx repovine setup codex)
[mcp_servers.repovine]
command = ${JSON.stringify(launcher.command)}
args = [${argsToml}]

[mcp_servers.repovine.env]
REPOVINE_ROOT = ${JSON.stringify(CLIENT_CAPABILITIES.codex.mcp.projectRootValue)}
`;
}

export const CODEX_MCP_SERVER_BLOCK = buildCodexMcpServerBlock();

export const CODEX_HOOKS_BEGIN_MARKER = '# BEGIN repovine hooks';
export const CODEX_HOOKS_END_MARKER = '# END repovine hooks';

/** Per-event wiring of the Codex hooks block (rendering data for buildCodexHooksBlock). */
interface CodexHookRow {
  event: 'PreToolUse' | 'PostToolUse' | 'SessionStart';
  matcher: string;
  action: HookAction;
  timeout: number;
  statusMessage: string;
}

const CODEX_HOOK_ROWS: readonly CodexHookRow[] = [
  {
    event: 'PreToolUse',
    matcher: 'Edit|Write|NotebookEdit|apply_patch',
    action: 'boundary-notice',
    timeout: 5,
    statusMessage: 'Checking repovine boundary surface',
  },
  {
    event: 'PostToolUse',
    matcher: 'Edit|Write|NotebookEdit|apply_patch|Bash',
    action: 'stale-graph-notice',
    timeout: 5,
    statusMessage: 'Checking repovine graph freshness',
  },
  {
    event: 'SessionStart',
    matcher: 'startup|resume|clear',
    action: 'session-mcp-hint',
    timeout: 5,
    statusMessage: 'Loading repovine MCP reminder',
  },
];

/**
 * Windows alternate for the project-scope Codex hook command. cmd.exe cannot
 * evaluate `$(git rev-parse --show-toplevel)`; the dispatcher resolves the repo
 * root itself by walking up to `.repovine`, so a workspace-relative path
 * suffices. Verification on a real Windows Codex client is pending.
 */
function codexProjectWindowsCommand(action: HookAction): string {
  return `node "${CLIENT_CAPABILITIES.codex.hooks.projectScriptsDir}/${CLIENT_DISPATCHER_FILENAME}" ${action} codex`;
}

/** TOML literal string (single quotes) — the hook commands contain double quotes. */
function tomlLiteralString(value: string): string {
  if (value.includes("'")) {
    throw new Error(`TOML literal string cannot contain a single quote: ${value}`);
  }
  return `'${value}'`;
}

export function buildCodexHooksBlock(): string {
  const stanzas = CODEX_HOOK_ROWS.map(row => [
    `[[hooks.${row.event}]]`,
    `matcher = ${JSON.stringify(row.matcher)}`,
    '',
    `[[hooks.${row.event}.hooks]]`,
    'type = "command"',
    `command = ${tomlLiteralString(shellHookCommand('codex', 'project', row.action))}`,
    `command_windows = ${tomlLiteralString(codexProjectWindowsCommand(row.action))}`,
    `timeout = ${row.timeout}`,
    `statusMessage = ${JSON.stringify(row.statusMessage)}`,
  ].join('\n'));
  return `# repovine hooks (managed by: npx repovine setup codex)\n${CODEX_HOOKS_BEGIN_MARKER}\n${stanzas.join('\n\n')}\n${CODEX_HOOKS_END_MARKER}\n`;
}

export const CODEX_HOOKS_BLOCK = buildCodexHooksBlock();

export function buildCodexConfigToml(launcher: McpLauncher = NPX_LAUNCHER): string {
  return `#:schema https://developers.openai.com/codex/config-schema.json
#
# repovine MCP server -- structural & semantic repository context for AI agents.
# Generated by: npx repovine setup codex
# Agent docs: AGENTS.md is the quick reference; full tool descriptions are in MCP tools/list.

project_doc_max_bytes = 65536

${buildCodexMcpServerBlock(launcher)}
${CODEX_HOOKS_BLOCK}`;
}

export const CODEX_CONFIG_TOML = buildCodexConfigToml();

export type CursorHookEvent = 'preToolUse' | 'afterFileEdit' | 'afterShellExecution' | 'sessionStart';

/** Per-event wiring of the Cursor hooks config (rendering data for buildCursorHooksSettings). */
const CURSOR_HOOK_ROWS: ReadonlyArray<{ event: CursorHookEvent; action: HookAction }> = [
  { event: 'preToolUse', action: 'boundary-notice' },
  { event: 'afterFileEdit', action: 'stale-graph-notice' },
  { event: 'afterShellExecution', action: 'stale-graph-notice' },
  { event: 'sessionStart', action: 'session-mcp-hint' },
];

export interface CursorHooksSettings {
  version: number;
  hooks: Record<CursorHookEvent, Array<{ command: string }>>;
}

/** Cursor `.cursor/hooks.json` shape: shell-string commands, workspace-relative paths. */
export function buildCursorHooksSettings(): CursorHooksSettings {
  const hooks = {} as CursorHooksSettings['hooks'];
  for (const row of CURSOR_HOOK_ROWS) {
    (hooks[row.event] ??= []).push({ command: shellHookCommand('cursor', 'project', row.action) });
  }
  return { version: 1, hooks };
}

export const CURSOR_HOOKS_SETTINGS = buildCursorHooksSettings();

export type ClaudeHookEvent = 'PreToolUse' | 'PostToolUse' | 'SessionStart';

/** Per-event wiring of the Claude hooks settings (rendering data for buildClaudeHooksSettings). */
const CLAUDE_HOOK_ROWS: ReadonlyArray<{ event: ClaudeHookEvent; matcher?: string; action: HookAction }> = [
  { event: 'PreToolUse', matcher: 'Edit|Write|NotebookEdit', action: 'boundary-notice' },
  { event: 'PostToolUse', matcher: 'Edit|Write|NotebookEdit|Bash', action: 'stale-graph-notice' },
  { event: 'SessionStart', action: 'session-mcp-hint' },
];

export interface ClaudeHookExec {
  type: 'command';
  command: string;
  args: string[];
}

export interface ClaudeHookEntry {
  matcher?: string;
  hooks: ClaudeHookExec[];
}

export type ClaudeHooksSettings = Record<ClaudeHookEvent, ClaudeHookEntry[]>;

/**
 * Claude hooks settings in exec form: `command: 'node'` plus `args`. Claude
 * spawns the command directly (no shell) when `args` is present and
 * substitutes `${VAR}` references in command/args itself, so no `shell` field
 * is emitted. `scope` selects the root the dispatcher path is anchored to:
 * `${CLAUDE_PROJECT_DIR}` (project settings) or `${CLAUDE_PLUGIN_ROOT}`
 * (plugin bundle).
 */
export function buildClaudeHooksSettings(scope: 'project' | 'plugin'): ClaudeHooksSettings {
  const settings = {} as ClaudeHooksSettings;
  for (const row of CLAUDE_HOOK_ROWS) {
    const hook: ClaudeHookExec = {
      type: 'command',
      command: 'node',
      args: [hookDispatcherPath('claude', scope), row.action, 'claude'],
    };
    // `matcher` is absent (not undefined-valued) on SessionStart entries.
    const entry: ClaudeHookEntry = row.matcher !== undefined
      ? { matcher: row.matcher, hooks: [hook] }
      : { hooks: [hook] };
    (settings[row.event] ??= []).push(entry);
  }
  return settings;
}

export const CLAUDE_HOOKS_SETTINGS = buildClaudeHooksSettings('project');

export const AGENTS_MD_BEGIN_MARKER = '<!-- repovine:agents-md:begin -->';
export const AGENTS_MD_END_MARKER = '<!-- repovine:agents-md:end -->';

export const AGENTS_MD = `${AGENTS_MD_BEGIN_MARKER}
# repovine -- quick reference

This managed block is intentionally short for Claude Code and Codex. Detailed workflows live in the generated skills, agent files, and hooks so this always-on file does not compete with project instructions.

## Start

Before non-trivial work, call the \`repovine\` MCP server first. Use \`search_context\` when the task wording is fuzzy, \`map_context\` when a domain/package/module is named, then \`inspect_node\` after narrowing. Skip this only for trivial single-file tasks.

If the MCP call fails with a connection error, the server is not running. Ask the user to check the MCP config. Do not fall back to blind file reading -- without the graph you lack structure and dependency info.

If a tool returns \`status:"building"\`, call \`get_build_status({ "waitSec": 45 })\` once instead of polling. \`stage_eta_sec\` estimates only the current stage; use \`stage\` and \`remaining_stages\` to report progress. If the long-poll still returns building, continue with direct file reads only when the task can proceed without graph structure. To abandon a cold build, call \`get_build_status({ "cancel": true })\`; it stops Stage 1 workers and returns \`cancelled\` (no graph) or keeps a prior \`ready\` graph.

${renderContextQualityGuidance()}

## Working loop

- Orient/map/inspect: \`search_context\`, \`map_context\`, \`inspect_node\`.
- Follow the task axis: runtime/user flow -> \`get_entrypoints\` + \`trace_flow\`; shared contracts -> \`analyze_dependencies\`; env/resources -> \`get_config_surface\`; architecture/review candidates -> \`analyze_architecture\`; annotation health -> \`get_annotation_status\`.
- After code edits, call \`refresh_context({})\`. After changing \`repovine.config.json\`, call \`refresh_context({ "reloadConfig": true })\` so the running MCP process re-reads config and rebuilds the graph. Changing \`repovine.domains.json\` is picked up by a normal refresh; using \`reloadConfig: true\` is harmless when both files changed.
- Never hand-edit \`repovine.annots.json\`. Use \`write_annotation\`, \`merge_annotations\`, \`validate_annotations\`, or \`refresh_context({ "cleanupOrphans": true })\`.

## Public MCP tools

- Orient/map/inspect: \`search_context\`, \`map_context\`, \`inspect_node\`
- Runtime/user flow: \`get_entrypoints\`, \`trace_flow\`
- Contracts/packages: \`analyze_dependencies\`
- Env/secrets/resources: \`get_config_surface\`
- Architecture candidates: \`analyze_architecture\`
- Annotation health/writes: \`get_annotation_status\` (view \`carrier-gaps\` pages carrier-link candidates by SSOT target), \`get_annotation_merge_status\`, \`merge_annotations\`, \`validate_annotations\`, \`write_annotation\`
- Domains advisor: \`suggest_domains_config\`
- Advisory declines: \`decline_advisory\` (kind: \`domains-config\` | \`carrier-link-gaps\`; workspace-local state)
- Sync/status/handoff audit: \`refresh_context\`, \`get_build_status\` (pass \`cancel:true\` to stop an in-flight build), \`get_context_session_quality\`

## Detailed workflows

Use generated skills for the longer procedures:

- \`repovine-workflow\`: implementation flow and post-edit checks.
- \`repovine-refresh\`: build status, refresh, config reload, domains suggestions, orphan cleanup.
- \`repovine-status\`: graph and annotation status.
- \`repovine-review\`: code review and architecture audit.
- \`repovine-annotations\`: annotation onboarding, merge repair, sideEffects vocabulary, and quality/provenance rules.

Claude uses \`.claude/agents/*.md\` and \`.claude/skills/*/SKILL.md\`. Codex uses \`.codex/agents/*.toml\` and \`.agents/skills/*/SKILL.md\`. Cursor uses \`.cursor/rules\` and does not rely on this \`AGENTS.md\` surface.

## Artifacts

| File | Git | Purpose |
|---|---|---|
| \`repovine.annots.json\` | Commit | Shared annotation memory between agents/sessions (workspace root). |
| \`repovine.config.json\` | Commit | Graph build (\`build.scan\`, \`build.linking\`), MCP/analyzer settings (workspace root). |
| \`repovine.domains.json\` | Commit | Domain patterns and package grouping (workspace root). |
| \`.repovine/\` | Ignore | Local engine cache (snapshot, graph dumps, build calibration). |

Commit \`repovine.annots.json\`. Never store secrets in annotations; the engine records env var names, not values, and rejects obvious secret values written through \`write_annotation\`.

${renderMainAgentProtocolSection()}
${AGENTS_MD_END_MARKER}
`;

/** Claude Code project instructions -- points at AGENTS.md (same content as init codex/claude). */
export const CLAUDE_MD = `@AGENTS.md

Thin repovine bootstrap: **AGENTS.md**. Detailed workflows live in \`.claude/skills/*/SKILL.md\` and \`.claude/agents/*.md\`. Full tool/config reference: \`repovine/README.md\` when present, else MCP **tools/list** on \`repovine\`.
`;
