import * as path from 'node:path';
import { availableParallelism } from 'node:os';
import type { RepositoryFactsSnapshot, PackageInfo, ModuleInfo, PendingModule } from '../types.js';
import { ARTIFACTS_DIR_NAME, cacheDirFor } from '../paths.js';
import { collectInfraModules } from './infra.js';
import { collectTemplates } from './templates.js';
import { loadBundleOutputHandlerMap } from '../stage2/bundle-output-loader.js';
import { hasLinkingConfig, normalizeLinkingConfig } from './linking-config.js';
import { compileScanPatterns, shouldScanSourcePath, type ScanPatternInput } from '../scan-filters.js';
import { isPathInsideRepo } from '../fs/containment.js';
import { MemoryProfiler } from '../perf/memory-profiler.js';
import { formatPackageProgressLine, formatPipelineDetail, formatPipelineStageDone, logPipeline, logPipelineProgress, logPipelineProgressEnd, logPipelineWarn } from '../cli/ui.js';
import { makeModuleId, modulePathResolverPriority, extractPackageName, packageJobKey } from './utils.js';
import { PackageWorkerPool, chooseWorkerCount, effectiveTotalMemBytes, type PackageJob, type PackageJobResult } from './worker-pool.js';
import {
  adviseFromCalibration,
  isRepresentativeCalibrationRun,
  loadCalibration,
  saveCalibration,
} from './calibration.js';
import { getSourcePlugin, getSourcePlugins } from './source/registry.js';
import { runSourceExtraction } from './source/extract-runner.js';
import { applyPluginConfig, type PluginsConfigInput } from './plugin-loader.js';
import { currentEngineBuildId, engineBuildMatches } from './engine-build-id.js';
import { computeExtractionConfigFingerprint } from './extraction-config-fingerprint.js';
import {
  emptyPluginRuntime,
  pluginRuntimeIdentity,
  type PluginRuntime,
} from '../plugins/runtime.js';
import { rememberPluginRuntime } from '../plugins/runtime-store.js';
import type { DeclarationCatalog } from '../plugins/declaration-catalog.js';
import { getRegisteredIaCPluginIds } from './iac/registry.js';
import type { SourceDiscoveryOptions, SourcePlugin } from '@repovine/plugin-sdk';
// Side-effect: register built-in source plugins (typescript, …) before discovery runs.
import './source/bootstrap.js';
import { compareCodeUnits } from '../platform/ordering.js';
import { repoRelativePosix } from '../platform/paths.js';
import { packageNodeId } from '../graph/node-ids.js';
import { shortenList, omittedNote } from '../platform/text.js';
import { refusal, type Refusal } from '../response/refusal.js';
import {
  FILE_CLAIMED_TWICE_REFUSAL,
  OUTSIDE_WORKSPACE_REFUSAL,
  PLUGIN_UNLOADABLE_REFUSAL,
  SOURCE_PLUGIN_UNAVAILABLE_REFUSAL,
} from './refusal-kinds.js';

/** Schema version of the Stage 1 facts snapshot; a mismatch invalidates the on-disk cache.
 *  2: `ExportInfo.defaultLocalName` — a cached module extracted before it would still project no
 *  node for a named default export, so the shape change has to force a re-extract. The same bump
 *  covers the hint corrections that ship with it: `ssr.qwikServer`, `ui.framework` and
 *  `serviceWrapper.delegateCallCount` are now decided from the syntax tree, and `ui.framework`
 *  no longer infers Angular from a filename suffix. A module cached under version 1 can carry any
 *  of those set from prose or from its name alone. */
export const STAGE1_ANALYSIS_VERSION = 1;

interface PackageJobInputs {
  jobs: PackageJob[];
  modulesByPackage: Map<string, PendingModule[]>;
}

function pendingJobKey(pending: PendingModule): string {
  return packageJobKey({
    name: pending.pkg.name,
    path: pending.pkg.path,
    sourcePluginId: pending.sourcePluginId ?? pending.pkg.sourcePluginId,
  });
}

const DEFAULT_SHARD_TARGET_SIZE = 800;

/** How many refused paths the build log names before it falls back to a count. One directory link
 *  refuses everything beneath it, so the count is the number to act on. Matches the cap the MCP
 *  `outsideRepo` report uses, so both surfaces name the same set. */
const OUTSIDE_REPO_SAMPLE = 5;

/**
 * How the refused paths left the repository. A path spelled with a leading `..` was reached by a
 * scan or tsconfig entry pointing past the workspace root; one spelled inside the repository got out
 * through a link. Sending someone hunting for the wrong one wastes the report.
 */
function outsideRepoCause(paths: readonly string[]): string {
  const named = paths.filter(p => p.startsWith('../')).length;
  if (named === paths.length) return 'are named past the workspace root by the scan or tsconfig configuration';
  if (named === 0) return 'name an in-repo path but resolve outside the repository through a link';
  return `resolve outside the repository — ${named} named past the workspace root, ${paths.length - named} through a link`;
}

/**
 * The containment refusal, composed where the paths were refused. `refresh_context`,
 * `get_build_status` and `repovine status` republish this sentence rather than re-deriving a cause
 * from a path list that has already lost the context it was refused in.
 */
export function outsideRepoRefusal(paths: readonly string[]): Refusal {
  const { shown: sample, omitted } = shortenList(paths, OUTSIDE_REPO_SAMPLE);
  return refusal(
    'rejected-by-policy',
    OUTSIDE_WORKSPACE_REFUSAL,
    `${paths.length} file(s) ${outsideRepoCause(paths)}, `
    + `so they are absent from the graph: ${sample.join(', ')}${omittedNote(omitted)}. `
    + 'repovine indexes one workspace root (see docs/workspace-files.md).',
    // Sampled, not listed whole: one directory link refuses everything beneath it, and three
    // surfaces publish this array verbatim into a size-capped response.
    { count: paths.length, sample: [...sample] },
  );
}

