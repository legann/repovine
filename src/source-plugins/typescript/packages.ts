import * as path from 'node:path';
import * as fs from 'node:fs';
import type { PackageInfo } from '@repovine/plugin-sdk';

const DISCOVER_SKIP =
  /\/(node_modules|\.git|dist|dist-bundled|target|build|out|coverage|\.next|__tests__|__mocks__|__snapshots__|\.cache|test|tests|e2e|cypress|playwright)(\/|$)/;

export function discoverPackages(repoRoot: string): PackageInfo[] {
  const tsconfigDirs = findAllTsconfigDirs(repoRoot);
  const packages: PackageInfo[] = [];
  const seen = new Set<string>();

  for (const dir of tsconfigDirs) {
    // POSIX form: pkg.path is persisted identity and is minted into
    // module ids; path.normalize would keep win32 backslashes.
    const relPath = path.relative(repoRoot, dir);
    const normalized = (relPath || '.').split(path.sep).join('/');
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const info = readPackageInfoFromDir(dir, normalized);
    if (info) packages.push(info);
  }

  return packages.sort((a, b) => a.path.localeCompare(b.path));
}

function findAllTsconfigDirs(repoRoot: string): string[] {
  const result: string[] = [];
  function walk(dir: string) {
    // Match skip segments relative to the scanned root only. Absolute paths may
    // contain "/test/" in parent dirs (e.g. repovine/test/fixtures/*) while the
    // fixture itself is the repo root and must still be discovered.
    const rel = path.relative(repoRoot, dir);
    if (rel && DISCOVER_SKIP.test(`/${rel.split(path.sep).join('/')}/`)) return;
    const tsconfigPath = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(tsconfigPath)) {
      result.push(dir);
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'target' || e.name === 'build' || e.name === 'out' || e.name === 'coverage' || e.name === '.cache' || e.name === 'test') continue;
      walk(path.join(dir, e.name));
    }
  }
  walk(repoRoot);
  return result;
}

function readPackageInfoFromDir(pkgDir: string, relativePath: string): PackageInfo | null {
  const tsconfigPath = path.join(pkgDir, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return null;

  let name: string;
  let version: string | undefined;
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      name = pkgJson.name || pathToSlug(relativePath);
      version = pkgJson.version;
    } catch {
      name = pathToSlug(relativePath);
    }
  } else {
    name = pathToSlug(relativePath);
  }

  return {
    name,
    path: relativePath,
    version,
  };
}

function pathToSlug(relativePath: string): string {
  // Input is POSIX-relative by contract; path.normalize would
  // re-introduce win32 backslashes past the '/'-only replace (the python
  // plugin's slug() had the identical defect).
  const normalized = relativePath || '.';
  if (normalized === '.') return 'root';
  return normalized.replace(/\/+/g, '-').replace(/^\.-/, '') || 'root';
}
