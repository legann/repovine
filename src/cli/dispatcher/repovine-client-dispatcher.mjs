#!/usr/bin/env node
// repovine client hook dispatcher.
//
// One versioned file serves every repovine hook event for Cursor, Claude Code,
// and Codex. The per-event hook bodies share root resolution, payload parsing,
// and advisory text, so a single file keeps the clients' behavior identical.
// The client argument exists because hosts disagree on output shape: Cursor
// expects a dual-key emit ({ additional_context, hookSpecificOutput }) with
// lowercase event names; Claude Code and Codex expect hookSpecificOutput only,
// with PascalCase event names.
//
// CLI contract:
//   node repovine-client-dispatcher.mjs <action> [client]
//     action: boundary-notice | stale-graph-notice | session-mcp-hint
//     client: claude | codex | cursor (default: claude; codex shares claude's shape)
// stdin: one JSON hook payload from the host client.
//
// Advisory only, never blocking: unknown actions, malformed payloads, and
// missing index/config files exit 0 with no output. Uses node: builtins only —
// no npx, no network.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** Version of the dispatcher CLI/stdin/emit contract described above. */
export const DISPATCHER_VERSION = 1;

const ACTIONS = new Set(['boundary-notice', 'stale-graph-notice', 'session-mcp-hint']);
const CLIENTS = new Set(['claude', 'codex', 'cursor']);

const action = process.argv[2];
const client = CLIENTS.has(process.argv[3]) ? process.argv[3] : 'claude';
const cursorStyle = client === 'cursor';

// Event names per emit kind, in each host's casing.
const EVENT_NAMES = {
  'boundary-notice': { cursor: 'preToolUse', default: 'PreToolUse' },
  'stale-graph-notice': { cursor: 'afterFileEdit', default: 'PostToolUse' },
  'stale-graph-conflict': { cursor: 'afterShellExecution', default: 'PostToolUse' },
  'session-mcp-hint': { cursor: 'sessionStart', default: 'SessionStart' },
};

function emit(eventKey, message) {
  const names = EVENT_NAMES[eventKey];
  const eventName = cursorStyle ? names.cursor : names.default;
  const payload = cursorStyle
    ? {
      additional_context: message,
      hookSpecificOutput: { hookEventName: eventName, additionalContext: message },
    }
    : {
      hookSpecificOutput: { hookEventName: eventName, additionalContext: message },
    };
  process.stdout.write(JSON.stringify(payload));
}

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

function findRoot(start) {
  let dir = resolve(start || process.cwd());
  for (;;) {
    if (existsSync(join(dir, '.repovine'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start || process.cwd());
    dir = parent;
  }
}

function readAnnotationsRel(rootDir) {
  try {
    const envRel = process.env.REPOVINE_ANNOTATIONS_FILE;
    if (typeof envRel === 'string' && envRel.trim()) return envRel.trim();
    const cfgPath = join(rootDir, 'repovine.config.json');
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      const rel = cfg?.workspace?.annotationsFile;
      if (typeof rel === 'string' && rel.trim()) return rel.trim();
    }
  } catch {
    // Unreadable config falls back to the default annotations file name.
  }
  return 'repovine.annots.json';
}

/** Relative path of the annotations file when it carries git conflict markers, else null. */
function annotationConflictFile(data) {
  try {
    const root = findRoot(resolveRoot(data));
    const rel = readAnnotationsRel(root);
    const filePath = join(root, rel);
    const hasMarkers = existsSync(filePath) && /^(<<<<<<<|=======|>>>>>>>) ?/m.test(readFileSync(filePath, 'utf-8'));
    return hasMarkers ? rel : null;
  } catch {
    return null;
  }
}

function onboardingStateHint(data) {
  try {
    const root = findRoot(resolveRoot(data));
    const filePath = join(root, '.repovine', 'onboarding-state.json');
    if (!existsSync(filePath)) return '';
    const state = JSON.parse(readFileSync(filePath, 'utf-8'));
    return ' Onboarding state: ' + JSON.stringify({
      graph: state.graph,
      onboarding: state.onboarding,
    }) + '.';
  } catch {
    return '';
  }
}

// Path collection accepts the superset of every host's payload keys
// (snake_case and camelCase singles, file arrays, apply_patch text); keys a
// host never sends are simply absent.
function collectPaths(data) {
  const paths = [];
  const ti = data && data.tool_input;
  for (const source of [data, ti]) {
    if (!source || typeof source !== 'object') continue;
    if (typeof source.file_path === 'string') paths.push(source.file_path);
    if (typeof source.filePath === 'string') paths.push(source.filePath);
    if (typeof source.path === 'string') paths.push(source.path);
    if (typeof source.notebook_path === 'string') paths.push(source.notebook_path);
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
    ti && ti.input, ti && ti.patch, ti && ti.command,
    data && data.input, data && data.patch, data && data.command,
  );
  if (patchText) {
    const re = /^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm;
    let m;
    while ((m = re.exec(patchText)) !== null) paths.push(m[1].trim());
  }
  return paths;
}

const ANNOTATION_MERGE_TOOLING =
  'call the repovine MCP tools: get_annotation_merge_status, merge_annotations, validate_annotations. ' +
  'CLI fallback: npx repovine annotations merge && npx repovine annotations validate.';

const DOMAINS_ADVISOR_AGENT_CONTRACT =
  'When get_build_status or refresh_context reports domainsSuggestions.count > 0, call suggest_domains_config; never auto-apply. With user approval, write a repovine.domains.json preview and call refresh_context: accept = write the mergedConfig (exclude), keep = write the keepConfig (committed infra.keep marker — keeps the resource visible and stops the suggestion); for skip/hide, call decline_advisory({ "kind": "domains-config" }) so ids are stored in .repovine/onboarding-state.json.';

// Post-edit staleness notice: reminds the agent that the repovine graph is
// stale after graph-relevant edits, and detects annotation conflict markers
// after git merge/pull/rebase/cherry-pick commands.
function runStaleGraphNotice(data) {
  const ti = data && data.tool_input;
  const commandText = firstString(
    data && data.command,
    data && data.shell_command,
    ti && ti.command,
  );
  const isGitMergeCommand = /\bgit\s+(merge|pull|rebase|cherry-pick)\b/.test(commandText);
  if (isGitMergeCommand) {
    const conflictRel = annotationConflictFile(data);
    if (conflictRel) {
      emit(
        'stale-graph-conflict',
        'repovine: ' + conflictRel + ' contains conflict markers. ' +
          'Do not resolve the JSON by hand. Call the repovine MCP tools: get_annotation_merge_status, merge_annotations, validate_annotations. ' +
          'CLI fallback: npx repovine annotations merge && npx repovine annotations validate.',
      );
      return;
    }
  }

  const paths = collectPaths(data);
  if (paths.length === 0) process.exit(0);

  const isEngineOwned = p =>
    /[\\/]\.repovine[\\/]/.test(p) ||
    /(?:^|[\\/])\.repovine\.[^\\/]+$/.test(p) ||
    /(?:^|[\\/])repovine\.(?:annots|annotations|config|domains)\.json$/.test(p);
  const isParsed = p =>
    /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|tf|ya?ml)$/i.test(p) ||
    /(^|[\\/])Dockerfile[^\\/]*$/i.test(p);

  const relevant = paths.some(p => !isEngineOwned(p) && isParsed(p));
  if (!relevant) process.exit(0);

  emit(
    'stale-graph-notice',
    'repovine: syntax index is now stale after this edit. ' +
      'Before the next structural navigation, dependency analysis, or annotation write, ' +
      'call repovine MCP tool refresh_context. ' +
      'Reading individual files directly is still fine without refresh.',
  );
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
  return lines.join('\n');
}

