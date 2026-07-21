import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// R11: in a worker isolate (isMainThread=false) the profiler must NOT create or truncate the shared
// crash-trail file — a Stage 2 worker builds its own profiler, and truncating would wipe the main
// thread's Stage 1 trail (and concurrent appends would interleave). Mock the worker_threads flag so
// the constructor takes the off-main-thread branch.
describe('MemoryProfiler crash-trail off the main thread (R11)', () => {
  const originalProfile = process.env.REPOVINE_PROFILE;
  const originalProfileFile = process.env.REPOVINE_PROFILE_FILE;
  let tmpDir: string;
  let trailPath: string;
  let consoleErrorSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profiler-worker-trail-'));
    trailPath = path.join(tmpDir, 'build-profile.log');
    process.env.REPOVINE_PROFILE = '1';
    process.env.REPOVINE_PROFILE_FILE = trailPath;
    // phase() emits the real-time trail line to stderr on the enabled path; this test asserts on the
    // trail file, not the log, so swallow it to keep the Jest report clean.
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    jest.unstable_unmockModule('node:worker_threads');
    jest.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete globalThis.__repovineProfiler;
    if (originalProfile === undefined) delete process.env.REPOVINE_PROFILE;
    else process.env.REPOVINE_PROFILE = originalProfile;
    if (originalProfileFile === undefined) delete process.env.REPOVINE_PROFILE_FILE;
    else process.env.REPOVINE_PROFILE_FILE = originalProfileFile;
  });

  it('leaves the main thread trail intact when a worker-isolate profiler is constructed', async () => {
    // Seed the trail with a main-thread build's content that must survive the worker's profiler.
    const mainTrail = '# main thread trail\nstage1 phase\n';
    fs.writeFileSync(trailPath, mainTrail);

    jest.resetModules();
    jest.unstable_mockModule('node:worker_threads', () => ({ isMainThread: false }));
    const { MemoryProfiler } = await import('../../../src/perf/memory-profiler.js');

    const profiler = new MemoryProfiler(true); // enabled, but off-main-thread per the mock
    profiler.phase('stage2 worker phase');

    // No truncation on construction, no per-phase appends from the worker: the trail is untouched.
    expect(fs.readFileSync(trailPath, 'utf8')).toBe(mainTrail);
  });
});
