/**
 * Single-flight runner for `refresh_context({ reloadConfig: true })`: builds a fresh runtime from the
 * re-read config, drains the outgoing annotation store, re-reads the incoming one, and swaps the ready
 * runtime. Concurrent calls coalesce onto the one in-flight swap.
 *
 * Cancellation: the initiating request's signal and a runner-owned controller are combined with
 * `AbortSignal.any`, so both a client cancel and a server shutdown (`abortActive()`) stop the rebuild.
 * Checkpoints guard every durable step — after the runtime build and, finally, after drain/reload
 * immediately before the swap — so a late cancel always leaves the current runtime intact.
 *
 * Dependency-injected (no direct imports of the runtime/controller) so the lifecycle is unit-testable.
 */

export interface ReloadConfigResult {
  configReloaded: true;
  drainWarning?: string;
}

export interface ReloadConfigDeps<Cfg, Ctx> {
  /** Re-read the on-disk config. Synchronous and cheap; runs before the rebuild. */
  loadNextConfig(): Cfg;
  /** Build the replacement runtime. Must honor `signal` at its own internal checkpoints. */
  buildRuntime(cfg: Cfg, signal: AbortSignal): Promise<Ctx>;
  /** Drain the OUTGOING (current) store so pre-barrier writes are on disk; returns its save error, if any. */
  drainOutgoing(): Promise<string | undefined>;
  /** Re-read the incoming runtime's store from disk so it reflects the outgoing store's final state. */
  reloadIncoming(ctx: Ctx): Promise<void>;
  /** Publish: swap the ready runtime and apply process-level config (logging, quality store). */
  publish(ctx: Ctx, cfg: Cfg): void;
  /** Observer for a non-fatal outgoing-drain failure (pending writes may be stranded). */
  onDrainWarning?(message: string): void;
}

export class ReloadConfigRunner<Cfg, Ctx> {
  private inFlight: Promise<ReloadConfigResult> | null = null;
  private abortCtl: AbortController | null = null;

  constructor(private readonly deps: ReloadConfigDeps<Cfg, Ctx>) {}

  /** True while a reload swap is running; annotation writes are refused during this window. */
  get isInFlight(): boolean {
    return this.inFlight !== null;
  }

  run(requestSignal?: AbortSignal): Promise<ReloadConfigResult> {
    // Single-flight: concurrent reloadConfig calls coalesce onto one runtime swap instead of racing
    // to publish last-completion-wins. The initiating request's signal governs the shared build.
    if (this.inFlight) return this.inFlight;
    const abortCtl = new AbortController();
    this.abortCtl = abortCtl;
    const signal = requestSignal ? AbortSignal.any([requestSignal, abortCtl.signal]) : abortCtl.signal;
    this.inFlight = this.runOnce(signal).finally(() => {
      this.inFlight = null;
      this.abortCtl = null;
    });
    return this.inFlight;
  }

  /** Shutdown path: abort the in-flight swap (if any) and wait for it to settle, so its build's
   *  worker pool is destroyed (python children reaped) before the process exits. No-op when idle. */
  async abortActive(): Promise<void> {
    const inFlight = this.inFlight;
    if (!inFlight) return;
    this.abortCtl?.abort();
    await inFlight.then(() => undefined, () => undefined);
  }

  private async runOnce(signal: AbortSignal): Promise<ReloadConfigResult> {
    const nextCfg = this.deps.loadNextConfig();
    // Build the new runtime first (it loads its store from disk), THEN drain the outgoing store so
    // any write that landed before the barrier is on disk, THEN re-read it into the new store — so
    // the swap publishes a store that reflects the outgoing store's final state, not a stale disk snapshot.
    const nextCtx = await this.deps.buildRuntime(nextCfg, signal);
    // Checkpoint: an abort that landed during the build (after its last internal checkpoint) must not
    // proceed to drain the outgoing store — leave the current runtime untouched.
    signal.throwIfAborted();
    const drainWarning = await this.deps.drainOutgoing();
    if (drainWarning) this.deps.onDrainWarning?.(drainWarning);
    await this.deps.reloadIncoming(nextCtx);
    // Final checkpoint immediately before the swap: a cancel landing during drain/reload must not
    // replace the ready runtime. Everything up to here touched only the new runtime and the on-disk
    // store (both idempotent); the swap is the one non-reversible step.
    signal.throwIfAborted();
    this.deps.publish(nextCtx, nextCfg);
    return { configReloaded: true, ...(drainWarning ? { drainWarning } : {}) };
  }
}
