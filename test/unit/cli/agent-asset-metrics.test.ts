import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  initAll,
  initCodex,
  initCursor,
} from '../../../src/cli/init.js';
import { collectGeneratedAssetMetrics } from '../../helpers/agent-asset-metrics.js';

describe('generated asset metrics helper', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-asset-metrics-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('collects Cursor-only scorecard data without treating AGENTS.md as Cursor surface', () => {
    initCursor(tmpDir, { forceBootstrap: false, replaceMcp: false });

    const metrics = collectGeneratedAssetMetrics(tmpDir, 'cursor');
    expect(metrics.files.some(file => file.path === 'AGENTS.md')).toBe(false);
    expect(metrics.byClass.rules.files).toBeGreaterThan(0);
    expect(metrics.totals.alwaysOnChars).toBeGreaterThan(0);
    const expectedAlwaysOnTokens = metrics.files
      .filter(file => file.alwaysOn)
      .reduce((sum, file) => sum + file.estimatedTokens, 0);
    expect(metrics.totals.alwaysOnEstimatedTokens).toBe(expectedAlwaysOnTokens);
    expect(metrics.snippetCounts.annotationsMcpOnly).toBeGreaterThan(0);
    expect(metrics.largestFiles.length).toBeGreaterThan(0);
    expect(metrics.byClass.hooks.files).toBe(2);
    expect(metrics.files.some(file => file.path.endsWith('hooks/repovine-client-dispatcher.mjs'))).toBe(true);
  });

  it('keeps Cursor and Claude scorecards separated in mixed init output', () => {
    initAll(tmpDir, { forceBootstrap: false, replaceMcp: false });

    const cursor = collectGeneratedAssetMetrics(tmpDir, 'cursor');
    const claude = collectGeneratedAssetMetrics(tmpDir, 'claude');

    expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(true);
    expect(cursor.files.some(file => file.path === 'AGENTS.md')).toBe(false);
    expect(claude.files.some(file => file.path === 'AGENTS.md')).toBe(true);
    expect(cursor.byClass.rules.alwaysOnChars).toBe(cursor.totals.alwaysOnChars);
    expect(claude.byClass.instructions.alwaysOnChars).toBeGreaterThan(0);
    expect(claude.byClass.instructions.alwaysOnChars).toBeLessThan(9000);
    expect(claude.files.some(file => file.path.endsWith('hooks/repovine-client-dispatcher.mjs'))).toBe(true);
  });

  it('collects Codex scorecard data with AGENTS.md and shared skills', () => {
    initCodex(tmpDir, { forceBootstrap: false, replaceMcp: false });

    const metrics = collectGeneratedAssetMetrics(tmpDir, 'codex');
    expect(metrics.client).toBe('codex');
    expect(metrics.files.some(file => file.path === 'AGENTS.md')).toBe(true);
    expect(metrics.files.every(file => file.client === 'codex')).toBe(true);
    expect(metrics.files.some(file => file.path === 'CLAUDE.md')).toBe(false);
    expect(metrics.byClass.instructions.alwaysOnChars).toBeGreaterThan(0);
    expect(metrics.byClass.instructions.alwaysOnChars).toBeLessThan(8000);
    expect(metrics.byClass['shared-skills']?.files ?? 0).toBeGreaterThan(0);
    expect(metrics.byClass['hooks-and-config']?.files ?? 0).toBeGreaterThan(0);
    expect(metrics.files.some(file => file.path.endsWith('hooks/repovine-client-dispatcher.mjs'))).toBe(true);
  });
});
