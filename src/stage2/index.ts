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
import { createEmptyGraph, addNode, addEdge } from '../graph/index.js';
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
  rememberInterpreterEntrypoints(graph, interpreterResult.entrypoints);
  profiler.phase('stage2:after-interpreter-composer');

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

  // Read-only invariant gate: every snapshot record projected into the graph, no dangling
  // edge. Healthy graphs produce zero problems, so this is silent in normal operation. It throws under
  // REPOVINE_DEV (git checkout / CI) to catch a pass regression at the source, and otherwise warns.
  const problems = validateComposedGraph(graph, snapshot);
  if (problems.length > 0) {
    const summary = summarizeGraphValidationProblems(problems);
    if (process.env.REPOVINE_DEV) {
      throw new Error(`stage2 graph validation failed: ${summary}`);
    }
    logPipeline(formatPipelineDetail(`  ⚠ graph validation: ${summary}`));
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
    let result: { type?: string; graph?: RepositoryGraph; entrypoints?: EntrypointFragment[]; message?: string; stack?: string } | undefined;
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

function logDomains(graph: RepositoryGraph): void {
  const domainIds = graph.byType.get('domain');
  if (!domainIds?.size) return;
  const list = Array.from(domainIds)
    .map(id => {
      const node = graph.nodes.get(id);
      if (!node) return null;
      const tagged = graph.inEdges.get(id)?.filter(e => e.kind === 'tagged').length ?? 0;
      return { label: node.label, tagged };
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
  const serviceSet = graph.byType.get('runtime-resource');
  const serviceIds = serviceSet ? Array.from(serviceSet) : [];
  for (const serviceId of serviceIds) {
    const outEdges = graph.outEdges.get(serviceId) ?? [];
    const infraTargets = outEdges.filter(e => e.kind === 'infra').map(e => e.to);
    const seenDomain = new Set<string>();
    for (const modId of infraTargets) {
      const modOut = graph.outEdges.get(modId) ?? [];
      for (const e of modOut) {
        if (e.kind === 'tagged' && !seenDomain.has(e.to)) {
          seenDomain.add(e.to);
          addEdge(graph, serviceId, e.to, 'tagged');
        }
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
      const domainId = `domain:${tag.domain}`;
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

function hasTaggedEdge(graph: RepositoryGraph, fromId: string, domainId: string): boolean {
  const out = graph.outEdges.get(fromId) ?? [];
  return out.some(e => e.kind === 'tagged' && e.to === domainId);
}

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
      if (!hasTaggedEdge(graph, mod.id, 'domain:routing')) {
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
      if (!hasTaggedEdge(graph, mod.id, 'domain:config')) {
        addEdge(graph, mod.id, 'domain:config', 'tagged');
      }
    }
  }
}

// ── Pass 7: Subdomains for large domains ──

const SUBDOMAIN_MIN_MODULES = 10;
const SUBDOMAIN_MIN_CLUSTER = 3;

function pass7Subdomains(graph: RepositoryGraph, modulesById: Map<string, ModuleInfo>): void {
  const domainIds = graph.byType.get('domain');
  if (!domainIds?.size) return;

  // Count tagged modules per domain so we can process biggest parents first. This way, when
  // `client-ui` (108 modules) and `ui` (108 same modules — UI files are tagged by both via
  // package + path) both could spawn a `dashboard` subdomain, the bigger parent claims it and
  // the smaller one skips on duplicate detection below.
  const taggedCount = (id: string): number =>
    (graph.inEdges.get(id) ?? []).filter(e => e.kind === 'tagged').length;

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

    const incoming = graph.inEdges.get(domainId) ?? [];
    const taggedModIds = incoming
      .filter(e => e.kind === 'tagged')
      .map(e => e.from)
      .filter(id => {
        const n = graph.nodes.get(id);
        return n?.type === 'module';
      });

    if (taggedModIds.length < SUBDOMAIN_MIN_MODULES) continue;

    const clusters = clusterByPathPrefix(taggedModIds, modulesById, node.label);

    const subdomains: string[] = [];
    for (const [subLabel, modIds] of clusters) {
      if (modIds.length < SUBDOMAIN_MIN_CLUSTER) continue;
      if (subLabel === node.label) continue;

      const subdomainId = `domain:${node.label}/${subLabel}`;
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

    const rel = mod.relativeFilePath.replace(/\.(tsx?|jsx?)$/, '');
    const parts = rel.split('/');

    const domainIdx = parts.findIndex(p => p.toLowerCase() === domainLabel);
    const afterDomain = domainIdx >= 0 ? parts.slice(domainIdx + 1) : parts;

    const meaningful = afterDomain.filter(
      p => !STRUCTURAL_DIRS_REF.has(p.toLowerCase()) && p !== 'index',
    );

    const subKey = meaningful.length > 0 ? meaningful[0].toLowerCase() : domainLabel;
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

  const incoming = graph.inEdges.get(domainId) ?? [];
  const taggedModuleIds = incoming.filter(e => e.kind === 'tagged').map(e => e.from);
  const modules = taggedModuleIds.filter(id => {
    const n = graph.nodes.get(id);
    return n?.type === 'module' || n?.type === 'runtime-resource';
  });

  const packages = new Set<string>();
  for (const modId of modules) {
    const containsEdge = (graph.inEdges.get(modId) ?? []).find(
      e => e.kind === 'contains' && e.from.startsWith('pkg:'),
    );
    if (containsEdge) packages.add(containsEdge.from);
  }

  if (modules.length >= 5 && packages.size >= 2) return 'business';
  if (modules.length >= 3 || (modules.length >= 2 && packages.size >= 2)) return 'feature';
  return 'technical';
}

function pass6ClassifyDomains(graph: RepositoryGraph): void {
  const domainIds = graph.byType.get('domain');
  if (!domainIds?.size) return;

  for (const domainId of domainIds) {
    const node = graph.nodes.get(domainId);
    if (!node || node.type !== 'domain') continue;
    const tier = classifyDomainTier(domainId, graph);
    node.data = { ...node.data, tier };
  }
}
