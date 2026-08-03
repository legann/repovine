#!/usr/bin/env node
/**
 * Maintainer script: validate the generated repovine-client-plugins marketplace
 * bundles (manifests, source paths, MCP pins, hook layout). Run via
 * `npm run render-client-plugins:validate` after `npm run render-client-plugins`.
 *
 *   --out <dir>   plugin repo root (default: ../repovine-client-plugins relative to engine)
 *
 * Checks that map to install-time failures:
 *   - every hook command resolves to a script file that exists in the bundle;
 *   - every MCP config pins `repovine@<version>` matching the manifests;
 *   - every client bundle ships an MCP config, a plugin manifest, and INSTALL.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(
  flagValue(process.argv.slice(2), '--out') ?? path.join(engineRoot, '..', 'repovine-client-plugins'),
);

/** Hook files every client bundle wires: the single client dispatcher. */
const REQUIRED_HOOK_SCRIPTS = ['repovine-client-dispatcher.mjs'];

/** Dispatcher actions every client must wire: pre-edit boundary, post-edit staleness, session MCP hint. */
const REQUIRED_HOOK_ACTIONS = ['boundary-notice', 'stale-graph-notice', 'session-mcp-hint'];

/**
 * Per-client layout. `hookFiles` are scanned for `hooks/<name>.js` references;
 * each referenced script must exist under `hooksDir`. `mcpFiles` are scanned for
 * the `repovine@<version>` pin.
 */
const CLIENTS = {
  cursor: {
    marketplace: '.cursor-plugin/marketplace.json',
    bundle: 'repovine-plugins/cursor',
    manifest: '.cursor-plugin/plugin.json',
    mcpFiles: ['.cursor/mcp.json'],
    hookFiles: ['.cursor/hooks.json'],
    hooksDir: '.cursor/hooks',
  },
  claude: {
    marketplace: '.claude-plugin/marketplace.json',
    bundle: 'repovine-plugins/claude',
    manifest: '.claude-plugin/plugin.json',
    mcpFiles: ['.mcp.json'],
    hookFiles: ['hooks/hooks.json'],
    hooksDir: 'hooks',
  },
  codex: {
    marketplace: '.agents/plugins/marketplace.json',
    bundle: 'repovine-plugins/codex',
    manifest: '.codex-plugin/plugin.json',
    mcpFiles: ['.mcp.json', '.codex/config.toml'],
    hookFiles: ['.codex/config.toml'],
    hooksDir: '.codex/hooks',
  },
};

if (!fs.existsSync(path.join(root, CLIENTS.claude.marketplace)) || !fs.existsSync(path.join(root, CLIENTS.codex.marketplace))) {
  console.error(`Missing generated plugin output in ${root}. Run: npm run render-client-plugins`);
  process.exit(1);
}

const errors = [];
const fail = (message) => errors.push(message);

function mustExist(rel) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) fail(`Missing ${rel}`);
  return p;
}

function readText(rel) {
  const p = mustExist(rel);
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch (e) {
    fail(`Cannot read ${rel}: ${e.message}`);
    return '';
  }
}

function readJson(rel) {
  const text = readText(rel);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    fail(`Cannot parse ${rel}: ${e.message}`);
    return {};
  }
}

/** Marketplace entry: name, ./ source path pointing at the bundle, INSTALL.md next to it. */
function checkMarketplace(client, { marketplace, bundle }) {
  const entry = readJson(marketplace);
  const plugin = entry.plugins && entry.plugins[0];
  if (!plugin) {
    fail(`${marketplace} has no plugin entry`);
    return undefined;
  }
  if (plugin.name !== 'repovine') fail(`${marketplace} plugin name must be repovine`);
  const source = typeof plugin.source === 'string' ? plugin.source : plugin.source && plugin.source.path;
  if (source !== `./${bundle}`) fail(`${marketplace} source must be ./${bundle}, got ${source}`);
  mustExist(`${bundle}/INSTALL.md`);
  if (!plugin.version) fail(`${marketplace} plugin entry has no version`);
  return plugin.version;
}

/**
 * Every `hooks/<name>.js|.mjs` a hook command references must exist in the
 * bundle, the dispatcher must be wired, every dispatcher action must be
 * dispatched at least once.
 */
function checkHooks(client, { bundle, hookFiles, hooksDir }) {
  const referenced = new Set();
  const texts = [];
  for (const rel of hookFiles) {
    const text = readText(`${bundle}/${rel}`);
    texts.push(text);
    for (const match of text.matchAll(/hooks\/([\w.-]+\.m?js)/g)) referenced.add(match[1]);
  }
  for (const script of referenced) {
    const scriptRel = `${bundle}/${hooksDir}/${script}`;
    if (!fs.existsSync(path.join(root, scriptRel))) {
      fail(`${client} hooks reference ${script}, but ${scriptRel} does not exist`);
    }
  }
  for (const script of REQUIRED_HOOK_SCRIPTS) {
    if (!referenced.has(script)) fail(`${client} hooks must wire ${script} (${hookFiles.join(', ')})`);
  }
  const combined = texts.join('\n');
  for (const action of REQUIRED_HOOK_ACTIONS) {
    if (!combined.includes(action)) {
      fail(`${client} hooks must dispatch the ${action} action (${hookFiles.join(', ')})`);
    }
  }
}

