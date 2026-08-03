import * as path from 'node:path';
import type { HostPath, PackageInfo } from '@repovine/plugin-sdk';
import { asHostPath, lastPathSegment, moduleCandidateSuffixes, resolveByCandidates } from '@repovine/plugin-sdk';
import { compareCodeUnits } from '@repovine/plugin-sdk';
import { PYTHON_EXTENSIONS, PYTHON_INDEX_BASENAMES } from './extensions.js';

/**
 * Python import resolution (structural graph). Mirror of `typescript/resolve-specifier.ts`:
 * operates on the global `absPathToId` map and discovered package roots — no disk reads,
 * no sys.path / venv simulation.
 */

export interface PythonImportResolution {
  resolvedModuleId: string | undefined;
  isExternal: boolean;
}

export interface ResolvePythonImportInput {
  /** Absolute path of the importing .py file */
  importingAbsPath: HostPath;
  /** ast.ImportFrom: level + module; ast.Import: level=0, module=dotted name */
  level: number;
  moduleDotted: string;
  kind: 'import' | 'from';
  /** Global map from Pass 1 orchestrator (all languages' files) */
  absPathToId: ReadonlyMap<string, string>;
  /** Python packages discovered in this repo */
  packages: PackageInfo[];
  repoRoot: HostPath;
  /** Package that owns the importing file */
  importingPackage: PackageInfo;
}

/** The module file, then the package directory it stands for. Both halves come from the facts the
 *  descriptor declares, so the resolver spells neither the extension nor the index basename again. */
const CANDIDATE_SUFFIXES = moduleCandidateSuffixes({
  fileSuffixes: PYTHON_EXTENSIONS,
  indexBasenames: PYTHON_INDEX_BASENAMES,
});

function lookupModule(
  baseAbsPath: HostPath,
  absPathToId: ReadonlyMap<string, string>,
): string | undefined {
  return resolveByCandidates(baseAbsPath, CANDIDATE_SUFFIXES, absPathToId);
}

function normalizePyName(name: string): string {
  return name.replace(/-/g, '_');
}

function packageMatchesTopLevel(pkg: PackageInfo, topLevel: string): boolean {
  const normalizedTop = normalizePyName(topLevel);
  if (pkg.name === topLevel || normalizePyName(pkg.name) === normalizedTop) return true;
  const base = lastPathSegment(pkg.repoRelDir);
  return base === topLevel || normalizePyName(base) === normalizedTop;
}

function sortedPythonPackages(packages: PackageInfo[]): PackageInfo[] {
  return packages
    .filter(p => p.sourcePluginId === 'python')
    .sort((a, b) => compareCodeUnits(a.repoRelDir, b.repoRelDir));
}

function dottedToSegments(moduleDotted: string): string[] {
  return moduleDotted.split('.').filter(Boolean);
}

function resolveRelative(
  importingAbsPath: HostPath,
  level: number,
  moduleDotted: string,
  absPathToId: ReadonlyMap<string, string>,
): string | undefined {
  let dir = path.dirname(importingAbsPath);
  for (let i = 1; i < level; i++) dir = path.dirname(dir);
  const tail = dottedToSegments(moduleDotted);
  const base = tail.length > 0 ? path.join(dir, ...tail) : dir;
  return lookupModule(asHostPath(base), absPathToId);
}

/** Resolve within a single package root (same-package absolute imports like `from models import X`). */
function resolveIntraPackage(
  pkgRoot: HostPath,
  moduleDotted: string,
  absPathToId: ReadonlyMap<string, string>,
): string | undefined {
  const segments = dottedToSegments(moduleDotted);
  if (segments.length === 0) return undefined;
  const base = path.join(pkgRoot, ...segments);
  return lookupModule(asHostPath(base), absPathToId);
}

/** Resolve cross-package absolute imports (`from otherpkg.sub import x`). */
function resolveCrossPackage(
  topLevel: string,
  moduleDotted: string,
  packages: PackageInfo[],
  repoRoot: HostPath,
  absPathToId: ReadonlyMap<string, string>,
): string | undefined {
  const tail = dottedToSegments(moduleDotted).slice(1);
  for (const pkg of sortedPythonPackages(packages)) {
    if (!packageMatchesTopLevel(pkg, topLevel)) continue;
    const pkgRoot = asHostPath(path.resolve(repoRoot, pkg.repoRelDir));
    const segments = [topLevel, ...tail];
    const base = path.join(pkgRoot, ...segments);
    const id = lookupModule(asHostPath(base), absPathToId);
    if (id) return id;
    // Flat layout: module file may live directly under package root without a nested topLevel dir.
    if (tail.length > 0) {
      const flatBase = path.join(pkgRoot, ...tail);
      const flatId = lookupModule(asHostPath(flatBase), absPathToId);
      if (flatId) return flatId;
    }
  }
  return undefined;
}

export function resolvePythonImport(input: ResolvePythonImportInput): PythonImportResolution {
  const {
    importingAbsPath,
    level,
    moduleDotted,
    absPathToId,
    packages,
    repoRoot,
    importingPackage,
  } = input;

  if (level > 0) {
    const id = resolveRelative(importingAbsPath, level, moduleDotted, absPathToId);
    return { resolvedModuleId: id, isExternal: false };
  }

  const dotted = moduleDotted.trim();
  if (!dotted) {
    return { resolvedModuleId: undefined, isExternal: true };
  }

  const pkgRoot = asHostPath(path.resolve(repoRoot, importingPackage.repoRelDir));
  const intraId = resolveIntraPackage(pkgRoot, dotted, absPathToId);
  if (intraId) {
    return { resolvedModuleId: intraId, isExternal: false };
  }

  const topLevel = dottedToSegments(dotted)[0]!;
  const crossId = resolveCrossPackage(topLevel, dotted, packages, repoRoot, absPathToId);
  if (crossId) {
    return { resolvedModuleId: crossId, isExternal: false };
  }

  return { resolvedModuleId: undefined, isExternal: true };
}
