// Imported from the schema module, not the `stage2/domains` barrel: scanning runs before any
// source plugin is registered, and routing through the barrel would pull the plugin bootstrap
// into the scanner's own import cycle.
import { compileGlob, type GlobMatcher } from './stage2/domains-schema.js';
import { matchesEngineIgnorePath, shouldWalkDiscoveryDir } from '@repovine/plugin-sdk';
import { normalizeRelPath } from './platform/paths.js';

/**
 * The discovery prune predicate lives in the SDK beside the walk that applies it, so a plugin and
 * the engine leave out the same directories. Re-exported here because engine callers read the whole
 * scan vocabulary — user patterns and engine ignores — from this module.
 */
export { shouldWalkDiscoveryDir };

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
  if (matchesEngineIgnorePath(norm)) return false;
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
  if (matchesEngineIgnorePath(norm)) return false;
  if (isScanIncluded(norm, patterns, 'source')) return true;
  if (isScanExcluded(norm, patterns, 'source')) return false;
  if (norm.endsWith('.d.ts')) return false;
  return true;
}
