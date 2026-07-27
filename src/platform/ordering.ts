/**
 * Host-independent string ordering.
 *
 * `String.prototype.localeCompare` collates by locale and by the ICU data the runtime was built
 * with: `'ä'.localeCompare('z')` is -1 under a German or ICU-default collation and +1 under
 * C/POSIX or a Node built with small-icu. Ordering that reaches the graph — file discovery order,
 * package order, node payload lists, persisted artifacts — is a property of the bytes here, so the
 * same repository projects identically regardless of `LANG`/`LC_ALL` and of the host's ICU build.
 *
 * This is the same comparison `Array.prototype.sort` applies to strings with no comparator; the
 * named form exists so a sort that needs a key extractor or a tie-break chain does not reach for
 * `localeCompare` to get one.
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
