import * as fs from 'node:fs';
import * as path from 'node:path';
import type ts from 'typescript';
import type { PackageInfo, PendingModuleDraft } from '@repovine/plugin-sdk';
import type { SourceDiscoveryOptions, SourceDiscoveryResult } from '@repovine/plugin-sdk';
import { compileScanPatterns, shouldScanSourcePath, type CompiledScanPatterns } from '../../scan-filters.js';
import { hostPathKey } from '../../platform/paths.js';
import { logPipelineWarn } from '../../cli/ui.js';
import { pathPrefixLength } from '../../stage1/utils.js';
import { discoverPackages } from './packages.js';
import { parsePackageTsConfig } from './list-tsconfig-files.js';
import { extractTypeScriptFromSfc, SFC_EXTENSIONS } from './sfc-extractor.js';
import { readDirSorted } from '../../fs/read-dir-sorted.js';

/**
 * TypeScript/JavaScript discovery (Pass 1 of the source-plugin contract).
 *
 * Owns everything language-specific about finding TS packages and candidate files:
 * tsconfig walk, file-extension filter, declaration-file gating, and SFC (Vue/Svelte)
 * extraction. The orchestrator only sees the resulting `SourceDiscoveryResult`.
 */

/** Normalized path (forward slashes): skip these directory subtrees. */
const SKIP_PATH_SUBTREE_RE =
  /\/(?:dist|dist-bundled|target|build|out|coverage|node_modules|\.next|\.repovine|__tests__|__mocks__|__snapshots__|\.cache|test|tests|e2e|cypress|playwright|__e2e__)(?:\/|$)/;

const SKIP_WALK_DIRS = new Set([
  'node_modules', '.git', '.repovine', 'dist', 'dist-bundled', 'target', 'build', 'out', 'coverage', '.next',
]);

export function shouldSkipRepoRelativePath(relFromRoot: string): boolean {
  const normalized = relFromRoot.split(path.sep).join('/');
  return SKIP_PATH_SUBTREE_RE.test(`/${normalized}/`);
}

/** Basename: conventional test files anywhere in the tree (e.g. foo.test.ts, bar.spec.tsx). */
const SKIP_TEST_FILENAME_RE = /\.(?:test|spec)\.(?:[cm]?[jt]sx?|jsx?|cjs|mjs)$/i;

/** Source maps are never repovine modules. */
const SKIP_MAP_FILE_RE = /\.(?:js|mjs|cjs|css|ts|tsx|jsx)\.map$/i;

const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

interface DiscoveryContext {
  repoRoot: string;
  scanPatterns: CompiledScanPatterns;
}

interface DiscoveryResult {
  pendingByPath: Map<string, PendingModuleDraft>;
  parsedOptionsByPkg: Map<string, ts.CompilerOptions>;
  sourceFilesDiscovered: number;
}

function registerPendingModule(
  pendingByPath: Map<string, PendingModuleDraft>,
  filePath: string,
  entry: PendingModuleDraft,
  relFromRoot: string,
): void {
  // Canonical key: tsconfig enumeration, SFC discovery, and the tree
  // walk emit different absolute-path forms for one file on win32; a raw key
  // would miss the dedupe and register the file twice under two module ids.
  const key = hostPathKey(filePath);
  const existing = pendingByPath.get(key);
  if (!existing || pathPrefixLength(entry.pkg.path, relFromRoot) > pathPrefixLength(existing.pkg.path, relFromRoot)) {
    pendingByPath.set(key, entry);
  }
}

function pickPackageForPath(packages: PackageInfo[], relFromRoot: string): PackageInfo | undefined {
  let best: PackageInfo | undefined;
  let bestLen = -1;
  for (const pkg of packages) {
    const prefix = pkg.path.replace(/\\/g, '/');
    if (relFromRoot === prefix || relFromRoot.startsWith(`${prefix}/`)) {
      if (prefix.length > bestLen) {
        best = pkg;
        bestLen = prefix.length;
      }
    }
  }
  return best;
}

