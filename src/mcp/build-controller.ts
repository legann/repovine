import type { RepovineRuntime } from './context.js';

export type IndexBuildStage = 'pending' | 'stage1' | 'stage2' | 'stage3' | 'ready' | 'failed' | 'cancelled';

/** Hooks passed into `RepovineRuntime.create` so the MCP server can observe pipeline progress. */
export interface BuildHooks {
  onStageEnter?(stage: 'stage1' | 'stage2' | 'stage3'): void;
  onExtractionBegin?(totals: { totalPackages: number; totalModules: number }): void;
  onPackageDone?(pkgName: string, pkgModules: number): void;
  onSemanticEmbedProgress?(done: number, total: number): void;
}

export interface IndexBuildStatus {
  status: 'pending' | 'building' | 'ready' | 'failed' | 'cancelled';
  stage: IndexBuildStage;
  /** Stage-1 progress, populated while stage===stage1. */
  doneModules?: number;
  totalModules?: number;
  donePackages?: number;
  totalPackages?: number;
  currentPackage?: string;
  /** Stage-3 semantic search embed progress while embeddings are running. */
  doneSemanticCards?: number;
  totalSemanticCards?: number;
  pct?: number;
  /** Seconds since start of build. */
  elapsedSec?: number;
  /** Seconds remaining in the current stage only (best-effort estimate). */
  stageEtaSec?: number;
  /** Pipeline stages after the current one (stage1→2, stage2→1, stage3→0). */
  remainingStages?: number;
  /** Suggested next poll delay in seconds. */
  retryAfterSec: number;
  /** Human-friendly message. */
  message: string;
  errorMessage?: string;
}

/**
 * Tracks the lifecycle of `RepovineRuntime.create()` so MCP tools can return informational
 * responses while the graph is being built instead of blocking the stdio handshake or
 * surfacing errors. Owned by the MCP server, mutated only via the public methods below.
 */
export class IndexBuildController {
  private ctx: RepovineRuntime | undefined;
  private stage: IndexBuildStage = 'pending';
  private startedAt = 0;
  private donePackages = 0;
  private totalPackages = 0;
  private doneModules = 0;
  private totalModules = 0;
  private currentPackage: string | undefined;
  private doneSemanticCards = 0;
  private totalSemanticCards = 0;
  private semanticEmbedStartedAt = 0;
  private lastStageStartedAt = 0;
  private errorMessage: string | undefined;
  private promise: Promise<RepovineRuntime> | undefined;
  private abortController: AbortController | undefined;
  /** Set by cancel() so start()'s catch can distinguish a cancel from a real build failure. */
  private cancelRequested = false;
  /** Retained from the first start() so rebuild() can re-run a fresh build from `cancelled`. */
  private buildFn: ((signal: AbortSignal) => Promise<RepovineRuntime>) | undefined;

  /**
   * Begin a build. Returns the same promise on repeated calls so callers can await readiness.
   * `buildFn` receives an `AbortSignal`; `cancel()` aborts it to stop the in-flight build.
   */
  start(buildFn: (signal: AbortSignal) => Promise<RepovineRuntime>): Promise<RepovineRuntime> {
    if (this.promise) return this.promise;
    this.buildFn = buildFn;
    this.stage = 'stage1';
    this.startedAt = Date.now();
    this.lastStageStartedAt = this.startedAt;
    this.cancelRequested = false;
    this.abortController = new AbortController();
    const prevCtx = this.ctx;
    this.promise = buildFn(this.abortController.signal)
      .then(ctx => {
        this.ctx = ctx;
        this.stage = 'ready';
        this.abortController = undefined;
        return ctx;
      })
      .catch(err => {
        // Cooperative cancel: a `cancel()` aborted this build. Distinguished by the
        // `cancelRequested` flag, not the thrown error type — Stage 1/3 raise whatever the
        // abort surfaces (a wrapped facts-snapshot error, an AbortError, etc.).
        if (this.cancelRequested) {
          this.abortController = undefined;
          if (prevCtx) {
            // Option A: a prior ready graph exists (e.g. a controller-driven rebuild). Keep it.
            this.ctx = prevCtx;
            this.stage = 'ready';
            this.promise = Promise.resolve(prevCtx);
            return prevCtx;
          }
          // Cold first build, no reusable graph: terminal `cancelled` (bare tree). Clear the
          // promise so a later start() can run a fresh build from cancelled.
          this.ctx = undefined;
          this.stage = 'cancelled';
          this.promise = undefined;
          return undefined as unknown as RepovineRuntime;
        }
        this.stage = 'failed';
        this.errorMessage = (err as Error).message;
        this.abortController = undefined;
        throw err;
      });
    return this.promise;
  }

