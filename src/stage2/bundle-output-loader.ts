import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPathInsideRepo } from '../fs/containment.js';
// Side-effect import: the built-in source plugins must be registered before this module asks the
import { stripSourceExtension } from '../plugin-host/source-set.js';
import { toPosixPath } from '../platform/paths.js';

/**
 * Conventional paths where build scripts that map source → bundle-output usually live.
 * Scanned in addition to `build.linking.bundles.scripts` from `repovine.config.json` unless the
 * caller opts out via `autoDetect: false`. Per-workspace candidates (added at runtime)
 * cover monorepos.
 */
const ROOT_BUNDLE_SCRIPT_CANDIDATES = [
  'scripts/bundle.js',
  'scripts/bundle.ts',
  'scripts/build.js',
  'scripts/build.ts',
];

function stripExt(file: string, extRe: RegExp): string {
  return file.replace(extRe, '');
}

/**
 * Parse a build script and return a map of `bundle-output-path → source-entry-path`.
 *
 * Recognizes three common JS bundler config shapes via a single sweep with three regexes:
 *   1. esbuild-style:  `{ entryPoint: 'src/foo.ts', outputFile: 'dist/foo/index.js' }`
 *   2. webpack-style:  `{ entry: 'src/foo.ts', output: 'dist/foo.js' }` (object literal form)
 *   3. rollup-style:   `{ input: 'src/foo.ts', file: 'dist/foo.js' }`
 *
 * Each pattern also has a reverse-order variant since users write keys in either order. We do
 * a regex sweep rather than a TypeScript AST parse because these scripts often import other
 * packages and `eval`-style execution is unsafe; matching literal-pair shapes covers ~95% of
 * real bundle scripts without parsing the host language.
 */
export function parseBundleOutputScript(source: string): Record<string, string> {
  const map: Record<string, string> = {};

  // Pattern definitions: each entry is { entryKey, outputKey } — the regex is built from these.
  const patterns: Array<{ src: string; out: string }> = [
    { src: 'entryPoint', out: 'outputFile' }, // esbuild
    { src: 'entry', out: 'output' },          // webpack
    { src: 'input', out: 'file' },            // rollup
  ];

  for (const { src, out } of patterns) {
    // forward: src before out
    const reForward = new RegExp(
      `\\b${src}\\s*:\\s*['"]([^'"]+)['"]\\s*,\\s*${out}\\s*:\\s*['"]([^'"]+)['"]`,
      'g',
    );
    let m: RegExpExecArray | null;
    while ((m = reForward.exec(source)) !== null) {
      addBundleMapping(map, m[1], m[2]);
    }
    // reverse: out before src
    const reReverse = new RegExp(
      `\\b${out}\\s*:\\s*['"]([^'"]+)['"]\\s*,\\s*${src}\\s*:\\s*['"]([^'"]+)['"]`,
      'g',
    );
    while ((m = reReverse.exec(source)) !== null) {
      addBundleMapping(map, m[2], m[1]);
    }
  }
  return map;
}

function addBundleMapping(map: Record<string, string>, entryPoint: string, outputFile: string): void {
  const entryBase = toPosixPath(stripSourceExtension(entryPoint.trim())).replace(/^\/+/, '');
  // Bundler output is always JS, whatever the entry was written in.
  const outBase = toPosixPath(stripExt(outputFile.trim(), /\.(m?js|cjs)$/i)).replace(/^\/+/, '');
  if (!entryBase || !outBase) return;
  if (entryBase === outBase) return;
  map[outBase] = entryBase;
}

/**
 * Build conventional bundle-script paths to scan when `build.linking.bundles.autoDetect` is enabled.
 * Combines repo-root conventions with per-workspace conventions so monorepos discover bundle
 * scripts inside individual packages.
 */
function buildAutoDetectCandidates(repoRoot: string): string[] {
  const candidates = [...ROOT_BUNDLE_SCRIPT_CANDIDATES];
  // Pull workspace globs from package.json to extend candidates per-package.
  const rootPkgPath = path.join(repoRoot, 'package.json');
  let workspaces: string[] = [];
  try {
    if (fs.existsSync(rootPkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8')) as {
        workspaces?: string[] | { packages?: string[] };
      };
      const ws = pkg.workspaces;
      if (Array.isArray(ws)) workspaces = ws;
      else if (ws && Array.isArray(ws.packages)) workspaces = ws.packages;
    }
  } catch {
    // ignore unreadable / malformed package.json
  }
  // Expand simple "packages/*" globs by listing directory entries.
  for (const ws of workspaces) {
    if (!ws.endsWith('/*')) continue;
    const dir = path.join(repoRoot, ws.slice(0, -2));
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const pkgRel = path.join(ws.slice(0, -2), e.name);
      candidates.push(path.join(pkgRel, 'scripts/bundle.js'));
      candidates.push(path.join(pkgRel, 'scripts/bundle.ts'));
      candidates.push(path.join(pkgRel, 'scripts/build.js'));
      candidates.push(path.join(pkgRel, 'scripts/build.ts'));
    }
  }
  return candidates;
}

/**
 * Build a `bundle-output-path → source-entry-path` map by parsing configured and conventional
 * bundler scripts.
 *
 * `bundleScripts` are repo-root-relative paths from `repovine.config.json` →
 * `build.linking.bundles.scripts`. When `autoDetect` is `true` (default), conventional script paths
 * (scripts/bundle.{js,ts}, scripts/build.{js,ts}, <workspace>/scripts/bundle.{js,ts}) are also
 * scanned; explicit entries are additive on top. Set `autoDetect: false` to scan only the
 * explicit entries.
 */
export function loadBundleOutputHandlerMap(
  repoRoot: string,
  bundleScripts: string[],
  autoDetect = true,
): Record<string, string> {
  const handlerMap: Record<string, string> = {};
  const autoCandidates = autoDetect ? buildAutoDetectCandidates(repoRoot) : [];
  const paths = [...bundleScripts, ...autoCandidates]
    .filter((p, i, arr) => arr.indexOf(p) === i);

  for (const rel of paths) {
    const abs = path.join(repoRoot, rel);
    // `path.join` normalizes a `..` segment away instead of rejecting it, and `statSync` follows
    // links, so a configured script path can name a file outside the workspace root. Same rule the
    // engine applies to discovered candidates.
    if (!isPathInsideRepo(repoRoot, abs)) continue;
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    try {
      const text = fs.readFileSync(abs, 'utf8');
      const part = parseBundleOutputScript(text);
      Object.assign(handlerMap, part);
    } catch (e) {
      if (process.env.REPOVINE_VERBOSE) {
        console.warn(`  ⚠ Build-output script ${rel}: ${(e as Error).message}`);
      }
    }
  }

  return handlerMap;
}