/** Split a package's pendingModules into evenly sized shards. Stable per-module ordering
 * (relies on caller's order, which is filesystem-discovery order for cold scans and
 * preserved across reruns). Single shard when sharding would not produce at least two. */
export { packageJobKey } from './utils.js';

export function splitIntoShards(pendingModules: PendingModule[], shardTargetSize: number): PendingModule[][] {
  if (pendingModules.length < shardTargetSize * 2) return [pendingModules];
  const shardCount = Math.max(2, Math.ceil(pendingModules.length / shardTargetSize));
  const baseSize = Math.ceil(pendingModules.length / shardCount);
  const shards: PendingModule[][] = [];
  for (let i = 0; i < pendingModules.length; i += baseSize) {
    shards.push(pendingModules.slice(i, i + baseSize));
  }
  return shards;
}

export function buildPackageJobs(
  packages: PackageInfo[],
  pendingModules: PendingModule[],
  prevByPath: Map<string, ModuleInfo>,
  shardTargetSize: number,
): PackageJobInputs {
  const modulesByPackage = new Map<string, PendingModule[]>();
  for (const pending of pendingModules) {
    const key = pendingJobKey(pending);
    let list = modulesByPackage.get(key);
    if (!list) { list = []; modulesByPackage.set(key, list); }
    list.push(pending);
  }

  const jobs: PackageJob[] = [];
  // Some workspaces register the same (sourcePluginId, name, path) in `packages[]` more
  // than once (nested package roots etc.). Each pending module is uniquely owned by one
  // such pkg via dedup-on-filePath in Pass 1, but iterating duplicate package entries
  // would create duplicate shard jobs whose results then duplicate during merge. Track
  // already-scheduled job keys so each package entry produces shards exactly once.
  const scheduledJobKeys = new Set<string>();
  for (const pkg of packages) {
    const jobKey = packageJobKey(pkg);
    if (scheduledJobKeys.has(jobKey)) continue;
    const pkgModules = modulesByPackage.get(jobKey);
    if (!pkgModules || pkgModules.length === 0) continue;
    const sourcePluginId = pkg.sourcePluginId ?? pkgModules[0]!.sourcePluginId;
    if (!sourcePluginId) continue;
    scheduledJobKeys.add(jobKey);

    const shards = splitIntoShards(pkgModules, shardTargetSize);
    const totalShards = shards.length;
    for (let shardIndex = 0; shardIndex < totalShards; shardIndex++) {
      const shardModules = shards[shardIndex]!;
      const prevEntries: [string, ModuleInfo][] = [];
      for (const pm of shardModules) {
        const prev = prevByPath.get(pm.filePath);
        if (prev) prevEntries.push([pm.filePath, prev]);
      }
      jobs.push({
        pkg,
        sourcePluginId,
        pendingModules: shardModules,
        prevModuleEntries: prevEntries,
        shardIndex,
        totalShards,
      });
    }
  }
  return { jobs, modulesByPackage };
}

/** Merge per-shard results into the global module list, preserving `packages[]` order
 * across packages and `shardIndex` order within a package. Each package job key is merged
 * at most once even when `packages[]` contains duplicate entries (e.g. nested package roots),
 * since each module is already uniquely owned by one pkg via Pass 1 dedup.
 * Exported for the capability-first boundary guard (`test/laws/source-plugin-stamping.test.ts`),
 * which verifies the per-module `sourcePluginId` stamp directly. */
export function mergeResults(
  resultsByJobKey: Map<string, PackageJobResult[]>,
  packages: PackageInfo[],
  allModules: ModuleInfo[],
): { reused: number; rescanned: number } {
  let reused = 0;
  let rescanned = 0;
  const merged = new Set<string>();
  for (const pkg of packages) {
    const jobKey = packageJobKey(pkg);
    if (merged.has(jobKey)) continue;
    const shards = resultsByJobKey.get(jobKey);
    if (!shards || shards.length === 0) continue;
    merged.add(jobKey);
    shards.sort((a, b) => a.shardIndex - b.shardIndex);
    for (const r of shards) {
      if (r.error) {
        throw new Error(`Package ${r.pkgName} shard ${r.shardIndex} extraction failed: ${r.error}`);
      }
      // Boundary invariant: stamp every module with its owning package's source-plugin id so
      // downstream layers identify ownership by id alone, with no language-identity fallback
      // (a plugin that forgets to self-stamp still produces correctly-owned modules here).
      for (const m of r.modules) allModules.push(m.sourcePluginId ? m : { ...m, sourcePluginId: pkg.sourcePluginId });
      reused += r.reused;
      rescanned += r.rescanned;
    }
  }
  return { reused, rescanned };
}

