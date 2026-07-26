import { collectRepositoryFactsAsync } from '../stage1/index.js';
import { createFileCache, snapshotContentFingerprint, type SnapshotCache } from '../stage1/cache.js';
import { composeRepositoryGraph, composeRepositoryGraphAsync } from '../stage2/index.js';
import { loadDomainsConfig } from '../stage2/domains.js';
import { computeDomainsSuggestion } from '../stage2/domains-advisor.js';
import { hasLinkingConfig } from '../stage1/linking-config.js';
import { graphStats } from '../graph/index.js';
import { AnnotationStore } from '../annotations/store.js';
import type { ModuleInfo, RepositoryGraph, StoredAnnotation, RepositoryFactsSnapshot } from '../types.js';
import type { RepovineState, SemanticSearchRefresh } from './types.js';
import { buildTokenIndex } from './lib/search-index.js';
import { semanticSearchRefreshFromSync } from './lib/refresh-summary.js';
import { createEmbedder } from '../semantic/embedder.js';
import { projectNodeCards } from '../semantic/cards.js';
import { SemanticIndex, semanticIndexFilePath } from '../semantic/store.js';
import { describeTransformersInstall } from '../semantic/transformers-install.js';
import type { ResolvedConfig } from '../config.js';
import { DEFAULT_EMBEDDING_BATCH_SIZE } from '../config.js';
import { DEFAULT_THRESHOLDS, type RefactoringThresholds } from '../analysis/architecture/config.js';
import { ANNOTATIONS_FILENAME, cacheDirFor } from '../paths.js';
import { readDeclinedDomainsSuggestions, writeOnboardingState } from './onboarding-state.js';
import { writeBoundaryIndex } from './boundary-index.js';
import { MemoryProfiler } from '../perf/memory-profiler.js';
import {
  formatPipelineDetail,
  formatPipelineStage,
  formatPipelineStageDone,
  formatSemanticEmbedProgressLine,
  logPipeline,
  logPipelineProgress,
  logPipelineProgressEnd,
} from '../cli/ui.js';

export interface RepovineRuntimeOptions {
  /** Full rescan: do not load or write repository-facts-snapshot.json (used by npm run profile). */
  coldSnapshot?: boolean;
  /** Optional hooks for observing pipeline progress (used by lazy MCP build controller). */
  hooks?: import('./build-controller.js').BuildHooks;
  /** Cooperative-cancel signal for the startup build (threaded into Stage 1 and Stage 3). */
  signal?: AbortSignal;
}

type RefreshStats = {
  before: { totalNodes: number; totalEdges: number };
  after: { totalNodes: number; totalEdges: number };
};

export class RepovineRuntime {
  private state!: RepovineState;
  private readonly repoRoot: string;
  private readonly artifactsDir: string;
  private readonly annotationsFile: string;
  private readonly cache: SnapshotCache;
  private readonly coldSnapshot: boolean;
  private readonly scanConfig: ResolvedConfig['build']['scan'];
  private readonly linkingConfig: ResolvedConfig['build']['linking'];
  private readonly pluginsConfig: ResolvedConfig['plugins'];
  private readonly semanticSearchEmbeddingsEnabled: boolean;
  private readonly refactoringThresholds: RefactoringThresholds;
  private readonly hooks: import('./build-controller.js').BuildHooks | undefined;
  private readonly signal: AbortSignal | undefined;
  private previousSnapshot: RepositoryFactsSnapshot | null = null;
  /** Fingerprint of the snapshot currently on disk; the dirty-skip guard avoids rewriting it unchanged. */
  private persistedSnapshotFingerprint: string | null = null;
  private refreshCallbacks: Array<() => void> = [];
  /** Shared by concurrent refresh callers so only one graph/cache rebuild mutates runtime state. */
  private refreshInFlight: Promise<RefreshStats> | undefined;
  /** Per in-flight refresh build: aborted only when EVERY attached request has cancelled (refcount),
   *  so one client's cancel cannot kill a rebuild another client is still awaiting. */
  private refreshAbort: AbortController | undefined;
  /** A caller with no signal keeps the in-flight refresh uncancellable regardless of others' cancels. */
  private refreshUnconditional = false;
  /** Live (not-yet-aborted) request signals attached to the in-flight refresh. */
  private readonly refreshWaiters = new Set<AbortSignal>();
  /** The refresh build's effective cancel signal, consulted by activeSignal(true) during that build. */
  private refreshBuildSignal: AbortSignal | undefined;
  /**
   * The single annotation store for this runtime, kept across refreshes. A refresh re-reads disk into it
   * rather than constructing a new store, so no orphaned debounce timer survives a swap to clobber or
   * resurrect records, and disk/active state cannot diverge.
   */
  private annotationStore: AnnotationStore | null = null;

