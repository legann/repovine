import * as fs from 'node:fs';
import * as path from 'node:path';
import type ts from 'typescript';
import type { HostPath, PackageInfo, PendingModuleDraft, PkgRelPath, RepoRelPath } from '@repovine/plugin-sdk';
import type { SourceDiscoveryOptions, SourceDiscoveryResult } from '@repovine/plugin-sdk';
import { walkRepository } from '@repovine/plugin-sdk';
import { asHostPath, asPkgRelPath, compileScanPatterns, hostPathKey, repoRelativePosix, shouldScanSourcePath, shouldWalkDiscoveryDir, toPosixPath } from '@repovine/plugin-sdk';
import type { CompiledScanPatterns } from '@repovine/plugin-sdk';
import type { SourceDiscoveryLogLevel } from '@repovine/plugin-sdk';
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
export function shouldSkipRepoRelativePath(repoRelPath: RepoRelPath): boolean {
  return !shouldWalkDiscoveryDir(repoRelPath);
}

/** Basename: conventional test files anywhere in the tree (e.g. foo.test.ts, bar.spec.tsx). */
const SKIP_TEST_FILENAME_RE = /\.(?:test|spec)\.(?:[cm]?[jt]sx?|jsx?|cjs|mjs)$/i;

/** Source maps are never repovine modules. */
const SKIP_MAP_FILE_RE = /\.(?:js|mjs|cjs|css|ts|tsx|jsx)\.map$/i;

const SUPPORTED_EXTENSIONS = new Set(TYPESCRIPT_SOURCE_EXTENSIONS);

interface DiscoveryContext {
  repoRoot: HostPath;
  scanPatterns: CompiledScanPatterns;
  /** Host diagnostic sink. Absent when the host asked for no diagnostics from this pass. */
  log?(level: SourceDiscoveryLogLevel, message: string): void;
  /** Host sink for where this producer's walk stopped. Absent when the host wants no report. */
  onPruned?: SourceDiscoveryOptions['onPruned'];
}

/**
 * Length of `pkgPath` as a prefix of `relFromRoot`, in characters; 0 when it is not one.
 *
 * A file inside two nested tsconfig packages is claimed by the deeper one, and "deeper" is the
 * longer matching prefix. Segment-anchored: `srv` does not count as a prefix of `srvc/a.ts`.
 */
function pathPrefixLength(pkgPath: string, relFromRoot: string): number {
  const norm = path.normalize(relFromRoot);
  const prefix = path.normalize(pkgPath);
  if (prefix === '.' || prefix === '') return 0;
  if (norm === prefix || norm.startsWith(prefix + path.sep)) return prefix.length;
  return 0;
}

interface DiscoveryResult {
  pendingByAbsPath: Map<HostPath, PendingModuleDraft>;
  parsedOptionsByPkg: Map<string, ts.CompilerOptions>;
  sourceFilesDiscovered: number;
}

function registerPendingModule(
  pendingByAbsPath: Map<HostPath, PendingModuleDraft>,
  absPath: HostPath,
  entry: PendingModuleDraft,
  repoRelPath: RepoRelPath,
): void {
  // Canonical key: tsconfig enumeration, SFC discovery, and the tree
  // walk emit different absolute-path forms for one file on win32; a raw key
  // would miss the dedupe and register the file twice under two module ids.
  const key = hostPathKey(absPath);
  const existing = pendingByAbsPath.get(key);
  if (!existing || pathPrefixLength(entry.pkg.repoRelDir, repoRelPath) > pathPrefixLength(existing.pkg.repoRelDir, repoRelPath)) {
    pendingByAbsPath.set(key, entry);
  }
}

function pickPackageForPath(packages: PackageInfo[], repoRelPath: RepoRelPath): PackageInfo | undefined {
  let best: PackageInfo | undefined;
  let bestLen = -1;
  for (const pkg of packages) {
    const prefix = pkg.repoRelDir;
    if (repoRelPath === prefix || repoRelPath.startsWith(`${prefix}/`)) {
      if (prefix.length > bestLen) {
        best = pkg;
        bestLen = prefix.length;
      }
    }
  }
  return best;
}