function rssMb(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

async function runInlineExtractionAsync(
  jobs: PackageJob[],
  absPathToId: Map<string, string>,
  packages: PackageInfo[],
  repoRoot: string,
  extractContextByPlugin: Map<string, unknown>,
  profiler: MemoryProfiler,
  progress?: ExtractionProgressReporter,
  signal?: AbortSignal,
): Promise<Map<string, PackageJobResult[]>> {
  const results = new Map<string, PackageJobResult[]>();
  const total = jobs.length;
  const t0 = Date.now();
  let done = 0;
  // On cancel, kill any in-flight subprocess a plugin spawned on THIS thread (python AST child). The
  // pooled path does this via worker shutdown; the inline path has no worker, so wire it here.
  let onAbort: (() => void) | undefined;
  if (signal) {
    onAbort = (): void => {
      // terminateInFlight is async; swallow its rejection so a teardown error is not an unhandledRejection.
      for (const p of getSourcePlugins()) {
        try { void Promise.resolve(p.terminateInFlight?.()).catch(() => undefined); } catch { /* best-effort teardown */ }
      }
    };
    signal.addEventListener('abort', onAbort);
  }
  try {
  for (const job of jobs) {
    // Cooperative cancel checkpoint: stop before extracting the next package.
    signal?.throwIfAborted();
    const plugin = getSourcePlugin(job.sourcePluginId);
    let modules: ModuleInfo[] = [];
    let reused = 0;
    let rescanned = 0;
    if (!plugin) {
      logPipelineWarn(`  ⚠ No source plugin registered for "${job.sourcePluginId}" (package ${job.pkg.name}); skipping.`);
    } else {
      const r = await runSourceExtraction({
        plugin,
        repoRoot,
        packages,
        pendingModules: job.pendingModules,
        prevByPath: new Map(job.prevModuleEntries),
        absPathToId,
        extractContext: extractContextByPlugin.get(job.sourcePluginId),
        analysisVersion: STAGE1_ANALYSIS_VERSION,
      });
      modules = r.modules;
      reused = r.reused;
      rescanned = r.rescanned;
    }
    // Surface an abort that landed DURING this shard (esp. the last / only shard) — otherwise a
    // single-job repo would finish as if it were never cancelled.
    signal?.throwIfAborted();
    const jobKey = packageJobKey(job.pkg);
    const shardResult: PackageJobResult = {
      pkgName: job.pkg.name,
      jobKey,
      shardIndex: job.shardIndex,
      modules,
      reused,
      rescanned,
    };
    let bucket = results.get(jobKey);
    if (!bucket) { bucket = []; results.set(jobKey, bucket); }
    bucket.push(shardResult);
    done++;
    const shardTag = job.totalShards > 1 ? ` [shard ${job.shardIndex + 1}/${job.totalShards}]` : '';
    const pluginTag = job.sourcePluginId ? ` (${job.sourcePluginId})` : '';
    const extra = `(reused ${reused}, parsed ${rescanned})`;
    logPipelineProgress(formatPackageProgressLine(done, total, job.pkg.name + pluginTag + shardTag, job.pendingModules.length, Date.now() - t0, rssMb(), extra));
    if (profiler.enabled) profiler.phase(`stage1:extracted-${job.pkg.name}#${job.shardIndex}`);
    try { progress?.packageDone?.(job.pkg.name, job.pendingModules.length); } catch { /* observer must not break extraction */ }
  }
  return results;
  } finally {
    // Detach the listener: a LATER abort of this (now-settled) build's signal must not fire
    // terminateInFlight() and kill a different concurrent build's in-flight python children.
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function runPooledExtraction(
  jobs: PackageJob[],
  absPathToId: Map<string, string>,
  packages: PackageInfo[],
  repoRoot: string,
  extractContextByPlugin: Map<string, unknown>,
  workerCount: number,
  profiler: MemoryProfiler,
  progress?: ExtractionProgressReporter,
  signal?: AbortSignal,
): Promise<Map<string, PackageJobResult[]>> {
  const pool = new PackageWorkerPool({
    size: workerCount,
    packages,
    absPathToId,
    repoRoot,
    extractContextByPlugin,
    analysisVersion: STAGE1_ANALYSIS_VERSION,
    soloThreshold: Number.MAX_SAFE_INTEGER,
  });
  const abort = abortSignalRejection(signal);
  try {
    // Submit by descending size so giant shards start early; pool's drainQueue handles ordering.
    const ordered = [...jobs].sort((a, b) => b.pendingModules.length - a.pendingModules.length);
    const total = ordered.length;
    const t0 = Date.now();
    let done = 0;
    const pending = ordered.map(j =>
      pool.submit(j).then(r => {
        done++;
        const shardTag = j.totalShards > 1 ? ` [shard ${j.shardIndex + 1}/${j.totalShards}]` : '';
        const extra = r.error
          ? `ERROR ${r.error}`
          : `(reused ${r.reused}, parsed ${r.rescanned})`;
        logPipelineProgress(formatPackageProgressLine(done, total, j.pkg.name + shardTag, j.pendingModules.length, Date.now() - t0, rssMb(), extra));
        if (profiler.enabled) profiler.phase(`stage1:extracted-${j.pkg.name}#${j.shardIndex}`);
        try { progress?.packageDone?.(j.pkg.name, j.pendingModules.length); } catch { /* observer must not break extraction */ }
        return r;
      }),
    );
    // Race worker completion against cancellation. On cancel the abort promise rejects, the loop
    // exits, and the `finally` terminates every worker (pool.destroy → worker.terminate).
    const settled = await Promise.race([Promise.all(pending), abort.promise]);
    const out = new Map<string, PackageJobResult[]>();
    for (const r of settled) {
      let bucket = out.get(r.jobKey);
      if (!bucket) { bucket = []; out.set(r.jobKey, bucket); }
      bucket.push(r);
    }
    return out;
  } finally {
    abort.cleanup();
    await pool.destroy();
  }
}

/**
 * A promise that rejects when `signal` aborts (or immediately if already aborted), with a cleanup
 * to detach the listener. Used to race worker completion against cancellation; the caller's
 * `finally { pool.destroy() }` terminates the workers. With no signal the promise never settles,
 * so the race is decided solely by worker completion.
 */
function abortSignalRejection(signal: AbortSignal | undefined): { promise: Promise<never>; cleanup: () => void } {
  if (!signal) {
    return { promise: new Promise<never>(() => undefined), cleanup: () => undefined };
  }
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error('Build cancelled'));
    if (signal.aborted) { fail(); return; }
    onAbort = fail;
    signal.addEventListener('abort', fail, { once: true });
  });
  // Swallow the rejection when worker completion wins the race and this promise is dropped, so a
  // late abort does not surface as an unhandled rejection.
  promise.catch(() => undefined);
  return { promise, cleanup: () => { if (onAbort) signal.removeEventListener('abort', onAbort); } };
}

