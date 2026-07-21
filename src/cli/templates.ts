// Config templates for `setup` CLI subcommand.
// Stored as template strings -- they end up in dist/ alongside the JS.

import { REPOVINE_MCP_SERVER_NAME } from './merge-config.js';
import { renderMainAgentProtocolSection, renderContextQualityGuidance } from './agent-projection.js';

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

export function buildCursorMcpServer(launcher: McpLauncher = NPX_LAUNCHER): Record<string, unknown> {
  return { command: launcher.command, args: [...launcher.args], env: { REPOVINE_ROOT: '${workspaceFolder}' } };
}

export function buildClaudeMcpServer(launcher: McpLauncher = NPX_LAUNCHER): Record<string, unknown> {
  return { command: launcher.command, args: [...launcher.args], env: { REPOVINE_ROOT: '.' } };
}

export function buildCursorMcpJson(launcher: McpLauncher = NPX_LAUNCHER): string {
  return JSON.stringify({ mcpServers: { [REPOVINE_MCP_SERVER_NAME]: buildCursorMcpServer(launcher) } }, null, 2) + '\n';
}

export function buildClaudeMcpJson(launcher: McpLauncher = NPX_LAUNCHER): string {
  return JSON.stringify({ mcpServers: { [REPOVINE_MCP_SERVER_NAME]: buildClaudeMcpServer(launcher) } }, null, 2) + '\n';
}

// Backward-compatible npx defaults (consumed by clear.ts, plugin-render.ts, and as the setup default).
export const REPOVINE_MCP_SERVER_CURSOR = buildCursorMcpServer();
export const REPOVINE_MCP_SERVER_CLAUDE = buildClaudeMcpServer();
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
    // Fuzzy NL entry for search_context (optional `@huggingface/transformers`).
    semantic_search_embeddings: true,
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

const DOMAINS_ADVISOR_AGENT_CONTRACT =
  'When get_build_status or refresh_context reports domainsSuggestions.count > 0, call suggest_domains_config; never auto-apply. With user approval, write a repovine.domains.json preview and call refresh_context: accept = write the mergedConfig (exclude), keep = write the keepConfig (committed infra.keep marker — keeps the resource visible and stops the suggestion); for skip/hide, call decline_advisory({ "kind": "domains-config" }) so ids are stored in .repovine/onboarding-state.json.';

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
REPOVINE_ROOT = "."
`;
}

export const CODEX_MCP_SERVER_BLOCK = buildCodexMcpServerBlock();

export const CODEX_HOOKS_BEGIN_MARKER = '# BEGIN repovine hooks';
export const CODEX_HOOKS_END_MARKER = '# END repovine hooks';

export const CODEX_HOOKS_BLOCK = `# repovine hooks (managed by: npx repovine setup codex)
${CODEX_HOOKS_BEGIN_MARKER}
[[hooks.PreToolUse]]
matcher = "Edit|Write|NotebookEdit|apply_patch"

[[hooks.PreToolUse.hooks]]
type = "command"
command = 'node "$(git rev-parse --show-toplevel)/.codex/hooks/boundary-notice.js"'
timeout = 5
statusMessage = "Checking repovine boundary surface"

[[hooks.PostToolUse]]
matcher = "Edit|Write|NotebookEdit|apply_patch|Bash"

[[hooks.PostToolUse.hooks]]
type = "command"
command = 'node "$(git rev-parse --show-toplevel)/.codex/hooks/stale-graph-notice.js"'
timeout = 5
statusMessage = "Checking repovine graph freshness"

[[hooks.SessionStart]]
matcher = "startup|resume|clear"

[[hooks.SessionStart.hooks]]
type = "command"
command = 'node "$(git rev-parse --show-toplevel)/.codex/hooks/session-mcp-hint.js"'
timeout = 5
statusMessage = "Loading repovine MCP reminder"
${CODEX_HOOKS_END_MARKER}
`;

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

export const CODEX_STALE_GRAPH_NOTICE_JS = `#!/usr/bin/env node
// PostToolUse hook for Edit|Write|NotebookEdit/apply_patch/Bash.
// Reminds the agent that the repovine graph is stale and must be
// refreshed before structural navigation or annotation writes.

