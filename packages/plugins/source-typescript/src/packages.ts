import * as path from 'node:path';
import * as fs from 'node:fs';
import type { HostPath, PackageInfo, RepoRelPath } from '@repovine/plugin-sdk';
import { asHostPath, asRepoRelPath, classifyDiscoveryDir, compareCodeUnits, readDirSorted, repoRelativePosix } from '@repovine/plugin-sdk';
import type { SourceDiscoveryOptions } from '@repovine/plugin-sdk';
/**
 * The TypeScript packages of a repository: every directory holding one of the marker files the host
 * resolved for this plugin.
 *
 * `markers` is not defaulted. What names a package root is declared once, and a caller that could
 * omit it would discover by whatever this module happened to spell.
 */
export function discoverPackages(
  repoRoot: HostPath,
  markers: readonly string[],
  onPruned?: SourceDiscoveryOptions['onPruned'],
): PackageInfo[] {
  const markerDirs = findAllPackageMarkerDirs(repoRoot, markers, onPruned);
  const packages: PackageInfo[] = [];
  const seen = new Set<string>();

  for (const dir of markerDirs) {
    // POSIX form: pkg.path is persisted identity and is minted into
    // module ids; path.normalize would keep win32 backslashes.
    // `'.'` names the repository root itself; the empty relative path is not a package path.
    const normalized = repoRelativePosix(repoRoot, dir) || asRepoRelPath('.');
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const info = readPackageInfoFromDir(dir, normalized, markers);
    if (info) packages.push(info);
  }

  return packages.sort((a, b) => compareCodeUnits(a.repoRelDir, b.repoRelDir));
}

function hasPackageMarker(dir: HostPath, markers: readonly string[]): boolean {
  return markers.some(marker => fs.existsSync(path.join(dir, marker)));
}

function findAllPackageMarkerDirs(
  repoRoot: HostPath,
  markers: readonly string[],
  onPruned?: SourceDiscoveryOptions['onPruned'],
): HostPath[] {
  const result: HostPath[] = [];
  function walk(dir: HostPath) {
    // Match skip segments relative to the scanned root only. Absolute paths may
    // contain "/test/" in parent dirs (e.g. repovine/test/fixtures/*) while the
    // fixture itself is the repo root and must still be discovered.
    const rel = repoRelativePosix(repoRoot, dir);
    if (rel) {
      const pruned = classifyDiscoveryDir(rel, dir);
      if (pruned) {
        onPruned?.(pruned);
        return;
      }
    }
    if (hasPackageMarker(dir, markers)) {
      result.push(dir);
    }

    let entries: fs.Dirent[];
    try {
      entries = readDirSorted(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      walk(asHostPath(path.join(dir, e.name)));
    }
  }
  walk(repoRoot);
  return result;
}

function readPackageInfoFromDir(
  pkgDir: HostPath,
  repoRelDir: RepoRelPath,
  markers: readonly string[],
): PackageInfo | null {
  if (!hasPackageMarker(pkgDir, markers)) return null;

  let name: string;
  let version: string | undefined;
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      name = pkgJson.name || pathToSlug(repoRelDir);
      version = pkgJson.version;
    } catch {
      name = pathToSlug(repoRelDir);
    }
  } else {
    name = pathToSlug(repoRelDir);
  }

  return {
    name,
    repoRelDir,
    version,
  };
}

function pathToSlug(repoRelDir: RepoRelPath): string {
  // Input is POSIX-relative by contract; path.normalize would
  // re-introduce win32 backslashes past the '/'-only replace (the python
  // plugin's slug() had the identical defect).
  const normalized = repoRelDir || '.';
  if (normalized === '.') return 'root';
  return normalized.replace(/\/+/g, '-').replace(/^\.-/, '') || 'root';
}