function buildAbsPathToId(pendingModules: PendingModule[]): Map<string, string> {
  const absPathToId = new Map<string, string>();
  for (const pending of pendingModules) {
    absPathToId.set(pending.filePath, pending.moduleId);
    if (pending.virtualPath) absPathToId.set(pending.virtualPath, pending.moduleId);
  }
  return absPathToId;
}

/** Resolve moduleId collisions deterministically by TS-resolver priority. Preserves the
 * first-seen order of surviving entries (matches filesystem discovery order so cold runs
 * remain reproducible). */
export function dedupByModuleIdPreservingOrder(pendings: PendingModule[]): PendingModule[] {
  const winnerByModuleId = new Map<string, PendingModule>();
  const firstSeenOrder = new Map<string, number>();
  let orderCounter = 0;
  for (const p of pendings) {
    const existing = winnerByModuleId.get(p.moduleId);
    if (!existing) {
      winnerByModuleId.set(p.moduleId, p);
      firstSeenOrder.set(p.moduleId, orderCounter++);
      continue;
    }
    if (modulePathResolverPriority(p.filePath) < modulePathResolverPriority(existing.filePath)) {
      winnerByModuleId.set(p.moduleId, p);
    }
  }
  const result: PendingModule[] = new Array(winnerByModuleId.size);
  for (const [moduleId, winner] of winnerByModuleId) {
    result[firstSeenOrder.get(moduleId)!] = winner;
  }
  return result;
}

function resolveRemainingImports(allModules: ModuleInfo[], packages: PackageInfo[]): void {
  for (const mod of allModules) {
    for (const imp of mod.imports) {
      if (imp.isExternal) continue;
      if (imp.resolvedModuleId && !imp.moduleSpecifier.startsWith('.')) continue;
      if (!imp.moduleSpecifier.startsWith('.')) {
        const pkgName = extractPackageName(imp.moduleSpecifier);
        if (packages.some(p => p.name === pkgName)) {
          imp.resolvedModuleId = packageNodeId(pkgName);
        } else {
          imp.isExternal = true;
        }
      }
    }
  }
}

/** True when the catalog decided anything; an empty one is left off the snapshot entirely. */
function hasDeclarations(catalog: DeclarationCatalog): boolean {
  return catalog.dirs.length > 0
    || catalog.values.length > 0
    || catalog.resourceKinds.length > 0
    || catalog.triggerTypes.length > 0
    || catalog.conflicts.length > 0
    || catalog.retractions.length > 0;
}

function buildSnapshot(
  repoRoot: string,
  packages: PackageInfo[],
  allModules: ModuleInfo[],
  extractionConfigFingerprint: string,
  scanPatterns: ReturnType<typeof compileScanPatterns>,
  linkingOpt: RepositoryFactsSnapshot['linkingConfig'] | undefined,
  buildRefusals: Refusal[],
  declarations: DeclarationCatalog,
  profiler: MemoryProfiler,
): RepositoryFactsSnapshot {
  const normalizedLinking = linkingOpt ? normalizeLinkingConfig(linkingOpt) : undefined;
  const bundleOutputHandlerMap = loadBundleOutputHandlerMap(
    repoRoot,
    normalizedLinking?.bundles.scripts ?? [],
    normalizedLinking?.bundles.autoDetect ?? true,
  );

  // Infra scan is independent of source packages: an infra-only repo (Terraform/k8s with no
  // tsconfig/pyproject) still gets its infra modules.
  const infraModules = collectInfraModules({
    repoRoot,
    scanPatterns,
  });
  if (packages.length === 0 && infraModules.length === 0) {
    logPipelineWarn('  No source packages or infra files found.');
  }
  const totalInfraResources = infraModules?.reduce((n, m) => n + m.resources.length, 0) ?? 0;
  if (infraModules.length > 0) {
    logPipeline(formatPipelineDetail(`  Infra: ${infraModules.length} module(s), ${totalInfraResources} resource(s)`));
  }

  // Template artifacts are independent of source packages; a project can have template nodes even
  // when route extraction does not find matching render units.
  const templates = collectTemplates({ repoRoot, scanPatterns });
  if (templates.length > 0) {
    logPipeline(formatPipelineDetail(`  Templates: ${templates.length} template artifact(s)`));
  }

  profiler.setCounter('infraModules', infraModules.length);
  profiler.setCounter('templates', templates.length);
  profiler.setCounter('infraResources', totalInfraResources);
  profiler.setCounter('totalImports', allModules.reduce((sum, m) => sum + m.imports.length, 0));
  profiler.setCounter('totalExports', allModules.reduce((sum, m) => sum + m.exports.length, 0));
  profiler.phase('stage1:after-infra');

  const snapshot: RepositoryFactsSnapshot = {
    repoRoot,
    timestamp: new Date().toISOString(),
    analysisVersion: STAGE1_ANALYSIS_VERSION,
    engineBuildId: currentEngineBuildId(),
    extractionConfigFingerprint,
    packages,
    modules: allModules,
    infraModules,
    ...(buildRefusals.length > 0 ? { buildRefusals } : {}),
    ...(hasDeclarations(declarations) ? { declarations } : {}),
    ...(templates.length > 0 ? { templates } : {}),
    ...(Object.keys(bundleOutputHandlerMap).length > 0 ? { bundleOutputHandlerMap } : {}),
    ...(linkingOpt && hasLinkingConfig(linkingOpt) ? {
      linkingConfig: {
        handlers: { searchRoots: normalizedLinking!.handlers.searchRoots },
        bundles: {
          scripts: normalizedLinking!.bundles.scripts,
          autoDetect: normalizedLinking!.bundles.autoDetect,
        },
        containers: { dockerfileRoots: normalizedLinking!.containers.dockerfileRoots },
      },
    } : {}),
  };
  profiler.setCounter('snapshotJsonBytes', profiler.measureJsonBytes(snapshot));
  profiler.phase('stage1:complete');
  return snapshot;
}

