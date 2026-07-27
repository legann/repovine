/**
 * The content hash that answers for a graph node, resolved in one place.
 *
 * Freshness compares a stored annotation hash against "the current hash of this node", and which
 * hash that is depends on the node kind: a code module carries its own file hash, an IaC module
 * carries the parsed-file hash, a runtime resource carries the hash of its resource fragment, a
 * template carries its file hash, and a domain carries a roll-up over its members. {@link
 * resolveNodeContentHash} is the one dispatcher over those kinds; {@link hashedNodeKind} is the
 * enumerable list it dispatches on.
 */
import { createHash } from 'node:crypto';
import type {
  GraphEdge,
  ModuleInfo,
  RepositoryFactsSnapshot,
  RepositoryGraph,
} from '../types.js';
import type { PropagationConfig } from '../config.js';
import { domainLabelFromId } from '../graph/node-ids.js';
import { isAuthoredTag, isPackageOnlyDomain, isTaggedEdge } from '../graph/index.js';
import {
  buildRuntimeResourceContentHashLookup,
  resolveServiceResourceContentHash,
  type RuntimeResourceContentHashLookup,
} from './service-resource-hash.js';

/**
 * Node kinds that carry a content hash, and therefore an answerable freshness question.
 *
 * Enumerated at runtime so a consumer can be held to answering for each one: a new hashed kind
 * shows up as an unanswered case rather than as a node that silently has no hash.
 */
export const HASHED_NODE_KINDS = ['module', 'infra', 'runtime-resource', 'template', 'domain'] as const;

export type HashedNodeKind = typeof HASHED_NODE_KINDS[number];

/** Hashed kinds whose hash is read directly from stage-1 facts (no roll-up over other nodes). */
export const LEAF_HASHED_NODE_KINDS = ['module', 'infra', 'runtime-resource', 'template'] as const;

export type LeafHashedNodeKind = typeof LEAF_HASHED_NODE_KINDS[number];

/**
 * Which hashed kind a node id is, or `undefined` for a node type nothing hashes (export symbols,
 * packages, root).
 *
 * IaC modules are `type: 'module'` graph nodes under an `infra:` id and live in
 * `snapshot.infraModules`, so the id prefix is what separates them from code modules.
 */
export function hashedNodeKind(graph: RepositoryGraph, nodeId: string): HashedNodeKind | undefined {
  const node = graph.nodes.get(nodeId);
  if (!node) return undefined;
  if (nodeId.startsWith('infra:')) return 'infra';
  switch (node.type) {
    case 'module': return 'module';
    case 'runtime-resource': return 'runtime-resource';
    case 'template': return 'template';
    case 'domain': return 'domain';
    default: return undefined;
  }
}

export interface NodeContentHashLookup {
  moduleContentHashById: ReadonlyMap<string, string>;
  infraContentHashById: ReadonlyMap<string, string>;
  templateContentHashById: ReadonlyMap<string, string>;
  runtimeResourceHashes: RuntimeResourceContentHashLookup;
}

export function buildNodeContentHashLookup(
  snapshot: RepositoryFactsSnapshot,
): NodeContentHashLookup {
  const moduleContentHashById = new Map<string, string>();
  for (const m of snapshot.modules) moduleContentHashById.set(m.id, m.contentHash);
  const infraContentHashById = new Map<string, string>();
  for (const im of snapshot.infraModules ?? []) infraContentHashById.set(im.id, im.contentHash);
  const templateContentHashById = new Map<string, string>();
  for (const t of snapshot.templates ?? []) templateContentHashById.set(t.id, t.contentHash);
  return {
    moduleContentHashById,
    infraContentHashById,
    templateContentHashById,
    runtimeResourceHashes: buildRuntimeResourceContentHashLookup(snapshot),
  };
}

const LOOKUP_BY_SNAPSHOT = new WeakMap<RepositoryFactsSnapshot, NodeContentHashLookup>();

/**
 * Lookup maps for a snapshot, built once per snapshot object.
 *
 * A rebuild produces a new snapshot, so the cache retires with the facts it indexes. Single-node
 * callers get O(1) hash resolution without each of them building its own maps.
 */
export function nodeContentHashLookup(snapshot: RepositoryFactsSnapshot): NodeContentHashLookup {
  const cached = LOOKUP_BY_SNAPSHOT.get(snapshot);
  if (cached) return cached;
  const built = buildNodeContentHashLookup(snapshot);
  LOOKUP_BY_SNAPSHOT.set(snapshot, built);
  return built;
}