let raw = '';
process.stdin.on('data', chunk => { raw += chunk; });
async function annotationConflictHint() {
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { dirname, join, resolve } = await import('node:path');
    const findRoot = start => {
      let dir = resolve(start || process.cwd());
      for (;;) {
        if (existsSync(join(dir, '.repovine'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return resolve(start || process.cwd());
        dir = parent;
      }
    };
    const root = findRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const readAnnotationsRel = rootDir => {
      try {
        const envRel = process.env.REPOVINE_ANNOTATIONS_FILE;
        if (typeof envRel === 'string' && envRel.trim()) return envRel.trim();
        const cfgPath = join(rootDir, 'repovine.config.json');
        if (existsSync(cfgPath)) {
          const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
          const rel = cfg?.workspace?.annotationsFile;
          if (typeof rel === 'string' && rel.trim()) return rel.trim();
        }
      } catch {}
      return 'repovine.annots.json';
    };
    const rel = readAnnotationsRel(root);
    const filePath = join(root, rel);
    const hasMarkers = existsSync(filePath) && /^(<<<<<<<|=======|>>>>>>>) ?/m.test(readFileSync(filePath, 'utf-8'));
    if (!hasMarkers) return '';
    return 'repovine: ' + rel + ' contains conflict markers. ' +
      'Do not resolve the JSON by hand. Call the repovine MCP tools: get_annotation_merge_status, merge_annotations, validate_annotations. ' +
      'CLI fallback: npx repovine annotations merge && npx repovine annotations validate.';
  } catch {
    return '';
  }
}

async function onboardingStateHint() {
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { dirname, join, resolve } = await import('node:path');
    const findRoot = start => {
      let dir = resolve(start || process.cwd());
      for (;;) {
        if (existsSync(join(dir, '.repovine'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return resolve(start || process.cwd());
        dir = parent;
      }
    };
    const root = findRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const filePath = join(root, '.repovine', 'onboarding-state.json');
    if (!existsSync(filePath)) return '';
    const state = JSON.parse(readFileSync(filePath, 'utf-8'));
    return ' Onboarding state: ' + JSON.stringify({
      graph: state.graph,
      onboarding: state.onboarding
    }) + '.';
  } catch {
    return '';
  }
}

process.stdin.on('end', async () => {
  let data;
  try { data = JSON.parse(raw || '{}'); } catch { process.exit(0); }

  const paths = [];
  const ti = data && data.tool_input;
  if (ti && typeof ti.file_path === 'string') paths.push(ti.file_path);

  const patchText = ti && (ti.input || ti.patch || ti.command);
  if (typeof patchText === 'string') {
    const re = /^\\*\\*\\* (?:Update|Add|Delete) File:\\s*(.+)$/gm;
    let m;
    while ((m = re.exec(patchText)) !== null) paths.push(m[1].trim());
  }

  const commandText = ti && typeof ti.command === 'string' ? ti.command : '';
  const isGitMergeCommand = /\\bgit\\s+(merge|pull|rebase|cherry-pick)\\b/.test(commandText);
  if (isGitMergeCommand) {
    const hint = await annotationConflictHint();
    if (hint) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: hint
        }
      }));
      return;
    }
  }

  if (paths.length === 0) process.exit(0);

  const isEngineOwned = p =>
    /[\\\\/]\\.repovine[\\\\/]/.test(p) ||
    /(?:^|[\\\\/])\\.repovine\\.[^\\\\/]+$/.test(p) ||
    /(?:^|[\\\\/])repovine\\.(?:annots|annotations|config|domains)\\.json$/.test(p);
  const isParsed = p =>
    /\\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|tf|ya?ml)$/i.test(p) ||
    /(^|[\\\\/])Dockerfile[^\\\\/]*$/i.test(p);

  const relevant = paths.some(p => !isEngineOwned(p) && isParsed(p));
  if (!relevant) process.exit(0);

  const out = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        'repovine: syntax index is now stale after this edit. ' +
        'Before the next structural navigation, dependency analysis, or annotation write, ' +
        'call repovine MCP tool refresh_context. ' +
        'Reading individual files directly is still fine without refresh.'
    }
  };
  process.stdout.write(JSON.stringify(out));
});
`;

export const CODEX_BOUNDARY_NOTICE_JS = `#!/usr/bin/env node
// PreToolUse hook for Edit|Write|NotebookEdit|apply_patch.
// Deterministic boundary delivery: resolves the edited file to its node and, when that node carries a
// scope:"boundary" risk (recorded in .repovine/boundary-index.json by the build), surfaces the
// off-limits reason as additionalContext. Advisory, never blocking — a boundary surface is sometimes
// edited legitimately. Standalone: reads the index file, needs no running MCP server.