interface PreparedRun {
  packages: PackageInfo[];
  pendingModules: PendingModule[];
  absPathToId: Map<string, string>;
  prevByPath: Map<string, ModuleInfo>;
  /** Opaque per-plugin extractContext returned by each plugin's discover(). */
  extractContextByPlugin: Map<string, unknown>;
  /** Hash of compiler/discovery options, scan filters, and active plugin identities. */
  extractionConfigFingerprint: string;
  scanPatterns: ReturnType<typeof compileScanPatterns>;
  linkingOpt: RepositoryFactsSnapshot['linkingConfig'] | undefined;
  /** What discovery refused, in the order the phases produced it. */
  buildRefusals: Refusal[];
  profiler: MemoryProfiler;
}

async function prepareRun(
  repoRoot: string,
  options: SnapshotOptions | undefined,
  pluginRuntime: PluginRuntime,
): Promise<PreparedRun> {
  const profiler = MemoryProfiler.ensure();
  profiler.phase('stage1:start');

  const scanPatterns = compileScanPatterns(
    options?.scanInclude ?? [],
    options?.scanExclude ?? [],
  );
  const discoveryOptions: SourceDiscoveryOptions = { scanPatterns };

  // Pass 1 — discovery, per source plugin. Each plugin returns its packages, candidate files
  // (keyed by absolute path), and an opaque extractContext threaded back into extract().
  const allPackages: PackageInfo[] = [];
  const seenPackageKeys = new Set<string>();
  const mergedPendingByPath = new Map<string, PendingModule>();
  const extractContextByPlugin = new Map<string, unknown>();
  const activeSourcePlugins: SourcePlugin[] = [];
  // A Set, so a file two packages both enumerate is one refused file, matching how
  // `mergedPendingByPath` counts an accepted one.
  const outsideRepo = new Set<string>();
  const refusals: Refusal[] = [];
  // Collected, not pushed one-per-item: three surfaces publish the sink verbatim into a size-capped
  // response, and one bad config can name every file in the repository.
  const skippedPlugins: Array<{ id: string; reason: string }> = [];
  const claimedTwice: string[] = [];

  for (const plugin of getSourcePlugins()) {
    // Graceful degradation: a plugin self-probes its prerequisites
    // (e.g. Python's interpreter). When unavailable the engine skips it with ONE warning instead of
    // letting every file fail downstream. Absent `available()` ⇒ always applicable.
    if (plugin.available) {
      const availability = await plugin.available();
      if (!availability.ok) {
        const reason = availability.reason ?? `${plugin.requires?.runtime ?? 'prerequisite'} unavailable`;
        logPipelineWarn(`  ⚠ Skipping source plugin "${plugin.id}": ${reason}.`);
        skippedPlugins.push({ id: plugin.id, reason });
        extractContextByPlugin.set(plugin.id, undefined);
        continue;
      }
    }
    activeSourcePlugins.push(plugin);
    const { packages: pkgs, pendingByPath, extractContext } = plugin.discover(repoRoot, discoveryOptions);
    for (const pkg of pkgs) {
      const key = packageJobKey(pkg);
      if (seenPackageKeys.has(key)) continue;
      seenPackageKeys.add(key);
      allPackages.push(pkg);
    }
    for (const [filePath, pending] of pendingByPath) {
      // Containment is language-agnostic, so the engine applies it to every producer's candidates
      // rather than trusting each discover(). A candidate names an in-repo path while `readFileSync`
      // follows it, so `src/leak.ts -> ../../secret.ts`, or any file under a directory link, would
      // publish its export names, signatures and types into the graph. Refusing here, before
      // `absPathToId` is minted, keeps the path out of import resolution as well as out of the
      // module set. `pending.filePath`, not the map key: keys are host-normalized (lowercased on
      // win32) and would misreport the name.
      if (!isPathInsideRepo(repoRoot, pending.filePath)) {
        outsideRepo.add(repoRelativePosix(repoRoot, pending.filePath));
        continue;
      }
      // Enforce scan.include/exclude on every producer's output, not only the built-ins that apply it
      // inside discover(). A third-party source plugin that ignores `options.scanPatterns` would
      // otherwise seed the graph with files the config excludes; filtering here — before the id is
      // minted — makes `scan.exclude` an engine guarantee. Built-ins already filtered, so this is a
      // no-op for them.
      if (!shouldScanSourcePath(repoRelativePosix(repoRoot, pending.filePath), scanPatterns)) {
        continue;
      }
      const existing = mergedPendingByPath.get(filePath);
      if (existing) {
        logPipelineWarn(`  ⚠ File claimed by multiple source plugins (${existing.sourcePluginId} kept over ${pending.sourcePluginId}): ${pending.filePath}`);
        claimedTwice.push(repoRelativePosix(repoRoot, pending.filePath));
        continue;
      }
      // The engine mints the id, here, from what the producer reported. `mod:<pkg>/<path>` is
      // load-bearing for scope resolution, annotation keys and boundary lookups, so it is derived
      // centrally rather than trusted from a plugin that could return any string.
      mergedPendingByPath.set(filePath, {
        ...pending,
        moduleId: makeModuleId(pending.pkg.name, pending.relPath, plugin.capabilities?.moduleIdNormalize),
      });
    }
    extractContextByPlugin.set(plugin.id, extractContext);
  }

  const packages = allPackages.sort((a, b) => compareCodeUnits(a.path, b.path));
  const extractionConfigFingerprint = computeExtractionConfigFingerprint({
    repoRoot,
    scanInclude: options?.scanInclude,
    scanExclude: options?.scanExclude,
    sourcePlugins: activeSourcePlugins,
    iacPluginIds: getRegisteredIaCPluginIds(),
    extractContextByPlugin,
    pluginRuntime: pluginRuntimeIdentity(pluginRuntime),
  });
  profiler.setCounter('packagesScanned', packages.length);
  profiler.phase('stage1:after-discover-packages');

  const previousSnapshot = options?.previousSnapshot;
  const versionMatches = previousSnapshot?.analysisVersion === STAGE1_ANALYSIS_VERSION;
  const engineBuildOk = engineBuildMatches(previousSnapshot?.engineBuildId, currentEngineBuildId());
  const extractionConfigMatches = previousSnapshot?.extractionConfigFingerprint === extractionConfigFingerprint;
  const canReusePreviousSnapshot = Boolean(previousSnapshot)
    && versionMatches
    && engineBuildOk
    && extractionConfigMatches;
  if (previousSnapshot && !canReusePreviousSnapshot) {
    const reason = !versionMatches
      ? 'analysis version changed'
      : !engineBuildOk
        ? 'engine build changed'
        : 'extraction config changed';
    logPipeline(formatPipelineDetail(`  Snapshot not reused (${reason}); full re-extract`));
  }
  const prevByPath = new Map<string, ModuleInfo>();
  if (previousSnapshot && canReusePreviousSnapshot) {
    for (const m of previousSnapshot.modules) prevByPath.set(m.filePath, m);
  }

  profiler.setCounter('sourceFilesDiscovered', mergedPendingByPath.size);
  profiler.phase('stage1:after-file-discovery');

  // `mergedPendingByPath` dedups by filePath. A SECOND collision can occur when two distinct
  // filePaths collapse to the same moduleId — e.g. `foo.ts` and `foo/index.ts` both become
  // `mod:<pkg>/foo`. Resolve by picking the resolver winner. absPathToId is built from the FULL
  // pending set so imports of either filePath form still resolve to the surviving moduleId.
  const absPathToId = buildAbsPathToId(Array.from(mergedPendingByPath.values()));
  const pendingModules = dedupByModuleIdPreservingOrder(Array.from(mergedPendingByPath.values()));
  profiler.setCounter('uniqueModules', pendingModules.length);
  const pkgsWithModules = new Set(pendingModules.map(p => p.pkg.name)).size;
  logPipeline(formatPipelineDetail(`  Discovered ${pendingModules.length} unique modules across ${pkgsWithModules} packages`));
  for (const { id, reason } of skippedPlugins) {
    refusals.push(refusal(
      'not-ready',
      SOURCE_PLUGIN_UNAVAILABLE_REFUSAL,
      `Source plugin "${id}" was skipped because ${reason}, so the files it reads are absent from the graph.`,
      { sourcePluginId: id },
    ));
  }
  if (claimedTwice.length > 0) {
    const { shown, omitted } = shortenList(claimedTwice.sort(compareCodeUnits), OUTSIDE_REPO_SAMPLE);
    refusals.push(refusal(
      'conflict',
      FILE_CLAIMED_TWICE_REFUSAL,
      `${claimedTwice.length} file(s) were claimed by two source plugins and indexed by the first: `
      + `${shown.join(', ')}${omittedNote(omitted)}.`,
      { count: claimedTwice.length, sample: shown },
    ));
  }
  const outsideRepoPaths = Array.from(outsideRepo).sort();
  if (outsideRepoPaths.length > 0) {
    const { shown: sample, omitted } = shortenList(outsideRepoPaths, OUTSIDE_REPO_SAMPLE);
    const more = omittedNote(omitted);
    logPipelineWarn(`  ⚠ Refused ${outsideRepoPaths.length} file(s) resolving outside the workspace root: ${sample.join(', ')}${more}`);
    // Containment first in the sink: it is the refusal a reader is most likely to be looking for,
    // and the report `refresh_context` publishes reads its paths back off the details.
    refusals.unshift(outsideRepoRefusal(outsideRepoPaths));
  }

  return {
    packages,
    pendingModules,
    absPathToId,
    prevByPath,
    extractContextByPlugin,
    extractionConfigFingerprint,
    scanPatterns,
    linkingOpt: options?.linking,
    buildRefusals: refusals,
    profiler,
  };
}

