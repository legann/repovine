/**
 * Internal architecture-detector bootstrap.
 *
 * Holds the explicit list of built-in detectors and registers them on first
 * import (side-effect), mirroring `stage1/source/bootstrap.ts`. Each entry is a
 * thin adapter over the existing `detectX` body in ./detectors.ts — the bodies
 * are NOT modified. The adapters reproduce, one-for-one, the exact calls the
 * previous flat if-chain in `runRefactoringReport` made.
 *
 * INTERNAL_DETECTORS preserves the original if-chain order: `runRefactoringReport`
 * appends in registry order and `sortFindings` ties resolve by insertion order,
 * so the order is load-bearing for output parity.
 *
 * To add a detector: add its body to ./detectors.ts and a registry entry below.
 * Core dispatch (`runRefactoringReport`) does not change.
 *
 * Side-effect: also imports the source-plugin bootstrap so capability lookups
 * (`pluginHasUiSurfaces`) used by frontend-class `appliesTo` predicates see
 * a populated registry in isolated unit tests — same idiom as the
 * consumers (annotations/module-kind, stage2/index, mcp/lib/entrypoints).
 */


import { registerDetector } from './detector-registry.js';
import type { ArchitectureDetector, DetectorPack } from './detector-types.js';
import {
  detectAnnotationRisk,
  detectAnnotationSecretHygiene,
  detectAuthorizationPolicyDrift,
  detectBoundary,
  detectDomainShape,
  detectDuplicateLike,
  detectEventDrivenBoundary,
  detectFlowConvergence,
  detectDesignSystemLeakage,
  detectGodModule,
  detectRouteConvergence,
  detectSecretConfigBoundary,
  detectServiceWrapperExplosion,
  detectSourceDisclosureSurface,
  detectTrustBoundaryValidation,
  detectUiDomainCoupling,
  detectUnclearArchitecture,
} from './detectors.js';
// ui-surface detector pack: definitions are owned by analysis/architecture-detectors/ui-surface;
// registration stays here at the legacy positions (detector registry is global state read on graphs
// built without the composer).
import {
  clientBusinessLogicDetector,
  duplicatedClientPolicyDetector,
  effectSpaghettiDetector,
  privilegedClientSideEffectDetector,
  propDrillingOrchestrationDetector,
  sensitiveBrowserStorageDetector,
  serverClientBoundaryDetector,
  stateFragmentationDetector,
} from '../architecture-detectors/ui-surface/detectors.js';
import { serverHandlerOrchestrationDetector } from '../architecture-detectors/server-surface/detectors.js';
import { INTERNAL_DETECTOR_PACKS } from '../architecture-detectors/index.js';
import { uiSurfaceApplies } from './surfaces/ui.js';