function modulePkgRelPathFor(pkg: PackageInfo, absPath: HostPath, repoRoot: HostPath): PkgRelPath {
  const pkgAbsPath = asHostPath(path.resolve(repoRoot, pkg.repoRelDir));
  const relFromPkg = path.relative(pkgAbsPath, absPath);
  if (!relFromPkg.startsWith('..')) return asPkgRelPath(toPosixPath(relFromPkg));

  const repoRelPath = repoRelativePosix(repoRoot, absPath);
  const pkgPrefix = pkg.repoRelDir;
  if (repoRelPath === pkgPrefix || repoRelPath.startsWith(`${pkgPrefix}/`)) {
    return asPkgRelPath(repoRelPath.slice(pkgPrefix.length + (repoRelPath === pkgPrefix ? 0 : 1)));
  }

  const parentPrefix = toPosixPath(path.dirname(pkgPrefix));
  if (parentPrefix !== '.' && (repoRelPath === parentPrefix || repoRelPath.startsWith(`${parentPrefix}/`))) {
    return asPkgRelPath(repoRelPath.slice(parentPrefix.length + (repoRelPath === parentPrefix ? 0 : 1)));
  }

  return asPkgRelPath(repoRelPath);
}

function shouldSkipFilePath(
  absPath: HostPath,
  repoRoot: HostPath,
  ctx: DiscoveryContext,
): { skip: true } | { skip: false; repoRelPath: RepoRelPath } {
  const repoRelPath = repoRelativePosix(repoRoot, absPath);
  if (shouldSkipRepoRelativePath(repoRelPath)) return { skip: true };
  if (SKIP_TEST_FILENAME_RE.test(path.basename(absPath))) return { skip: true };
  if (SKIP_MAP_FILE_RE.test(path.basename(absPath))) return { skip: true };
  if (!shouldScanSourcePath(repoRelPath, ctx.scanPatterns)) return { skip: true };

  const ext = path.extname(absPath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) return { skip: true };

  return { skip: false, repoRelPath };
}

function discoverPackageSourceFiles(
  pkg: PackageInfo,
  pkgAbsPath: HostPath,
  repoRoot: HostPath,
  ctx: DiscoveryContext,
  fileNames: string[],
  pendingByAbsPath: Map<HostPath, PendingModuleDraft>,
): number {
  let count = 0;
  for (const filePath of fileNames) {
    const absPath = asHostPath(filePath);
    const check = shouldSkipFilePath(absPath, repoRoot, ctx);
    if (check.skip) continue;

    const pkgRelPath = modulePkgRelPathFor(pkg, absPath, repoRoot);
    const before = pendingByAbsPath.size;
    registerPendingModule(pendingByAbsPath, absPath, {
      absPath,
      pkg,
      pkgRelPath,
    }, check.repoRelPath);
    if (pendingByAbsPath.size > before) count++;
  }
  return count;
}

function discoverSfcFiles(
  pkgAbsPath: HostPath,
  repoRoot: HostPath,
  pkg: PackageInfo,
  ctx: DiscoveryContext,
  pendingByAbsPath: Map<HostPath, PendingModuleDraft>,
): number {
  let added = 0;
  // Starts inside the package, prunes by the path the graph knows — see the same split in the
  // Python file walk.
  walkRepository(pkgAbsPath, {
    ...(ctx.onPruned === undefined ? {} : { onPruned: ctx.onPruned }),
    repoRoot,
    onFile: ({ absPath: full, repoRelPath, name }) => {
      // Asked of the file as well as the directory: the walk starts inside the package, so a
      // package that itself sits under an ignored or test-layout tree would otherwise contribute
      // files no other producer would have reported.
      if (shouldSkipRepoRelativePath(repoRelPath)) return;
      const ext = path.extname(name).toLowerCase();
      if (!SFC_EXTENSIONS.has(ext)) return;
      if (!shouldScanSourcePath(repoRelPath, ctx.scanPatterns)) return;

      let content: string;
      try {
        content = fs.readFileSync(full, 'utf-8');
      } catch { return; }
      const extracted = extractTypeScriptFromSfc(full, content);
      if (!extracted || extracted.ts.trim().length === 0) return;

      const pkgRelPath = asPkgRelPath(repoRelativePosix(pkgAbsPath, full));
      const before = pendingByAbsPath.size;
      registerPendingModule(pendingByAbsPath, full, {
        absPath: full,
        virtualAbsPath: asHostPath(full + '.ts'),
        pkg,
        pkgRelPath,
      }, repoRelPath);
      if (pendingByAbsPath.size > before) added++;
    },
  });
  return added;
}