function finalize(
  repoRoot: string,
  packages: PackageInfo[],
  results: Map<string, PackageJobResult[]>,
  hasPreviousSnapshot: boolean,
  extractionConfigFingerprint: string,
  scanPatterns: ReturnType<typeof compileScanPatterns>,
  linkingOpt: RepositoryFactsSnapshot['linkingConfig'] | undefined,
  buildRefusals: Refusal[],
  declarations: DeclarationCatalog,
  profiler: MemoryProfiler,
): { snapshot: RepositoryFactsSnapshot; reused: number; rescanned: number } {
  const allModules: ModuleInfo[] = [];
  const { reused, rescanned } = mergeResults(results, packages, allModules);
  if (hasPreviousSnapshot) {
    logPipeline(formatPipelineDetail(`  Incremental: ${reused} reused, ${rescanned} rescanned`));
  }
  profiler.setCounter('modulesReused', reused);
  profiler.setCounter('modulesRescanned', rescanned);
  profiler.phase('stage1:after-module-extraction');

  resolveRemainingImports(allModules, packages);
  profiler.phase('stage1:after-import-resolution');

  const snapshot = buildSnapshot(
    repoRoot,
    packages,
    allModules,
    extractionConfigFingerprint,
    scanPatterns,
    linkingOpt,
    buildRefusals,
    declarations,
    profiler,
  );
  return { snapshot, reused, rescanned };
}

