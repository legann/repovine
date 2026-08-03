import type { DetectorPack } from '../architecture/detector-types.js';
import { serverSurfaceDetectorPack } from './server-surface/detectors.js';
import { uiSurfaceDetectorPack } from './ui-surface/detectors.js';

/**
 * Catalog of built-in architecture detector packs (symmetric with `INTERNAL_INTERPRETERS`). Packs
 * are identity/grouping units; the actual registration order lives in
 * `analysis/architecture/detector-bootstrap.ts`, which interleaves pack detectors with non-pack detectors at
 * their legacy positions. detector-bootstrap consults this catalog to assert that every pack
 * detector is registered (drift guard).
 */
export const INTERNAL_DETECTOR_PACKS: DetectorPack[] = [uiSurfaceDetectorPack, serverSurfaceDetectorPack];
