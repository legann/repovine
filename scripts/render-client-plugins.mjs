#!/usr/bin/env node
/**
 * Maintainer script: render the repovine-client-plugins marketplace bundles from
 * engine SSoT. Not part of `repovine agents` — run via `npm run render-client-plugins`
 * (which builds dist/ first).
 *
 * Bundles pin the MCP to `npx -y repovine@<version>` (the engine package.json version
 * at render time). To avoid shipping bundles that pin a version not yet on npm, this
 * refuses to render unless `repovine@<version>` resolves on the registry. Pass
 * `--allow-unpublished` for local inspection / offline / pre-publish dry runs.
 *
 * `--check` renders to a temp dir and diffs it against the plugin repo, reporting
 * drift between the committed bundles and engine SSoT. It writes nothing to outRoot
 * and skips the published-version guard.
 */
import { npmOutput } from './lib/spawn.cjs';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPluginRepo } from '../dist/cli/plugin-render.js';

const PLUGIN_CLIENTS = ['cursor', 'claude', 'codex'];

/** Entries a render never touches, so drift comparison ignores them too. */
const PRESERVED_ENTRIES = new Set(['assets', '.git', '.gitignore']);

function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function printUsage() {
  console.error(
    [
      'Usage: node scripts/render-client-plugins.mjs [options]',
      '',
      'Options:',
      '  --out <dir>           Output root (default: ../repovine-client-plugins relative to engine)',
      '  --engine-root <dir>   repovine package root (default: parent of scripts/)',
      '  --version <v>         Plugin bundle version stamp',
      '  --client <cursor|claude|codex>  Render one client only (leaves the other bundles intact)',
      '  --check               Report drift between outRoot and a fresh render; write nothing',
      '  --allow-unpublished   Skip the npm-published check for the pinned version',
    ].join('\n'),
  );
}

/** Relative paths of every file under dir, minus preserved entries. */
function listFiles(dir, base = dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (dir === base && PRESERVED_ENTRIES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, acc);
    else acc.push(path.relative(base, full));
  }
  return acc;
}

function diffTrees(committed, fresh) {
  const committedFiles = new Set(listFiles(committed));
  const freshFiles = new Set(listFiles(fresh));
  const missing = [...freshFiles].filter((f) => !committedFiles.has(f)).sort();
  const extra = [...committedFiles].filter((f) => !freshFiles.has(f)).sort();
  const changed = [...freshFiles]
    .filter((f) => committedFiles.has(f))
    .filter((f) => readFileSync(path.join(committed, f), 'utf-8') !== readFileSync(path.join(fresh, f), 'utf-8'))
    .sort();
  return { missing, extra, changed };
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  printUsage();
  process.exit(0);
}

const outRoot = flagValue(args, '--out');
const engineRoot = flagValue(args, '--engine-root');
const version = flagValue(args, '--version');
const clientArg = flagValue(args, '--client');
const allowUnpublished = args.includes('--allow-unpublished');
const check = args.includes('--check');

let clients;
if (clientArg) {
  if (!PLUGIN_CLIENTS.includes(clientArg)) {
    console.error(`Unknown --client "${clientArg}". Valid: ${PLUGIN_CLIENTS.join(', ')}.`);
    process.exit(1);
  }
  clients = [clientArg];
}

// Resolve the exact version that will be pinned into every bundle's MCP config,
// from the same source renderPluginRepo uses, so the published-check matches the pin.
const resolvedEngineRoot = engineRoot
  ? path.resolve(engineRoot)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resolvedVersion =
  version ?? JSON.parse(readFileSync(path.join(resolvedEngineRoot, 'package.json'), 'utf-8')).version;

if (!resolvedVersion) {
  console.error(`Could not determine engine version from ${resolvedEngineRoot}/package.json.`);
  process.exit(1);
}

// Guard: bundles pin `npx -y repovine@<version>`; refuse to ship one that pins a
// version not (yet) on npm, which would break every install. --check writes nothing,
// so it runs against an unpublished version too.
if (!allowUnpublished && !check) {
  let publishedVersion = '';
  try {
    publishedVersion = npmOutput(['view', `repovine@${resolvedVersion}`, 'version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    publishedVersion = '';
  }
  if (!publishedVersion) {
    console.error(`Refusing to render: \`repovine@${resolvedVersion}\` is not resolvable on npm.`);
    console.error('Bundles pin `npx -y repovine@<version>`, so installing them would fail until that version is published.');
    console.error('Release order: `npm publish` the engine first, then render. For local/offline/dry-run, pass --allow-unpublished.');
    process.exit(1);
  }
}

if (check) {
  const committedRoot = path.resolve(
    outRoot ?? path.join(resolvedEngineRoot, '..', 'repovine-client-plugins'),
  );
  if (!existsSync(committedRoot) || !statSync(committedRoot).isDirectory()) {
    console.error(`No plugin repo at ${committedRoot}. Nothing to check against.`);
    process.exit(1);
  }

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'repovine-plugins-check-'));
  try {
    renderPluginRepo({
      outRoot: tempRoot,
      ...(engineRoot ? { engineRoot } : {}),
      version: resolvedVersion,
      ...(clients ? { clients } : {}),
    });
    const { missing, extra, changed } = diffTrees(committedRoot, tempRoot);
    const drift = missing.length + extra.length + changed.length;
    if (drift === 0) {
      console.log(`${committedRoot} is a current projection of repovine@${resolvedVersion}.`);
      process.exit(0);
    }
    console.error(`Plugin repo drifted from engine SSoT (repovine@${resolvedVersion}): ${drift} file(s).`);
    for (const file of missing) console.error(`  missing in repo: ${file}`);
    for (const file of changed) console.error(`  stale in repo:   ${file}`);
    for (const file of extra) console.error(`  not generated:   ${file}`);
    console.error('Re-render and commit the plugin repo: npm run render-client-plugins');
    process.exit(1);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

const result = renderPluginRepo({
  ...(outRoot ? { outRoot } : {}),
  ...(engineRoot ? { engineRoot } : {}),
  version: resolvedVersion,
  ...(clients ? { clients } : {}),
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