export interface SnapshotOptions {
  previousSnapshot?: RepositoryFactsSnapshot;
  /** Repo-root-relative globs from `scan.include` (include wins over exclude). */
  scanInclude?: ScanPatternInput[];
  /** Repo-root-relative globs from `scan.exclude`. */
  scanExclude?: ScanPatternInput[];
  /** Infra → code linking hints passed through to stage 2. */
  linking?: NonNullable<RepositoryFactsSnapshot['linkingConfig']>;
  /** Worker pool size for Pass 2 per-package extraction (async API only).
   * - undefined (default): auto = min(4, cpus-1).
   * - 0 or 1: inline serial (no worker_threads).
   * - >1: persistent pool of N workers. */
  maxPackageWorkers?: number;
  /** Target number of modules per shard. Packages with more than `MIN_SHARDING_THRESHOLD`
   * modules are split into shards of approximately this size so a giant package can
   * parallelize across workers. Default 800. */
  shardTargetSize?: number;
  /** Progress callbacks for external consumers (e.g. lazy MCP build status). */
  progress?: ExtractionProgressReporter;
  /** External plugin wiring (`config.plugins`). When present, the loader resolves/registers
   *  third-party plugins from the analyzed repo and applies `{defaults, add, disable}` before
   *  discovery. Absent ⇒ bundled preset only (the loader is not run — existing callers unchanged). */
  plugins?: PluginsConfigInput;
  /** Cooperative-cancel signal. When aborted, extraction stops at the next package/shard boundary
   *  (inline) or wins a race against worker completion (pooled), then the worker pool is torn down. */
  signal?: AbortSignal;
}

/** Optional progress reporting hook exposed by the async stage 1 API. */
export interface ExtractionProgressReporter {
  /** Called once before extraction starts. */
  begin?(totals: { totalPackages: number; totalModules: number }): void;
  /** Called once for each package that completes (in completion order). */
  packageDone?(pkgName: string, pkgModules: number): void;
}

// ── Public API ──

/** Collect a repository facts snapshot — enables worker_threads pool when `maxPackageWorkers > 1` (default).
 * Falls back to inline serial when only 1 worker is requested. */
