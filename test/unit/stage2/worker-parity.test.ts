import { describe, expect, it, afterEach, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../../src/stage1/index.js';
import { composeRepositoryGraph, composeRepositoryGraphAsync } from '../../../src/stage2/index.js';
import { getInterpreterEntrypoints } from '../../../src/stage2/interpreter/entrypoint-store.js';
import { findFixturesRoot, normalizeGraph } from '../../laws/graph-law-helpers.js';
import type { RepositoryFactsSnapshot } from '../../../src/types.js';

const tempRoots: string[] = [];

// jest.setup defaults the suite to inline compose; this test must exercise the real offload worker.
let priorInline: string | undefined;
let priorStrict: string | undefined;
beforeAll(() => {
  priorInline = process.env.REPOVINE_STAGE2_INLINE;
  priorStrict = process.env.REPOVINE_STAGE2_WORKER_STRICT;
  delete process.env.REPOVINE_STAGE2_INLINE;
  // Hermetic worker contract: jest.global-setup.cjs runs `npm run build` before every Jest run, so
  // dist/ is always freshly compiled from the checked-out sources (never a stale ignored artifact).
  // STRICT turns ANY offload failure (spawn, clone, worker-side error) into a suite failure instead of
  // a silent inline fallback that would pass parity without exercising the worker boundary at all.
  process.env.REPOVINE_STAGE2_WORKER_STRICT = '1';
  const built = [
    path.resolve(process.cwd(), 'dist', 'stage2', 'worker.js'),
    path.resolve(process.cwd(), 'repovine', 'dist', 'stage2', 'worker.js'),
  ].some(p => fs.existsSync(p));
  if (!built) {
    throw new Error('dist/stage2/worker.js not built — run `npm run build` before this suite; it exercises the real Stage 2 worker offload, not the inline fallback');
  }
});
afterAll(() => {
  if (priorInline === undefined) delete process.env.REPOVINE_STAGE2_INLINE;
  else process.env.REPOVINE_STAGE2_INLINE = priorInline;
  if (priorStrict === undefined) delete process.env.REPOVINE_STAGE2_WORKER_STRICT;
  else process.env.REPOVINE_STAGE2_WORKER_STRICT = priorStrict;
});

afterEach(() => {
  while (tempRoots.length > 0) fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

function copyFixture(name: string): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `repovine-${name}-`));
  const dest = path.join(parent, name);
  fs.cpSync(path.join(findFixturesRoot(), name), dest, { recursive: true });
  tempRoots.push(parent);
  return dest;
}

async function snapshotOf(fixture: string): Promise<RepositoryFactsSnapshot> {
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    return await collectRepositoryFactsAsync(copyFixture(fixture), { maxPackageWorkers: 1 });
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
}

describe('composeRepositoryGraphAsync (Stage 2 worker offload)', () => {
  // The offloaded worker runs the SAME composeRepositoryGraph, so parity is by construction; this
  // guards the serialization boundary (snapshot in, Map/Set graph out survive structured clone) and
  // that the worker isolate registers the full interpreter set.
  it('produces a graph identical to inline compose on a multi-package fixture', async () => {
    const snapshot = await snapshotOf('hybrid-monorepo');
    const inline = composeRepositoryGraph(snapshot);
    const offloaded = await composeRepositoryGraphAsync(snapshot);
    expect(normalizeGraph(offloaded)).toEqual(normalizeGraph(inline));
  });

  it('matches inline compose on an infra fixture (runtime-resource edges + domains)', async () => {
    const snapshot = await snapshotOf('docker-compose-app');
    const inline = composeRepositoryGraph(snapshot);
    const offloaded = await composeRepositoryGraphAsync(snapshot);
    expect(normalizeGraph(offloaded)).toEqual(normalizeGraph(inline));
  });

  // Interpreter entrypoints live in a process-local WeakMap keyed by the graph object; structured
  // clone hands the parent a fresh graph with no WeakMap entry, so the worker must carry them across the
  // boundary and the parent re-key them. normalizeGraph is blind to this sidecar — assert it directly, on
  // a route-bearing fixture so the assertion is not vacuous (other fixtures yield zero entrypoints).
  it('carries interpreter entrypoints across the worker boundary', async () => {
    const snapshot = await snapshotOf('nestjs-modular');
    const inline = composeRepositoryGraph(snapshot);
    const inlineEntrypoints = getInterpreterEntrypoints(inline);
    expect(inlineEntrypoints.length).toBeGreaterThan(0); // guard against a vacuous parity assertion

    const offloaded = await composeRepositoryGraphAsync(snapshot);
    expect(getInterpreterEntrypoints(offloaded)).toEqual(inlineEntrypoints);
  });
});
