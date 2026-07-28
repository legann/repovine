import { compareCodeUnits } from './ordering.js';

/**
 * Canonical JSON: the bytes two equal structures both produce.
 *
 * Used wherever a structure has to compare equal to itself across producers, hosts and runs — a
 * resource payload before it is hashed, an edge's metadata before it is deduplicated. Three
 * properties, and each is a decision:
 *   - object keys are sorted by code unit, recursively, so key order carries no meaning;
 *   - array order is preserved, because in a document it does;
 *   - a key whose value is `undefined` is dropped, which is what `JSON.stringify` does — an absent
 *     key and a key set to `undefined` are the same fact.
 *
 * Sorting is by code unit for the same reason discovery order is: a locale collation would make the
 * answer depend on `LANG` and on the host's ICU build.
 */
export function canonicalJson(value: unknown): string {
  // A value serializes itself first, the way `JSON.stringify` asks it to. YAML parsers hand back
  // `Date` for an unquoted timestamp, and an object walked field-by-field instead of asked would
  // fold to `{}` — two structures differing only by a date would then compare equal.
  if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return canonicalJson((value as { toJSON: () => unknown }).toJSON());
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    // A collection carries its entries where `Object.keys` cannot see them, so walking one field by
    // field answers `{}` for every instance — two different structures would compare equal, silently.
    // Refusing is the honest answer: the caller knows whether its entries are a list or an object.
    if (value instanceof Map || value instanceof Set || value instanceof WeakMap || value instanceof WeakSet) {
      throw new TypeError(
        `canonicalJson: ${value.constructor.name} carries no enumerable own keys, so canonicalizing it `
          + 'would give every instance the same bytes. Hand its entries as an array or a plain object.',
      );
    }
    const record = value as Record<string, unknown>;
    const fields: string[] = [];
    for (const key of Object.keys(record).sort(compareCodeUnits)) {
      const field = record[key];
      if (field === undefined) continue;
      fields.push(`${JSON.stringify(key)}:${canonicalJson(field)}`);
    }
    return `{${fields.join(',')}}`;
  }
  // `JSON.stringify(undefined)` answers with `undefined` rather than a string; inside an array that
  // position is `null`, which is where this branch is reached from.
  return JSON.stringify(value) ?? 'null';
}