  /**
   * Cooperatively cancel the in-flight startup build. No-op (returns the current snapshot) when
   * the controller is already ready/failed/cancelled or no build is running. Otherwise aborts the
   * build — Stage 1 stops where it stands (every worker thread is asked to shut down and
   * force-terminated after a few seconds' grace, so packages still extracting are dropped and the
   * work already done on them is discarded), Stage 3 stops at the next embed batch — and resolves
   * to the post-cancel snapshot (Option A: prior ready graph kept, else terminal `cancelled`).
   */
  async cancel(): Promise<IndexBuildStatus> {
    if (
      this.stage === 'ready' ||
      this.stage === 'failed' ||
      this.stage === 'cancelled' ||
      !this.promise
    ) {
      return this.snapshot();
    }
    this.cancelRequested = true;
    const inflight = this.promise;
    this.abortController?.abort();
    await inflight.catch(() => undefined);
    return this.snapshot();
  }

  /**
   * Re-trigger a fresh build after a cancel. Reachable from `cancelled` only — reuses the build
   * function captured by the first start(), so the whole cancel→rebuild cycle stays inside MCP
   * tools (no process restart). Returns immediately with the `building` snapshot; the build runs in
   * the background like the cold startup. A no-op returning the current snapshot in any other state.
   */
  rebuild(): IndexBuildStatus {
    if (this.stage === 'cancelled' && this.buildFn) {
      // cancel() cleared this.promise, so start() runs instead of returning the prior promise.
      this.start(this.buildFn).catch(() => undefined);
    }
    return this.snapshot();
  }

  /** Move into the next pipeline phase. */
  onStageEnter(stage: 'stage1' | 'stage2' | 'stage3'): void {
    this.stage = stage;
    this.lastStageStartedAt = Date.now();
    if (stage === 'stage3') {
      this.doneSemanticCards = 0;
      this.totalSemanticCards = 0;
      this.semanticEmbedStartedAt = 0;
    }
  }

  /** Called once at the start of stage 1 extraction to seed totals. */
  onExtractionBegin(totals: { totalPackages: number; totalModules: number }): void {
    this.totalPackages = totals.totalPackages;
    this.totalModules = totals.totalModules;
    this.donePackages = 0;
    this.doneModules = 0;
  }

  /** Called by stage 1 after each package completes. */
  onPackageDone(pkgName: string, pkgModules: number): void {
    this.donePackages += 1;
    this.doneModules += pkgModules;
    this.currentPackage = pkgName;
  }

  /** Called during stage 3 while semantic node cards are embedded. */
  onSemanticEmbedProgress(done: number, total: number): void {
    if (total <= 0) return;
    if (this.semanticEmbedStartedAt === 0) this.semanticEmbedStartedAt = Date.now();
    this.doneSemanticCards = done;
    this.totalSemanticCards = total;
  }

  /**
   * Long-poll: wait up to `maxWaitSec` for the build to settle (ready or failed),
   * returning the snapshot the moment it does — or the current building snapshot on
   * timeout. Never rejects; a failed build resolves to the `failed` snapshot. Lets
   * `get_build_status({ waitSec })` replace client-side polling loops with one
   * server-side wait.
   */
  async waitForSettled(maxWaitSec: number, signal?: AbortSignal): Promise<IndexBuildStatus> {
    if (!this.promise || this.stage === 'ready' || this.stage === 'failed' || this.stage === 'cancelled') {
      return this.snapshot();
    }
    if (signal?.aborted) return this.snapshot();
    const settled = this.promise.then(() => undefined, () => undefined);
    await Promise.race([
      settled,
      new Promise<void>(resolve => {
        const timer = setTimeout(resolve, maxWaitSec * 1000);
        timer.unref?.();
        // Client cancelled the long-poll: stop waiting and return the current snapshot promptly.
        signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      }),
    ]);
    return this.snapshot();
  }

  isReady(): boolean {
    return this.stage === 'ready' && this.ctx !== undefined;
  }

  isFailed(): boolean {
    return this.stage === 'failed';
  }

  isCancelled(): boolean {
    return this.stage === 'cancelled';
  }

  /** Get the RepovineRuntime when ready; returns undefined while building. */
  getCtx(): RepovineRuntime | undefined {
    return this.ctx;
  }

