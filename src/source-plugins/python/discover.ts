import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { PackageInfo, PendingModuleDraft } from '@repovine/plugin-sdk';
import type { SourceDiscoveryOptions, SourceDiscoveryResult } from '@repovine/plugin-sdk';
import { compileScanPatterns, shouldScanSourcePath, type CompiledScanPatterns } from '../../scan-filters.js';
import { hostPathKey } from '../../platform/paths.js';

/**
 * Python discovery (Pass 1). Finds Python packages (`pyproject.toml` / `setup.py`) and their
 * `.py` files. No AST here — extraction happens in extract.ts via a `python -c` subprocess.
 */

export const PYTHON_EXTENSIONS = ['.py'];
export const PYTHON_PACKAGE_MARKERS = ['pyproject.toml', 'setup.py'];

/** Opaque extractContext for this plugin: the resolved interpreter (or null when unavailable). */
export interface PythonExtractContext {
  pythonBin: string | null;
}

const SKIP_DIRS = new Set([
  '__pycache__', '.venv', 'venv', 'env', '.env', '.git', 'node_modules', 'dist', 'build',
  '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.eggs', 'site-packages',
  'tests', 'test', '.repovine', '.cache', '.nox',
]);
const SKIP_FILE_RE = /^(test_.*\.py|.*_test\.py|conftest\.py)$/i;

let cachedPythonBin: string | null | undefined;

/** Resolve a usable interpreter once per process. Returns null when neither python3 nor python
 * can import the stdlib `ast` module (the only dependency the extractor needs). */
export function detectPython(): string | null {
  if (cachedPythonBin !== undefined) return cachedPythonBin;
  for (const bin of ['python3', 'python']) {
    try {
      // timeout: a wedged interpreter shim (network-FS pyenv, stale WSL stub)
      // must not hang the scanner or `doctor`; windowsHide keeps the probe from
      // flashing a console window.
      execFileSync(bin, ['-c', 'import ast, sys'], { stdio: 'ignore', timeout: 3_000, windowsHide: true });
      cachedPythonBin = bin;
      return bin;
    } catch { /* try next candidate */ }
  }
  cachedPythonBin = null;
  return null;
}

/** Module id for a Python file. Mirrors the TS scheme: strip the extension and collapse
 * `__init__` (the Python analogue of `index`) so a package dir and its `__init__.py` share an id
 * and handler resolution (`app.handler` → `app`) lines up across languages. */
function slug(relPath: string): string {
  // Input is POSIX-relative by contract; path.normalize here would
  // re-introduce win32 backslashes that the '/'-only replace misses.
  const normalized = relPath || '.';
  if (normalized === '.') return 'root';
  return normalized.replace(/\/+/g, '-').replace(/^\.-/, '') || 'root';
}

/** Best-effort package name from pyproject.toml `name = "..."` (no TOML dependency); falls back
 * to a path slug. Reads the first top-level `name =` which covers PEP 621 `[project]` and Poetry. */
function pyPackageName(pkgDir: string, fallback: string): string {
  const pyproject = path.join(pkgDir, 'pyproject.toml');
  if (fs.existsSync(pyproject)) {
    try {
      const m = fs.readFileSync(pyproject, 'utf-8').match(/^\s*name\s*=\s*["']([^"']+)["']/m);
      if (m) return m[1];
    } catch { /* ignore */ }
  }
  return fallback;
}

function discoverPythonPackages(repoRoot: string): PackageInfo[] {
  const packages: PackageInfo[] = [];
  const seen = new Set<string>();
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (PYTHON_PACKAGE_MARKERS.some(m => fs.existsSync(path.join(dir, m)))) {
      // POSIX form: pkg.path is persisted identity; path.resolve
      // consumes forward slashes on every OS.
      const normalized = (path.relative(repoRoot, dir) || '.').split(path.sep).join('/');
      if (!seen.has(normalized)) {
        seen.add(normalized);
        packages.push({
          name: pyPackageName(dir, slug(normalized)),
          path: normalized,
          sourcePluginId: 'python',
        });
      }
    }
    for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory()) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name));
    }
  };
  walk(repoRoot);
  return packages.sort((a, b) => a.path.localeCompare(b.path));
}

function discoverPyFiles(
  pkgAbs: string,
  repoRoot: string,
  pkg: PackageInfo,
  scanPatterns: CompiledScanPatterns,
  pendingByPath: Map<string, PendingModuleDraft>,
): void {
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      const relFromRoot = path.normalize(path.relative(repoRoot, full)).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (path.extname(e.name).toLowerCase() !== '.py') continue;
      if (SKIP_FILE_RE.test(e.name)) continue;
      if (!shouldScanSourcePath(relFromRoot, scanPatterns)) continue;

      const relPathNative = path.relative(pkgAbs, full);
      if (relPathNative.startsWith('..')) continue;
      // Persisted repo-relative identity is POSIX-normalized: relPath
      // feeds module labels and detector evidence, which must match cross-OS.
      const relPath = relPathNative.split(path.sep).join('/');
      // Canonical key — uniform with the TS plugin so the stage-1
      // cross-plugin merge dedupes on one key form.
      if (pendingByPath.has(hostPathKey(full))) continue;
      pendingByPath.set(hostPathKey(full), {
        filePath: full,
        pkg,
        relPath,
        sourcePluginId: 'python',
      });
    }
  };
  walk(pkgAbs);
}

export function discoverPython(repoRoot: string, options: SourceDiscoveryOptions): SourceDiscoveryResult {
  // The engine gates discovery on the plugin's `available()` (→ detectPython), so an interpreter is
  // present by here. The null-guard stays as a defensive no-op; the user-facing "interpreter not
  // found" warning is emitted once at the engine boundary, not per discover() call.
  const pythonBin = detectPython();
  if (!pythonBin) {
    return { packages: [], pendingByPath: new Map(), extractContext: { pythonBin: null } as PythonExtractContext };
  }

  const scanPatterns = options.scanPatterns ?? compileScanPatterns([], []);
  const packages = discoverPythonPackages(repoRoot);
  const pendingByPath = new Map<string, PendingModuleDraft>();
  for (const pkg of packages) {
    const pkgAbs = path.resolve(repoRoot, pkg.path);
    discoverPyFiles(pkgAbs, repoRoot, pkg, scanPatterns, pendingByPath);
  }
  return { packages, pendingByPath, extractContext: { pythonBin } as PythonExtractContext };
}
