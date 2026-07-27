/**
 * Shortening a value that is about to be shown, and the marker that says it continues.
 *
 * Published by the SDK because plugins produce facts that carry it: an exported type's text, a
 * conditional's source, a resource description. A plugin that cut its own facts at its own width
 * with its own marker would put two shapes of "this continues" in one graph, and a client reading
 * the graph would need a rule per producer. One recipe, one marker, both sides of the seam.
 *
 * The budget is the whole result: {@link shortenText} returns at most `maxChars` characters counting
 * the marker, so a field declared at 200 never arrives at 201.
 */

/** The one marker that says "this value continues". A client recognizing it needs no second rule. */
export const SHORTENED_MARKER = '…';

/**
 * At most `maxChars` characters, marker included.
 *
 * The budget covering the marker is what makes it a budget: a caller sizing a response by the sum
 * of its declared field widths is right. A `maxChars` below the marker's own width answers with the
 * leading characters and no marker, because a value that is all marker says nothing about the value.
 */
export function shortenText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const room = maxChars - SHORTENED_MARKER.length;
  return room > 0 ? `${value.slice(0, room)}${SHORTENED_MARKER}` : value.slice(0, Math.max(0, maxChars));
}
