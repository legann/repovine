/**
 * `build.scan` vocabulary for engine callers.
 *
 * The glob dialect and the include/exclude verdict live in the SDK, beside the `discover()` contract
 * that hands compiled patterns to a producer: the engine and the plugin reading the files have to
 * call the same file in scope. The discovery prune predicate ships there for the same reason.
 * Re-exported here because engine callers read the whole scan vocabulary — user patterns and engine
 * ignores — from this module.
 */
export {
  compileScanPatterns,
  shouldScanInfraPath,
  shouldScanSourcePath,
  shouldWalkDiscoveryDir,
} from '@repovine/plugin-sdk';

// The two halves behind the verdict. They are host machinery rather than authoring surface — a
// producer is handed the compiled patterns and asks for the verdict — so they arrive by the subpath
// that carries no compatibility promise.
export { isScanExcluded, isScanIncluded } from '@repovine/plugin-sdk/internal';

export type {
  CompiledScanPattern,
  CompiledScanPatterns,
  ScanPatternInput,
  ScanScope,
} from '@repovine/plugin-sdk';
