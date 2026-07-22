/**
 * EOL helpers for managed-file compare/write. Templates stay LF constants;
 * user checkouts may be CRLF (core.autocrlf), so compares normalize to LF and
 * writes restore the file's dominant EOL.
 */

export type Eol = '\n' | '\r\n';

/** Dominant EOL of `content`. Mixed files keep their majority; no newlines → '\n'. */
export function detectEol(content: string): Eol {
  const crlf = content.match(/\r\n/g)?.length ?? 0;
  const lfTotal = content.match(/\n/g)?.length ?? 0;
  return crlf > lfTotal - crlf ? '\r\n' : '\n';
}

/**
 * True when every newline shares one form (all CRLF or all lone LF), or there
 * are none. Mixed-EOL files fail this check; normalize/apply round-trips are
 * lossy for them, so callers fall back to byte-exact handling.
 */
export function isUniformEol(content: string): boolean {
  const crlf = content.match(/\r\n/g)?.length ?? 0;
  const lfTotal = content.match(/\n/g)?.length ?? 0;
  return crlf === 0 || crlf === lfTotal;
}

/** Convert all CRLF to LF. */
export function normalizeEol(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

/** Rewrite `content` with `eol`. Normalizes first, so it never double-converts. */
export function applyEol(content: string, eol: Eol): string {
  const normalized = normalizeEol(content);
  return eol === '\n' ? normalized : normalized.replace(/\n/g, '\r\n');
}
