import { compileGlob } from '../glob.js';
import { normalizeRelPath } from '../paths.js';
import { matchesEngineIgnorePath } from './discovery-walk.js';
import type { CompiledScanPattern, CompiledScanPatterns, ScanPatternInput, ScanScope } from './types.js';

/**
 * `build.scan` include/exclude matching.
 *
 * The engine compiles the user's patterns once and hands them to `discover()` on
 * `SourceDiscoveryOptions.scanPatterns`; the producer applies them to each candidate path it walks.
 * Both halves live here so the answer to "is this file in scope" is one function: a producer that
 * wrote its own matcher would let a repository's scan config mean one thing to the engine and
 * another to the plugin that reads the files.
 */

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

/** Infra file collection for a repo-relative path. */
export function shouldScanInfraPath(relPath: string, patterns: CompiledScanPatterns): boolean {
  const norm = normalizeRelPath(relPath);
  if (matchesEngineIgnorePath(norm)) return false;
  if (isScanIncluded(norm, patterns, 'infra')) return true;
  if (isScanExcluded(norm, patterns, 'infra')) return false;
  return true;
}

/**
 * Source discovery for a repo-relative path.
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
