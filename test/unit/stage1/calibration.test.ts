import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  adviseFromCalibration,
  BUILD_CALIBRATION_FILENAME,
  loadCalibration,
  saveCalibration,
  type CalibrationFile,
  type CalibrationLastRun,
} from '../../../src/stage1/calibration.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-calib-'));
}

function sampleRun(overrides: Partial<CalibrationLastRun['observed']> = {}): CalibrationLastRun {
  return {
    at: '2026-05-29T00:00:00.000Z',
    observed: {
      cpuCount: 16,
      totalRamMb: 32000,
      workerCount: 8,
      shardTargetSize: 800,
      peakRssMb: 18800,
      wallSec: 1100,
      totalModules: 67000,
      totalShards: 1395,
      ...overrides,
    },
  };
}

describe('calibration save/load roundtrip', () => {
  it('returns undefined when the file does not exist', () => {
    expect(loadCalibration(tempDir())).toBeUndefined();
  });

  it('round-trips a representative run', () => {
    const dir = tempDir();
    const run = sampleRun();
    saveCalibration(dir, run);
    const loaded = loadCalibration(dir);
    expect(loaded?.version).toBe(1);
    expect(loaded?.lastRun).toEqual(run);
  });

  it('creates the cache directory on save if it does not exist', () => {
    const base = tempDir();
    const dir = path.join(base, 'nested', '.cache');
    expect(fs.existsSync(dir)).toBe(false);
    saveCalibration(dir, sampleRun());
    expect(fs.existsSync(path.join(dir, BUILD_CALIBRATION_FILENAME))).toBe(true);
  });

  it('rejects an unknown schema version', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, BUILD_CALIBRATION_FILENAME), JSON.stringify({ version: 99, lastRun: sampleRun() }));
    expect(loadCalibration(dir)).toBeUndefined();
  });

  it('rejects a malformed payload (missing lastRun.observed)', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, BUILD_CALIBRATION_FILENAME), JSON.stringify({ version: 1, lastRun: {} }));
    expect(loadCalibration(dir)).toBeUndefined();
  });

  it('rejects non-numeric and non-positive observed fields', () => {
    const dir = tempDir();
    const invalid = {
      version: 1,
      lastRun: sampleRun({ workerCount: 'many' as unknown as number, shardTargetSize: 0 }),
    };
    fs.writeFileSync(path.join(dir, BUILD_CALIBRATION_FILENAME), JSON.stringify(invalid));
    expect(loadCalibration(dir)).toBeUndefined();
  });

  it('writes atomically without leaving a temporary file', () => {
    const dir = tempDir();
    saveCalibration(dir, sampleRun());
    expect(fs.readdirSync(dir).filter(name => name.includes('.tmp.'))).toEqual([]);
  });

  it('rejects unparseable JSON', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, BUILD_CALIBRATION_FILENAME), 'not-json');
    expect(loadCalibration(dir)).toBeUndefined();
  });
});

describe('adviseFromCalibration math', () => {
  const current = { cpuCount: 16, totalRamMb: 32000, defaultShardSize: 800 };

  it('returns undefined when no calibration is present', () => {
    expect(adviseFromCalibration(undefined, {}, current)).toBeUndefined();
  });

  it('rejects a programmatic calibration containing NaN', () => {
    const cal: CalibrationFile = { version: 1, lastRun: sampleRun({ workerCount: Number.NaN }) };
    expect(adviseFromCalibration(cal, {}, current)).toBeUndefined();
  });

  it('floors finite positive overrides before they reach the worker pool', () => {
    const cal: CalibrationFile = { version: 1, lastRun: sampleRun() };
    expect(adviseFromCalibration(cal, { maxPackageWorkers: 3.9, shardTargetSize: 400.8 }, current))
      .toMatchObject({ workerCount: 3, shardTargetSize: 400 });
  });

  it('caps by RAM when per-worker footprint is heavy (large-monorepo-style)', () => {
    // 18800 / 8 ≈ 2350 MB/w → budget 32000*0.7 = 22400 → ramCap = 9 → min(15, 9) = 9
    const cal: CalibrationFile = { version: 1, lastRun: sampleRun({ peakRssMb: 18800, workerCount: 8 }) };
    const advice = adviseFromCalibration(cal, {}, current);
    expect(advice?.workerCount).toBe(9);
    expect(advice?.perWorkerRamMb).toBe(2350);
    expect(advice?.rationale).toContain('9 RAM-safe');
  });

  it('caps by CPU when per-worker footprint is light (large-monorepo-style)', () => {
    // 3000 / 4 = 750 MB/w → ramCap = 29 → min(15, 29) = 15
    const cal: CalibrationFile = { version: 1, lastRun: sampleRun({ peakRssMb: 3000, workerCount: 4, totalShards: 12 }) };
    const advice = adviseFromCalibration(cal, {}, current);
    expect(advice?.workerCount).toBe(15); // cpuCount - 1
    expect(advice?.rationale).toContain('cpu cap 15');
  });

  it('user override on maxPackageWorkers wins over calibration auto-pick', () => {
    const cal: CalibrationFile = { version: 1, lastRun: sampleRun() };
    const advice = adviseFromCalibration(cal, { maxPackageWorkers: 3 }, current);
    expect(advice?.workerCount).toBe(3);
    expect(advice?.rationale).toContain('user override 3w wins');
  });

  it('user override on shardTargetSize wins over previous shard size', () => {
    const cal: CalibrationFile = { version: 1, lastRun: sampleRun({ shardTargetSize: 800 }) };
    const advice = adviseFromCalibration(cal, { shardTargetSize: 400 }, current);
    expect(advice?.shardTargetSize).toBe(400);
  });

  it('falls back to last-run shard size when no shard override provided', () => {
    const cal: CalibrationFile = { version: 1, lastRun: sampleRun({ shardTargetSize: 1200 }) };
    const advice = adviseFromCalibration(cal, {}, current);
    expect(advice?.shardTargetSize).toBe(1200);
  });

  it('uses min(workerCount, totalShards) when shards < workers (avoid inflating per-worker estimate)', () => {
    // 4 workers, only 3 shards → inflight = 3, perWorkerRamMb = 3000/3 = 1000
    const cal: CalibrationFile = { version: 1, lastRun: sampleRun({ workerCount: 4, totalShards: 3, peakRssMb: 3000 }) };
    const advice = adviseFromCalibration(cal, {}, current);
    expect(advice?.perWorkerRamMb).toBe(1000);
  });

  it('never advises fewer than 1 worker', () => {
    // Pathological: peak way over budget → ramCap = 0 → clamped to 1
    const cal: CalibrationFile = { version: 1, lastRun: sampleRun({ peakRssMb: 999999, workerCount: 1, totalShards: 1 }) };
    const advice = adviseFromCalibration(cal, {}, { cpuCount: 16, totalRamMb: 1000, defaultShardSize: 800 });
    expect(advice?.workerCount).toBeGreaterThanOrEqual(1);
  });

  it('reports auto-pick distinct from override in rationale only when they differ', () => {
    const cal: CalibrationFile = { version: 1, lastRun: sampleRun({ peakRssMb: 3000, workerCount: 4, totalShards: 12 }) };
    const noOverride = adviseFromCalibration(cal, {}, current);
    expect(noOverride?.rationale).not.toContain('user override');

    const equalOverride = adviseFromCalibration(cal, { maxPackageWorkers: 15 }, current);
    expect(equalOverride?.rationale).not.toContain('user override'); // matches auto-pick
  });
});
