import type { EntrypointFragment } from '../interpreter/types.js';
import type { PropagationConfig } from '../config.js';
import { DEFAULT_CONTRACT_HUB_THRESHOLDS } from '../config.js';
import type { ModuleInfo, RepositoryGraph, RepositoryFactsSnapshot, StoredAnnotation } from '../types.js';
import { modulePackageId } from '../analysis/architecture/scope.js';
import { importBaselineStaleUpstream } from './content-hash.js';
import { annotationFreshness, contentMoved } from './freshness.js';

function snapshotModules(snapshot: RepositoryFactsSnapshot): ModuleInfo[] {
  return snapshot.modules ?? [];
}

interface PropagationModuleLookup {
  modulesById: ReadonlyMap<string, ModuleInfo>;
  contentHashById: ReadonlyMap<string, string>;
}

const MODULE_LOOKUP_BY_SNAPSHOT = new WeakMap<RepositoryFactsSnapshot, PropagationModuleLookup>();

/** Module facts and hashes by id, built once per snapshot object and retired with it. */
function buildPropagationModuleLookup(snapshot: RepositoryFactsSnapshot): PropagationModuleLookup {
  const cached = MODULE_LOOKUP_BY_SNAPSHOT.get(snapshot);
  if (cached) return cached;
  const modulesById = new Map<string, ModuleInfo>();
  const contentHashById = new Map<string, string>();
  for (const mod of snapshotModules(snapshot)) {
    modulesById.set(mod.id, mod);
    contentHashById.set(mod.id, mod.contentHash);
  }
  const lookup = { modulesById, contentHashById };
  MODULE_LOOKUP_BY_SNAPSHOT.set(snapshot, lookup);
  return lookup;
}

export interface PropagationPreview {
  hard: string[];
  derived: string[];
  domains: string[];
  entrypoints: Array<{ id?: string; moduleId?: string; handlerModule?: string; kind: string; label?: string }>;
  entrypointRoots?: EntrypointRootsDiagnostics;
  warnings?: string[];
}

export interface PropagationSlice {
  anchor: string;
  path: string[];
  entrypointId?: string;
  reviewedAt: string;
}

export interface EntrypointRootsDiagnostics {
  moduleRoots: string[];
  handlerRoots: string[];
  total: number;
}

type AnnotationLookup = Record<string, StoredAnnotation> | { get(id: string): StoredAnnotation | undefined };

function resolveAnn(annotations: AnnotationLookup, id: string): StoredAnnotation | undefined {
  if ('get' in annotations && typeof annotations.get === 'function') {
    return annotations.get(id);
  }
  return (annotations as Record<string, StoredAnnotation>)[id];
}

function isModuleRoot(id: string | undefined): id is string {
  return typeof id === 'string' && id.startsWith('mod:');
}

/** Upstream module ids whose graph contentHash differs from stored importBaseline. */
export function getImportBaselineStaleUpstream(
  ann: StoredAnnotation,
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  moduleId: string,
  contentHashById?: ReadonlyMap<string, string>,
): string[] {
  return importBaselineStaleUpstream(ann.importBaseline, graph, snapshot, moduleId, contentHashById);
}

/**
 * True when the annotation still matches the module's own content but a module it imports moved
 * since the baseline was taken. Content- or schema-stale notes are excluded: they need a rewrite,
 * which subsumes upstream review.
 */
export function isDerivedStaleModule(
  ann: StoredAnnotation | undefined,
  mod: ModuleInfo,
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  contentHashById?: ReadonlyMap<string, string>,
): boolean {
  if (!ann) return false;
  if (annotationFreshness({ annotation: ann, currentHash: mod.contentHash }).state !== 'fresh') return false;
  return getImportBaselineStaleUpstream(ann, graph, snapshot, mod.id, contentHashById).length > 0;
}

/** Union of frontend `moduleId` and backend SAM `handlerModule` roots (mod: only). */
export function collectEntrypointRoots(entrypoints: readonly EntrypointFragment[]): Set<string> {
  const ids = new Set<string>();
  for (const ep of entrypoints) {
    if (isModuleRoot(ep.moduleId)) ids.add(ep.moduleId);
    const handlerModule = ep.handlerModule;
    if (isModuleRoot(typeof handlerModule === 'string' ? handlerModule : undefined)) {
      ids.add(handlerModule as string);
    }
  }
  return ids;
}

