import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createShutdownSequence } from '../../src/mcp/shutdown.js';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { findFixturesRoot } from '../laws/graph-law-helpers.js';
import { listChildProcesses } from '../helpers/process-probe.js';

// Acceptance: aborting a POOLED build mid-python-extraction leaves zero live python children.
// The pooled path spawns python AST subprocesses inside worker isolates; the abort propagates
// abort → pool.destroy() → worker shutdown handler → plugin.terminateInFlight() → SIGKILL + reap.
// The build promise settles only after pool.destroy(), so children must be gone right after it rejects.

const hasPython = ((): boolean => {
  try { return spawnSync('python3', ['--version'], { timeout: 5_000 }).status === 0; } catch { return false; }
})();

/** Python processes among the direct children of THIS process (worker threads share the pid). */
function livePythonChildren(): string[] {
  return listChildProcesses(process.pid)
    .filter(c => c.command.includes('python'))
    .map(c => `${c.pid} ${c.command}`);
}

/** Wait for proof that this test entered the Python extraction phase before cancelling it. */
async function waitForPythonChild(timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let children = livePythonChildren();
  while (children.length === 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 25));
    children = livePythonChildren();
  }
  return children;
}

/** Inflate the fixture with generated modules so the python AST parse is slow enough to abort into. */
function inflateFixture(root: string): void {
  const pkgDir = path.join(root, 'packages', 'basic-python');
  const fn = (i: number): string =>
    `def generated_fn_${i}(a, b):\n    x = {"k": [a, b, ${i}]}\n    return sorted(x["k"]) if a > b else [v * ${i} for v in x["k"]]\n`;
  for (let f = 0; f < 6; f++) {
    const body = Array.from({ length: 4_000 }, (_, i) => fn(f * 4_000 + i)).join('\n');
    fs.writeFileSync(path.join(pkgDir, `generated_bulk_${f}.py`), `"""generated bulk module ${f}"""\n\n${body}`);
  }
}

(hasPython ? describe : describe.skip)('pooled python extraction abort (integration)', () => {
  it('leaves zero live python children after an abort settles the pooled build', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-pooled-py-abort-'));
    const root = path.join(parent, 'basic-python');
    fs.cpSync(path.join(findFixturesRoot(), 'basic-python'), root, { recursive: true });
    inflateFixture(root);

    const ac = new AbortController();
    const origLog = console.log;
    const origWarn = console.warn;
    let settled: Promise<'resolved' | 'rejected'> | undefined;
    let outcome: 'resolved' | 'rejected' | undefined;
    let childrenAtAnnotationDrain: string[] | undefined;
    const exitCodes: number[] = [];
    console.log = () => undefined;
    console.warn = () => undefined;
    try {
      const build = collectRepositoryFactsAsync(root, { maxPackageWorkers: 2, signal: ac.signal });
      settled = build.then(() => 'resolved' as const, () => 'rejected' as const);
      // Do not rely on a fixed delay: prove the pooled build spawned a real Python subprocess, then
      // cancel while that subprocess is live. This makes zero-children-after-abort non-vacuous.
      const observed = await waitForPythonChild(10_000);
      expect(observed.length).toBeGreaterThan(0);
      const shutdown = createShutdownSequence({
        closeAdmission: () => undefined,
        abortActiveBuilds: async () => {
          ac.abort(); // startup-controller equivalent: cancel the build and await pool destruction
          outcome = await settled;
        },
        inFlightToolCalls: () => 0,
        terminateInlinePluginChildren: async () => undefined,
        drainAnnotations: async () => { childrenAtAnnotationDrain = livePythonChildren(); },
        afterFlushHooks: [],
        exit: code => { exitCodes.push(code); },
        log: () => undefined,
        logError: () => undefined,
        deadlineMs: 8_000,
        buildAbortGraceMs: 4_000,
        cleanupTailMs: 2_000,
      });
      await shutdown('integration-test');

      expect(outcome).toBe('rejected'); // the abort was honored, not swallowed
      expect(childrenAtAnnotationDrain).toEqual([]); // shutdown awaited pooled-child cleanup first
      expect(exitCodes).toEqual([0]);

      // pool.destroy() has completed (the build settles in its finally), so worker isolates have
      // reaped their children. Poll briefly for the OS to update the process table.
      const deadline = Date.now() + 3_000;
      let leaked = livePythonChildren();
      while (leaked.length > 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
        leaked = livePythonChildren();
      }
      expect(leaked).toEqual([]);
    } finally {
      // Ensure a failed precondition/assertion cannot leave the build or its children behind.
      ac.abort();
      await settled;
      console.log = origLog;
      console.warn = origWarn;
      fs.rmSync(parent, { recursive: true, force: true });
    }
  }, 60_000);
});
