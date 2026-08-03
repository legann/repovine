import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { writeFileAtomicSync } from '../fs/atomic.js';

export const BUILD_CALIBRATION_FILENAME = 'build-calibration.json';
const CALIBRATION_SCHEMA_VERSION = 2;

export interface CalibrationLastRun {
  /** ISO timestamp of the run. */
  at: string;
  /** What the run observed. */
  observed: {
    cpuCount: number;
    totalRamMb: number;
    workerCount: number;
    shardTargetSize: number;
    /** Process RSS before extraction workers start. */
    baselineRssMb: number;
    /** Highest process RSS observed while extraction runs. */
    peakRssMb: number;
    /** Worker-attributable peak after subtracting the process baseline. */
    incrementalPeakRssMb: number;
    wallSec: number;
    totalModules: number;
    totalShards: number;
    reusedModules: number;
    rescannedModules: number;
    runKind: 'cold';
  };
}

export interface CalibrationFile {
  version: number;
  lastRun: CalibrationLastRun;
}

export interface CalibrationAdvice {
  /** Recommended worker count for the next run. */
  workerCount: number;
  /** Recommended shardTargetSize for the next run. */
  shardTargetSize: number;
  /** Per-worker RAM headroom in MB, derived from the previous run's footprint. */
  perWorkerRamMb: number;
  /** Free-form explanation written to the log so the user understands the choice. */
  rationale: string;
}

const positiveFinite = z.number().finite().positive();
const positiveInteger = positiveFinite.int();
const CalibrationFileSchema = z.object({
  version: z.literal(CALIBRATION_SCHEMA_VERSION),
  lastRun: z.object({
    at: z.string().min(1),
    observed: z.object({
      cpuCount: positiveInteger,
      totalRamMb: positiveFinite,
      workerCount: positiveInteger,
      shardTargetSize: positiveInteger,
      baselineRssMb: positiveFinite,
      peakRssMb: positiveFinite,
      incrementalPeakRssMb: positiveFinite,
      wallSec: positiveFinite,
      totalModules: positiveInteger,
      totalShards: positiveInteger,
      reusedModules: z.literal(0),
      rescannedModules: positiveInteger,
      runKind: z.literal('cold'),
    }),
  }),
});

function readCalibrationFile(filePath: string): CalibrationFile | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const parsed = CalibrationFileSchema.safeParse(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function loadCalibration(cacheDir: string): CalibrationFile | undefined {
  return readCalibrationFile(path.join(cacheDir, BUILD_CALIBRATION_FILENAME));
}

export function saveCalibration(cacheDir: string, lastRun: CalibrationLastRun): void {
  fs.mkdirSync(cacheDir, { recursive: true });
  const filePath = path.join(cacheDir, BUILD_CALIBRATION_FILENAME);
  const data: CalibrationFile = { version: CALIBRATION_SCHEMA_VERSION, lastRun };
  writeFileAtomicSync(filePath, JSON.stringify(CalibrationFileSchema.parse(data), null, 2));
}

/**
 * Only a cold, genuinely parallel extraction is representative of the next
 * cold build. Incremental runs keep the last cold calibration intact.
 */
export function isRepresentativeCalibrationRun(run: {
  workerCount: number;
  totalShards: number;
  reusedModules: number;
  rescannedModules: number;
}): boolean {
  return run.workerCount >= 2
    && run.totalShards >= 2
    && run.reusedModules === 0
    && run.rescannedModules > 0;
}

/**
 * Derive next-run worker count and shard size from the previous run's measured peak.
 * Honors explicit user overrides (when not undefined) and otherwise picks the highest
 * safe values for the current machine using the observed bytes-per-shard footprint.
 *
 * Strategy:
 *  - Worker-attributable peak RSS ≈ (peakRssMb - baselineRssMb) / workerCount.
 *  - Choose workerCount up to min(cpuCount - 1, observedSafeWorkers) where observedSafeWorkers
 *    fits 70% of total RAM at the observed per-worker peak.
 *  - shardTargetSize stays at the previously-observed value unless it produced very large
 *    per-worker peaks (>1.5x of available headroom), in which case shrink it.
 */
export function adviseFromCalibration(
  cal: CalibrationFile | undefined,
  override: { maxPackageWorkers?: number; shardTargetSize?: number },
  current: { cpuCount: number; totalRamMb: number; defaultShardSize: number },
): CalibrationAdvice | undefined {
  const parsed = CalibrationFileSchema.safeParse(cal);
  if (!parsed.success) return undefined;
  const last = parsed.data.lastRun.observed;

  const finitePositiveInt = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.max(1, Math.floor(value))
      : fallback;
  const currentCpuCount = finitePositiveInt(current.cpuCount, 1);
  const currentRamMb = finitePositiveInt(current.totalRamMb, 1);

  // Per-worker observed peak. Cap shards-per-worker at 1 if there were fewer shards than
  // workers (gives an overstated per-worker number but errs safe).
  const inflight = Math.min(last.workerCount, last.totalShards);
  const observedPerWorkerRamMb = inflight > 0
    ? Math.max(1, Math.ceil(last.incrementalPeakRssMb / inflight))
    : last.incrementalPeakRssMb;
  const availableRamMb = Math.max(1, Math.floor(currentRamMb * 0.7) - last.baselineRssMb);
  const ramCappedWorkers = Math.max(1, Math.floor(availableRamMb / Math.max(1, observedPerWorkerRamMb)));
  const cpuCap = Math.max(1, currentCpuCount - 1);
  const autoPick = Math.min(cpuCap, ramCappedWorkers);
  const hasWorkerOverride = typeof override.maxPackageWorkers === 'number'
    && Number.isFinite(override.maxPackageWorkers)
    && override.maxPackageWorkers > 0;
  const advisedWorkers = finitePositiveInt(override.maxPackageWorkers, autoPick);

  const priorShardSize = finitePositiveInt(last.shardTargetSize, finitePositiveInt(current.defaultShardSize, 1));
  const advisedShardSize = finitePositiveInt(override.shardTargetSize, priorShardSize);

  const head = `calibration: baseline ${last.baselineRssMb}MB + worker peak ${last.incrementalPeakRssMb}MB on ${last.workerCount}w → ~${observedPerWorkerRamMb}MB/w; worker budget ${availableRamMb}MB → ${ramCappedWorkers} RAM-safe / cpu cap ${cpuCap} → auto ${autoPick}w`;
  const tail = hasWorkerOverride && advisedWorkers !== autoPick
    ? `, but user override ${advisedWorkers}w wins`
    : '';
  const rationale = head + tail;
  return {
    workerCount: advisedWorkers,
    shardTargetSize: advisedShardSize,
    perWorkerRamMb: observedPerWorkerRamMb,
    rationale,
  };
}
