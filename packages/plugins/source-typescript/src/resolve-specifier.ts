import * as path from 'node:path';
import ts from 'typescript';
import {
  moduleCandidateSuffixes,
  packageNodeId,
  resolveByCandidates,
  type PackageInfo,
} from '@repovine/plugin-sdk';
import { extractPackageName, hostKeyedView, hostPathKey } from '@repovine/plugin-sdk';
import {
  DECLARATION_EXT_SUFFIX_RE,
  SOURCE_EXT_SUFFIX_RE,
  TYPESCRIPT_DECLARATION_EXTENSION,
  TYPESCRIPT_INDEX_BASENAMES,
  TYPESCRIPT_JS_EXTENSIONS,
  TYPESCRIPT_TS_EXTENSIONS,
} from './extensions.js';

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

/** Suffix candidates in the order the TypeScript module resolver tries them: an implementation in
 * TypeScript, then a declaration, then an implementation in JavaScript. The order is the contract —
 * a `.d.ts` that outran its own `.ts` would resolve every import to the declaration file — and it is
 * the one fact the declared `moduleIdNormalize` cannot carry, because the id mint reads that as an
 * unordered set. Which suffixes are on it, and the index basenames underneath, come from the same
 * constants the descriptor declares. */
const RESOLVE_SUFFIX_LADDER = [
  ...TYPESCRIPT_TS_EXTENSIONS,
  TYPESCRIPT_DECLARATION_EXTENSION,
  ...TYPESCRIPT_JS_EXTENSIONS,
];

const CANDIDATE_SUFFIXES = moduleCandidateSuffixes({
  fileSuffixes: RESOLVE_SUFFIX_LADDER,
  indexBasenames: TYPESCRIPT_INDEX_BASENAMES,
  // A specifier that already carries its extension resolves against the base path itself.
  includeBareBase: true,
});

function lookupCandidates(basePath: string, absPathToId: Map<string, string>): string | undefined {
  return resolveByCandidates(basePath, CANDIDATE_SUFFIXES, absPathToId);
}

/** NodeNext-style imports use the `.js` extension to refer to a sibling `.ts`/`.tsx` source.
 * Strip the JS-family extension so the candidate suffix loop can match the TS source. The family is
 * the one the descriptor declares, so adding a form to the ecosystem adds it here too. */
function stripJsLikeExtension(specifier: string): string {
  for (const ext of TYPESCRIPT_JS_EXTENSIONS) {
    if (specifier.endsWith(ext)) return specifier.slice(0, -ext.length);
  }
  return specifier;
}

function moduleIdForResolvedFile(
  resolvedFileName: string,
  absPathToId: Map<string, string>,
): string | undefined {
  const abs = path.resolve(resolvedFileName);
  const direct = absPathToId.get(hostPathKey(abs));
  if (direct) return direct;

  const withoutExt = abs.replace(SOURCE_EXT_SUFFIX_RE, '');
  const fromLookup = lookupCandidates(withoutExt, absPathToId);
  if (fromLookup) return fromLookup;

  // A declaration names an implementation beside it; the ladder finds whichever form that is.
  // Case-insensitive like every other suffix test here and like the id mint, which folds both sides.
  if (DECLARATION_EXT_SUFFIX_RE.test(abs)) {
    return lookupCandidates(abs.replace(DECLARATION_EXT_SUFFIX_RE, ''), absPathToId);
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
  if (absPathToId.has(hostPathKey(abs))) return true;
  const withoutExt = abs.replace(DECLARATION_EXT_SUFFIX_RE, '').replace(SOURCE_EXT_SUFFIX_RE, '');
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
  // Canonical view: caller-built maps of any absolute-path shape —
  // tsconfig forward-slash, native walker, POSIX fixtures — resolve identically.
  absPathToId = hostKeyedView(absPathToId);
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
    return { resolvedModuleId: packageNodeId(pkgName), isExternal: false };
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
  return { resolvedModuleId: packageNodeId(pkgName), isExternal: false };
}
