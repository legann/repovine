import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  RepositoryFactsSnapshot,
  RepositoryGraph,
  ModuleInfo,
  DomainTier,
  DomainNodeData,
} from '../types.js';
import { addEdge, addNode, applyValidated, createEmptyGraph, domainMembers, infraTargetIds, isTaggedInto, modulePackageId, nodesOfType, taggedDomains } from '../graph/index.js';
import { rememberGraphExtensions, rememberProjectionReport } from '../graph/build-artifact.js';
import { emptyExtensionStore, extensionStoreOf, type ExtensionStore } from '../graph/extension-store.js';
import { getPluginRuntime } from '../plugin-host/runtime-store.js';
import {
  composeProjections,
  emptyProjectionCompositionResult,
  type ContributorOutcome,
  type ProjectionCompositionResult,
} from './projection/compose.js';
import { createFactView } from './projection/fact-view.js';
import { domainNodeId } from '../graph/node-ids.js';
import { collectAllDomainTags, loadDomainsConfig, STRUCTURAL_DIRS } from './domains.js';
import { MemoryProfiler } from '../perf/memory-profiler.js';
import { formatPipelineDetail, logPipeline } from '../cli/ui.js';
// Side-effect import: registers built-in interpreters so composeInterpreters can build
// the structural + infra-link graph (and collect entrypoints) before the domain passes run.
import './interpreter/bootstrap.js';
import { composeInterpreters } from './interpreter/composer.js';
import { rememberInterpreterEntrypoints } from './interpreter/entrypoint-store.js';
import type { EntrypointFragment } from '../interpreter/types.js';
import { pruneInertRuntimeResources } from './prune-inert-resources.js';
import { validateComposedGraph, summarizeGraphValidationProblems } from './graph-validate.js';
import { refusal, type Refusal } from '../response/refusal.js';
import { GRAPH_VALIDATION_REFUSAL } from '../stage1/refusal-kinds.js';

/**
 * Refusals composition made, keyed by the graph it made them about.
 *
 * Process-local and keyed by object identity, exactly like the interpreter entrypoint store: the
 * worker's map does not survive structured clone, so the value is posted across the boundary and
 * re-keyed onto the cloned graph on the parent side.
 */
const composedRefusals = new WeakMap<RepositoryGraph, Refusal[]>();

/** What composition refused about this graph. Empty for a graph that took every record. */
export function getComposedRefusals(graph: RepositoryGraph): Refusal[] {
  return composedRefusals.get(graph) ?? [];
}

/** Re-key composition refusals onto a graph that crossed an isolate boundary. */
export function rememberComposedRefusals(graph: RepositoryGraph, refusals: Refusal[]): void {
  composedRefusals.set(graph, refusals);
}
import { domainSlug } from './domain-slug.js';
import { getSourceIndexBasenames, stripSourceExtension } from '../plugin-host/source-set.js';

const STRUCTURAL_DIRS_REF = STRUCTURAL_DIRS;

