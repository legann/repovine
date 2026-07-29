import { describe, expect, it, jest } from '@jest/globals';
import { runPythonAst, __PY_AST_TIMEOUT_MS_FOR_TEST } from '../../../../packages/plugins/source-python/src/extract.js';

// The runaway-parse backstop is a manual unref'd timer cleared on 'close' — not spawn's `timeout`
// option, whose internal timer is ref'd and stays armed for the full 10 min after an early spawn
// failure, holding the event loop open. Assert the backstop is unref'd and cleared when a spawn fails.
describe('runPythonAst backstop timer lifecycle', () => {
  it("unref's the backstop timer and clears it on a failed spawn (no ref'd handle held)", async () => {
    const realSetTimeout = global.setTimeout;
    let backstop: NodeJS.Timeout | undefined;
    let unrefed = false;

    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((
      fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]
    ): NodeJS.Timeout => {
      const timer = (realSetTimeout as unknown as (...a: unknown[]) => NodeJS.Timeout)(fn, ms, ...rest);
      if (ms === __PY_AST_TIMEOUT_MS_FOR_TEST) {
        backstop = timer;
        const origUnref = timer.unref.bind(timer);
        timer.unref = (): NodeJS.Timeout => { unrefed = true; return origUnref(); };
      }
      return timer;
    }) as unknown as typeof global.setTimeout);
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

    try {
      // A binary that cannot spawn → the child emits 'error' (and the run rejects) promptly.
      await expect(
        runPythonAst('repovine-no-such-python-binary-xyz', 'print(1)', ['/nonexistent/a.py']),
      ).rejects.toThrow();

      expect(backstop).toBeDefined();               // the manual backstop was armed
      expect(unrefed).toBe(true);                    // and unref'd, so it never blocks process exit
      expect(clearTimeoutSpy).toHaveBeenCalledWith(backstop); // and cleared on settle, not left armed
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });
});
