/**
 * Text vocabulary: making a value short enough to show, and splitting an identifier into words.
 *
 * Shortening answers one question — "this value is about to be shown and may be too long". The
 * budget is the whole result: {@link shortenText} returns at most `maxChars` characters counting
 * the marker, so a field declared at 200 never arrives at 201. One marker, {@link SHORTENED_MARKER},
 * so a client recognizes a shortened value by a single rule.
 *
 * Three neighbouring questions are deliberately not this one:
 *   - A read window, where the caller is told what was never looked at. `scanLinesWithRegex` bounds
 *     each line before the regex sees it and reports `truncatedLineCount`, which `inspect_node`
 *     turns into a `truncation.grepInput` block. The value is not being shown there; it is being
 *     searched, and the block is what makes "not found" distinguishable from "not searched".
 *   - An input budget, where the cut feeds a computation rather than a reader — the embedding card
 *     text, a captured stderr tail. Nobody reads the marker, and a marker would enter the digest.
 *   - Reporting the cut. `src/response/truncation.ts` owns the block that says a bound bit; this
 *     module owns the act. A response carries both once: the shortened value and, where the caller
 *     can page or widen, the block that says so.
 */

/**
 * The character budget and its marker, declared in the SDK beside the fact schemas, because plugins
 * shorten the facts they produce and both sides must cut the same way. Re-exported here so engine
 * callers read the whole text vocabulary from one module.
 */
export { SHORTENED_MARKER, shortenText } from '@repovine/plugin-sdk';

import { SHORTENED_MARKER as MARKER } from '@repovine/plugin-sdk';

/**
 * At most `maxWords` words, marker included.
 *
 * A second budget unit, named rather than folded into {@link shortenText}: a navigation `reason` is
 * a phrase, and cutting a phrase mid-word to hit a character count reads worse than dropping the
 * tail words. The marker is the same one, so the client's rule for "was this shortened" is unchanged
 * across both units. Runs of whitespace collapse, because the count is words rather than layout.
 */
export function shortenWords(value: string, maxWords: number): string {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return `${words.slice(0, maxWords).join(' ')}${MARKER}`;
}

/**
 * The first `maxItems` entries, and how many were left behind.
 *
 * Sized in items, not characters: a caller who shows five of forty risks bounded a list, and the
 * reader needs the count rather than the width. Pair the `omitted` count with {@link omittedNote}
 * for prose, or with a `truncation` block where the caller can page to the rest.
 */
export function shortenList<T>(items: readonly T[], maxItems: number): { shown: T[]; omitted: number } {
  const bound = Math.max(0, maxItems);
  return { shown: items.slice(0, bound), omitted: Math.max(0, items.length - bound) };
}

/**
 * The one way prose says a list was bounded: ` (+3 more)`, or nothing when nothing was dropped.
 *
 * Leading space included, so the caller appends it directly after the sample it bounded. Absence of
 * the note means the sample is the whole list — the same contract the `truncation` block carries in
 * structured fields.
 */
export function omittedNote(omitted: number): string {
  return omitted > 0 ? ` (+${omitted} more)` : '';
}

/**
 * Word boundaries inside an identifier, marked with spaces and nothing else removed.
 *
 * Two passes, because one is wrong on acronyms: `HTTPServerAdapter` needs a boundary both where a
 * lowercase meets an uppercase and where a run of uppercase meets a capitalized word, so it reads
 * `HTTP Server Adapter` rather than `HTTPServer Adapter`. The search index and the responsibility
 * key ask the same question of the same identifier and must not answer it differently: a module
 * reachable by searching for "http" is named after "http" in a finding too. Callers that want
 * another separator replace the spaces themselves — the split is the shared part, the joiner is not.
 */
export function splitCamelCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}