  /** Replace the ready runtime, used by refresh_context({ reloadConfig: true }). */
  replaceReadyContext(ctx: RepovineRuntime): void {
    this.ctx = ctx;
    this.stage = 'ready';
    this.promise = Promise.resolve(ctx);
    this.errorMessage = undefined;
    this.cancelRequested = false;
    this.abortController = undefined;
    this.donePackages = 0;
    this.totalPackages = 0;
    this.doneModules = 0;
    this.totalModules = 0;
    this.currentPackage = undefined;
    this.doneSemanticCards = 0;
    this.totalSemanticCards = 0;
    this.semanticEmbedStartedAt = 0;
    this.lastStageStartedAt = Date.now();
  }

  /** Snapshot the current status for clients to read or display. */
  snapshot(): IndexBuildStatus {
    if (this.stage === 'ready') {
      return {
        status: 'ready',
        stage: 'ready',
        retryAfterSec: 0,
        message: 'Graph is ready.',
      };
    }
    if (this.stage === 'failed') {
      return {
        status: 'failed',
        stage: 'failed',
        retryAfterSec: 0,
        message: `Build failed: ${this.errorMessage ?? 'unknown error'}`,
        errorMessage: this.errorMessage,
      };
    }
    if (this.stage === 'cancelled') {
      return {
        status: 'cancelled',
        stage: 'cancelled',
        retryAfterSec: 0,
        message:
          'Build cancelled; the graph is not built. Trigger a rebuild with refresh_context, '
          + 'or run `repovine build` and restart the server, or fall back to direct file reads.',
      };
    }
    if (this.stage === 'pending') {
      return {
        status: 'pending',
        stage: 'pending',
        retryAfterSec: 5,
        message: 'Build has not started yet.',
      };
    }

    const elapsedSec = Math.round((Date.now() - this.startedAt) / 1000);
    let pct: number | undefined;
    let stageEtaSec: number | undefined;
    if (this.stage === 'stage1' && this.totalModules > 0) {
      pct = Math.round((this.doneModules / this.totalModules) * 100);
      if (this.doneModules > 0 && elapsedSec > 0) {
        const rate = this.doneModules / elapsedSec;
        if (rate > 0) stageEtaSec = Math.round((this.totalModules - this.doneModules) / rate);
      }
    } else if (this.stage === 'stage3' && this.totalSemanticCards > 0) {
      pct = Math.round((this.doneSemanticCards / this.totalSemanticCards) * 100);
      const embedElapsedSec = Math.max(1, Math.round((Date.now() - this.semanticEmbedStartedAt) / 1000));
      if (this.doneSemanticCards > 0) {
        const rate = this.doneSemanticCards / embedElapsedSec;
        if (rate > 0) stageEtaSec = Math.round((this.totalSemanticCards - this.doneSemanticCards) / rate);
      }
    } else if (this.stage === 'stage2') {
      pct = undefined;
    }

    const retryAfterSec = Math.min(30, Math.max(2, Math.ceil((stageEtaSec ?? 30) / 4)));
    const remainingStages = this.stage === 'stage1' ? 2 : this.stage === 'stage2' ? 1 : 0;
    const stageLabel: Record<IndexBuildStage, string> = {
      pending: 'pending',
      stage1: 'repository facts snapshot',
      stage2: 'repository graph',
      stage3: this.totalSemanticCards > 0 ? 'semantic search embeddings' : 'annotations',
      ready: 'ready',
      failed: 'failed',
      cancelled: 'cancelled',
    };
    const parts: string[] = [`Building ${stageLabel[this.stage]}`];
    if (this.stage === 'stage1' && this.totalPackages > 0) {
      parts.push(`[${this.donePackages}/${this.totalPackages} pkgs]`);
    }
    if (this.stage === 'stage3' && this.totalSemanticCards > 0) {
      parts.push(`[${this.doneSemanticCards}/${this.totalSemanticCards} cards]`);
    }
    if (stageEtaSec !== undefined) parts.push(`stage ETA ~${formatDuration(stageEtaSec)}`);
    const message = parts.join(' ');

    return {
      status: 'building',
      stage: this.stage,
      doneModules: this.totalModules > 0 ? this.doneModules : undefined,
      totalModules: this.totalModules > 0 ? this.totalModules : undefined,
      donePackages: this.totalPackages > 0 ? this.donePackages : undefined,
      totalPackages: this.totalPackages > 0 ? this.totalPackages : undefined,
      currentPackage: this.currentPackage,
      doneSemanticCards: this.totalSemanticCards > 0 ? this.doneSemanticCards : undefined,
      totalSemanticCards: this.totalSemanticCards > 0 ? this.totalSemanticCards : undefined,
      pct,
      elapsedSec,
      stageEtaSec,
      remainingStages,
      retryAfterSec,
      message,
    };
  }
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}