export function resolveModuleContentHash(
  snapshot: RepositoryFactsSnapshot,
  moduleId: string,
  contentHashById?: ReadonlyMap<string, string>,
): string | undefined {
  if (contentHashById) return contentHashById.get(moduleId);
  return snapshot.modules.find(m => m.id === moduleId)?.contentHash;
}

export function resolveTemplateContentHash(
  snapshot: RepositoryFactsSnapshot,
  templateId: string,
): string | undefined {
  return snapshot.templates?.find(t => t.id === templateId)?.contentHash;
}

export interface NodeContentHashSources {
  graph: RepositoryGraph;
  snapshot: RepositoryFactsSnapshot;
  /** Domain staleness policy; read only when the node is a domain. */
  propagation: PropagationConfig;
  /** Prebuilt hash maps; the per-snapshot cache is used when omitted. */
  lookup?: NodeContentHashLookup;
  /** Per-call memo for domain roll-ups, for callers that resolve many domains. */
  domainCache?: DomainContentHashCache;
}

/**
 * Current hash of a leaf node — one whose hash is a stage-1 fact rather than a roll-up.
 *
 * Split from {@link resolveNodeContentHash} because domain members are leaves by construction:
 * hashing a domain from its members must not re-enter the domain branch.
 */
export function resolveLeafNodeContentHash(
  nodeId: string,
  sources: Omit<NodeContentHashSources, 'propagation' | 'domainCache'>,
): string | undefined {
  const { graph, snapshot } = sources;
  const lookup = sources.lookup ?? nodeContentHashLookup(snapshot);
  const kind = hashedNodeKind(graph, nodeId);
  switch (kind) {
    case 'module': return lookup.moduleContentHashById.get(nodeId);
    case 'infra': return lookup.infraContentHashById.get(nodeId);
    case 'template': return lookup.templateContentHashById.get(nodeId);
    case 'runtime-resource':
      return resolveServiceResourceContentHash(graph, snapshot, nodeId, lookup.runtimeResourceHashes);
    default: return undefined;
  }
}

/** Current hash of any hashed node, by kind. `undefined` when the kind carries no hash. */
export function resolveNodeContentHash(
  nodeId: string,
  sources: NodeContentHashSources,
): string | undefined {
  const { graph, snapshot, propagation } = sources;
  const lookup = sources.lookup ?? nodeContentHashLookup(snapshot);
  if (hashedNodeKind(graph, nodeId) === 'domain') {
    return sources.domainCache
      ? resolveCachedDomainContentHash(graph, snapshot, nodeId, propagation, lookup, sources.domainCache)
      : resolveDomainContentHash(graph, snapshot, nodeId, propagation, lookup);
  }
  return resolveLeafNodeContentHash(nodeId, { graph, snapshot, lookup });
}

/**
 * Hash a pre-filtered set of tagged domain-member edges. Shared by the two domain
 * content-hash policies (full rollup vs path-only): they differ ONLY in which tagged
 * edges they pass in, never in how a member set is hashed. Order-independent — members
 * sort so the same set always yields the same hash. Returns the `'empty'` sentinel when
 * no member resolves to a content hash.
 */
