import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { MemoryProfiler, isProfileEnabled } from '../../../src/perf/memory-profiler.js';

describe('MemoryProfiler', () => {
  const originalProfile = process.env.REPOVINE_PROFILE;
  const originalGc = process.env.REPOVINE_PROFILE_GC;
  const originalProfileFile = process.env.REPOVINE_PROFILE_FILE;
  let tmpDir: string;
  let errorSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    delete globalThis.__repovineProfiler;
    process.env.REPOVINE_PROFILE = '1';
    delete process.env.REPOVINE_PROFILE_GC;
    // Keep the profiler's crash-trail out of the repo root during tests.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profiler-test-'));
    process.env.REPOVINE_PROFILE_FILE = path.join(tmpDir, 'build-profile.log');
    // phase() streams each line to stderr by design; silence it so the run stays quiet.
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete globalThis.__repovineProfiler;
    if (originalProfile === undefined) delete process.env.REPOVINE_PROFILE;
    else process.env.REPOVINE_PROFILE = originalProfile;
    if (originalGc === undefined) delete process.env.REPOVINE_PROFILE_GC;
    else process.env.REPOVINE_PROFILE_GC = originalGc;
    if (originalProfileFile === undefined) delete process.env.REPOVINE_PROFILE_FILE;
    else process.env.REPOVINE_PROFILE_FILE = originalProfileFile;
  });

  it('is disabled by default when env is unset', () => {
    delete process.env.REPOVINE_PROFILE;
    expect(isProfileEnabled()).toBe(false);
  });

  it('records phases and counters when enabled', () => {
    const profiler = MemoryProfiler.ensure();
    expect(profiler.enabled).toBe(true);

    profiler.phase('start');
    profiler.setCounter('uniqueModules', 42);
    profiler.phase('end');

    const lines = profiler.summaryLines();
    expect(lines.some(line => line.includes('start'))).toBe(true);
    expect(lines.some(line => line.includes('uniqueModules=42'))).toBe(true);
  });

  it('writes a readable crash-trail file whose contents carry the phase lines', () => {
    const profiler = MemoryProfiler.ensure();
    expect(profiler.enabled).toBe(true);

    profiler.phase('scan');
    profiler.phase('link-graph');

    const trailPath = process.env.REPOVINE_PROFILE_FILE as string;
    // The trail must survive on disk for offline reading after an OOM/crash.
    expect(fs.existsSync(trailPath)).toBe(true);
    const trail = fs.readFileSync(trailPath, 'utf8');

    // Header: constructor truncates and stamps pid + cwd so each build's trail stands alone.
    expect(trail).toContain('# repovine build profile');
    expect(trail).toContain(`pid=${process.pid}`);
    expect(trail).toContain(`cwd=${process.cwd()}`);

    // Every phase() call appends a line naming the phase and its live RSS reading.
    const trailLines = trail.split('\n');
    const scanLine = trailLines.find(l => l.startsWith('scan'));
    const linkLine = trailLines.find(l => l.startsWith('link-graph'));
    expect(scanLine).toBeDefined();
    expect(linkLine).toBeDefined();
    expect(scanLine).toMatch(/\d+ms/);
    expect(scanLine).toMatch(/rss=\s*\d+MB/);
    expect(scanLine).toMatch(/heap=\d+MB/);
    expect(scanLine).toMatch(/arrayBuffers=\d+MB/);
    // Both phases land in the same trail, in append order after the header.
    expect(trailLines.indexOf(scanLine as string)).toBeGreaterThan(0);
    expect(trailLines.indexOf(linkLine as string))
      .toBeGreaterThan(trailLines.indexOf(scanLine as string));
  });

  it('summaryLines does not throw on a huge phase count (reduce, not Math.max spread)', () => {
    // A long-lived MCP process appends a phase per package shard per build; past V8's argument-count
    // limit a `Math.max(...phases)` spread throws RangeError. Point the trail at a directory so the
    // constructor disables per-phase file appends and the 150k loop stays cheap.
    process.env.REPOVINE_PROFILE_FILE = tmpDir;
    const profiler = MemoryProfiler.ensure();
    for (let i = 0; i < 150_000; i++) profiler.phase('shard');
    let lines: string[] = [];
    expect(() => { lines = profiler.summaryLines(); }).not.toThrow();
    expect(lines.some(l => /^Peak heap: \d+ MB$/.test(l))).toBe(true);
  });

  it('reset() drops accumulated phases so the singleton stays bounded across builds', () => {
    const profiler = MemoryProfiler.ensure();
    profiler.phase('old-phase-A');
    profiler.phase('old-phase-B');
    expect(profiler.summaryLines().join('\n')).toContain('old-phase-A');

    profiler.reset();
    profiler.phase('new-phase-C');

    const after = profiler.summaryLines().join('\n');
    expect(after).not.toContain('old-phase-A');
    expect(after).not.toContain('old-phase-B');
    expect(after).toContain('new-phase-C');
  });

  it('reset() clears counters so a build reports its own numbers, not the prior build\'s (R10)', () => {
    const profiler = MemoryProfiler.ensure();
    // Simulate a prior build that set a counter on the process-global singleton.
    profiler.setCounter('searchIndexTokens', 9999);
    expect(profiler.summaryLines().join('\n')).toContain('searchIndexTokens=9999');

    profiler.reset(); // next build starts

    // A build that never re-sets searchIndexTokens must report 0, not the stale 9999 from last build.
    const after = profiler.summaryLines().join('\n');
    expect(after).toContain('searchIndexTokens=0');
    expect(after).not.toContain('searchIndexTokens=9999');
  });
});
