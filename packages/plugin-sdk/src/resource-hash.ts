import { canonicalJson } from './canonical-json.js';
import { HASH_WIDTH, sha256Hex } from './content-hash.js';

/**
 * Content hash of a single IaC resource payload, at the width the engine compares against.
 *
 * This is the one hash a PRODUCER mints rather than the engine, and it drives runtime-resource
 * freshness — so both the width ({@link HASH_WIDTH}) and the canonicalization ({@link canonicalJson})
 * are published contract rather than call-site detail: two parsers reading the same resource have to
 * produce the same bytes, and a manifest whose keys were reordered is the same resource.
 */
export function hashResourcePayload(payload: unknown): string {
  return sha256Hex(canonicalJson(payload), HASH_WIDTH.content);
}