const INTERNAL_DETECTORS: ArchitectureDetector[] = [
  {
    id: 'duplicate-like',
    categories: ['duplicate-like'],
    run: ctx => detectDuplicateLike(ctx.graph, ctx.modulesById, ctx.annotations, ctx.scope, {
      annotationReasoning: ctx.annotationReasoning,
      thresholds: ctx.thresholds.duplicateLike,
    }),
  },
  {
    id: 'boundary',
    categories: ['boundary'],
    run: ctx => detectBoundary(ctx.graph, ctx.modulesById, ctx.annotations, ctx.scope, {
      annotationReasoning: ctx.annotationReasoning,
    }),
  },
  {
    id: 'god-module',
    categories: ['god-module'],
    run: ctx => detectGodModule(ctx.graph, ctx.modulesById, ctx.annotations, ctx.scope, {
      annotationReasoning: ctx.annotationReasoning,
      thresholds: ctx.thresholds.godModule,
    }),
  },
  {
    // One detector → two categories. The final per-category filter in
    // runRefactoringReport drops whichever of the two was not requested.
    id: 'domain-shape',
    categories: ['god-domain', 'low-cohesion'],
    run: ctx => detectDomainShape(
      ctx.graph,
      ctx.modulesById,
      ctx.annotations,
      ctx.scope,
      {
        godDomain: ctx.requestedCategories.has('god-domain'),
        lowCohesion: ctx.requestedCategories.has('low-cohesion'),
      },
      {
        annotationReasoning: ctx.annotationReasoning,
        godDomainThresholds: ctx.thresholds.godDomain,
        lowCohesionThresholds: ctx.thresholds.lowCohesion,
      },
    ),
  },
  clientBusinessLogicDetector,
  {
    id: 'flow-convergence',
    categories: ['flow-convergence'],
    run: ctx => detectFlowConvergence(ctx.graph, ctx.modulesById, ctx.annotations, ctx.scope, {
      includeComponentEntrypoints: ctx.includeComponentEntrypoints,
      annotationReasoning: ctx.annotationReasoning,
      thresholds: ctx.thresholds.flowConvergence,
    }),
  },
  stateFragmentationDetector,
  effectSpaghettiDetector,
  propDrillingOrchestrationDetector,
  {
    id: 'service-wrapper-explosion',
    categories: ['service-wrapper-explosion'],
    run: ctx => detectServiceWrapperExplosion(ctx.graph, ctx.modulesById, ctx.scope, {
      thresholds: ctx.thresholds.serviceWrapperExplosion,
    }),
  },
  {
    id: 'ui-domain-coupling',
    categories: ['ui-domain-coupling'],
    run: ctx => detectUiDomainCoupling(ctx.graph, ctx.modulesById, ctx.scope, {
      thresholds: ctx.thresholds.uiDomainCoupling,
    }),
  },
  {
    id: 'route-convergence',
    categories: ['route-convergence'],
    run: ctx => detectRouteConvergence(ctx.graph, ctx.modulesById, ctx.scope, {
      thresholds: ctx.thresholds.routeConvergence,
    }),
  },
  duplicatedClientPolicyDetector,
  {
    id: 'design-system-leakage',
    categories: ['design-system-leakage'],
    run: ctx => detectDesignSystemLeakage(ctx.modulesById, ctx.scope),
  },
  {
    id: 'event-driven-boundary',
    categories: ['event-driven-boundary'],
    run: ctx => detectEventDrivenBoundary(ctx.graph, ctx.scope),
  },
  {
    id: 'secret-config-boundary',
    categories: ['secret-config-boundary'],
    run: ctx => detectSecretConfigBoundary(ctx.graph, ctx.modulesById, ctx.annotations, ctx.scope, {
      annotationReasoning: ctx.annotationReasoning,
      thresholds: ctx.thresholds.secretConfigBoundary,
    }),
  },
  {
    id: 'authorization-policy-drift',
    categories: ['authorization-policy-drift'],
    run: ctx => detectAuthorizationPolicyDrift(ctx.graph, ctx.modulesById, ctx.annotations, ctx.scope, {
      annotationReasoning: ctx.annotationReasoning,
      thresholds: ctx.thresholds.authorizationPolicyDrift,
    }),
  },
  {
    id: 'trust-boundary-validation',
    categories: ['trust-boundary-validation'],
    run: ctx => detectTrustBoundaryValidation(ctx.graph, ctx.modulesById, ctx.annotations, ctx.scope, {
      annotationReasoning: ctx.annotationReasoning,
      thresholds: ctx.thresholds.trustBoundaryValidation,
    }),
  },
  privilegedClientSideEffectDetector,
  sensitiveBrowserStorageDetector,
  serverClientBoundaryDetector,
  {
    id: 'source-disclosure-surface',
    categories: ['source-disclosure-surface'],
    run: ctx => detectSourceDisclosureSurface(ctx.graph, ctx.modulesById, ctx.annotations, ctx.scope, {
      annotationReasoning: ctx.annotationReasoning,
      thresholds: ctx.thresholds.sourceDisclosureSurface,
    }),
  },
  {
    id: 'annotation-secret-hygiene',
    categories: ['annotation-secret-hygiene'],
    run: ctx => detectAnnotationSecretHygiene(ctx.graph, ctx.modulesById, ctx.annotations, ctx.scope, {
      thresholds: ctx.thresholds.annotationSecretHygiene,
    }),
  },
  {
    id: 'annotation-risk',
    categories: ['annotation-risk'],
    run: ctx => detectAnnotationRisk(ctx.graph, ctx.modulesById, ctx.annotations, ctx.scope, {
      thresholds: ctx.thresholds.annotationRisk,
      derivedStaleSet: ctx.derivedStaleSet,
    }),
  },
  {
    id: 'unclear-architecture',
    categories: ['unclear-architecture'],
    run: ctx => detectUnclearArchitecture(ctx.graph, ctx.scope, {
      thresholds: ctx.thresholds.unclearArchitecture,
    }),
  },
  serverHandlerOrchestrationDetector,
];

let bootstrapped = false;

/** Register all built-in detectors. Idempotent — safe from multiple entry-points. */
export function bootstrapInternalDetectors(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  assertDetectorPacksRegistered();
  for (const detector of INTERNAL_DETECTORS) registerDetector(detector);
}

/**
 * Drift guard: every detector catalogued in a built-in `DetectorPack` must be wired into
 * INTERNAL_DETECTORS above (registration order is owned here, not by the pack). Throws if a pack
 * declares a detector that is not registered — catches a pack/registration mismatch at startup.
 *
 * Registration policy makes this the boundary between the two surfaces: the catalog
 * (`INTERNAL_DETECTOR_PACKS`) is identity/grouping, the ordered registration is owned here, and this
 * guard is the only thing tying them together. Parameters default to the real lists (the bootstrap
 * call below passes none) and exist purely so the throw path is unit-testable with an injected
 * mismatch — they do not change runtime behavior.
 */
export function assertDetectorPacksRegistered(
  detectors: readonly ArchitectureDetector[] = INTERNAL_DETECTORS,
  packs: readonly DetectorPack[] = INTERNAL_DETECTOR_PACKS,
): void {
  const registeredIds = new Set(detectors.map(d => d.id));
  for (const pack of packs) {
    for (const detector of pack.detectors) {
      if (!registeredIds.has(detector.id)) {
        throw new Error(
          `Detector pack "${pack.id}" declares detector "${detector.id}" that is not registered in INTERNAL_DETECTORS.`,
        );
      }
    }
  }
}

// Auto-invoke on first import — keeps the "side-effect import" pattern symmetric
// with the source/iac bootstraps.
bootstrapInternalDetectors();

// Exported only so the capability gate can be toggled/inspected in tests; the
// dispatcher never reads it directly.
export { uiSurfaceApplies };