export function composeRepositoryGraph(
  snapshot: RepositoryFactsSnapshot,
  modulesById?: Map<string, ModuleInfo>,
): RepositoryGraph {
  const profiler = MemoryProfiler.ensure();
  const graph = createEmptyGraph();
  const modsMap = modulesById ?? new Map(snapshot.modules.map(m => [m.id, m]));
  // Load config once; the infra-link layer (resource excludes) and the content/infra domain passes
  // consult it. collectAllDomainTags also loads its own copy — fine (cheap, fs cache hit).
  const config = loadDomainsConfig(snapshot.repoRoot);

  // Graph-building layers run before domains: the structural and infra-link layers contribute the
  // module/service/infra edges that the domain passes depend on. The composer also collects
  // entrypoint fragments in the same pass (services exist after infra-link.contribute).
  const interpreterResult = composeInterpreters({ graph, snapshot, modulesById: modsMap, domainsConfig: config });
  profiler.phase('stage2:after-interpreter-composer');

  // Plugin projection runs after the structural layers and before the domain passes: its resources
  // are nodes the domain passes must see, and its references resolve against modules those layers
  // already minted. Every contributor runs before anything is applied, so registration order
  // decides nothing here.
  const projection = composeProjectionsFor(graph, snapshot);
  applyValidated(graph, projection.delta);
  rememberInterpreterEntrypoints(graph, [...interpreterResult.entrypoints, ...projection.entrypoints]);
  rememberGraphExtensions(graph, extensionStoreOf(projection.extensions));
  rememberProjectionReport(graph, projection.contributors);
  profiler.phase('stage2:after-projection-composer');

  // Opt-in witness gate (infra.pruneInert): drop inert runtime-resources now that every load-bearing
  // edge exists but before the domain passes, so inert plumbing never tags domains or inflates tiers.
  pruneInertRuntimeResources(graph, config);

  pass4Domains(graph, snapshot, modsMap);
  profiler.phase('stage2:after-pass4-domains');
  pass5ContentDomains(graph, snapshot);
  pass5PropagateInfraDomains(graph);
  profiler.phase('stage2:after-pass5-content-domains');
  pass6ClassifyDomains(graph);
  pass7Subdomains(graph, modsMap);
  profiler.phase('stage2:after-pass6-7-domains');
  logDomains(graph);
  // Node view fields are computed on-demand by buildNodeView

  // Read-only invariant gate over two snapshot collections: every stage1 module and every template
  // projected into the graph, and no edge points at a node the graph does not hold. Packages and
  // infra modules also become nodes; the gate does not walk them. Healthy graphs produce zero
  // problems, so this is silent in normal operation. It throws under REPOVINE_DEV (git checkout /
  // CI) to catch a pass regression at the source, and otherwise warns.
  const problems = validateComposedGraph(graph, snapshot);
  // Returned, not written onto `snapshot`: composition runs in a worker over a structured clone, so
  // a refusal recorded on the argument would be dropped at the isolate boundary — the same loss the
  // interpreter entrypoints already pay for and carry across explicitly.
  composedRefusals.set(graph, [...projection.refusals]);
  if (problems.length > 0) {
    const summary = summarizeGraphValidationProblems(problems);
    if (process.env.REPOVINE_DEV) {
      throw new Error(`stage2 graph validation failed: ${summary}`);
    }
    logPipeline(formatPipelineDetail(`  ⚠ graph validation: ${summary}`));
    composedRefusals.set(graph, [...projection.refusals, refusal(
      'incomplete',
      GRAPH_VALIDATION_REFUSAL,
      `The graph did not take every module and template the scan produced: ${summary}. What is named there is missing from the graph or points at a node that is not in it.`,
      { problems: problems.length },
    )]);
  }

  return graph;
}

// ── Stage 2 off the control plane ──

let stage2WorkerUrl: URL | null | undefined;
/** Locate the compiled stage2 worker. Lazy + memoized; returns null when unbuilt (running from
 *  source without dist) so the caller composes inline instead of throwing at module load. */
function resolveStage2WorkerUrl(): URL | null {
  if (stage2WorkerUrl !== undefined) return stage2WorkerUrl;
  const adjacent = fileURLToPath(new URL('./worker.js', import.meta.url));
  const candidates: Array<URL | null> = [
    fs.existsSync(adjacent) ? new URL('./worker.js', import.meta.url) : null,
    ...[
      adjacent.replace(`${path.sep}src${path.sep}`, `${path.sep}dist${path.sep}`),
      path.resolve(process.cwd(), 'dist', 'stage2', 'worker.js'),
      path.resolve(process.cwd(), 'repovine', 'dist', 'stage2', 'worker.js'),
    ].map(candidate => (fs.existsSync(candidate) ? pathToFileURL(candidate) : null)),
  ];
  stage2WorkerUrl = candidates.find((url): url is URL => url !== null) ?? null;
  return stage2WorkerUrl;
}

/** Distinguishes a cancel-triggered stage2 rejection from an offload infrastructure failure, so the
 *  caller re-throws (aborts the build) instead of falling back to a full inline recompute. */
