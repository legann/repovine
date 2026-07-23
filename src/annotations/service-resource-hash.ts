import { createHash } from 'node:crypto';
import type { RepositoryGraph, RepositoryFactsSnapshot } from '../types.js';
import { makeRuntimeResourceId } from '../graph/make-runtime-resource-id.js';

export interface RuntimeResourceContentHashLookup {
  resourceHashByServiceId: ReadonlyMap<string, string>;
  parentInfraContentHashById: ReadonlyMap<string, string>;
}

/**
 * One fingerprint for all declarations of a resource id: a single distinct hash is returned
 * verbatim; multiple distinct hashes reduce to sha256 over the sorted set (order-independent).
 */
function resourceSetHash(hashes: string[]): string {
  const distinct = [...new Set(hashes)].sort();
  if (distinct.length === 1) return distinct[0]!;
  return createHash('sha256').update(distinct.join('\n')).digest('hex').slice(0, 16);
}

export function buildRuntimeResourceContentHashLookup(
  snapshot: RepositoryFactsSnapshot,
): RuntimeResourceContentHashLookup {
  const declaredHashesByServiceId = new Map<string, string[]>();
  const parentInfraContentHashById = new Map<string, string>();
  for (const im of snapshot.infraModules ?? []) {
    parentInfraContentHashById.set(im.id, im.contentHash);
    for (const res of im.resources) {
      const serviceId = makeRuntimeResourceId(res);
      const declared = declaredHashesByServiceId.get(serviceId);
      if (declared) declared.push(res.contentHash);
      else declaredHashesByServiceId.set(serviceId, [res.contentHash]);
    }
  }
  const resourceHashByServiceId = new Map<string, string>();
  for (const [serviceId, declared] of declaredHashesByServiceId) {
    resourceHashByServiceId.set(serviceId, resourceSetHash(declared));
  }
  return { resourceHashByServiceId, parentInfraContentHashById };
}

/**
 * Hash of the parsed CloudFormation/SAM resource object (or k8s/helm/dockerfile payload) for this
 * logical resource; an id declared in several infra files resolves to the set-hash of all declarations.
 */
export function getResourceContentHashForServiceId(
  snapshot: RepositoryFactsSnapshot,
  serviceId: string,
  lookup?: RuntimeResourceContentHashLookup,
): string | undefined {
  const fromLookup = lookup?.resourceHashByServiceId.get(serviceId);
  if (fromLookup !== undefined) return fromLookup;
  const declared: string[] = [];
  for (const im of snapshot.infraModules ?? []) {
    for (const res of im.resources) {
      if (makeRuntimeResourceId(res) === serviceId) declared.push(res.contentHash);
    }
  }
  return declared.length > 0 ? resourceSetHash(declared) : undefined;
}

export function getParentInfraModuleId(graph: RepositoryGraph, serviceId: string): string | undefined {
  const inEdges = graph.inEdges.get(serviceId) ?? [];
  const contains = inEdges.find(e => e.kind === 'contains');
  return contains?.from;
}

export function getParentInfraContentHash(
  snapshot: RepositoryFactsSnapshot,
  parentInfraModuleId: string,
  lookup?: RuntimeResourceContentHashLookup,
): string | undefined {
  const fromLookup = lookup?.parentInfraContentHashById.get(parentInfraModuleId);
  if (fromLookup !== undefined) return fromLookup;
  return snapshot.infraModules?.find(m => m.id === parentInfraModuleId)?.contentHash;
}

/** Fingerprint used for service annotation freshness: per-resource hash from snapshot, else graph node data. */
export function resolveServiceResourceContentHash(
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  serviceId: string,
  lookup?: RuntimeResourceContentHashLookup,
): string | undefined {
  const fromSnapshot = getResourceContentHashForServiceId(snapshot, serviceId, lookup);
  if (fromSnapshot !== undefined) return fromSnapshot;
  const n = graph.nodes.get(serviceId);
  return n?.type === 'runtime-resource' ? n.data?.contentHash : undefined;
}