  private constructor(repoRoot: string, artifactsDir: string, config?: ResolvedConfig, options?: RepovineRuntimeOptions) {
    this.repoRoot = repoRoot;
    this.artifactsDir = artifactsDir;
    this.annotationsFile = config?.workspace.annotationsFile ?? ANNOTATIONS_FILENAME;
    // Per-instance cache derived from THIS context's artifactsDir — never the process-global
    // `cacheDir` const. Otherwise a context built for a fixture/sub-repo writes its snapshot cache
    // into the workspace root's .repovine/.cache, clobbering it (see paths.cacheDirFor).
    this.cache = createFileCache(cacheDirFor(artifactsDir), repoRoot);
    this.coldSnapshot = options?.coldSnapshot ?? false;
    this.scanConfig = config?.build.scan ?? {
      include: [],
      exclude: [],
      maxPackageWorkers: undefined,
    };
    this.linkingConfig = config?.build.linking ?? {
      handlers: { searchRoots: [] },
      bundles: { scripts: [], autoDetect: true },
      containers: { dockerfileRoots: [] },
    };
    this.pluginsConfig = config?.plugins ?? { defaults: true, add: [], disable: [] };
    // Falling back to `true` here would re-enable embeddings for a runtime constructed without a
    // resolved config, defeating the peer-derived default that loadConfig computes.
    this.semanticSearchEmbeddingsEnabled = config?.semanticSearchEmbeddings
      ?? describeTransformersInstall(repoRoot).resolved;
    this.refactoringThresholds = config?.analyze_architecture?.thresholds ?? DEFAULT_THRESHOLDS;
    this.hooks = options?.hooks;
    this.signal = options?.signal;
  }

  /** Startup builds use the constructor signal; refresh builds use a per-request refcounted signal
   *  wired by refreshOnce (undefined ⇒ uncancellable, the historical behavior). Refresh is
   *  single-flight, so at most one build signal is active at a time. */
  private activeSignal(suppressBuildHooks: boolean): AbortSignal | undefined {
    return suppressBuildHooks ? this.refreshBuildSignal : this.signal;
  }

  onRefresh(cb: () => void): void {
    this.refreshCallbacks.push(cb);
  }

  /** Async factory — preferred for MCP server startup. */
  static async create(
    repoRoot: string,
    artifactsDir: string,
    config?: ResolvedConfig,
    options?: RepovineRuntimeOptions,
  ): Promise<RepovineRuntime> {
    const ctx = new RepovineRuntime(repoRoot, artifactsDir, config, options);
    if (!ctx.coldSnapshot) {
      ctx.previousSnapshot = await ctx.cache.loadAsync();
      if (ctx.previousSnapshot) {
        ctx.persistedSnapshotFingerprint = snapshotContentFingerprint(ctx.previousSnapshot);
      }
    }
    ctx.state = await ctx.buildStateAsync(false);
    return ctx;
  }

  getState(): RepovineState {
    return this.state;
  }

  refresh(signal?: AbortSignal): Promise<RefreshStats> {
    if (this.refreshInFlight) {
      this.attachRefreshCanceller(signal);
      return this.refreshInFlight;
    }
    this.refreshAbort = new AbortController();
    this.refreshUnconditional = false;
    this.refreshWaiters.clear();
    this.attachRefreshCanceller(signal);
    const refresh = this.refreshOnce(this.refreshAbort.signal);
    const tracked = refresh.finally(() => {
      if (this.refreshInFlight === tracked) {
        this.refreshInFlight = undefined;
        this.refreshAbort = undefined;
        this.refreshUnconditional = false;
        this.refreshWaiters.clear();
      }
    });
    this.refreshInFlight = tracked;
    return tracked;
  }

  /** Shutdown path: force-abort any in-flight refresh build, bypassing the caller refcount (at
   *  shutdown nobody gets the result, so an unconditional caller must not keep the pool alive).
   *  Resolves once the build settles — its `finally` has run `pool.destroy()`, so worker isolates
   *  have reaped their python children. No-op when idle. */
  async abortActiveRefresh(): Promise<void> {
    const inFlight = this.refreshInFlight;
    if (!inFlight) return;
    this.refreshAbort?.abort();
    await inFlight.then(() => undefined, () => undefined);
  }