function discoverExplicitIncludeFiles(
  packages: PackageInfo[],
  repoRoot: HostPath,
  ctx: DiscoveryContext,
  pendingByAbsPath: Map<HostPath, PendingModuleDraft>,
): number {
  if (ctx.scanPatterns.include.length === 0) return 0;

  let added = 0;
  const visitFile = (absPath: HostPath, repoRelPath: RepoRelPath): void => {
    // Canonical key, like every other probe of this map. A raw-path probe answered differently per
    // platform — it matched on POSIX and missed on win32, where the key is case-folded — so an
    // explicit include re-opened an already-registered file there and `registerPendingModule` could
    // hand it to a package with a longer prefix, changing its relPath and its minted id.
    if (pendingByAbsPath.has(hostPathKey(absPath))) return;
    if (shouldSkipRepoRelativePath(repoRelPath)) return;
    if (SKIP_TEST_FILENAME_RE.test(path.basename(absPath))) return;
    if (SKIP_MAP_FILE_RE.test(path.basename(absPath))) return;
    if (!shouldScanSourcePath(repoRelPath, ctx.scanPatterns)) return;

    const ext = path.extname(absPath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) return;

    const pkg = pickPackageForPath(packages, repoRelPath);
    if (!pkg) return;
    const pkgAbsPath = asHostPath(path.resolve(repoRoot, pkg.repoRelDir));
    if (!absPath.startsWith(pkgAbsPath + path.sep)) return;

    const pkgRelPath = asPkgRelPath(repoRelativePosix(pkgAbsPath, absPath));
    const before = pendingByAbsPath.size;
    registerPendingModule(pendingByAbsPath, absPath, {
      absPath,
      pkg,
      pkgRelPath,
    }, repoRelPath);
    if (pendingByAbsPath.size > before) added++;
  };

  walkRepository(repoRoot, {
    ...(ctx.onPruned === undefined ? {} : { onPruned: ctx.onPruned }),
    onFile: ({ absPath, repoRelPath }) => visitFile(absPath, repoRelPath),
  });
  return added;
}

/** Pass 1: discover every package's source files via tsconfig (no AST parse) and capture
 * the parsed compilerOptions so Pass 2 doesn't re-parse the tsconfig. */
function discoverPendingModules(
  packages: PackageInfo[],
  repoRoot: HostPath,
  ctx: DiscoveryContext,
): DiscoveryResult {
  const pendingByAbsPath = new Map<HostPath, PendingModuleDraft>();
  const parsedOptionsByPkg = new Map<string, ts.CompilerOptions>();
  let sourceFilesDiscovered = 0;

  for (const pkg of packages) {
    const pkgAbsPath = asHostPath(path.resolve(repoRoot, pkg.repoRelDir));
    let parsed;
    try {
      parsed = parsePackageTsConfig(pkgAbsPath);
    } catch (e) {
      ctx.log?.('warn', `  ⚠ Skipping ${pkg.name}: ${(e as Error).message}`);
      continue;
    }
    parsedOptionsByPkg.set(pkg.name, parsed.compilerOptions);

    sourceFilesDiscovered += discoverPackageSourceFiles(pkg, pkgAbsPath, repoRoot, ctx, parsed.fileNames, pendingByAbsPath);
    discoverSfcFiles(pkgAbsPath, repoRoot, pkg, ctx, pendingByAbsPath);
  }

  sourceFilesDiscovered += discoverExplicitIncludeFiles(packages, repoRoot, ctx, pendingByAbsPath);
  return { pendingByAbsPath, parsedOptionsByPkg, sourceFilesDiscovered };
}

/**
 * Source-plugin discover() entrypoint. Returns the TS packages, the candidate modules keyed by
 * absolute file path, and the parsed compilerOptions per package as the opaque `extractContext`
 * threaded into extract().
 */
export function discoverTypeScript(repoRoot: HostPath, options: SourceDiscoveryOptions): SourceDiscoveryResult {
  const packages: PackageInfo[] = discoverPackages(repoRoot, options.packageMarkers, options.onPruned)
    .map(p => ({ ...p, sourcePluginId: 'typescript' }));
  const scanPatterns = options.scanPatterns ?? compileScanPatterns([], []);
  const ctx: DiscoveryContext = { repoRoot, scanPatterns, log: options.log, onPruned: options.onPruned };

  const { pendingByAbsPath, parsedOptionsByPkg } = discoverPendingModules(packages, repoRoot, ctx);
  for (const pending of pendingByAbsPath.values()) pending.sourcePluginId = 'typescript';

  return { packages, pendingByAbsPath, extractContext: parsedOptionsByPkg };
}
