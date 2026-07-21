import type { RepositoryGraph, RepositoryFactsSnapshot } from '../types.js';
import { makeRuntimeResourceId } from '../graph/make-runtime-resource-id.js';

export interface RuntimeResourceContentHashLookup {
  resourceHashByServiceId: ReadonlyMap<string, string>;
  parentInfraContentHashById: ReadonlyMap<string, string>;
}

export function buildRuntimeResourceContentHashLookup(
  snapshot: RepositoryFactsSnapshot,
): RuntimeResourceContentHashLookup {
  const resourceHashByServiceId = new Map<string, string>();
  const parentInfraContentHashById = new Map<string, string>();
  for (const im of snapshot.infraModules ?? []) {
    parentInfraContentHashById.set(im.id, im.contentHash);
    for (const res of im.resources) {
      resourceHashByServiceId.set(makeRuntimeResourceId(res), res.contentHash);
    }
  }
  return { resourceHashByServiceId, parentInfraContentHashById };
}

/** Hash of the parsed CloudFormation/SAM resource object (or k8s/helm/dockerfile payload) for this logical resource. */
export function getResourceContentHashForServiceId(
  snapshot: RepositoryFactsSnapshot,
  serviceId: string,
  lookup?: RuntimeResourceContentHashLookup,
): string | undefined {
  const fromLookup = lookup?.resourceHashByServiceId.get(serviceId);
  if (fromLookup !== undefined) return fromLookup;
  const modules = snapshot.infraModules ?? [];
  for (const im of modules) {
    for (const res of im.resources) {
      if (makeRuntimeResourceId(res) === serviceId) {
        return res.contentHash;
      }
    }
  }
  return undefined;
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