  /** Track a caller's interest in the current refresh build. A caller with no signal keeps the build
   *  uncancellable; a caller with a live signal joins the refcount, and the build aborts only once
   *  every such caller has cancelled (so one client's Esc cannot kill another's rebuild). */
  private attachRefreshCanceller(signal?: AbortSignal): void {
    if (!signal) { this.refreshUnconditional = true; return; }
    if (signal.aborted) {
      // An already-cancelled sole caller must not silently run an uncancellable build: if nobody else
      // wants it (no unconditional caller, no live waiters), abort the fresh build now.
      const controller = this.refreshAbort;
      if (controller && !this.refreshUnconditional && this.refreshWaiters.size === 0) controller.abort();
      return;
    }
    const controller = this.refreshAbort;
    if (!controller) return;
    this.refreshWaiters.add(signal);
    signal.addEventListener('abort', () => {
      if (this.refreshAbort !== controller) return; // a later build already replaced this one
      this.refreshWaiters.delete(signal);
      if (!this.refreshUnconditional && this.refreshWaiters.size === 0) controller.abort();
    }, { once: true });
  }

  private async refreshOnce(signal?: AbortSignal): Promise<RefreshStats> {
    const before = graphStats(this.state.graph);
    this.previousSnapshot = this.state.snapshot;
    this.refreshBuildSignal = signal;
    let next: RepovineState;
    try {
      next = await this.buildStateAsync(true);
    } finally {
      this.refreshBuildSignal = undefined;
    }
    // Refuse to publish a build every attached caller has cancelled. `signal` is the refcounted
    // refreshAbort.signal (aborted only when all callers cancelled), so no still-waiting client loses
    // a finished build. buildStateAsync can complete before an abort lands at an internal checkpoint,
    // so this final gate is what preserves the ready graph on a late cancel — no partial swap.
    signal?.throwIfAborted();
    this.state = next;
    const after = graphStats(this.state.graph);
    for (const cb of this.refreshCallbacks) {
      try { cb(); } catch (e) { console.error('[ui] refresh callback error:', (e as Error).message); }
    }
    return { before, after };
  }

  private buildSnapshotOptions(suppressBuildHooks: boolean) {
    const hooks = suppressBuildHooks ? undefined : this.hooks;
    const progress = hooks
      ? {
          begin: (totals: { totalPackages: number; totalModules: number }) => { try { hooks.onExtractionBegin?.(totals); } catch { /* observer */ } },
          packageDone: (pkg: string, mods: number) => { try { hooks.onPackageDone?.(pkg, mods); } catch { /* observer */ } },
        }
      : undefined;
    return {
      previousSnapshot: this.coldSnapshot ? undefined : this.previousSnapshot ?? undefined,
      scanInclude: this.scanConfig.include.length > 0 ? this.scanConfig.include : undefined,
      scanExclude: this.scanConfig.exclude.length > 0 ? this.scanConfig.exclude : undefined,
      linking: hasLinkingConfig({
        handlers: { searchRoots: this.linkingConfig.handlers.searchRoots },
        bundles: {
          scripts: this.linkingConfig.bundles.scripts,
          autoDetect: this.linkingConfig.bundles.autoDetect,
        },
        containers: { dockerfileRoots: this.linkingConfig.containers.dockerfileRoots },
      }) ? {
        handlers: { searchRoots: this.linkingConfig.handlers.searchRoots },
        bundles: {
          scripts: this.linkingConfig.bundles.scripts,
          autoDetect: this.linkingConfig.bundles.autoDetect,
        },
        containers: { dockerfileRoots: this.linkingConfig.containers.dockerfileRoots },
      } : undefined,
      maxPackageWorkers: this.scanConfig.maxPackageWorkers,
      progress,
      signal: this.activeSignal(suppressBuildHooks),
      // Only run the external-plugin loader when the config asks for something non-default
      // (added/disabled plugins, or the preset turned off). The bundled-only common case keeps the
      // existing fast path — the registry already holds the preset via bootstrap.
      plugins: this.pluginsHaveWork() ? this.pluginsConfig : undefined,
    };
  }