let raw = '';
process.stdin.on('data', chunk => { raw += chunk; });

function collectPaths(ti) {
  const paths = [];
  if (ti && typeof ti.file_path === 'string') paths.push(ti.file_path);
  if (ti && typeof ti.notebook_path === 'string') paths.push(ti.notebook_path);
  const patchText = ti && (ti.input || ti.patch || ti.command);
  if (typeof patchText === 'string') {
    const re = /^\\*\\*\\* (?:Update|Add|Delete) File:\\s*(.+)$/gm;
    let m;
    while ((m = re.exec(patchText)) !== null) paths.push(m[1].trim());
  }
  return paths;
}

function buildAdvisory(blocks) {
  const lines = ['repovine boundary advisory — the file(s) you are editing carry scope:"boundary" annotations (off-limits surface: published contract, frozen migration, or structural slot).'];
  for (const block of blocks) {
    lines.push(block.relPath + ':');
    for (const entry of block.entries) {
      const who = entry.label ? entry.label + ' [' + entry.nodeId + ']' : entry.nodeId;
      for (const risk of (entry.risks || [])) lines.push('  - ' + who + ': ' + risk);
    }
  }
  lines.push('Editing a boundary surface is legitimate for a real fix in the surface itself. If this change would alter the contract, re-plan to the consumer / write path instead of editing the frozen surface in place.');
  return lines.join('\\n');
}

process.stdin.on('end', async () => {
  let data;
  try { data = JSON.parse(raw || '{}'); } catch { process.exit(0); }

  const ti = data && data.tool_input;
  const paths = collectPaths(ti);
  if (paths.length === 0) process.exit(0);

  const { existsSync, readFileSync } = await import('node:fs');
  const { dirname, join, resolve, isAbsolute, relative } = await import('node:path');

  const findRoot = start => {
    let dir = resolve(start || process.cwd());
    for (;;) {
      if (existsSync(join(dir, '.repovine'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) return resolve(start || process.cwd());
      dir = parent;
    }
  };
  const startDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = findRoot(startDir);

  let index;
  try {
    const filePath = join(root, '.repovine', 'boundary-index.json');
    if (!existsSync(filePath)) process.exit(0);
    index = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch { process.exit(0); }
  if (!index || typeof index !== 'object') process.exit(0);
  const entriesOk = index.entries && typeof index.entries === 'object';
  if (index.version !== 1) {
    // Schema drift: the engine emits a newer index than this installed hook understands. Fail LOUD
    // (actionable notice) instead of silently disabling the channel. Only when the index is otherwise
    // well-formed; a corrupt newer index stays silent like any other malformed file.
    if (entriesOk) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext:
            'repovine: boundary index schema (v' + index.version + ') is newer than this pre-edit hook; '
            + 'run "npx repovine setup" to refresh it. Boundary advisories are paused until then.'
        }
      }));
    }
    process.exit(0);
  }
  if (!entriesOk) process.exit(0);

  const toRel = p => relative(root, isAbsolute(p) ? p : resolve(startDir, p)).split('\\\\').join('/');

  const seen = new Set();
  const blocks = [];
  for (const p of paths) {
    const rel = toRel(p);
    if (seen.has(rel)) continue;
    seen.add(rel);
    const entries = index.entries[rel];
    if (Array.isArray(entries) && entries.length > 0) blocks.push({ relPath: rel, entries });
  }
  if (blocks.length === 0) process.exit(0);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: buildAdvisory(blocks)
    }
  }));
});
`;

export const CODEX_SESSION_MCP_HINT_JS = `#!/usr/bin/env node
// SessionStart hook. Injects a one-time hint that repovine MCP is
// available and should be the first call for any non-trivial task.

