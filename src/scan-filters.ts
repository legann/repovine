// Imported from the schema module, not the `stage2/domains` barrel: scanning runs before any
// source plugin is registered, and routing through the barrel would pull the plugin bootstrap
// into the scanner's own import cycle.
import { compileGlob, type GlobMatcher } from './stage2/domains-schema.js';
import { REPOVINE_ENGINE_SCAN_IGNORE_PATTERNS } from './paths.js';
import { normalizeRelPath, toPosixPath } from './platform/paths.js';

/** Repo-root-relative glob or scoped pattern entry from `repovine.config.json` → `build.scan`. */
export type ScanScope = 'all' | 'source' | 'infra';

export type ScanPatternInput =
  | string
  | {
      path: string;
      scope?: ScanScope;
    };

export interface CompiledScanPattern {
  matcher: GlobMatcher;
  scope: ScanScope;
}

export interface CompiledScanPatterns {
  include: CompiledScanPattern[];
  exclude: CompiledScanPattern[];
}

function parsePatternEntry(entry: ScanPatternInput): { glob: string; scope: ScanScope } {
  if (typeof entry === 'string') {
    return { glob: entry, scope: 'all' };
  }
  return { glob: entry.path, scope: entry.scope ?? 'all' };
}

export function compileScanPatterns(
  include: readonly ScanPatternInput[] = [],
  exclude: readonly ScanPatternInput[] = [],
): CompiledScanPatterns {
  return {
    include: include.map(entry => {
      const { glob, scope } = parsePatternEntry(entry);
      return { matcher: compileGlob(glob), scope };
    }),
    exclude: exclude.map(entry => {
      const { glob, scope } = parsePatternEntry(entry);
      return { matcher: compileGlob(glob), scope };
    }),
  };
}

function scopeApplies(patternScope: ScanScope, requestScope: 'source' | 'infra'): boolean {
  return patternScope === 'all' || patternScope === requestScope;
}

function matchesAny(
  relPath: string,
  patterns: readonly CompiledScanPattern[],
  requestScope: 'source' | 'infra',
): boolean {
  const norm = normalizeRelPath(relPath);
  for (const pattern of patterns) {
    if (!scopeApplies(pattern.scope, requestScope)) continue;
    if (pattern.matcher.test(norm)) return true;
  }
  return false;
}

function matchesEngineIgnore(relPath: string): boolean {
  const norm = normalizeRelPath(relPath);
  for (const fragment of REPOVINE_ENGINE_SCAN_IGNORE_PATTERNS) {
    const q = toPosixPath(fragment).replace(/^\//, '').replace(/\/$/, '');
    if (!q) continue;
    if (norm === q) return true;
    if (norm.startsWith(`${q}/`)) return true;
    if (norm.includes(`/${q}/`) || norm.endsWith(`/${q}`)) return true;
  }
  return false;
}

/**
 * Whether a walker should descend into this repo-relative directory.
 *
 * The engine ignore list is the same one that rejects files, asked one level up: a directory the
 * list names holds nothing the graph wants, so pruning there and rejecting per file give the same
 * answer at a fraction of the readdir calls. Walkers that look for PACKAGE MARKERS rather than
 * source files need this specifically — a `tsconfig.json` under `.venv/` or a `pyproject.toml`
 * under `coverage/` mints a package node whose every module the file filter then rejects, so the
 * repository grows a package with no modules in it.
 *
 * User `scan.exclude` is deliberately not consulted: an exclude pattern narrows what is indexed,
 * and a walker that stopped descending on it could not honour a more specific `scan.include`
 * underneath.
 */
function shouldWalkScanDir(relDirPath: string): boolean {
  return !matchesEngineIgnore(relDirPath);
}

/**
 * Directory names that hold tests by convention, in any ecosystem the engine discovers.
 *
 * Separate from the engine ignore list because it answers a separate question: those directories
 * are not build output or dependency trees, they are first-class repository content that the graph
 * deliberately leaves out. Keeping the two apart also keeps `scan.include` meaningful — a user who
 * points it at `tests/` is asking for something the engine ignore list would never have allowed.
 */
const TEST_LAYOUT_DIRS: ReadonlySet<string> = new Set([
  'test', 'tests', '__tests__', '__mocks__', '__snapshots__',
  'e2e', '__e2e__', 'cypress', 'playwright',
]);

/** True when any segment of the repo-relative path is a test-layout directory. */
function hasTestLayoutSegment(relPath: string): boolean {
  return normalizeRelPath(relPath).split('/').some(segment => TEST_LAYOUT_DIRS.has(segment));
}

/**
 * Whether a discovery walker should descend into this repo-relative directory at all: neither an
 * engine-ignored tree nor a test-layout one. Every walker that mints repository content — packages,
 * modules, templates, infra files — asks this, so a directory is present in the graph or absent
 * from it, not present through one producer and absent through another.
 */
export function shouldWalkDiscoveryDir(relDirPath: string): boolean {
  return shouldWalkScanDir(relDirPath) && !hasTestLayoutSegment(relDirPath);
}

/** User `scan.include` match — wins over exclude. */
export function isScanIncluded(
  relPath: string,
  patterns: CompiledScanPatterns,
  scope: 'source' | 'infra',
): boolean {
  return matchesAny(relPath, patterns.include, scope);
}

/** User `scan.exclude` match — ignored when include matches. */
export function isScanExcluded(
  relPath: string,
  patterns: CompiledScanPatterns,
  scope: 'source' | 'infra',
): boolean {
  if (isScanIncluded(relPath, patterns, scope)) return false;
  return matchesAny(relPath, patterns.exclude, scope);
}

/** Stage 1 infra file collection. */
export function shouldScanInfraPath(relPath: string, patterns: CompiledScanPatterns): boolean {
  const norm = normalizeRelPath(relPath);
  if (matchesEngineIgnore(norm)) return false;
  if (isScanIncluded(norm, patterns, 'infra')) return true;
  if (isScanExcluded(norm, patterns, 'infra')) return false;
  return true;
}

/**
 * Stage 1 source discovery for a repo-relative path.
 * `.d.ts` files are skipped unless explicitly included.
 */
export function shouldScanSourcePath(relPath: string, patterns: CompiledScanPatterns): boolean {
  const norm = normalizeRelPath(relPath);
  if (matchesEngineIgnore(norm)) return false;
  if (isScanIncluded(norm, patterns, 'source')) return true;
  if (isScanExcluded(norm, patterns, 'source')) return false;
  if (norm.endsWith('.d.ts')) return false;
  return true;
}
