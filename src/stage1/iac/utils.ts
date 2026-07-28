/**
 * Content hash for a single IaC resource payload (not the whole template).
 *
 * Declared in the SDK, because this is the one hash a PRODUCER mints: a third-party parser that
 * composed its own digest would give the same resource a different identity than a built-in one,
 * and the value drives runtime-resource freshness. The canonicalization — sorted keys, preserved
 * array order, `undefined`-valued keys dropped — is part of that published contract.
 */
export { hashResourcePayload } from '@repovine/plugin-sdk';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function attrValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const values = value
      .map(v => attrValue(v))
      .filter((v): v is string => Boolean(v));
    return values.length > 0 ? values.join(',') : undefined;
  }
  return undefined;
}

export function addAttr(attrs: Record<string, string>, key: string, value: unknown): void {
  const normalized = attrValue(value);
  if (normalized) attrs[key] = normalized;
}

/** Extract path-based infra domains from relative path (e.g. k8s-services/some-service). */
export function pathBasedDomainsFromRelPath(relPath: string): string {
  const segments = relPath.replace(/\/Dockerfile.*$/, '').split(/[/\\]/).filter(Boolean);
  const skip = new Set(['infrastructure', 'infra', 'src', 'app']);
  const meaningful = segments.filter(s => !skip.has(s.toLowerCase()));
  return meaningful.length > 0 ? meaningful.join('/') : segments.join('/') || 'root';
}
