import { describe, it, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../../src/stage1/index.js';

/** Resolve a committed fixture by name from either the engine root or a parent workspace. */
function fixture(name: string): string {
  const candidates = [
    path.resolve(process.cwd(), 'test', 'fixtures', name),
    path.resolve(process.cwd(), 'repovine', 'test', 'fixtures', name),
  ];
  const root = candidates.find(candidate => fs.existsSync(candidate));
  if (!root) throw new Error(`fixture ${name} not found. Tried: ${candidates.join(', ')}`);
  return root;
}

// Jest forces REPOVINE_MAX_PACKAGE_WORKERS=1 (see test/jest.setup.ts), so extraction runs on the
// inline path — the unit-testable Stage 1 cancel route. The pooled worker race needs an opt-in
// integration test (workers > 1) outside this default.
describe('collectRepositoryFactsAsync cooperative cancel (inline path)', () => {
  it('rejects at entry when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();

    await expect(
      collectRepositoryFactsAsync(fixture('basic-typescript'), { signal: ac.signal }),
    ).rejects.toThrow();
  });

  it('stops before the next package when aborted mid-run', async () => {
    const ac = new AbortController();
    let packagesDone = 0;

    await expect(
      collectRepositoryFactsAsync(fixture('lambda-monorepo'), {
        signal: ac.signal,
        // Abort after the first package completes; the next package's boundary check throws before
        // its own packageDone fires, so exactly one package is reported done.
        progress: { packageDone: () => { packagesDone += 1; ac.abort(); } },
      }),
    ).rejects.toThrow();

    expect(packagesDone).toBe(1);
  });
});