function hashDomainMembers(
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  taggedEdges: GraphEdge[],
  lookup: NodeContentHashLookup,
): string {
  const members: Array<[string, string]> = [];
  for (const edge of taggedEdges) {
    const memberId = edge.from;
    const hash = resolveLeafNodeContentHash(memberId, { graph, snapshot, lookup });
    if (hash) members.push([memberId, hash]);
  }
  if (members.length === 0) return 'empty';

  members.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const payload = members.map(([id, h]) => `${id}:${h}`).join('\n');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * Compute a stable content hash for a domain node as a function of its tagged
 * member modules' contentHashes. Two members with the same set of module ids
 * and contentHashes always produce the same domain hash, regardless of insertion
 * order. Used to detect when a domain annotation has become stale because its
 * underlying members changed.
 *
 * Includes module, infra-module, runtime-resource and template nodes that participate in this domain.
 * Export symbols are excluded (already covered transitively via their parent module).
 */
export function computeDomainContentHash(
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  domainId: string,
  lookup?: NodeContentHashLookup,
): string | undefined {
  const node = graph.nodes.get(domainId);
  if (!node || node.type !== 'domain') return undefined;

  const taggedEdges = (graph.inEdges.get(domainId) ?? []).filter(isTaggedEdge);
  if (taggedEdges.length === 0) return 'empty'; // domain with no members — stable sentinel

  return hashDomainMembers(graph, snapshot, taggedEdges, lookup ?? nodeContentHashLookup(snapshot));
}

/**
 * Hash the authored members of a domain (path-only domain staleness): everything the path/pattern
 * collector or an untagged writer put there, without the members an import cluster or a package
 * name pulled in. A deliberately narrower scope than computeDomainContentHash;
 * `resolveDomainContentHash` selects between the two by `domainStalePolicy`, and unifying them
 * would re-flag path-only domains against persisted hashes.
 */
export function computeDomainContentHashForPathOnly(
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  domainId: string,
  lookup?: NodeContentHashLookup,
): string | undefined {
  const node = graph.nodes.get(domainId);
  if (!node || node.type !== 'domain') return undefined;

  const taggedEdges = (graph.inEdges.get(domainId) ?? []).filter(isAuthoredTag);
  if (taggedEdges.length === 0) return 'empty';

  return hashDomainMembers(graph, snapshot, taggedEdges, lookup ?? nodeContentHashLookup(snapshot));
}

/**
 * Domain content hash under the active propagation policy. `path-only` policy uses the path/pattern
 * scope for slashed (subdomain) or non-package-only domains, and the full rollup otherwise;
 * `all-tags` policy always uses the full rollup. This selection is load-bearing for staleness — the
 * two scopes are not interchangeable.
 */
export function resolveDomainContentHash(
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  domainId: string,
  propagation: PropagationConfig,
  lookup?: NodeContentHashLookup,
): string | undefined {
  if (propagation.domainStalePolicy === 'path-only') {
    const label = graph.nodes.get(domainId)?.label ?? domainLabelFromId(domainId);
    if (label.includes('/') || !isPackageOnlyDomain(graph, domainId)) {
      return computeDomainContentHashForPathOnly(graph, snapshot, domainId, lookup);
    }
  }
  return computeDomainContentHash(graph, snapshot, domainId, lookup);
}

export type DomainContentHashCache = Map<string, string | undefined>;

export function resolveCachedDomainContentHash(
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  domainId: string,
  propagation: PropagationConfig,
  lookup: NodeContentHashLookup,
  cache: DomainContentHashCache,
): string | undefined {
  const key = `${propagation.domainStalePolicy}\0${domainId}`;
  if (!cache.has(key)) {
    cache.set(key, resolveDomainContentHash(graph, snapshot, domainId, propagation, lookup));
  }
  return cache.get(key);
}

/** Direct module import targets (`imports` edges from moduleId). */
export function getDirectImportModuleIds(graph: RepositoryGraph, moduleId: string): string[] {
  const out = graph.outEdges.get(moduleId) ?? [];
  return out
    .filter(e => e.kind === 'imports' && e.to.startsWith('mod:'))
    .map(e => e.to);
}

/** Snapshot current direct-import content hashes for persisting on write/ack. */
export function computeImportBaseline(
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  moduleId: string,
  contentHashById?: ReadonlyMap<string, string>,
): Record<string, string> {
  const baseline: Record<string, string> = {};
  for (const targetId of getDirectImportModuleIds(graph, moduleId)) {
    const hash = resolveModuleContentHash(snapshot, targetId, contentHashById);
    if (hash) baseline[targetId] = hash;
  }
  return baseline;
}

/** Module ids this module imports whose current hash differs from the stored import baseline. */
export function importBaselineStaleUpstream(
  baseline: Record<string, string> | undefined,
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  moduleId: string,
  contentHashById?: ReadonlyMap<string, string>,
): string[] {
  const stale: string[] = [];
  for (const targetId of getDirectImportModuleIds(graph, moduleId)) {
    const current = resolveModuleContentHash(snapshot, targetId, contentHashById);
    if (!current) continue;
    if (!baseline || baseline[targetId] !== current) stale.push(targetId);
  }
  return stale;
}

/** Module facts by id, for callers that resolve many modules. */
export function buildModulesById(snapshot: RepositoryFactsSnapshot): ReadonlyMap<string, ModuleInfo> {
  const byId = new Map<string, ModuleInfo>();
  for (const mod of snapshot.modules ?? []) byId.set(mod.id, mod);
  return byId;
}