export async function collectRepositoryFactsAsync(
  repoRoot: string,
  options?: SnapshotOptions,
): Promise<RepositoryFactsSnapshot> {
  options?.signal?.throwIfAborted();
  // Environment cap on the worker pool, applied only when the caller didn't pass an explicit
  // option. Used by harnesses/CI; the Jest setup file sets it to 1 because ts-jest runs Stage 1
  // from src/ while worker_threads need dist/stage1/worker.js.
  const envWorkersRaw = process.env.REPOVINE_MAX_PACKAGE_WORKERS;
  const envWorkers = envWorkersRaw ? Number(envWorkersRaw) : undefined;
  const resolvedOptions =
    options?.maxPackageWorkers === undefined && envWorkers !== undefined && Number.isFinite(envWorkers)
      ? { ...options, maxPackageWorkers: envWorkers }
      : options;

  const t0 = Date.now();

  // External plugins: resolve/register third-party plugins from the analyzed
  // repo, applying config.plugins.{defaults,add,disable}, BEFORE discovery reads the registry. When
  // any external SOURCE plugin is active, force inline extraction — worker isolates only carry the
  // bundled preset, so an external source plugin's extract() must run on the main thread.
  let forceInlineExtraction = false;
  const pluginRefusals: Refusal[] = [];
  // Assembled fresh here every call: the runtime is what this build's plugin set declares and
  // contributes, and it is handed on rather than left in module state.
  let pluginRuntime = emptyPluginRuntime();
  if (resolvedOptions?.plugins) {
    const report = await applyPluginConfig({ repoRoot, config: resolvedOptions.plugins });
    forceInlineExtraction = report.externalSourceIds.size > 0;
    pluginRuntime = report.runtime;
    for (const { name, reason } of report.refused) {
      pluginRefusals.push(refusal(
        'unreadable',
        PLUGIN_UNLOADABLE_REFUSAL,
        `Plugin "${name}" from repovine.config.json could not be loaded: ${reason}. What it would have contributed is absent from the graph.`,
        { plugin: name },
      ));
    }
    // Conflicting and unnarrowable declarations change what the build knows, so they reach the
    // reader beside the plugins that could not be loaded at all.
    pluginRefusals.push(...pluginRuntime.refusals);
  }

  const signal = resolvedOptions?.signal;
  const prep = await prepareRun(repoRoot, resolvedOptions, pluginRuntime);
  // Plugin loading happens before discovery, so its refusals are prepended: the sink reads as the
  // order the build made them.
  prep.buildRefusals.unshift(...pluginRefusals);
  signal?.throwIfAborted();

  // Calibration: read the previous run's observations (if any) and let them advise
  // worker count + shard size. User-provided overrides still win. The cache path is
  // anchored to `repoRoot` (the scanned project) — not cwd — so calibration follows
  // the project across invocations even when repovine is run from elsewhere.
  const calibrationCacheDir = cacheDirFor(path.join(repoRoot, ARTIFACTS_DIR_NAME));
  const cpus = availableParallelism();
  const totalRamMb = Math.round(effectiveTotalMemBytes() / 1024 / 1024);
  const calibration = loadCalibration(calibrationCacheDir);
  const advice = adviseFromCalibration(
    calibration,
    { maxPackageWorkers: resolvedOptions?.maxPackageWorkers, shardTargetSize: resolvedOptions?.shardTargetSize },
    { cpuCount: cpus, totalRamMb, defaultShardSize: DEFAULT_SHARD_TARGET_SIZE },
  );
  const shardTargetSize = advice?.shardTargetSize ?? resolvedOptions?.shardTargetSize ?? DEFAULT_SHARD_TARGET_SIZE;
  const { jobs } = buildPackageJobs(prep.packages, prep.pendingModules, prep.prevByPath, shardTargetSize);

  try {
    resolvedOptions?.progress?.begin?.({
      totalPackages: jobs.length,
      totalModules: prep.pendingModules.length,
    });
  } catch { /* observer must not break extraction */ }

  // Pick the worker count, then never spin up more workers than there are jobs to
  // dispatch (small repos otherwise pay extra spawn overhead for idle workers).
  const requestedWorkerCount = advice?.workerCount ?? chooseWorkerCount(resolvedOptions?.maxPackageWorkers, cpus, effectiveTotalMemBytes());
  // External source plugins are not registered in worker isolates → run extraction inline.
  const workerCount = forceInlineExtraction ? 1 : Math.max(1, Math.min(requestedWorkerCount, jobs.length));

  // Peak RSS tracker — sampled while extraction runs so calibration captures the real
  // process-wide footprint (not just heap).
  const baselineRssMb = Math.max(1, Math.round(process.memoryUsage().rss / 1024 / 1024));
  let peakRssMb = baselineRssMb;
  const rssTicker = setInterval(() => {
    const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (rss > peakRssMb) peakRssMb = rss;
  }, 250);

  let snap: RepositoryFactsSnapshot;
  let reuseStats: { reused: number; rescanned: number };
  try {
    let results: Map<string, PackageJobResult[]>;
    if (workerCount <= 1) {
      results = await runInlineExtractionAsync(jobs, prep.absPathToId, prep.packages, repoRoot, prep.extractContextByPlugin, prep.profiler, resolvedOptions?.progress, signal);
    } else {
      results = await runPooledExtraction(
        jobs,
        prep.absPathToId,
        prep.packages,
        repoRoot,
        prep.extractContextByPlugin,
        workerCount,
        prep.profiler,
        resolvedOptions?.progress,
        signal,
      );
    }
    logPipelineProgressEnd();
    const finalized = finalize(
      repoRoot,
      prep.packages,
      results,
      Boolean(resolvedOptions?.previousSnapshot),
      prep.extractionConfigFingerprint,
      prep.scanPatterns,
      prep.linkingOpt,
      prep.buildRefusals,
      pluginRuntime.catalog,
      prep.profiler,
    );
    snap = finalized.snapshot;
    // The declarations rode along on the snapshot; the loaded capability code cannot, so it is
    // keyed to this snapshot object for whoever composes it in this isolate.
    rememberPluginRuntime(snap, pluginRuntime);
    reuseStats = { reused: finalized.reused, rescanned: finalized.rescanned };
  } finally {
    logPipelineProgressEnd();
    // Always stop the RSS sampler — a throw above would otherwise leak the interval and keep
    // a long-lived MCP server's event loop ticking forever.
    clearInterval(rssTicker);
  }
  const wallSec = Math.max(1, Math.round((Date.now() - t0) / 1000));
  logPipeline(formatPipelineStageDone(`  Stage 1 DONE in ${wallSec}s — ${snap.modules.length} modules, ${snap.infraModules?.length ?? 0} infra modules`));

  // Persist what this run observed so the next run can self-tune. Best-effort: a
  // calibration write failure should never break extraction. Skip persistence when
  // the run is unrepresentative (forced single-worker, no shards) — saving those
  // numbers would attribute the full process peak to one worker and starve future
  // auto-picks.
  const isRepresentativeRun = isRepresentativeCalibrationRun({
    workerCount,
    totalShards: jobs.length,
    reusedModules: reuseStats.reused,
    rescannedModules: reuseStats.rescanned,
  });
  if (isRepresentativeRun) {
    try {
      saveCalibration(calibrationCacheDir, {
        at: new Date().toISOString(),
        observed: {
          cpuCount: cpus,
          totalRamMb,
          workerCount,
          shardTargetSize,
          baselineRssMb,
          peakRssMb,
          incrementalPeakRssMb: Math.max(1, peakRssMb - baselineRssMb),
          wallSec,
          totalModules: snap.modules.length,
          totalShards: jobs.length,
          reusedModules: reuseStats.reused,
          rescannedModules: reuseStats.rescanned,
          runKind: 'cold',
        },
      });
    } catch (e) {
      logPipelineWarn(`  ⚠ Failed to save calibration: ${(e as Error).message}`);
    }
  }

  return snap;
}