class Stage2Aborted extends Error {
  constructor() { super('stage2 offload aborted'); this.name = 'Stage2Aborted'; }
}

function runStage2InWorker(snapshot: RepositoryFactsSnapshot, signal?: AbortSignal): Promise<RepositoryGraph> {
  const url = resolveStage2WorkerUrl();
  if (!url) return Promise.reject(new Error('stage2/worker.js not built'));
  if (signal?.aborted) return Promise.reject(new Stage2Aborted());
  return new Promise<RepositoryGraph>((resolve, reject) => {
    const worker = new Worker(url, { workerData: { snapshot } });
    let result: { type?: string; graph?: RepositoryGraph; entrypoints?: EntrypointFragment[]; refusals?: Refusal[]; extensions?: ExtensionStore; contributors?: ContributorOutcome[]; message?: string; stack?: string } | undefined;
    let settled = false;
    // Holder breaks the settle ↔ onAbort mutual reference without a reassigned `let` (prefer-const).
    const abortRef: { fn?: () => void } = {};
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (abortRef.fn) signal?.removeEventListener('abort', abortRef.fn);
      fn();
    };
    // Cancel: terminate the isolate so Stage 2 work actually stops (the signal cannot cross the worker
    // boundary — terminate is the mechanism), and reject with the marker so the caller does not fall back.
    abortRef.fn = (): void => settle(() => { void worker.terminate().catch(() => undefined); reject(new Stage2Aborted()); });
    if (signal) signal.addEventListener('abort', abortRef.fn, { once: true });
    // Capture the result, then let the worker exit (terminate speeds the unref'd self-exit). Settle
    // only on 'exit', so this call never returns while the isolate is still alive — no leaked worker.
    worker.once('message', (msg: typeof result) => { result = msg; void worker.terminate().catch(() => undefined); });
    worker.once('exit', () => settle(() => {
      if (result?.type === 'ok' && result.graph) {
        // Re-key the interpreter entrypoints onto the cloned graph — the worker's WeakMap entry did
        // not survive structured clone (see R5). Absent field ⇒ empty (stale/pre-fix worker).
        rememberInterpreterEntrypoints(result.graph, result.entrypoints ?? []);
        rememberComposedRefusals(result.graph, result.refusals ?? []);
        rememberGraphExtensions(result.graph, result.extensions ?? emptyExtensionStore());
        rememberProjectionReport(result.graph, result.contributors ?? []);
        resolve(result.graph);
      } else {
        const err = new Error(result?.message ?? 'stage2 worker exited before returning a graph');
        if (result?.stack) err.stack = result.stack;
        reject(err);
      }
    }));
    worker.once('error', err => settle(() => { void worker.terminate().catch(() => undefined); reject(err); }));
  });
}

/**
 * Compose the repository graph off the MCP control plane. `composeRepositoryGraph` is synchronous and
 * would block the event loop for its whole duration — no request (including get_build_status) can be
 * answered while it runs. This offloads it to a worker so only the result deserialization touches the
 * main loop. Any offload failure (unbuilt worker, spawn, clone, or a worker-side error) falls back to
 * inline compose so the build never breaks; a REPOVINE_DEV validation error re-throws from the inline
 * path deterministically.
 */
export async function composeRepositoryGraphAsync(
  snapshot: RepositoryFactsSnapshot,
  modulesById?: Map<string, ModuleInfo>,
  signal?: AbortSignal,
): Promise<RepositoryGraph> {
  // Escape hatch: force inline compose (skip the worker) for debugging or constrained environments.
  if (process.env.REPOVINE_STAGE2_INLINE) {
    signal?.throwIfAborted(); // honor cancel on the inline path too
    return composeRepositoryGraph(snapshot, modulesById);
  }
  try {
    return await runStage2InWorker(snapshot, signal);
  } catch (e) {
    // A cancel is not an offload failure — re-throw instead of falling back and redoing the full compose.
    if (e instanceof Stage2Aborted || signal?.aborted) throw e;
    // Strict mode (tests): any offload failure is a hard error instead of a silent inline fallback,
    // so a worker-boundary regression cannot hide behind an inline compose that happens to pass.
    if (process.env.REPOVINE_STAGE2_WORKER_STRICT) throw e;
    if (process.env.REPOVINE_VERBOSE) {
      logPipeline(formatPipelineDetail(`  ⚠ Stage 2 offload unavailable (${(e as Error).message}); composing inline`));
    }
    return composeRepositoryGraph(snapshot, modulesById);
  }
}

