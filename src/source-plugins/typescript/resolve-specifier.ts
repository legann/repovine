import * as path from 'node:path';
import ts from 'typescript';
import type { PackageInfo } from '@repovine/plugin-sdk';
import { extractPackageName } from '../../stage1/utils.js';

/**
 * String-based shortcut for module specifier resolution. Avoids ts-morph's
 * `getModuleSpecifierSourceFile()` (which runs TypeScript's full module resolution and
 * may transitively load shared dependencies into the Project). Operates purely on the
 * global `absPathToId` map built during Pass 1.
 *
 * ## Supported specifier patterns (in resolution order)
 *
 * 1. **Relative** — `./foo`, `../bar` (and NodeNext-style `./foo.js` → `.ts`/`.tsx` source)
 * 2. **Tsconfig `paths`** — per-package aliases from `compilerOptions.paths`, e.g.
 *    `@/*` → `./src/*`, or exact keys like `@drizzle-migration-linter` → a file path
 *    (requires `pathsContext` with the importer package's parsed tsconfig options)
 * 3. **Workspace bare** — `@scope/pkg` → `pkg:@scope/pkg`
 * 4. **Workspace sub-path** — `@scope/pkg/sub/module` → concrete `mod:` when present in
 *    the file map, otherwise `pkg:@scope/pkg`
 * 5. **External** — any other bare or scoped specifier → `isExternal: true`
 *
 * Unresolved relative specifiers return `undefined` (e.g. `.json` imports). Path aliases
 * and workspace misses fall through to the next strategy.
 */
export interface SpecifierResolution {
  resolvedModuleId: string | undefined;
  isExternal: boolean;
}

/** Parsed tsconfig options for the package that owns the importing file. */
export interface PathsContext {
  compilerOptions: ts.CompilerOptions;
}

interface PackageIndex {
  byName: Map<string, PackageInfo>;
}

const packageIndexCache = new WeakMap<PackageInfo[], PackageIndex>();

function indexPackages(packages: PackageInfo[]): PackageIndex {
  const existing = packageIndexCache.get(packages);
  if (existing) return existing;
  const byName = new Map<string, PackageInfo>();
  for (const pkg of packages) byName.set(pkg.name, pkg);
  const idx: PackageIndex = { byName };
  packageIndexCache.set(packages, idx);
  return idx;
}

/** Suffix candidates ordered the way the TypeScript module resolver tries them.
 * Empty string is intentional: handles specifiers that already include the extension. */
const FILE_SUFFIX_CANDIDATES = [
  '.ts',
  '.tsx',
  '.d.ts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '',
];

/** Index resolution candidates appended after FILE candidates. */
const INDEX_SUFFIX_CANDIDATES = [
  '/index.ts',
  '/index.tsx',
  '/index.d.ts',
  '/index.js',
  '/index.jsx',
];

function lookupCandidates(basePath: string, absPathToId: Map<string, string>): string | undefined {
  for (const suffix of FILE_SUFFIX_CANDIDATES) {
    const id = absPathToId.get(basePath + suffix);
    if (id) return id;
  }
  for (const suffix of INDEX_SUFFIX_CANDIDATES) {
    const id = absPathToId.get(basePath + suffix);
    if (id) return id;
  }
  return undefined;
}

/** NodeNext-style imports use the `.js` extension to refer to a sibling `.ts`/`.tsx` source.
 * Strip the JS-family extension so the candidate suffix loop can match the TS source. */
function stripJsLikeExtension(specifier: string): string {
  if (specifier.endsWith('.js')) return specifier.slice(0, -3);
  if (specifier.endsWith('.jsx')) return specifier.slice(0, -4);
  if (specifier.endsWith('.mjs')) return specifier.slice(0, -4);
  if (specifier.endsWith('.cjs')) return specifier.slice(0, -4);
  return specifier;
}

function moduleIdForResolvedFile(
  resolvedFileName: string,
  absPathToId: Map<string, string>,
): string | undefined {
  const abs = path.resolve(resolvedFileName);
  const direct = absPathToId.get(abs);
  if (direct) return direct;

  const withoutExt = abs.replace(/\.(tsx?|jsx?|mjs|cjs)$/i, '');
  const fromLookup = lookupCandidates(withoutExt, absPathToId);
  if (fromLookup) return fromLookup;

  if (abs.endsWith('.d.ts')) {
    const impl = abs.slice(0, -5);
    return lookupCandidates(impl, absPathToId) ?? absPathToId.get(`${impl}.ts`);
  }

  return undefined;
}

/** Resolve via tsconfig `paths` / `baseUrl` using TypeScript's module resolver, then map to `mod:` ids. */
function resolveViaTsconfigPaths(
  specifier: string,
  importingFilePath: string,
  compilerOptions: ts.CompilerOptions,
  absPathToId: Map<string, string>,
): string | undefined {
  const paths = compilerOptions.paths;
  if (!paths || Object.keys(paths).length === 0) return undefined;

  const host = createPathResolutionHost(absPathToId);
  const result = ts.resolveModuleName(
    specifier,
    importingFilePath,
    compilerOptions,
    host,
  );
  const fileName = result.resolvedModule?.resolvedFileName;
  if (!fileName) return undefined;
  return moduleIdForResolvedFile(fileName, absPathToId);
}