function moduleRelPathFor(pkg: PackageInfo, filePath: string, repoRoot: string): string {
  const pkgAbsPath = path.resolve(repoRoot, pkg.path);
  const relFromPkg = path.relative(pkgAbsPath, filePath);
  if (!relFromPkg.startsWith('..')) return relFromPkg.split(path.sep).join('/');

  const relFromRoot = path.normalize(path.relative(repoRoot, filePath)).split(path.sep).join('/');
  const pkgPrefix = pkg.path.replace(/\\/g, '/');
  if (relFromRoot === pkgPrefix || relFromRoot.startsWith(`${pkgPrefix}/`)) {
    return relFromRoot.slice(pkgPrefix.length + (relFromRoot === pkgPrefix ? 0 : 1));
  }

  const parentPrefix = path.dirname(pkgPrefix).replace(/\\/g, '/');
  if (parentPrefix !== '.' && (relFromRoot === parentPrefix || relFromRoot.startsWith(`${parentPrefix}/`))) {
    return relFromRoot.slice(parentPrefix.length + (relFromRoot === parentPrefix ? 0 : 1));
  }

  return relFromRoot;
}

function shouldSkipFilePath(
  filePath: string,
  repoRoot: string,
  ctx: DiscoveryContext,
): { skip: true } | { skip: false; relFromRoot: string } {
  const relFromRoot = path.normalize(path.relative(repoRoot, filePath)).split(path.sep).join('/');
  if (shouldSkipRepoRelativePath(relFromRoot)) return { skip: true };
  if (SKIP_TEST_FILENAME_RE.test(path.basename(filePath))) return { skip: true };
  if (SKIP_MAP_FILE_RE.test(path.basename(filePath))) return { skip: true };
  if (!shouldScanSourcePath(relFromRoot, ctx.scanPatterns)) return { skip: true };

  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) return { skip: true };

  return { skip: false, relFromRoot };
}

function discoverPackageSourceFiles(
  pkg: PackageInfo,
  pkgAbsPath: string,
  repoRoot: string,
  ctx: DiscoveryContext,
  fileNames: string[],
  pendingByPath: Map<string, PendingModuleDraft>,
): number {
  let count = 0;
  for (const filePath of fileNames) {
    const check = shouldSkipFilePath(filePath, repoRoot, ctx);
    if (check.skip) continue;

    const relPath = moduleRelPathFor(pkg, filePath, repoRoot);
    const before = pendingByPath.size;
    registerPendingModule(pendingByPath, filePath, {
      filePath,
      pkg,
      relPath,
    }, check.relFromRoot);
    if (pendingByPath.size > before) count++;
  }
  return count;
}

function discoverSfcFiles(
  pkgAbsPath: string,
  repoRoot: string,
  pkg: PackageInfo,
  ctx: DiscoveryContext,
  pendingByPath: Map<string, PendingModuleDraft>,
): number {
  let added = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = readDirSorted(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const relFromRoot = path.normalize(path.relative(repoRoot, full)).split(path.sep).join('/');
      if (shouldSkipRepoRelativePath(relFromRoot)) continue;
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!SFC_EXTENSIONS.has(ext)) continue;
      if (!shouldScanSourcePath(relFromRoot, ctx.scanPatterns)) continue;

      let content: string;
      try {
        content = fs.readFileSync(full, 'utf-8');
      } catch { continue; }
      const extracted = extractTypeScriptFromSfc(full, content);
      if (!extracted || extracted.ts.trim().length === 0) continue;

      const relPath = path.relative(pkgAbsPath, full).split(path.sep).join('/');
      const before = pendingByPath.size;
      registerPendingModule(pendingByPath, full, {
        filePath: full,
        virtualPath: full + '.ts',
        pkg,
        relPath,
        }, relFromRoot);
      if (pendingByPath.size > before) added++;
    }
  };
  walk(pkgAbsPath);
  return added;
}