  /** True when `config.plugins` requires the loader (third-party adds, disables, or preset off). */
  private pluginsHaveWork(): boolean {
    return (
      this.pluginsConfig.defaults === false ||
      this.pluginsConfig.add.length > 0 ||
      this.pluginsConfig.disable.length > 0
    );
  }

  private async collectSnapshotAndGraphAsync(suppressBuildHooks: boolean) {
    const profiler = MemoryProfiler.ensure();
    profiler.reset(); // singleton persists across refreshes; drop prior phases so this build stays bounded
    profiler.phase('pipeline:start');
    let snapshot: RepositoryFactsSnapshot;
    try {
      logPipeline(formatPipelineStage('Stage 1: Repository facts snapshot...'));
      this.notifyStageEnter('stage1', suppressBuildHooks);
      snapshot = await collectRepositoryFactsAsync(this.repoRoot, this.buildSnapshotOptions(suppressBuildHooks));
    } catch (e) {
      // A cooperative cancel (aborted refresh/startup) is not a failure — re-throw quietly so a
      // cancelled build does not log a misleading FATAL.
      if (this.activeSignal(suppressBuildHooks)?.aborted) throw e;
      const msg = (e as Error).message;
      console.error(`[FATAL] Stage 1 (repository facts snapshot) failed: ${msg}`);
      throw new Error(`Repository facts snapshot failed: ${msg}`);
    }
    // Cancel checkpoint between Stage 1 and Stage 2: abort before composeRepositoryGraph runs and
    // before the snapshot is persisted, so a cancelled build leaves the prior cache untouched.
    this.activeSignal(suppressBuildHooks)?.throwIfAborted();
    return this.finalizeSnapshotAndGraph(snapshot, profiler, suppressBuildHooks);
  }

  private async finalizeSnapshotAndGraph(
    snapshot: RepositoryFactsSnapshot,
    profiler: MemoryProfiler,
    suppressBuildHooks: boolean,
  ) {
    if (this.coldSnapshot) {
      profiler.setCounter('snapshotCacheJsonBytes', profiler.measureJsonBytes(snapshot));
    } else {
      const fingerprint = snapshotContentFingerprint(snapshot);
      if (fingerprint === this.persistedSnapshotFingerprint && this.cache.exists()) {
        // Dirty-skip: the on-disk snapshot already holds this exact content (the refresh changed
        // nothing graph-relevant). Skip the serialize + write entirely — the common case during an
        // editing session, where refresh_context fires after edits that do not change the graph.
        profiler.phase('cache:skip-unchanged');
      } else {
        try {
          profiler.phase('cache:before-save');
          await this.cache.saveAsync(snapshot);
          this.persistedSnapshotFingerprint = fingerprint;
          profiler.phase('cache:after-save');
        } catch (e) {
          console.error(`[WARN] Failed to save snapshot cache: ${(e as Error).message}`);
        }
      }
    }
    this.previousSnapshot = snapshot;

    const modulesById = new Map<string, ModuleInfo>();
    for (const m of snapshot.modules) modulesById.set(m.id, m);

    let graph: ReturnType<typeof composeRepositoryGraph>;
    const stage2T0 = Date.now();
    try {
      logPipeline(formatPipelineStage('Stage 2: repovine repository graph...'));
      this.notifyStageEnter('stage2', suppressBuildHooks);
      profiler.phase('stage2:start');
      // Offloaded to a worker so Stage 2 does not block the MCP control plane; falls back to inline.
      // The signal terminates the worker on cancel so the work actually stops, not just its publication.
      graph = await composeRepositoryGraphAsync(snapshot, modulesById, this.activeSignal(suppressBuildHooks));
      profiler.phase('stage2:complete');
    } catch (e) {
      // A cooperative cancel during Stage 2 is not a failure — re-throw quietly (no FATAL).
      if (this.activeSignal(suppressBuildHooks)?.aborted) throw e;
      const msg = (e as Error).message;
      console.error(`[FATAL] Stage 2 (repository graph) failed: ${msg}`);
      throw new Error(`Repository graph build failed: ${msg}`);
    }
    // Cancel checkpoint after Stage 2: an abort that landed during compose (worker terminated) must
    // not proceed to Stage 3 or its side-effect writes (onboarding state / boundary index).
    this.activeSignal(suppressBuildHooks)?.throwIfAborted();

    const stats = graphStats(graph);
    profiler.setCounter('graphNodes', stats.totalNodes);
    profiler.setCounter('graphEdges', stats.totalEdges);
    profiler.phase('stage2:done');
    // logSummary is emitted at the end of buildStateAsync, after the last setCounter (searchIndexTokens
    // in Stage 3), so the summary reports this build's token count rather than the prior build's.

    logPipeline(formatPipelineStageDone(`  Stage 2 DONE in ${((Date.now() - stage2T0) / 1000).toFixed(1)}s — ${stats.totalNodes} nodes, ${stats.totalEdges} edges`));
    return { snapshot, modulesById, graph };
  }