/**
 * Run this build's projectors against the graph as it stands.
 *
 * The contributors come from the runtime keyed to this snapshot. Every isolate that composes loads
 * the set itself from `snapshot.plugins`, so the Stage 2 worker holds the same contributors the
 * control plane did. A snapshot that names no plugin config has none, and none is then the honest
 * answer rather than a silently empty projection.
 */
function composeProjectionsFor(
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
): ProjectionCompositionResult {
  const { contributors } = getPluginRuntime(snapshot);
  if (contributors.length === 0) return emptyProjectionCompositionResult();
  return composeProjections({
    contributors,
    input: {
      repoRoot: snapshot.repoRoot,
      facts: createFactView({
        snapshot,
        ...(snapshot.facts === undefined ? {} : { facts: snapshot.facts }),
      }),
    },
    knownModuleIds: new Set(snapshot.modules.map(mod => mod.id)),
    knownNodeIds: new Set(graph.nodes.keys()),
  });
}

function logDomains(graph: RepositoryGraph): void {
  const domainIds = nodesOfType(graph, 'domain');
  if (domainIds.length === 0) return;
  const list = domainIds
    .map(id => {
      const node = graph.nodes.get(id);
      if (!node) return null;
      return { label: node.label, tagged: domainMembers(graph, id).all.length };
    })
    .filter((x): x is { label: string; tagged: number } => x !== null)
    .sort((a, b) => b.tagged - a.tagged);
  if (process.env.REPOVINE_VERBOSE) {
    logPipeline(formatPipelineDetail(`  Domains (${list.length}): ${list.map(d => `${d.label}(${d.tagged})`).join(', ')}`));
  } else {
    logPipeline(formatPipelineDetail(`  Domains: ${list.length}`));
  }
}

/**
 * Propagate domain tags from code modules to infra services linked by edge 'infra'.
 * So domain "formula-manager" includes both the TS module and the Lambda → one unified graph.
 */
function pass5PropagateInfraDomains(graph: RepositoryGraph): void {
  const serviceIds = nodesOfType(graph, 'runtime-resource');
  for (const serviceId of serviceIds) {
    const infraTargets = infraTargetIds(graph, serviceId);
    const seenDomain = new Set<string>();
    for (const modId of infraTargets) {
      for (const domainId of taggedDomains(graph, modId).ids) {
        if (seenDomain.has(domainId)) continue;
        seenDomain.add(domainId);
        addEdge(graph, serviceId, domainId, 'tagged');
      }
    }
  }
}

// ── Pass 4: Domains (path-based + import clustering + optional config) ──

function pass4Domains(graph: RepositoryGraph, snapshot: RepositoryFactsSnapshot, modulesById: Map<string, ModuleInfo>): void {
  const { tagsByModule, classification } = collectAllDomainTags(snapshot, graph, snapshot.repoRoot, modulesById);
  const seenEdge = new Set<string>();

  for (const [modId, tags] of tagsByModule) {
    for (const tag of tags) {
      const domainId = domainNodeId(tag.domain);
      const edgeKey = `${modId}\t${domainId}`;
      if (seenEdge.has(edgeKey)) continue;
      seenEdge.add(edgeKey);

      if (!graph.nodes.has(domainId)) {
        const cls = classification.get(tag.domain);
        const data: DomainNodeData = {};
        if (cls?.weight) data.weight = cls.weight;
        addNode(graph, {
          id: domainId,
          type: 'domain',
          label: tag.domain,
          description: `Domain: ${tag.domain}`,
          ...(Object.keys(data).length > 0 ? { data } : {}),
        });
      }
      // Map collector source → edge metadata. 'path' and 'cluster' are primary; 'pattern' is secondary.
      addEdge(graph, modId, domainId, 'tagged', { tagSource: tag.source });
    }
  }
}