function discoverExplicitIncludeFiles(
  packages: PackageInfo[],
  repoRoot: string,
  ctx: DiscoveryContext,
  pendingByPath: Map<string, PendingModuleDraft>,
): number {
  if (ctx.scanPatterns.include.length === 0) return 0;

  let added = 0;
  const visitFile = (absPath: string, relFromRoot: string): void => {
    if (pendingByPath.has(absPath)) return;
    if (shouldSkipRepoRelativePath(relFromRoot)) return;
    if (SKIP_TEST_FILENAME_RE.test(path.basename(absPath))) return;
    if (SKIP_MAP_FILE_RE.test(path.basename(absPath))) return;
    if (!shouldScanSourcePath(relFromRoot, ctx.scanPatterns)) return;

    const ext = path.extname(absPath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) return;

    const pkg = pickPackageForPath(packages, relFromRoot);
    if (!pkg) return;
    const pkgAbsPath = path.resolve(repoRoot, pkg.path);
    if (!absPath.startsWith(pkgAbsPath + path.sep)) return;

    const relPath = path.relative(pkgAbsPath, absPath).split(path.sep).join('/');
    const before = pendingByPath.size;
    registerPendingModule(pendingByPath, absPath, {
      filePath: absPath,
      pkg,
      relPath,
    }, relFromRoot);
    if (pendingByPath.size > before) added++;
  };

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = readDirSorted(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const relFromRoot = path.normalize(path.relative(repoRoot, full)).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (SKIP_WALK_DIRS.has(e.name) || shouldSkipRepoRelativePath(relFromRoot)) continue;
        walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      visitFile(full, relFromRoot);
    }
  };

  walk(repoRoot);
  return added;
}

/** Pass 1: discover every package's source files via tsconfig (no AST parse) and capture
 * the parsed compilerOptions so Pass 2 doesn't re-parse the tsconfig. */
function discoverPendingModules(
  packages: PackageInfo[],
  repoRoot: string,
  ctx: DiscoveryContext,
): DiscoveryResult {
  const pendingByPath = new Map<string, PendingModuleDraft>();
  const parsedOptionsByPkg = new Map<string, ts.CompilerOptions>();
  let sourceFilesDiscovered = 0;

  for (const pkg of packages) {
    const pkgAbsPath = path.resolve(repoRoot, pkg.path);
    let parsed;
    try {
      parsed = parsePackageTsConfig(pkgAbsPath);
    } catch (e) {
      logPipelineWarn(`  ⚠ Skipping ${pkg.name}: ${(e as Error).message}`);
      continue;
    }
    parsedOptionsByPkg.set(pkg.name, parsed.compilerOptions);

    sourceFilesDiscovered += discoverPackageSourceFiles(pkg, pkgAbsPath, repoRoot, ctx, parsed.fileNames, pendingByPath);
    discoverSfcFiles(pkgAbsPath, repoRoot, pkg, ctx, pendingByPath);
  }

  sourceFilesDiscovered += discoverExplicitIncludeFiles(packages, repoRoot, ctx, pendingByPath);
  return { pendingByPath, parsedOptionsByPkg, sourceFilesDiscovered };
}

/**
 * Source-plugin discover() entrypoint. Returns the TS packages, the candidate modules keyed by
 * absolute file path, and the parsed compilerOptions per package as the opaque `extractContext`
 * threaded into extract().
 */
export function discoverTypeScript(repoRoot: string, options: SourceDiscoveryOptions): SourceDiscoveryResult {
  const packages: PackageInfo[] = discoverPackages(repoRoot).map(p => ({ ...p, sourcePluginId: 'typescript' }));
  const scanPatterns = options.scanPatterns ?? compileScanPatterns([], []);
  const ctx: DiscoveryContext = { repoRoot, scanPatterns };

  const { pendingByPath, parsedOptionsByPkg } = discoverPendingModules(packages, repoRoot, ctx);
  for (const pending of pendingByPath.values()) pending.sourcePluginId = 'typescript';

  return { packages, pendingByPath, extractContext: parsedOptionsByPkg };
}
