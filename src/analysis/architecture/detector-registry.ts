/**
 * Mutable registry of architecture detectors. Built-in detectors register at
 * bootstrap (see ./detector-bootstrap.ts). Mirror of `stage1/source/registry.ts`.
 *
 * Registration order is load-bearing for output parity: `runRefactoringReport`
 * appends findings in registry order, and `sortFindings` is a partial order
 * (stable sort preserves insertion order on ties). The bootstrap list therefore
 * keeps the exact order of the original if-chain.
 */

import type { ModuleInfo } from '../../types.js';
import type { RefactoringCategory } from './types.js';
import type { ArchitectureDetector, DetectorContext } from './detector-types.js';

const detectors: ArchitectureDetector[] = [];

export function registerDetector(detector: ArchitectureDetector): void {
  detectors.push(detector);
}

export function getDetectors(): readonly ArchitectureDetector[] {
  return detectors;
}

/** Test-only: replace all registered detectors. Returns a restore callback. */
export function setDetectorsForTest(next: ArchitectureDetector[]): () => void {
  const prev = detectors.splice(0, detectors.length, ...next);
  return () => {
    detectors.splice(0, detectors.length, ...prev);
  };
}

/** True when none of the detector's categories were requested → skip the detector. */
export function categoriesDisjoint(
  detectorCategories: RefactoringCategory[],
  requested: Set<RefactoringCategory>,
): boolean {
  return !detectorCategories.some(category => requested.has(category));
}

/**
 * True when at least one in-scope module satisfies `appliesTo`. Used for the
 * whole-detector skip: if NO scoped module matches, the detector is skipped
 * entirely (safe for detectors that emit nothing when no module matches).
 *
 * Results are memoised by predicate identity within one report — built-in
 * frontend detectors share a single predicate reference, so the module scan
 * runs at most once per distinct predicate.
 */
export function anyInScopeApplies(
  ctx: DetectorContext,
  appliesTo: (mod: ModuleInfo) => boolean,
  cache?: Map<(mod: ModuleInfo) => boolean, boolean>,
): boolean {
  const cached = cache?.get(appliesTo);
  if (cached !== undefined) return cached;
  let result = false;
  for (const moduleId of ctx.scope.moduleIds) {
    const mod = ctx.modulesById.get(moduleId);
    if (mod && appliesTo(mod)) {
      result = true;
      break;
    }
  }
  cache?.set(appliesTo, result);
  return result;
}