// ── Pass 5: Content-based domains (routing, config) ──

/**
 * Domains the engine declares from an observed module property rather than deriving from a path.
 * Their labels name a property (`routing`, `config`), so the label-provenance invariant checks
 * them against the evidence that seeds them, not against names in the tree.
 */
export const CONTENT_DOMAIN_IDS = ['domain:routing', 'domain:config'] as const;

function pass5ContentDomains(graph: RepositoryGraph, snapshot: RepositoryFactsSnapshot): void {
  let routingCreated = false;
  let configCreated = false;

  for (const mod of snapshot.modules) {
    if (!mod.semanticHints) continue;

    if (mod.semanticHints.hasRoutes) {
      if (!routingCreated) {
        addNode(graph, {
          id: 'domain:routing',
          type: 'domain',
          label: 'routing',
          description: 'Domain: routing (modules containing <Route> definitions)',
        });
        routingCreated = true;
      }
      if (!isTaggedInto(graph, mod.id, 'domain:routing')) {
        addEdge(graph, mod.id, 'domain:routing', 'tagged');
      }
    }

    if (mod.semanticHints.envVars && mod.semanticHints.envVars.length > 0) {
      if (!configCreated) {
        addNode(graph, {
          id: 'domain:config',
          type: 'domain',
          label: 'config',
          description: 'Domain: config (modules referencing environment variables)',
        });
        configCreated = true;
      }
      if (!isTaggedInto(graph, mod.id, 'domain:config')) {
        addEdge(graph, mod.id, 'domain:config', 'tagged');
      }
    }
  }
}

// ── Pass 7: Subdomains for large domains ──

const SUBDOMAIN_MIN_MODULES = 10;
const SUBDOMAIN_MIN_CLUSTER = 3;

