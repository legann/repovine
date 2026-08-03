/**
 * Folding an arbitrary document value into the shape `InfraResource.attributes` accepts.
 *
 * `attributes` is a flat `Record<string, string>`: the host stores and shows the pairs and never
 * interprets them. A parser reads YAML, JSON or HCL, where a value is a scalar, a list or a nested
 * map, so every parser faces the same narrowing. The rules are published here so two parsers give
 * one document value the same spelling.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Scalar spelling of a document value: scalars stringify, lists join with `,`, maps drop. */
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

/** Set `key` when the value has a scalar spelling. An empty spelling leaves the key absent. */
export function addAttr(attrs: Record<string, string>, key: string, value: unknown): void {
  const normalized = attrValue(value);
  if (normalized) attrs[key] = normalized;
}

/** Path segments that group files without naming what they hold. */
const CONTAINER_PATH_SEGMENTS = new Set(['infrastructure', 'infra', 'src', 'app']);

/**
 * Grouping label for a repo-relative path, with container segments dropped.
 *
 * The caller decides what part of the path it wants labelled — a parser that groups by directory
 * strips the file name first. Every segment is kept when dropping the container segments would
 * leave nothing, so the label is never empty.
 */
export function pathGroupingLabel(relPath: string): string {
  const segments = relPath.split(/[/\\]/).filter(Boolean);
  const meaningful = segments.filter(segment => !CONTAINER_PATH_SEGMENTS.has(segment.toLowerCase()));
  return meaningful.length > 0 ? meaningful.join('/') : segments.join('/') || 'root';
}