// Pre-edit boundary delivery: resolves each edited file against the
// scope:"boundary" risks recorded in .repovine/boundary-index.json by the build
// and surfaces the off-limits reason. Standalone: reads the index file, needs
// no running MCP server.
function runBoundaryNotice(data) {
  const paths = collectPaths(data);
  if (paths.length === 0) process.exit(0);

  const startDir = resolveRoot(data);
  const root = findRoot(startDir);

  let index;
  try {
    const filePath = join(root, '.repovine', 'boundary-index.json');
    if (!existsSync(filePath)) process.exit(0);
    index = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    process.exit(0);
  }
  if (!index || typeof index !== 'object') process.exit(0);
  const entriesOk = index.entries && typeof index.entries === 'object';
  if (index.version !== 1) {
    // Schema drift: the engine emits a newer index than this installed hook understands. Fail LOUD
    // (actionable notice) instead of silently disabling the channel. Only when the index is otherwise
    // well-formed; a corrupt newer index stays silent like any other malformed file.
    if (entriesOk) {
      emit(
        'boundary-notice',
        'repovine: boundary index schema (v' + index.version + ') is newer than this pre-edit hook; '
          + 'run "npx repovine setup" to refresh it. Boundary advisories are paused until then.',
      );
    }
    process.exit(0);
  }
  if (!entriesOk) process.exit(0);

  const toRel = p => relative(root, isAbsolute(p) ? p : resolve(startDir, p)).split('\\').join('/');

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

  emit('boundary-notice', buildAdvisory(blocks));
}

// Session-start hint: injects a one-time reminder that the repovine MCP should
// be the first call for non-trivial tasks, plus annotation-conflict and
// onboarding-state context when present.
function runSessionMcpHint(data) {
  if (data.source === 'compact') process.exit(0);
  const conflictRel = annotationConflictFile(data);
  const conflictHint = conflictRel
    ? ' Annotation maintenance: ' + conflictRel + ' currently contains conflict markers. ' +
      'Before annotation work, ' + ANNOTATION_MERGE_TOOLING
    : '';
  const onboardingHint = onboardingStateHint(data);

  emit(
    'session-mcp-hint',
    'repovine MCP is available (server name: repovine). ' +
      'For any non-trivial task, START with repovine MCP tools search_context or map_context; do not grep or read files first. ' +
      'The MCP provides structure, annotations, entrypoints, dependency analysis, config surface, and flow tracing. ' +
      'After editing files, call repovine MCP tool refresh_context to refresh the syntax index before further structural navigation. ' +
      'Build state: tool calls received before the graph finishes building return a successful response (not an error) with status:"building" and an eta_sec; ' +
      'do not retry in a loop — call get_build_status with waitSec (e.g. { waitSec: 45 }) to long-poll until the build settles, respect retry_after_sec, and fall back to direct file reads when eta_sec >= 60. ' +
      DOMAINS_ADVISOR_AGENT_CONTRACT +
      onboardingHint +
      conflictHint,
  );
}

if (!ACTIONS.has(action)) process.exit(0);

let raw = '';
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  let data;
  try {
    data = JSON.parse(raw || '{}');
  } catch {
    // The session hint degrades to an empty payload; the edit-scoped actions
    // stay silent on malformed input.
    if (action !== 'session-mcp-hint') process.exit(0);
    data = {};
  }

  if (action === 'boundary-notice') runBoundaryNotice(data);
  else if (action === 'stale-graph-notice') runStaleGraphNotice(data);
  else runSessionMcpHint(data);
});
