import { createHash } from 'node:crypto';

/**
 * How wide a truncated sha256 is, per contract.
 *
 * The width IS the fact. A 16-char content hash and a 24-char extraction-config fingerprint are
 * compared against different stored values and mean different things, so each width carries a name
 * and a purpose here. The union type below admits only these three, which turns "pick a number"
 * into "pick a contract".
 */
export const HASH_WIDTH = {
  /** Identity of a node's or resource's content. Travels in the snapshot and in `repovine.annots.json`. */
  content: 16,
  /** Identity of the extraction config, for the snapshot-reuse gate. */
  config: 24,
  /** The untruncated digest. */
  full: 64,
} as const;

export type HashWidth = (typeof HASH_WIDTH)[keyof typeof HASH_WIDTH];

/**
 * sha256 over one already-canonicalized UTF-8 string, kept to `width` hex characters.
 *
 * Canonicalizing the input — `JSON.stringify`, sorting, joining, framing — stays at the call site,
 * because that is what separates one hash fact from another. The exception is the one hash a
 * producer mints rather than the engine: `hashResourcePayload` in `resource-hash.ts` owns the IaC
 * resource form, because two parsers reading the same resource have to agree. Callers that answer
 * "no content" with a sentinel (`''`, `'empty'`, `'dev:no-dist'`) keep the sentinel at the call site
 * too; this returns a digest and nothing else.
 *
 * It ships in the SDK so a plugin minting `InfraResource.contentHash` produces the bytes the engine
 * compares against, instead of re-deriving the recipe and the width from a sample.
 */
export function sha256Hex(text: string, width: HashWidth): string {
  return createHash('sha256').update(text).digest('hex').slice(0, width);
}
