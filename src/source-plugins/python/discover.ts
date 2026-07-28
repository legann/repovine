import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import type { PackageInfo, PendingModuleDraft } from '@repovine/plugin-sdk';
import type { SourceDiscoveryOptions, SourceDiscoveryResult } from '@repovine/plugin-sdk';
import { walkRepository } from '@repovine/plugin-sdk';
import { compileScanPatterns, shouldScanSourcePath, shouldWalkDiscoveryDir, type CompiledScanPatterns } from '../../scan-filters.js';
import { hostPathKey, repoRelativePosix, toPosixPath } from '../../platform/paths.js';
import { readDirSorted } from '../../fs/read-dir-sorted.js';
import { compareCodeUnits } from '../../platform/ordering.js';
import { PYTHON_PACKAGE_MARKERS } from './extensions.js';

/**
 * Python discovery (Pass 1). Finds Python packages (`pyproject.toml` / `setup.py`) and their
 * `.py` files. No AST here — extraction happens in extract.ts via a `python -c` subprocess.
 */

/** Opaque extractContext for this plugin: the resolved interpreter (or null when unavailable). */
export interface PythonExtractContext {
  pythonBin: string | null;
}

const SKIP_FILE_RE = /^(test_.*\.py|.*_test\.py|conftest\.py)$/i;

let cachedPythonBin: string | null | undefined;

/** A directory outside any analyzed repository, used as the working directory for interpreter
 * subprocesses. The OS spawn search inspects the child's cwd before PATH on Windows, and `python -c`
 * puts the cwd on `sys.path`; running from the temp dir keeps a repo-local `python.exe` or a
 * repo-local `ast.py` from being executed. */
export function safeInterpreterCwd(): string {
  return os.tmpdir();
}

/** A PATH entry is trusted for interpreter resolution only when it is an absolute directory other
 * than the current working directory. An empty entry and a relative entry both denote a cwd-relative
 * location to the OS executable search — the exact vector a repo-local interpreter would exploit —
 * so neither is a place to look for a real interpreter. */
export function isTrustedInterpreterPathEntry(entry: string, cwd: string = process.cwd()): boolean {
  if (!entry || !path.isAbsolute(entry)) return false;
  return hostPathKey(path.resolve(entry)) !== hostPathKey(path.resolve(cwd));
}

/** Verify a resolved interpreter can import the stdlib `ast` module (the extractor's only
 * dependency). Runs from a non-repo cwd; the bounded timeout keeps a wedged shim (network-FS pyenv,
 * stale WSL stub) from hanging the scanner or `doctor`, and windowsHide suppresses a console flash. */
function interpreterImportsAst(interpreterPath: string): boolean {
  try {
    execFileSync(interpreterPath, ['-c', 'import ast, sys'], {
      stdio: 'ignore',
      timeout: 3_000,
      windowsHide: true,
      cwd: safeInterpreterCwd(),
    });
    return true;
  } catch {
    return false;
  }
}

/** Executable-file candidates for a bare interpreter name in one PATH directory. On Windows a bare
 * name resolves through PATHEXT; restrict it to `.exe`/`.com` — a `.bat`/`.cmd` shim is a separate
 * class a no-shell spawn will not launch. POSIX uses the extensionless name. */
function interpreterCandidates(dir: string, name: string): string[] {
  if (process.platform === 'win32') {
    return ['.exe', '.com'].map(ext => path.join(dir, name + ext));
  }
  return [path.join(dir, name)];
}

/** Resolve an interpreter name to an absolute path on PATH, returning the first candidate that both
 * exists and imports `ast`. Untrusted PATH entries (empty, relative, or the cwd) are skipped so a
 * repo-local `./python` — which the Windows spawn search would try before PATH — never wins. */
function resolveInterpreterOnPath(name: string): string | null {
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!isTrustedInterpreterPathEntry(entry)) continue;
    for (const candidate of interpreterCandidates(entry, name)) {
      let isFile = false;
      try { isFile = fs.statSync(candidate).isFile(); } catch { /* not present here */ }
      if (isFile && interpreterImportsAst(candidate)) return candidate;
    }
  }
  return null;
}

/** Resolve a usable interpreter once per process. Returns the absolute path to python3/python — never
 * a bare name, so the spawn search cannot fall back to the current directory — or null when neither
 * can import the stdlib `ast` module (the only dependency the extractor needs). */
export function detectPython(): string | null {
  if (cachedPythonBin !== undefined) return cachedPythonBin;
  for (const name of ['python3', 'python']) {
    const resolved = resolveInterpreterOnPath(name);
    if (resolved) {
      cachedPythonBin = resolved;
      return resolved;
    }
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
      entries = readDirSorted(dir);
    } catch {
      return;
    }
    if (PYTHON_PACKAGE_MARKERS.some(m => fs.existsSync(path.join(dir, m)))) {
      // POSIX form: pkg.path is persisted identity; path.resolve
      // consumes forward slashes on every OS.
      // `'.'` names the repository root itself; the empty relative path is not a package path.
      const normalized = repoRelativePosix(repoRoot, dir) || '.';
      if (!seen.has(normalized)) {
        seen.add(normalized);
        packages.push({
          name: pyPackageName(dir, slug(normalized)),
          path: normalized,
          sourcePluginId: 'python',
        });
      }
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!shouldWalkDiscoveryDir(repoRelativePosix(repoRoot, path.join(dir, e.name)))) continue;
      walk(path.join(dir, e.name));
    }
  };
  walk(repoRoot);
  return packages.sort((a, b) => compareCodeUnits(a.path, b.path));
}

function discoverPyFiles(
  pkgAbs: string,
  repoRoot: string,
  pkg: PackageInfo,
  scanPatterns: CompiledScanPatterns,
  pendingByPath: Map<string, PendingModuleDraft>,
): void {
  // Starts inside the package, prunes by the path the graph knows: a package under a directory the
  // engine ignore list names is still walked when discovery reached it deliberately, while a
  // `node_modules` inside that package is not.
  walkRepository(pkgAbs, {
    repoRoot,
    onFile: ({ absPath, relFromRoot, name }) => {
      if (path.extname(name).toLowerCase() !== '.py') return;
      if (SKIP_FILE_RE.test(name)) return;
      if (!shouldScanSourcePath(relFromRoot, scanPatterns)) return;

      const relPathNative = path.relative(pkgAbs, absPath);
      if (relPathNative.startsWith('..')) return;
      // Persisted repo-relative identity is POSIX-normalized: relPath
      // feeds module labels and detector evidence, which must match cross-OS.
      const relPath = toPosixPath(relPathNative);
      // Canonical key — uniform with the TS plugin so the stage-1
      // cross-plugin merge dedupes on one key form.
      if (pendingByPath.has(hostPathKey(absPath))) return;
      pendingByPath.set(hostPathKey(absPath), {
        filePath: absPath,
        pkg,
        relPath,
        sourcePluginId: 'python',
      });
    },
  });
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
