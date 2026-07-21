/**
 * ui-surface detector pack.
 *
 * Owns the definitions of the frontend/UI-class architecture detectors (the eight gated by
 * `uiSurfaceApplies`). The detector *bodies* stay in `analysis/architecture/detectors.ts` (untouched);
 * this module owns only the thin adapters + the `uiSurfaceDetectorPack` grouping.
 *
 * Registration deliberately stays in `analysis/architecture/detector-bootstrap.ts`, which imports these objects
 * and places them at their exact legacy positions in the global detector list. The detector registry is
 * global state consulted by the architecture report on graphs that may be built without the interpreter
 * composer (manual test graphs); routing registration through the composer would lose detectors on
 * those paths and is intentionally not done. Order is load-bearing — these adapters are interspersed
 * with non-UI detectors and sortFindings resolves ties by registration order, so a pack is an
 * identity/grouping unit, not a registration loop.
 */
import type { ArchitectureDetector, DetectorPack } from '../../architecture/detector-types.js';
import {
  detectClientBusinessLogic,
  detectDuplicatedClientPolicy,
  detectEffectSpaghetti,
  detectPropDrillingOrchestration,
  detectPrivilegedClientSideEffect,
  detectSensitiveBrowserStorage,
  detectServerClientBoundary,
  detectStateFragmentation,
} from '../../architecture/detectors.js';
import { uiSurfaceApplies } from '../../architecture/surfaces/ui.js';

export const clientBusinessLogicDetector: ArchitectureDetector = {
  id: 'client-business-logic',
  categories: ['client-business-logic'],
  appliesTo: uiSurfaceApplies,
  run: ctx => detectClientBusinessLogic(ctx.graph, ctx.modulesById, ctx.annotations, ctx.scope, {
    annotationReasoning: ctx.annotationReasoning,
  }),
};

export const stateFragmentationDetector: ArchitectureDetector = {
  id: 'state-fragmentation',
  categories: ['state-fragmentation'],
  appliesTo: uiSurfaceApplies,
  run: ctx => detectStateFragmentation(ctx.graph, ctx.modulesById, ctx.annotations, ctx.scope, {
    annotationReasoning: ctx.annotationReasoning,
  }),
};

export const effectSpaghettiDetector: ArchitectureDetector = {
  id: 'effect-spaghetti',
  categories: ['effect-spaghetti'],
  appliesTo: uiSurfaceApplies,
  run: ctx => detectEffectSpaghetti(ctx.modulesById, ctx.scope, {
    thresholds: ctx.thresholds.effectSpaghetti,
  }),
};

export const propDrillingOrchestrationDetector: ArchitectureDetector = {
  id: 'prop-drilling-orchestration',
  categories: ['prop-drilling-orchestration'],
  appliesTo: uiSurfaceApplies,
  run: ctx => detectPropDrillingOrchestration(ctx.graph, ctx.modulesById, ctx.annotations, ctx.scope, {
    annotationReasoning: ctx.annotationReasoning,
    thresholds: ctx.thresholds.propDrillingOrchestration,
  }),
};

export const duplicatedClientPolicyDetector: ArchitectureDetector = {
  id: 'duplicated-client-policy',
  categories: ['duplicated-client-policy'],
  appliesTo: uiSurfaceApplies,
  run: ctx => detectDuplicatedClientPolicy(ctx.graph, ctx.modulesById, ctx.annotations, ctx.scope, {
    annotationReasoning: ctx.annotationReasoning,
  }),
};

export const privilegedClientSideEffectDetector: ArchitectureDetector = {
  id: 'privileged-client-side-effect',
  categories: ['privileged-client-side-effect'],
  appliesTo: uiSurfaceApplies,
  run: ctx => detectPrivilegedClientSideEffect(ctx.graph, ctx.modulesById, ctx.annotations, ctx.scope, {
    annotationReasoning: ctx.annotationReasoning,
    thresholds: ctx.thresholds.privilegedClientSideEffect,
  }),
};

export const sensitiveBrowserStorageDetector: ArchitectureDetector = {
  id: 'sensitive-browser-storage',
  categories: ['sensitive-browser-storage'],
  appliesTo: uiSurfaceApplies,
  run: ctx => detectSensitiveBrowserStorage(ctx.graph, ctx.modulesById, ctx.annotations, ctx.scope, {
    annotationReasoning: ctx.annotationReasoning,
    thresholds: ctx.thresholds.sensitiveBrowserStorage,
  }),
};

export const serverClientBoundaryDetector: ArchitectureDetector = {
  id: 'server-client-boundary',
  categories: ['server-client-boundary'],
  appliesTo: uiSurfaceApplies,
  run: ctx => detectServerClientBoundary(ctx.graph, ctx.modulesById, ctx.annotations, ctx.scope, {
    annotationReasoning: ctx.annotationReasoning,
    thresholds: ctx.thresholds.serverClientBoundary,
  }),
};

/**
 * The ui-surface pack groups the eight frontend detectors. Identity/grouping only — registration
 * order is owned by detector-bootstrap.ts (these detectors are interleaved with non-UI detectors).
 */
export const uiSurfaceDetectorPack: DetectorPack = {
  id: 'ui-surface',
  detectors: [
    clientBusinessLogicDetector,
    stateFragmentationDetector,
    effectSpaghettiDetector,
    propDrillingOrchestrationDetector,
    duplicatedClientPolicyDetector,
    privilegedClientSideEffectDetector,
    sensitiveBrowserStorageDetector,
    serverClientBoundaryDetector,
  ],
};
