import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  formatPackageProgressLine,
  formatSemanticEmbedProgressLine,
  logPipelineProgress,
  logPipelineProgressEnd,
  setPipelineLogSink,
  setProgressInPlace,
  stripAnsi,
} from '../../../src/cli/ui.js';

describe('formatSemanticEmbedProgressLine', () => {
  it('includes counter, bar, percent, and timing', () => {
    const line = stripAnsi(formatSemanticEmbedProgressLine(48, 160, 90_000));
    expect(line).toContain('[ 48/160]');
    expect(line).toContain('semantic search embeddings');
    expect(line).toContain('30%');
    expect(line).toContain('t=01:30');
    expect(line).toContain('eta~');
    expect(line).toMatch(/[█░]{10,}/);
  });
});

describe('formatPackageProgressLine', () => {
  it('includes counter, bar, percent, package name, and timing', () => {
    const line = stripAnsi(formatPackageProgressLine(5, 13, 'repovine', 167, 1_000, 1819, '(reused 167, parsed 0)'));
    expect(line).toContain('[ 5/13]');
    expect(line).toContain('extracting packages');
    expect(line).toContain('38%');
    expect(line).toContain('repovine');
    expect(line).toContain('167mod');
    expect(line).toContain('rss=1819MB');
    expect(line).toContain('(reused 167, parsed 0)');
    expect(line).toMatch(/[█░]{10,}/);
  });

  it('truncates very long package names to keep progress lines on one row', () => {
    const long = 'platform-frontend-tests-integration-extra-suffix';
    const line = stripAnsi(formatPackageProgressLine(2, 10, long, 6, 1_000, 1177, '(reused 0, parsed 6)'));
    expect(line).not.toContain(long);
    expect(line).toContain('platform-frontend-tests-integration-ext…');
  });
});

describe('logPipelineProgress in-place mode', () => {
  let stderrWrite: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    setPipelineLogSink('stderr');
    setProgressInPlace(true);
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true, writable: true });
    Object.defineProperty(process.stderr, 'columns', { value: 100, configurable: true, writable: true });
  });

  afterEach(() => {
    logPipelineProgressEnd();
    setProgressInPlace(false);
    stderrWrite.mockRestore();
  });

  it('uses carriage return on piped stderr when progress in-place is forced (MCP host)', () => {
    logPipelineProgress('  [1/10] extracting packages');
    expect(stderrWrite).toHaveBeenCalled();
    const payload = String(stderrWrite.mock.calls.at(-1)?.[0]);
    expect(payload.startsWith('\r')).toBe(true);
    expect(payload).toContain('\x1b[K');
    expect(payload.endsWith('\n')).toBe(false);
  });
});
