/**
 * server-surface detector pack.
 *
 * Owns server/handler-class detector adapters. Detector bodies stay in
 * `analysis/architecture/detectors.ts`; this module owns the DetectorPack grouping.
 * Registration order remains in `analysis/architecture/detector-bootstrap.ts`.
 */
import type { ArchitectureDetector, DetectorPack } from '../../architecture/detector-types.js';
import { detectServerHandlerOrchestration } from '../../architecture/detectors.js';
import { serverSurfaceApplies } from '../../architecture/surfaces/server.js';

export { serverSurfaceApplies };

export const serverHandlerOrchestrationDetector: ArchitectureDetector = {
  id: 'server-handler-orchestration',
  categories: ['god-module'],
  appliesTo: serverSurfaceApplies,
  run: ctx => detectServerHandlerOrchestration(ctx.graph, ctx.modulesById, ctx.annotations, ctx.scope, {
    annotationReasoning: ctx.annotationReasoning,
    thresholds: ctx.thresholds.godModule,
  }),
};

export const serverSurfaceDetectorPack: DetectorPack = {
  id: 'server-surface',
  detectors: [
    serverHandlerOrchestrationDetector,
  ],
};
