/**
 * Detector registry contract.
 *
 * Replaces the flat if-chain in `runRefactoringReport` with metadata-carrying
 * registry entries, mirroring `stage1/source/registry.ts`. Adding a detector
 * becomes a registration (see ./detector-bootstrap.ts), not a core-dispatcher
 * edit. The detector bodies in ./detectors.ts are NOT touched — each entry is a
 * thin adapter that pulls the fields it needs out of `DetectorContext`.
 */

import type { RepositoryGraph, ModuleInfo, RepositoryFactsSnapshot } from '../../types.js';
import type { AnnotationStore } from '../../annotations/store.js';
import type { RefactoringThresholds } from './config.js';
import type { RefactoringCategory, RefactoringFinding, RefactoringScope } from './types.js';

/**
 * Everything a detector adapter might need, assembled once per report so the
 * registry loop can stay uniform. Individual adapters read only the slice the
 * underlying `detectX` requires; heterogeneous detector signatures are absorbed
 * here, not in the dispatcher.
 */
export interface DetectorContext {
  graph: RepositoryGraph;
  modulesById: Map<string, ModuleInfo>;
  annotations: AnnotationStore;
  scope: RefactoringScope;
  /**
   * Repository facts snapshot — only annotation-risk's derived-stale propagation needs
   * it, and that is precomputed into `derivedStaleSet`. Optional: detectors
   * gracefully degrade when missing.
   */
  snapshot?: RepositoryFactsSnapshot;
  thresholds: RefactoringThresholds;
  /** The categories the caller asked for — drives detectDomainShape's sub-flags. */
  requestedCategories: Set<RefactoringCategory>;
  annotationReasoning: boolean;
  includeComponentEntrypoints: boolean;
  /**
   * Derived-stale module ids, precomputed once per report from `snapshot` for
   * annotation-risk so all in-scope modules share a consistent view. Undefined
   * when annotation-risk was not requested or no snapshot was supplied.
   */
  derivedStaleSet?: ReadonlySet<string>;
}

/**
 * A registered detector: stable id, the categories it can emit (one-to-many —
 * detectDomainShape emits both `god-domain` and `low-cohesion`), an optional
 * detector-level applicability predicate, and a thin `run` adapter.
 */
export interface ArchitectureDetector {
  /** Stable id, e.g. 'boundary'. */
  id: string;
  /** Categories this detector can produce. The dispatcher runs the detector when
   *  any requested category intersects this set. */
  categories: RefactoringCategory[];
  /**
   * Detector-level applicability. Default (undefined): applies to the whole
   * scope. When set, the dispatcher skips the detector entirely if NO in-scope
   * module satisfies the predicate — safe only for detectors that already emit
   * nothing when no module matches (e.g. frontend-class detectors gated on
   * `isFrontendSurfaceModule`). Used for the capability gate:
   * `mod => pluginHasUiSurfaces(mod.sourcePluginId)`.
   */
  appliesTo?(mod: ModuleInfo): boolean;
  /** Thin adapter over the existing `detectX` body. */
  run(ctx: DetectorContext): RefactoringFinding[];
}

/**
 * A named group of architecture detectors that share a surface/concern. Detector packs are the
 * analysis-extension role split out of the old `LayerPlugin` (interpreters judge nothing; packs
 * judge the map). The built-in `ui-surface` pack lives under
 * `analysis/architecture-detectors/`. Registration order is still owned by
 * `detector-bootstrap.ts` (a pack's detectors are interleaved with non-pack detectors at exact
 * legacy positions), so a pack is an identity/grouping unit, not a registration loop.
 */
export interface DetectorPack {
  /** Stable pack id, e.g. 'ui-surface'. */
  id: string;
  /** The detectors this pack owns. */
  detectors: ArchitectureDetector[];
}