export function collectEntrypointRootsDiagnostics(
  entrypoints: readonly EntrypointFragment[],
): EntrypointRootsDiagnostics {
  const moduleRoots = new Set<string>();
  const handlerRoots = new Set<string>();
  for (const ep of entrypoints) {
    if (isModuleRoot(ep.moduleId)) moduleRoots.add(ep.moduleId);
    const handlerModule = ep.handlerModule;
    if (isModuleRoot(typeof handlerModule === 'string' ? handlerModule : undefined)) {
      handlerRoots.add(handlerModule as string);
    }
  }
  return {
    moduleRoots: [...moduleRoots].sort(),
    handlerRoots: [...handlerRoots].sort(),
    total: moduleRoots.size + handlerRoots.size,
  };
}

/**
 * Modules reachable from any entrypoint by following `imports` outEdges
 * (everything the app can load downward from an entrypoint).
 */
export function computeDepCone(
  graph: RepositoryGraph,
  entryModuleIds: Set<string>,
): Set<string> {
  const cone = new Set<string>();
  const queue = [...entryModuleIds];
  for (const id of queue) cone.add(id);

  let head = 0;
  while (head < queue.length) {
    const current = queue[head++]!;
    for (const edge of graph.outEdges?.get(current) ?? []) {
      if (edge.kind !== 'imports' || !edge.to.startsWith('mod:')) continue;
      if (!cone.has(edge.to)) {
        cone.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return cone;
}

/**
 * Consumer-direction BFS: follow importers (inEdges `imports`) until an entrypoint module is hit.
 */
export function reachesEntrypoint(
  graph: RepositoryGraph,
  moduleId: string,
  entryModuleIds: Set<string>,
  maxDepth: number,
): boolean {
  if (entryModuleIds.has(moduleId)) return true;

  const visited = new Set<string>([moduleId]);
  const queue: Array<{ id: string; depth: number }> = [{ id: moduleId, depth: 0 }];

  while (queue.length > 0) {
    const { id: current, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;

    for (const edge of graph.inEdges?.get(current) ?? []) {
      if (edge.kind !== 'imports' || !edge.from.startsWith('mod:')) continue;
      if (entryModuleIds.has(edge.from)) return true;
      if (!visited.has(edge.from)) {
        visited.add(edge.from);
        queue.push({ id: edge.from, depth: depth + 1 });
      }
    }
  }
  return false;
}

function getDirectImporters(graph: RepositoryGraph, moduleId: string): string[] {
  return (graph.inEdges?.get(moduleId) ?? [])
    .filter(e => e.kind === 'imports' && e.from.startsWith('mod:'))
    .map(e => e.from);
}

/** True when importer has importBaseline drift on a configured hub upstream. */
function importerHasHubBaselineDrift(
  importerId: string,
  hubId: string,
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  annotations: AnnotationLookup,
  moduleLookup: PropagationModuleLookup,
): boolean {
  const mod = moduleLookup.modulesById.get(importerId);
  if (!mod) return false;
  const ann = resolveAnn(annotations, importerId);
  if (!ann || !isDerivedStaleModule(ann, mod, graph, snapshot, moduleLookup.contentHashById)) return false;
  return getImportBaselineStaleUpstream(
    ann,
    graph,
    snapshot,
    importerId,
    moduleLookup.contentHashById,
  ).includes(hubId);
}

function exportNameSet(mod: ModuleInfo): Set<string> {
  return new Set(mod.exports.map(e => e.name));
}

/**
 * Hub content changed and export surface (export names) differs from annotation keyExports.
 * Same export names with comment-only body edits → false (hard hub only).
 */
export function isHubContractDrift(mod: ModuleInfo, ann: StoredAnnotation | undefined): boolean {
  if (!ann) return false;
  if (!contentMoved(annotationFreshness({ annotation: ann, currentHash: mod.contentHash }))) return false;
  const annotatedNames = Object.keys(ann.annotation.keyExports ?? {});
  if (annotatedNames.length === 0) return false;
  const current = exportNameSet(mod);
  const annotated = new Set(annotatedNames);
  if (current.size !== annotated.size) return true;
  for (const name of current) {
    if (!annotated.has(name)) return true;
  }
  return false;
}

export interface ContractHubThresholds {
  minCrossPackageFanIn: number;
  minImportance: number;
}

export function crossPackageFanIn(graph: RepositoryGraph, moduleId: string): number {
  const packages = new Set<string>();
  for (const edge of graph.inEdges?.get(moduleId) ?? []) {
    if (edge.kind !== 'imports' || !edge.from.startsWith('mod:')) continue;
    const pkg = modulePackageId(graph, edge.from);
    if (pkg) packages.add(pkg);
  }
  return packages.size;
}

function matchesContractPathHeuristic(mod: ModuleInfo): boolean {
  const path = mod.relativeFilePath || mod.id.replace(/^mod:[^/]+\//, '');
  if (/(^|\/)types(\/|$)|-types\.|api-client/.test(path)) return true;
  const pkg = mod.packageName.toLowerCase();
  return pkg.includes('shared') || pkg.endsWith('-shared');
}

export function isContractHubCandidate(
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  annotations: AnnotationLookup,
  moduleId: string,
  thresholds: ContractHubThresholds = DEFAULT_CONTRACT_HUB_THRESHOLDS,
  moduleLookup: PropagationModuleLookup = buildPropagationModuleLookup(snapshot),
): boolean {
  const mod = moduleLookup.modulesById.get(moduleId);
  if (!mod) return false;

  if (crossPackageFanIn(graph, moduleId) >= thresholds.minCrossPackageFanIn) return true;

  const ann = resolveAnn(annotations, moduleId);
  const keyExports = ann?.annotation.keyExports;
  if (keyExports && Object.keys(keyExports).length > 0) return true;

  const fanIn = (graph.inEdges?.get(moduleId) ?? []).filter(e => e.kind === 'imports').length;
  const fanOut = (graph.outEdges?.get(moduleId) ?? []).filter(e => e.kind === 'imports').length;
  const importance = fanIn + fanOut + mod.exports.length;
  if (importance >= thresholds.minImportance) return true;

  return matchesContractPathHeuristic(mod);
}

export function discoverContractHubs(input: {
  graph: RepositoryGraph;
  snapshot: RepositoryFactsSnapshot;
  annotations: AnnotationLookup;
  propagation: PropagationConfig;
  thresholds?: ContractHubThresholds;
}, moduleLookup = buildPropagationModuleLookup(input.snapshot)): Set<string> {
  const thresholds = input.thresholds ?? DEFAULT_CONTRACT_HUB_THRESHOLDS;
  const hubs = new Set<string>();
  for (const mod of snapshotModules(input.snapshot)) {
    if (isContractHubCandidate(
      input.graph,
      input.snapshot,
      input.annotations,
      mod.id,
      thresholds,
      moduleLookup,
    )) {
      hubs.add(mod.id);
    }
  }
  for (const extra of input.propagation.hubModulesExtra) hubs.add(extra);
  for (const deny of input.propagation.hubModulesDeny) hubs.delete(deny);
  return hubs;
}

export interface DerivedStaleInput {
  graph: RepositoryGraph;
  snapshot: RepositoryFactsSnapshot;
  annotations: AnnotationLookup;
  entrypoints: readonly EntrypointFragment[];
  propagation: PropagationConfig;
}

/** Answers the propagation question for one module at a time, over shared per-repository inputs. */
export interface DerivedStaleEvaluator {
  isStale(moduleId: string): boolean;
}

/**
 * The propagation rule, in one place, for one module or for all of them.
 *
 * A module is propagation-stale when its import baseline drifted AND the drift matters: either the
 * module is reachable from an entrypoint (the app can load it), or a drifted upstream is a contract
 * hub whose exported surface changed. Building the evaluator is cheap — the entrypoint dependency
 * cone and the hub set are computed on first use, so a single-node caller pays for them only when
 * that node actually has baseline drift.
 */
export function derivedStaleEvaluator(
  input: DerivedStaleInput,
  options: { precomputeHubs?: boolean } = {},
): DerivedStaleEvaluator {
  const { graph, snapshot, annotations, entrypoints, propagation } = input;
  const moduleLookup = buildPropagationModuleLookup(snapshot);
  const entryRoots = collectEntrypointRoots(entrypoints);
  const maxDepth = propagation.consumerReachMaxDepth;

  let depConeMemo: Set<string> | undefined;
  const depCone = (): Set<string> => (depConeMemo ??= computeDepCone(graph, entryRoots));

  let hubSetMemo: Set<string> | undefined;
  if (options.precomputeHubs) {
    hubSetMemo = discoverContractHubs({ graph, snapshot, annotations, propagation }, moduleLookup);
  }
  const hubExtra = new Set(propagation.hubModulesExtra);
  const hubDeny = new Set(propagation.hubModulesDeny);
  const isHub = (id: string): boolean => {
    if (hubSetMemo) return hubSetMemo.has(id);
    if (hubDeny.has(id)) return false;
    if (hubExtra.has(id)) return true;
    return isContractHubCandidate(
      graph,
      snapshot,
      annotations,
      id,
      DEFAULT_CONTRACT_HUB_THRESHOLDS,
      moduleLookup,
    );
  };
  // A drifted upstream widens review only when that same upstream is a hub whose export surface
  // changed. Hub-ness on one upstream and drift on another are not the same upstream, and reading
  // them together would widen on a hub that never moved.
  const hubContractDrift = (upstreamId: string): boolean => {
    if (!isHub(upstreamId)) return false;
    const hubMod = moduleLookup.modulesById.get(upstreamId);
    const hubAnn = resolveAnn(annotations, upstreamId);
    return !!hubMod && !!hubAnn && isHubContractDrift(hubMod, hubAnn);
  };

  return {
    isStale(moduleId: string): boolean {
      const mod = moduleLookup.modulesById.get(moduleId);
      if (!mod) return false;
      const ann = resolveAnn(annotations, moduleId);
      if (!isDerivedStaleModule(ann, mod, graph, snapshot, moduleLookup.contentHashById)) return false;

      const staleUpstream = getImportBaselineStaleUpstream(
        ann!,
        graph,
        snapshot,
        moduleId,
        moduleLookup.contentHashById,
      );
      if (staleUpstream.some(hubContractDrift)) return true;
      return depCone().has(moduleId) && reachesEntrypoint(graph, moduleId, entryRoots, maxDepth);
    },
  };
}

export function computeEntrypointBoundedDerived(input: DerivedStaleInput): Set<string> {
  const evaluator = derivedStaleEvaluator(input, { precomputeHubs: true });
  const narrow = new Set<string>();
  for (const mod of snapshotModules(input.snapshot)) {
    if (evaluator.isStale(mod.id)) narrow.add(mod.id);
  }
  return narrow;
}

/** The propagation verdict for a single module, without materializing the repository-wide set. */
export function isEntrypointBoundedDerivedStale(input: DerivedStaleInput, moduleId: string): boolean {
  return derivedStaleEvaluator(input).isStale(moduleId);
}

export function computePropagationPreview(input: {
  graph: RepositoryGraph;
  snapshot: RepositoryFactsSnapshot;
  annotations: AnnotationLookup;
  entrypoints: readonly EntrypointFragment[];
  propagation: PropagationConfig;
  from: string;
  includeDomains?: boolean;
}): PropagationPreview {
  const { graph, snapshot, annotations, entrypoints, propagation, from, includeDomains } = input;
  const warnings: string[] = [];

  const entryRoots = collectEntrypointRoots(entrypoints);
  const rootDiagnostics = collectEntrypointRootsDiagnostics(entrypoints);
  if (rootDiagnostics.total === 0) {
    warnings.push('No entrypoint module roots found on graph; narrow derived may under-propagate.');
  } else if (rootDiagnostics.handlerRoots.length === 0) {
    const hasRuntime = (graph.byType.get('runtime-resource')?.size ?? 0) > 0;
    if (hasRuntime) {
      warnings.push(
        'No handlerModule entrypoint roots found despite runtime-resource nodes; backend propagation may under-propagate. '
        + 'Check get_entrypoints({ layer: "backend" }) for unresolved handlers.',
      );
    }
  }

  const depCone = computeDepCone(graph, entryRoots);
  const hard = [from];
  const moduleLookup = buildPropagationModuleLookup(snapshot);
  const hubSet = discoverContractHubs({ graph, snapshot, annotations, propagation }, moduleLookup);
  const fromIsHub = hubSet.has(from);
  const fromMod = moduleLookup.modulesById.get(from);
  const fromAnn = resolveAnn(annotations, from);
  const fromHubContractDrift = fromMod && fromAnn ? isHubContractDrift(fromMod, fromAnn) : false;

  const directImporters = getDirectImporters(graph, from);
  const derived = new Set<string>();
  for (const importerId of directImporters) {
    const mod = moduleLookup.modulesById.get(importerId);
    const ann = resolveAnn(annotations, importerId);
    if (!mod || !ann) continue;

    if (fromIsHub && fromHubContractDrift && importerHasHubBaselineDrift(
      importerId,
      from,
      graph,
      snapshot,
      annotations,
      moduleLookup,
    )) {
      derived.add(importerId);
      continue;
    }

    const inCone = depCone.has(importerId);
    if (inCone && reachesEntrypoint(graph, importerId, entryRoots, propagation.consumerReachMaxDepth)) {
      if (isDerivedStaleModule(ann, mod, graph, snapshot, moduleLookup.contentHashById)) {
        derived.add(importerId);
      }
    }
  }

  let domains: string[] = [];
  if (includeDomains) {
    const outEdges = graph.outEdges?.get(from) ?? [];
    domains = outEdges
      .filter(e => e.kind === 'tagged' && e.to.startsWith('domain:'))
      .filter(e => {
        if (propagation.domainStalePolicy !== 'path-only') return true;
        const tagSource = e.metadata?.tagSource;
        if (tagSource === 'path' || tagSource === 'pattern') return true;
        const label = graph.nodes.get(e.to)?.label ?? e.to.replace(/^domain:/, '');
        return label.includes('/');
      })
      .map(e => graph.nodes.get(e.to)?.label ?? e.to.replace(/^domain:/, ''));
  }

  const entrypointsOut = entrypoints
    .filter(ep => {
      const moduleRoot = isModuleRoot(ep.moduleId) && entryRoots.has(ep.moduleId);
      const handlerRoot = isModuleRoot(typeof ep.handlerModule === 'string' ? ep.handlerModule : undefined)
        && entryRoots.has(ep.handlerModule as string);
      return moduleRoot || handlerRoot;
    })
    .map(ep => ({
      ...(ep.id ? { id: ep.id } : {}),
      ...(isModuleRoot(ep.moduleId) ? { moduleId: ep.moduleId } : {}),
      ...(isModuleRoot(typeof ep.handlerModule === 'string' ? ep.handlerModule : undefined)
        ? { handlerModule: ep.handlerModule as string }
        : {}),
      kind: ep.kind,
      ...(ep.label ? { label: ep.label } : {}),
    }));

  return {
    hard,
    derived: [...derived],
    domains,
    entrypoints: entrypointsOut,
    entrypointRoots: rootDiagnostics,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** Shortest importer chain from `from` to the nearest entrypoint module (for audit). */
export function buildPropagationSlice(input: {
  graph: RepositoryGraph;
  from: string;
  entrypoints: readonly EntrypointFragment[];
  maxDepth?: number;
  reviewedAt?: string;
}): PropagationSlice | undefined {
  const { graph, from, entrypoints, maxDepth = 32, reviewedAt } = input;
  const entryRoots = collectEntrypointRoots(entrypoints);
  if (entryRoots.size === 0) return undefined;

  if (entryRoots.has(from)) {
    return {
      anchor: from,
      path: [from],
      reviewedAt: reviewedAt ?? new Date().toISOString(),
    };
  }

  const parent = new Map<string, string>();
  const visited = new Set<string>([from]);
  const queue: Array<{ id: string; depth: number }> = [{ id: from, depth: 0 }];
  let targetEntry: string | undefined;

  while (queue.length > 0 && !targetEntry) {
    const { id: current, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;

    for (const edge of graph.inEdges?.get(current) ?? []) {
      if (edge.kind !== 'imports' || !edge.from.startsWith('mod:')) continue;
      const importer = edge.from;
      if (!visited.has(importer)) {
        visited.add(importer);
        parent.set(importer, current);
        if (entryRoots.has(importer)) {
          targetEntry = importer;
          break;
        }
        queue.push({ id: importer, depth: depth + 1 });
      }
    }
  }

  if (!targetEntry) return undefined;

  const path: string[] = [targetEntry];
  let cur = targetEntry;
  while (parent.has(cur)) {
    cur = parent.get(cur)!;
    path.unshift(cur);
  }

  const matchingEp = entrypoints.find(ep =>
    ep.moduleId === targetEntry
    || ep.handlerModule === targetEntry,
  );

  return {
    anchor: from,
    path,
    ...(matchingEp?.id ? { entrypointId: matchingEp.id } : {}),
    reviewedAt: reviewedAt ?? new Date().toISOString(),
  };
}
