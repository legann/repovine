/**
 * `@repovine/plugin-sdk/internal` — host machinery, published because the engine and the SDK are two
 * packages and one of them has to reach the other. It is **not** part of the plugin contract.
 *
 * Everything here is outside semver: a name may change shape or disappear in any release, including
 * a patch, and that is not a breaking change to API 1. Nothing in this barrel appears in the written
 * contract registry (`docs/plugin-api-contract.json`), and no plugin — built-in, example, canary or
 * third party — may import it; the boundary laws refuse the specifier by name.
 *
 * Why a subpath rather than a duplicate implementation: the layout table, the scan verdict, the
 * declaration stamp and the canonical byte forms are each single-valued. A second copy in the engine
 * would be a second answer to a question that must have one, and the per-run `DirLayoutTable` is
 * module state — two copies would disagree about what discovery prunes.
 *
 * An author reaching for something here is a signal the contract has a gap. The gap is closed on the
 * contract side, under a name chosen for authors, not by widening this door.
 */

/* ---- per-run directory layout: engine installs the table, discovery reads it ---- */
export {
  BASE_DIR_LAYOUT,
  currentDirLayoutTable,
  installDirLayoutTable,
} from '../source-plugin/dir-layout.js';

/* ---- the include/exclude halves behind the scan verdict the engine composes ---- */
export { isScanExcluded, isScanIncluded } from '../source-plugin/scan-filters.js';

/* ---- declaration stamping and the composite keys the per-run catalog is keyed by ---- */
export {
  resourceKindMetaKey,
  stampDeclarationCatalog,
  triggerTypeMetaKey,
} from '../plugin/declarations.js';

/* ---- canonical bytes and the digest over them, shared so both sides hash alike ---- */
export { canonicalJson } from '../canonical-json.js';
export { sha256Hex } from '../content-hash.js';
