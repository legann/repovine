import * as path from 'node:path';
import type { PackageInfo } from '@repovine/plugin-sdk';
import { moduleCandidateSuffixes, resolveByCandidates } from '@repovine/plugin-sdk';
import { compareCodeUnits } from '../../platform/ordering.js';
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
  importingFilePath: string;
  /** ast.ImportFrom: level + module; ast.Import: level=0, module=dotted name */
  level: number;
  moduleDotted: string;
  kind: 'import' | 'from';
  /** Global map from Pass 1 orchestrator (all languages' files) */
  absPathToId: Map<string, string>;
  /** Python packages discovered in this repo */
  packages: PackageInfo[];
  repoRoot: string;
  /** Package that owns the importing file */
  importingPackage: PackageInfo;
}

/** The module file, then the package directory it stands for. Both halves come from the facts the
 *  descriptor declares, so the resolver spells neither the extension nor the index basename again. */
const CANDIDATE_SUFFIXES = moduleCandidateSuffixes({
  fileSuffixes: PYTHON_EXTENSIONS,
  indexBasenames: PYTHON_INDEX_BASENAMES,
});

function lookupModule(basePath: string, absPathToId: Map<string, string>): string | undefined {
  return resolveByCandidates(basePath, CANDIDATE_SUFFIXES, absPathToId);
}

function normalizePyName(name: string): string {
  return name.replace(/-/g, '_');
}

function packageMatchesTopLevel(pkg: PackageInfo, topLevel: string): boolean {
  const normalizedTop = normalizePyName(topLevel);
  if (pkg.name === topLevel || normalizePyName(pkg.name) === normalizedTop) return true;
  const base = path.basename(pkg.path);
  return base === topLevel || normalizePyName(base) === normalizedTop;
}

function sortedPythonPackages(packages: PackageInfo[]): PackageInfo[] {
  return packages
    .filter(p => p.sourcePluginId === 'python')
    .sort((a, b) => compareCodeUnits(a.path, b.path));
}

function dottedToSegments(moduleDotted: string): string[] {
  return moduleDotted.split('.').filter(Boolean);
}

function resolveRelative(
  importingFilePath: string,
  level: number,
  moduleDotted: string,
  absPathToId: Map<string, string>,
): string | undefined {
  let dir = path.dirname(importingFilePath);
  for (let i = 1; i < level; i++) dir = path.dirname(dir);
  const tail = dottedToSegments(moduleDotted);
  const base = tail.length > 0 ? path.join(dir, ...tail) : dir;
  return lookupModule(base, absPathToId);
}

/** Resolve within a single package root (same-package absolute imports like `from models import X`). */
function resolveIntraPackage(
  pkgRoot: string,
  moduleDotted: string,
  absPathToId: Map<string, string>,
): string | undefined {
  const segments = dottedToSegments(moduleDotted);
  if (segments.length === 0) return undefined;
  const base = path.join(pkgRoot, ...segments);
  return lookupModule(base, absPathToId);
}

/** Resolve cross-package absolute imports (`from otherpkg.sub import x`). */
function resolveCrossPackage(
  topLevel: string,
  moduleDotted: string,
  packages: PackageInfo[],
  repoRoot: string,
  absPathToId: Map<string, string>,
): string | undefined {
  const tail = dottedToSegments(moduleDotted).slice(1);
  for (const pkg of sortedPythonPackages(packages)) {
    if (!packageMatchesTopLevel(pkg, topLevel)) continue;
    const pkgRoot = path.resolve(repoRoot, pkg.path);
    const segments = [topLevel, ...tail];
    const base = path.join(pkgRoot, ...segments);
    const id = lookupModule(base, absPathToId);
    if (id) return id;
    // Flat layout: module file may live directly under package root without a nested topLevel dir.
    if (tail.length > 0) {
      const flatBase = path.join(pkgRoot, ...tail);
      const flatId = lookupModule(flatBase, absPathToId);
      if (flatId) return flatId;
    }
  }
  return undefined;
}

export function resolvePythonImport(input: ResolvePythonImportInput): PythonImportResolution {
  const {
    importingFilePath,
    level,
    moduleDotted,
    absPathToId,
    packages,
    repoRoot,
    importingPackage,
  } = input;

  if (level > 0) {
    const id = resolveRelative(importingFilePath, level, moduleDotted, absPathToId);
    return { resolvedModuleId: id, isExternal: false };
  }

  const dotted = moduleDotted.trim();
  if (!dotted) {
    return { resolvedModuleId: undefined, isExternal: true };
  }

  const pkgRoot = path.resolve(repoRoot, importingPackage.path);
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
