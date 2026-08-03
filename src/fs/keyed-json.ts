/**
 * One-line-per-entry serializer for `.repovine/` cache files whose bulk is a single keyed map.
 * Scalar header fields (e.g. `version`, `builtAt`) stay on their own indented lines; each map entry
 * is one line — `    "key": <compact-json>` — mirroring the annotations file layout
 * ({@link ../annotations/format.ts serializeAnnotationFileFromRaw}). Keys are sorted, so the same
 * input yields byte-identical output and a changed entry is a one-line diff, not a moved block.
 *
 * `header` fields serialize in insertion order before the map. `entries` values keep their own key
 * order (the caller owns intra-entry ordering); a value that stringifies to `undefined` is written
 * as `null`. Output ends with a trailing newline.
 */
export function serializeKeyedRecordFile(
  header: Record<string, string | number | boolean>,
  mapKey: string,
  entries: Record<string, unknown>,
): string {
  const lines = ['{'];
  for (const [key, value] of Object.entries(header)) {
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  }

  const ids = Object.keys(entries).sort();
  if (ids.length === 0) {
    lines.push(`  ${JSON.stringify(mapKey)}: {}`);
  } else {
    lines.push(`  ${JSON.stringify(mapKey)}: {`);
    ids.forEach((id, index) => {
      const serialized = JSON.stringify(entries[id]);
      const value = serialized === undefined ? 'null' : serialized;
      const comma = index === ids.length - 1 ? '' : ',';
      lines.push(`    ${JSON.stringify(id)}: ${value}${comma}`);
    });
    lines.push('  }');
  }

  lines.push('}', '');
  return lines.join('\n');
}