function pathExistsInMap(fileName: string, absPathToId: Map<string, string>): boolean {
  const abs = path.resolve(fileName);
  if (absPathToId.has(abs)) return true;
  const withoutExt = abs.replace(/\.d\.ts$/i, '').replace(/\.(tsx?|jsx?|mjs|cjs)$/i, '');
  return lookupCandidates(withoutExt, absPathToId) !== undefined;
}

/** A `node_modules` segment never holds a graph module; never resolve into it. */
const NODE_MODULES_SEGMENT_RE = /[\\/]node_modules([\\/]|$)/;
export function isNodeModulesPath(fileName: string): boolean {
  return NODE_MODULES_SEGMENT_RE.test(fileName);
}

/**
 * Module resolution host: graph file map first, then real filesystem (for production scans).
 * Paths under `node_modules` short-circuit to not-found: a third-party file is never a graph module
 * (`moduleIdForResolvedFile` would return undefined anyway), so resolving into it is wasted work —
 * and on a large monorepo with installed deps it makes `ts.resolveModuleName` walk the whole
 * dependency tree, the memory blow-up behind the build OOM. Blocking it keeps the same result
 * (the import resolves to "external") and never touches the type checker, so the graph is unchanged.
 */
function createPathResolutionHost(absPathToId: Map<string, string>): ts.ModuleResolutionHost {
  const exists = (fileName: string): boolean =>
    !isNodeModulesPath(fileName) && (pathExistsInMap(fileName, absPathToId) || ts.sys.fileExists(fileName));
  return {
    fileExists: exists,
    readFile: fileName => (exists(fileName) ? 'export {}' : undefined),
    getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
  };
}

/**
 * Try to resolve a module specifier using only the file map. Returns `undefined` when a
 * relative specifier does not resolve (JSON imports, missing files). See module doc for the
 * full list of supported patterns.
 */
export function resolveSpecifierFromMap(
  specifier: string,
  importingFilePath: string,
  absPathToId: Map<string, string>,
  packages: PackageInfo[],
  repoRoot: string,
  pathsContext?: PathsContext,
): SpecifierResolution | undefined {
  if (specifier.startsWith('.')) {
    const importerDir = path.dirname(importingFilePath);
    const stripped = stripJsLikeExtension(specifier);
    const basePath = path.resolve(importerDir, stripped);
    const id = lookupCandidates(basePath, absPathToId);
    if (id !== undefined) {
      return { resolvedModuleId: id, isExternal: false };
    }
    return undefined;
  }

  if (pathsContext) {
    const pathsId = resolveViaTsconfigPaths(
      specifier,
      importingFilePath,
      pathsContext.compilerOptions,
      absPathToId,
    );
    if (pathsId !== undefined) {
      return { resolvedModuleId: pathsId, isExternal: false };
    }
  }

  // Non-relative: workspace package or external.
  const pkgName = extractPackageName(specifier);
  const pkg = indexPackages(packages).byName.get(pkgName);
  if (!pkg) {
    // Not a workspace package → external.
    return { resolvedModuleId: undefined, isExternal: true };
  }

  const pkgAbsPath = path.resolve(repoRoot, pkg.path);

  // Bare workspace specifier: `@workspace/pkg` with no sub-path. Resolve to the package
  // entry/barrel module (`<pkg>/index.*` or `<pkg>/src/index.*`) so a cross-package import lands on
  // a real module the linker follows through re-exports to the defining leaf. No entry → package node.
  const subPathRaw = specifier.length > pkgName.length ? specifier.slice(pkgName.length + 1) : '';
  if (!subPathRaw) {
    for (const entryDir of ['', 'src']) {
      const entryId = lookupCandidates(path.resolve(pkgAbsPath, entryDir), absPathToId);
      if (entryId !== undefined) return { resolvedModuleId: entryId, isExternal: false };
    }
    return { resolvedModuleId: `pkg:${pkgName}`, isExternal: false };
  }

  // Workspace sub-path: resolve against the package directory.
  const basePath = path.resolve(pkgAbsPath, stripJsLikeExtension(subPathRaw));
  const id = lookupCandidates(basePath, absPathToId);
  if (id !== undefined) {
    return { resolvedModuleId: id, isExternal: false };
  }

  // Workspace pkg known but specific module not in map — TS resolver may find it via
  // package.json `exports` / conditional exports. Match the legacy behavior of falling
  // back to `pkg:<name>` (existing ts-morph code path does the same on its own miss).
  return { resolvedModuleId: `pkg:${pkgName}`, isExternal: false };
}
