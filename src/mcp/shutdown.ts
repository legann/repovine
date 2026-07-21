/**
 * Ordered graceful-shutdown sequence for the MCP server. Dependency-injected so the ORDER — the part
 * round-3 review flagged as untestable inside the CLI entry — is unit-testable with fakes.
 *
 * Phase order (each bounded; a hard-exit backstop covers a hung phase):
 *   1. close admission (new tool calls refused)
 *   2. abort every active build kind — startup, refresh, reloadConfig — so their worker pools destroy
 *      and worker-local plugin cleanup reaps python children; bounded by a reserved grace budget so a
 *      hung build cannot eat the whole deadline that the annotation drain needs
 *   3. wait for in-flight tool calls to finish (their writes must reach the store)
 *   4. main-thread plugin teardown — the INLINE-child fallback; pooled children are owned by their
 *      worker isolates and were reaped in phase 2
 *   5. drain annotation saves
 *   6. after-flush hooks, then transport close
 */

export interface ShutdownDeps {
  /** Refuse new tool calls from now on. */
  closeAdmission(): void;
  /** Abort startup + refresh + reloadConfig builds and resolve once they settle (pools destroyed). */
  abortActiveBuilds(): Promise<void>;
  /** Current in-flight tool-call count; the drain loop polls it. */
  inFlightToolCalls(): number;
  /** Main-thread source-plugin teardown (SIGKILL inline python children). */
  terminateInlinePluginChildren(): Promise<void>;
  /** Drain pending annotation saves of the current runtime (no-op when no runtime). */
  drainAnnotations(): Promise<void>;
  /** After-flush hooks (sidecars), run after the store is drained. */
  afterFlushHooks: Array<() => Promise<void>>;
  closeTransport?(): Promise<void>;
  /** Terminal exit. Injected so tests observe it instead of dying. */
  exit(code: number): void;
  log(message: string): void;
  logError(message: string): void;
  /** Total drain deadline (default 8s), the phase-2 build-abort slice, and the cleanup tail that
   * tool-call draining may never consume. */
  deadlineMs?: number;
  buildAbortGraceMs?: number;
  cleanupTailMs?: number;
}

/** Live MCP build handles that shutdown must trigger together. Keeping this adapter beside the
 * ordered sequence makes the index.ts wiring testable without importing the CLI entrypoint. */
export interface ShutdownBuildDeps {
  abortStartup(): Promise<unknown>;
  abortRefresh(): Promise<unknown>;
  abortReloadConfig(): Promise<unknown>;
  logError(message: string): void;
}

/** Abort every independently-owned build lifecycle. Start all three before awaiting any one of them:
 * a slow owner must not prevent the other worker pools from receiving their cancellation. Individual
 * failures are logged and absorbed so cleanup can continue for the remaining owners. */
export async function abortMcpBuilds(deps: ShutdownBuildDeps): Promise<void> {
  const settle = async (label: string, abort: () => Promise<unknown>): Promise<void> => {
    try {
      await abort();
    } catch (e) {
      deps.logError(`  [shutdown] ${label} abort error: ${(e as Error).message}`);
    }
  };
  await Promise.all([
    settle('startup build', deps.abortStartup),
    settle('refresh', deps.abortRefresh),
    settle('reloadConfig', deps.abortReloadConfig),
  ]);
}

const DEFAULT_DEADLINE_MS = 8_000;
const DEFAULT_BUILD_ABORT_GRACE_MS = 4_000;
const DEFAULT_CLEANUP_TAIL_MS = 2_000;

export function createShutdownSequence(deps: ShutdownDeps): (reason: string) => Promise<void> {
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const buildAbortGraceMs = deps.buildAbortGraceMs ?? DEFAULT_BUILD_ABORT_GRACE_MS;
  const cleanupTailMs = Math.max(0, Math.min(deps.cleanupTailMs ?? DEFAULT_CLEANUP_TAIL_MS, deadlineMs));
  let shuttingDown = false;
  return async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.closeAdmission();
    deps.log(`\n  Shutting down (${reason}) — stopping builds, draining annotation saves...`);
    const deadline = Date.now() + deadlineMs;
    // In-flight tool calls may consume only the head of the deadline. The tail belongs to resource
    // teardown, annotation persistence, hooks and transport close; otherwise a hung build followed
    // by a stuck tool call reaches the hard-exit timer before drainAnnotations() even starts.
    const cleanupStartsAt = deadline - cleanupTailMs;
    // Backstop: if any phase hangs, exit anyway. Unref'd so it never keeps the loop alive.
    const hardExit = setTimeout(() => {
      deps.logError('  [shutdown] drain exceeded deadline; forcing exit.');
      deps.exit(0);
    }, deadlineMs);
    hardExit.unref();

    // Abort active builds FIRST: their pool teardown reaps pooled python children, and their tool
    // calls (refresh_context long-awaits) unblock, which also speeds the drain below. Bounded by a
    // reserved grace so a hung build leaves time for the annotation drain.
    try {
      const abortWaitMs = Math.max(0, Math.min(buildAbortGraceMs, cleanupStartsAt - Date.now()));
      await Promise.race([
        deps.abortActiveBuilds(),
        new Promise<void>(resolve => { const t = setTimeout(resolve, abortWaitMs); t.unref(); }),
      ]);
    } catch (e) {
      deps.logError(`  [shutdown] build abort error: ${(e as Error).message}`);
    }

    // Let already-accepted tool calls finish (their writes reach the store) before we drain it.
    while (deps.inFlightToolCalls() > 0 && Date.now() < cleanupStartsAt) {
      await new Promise(r => setTimeout(r, 25));
    }

    // Fallback for INLINE-path children spawned on the main thread; pooled children belong to worker
    // isolates and were reaped by the pool destroy in the build abort above.
    try {
      await deps.terminateInlinePluginChildren();
    } catch (e) {
      deps.logError(`  [shutdown] plugin subprocess teardown error: ${(e as Error).message}`);
    }

    try {
      await deps.drainAnnotations();
    } catch (e) {
      deps.logError(`  [ALERT] Failed to drain annotations on shutdown: ${(e as Error).message}`);
    }
    for (const hook of deps.afterFlushHooks) {
      try {
        await hook();
      } catch (e) {
        deps.logError(`  [shutdown] ${(e as Error).message}`);
      }
    }
    try {
      await deps.closeTransport?.();
    } catch (e) {
      deps.logError(`  [shutdown] transport close error: ${(e as Error).message}`);
    }
    clearTimeout(hardExit);
    // Saves are drained and the transport is closed; exit deterministically.
    deps.exit(0);
  };
}
