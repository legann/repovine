import * as fs from 'node:fs';
import * as path from 'node:path';
import type ts from 'typescript';
import type { PackageInfo, PendingModuleDraft } from '@repovine/plugin-sdk';
import type { SourceDiscoveryOptions, SourceDiscoveryResult } from '@repovine/plugin-sdk';
import { walkRepository } from '@repovine/plugin-sdk';
import { compileScanPatterns, shouldScanSourcePath, shouldWalkDiscoveryDir, type CompiledScanPatterns } from '../../scan-filters.js';
import { hostPathKey, repoRelativePosix, toPosixPath } from '../../platform/paths.js';
import { logPipelineWarn } from '../../cli/ui.js';
import { pathPrefixLength } from '../../stage1/utils.js';
import { discoverPackages } from './packages.js';
import { parsePackageTsConfig } from './list-tsconfig-files.js';
import { extractTypeScriptFromSfc, SFC_EXTENSIONS } from './sfc-extractor.js';
import { TYPESCRIPT_SOURCE_EXTENSIONS } from './extensions.js';

/**
 * TypeScript/JavaScript discovery (Pass 1 of the source-plugin contract).
 *
 * Owns everything language-specific about finding TS packages and candidate files:
 * tsconfig walk, file-extension filter, declaration-file gating, and SFC (Vue/Svelte)
 * extraction. The orchestrator only sees the resulting `SourceDiscoveryResult`.
 */

/** Whether any segment of a repo-relative path names a tree discovery leaves out. */
export function shouldSkipRepoRelativePath(relFromRoot: string): boolean {
  return !shouldWalkDiscoveryDir(toPosixPath(relFromRoot));
}

/** Basename: conventional test files anywhere in the tree (e.g. foo.test.ts, bar.spec.tsx). */
const SKIP_TEST_FILENAME_RE = /\.(?:test|spec)\.(?:[cm]?[jt]sx?|jsx?|cjs|mjs)$/i;

/** Source maps are never repovine modules. */
const SKIP_MAP_FILE_RE = /\.(?:js|mjs|cjs|css|ts|tsx|jsx)\.map$/i;

const SUPPORTED_EXTENSIONS = new Set(TYPESCRIPT_SOURCE_EXTENSIONS);

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
    const prefix = toPosixPath(pkg.path);
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
  if (!relFromPkg.startsWith('..')) return toPosixPath(relFromPkg);

  const relFromRoot = repoRelativePosix(repoRoot, filePath);
  const pkgPrefix = toPosixPath(pkg.path);
  if (relFromRoot === pkgPrefix || relFromRoot.startsWith(`${pkgPrefix}/`)) {
    return relFromRoot.slice(pkgPrefix.length + (relFromRoot === pkgPrefix ? 0 : 1));
  }

  const parentPrefix = toPosixPath(path.dirname(pkgPrefix));
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
  const relFromRoot = repoRelativePosix(repoRoot, filePath);
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
  // Starts inside the package, prunes by the path the graph knows — see the same split in the
  // Python file walk.
  walkRepository(pkgAbsPath, {
    repoRoot,
    onFile: ({ absPath: full, relFromRoot, name }) => {
      // Asked of the file as well as the directory: the walk starts inside the package, so a
      // package that itself sits under an ignored or test-layout tree would otherwise contribute
      // files no other producer would have reported.
      if (shouldSkipRepoRelativePath(relFromRoot)) return;
      const ext = path.extname(name).toLowerCase();
      if (!SFC_EXTENSIONS.has(ext)) return;
      if (!shouldScanSourcePath(relFromRoot, ctx.scanPatterns)) return;

      let content: string;
      try {
        content = fs.readFileSync(full, 'utf-8');
      } catch { return; }
      const extracted = extractTypeScriptFromSfc(full, content);
      if (!extracted || extracted.ts.trim().length === 0) return;

      const relPath = repoRelativePosix(pkgAbsPath, full);
      const before = pendingByPath.size;
      registerPendingModule(pendingByPath, full, {
        filePath: full,
        virtualPath: full + '.ts',
        pkg,
        relPath,
      }, relFromRoot);
      if (pendingByPath.size > before) added++;
    },
  });
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
    // Canonical key, like every other probe of this map. A raw-path probe answered differently per
    // platform — it matched on POSIX and missed on win32, where the key is case-folded — so an
    // explicit include re-opened an already-registered file there and `registerPendingModule` could
    // hand it to a package with a longer prefix, changing its relPath and its minted id.
    if (pendingByPath.has(hostPathKey(absPath))) return;
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

    const relPath = repoRelativePosix(pkgAbsPath, absPath);
    const before = pendingByPath.size;
    registerPendingModule(pendingByPath, absPath, {
      filePath: absPath,
      pkg,
      relPath,
    }, relFromRoot);
    if (pendingByPath.size > before) added++;
  };

  walkRepository(repoRoot, {
    onFile: ({ absPath, relFromRoot }) => visitFile(absPath, relFromRoot),
  });
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