  /**
   * First build creates the store; a refresh reuses it and re-reads disk. Reusing the instance keeps the
   * single debounce timer, so a pending write cannot be orphaned by the state swap (fixes write-vs-refresh
   * divergence and cleanup-orphans resurrection).
   */
  private async loadOrReloadAnnotations(signal?: AbortSignal): Promise<AnnotationStore> {
    if (this.annotationStore) {
      await this.annotationStore.reloadFromDisk({ signal });
      return this.annotationStore;
    }
    this.annotationStore = await AnnotationStore.create(this.repoRoot, this.annotationsFile);
    return this.annotationStore;
  }

  private async buildStateAsync(suppressBuildHooks: boolean): Promise<RepovineState> {
    const { snapshot, modulesById, graph } = await this.collectSnapshotAndGraphAsync(suppressBuildHooks);
    logPipeline(formatPipelineStage('Stage 3: Loading annotations...'));
    this.notifyStageEnter('stage3', suppressBuildHooks);
    const stage3T0 = Date.now();
    // Cancel checkpoint entering Stage 3: a build cancelled by now must not mutate the annotation store
    // (migration schedules a save) or write the semantic index below for a graph refreshOnce won't publish.
    this.activeSignal(suppressBuildHooks)?.throwIfAborted();
    const annotations = await this.loadOrReloadAnnotations(this.activeSignal(suppressBuildHooks));
    // Re-check after the await: an abort that landed DURING the store load/reload must not run the
    // migration below (it schedules a debounced save on the SHARED store — durable state the
    // refreshOnce final gate cannot undo).
    this.activeSignal(suppressBuildHooks)?.throwIfAborted();
    const migrated = annotations.migrateServiceAnnotationHashesFromParentTemplate(graph, snapshot);
    if (migrated > 0) {
      logPipeline(formatPipelineDetail(`  Annotation store: migrated ${migrated} service hash(es) to per-resource scheme`));
    }
    const domainsConfig = loadDomainsConfig(this.repoRoot);
    const declinedDomainsSuggestions = readDeclinedDomainsSuggestions(this.repoRoot);
    const domainsSuggestions = computeDomainsSuggestion(snapshot, graph, undefined, declinedDomainsSuggestions);

    // The token index is built AFTER annotations load on purpose: annotation text
    // (summaries, keyExports, risks) is the natural-language bridge for fuzzy queries.
    const annotationsData = annotations.getAll();
    const searchIndex = buildTokenIndex(graph, annotationsData);
    MemoryProfiler.ensure().setCounter('searchIndexTokens', searchIndex.tokens.size);

    // Cancel checkpoint before the semantic index write: skip persisting embeddings for a cancelled build.
    // A cancel landing mid-embedding is caught between batches; the index is a hash-validated cache either
    // way, so a late persist is a cache write, not a wrong published graph.
    this.activeSignal(suppressBuildHooks)?.throwIfAborted();
    const { index: semanticIndex, refresh: semanticSearchRefresh } =
      await this.syncSemanticIndexAsync(graph, modulesById, annotationsData, suppressBuildHooks);

    // Emit the profile summary here — after searchIndexTokens (the last counter) and the semantic sync —
    // so it reports this build's counters and peak heap includes embedding, not the prior build's numbers.
    const profiler = MemoryProfiler.ensure();
    profiler.phase('pipeline:complete');
    profiler.logSummary();

    const builtAt = new Date().toISOString();
    logPipeline(formatPipelineStageDone(`  Stage 3 DONE in ${((Date.now() - stage3T0) / 1000).toFixed(1)}s — ${Object.keys(annotationsData).length} annotated nodes, ${searchIndex.tokens.size} search tokens`));
    const state: RepovineState = {
      graph, snapshot, modulesById, searchIndex, semanticIndex, semanticSearchRefresh,
      annotations, domainsConfig, domainsSuggestions, refactoringThresholds: this.refactoringThresholds, builtAt,
    };
    // Cancel checkpoint before side effects: an abort during Stage 3 must not write the onboarding
    // state / boundary index for a build that refreshOnce will refuse to publish.
    this.activeSignal(suppressBuildHooks)?.throwIfAborted();
    writeOnboardingState(this.repoRoot, state, { declined: declinedDomainsSuggestions });
    writeBoundaryIndex(this.repoRoot, state);
    return state;
  }