let raw = '';
process.stdin.on('data', chunk => { raw += chunk; });
async function annotationConflictHint() {
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { dirname, join, resolve } = await import('node:path');
    const findRoot = start => {
      let dir = resolve(start || process.cwd());
      for (;;) {
        if (existsSync(join(dir, '.repovine'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return resolve(start || process.cwd());
        dir = parent;
      }
    };
    const root = findRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const readAnnotationsRel = rootDir => {
      try {
        const envRel = process.env.REPOVINE_ANNOTATIONS_FILE;
        if (typeof envRel === 'string' && envRel.trim()) return envRel.trim();
        const cfgPath = join(rootDir, 'repovine.config.json');
        if (existsSync(cfgPath)) {
          const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
          const rel = cfg?.workspace?.annotationsFile;
          if (typeof rel === 'string' && rel.trim()) return rel.trim();
        }
      } catch {}
      return 'repovine.annots.json';
    };
    const rel = readAnnotationsRel(root);
    const filePath = join(root, rel);
    const hasMarkers = existsSync(filePath) && /^(<<<<<<<|=======|>>>>>>>) ?/m.test(readFileSync(filePath, 'utf-8'));
    if (!hasMarkers) return '';
    return ' Annotation maintenance: ' + rel + ' currently contains conflict markers. ' +
      'Before annotation work, call the repovine MCP tools: get_annotation_merge_status, merge_annotations, validate_annotations. ' +
      'CLI fallback: npx repovine annotations merge && npx repovine annotations validate.';
  } catch {
    return '';
  }
}

async function onboardingStateHint() {
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { dirname, join, resolve } = await import('node:path');
    const findRoot = start => {
      let dir = resolve(start || process.cwd());
      for (;;) {
        if (existsSync(join(dir, '.repovine'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return resolve(start || process.cwd());
        dir = parent;
      }
    };
    const root = findRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const filePath = join(root, '.repovine', 'onboarding-state.json');
    if (!existsSync(filePath)) return '';
    const state = JSON.parse(readFileSync(filePath, 'utf-8'));
    return ' Onboarding state: ' + JSON.stringify({
      graph: state.graph,
      onboarding: state.onboarding
    }) + '.';
  } catch {
    return '';
  }
}

process.stdin.on('end', async () => {
  let data;
  try { data = JSON.parse(raw || '{}'); } catch { data = {}; }

  if (data.source === 'compact') process.exit(0);
  const conflictHint = await annotationConflictHint();
  const onboardingHint = await onboardingStateHint();

  const out = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        'repovine MCP is available (server name: repovine). ' +
        'For any non-trivial task, START with repovine MCP tools search_context or map_context; do not grep or read files first. ' +
        'The MCP provides structure, annotations, entrypoints, dependency analysis, config surface, and flow tracing. ' +
        'After editing files, call repovine MCP tool refresh_context to refresh the syntax index before further structural navigation. ' +
        'Build state: tool calls received before the graph finishes building return a successful response (not an error) with status:"building" and an eta_sec; ' +
        'do not retry in a loop — call get_build_status with waitSec (e.g. { waitSec: 45 }) to long-poll until the build settles, respect retry_after_sec, and fall back to direct file reads when eta_sec >= 60. ' +
        ${JSON.stringify(DOMAINS_ADVISOR_AGENT_CONTRACT)} +
        onboardingHint +
        conflictHint
    }
  };
  process.stdout.write(JSON.stringify(out));
});
`;

export const CLAUDE_STALE_GRAPH_NOTICE_JS = CODEX_STALE_GRAPH_NOTICE_JS;
export const CLAUDE_SESSION_MCP_HINT_JS = CODEX_SESSION_MCP_HINT_JS;
export const CLAUDE_BOUNDARY_NOTICE_JS = CODEX_BOUNDARY_NOTICE_JS;

export const CURSOR_STALE_GRAPH_NOTICE_JS = `#!/usr/bin/env node
// Cursor project hook for afterFileEdit / afterShellExecution.
// Reminds the agent that the repovine graph is stale after graph-relevant
// edits, and detects annotation conflict markers after pull/merge/rebase commands.

let raw = '';
process.stdin.on('data', chunk => { raw += chunk; });

function firstString(...values) {
  return values.find(value => typeof value === 'string' && value.length > 0) || '';
}

function resolveRoot(data) {
  const workspaceRoots = Array.isArray(data.workspace_roots) ? data.workspace_roots : data.workspaceRoots;
  return firstString(
    process.env.CURSOR_WORKSPACE_ROOT,
    process.env.CLAUDE_PROJECT_DIR,
    Array.isArray(workspaceRoots) ? workspaceRoots[0] : '',
    data.workspace_root,
    data.workspaceRoot,
    data.cwd,
    process.cwd(),
  );
}

async function annotationConflictHint(data) {
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { dirname, join, resolve } = await import('node:path');
    const findRoot = start => {
      let dir = resolve(start || process.cwd());
      for (;;) {
        if (existsSync(join(dir, '.repovine'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return resolve(start || process.cwd());
        dir = parent;
      }
    };
    const root = findRoot(resolveRoot(data));
    const readAnnotationsRel = rootDir => {
      try {
        const envRel = process.env.REPOVINE_ANNOTATIONS_FILE;
        if (typeof envRel === 'string' && envRel.trim()) return envRel.trim();
        const cfgPath = join(rootDir, 'repovine.config.json');
        if (existsSync(cfgPath)) {
          const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
          const rel = cfg?.workspace?.annotationsFile;
          if (typeof rel === 'string' && rel.trim()) return rel.trim();
        }
      } catch {}
      return 'repovine.annots.json';
    };
    const rel = readAnnotationsRel(root);
    const filePath = join(root, rel);
    const hasMarkers = existsSync(filePath) && /^(<<<<<<<|=======|>>>>>>>) ?/m.test(readFileSync(filePath, 'utf-8'));
    if (!hasMarkers) return '';
    return 'repovine: ' + rel + ' contains conflict markers. ' +
      'Do not resolve the JSON by hand. Call the repovine MCP tools: get_annotation_merge_status, merge_annotations, validate_annotations. ' +
      'CLI fallback: npx repovine annotations merge && npx repovine annotations validate.';
  } catch {
    return '';
  }
}

async function onboardingStateHint(data) {
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { dirname, join, resolve } = await import('node:path');
    const findRoot = start => {
      let dir = resolve(start || process.cwd());
      for (;;) {
        if (existsSync(join(dir, '.repovine'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return resolve(start || process.cwd());
        dir = parent;
      }
    };
    const root = findRoot(resolveRoot(data));
    const filePath = join(root, '.repovine', 'onboarding-state.json');
    if (!existsSync(filePath)) return '';
    const state = JSON.parse(readFileSync(filePath, 'utf-8'));
    return ' Onboarding state: ' + JSON.stringify({
      graph: state.graph,
      onboarding: state.onboarding
    }) + '.';
  } catch {
    return '';
  }
}

function emit(eventName, message) {
  process.stdout.write(JSON.stringify({
    additional_context: message,
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: message
    }
  }));
}

function collectPaths(data) {
  const paths = [];
  const ti = data && data.tool_input;
  for (const source of [data, ti]) {
    if (!source || typeof source !== 'object') continue;
    if (typeof source.file_path === 'string') paths.push(source.file_path);
    if (typeof source.filePath === 'string') paths.push(source.filePath);
    if (typeof source.path === 'string') paths.push(source.path);
    for (const key of ['files', 'paths', 'changedFiles']) {
      const value = source[key];
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (typeof item === 'string') paths.push(item);
        else if (item && typeof item.path === 'string') paths.push(item.path);
        else if (item && typeof item.file_path === 'string') paths.push(item.file_path);
      }
    }
  }

  const patchText = firstString(
    ti && ti.input,
    ti && ti.patch,
    ti && ti.command,
    data && data.input,
    data && data.patch,
    data && data.command,
  );
  if (patchText) {
    const re = /^\\*\\*\\* (?:Update|Add|Delete) File:\\s*(.+)$/gm;
    let m;
    while ((m = re.exec(patchText)) !== null) paths.push(m[1].trim());
  }
  return paths;
}

process.stdin.on('end', async () => {
  let data;
  try { data = JSON.parse(raw || '{}'); } catch { process.exit(0); }

  const ti = data && data.tool_input;
  const commandText = firstString(
    data && data.command,
    data && data.shell_command,
    ti && ti.command,
  );
  const isGitMergeCommand = /\\bgit\\s+(merge|pull|rebase|cherry-pick)\\b/.test(commandText);
  if (isGitMergeCommand) {
    const hint = await annotationConflictHint(data);
    if (hint) {
      emit('afterShellExecution', hint);
      return;
    }
  }

  const paths = collectPaths(data);
  if (paths.length === 0) process.exit(0);

  const isEngineOwned = p =>
    /[\\\\/]\\.repovine[\\\\/]/.test(p) ||
    /(?:^|[\\\\/])\\.repovine\\.[^\\\\/]+$/.test(p) ||
    /(?:^|[\\\\/])repovine\\.(?:annots|annotations|config|domains)\\.json$/.test(p);
  const isParsed = p =>
    /\\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|tf|ya?ml)$/i.test(p) ||
    /(^|[\\\\/])Dockerfile[^\\\\/]*$/i.test(p);

  const relevant = paths.some(p => !isEngineOwned(p) && isParsed(p));
  if (!relevant) process.exit(0);

  emit(
    'afterFileEdit',
    'repovine: syntax index is now stale after this edit. ' +
      'Before the next structural navigation, dependency analysis, or annotation write, ' +
      'call repovine MCP tool refresh_context. ' +
      'Reading individual files directly is still fine without refresh.'
  );
});
`;

export const CURSOR_SESSION_MCP_HINT_JS = `#!/usr/bin/env node
// Cursor project hook for sessionStart. Injects a one-time reminder that the
// repovine MCP should be the first call for non-trivial tasks.

let raw = '';
process.stdin.on('data', chunk => { raw += chunk; });

function firstString(...values) {
  return values.find(value => typeof value === 'string' && value.length > 0) || '';
}

function resolveRoot(data) {
  const workspaceRoots = Array.isArray(data.workspace_roots) ? data.workspace_roots : data.workspaceRoots;
  return firstString(
    process.env.CURSOR_WORKSPACE_ROOT,
    process.env.CLAUDE_PROJECT_DIR,
    Array.isArray(workspaceRoots) ? workspaceRoots[0] : '',
    data.workspace_root,
    data.workspaceRoot,
    data.cwd,
    process.cwd(),
  );
}

async function annotationConflictHint(data) {
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { dirname, join, resolve } = await import('node:path');
    const findRoot = start => {
      let dir = resolve(start || process.cwd());
      for (;;) {
        if (existsSync(join(dir, '.repovine'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return resolve(start || process.cwd());
        dir = parent;
      }
    };
    const root = findRoot(resolveRoot(data));
    const readAnnotationsRel = rootDir => {
      try {
        const envRel = process.env.REPOVINE_ANNOTATIONS_FILE;
        if (typeof envRel === 'string' && envRel.trim()) return envRel.trim();
        const cfgPath = join(rootDir, 'repovine.config.json');
        if (existsSync(cfgPath)) {
          const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
          const rel = cfg?.workspace?.annotationsFile;
          if (typeof rel === 'string' && rel.trim()) return rel.trim();
        }
      } catch {}
      return 'repovine.annots.json';
    };
    const rel = readAnnotationsRel(root);
    const filePath = join(root, rel);
    const hasMarkers = existsSync(filePath) && /^(<<<<<<<|=======|>>>>>>>) ?/m.test(readFileSync(filePath, 'utf-8'));
    if (!hasMarkers) return '';
    return ' Annotation maintenance: ' + rel + ' currently contains conflict markers. ' +
      'Before annotation work, call the repovine MCP tools: get_annotation_merge_status, merge_annotations, validate_annotations. ' +
      'CLI fallback: npx repovine annotations merge && npx repovine annotations validate.';
  } catch {
    return '';
  }
}

async function onboardingStateHint(data) {
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { dirname, join, resolve } = await import('node:path');
    const findRoot = start => {
      let dir = resolve(start || process.cwd());
      for (;;) {
        if (existsSync(join(dir, '.repovine'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return resolve(start || process.cwd());
        dir = parent;
      }
    };
    const root = findRoot(resolveRoot(data));
    const filePath = join(root, '.repovine', 'onboarding-state.json');
    if (!existsSync(filePath)) return '';
    const state = JSON.parse(readFileSync(filePath, 'utf-8'));
    return ' Onboarding state: ' + JSON.stringify({
      graph: state.graph,
      onboarding: state.onboarding
    }) + '.';
  } catch {
    return '';
  }
}

function emit(message) {
  process.stdout.write(JSON.stringify({
    additional_context: message,
    hookSpecificOutput: {
      hookEventName: 'sessionStart',
      additionalContext: message
    }
  }));
}

process.stdin.on('end', async () => {
  let data;
  try { data = JSON.parse(raw || '{}'); } catch { data = {}; }

  if (data.source === 'compact') process.exit(0);
  const conflictHint = await annotationConflictHint(data);
  const onboardingHint = await onboardingStateHint(data);
  emit(
    'repovine MCP is available (server name: repovine). ' +
      'For any non-trivial task, START with repovine MCP tools search_context or map_context; do not grep or read files first. ' +
      'The MCP provides structure, annotations, entrypoints, dependency analysis, config surface, and flow tracing. ' +
      'After editing files, call repovine MCP tool refresh_context to refresh the syntax index before further structural navigation. ' +
      'Build state: tool calls received before the graph finishes building return a successful response (not an error) with status:"building" and an eta_sec; ' +
      'do not retry in a loop — call get_build_status with waitSec (e.g. { waitSec: 45 }) to long-poll until the build settles, respect retry_after_sec, and fall back to direct file reads when eta_sec >= 60. ' +
      ${JSON.stringify(DOMAINS_ADVISOR_AGENT_CONTRACT)} +
      onboardingHint +
      conflictHint
  );
});
`;

export const CURSOR_BOUNDARY_NOTICE_JS = `#!/usr/bin/env node
// Cursor project hook for preToolUse (Edit|Write|apply_patch tools).
// Deterministic boundary delivery: resolves the edited file to its node and, when that node carries a
// scope:"boundary" risk (recorded in .repovine/boundary-index.json by the build), surfaces the
// off-limits reason as additional_context. Advisory, never blocking. Standalone — no running server.

let raw = '';
process.stdin.on('data', chunk => { raw += chunk; });

function firstString(...values) {
  return values.find(value => typeof value === 'string' && value.length > 0) || '';
}

function resolveRoot(data) {
  const workspaceRoots = Array.isArray(data.workspace_roots) ? data.workspace_roots : data.workspaceRoots;
  return firstString(
    process.env.CURSOR_WORKSPACE_ROOT,
    process.env.CLAUDE_PROJECT_DIR,
    Array.isArray(workspaceRoots) ? workspaceRoots[0] : '',
    data.workspace_root,
    data.workspaceRoot,
    data.cwd,
    process.cwd(),
  );
}

function collectPaths(data) {
  const paths = [];
  const ti = data && data.tool_input;
  for (const source of [data, ti]) {
    if (!source || typeof source !== 'object') continue;
    if (typeof source.file_path === 'string') paths.push(source.file_path);
    if (typeof source.filePath === 'string') paths.push(source.filePath);
    if (typeof source.path === 'string') paths.push(source.path);
    if (typeof source.notebook_path === 'string') paths.push(source.notebook_path);
  }
  const patchText = firstString(
    ti && ti.input, ti && ti.patch, ti && ti.command,
    data && data.input, data && data.patch, data && data.command,
  );
  if (patchText) {
    const re = /^\\*\\*\\* (?:Update|Add|Delete) File:\\s*(.+)$/gm;
    let m;
    while ((m = re.exec(patchText)) !== null) paths.push(m[1].trim());
  }
  return paths;
}

function buildAdvisory(blocks) {
  const lines = ['repovine boundary advisory — the file(s) you are editing carry scope:"boundary" annotations (off-limits surface: published contract, frozen migration, or structural slot).'];
  for (const block of blocks) {
    lines.push(block.relPath + ':');
    for (const entry of block.entries) {
      const who = entry.label ? entry.label + ' [' + entry.nodeId + ']' : entry.nodeId;
      for (const risk of (entry.risks || [])) lines.push('  - ' + who + ': ' + risk);
    }
  }
  lines.push('Editing a boundary surface is legitimate for a real fix in the surface itself. If this change would alter the contract, re-plan to the consumer / write path instead of editing the frozen surface in place.');
  return lines.join('\\n');
}

process.stdin.on('end', async () => {
  let data;
  try { data = JSON.parse(raw || '{}'); } catch { process.exit(0); }

  const paths = collectPaths(data);
  if (paths.length === 0) process.exit(0);

  const { existsSync, readFileSync } = await import('node:fs');
  const { dirname, join, resolve, isAbsolute, relative } = await import('node:path');

  const findRoot = start => {
    let dir = resolve(start || process.cwd());
    for (;;) {
      if (existsSync(join(dir, '.repovine'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) return resolve(start || process.cwd());
      dir = parent;
    }
  };
  const startDir = resolveRoot(data);
  const root = findRoot(startDir);

  let index;
  try {
    const filePath = join(root, '.repovine', 'boundary-index.json');
    if (!existsSync(filePath)) process.exit(0);
    index = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch { process.exit(0); }
  if (!index || typeof index !== 'object') process.exit(0);
  const entriesOk = index.entries && typeof index.entries === 'object';
  if (index.version !== 1) {
    // Schema drift: fail LOUD (actionable notice) instead of silently disabling the channel; only
    // when the index is otherwise well-formed. Cursor dual-key payload.
    if (entriesOk) {
      const notice = 'repovine: boundary index schema (v' + index.version + ') is newer than this pre-edit hook; run "npx repovine setup" to refresh it. Boundary advisories are paused until then.';
      process.stdout.write(JSON.stringify({ additional_context: notice, hookSpecificOutput: { hookEventName: 'preToolUse', additionalContext: notice } }));
    }
    process.exit(0);
  }
  if (!entriesOk) process.exit(0);

  const toRel = p => relative(root, isAbsolute(p) ? p : resolve(startDir, p)).split('\\\\').join('/');

  const seen = new Set();
  const blocks = [];
  for (const p of paths) {
    const rel = toRel(p);
    if (seen.has(rel)) continue;
    seen.add(rel);
    const entries = index.entries[rel];
    if (Array.isArray(entries) && entries.length > 0) blocks.push({ relPath: rel, entries });
  }
  if (blocks.length === 0) process.exit(0);

  const message = buildAdvisory(blocks);
  process.stdout.write(JSON.stringify({
    additional_context: message,
    hookSpecificOutput: {
      hookEventName: 'preToolUse',
      additionalContext: message
    }
  }));
});
`;

export const CURSOR_HOOKS_SETTINGS = {
  version: 1,
  hooks: {
    preToolUse: [
      {
        command: 'node ".cursor/hooks/boundary-notice.js"',
      },
    ],
    afterFileEdit: [
      {
        command: 'node ".cursor/hooks/stale-graph-notice.js"',
      },
    ],
    afterShellExecution: [
      {
        command: 'node ".cursor/hooks/stale-graph-notice.js"',
      },
    ],
    sessionStart: [
      {
        command: 'node ".cursor/hooks/session-mcp-hint.js"',
      },
    ],
  },
} as const;

export const CLAUDE_HOOKS_SETTINGS = {
  PreToolUse: [
    {
      matcher: 'Edit|Write|NotebookEdit',
      hooks: [
        {
          type: 'command',
          command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/boundary-notice.js"',
        },
      ],
    },
  ],
  PostToolUse: [
    {
      matcher: 'Edit|Write|NotebookEdit|Bash',
      hooks: [
        {
          type: 'command',
          command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/stale-graph-notice.js"',
        },
      ],
    },
  ],
  SessionStart: [
    {
      hooks: [
        {
          type: 'command',
          command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/session-mcp-hint.js"',
        },
      ],
    },
  ],
} as const;

export const AGENTS_MD_BEGIN_MARKER = '<!-- repovine:agents-md:begin -->';
export const AGENTS_MD_END_MARKER = '<!-- repovine:agents-md:end -->';

export const AGENTS_MD = `${AGENTS_MD_BEGIN_MARKER}
# repovine -- quick reference

This managed block is intentionally short for Claude Code and Codex. Detailed workflows live in the generated skills, agent files, and hooks so this always-on file does not compete with project instructions.

## Start

Before non-trivial work, call the \`repovine\` MCP server first. Use \`search_context\` when the task wording is fuzzy, \`map_context\` when a domain/package/module is named, then \`inspect_node\` after narrowing. Skip this only for trivial single-file tasks.

If the MCP call fails with a connection error, the server is not running. Ask the user to check the MCP config. Do not fall back to blind file reading -- without the graph you lack structure and dependency info.

If a tool returns \`status:"building"\`, call \`get_build_status({ "waitSec": 45 })\` instead of polling. If the ETA is large, tell the user and continue with direct file reads only when the task can proceed without graph structure. To abandon a cold build, call \`get_build_status({ "cancel": true })\`; it stops Stage 1 workers and returns \`cancelled\` (no graph) or keeps a prior \`ready\` graph.

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