function pass7Subdomains(graph: RepositoryGraph, modulesById: Map<string, ModuleInfo>): void {
  const domainIds = nodesOfType(graph, 'domain');
  if (domainIds.length === 0) return;

  // Count tagged modules per domain so we can process biggest parents first. This way, when
  // `client-ui` (108 modules) and `ui` (108 same modules — UI files are tagged by both via
  // package + path) both could spawn a `dashboard` subdomain, the bigger parent claims it and
  // the smaller one skips on duplicate detection below.
  const taggedCount = (id: string): number => domainMembers(graph, id).all.length;

  const domainSnapshot = Array.from(domainIds).sort((a, b) => taggedCount(b) - taggedCount(a));

  // Track which module sets have already become a subdomain — same suffix + same module-set means
  // we already created the canonical subdomain (under a bigger parent) and should skip the dup.
  const claimedSubdomains = new Map<string, Set<string>[]>(); // suffix → list of module-id sets

  for (const domainId of domainSnapshot) {
    const node = graph.nodes.get(domainId);
    if (!node || node.type !== 'domain') continue;
    const tier = node.data?.tier;
    if (tier !== 'business' && tier !== 'feature') continue;
    if (node.data?.parent) continue;

    const taggedModIds = domainMembers(graph, domainId).modules;

    if (taggedModIds.length < SUBDOMAIN_MIN_MODULES) continue;

    const clusters = clusterByPathPrefix(taggedModIds, modulesById, node.label);

    const subdomains: string[] = [];
    for (const [subLabel, modIds] of clusters) {
      if (modIds.length < SUBDOMAIN_MIN_CLUSTER) continue;
      if (subLabel === node.label) continue;

      const subdomainId = domainNodeId(`${node.label}/${subLabel}`);
      if (graph.nodes.has(subdomainId)) continue;

      // Skip if an equivalent subdomain (same suffix + same module set) already exists under a
      // bigger parent. This prevents `ui/dashboard` from duplicating `client-ui/dashboard` when
      // both parents see the same modules.
      const modIdSet = new Set(modIds);
      const claimed = claimedSubdomains.get(subLabel);
      if (claimed && claimed.some(existing => setsEqual(existing, modIdSet))) continue;

      addNode(graph, {
        id: subdomainId,
        type: 'domain',
        label: `${node.label}/${subLabel}`,
        description: `Subdomain: ${node.label}/${subLabel} (${modIds.length} modules)`,
        data: { tier: 'feature', parent: domainId },
      });
      addEdge(graph, subdomainId, domainId, 'tagged');
      subdomains.push(subdomainId);

      for (const modId of modIds) {
        addEdge(graph, modId, subdomainId, 'tagged');
      }

      let claimedList = claimedSubdomains.get(subLabel);
      if (!claimedList) { claimedList = []; claimedSubdomains.set(subLabel, claimedList); }
      claimedList.push(modIdSet);
    }

    if (subdomains.length > 0) {
      node.data = { ...node.data, subdomains };
    }
  }
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function clusterByPathPrefix(
  modIds: string[],
  modulesById: Map<string, ModuleInfo>,
  domainLabel: string,
): Map<string, string[]> {
  const segmentCounts = new Map<string, string[]>();

  for (const modId of modIds) {
    const mod = modulesById.get(modId);
    if (!mod) continue;

    const rel = stripSourceExtension(mod.relativeFilePath);
    const parts = rel.split('/');

    const domainIdx = parts.findIndex(p => domainSlug(p) === domainLabel);
    const afterDomain = domainIdx >= 0 ? parts.slice(domainIdx + 1) : parts;

    // A sub-label is half of `domain:<parent>/<sub>`, so it is spelled in the label alphabet like
    // the parent half; a segment that spells nothing contributes no subdomain.
    const indexSegments = new Set(getSourceIndexBasenames().map(domainSlug));
    const meaningful = afterDomain
      .map(domainSlug)
      // The entry basename is a slot in the ecosystem's layout, not a sub-label. Spelled `index`
      // only, a Python barrel `__init__.py` slugged to `init` and became a subdomain of its own.
      .filter(seg => seg && !STRUCTURAL_DIRS_REF.has(seg) && !indexSegments.has(seg));

    const subKey = meaningful.length > 0 ? meaningful[0] : domainLabel;
    let list = segmentCounts.get(subKey);
    if (!list) { list = []; segmentCounts.set(subKey, list); }
    list.push(modId);
  }

  return segmentCounts;
}

// ── Pass 6: Classify domain tiers ──

const LAYER_NAMES = new Set([
  'types', 'utils', 'config', 'configs', 'constants',
  'index', 'hooks', 'testing', 'tests', 'store', 'stores',
  'models', 'interfaces', 'entities', 'contexts', 'providers',
  'routing',
]);

function classifyDomainTier(domainId: string, graph: RepositoryGraph): DomainTier {
  const node = graph.nodes.get(domainId);
  if (!node || node.type !== 'domain') return 'technical';

  if (LAYER_NAMES.has(node.label)) return 'layer';

  const members = domainMembers(graph, domainId);
  const modules = [...members.modules, ...members.resources];

  const packages = new Set<string>();
  for (const modId of modules) {
    const pkgId = modulePackageId(graph, modId);
    if (pkgId) packages.add(pkgId);
  }

  if (modules.length >= 5 && packages.size >= 2) return 'business';
  if (modules.length >= 3 || (modules.length >= 2 && packages.size >= 2)) return 'feature';
  return 'technical';
}

function pass6ClassifyDomains(graph: RepositoryGraph): void {
  const domainIds = nodesOfType(graph, 'domain');
  if (domainIds.length === 0) return;

  for (const domainId of domainIds) {
    const node = graph.nodes.get(domainId);
    if (!node || node.type !== 'domain') continue;
    const tier = classifyDomainTier(domainId, graph);
    node.data = { ...node.data, tier };
  }
}