  /**
   * Build/refresh the local embedding index over node cards. Runs on every state
   * build, so refresh_context updates embeddings too. Only changed cards are
   * re-embedded (card-text hash diff). Embedder failures degrade gracefully: the
   * previously persisted vectors keep serving and a warning is logged.
   */
  private async syncSemanticIndexAsync(
    graph: RepositoryGraph,
    modulesById: Map<string, ModuleInfo>,
    annotationsData: Record<string, StoredAnnotation>,
    suppressBuildHooks: boolean,
  ): Promise<{ index: SemanticIndex | null; refresh: SemanticSearchRefresh }> {
    // repoRoot, not cwd: under npx the engine runs from the npx cache, and the opt-in
    // `@huggingface/transformers` lives in the workspace being analyzed.
    const embedder = createEmbedder(this.semanticSearchEmbeddingsEnabled, this.repoRoot);
    if (!embedder) {
      return { index: null, refresh: semanticSearchRefreshFromSync(null, { enabled: false }) };
    }
    const filePath = semanticIndexFilePath(cacheDirFor(this.artifactsDir));
    const index = await SemanticIndex.load(filePath, embedder, DEFAULT_EMBEDDING_BATCH_SIZE);
    const cards = projectNodeCards(graph, modulesById, annotationsData);
    try {
      const pendingEmbed = index.countPendingEmbed(cards);
      if (pendingEmbed === 0) {
        const report = await index.sync(cards);
        if (report.removed > 0) {
          logPipeline(formatPipelineDetail(
            `  Semantic search index (${embedder.id}): pruned ${report.removed} stale node(s); ${report.total} remaining`,
          ));
        } else {
          logPipeline(formatPipelineDetail(
            `  Semantic search index (${embedder.id}): up to date (${report.total} nodes)`,
          ));
        }
        return { index, refresh: semanticSearchRefreshFromSync(report) };
      }

      const t0 = Date.now();
      // Warm up ONNX/transformers before the in-place progress bar so library stderr
      // does not print mid-line and break \r rendering.
      await embedder.embed(['repovine semantic warmup']);
      const report = await index.sync(cards, {
        onProgress: (done, total) => {
          if (total <= 0) return;
          // Cancel checkpoint between embed batches. A single embedder.embed(batch) is not interrupted.
          this.activeSignal(suppressBuildHooks)?.throwIfAborted();
          if (!suppressBuildHooks) {
            try { this.hooks?.onSemanticEmbedProgress?.(done, total); } catch { /* observer */ }
          }
          logPipelineProgress(formatSemanticEmbedProgressLine(done, total, Date.now() - t0));
        },
      });
      logPipelineProgressEnd();
      if (report.embedded > 0 || report.removed > 0) {
        logPipeline(formatPipelineDetail(`  Semantic search index (${embedder.id}): ${report.embedded} embedded, ${report.reused} reused, ${report.removed} removed in ${((Date.now() - t0) / 1000).toFixed(1)}s`));
      } else {
        logPipeline(formatPipelineDetail(`  Semantic search index (${embedder.id}): up to date (${report.total} nodes)`));
      }
      return { index, refresh: semanticSearchRefreshFromSync(report) };
    } catch (e) {
      logPipelineProgressEnd();
      // A cancel during embedding is not a degradable embedder failure: propagate it so the
      // controller transitions to cancelled instead of completing the build with partial vectors.
      if (this.activeSignal(suppressBuildHooks)?.aborted) throw e;
      const message = (e as Error).message;
      console.error(`[WARN] Semantic search index sync failed (${embedder.id}): ${message} — serving ${index.size} previously cached vector(s); token search unaffected`);
      return {
        index,
        refresh: semanticSearchRefreshFromSync(null, { enabled: true, error: message, cachedTotal: index.size }),
      };
    }
  }

  private notifyStageEnter(stage: 'stage1' | 'stage2' | 'stage3', suppressBuildHooks: boolean): void {
    if (suppressBuildHooks) return;
    try { this.hooks?.onStageEnter?.(stage); } catch { /* observer */ }
  }
}