/** Every MCP config must declare the repovine server and pin the manifest version. */
function checkMcpPins(client, { bundle, mcpFiles }, version) {
  for (const rel of mcpFiles) {
    const text = readText(`${bundle}/${rel}`);
    if (!text) continue;
    if (!/repovine/.test(text)) {
      fail(`${bundle}/${rel} does not declare the repovine MCP server`);
      continue;
    }
    const pins = [...text.matchAll(/repovine@([\w.+-]+)/g)].map((m) => m[1]);
    if (pins.length === 0) {
      fail(`${bundle}/${rel} does not pin repovine@<version>; installs would resolve a floating version`);
      continue;
    }
    for (const pin of pins) {
      if (pin !== version) fail(`${bundle}/${rel} pins repovine@${pin}, but the manifests say ${version}`);
    }
  }
}

const versions = new Map();

for (const [client, layout] of Object.entries(CLIENTS)) {
  const marketplaceVersion = checkMarketplace(client, layout);
  if (marketplaceVersion) versions.set(`${layout.marketplace}`, marketplaceVersion);

  const manifest = readJson(`${layout.bundle}/${layout.manifest}`);
  if (manifest.version) versions.set(`${layout.bundle}/${layout.manifest}`, manifest.version);
  else fail(`${layout.bundle}/${layout.manifest} has no version`);

  checkHooks(client, layout);
}

// One version across marketplaces, manifests, and MCP pins: a mismatched pin resolves
// a version that may not exist on npm, and the MCP server never starts.
const distinct = [...new Set(versions.values())];
if (distinct.length > 1) {
  const detail = [...versions.entries()].map(([file, v]) => `${file}=${v}`).join(', ');
  fail(`Version stamps disagree across bundles: ${detail}`);
}
const version = distinct[0];
if (version) {
  for (const [client, layout] of Object.entries(CLIENTS)) checkMcpPins(client, layout, version);
}

// Claude bundle shape: components live at plugin-root defaults, hooks run from ${CLAUDE_PLUGIN_ROOT}.
const claudeManifest = readJson('repovine-plugins/claude/.claude-plugin/plugin.json');
for (const rel of ['.mcp.json', 'agents', 'skills', 'hooks/hooks.json']) {
  mustExist(path.join('repovine-plugins/claude', rel));
}
for (const key of ['mcpServers', 'agents', 'skills']) {
  const value = claudeManifest[key];
  if (value === undefined) continue;
  if (typeof value !== 'string' || !value.startsWith('./')) {
    fail(`Claude manifest ${key}, when present, must be a ./ relative path, got ${JSON.stringify(value)}`);
    continue;
  }
  mustExist(path.join('repovine-plugins/claude', value.replace(/^\.\//, '')));
}
if (claudeManifest.hooks !== undefined) {
  fail('Claude manifest must not point hooks at default hooks/hooks.json; Claude auto-loads that file and can report duplicate hooks.');
}
if (fs.existsSync(path.join(root, 'repovine-plugins/claude/.claude/settings.json'))) {
  fail('Claude plugin bundle must not rely on project-scoped .claude/settings.json');
}

// Claude plugin hooks are exec-form: command `node` plus args, args[0] the
// dispatcher at ${CLAUDE_PLUGIN_ROOT}, the action among the remaining args.
const claudeHooks = readJson('repovine-plugins/claude/hooks/hooks.json');
const claudeHookEntries = [];
for (const entries of Object.values(claudeHooks)) {
  if (!Array.isArray(entries)) continue;
  for (const entry of entries) {
    if (!entry || !Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (hook && typeof hook.command === 'string') {
        claudeHookEntries.push({ command: hook.command, args: Array.isArray(hook.args) ? hook.args : [] });
      }
    }
  }
}
const claudeDispatcherRef = '${CLAUDE_PLUGIN_ROOT}/hooks/repovine-client-dispatcher.mjs';
for (const action of REQUIRED_HOOK_ACTIONS) {
  const wired = claudeHookEntries.some(
    (hook) => hook.command === 'node' && hook.args[0] === claudeDispatcherRef && hook.args.includes(action),
  );
  if (!wired) {
    fail(`Claude hooks must run ${action} through exec-form node + ${claudeDispatcherRef}`);
  }
}
for (const hook of claudeHookEntries) {
  const joined = [hook.command, ...hook.args].join(' ');
  if (joined.includes('$CLAUDE_PROJECT_DIR/.claude/hooks')) {
    fail('Claude plugin hooks must not point at project-scoped .claude/hooks');
  }
  if (hook.args.length === 0 && /hooks\/[\w.-]+\.js\b/.test(hook.command)) {
    fail(`Claude plugin hooks must not use shell-string per-hook scripts: ${hook.command}`);
  }
}

// Cursor MCP schema requires type:"stdio" on every stdio server entry.
const cursorMcp = readJson('repovine-plugins/cursor/.cursor/mcp.json');
for (const [name, server] of Object.entries(cursorMcp.mcpServers ?? {})) {
  if (!server || server.type !== 'stdio') {
    fail(`repovine-plugins/cursor/.cursor/mcp.json server "${name}" must declare type "stdio"`);
  }
}

// Codex plugin hooks address the plugin root and carry a Windows sibling:
// every hook command references $PLUGIN_ROOT and is followed by command_windows.
const codexTomlLines = readText('repovine-plugins/codex/.codex/config.toml').split('\n');
for (let i = 0; i < codexTomlLines.length; i++) {
  const line = codexTomlLines[i];
  if (!line.startsWith('command = ') || !line.includes('hooks/')) continue;
  if (line.includes('$(git rev-parse')) {
    fail(`codex plugin hook command must not resolve the project root via git: ${line}`);
  }
  if (!line.includes('$PLUGIN_ROOT/')) {
    fail(`codex plugin hook command must reference $PLUGIN_ROOT: ${line}`);
  }
  const next = codexTomlLines[i + 1] ?? '';
  if (!next.startsWith('command_windows = ')) {
    fail(`codex plugin hook command lacks a command_windows sibling: ${line}`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`Static checks passed for ${root} (repovine@${version})`);
