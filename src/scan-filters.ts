import { globToRegex } from './stage2/domains.js';
import { REPOVINE_ENGINE_SCAN_IGNORE_PATTERNS } from './paths.js';

/** Repo-root-relative glob or scoped pattern entry from `repovine.config.json` → `build.scan`. */
export type ScanScope = 'all' | 'source' | 'infra';

export type ScanPatternInput =
  | string
  | {
      path: string;
      scope?: ScanScope;
    };

export interface CompiledScanPattern {
  regex: RegExp;
  scope: ScanScope;
}

export interface CompiledScanPatterns {
  include: CompiledScanPattern[];
  exclude: CompiledScanPattern[];
}

function normalizeRelPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '');
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
      return { regex: globToRegex(glob), scope };
    }),
    exclude: exclude.map(entry => {
      const { glob, scope } = parsePatternEntry(entry);
      return { regex: globToRegex(glob), scope };
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
    if (pattern.regex.test(norm)) return true;
  }
  return false;
}

function matchesEngineIgnore(relPath: string): boolean {
  const norm = normalizeRelPath(relPath);
  for (const fragment of REPOVINE_ENGINE_SCAN_IGNORE_PATTERNS) {
    const q = fragment.replace(/\\/g, '/').replace(/^\//, '').replace(/\/$/, '');
    if (!q) continue;
    if (norm === q) return true;
    if (norm.startsWith(`${q}/`)) return true;
    if (norm.includes(`/${q}/`) || norm.endsWith(`/${q}`)) return true;
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
