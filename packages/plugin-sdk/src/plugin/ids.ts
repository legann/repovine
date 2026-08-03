/**
 * Identifier and path spelling rules shared by the plugin manifest, the runtime descriptor and the
 * projection contract.
 *
 * Every id in this contract ends up inside a composite key: provenance is
 * `(pluginId, contributorId, batchId)`, an extension is `(pluginId, schema, localKey)` and a
 * resource metadata entry is `(namespace, provider, kind)`. A `:` or a `/` inside one component
 * would let a plugin spell a key that belongs to another owner, so the charset excludes both.
 * Opaque values a plugin invents freely — a resource `localKey`, an extension `localKey` — are NOT
 * subject to this rule: they go through the identity encoder instead.
 */

/** Longest accepted id. Long enough for `docker-compose`, short enough to keep diagnostics readable. */
export const PLUGIN_ID_MAX_LENGTH = 64;

/**
 * Accepted spelling for a plugin id, contributor id, batch id, schema id, axis name, namespace and
 * provider: starts alphanumeric, then alphanumerics, `.`, `_` and `-`. No `:`, no `/`, no
 * whitespace, no empty string.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when `value` is a well-formed contract id. */
export function isPluginContractId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= PLUGIN_ID_MAX_LENGTH
    && ID_PATTERN.test(value);
}

/** Why `value` is not a usable contract id, or undefined when it is one. */
export function pluginContractIdProblem(value: unknown, field: string): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return `${field} must be a non-empty string`;
  if (value.length > PLUGIN_ID_MAX_LENGTH) return `${field} exceeds ${PLUGIN_ID_MAX_LENGTH} characters`;
  if (!ID_PATTERN.test(value)) {
    return `${field} must match [A-Za-z0-9][A-Za-z0-9._-]* (no ":", "/" or whitespace)`;
  }
  return undefined;
}

/**
 * A versioned namespaced fact/extension schema id: `<owner>/<name>@<version>`, e.g.
 * `sam/policy-template@1`. Owner and name follow the id charset; version is a positive integer.
 * The engine compares this string, it never parses meaning out of it.
 */
const SCHEMA_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*@[1-9][0-9]*$/;

export function isPluginSchemaId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 160 && SCHEMA_PATTERN.test(value);
}

export function pluginSchemaIdProblem(value: unknown, field: string): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return `${field} must be a non-empty string`;
  if (value.length > 160) return `${field} exceeds 160 characters`;
  if (!SCHEMA_PATTERN.test(value)) return `${field} must be spelled "<owner>/<name>@<version>", e.g. "sam/policy-template@1"`;
  return undefined;
}

/** The owner segment of a schema id — the plugin the loader requires to match. */
export function schemaIdOwner(schema: string): string {
  return schema.slice(0, schema.indexOf('/'));
}

/* --------------------------------- entry path --------------------------------- */

/**
 * A manifest `entry` is a package-root-relative POSIX path: `/`-separated, no drive letter, no
 * leading separator, no `.`/`..` segment. The spelling is fixed here so the same manifest resolves
 * identically on every platform; the host separately checks that the resolved absolute path stays
 * inside the package directory.
 */
export interface EntryPathParse {
  ok: true;
  /** Path segments in order, ready for the host to join against the package directory. */
  segments: string[];
}

export type EntryPathResult = EntryPathParse | { ok: false; error: string };

export function parseEntryPath(value: unknown): EntryPathResult {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: 'entry must be a non-empty string' };
  }
  if (value.includes('\\')) {
    return { ok: false, error: 'entry is a POSIX path: use "/" as the separator, never "\\"' };
  }
  if (value.startsWith('/')) {
    return { ok: false, error: 'entry is package-root-relative: it must not start with "/"' };
  }
  if (/^[A-Za-z]:/.test(value)) {
    return { ok: false, error: 'entry is package-root-relative: a drive letter is not allowed' };
  }
  if (value.includes('\0')) {
    return { ok: false, error: 'entry must not contain a NUL byte' };
  }
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment === '') return { ok: false, error: 'entry must not contain an empty path segment' };
    if (segment === '.' || segment === '..') {
      return { ok: false, error: `entry must not contain a "${segment}" segment` };
    }
  }
  return { ok: true, segments };
}
