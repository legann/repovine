/**
 * The alphabet a domain label is written in, and the only way to write one.
 *
 * A domain label becomes half of a node id (`domain:<label>`, `domain:<parent>/<sub>`), a key in
 * `repovine.domains.json`, and a scope argument callers type by hand. Those three meet only if one
 * function decides what a label looks like, so every mint routes through here — path segments,
 * basenames, package names, configured names, and the sub-labels of a subdomain.
 */

/**
 * A domain label from any human-written string: lowercase, ASCII letters and digits, `-` between.
 *
 * The empty string is a refusal, and the callers read it as one: a segment made only of characters
 * the alphabet does not admit (`___`, `--`, `@@`) names no domain, so it contributes none. Passing
 * the raw segment through instead would mint a label the same function rejects when asked again —
 * and the whole point of a single alphabet is that asking twice gives one answer.
 *
 * Non-ASCII letters are dropped, not transliterated: `ünï` becomes `n`. The alphabet is what node
 * ids are compared in, and a transliteration table is a per-language fact the engine does not hold.
 */
export function domainSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * A whole domain label, including the `parent/sub` form a subdomain carries.
 *
 * `/` separates label segments and is the one character outside {@link domainSlug}'s alphabet that
 * survives; each segment is slugged on its own. A segment that slugs to nothing is dropped, so a
 * label whose every segment is unwritable answers `''` — the same refusal a single segment gives.
 */
export function domainLabelSlug(label: string): string {
  return label
    .split('/')
    .map(domainSlug)
    .filter(Boolean)
    .join('/');
}
