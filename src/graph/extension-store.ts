import { makeResourceId } from '@repovine/plugin-sdk';
import type { ExtensionRecord, ProjectionRef } from '@repovine/plugin-sdk';
import { compareCodeUnits } from '../platform/ordering.js';

/**
 * Sidecar index for namespaced extensions.
 *
 * An extension is a fact with no canonical meaning yet. It is stored beside the graph rather than as
 * a node, so traversal, dependency and architecture algorithms never walk into a payload they cannot
 * interpret. Generic tools list and fetch records by owner and schema and show subject and
 * provenance; promoting one to a graph contract is a joint SDK/host decision, not a plugin's.
 *
 * The store is plain serializable data: it crosses the Stage 2 worker boundary, the dump and the
 * snapshot cache with the graph it describes.
 */
export interface ExtensionStore {
  /** Sorted by `(pluginId, schema, localKey)`; that order is the store's identity. */
  records: ExtensionRecord[];
}

export function emptyExtensionStore(): ExtensionStore {
  return { records: [] };
}

function recordOrder(a: ExtensionRecord, b: ExtensionRecord): number {
  return compareCodeUnits(
    `${a.pluginId}\0${a.schema}\0${a.localKey}`,
    `${b.pluginId}\0${b.schema}\0${b.localKey}`,
  );
}

/** Build a store from accepted records. Input order is not preserved: the store sorts. */
export function extensionStoreOf(records: readonly ExtensionRecord[]): ExtensionStore {
  return { records: [...records].sort(recordOrder) };
}

export interface ExtensionQuery {
  pluginId?: string;
  schema?: string;
}

export function listExtensions(
  store: ExtensionStore,
  query: ExtensionQuery = {},
): readonly ExtensionRecord[] {
  return store.records.filter(record =>
    (query.pluginId === undefined || record.pluginId === query.pluginId)
    && (query.schema === undefined || record.schema === query.schema));
}

export function getExtension(
  store: ExtensionStore,
  pluginId: string,
  schema: string,
  localKey: string,
): ExtensionRecord | undefined {
  return store.records.find(record =>
    record.pluginId === pluginId && record.schema === schema && record.localKey === localKey);
}

/**
 * The graph node a subject reference points at, or undefined when it points at another extension.
 *
 * Callers index extensions by the node a reader is looking at, so this is the one place a structured
 * reference becomes a node id.
 */
export function subjectNodeId(ref: ProjectionRef): string | undefined {
  if (ref.type === 'module') return ref.moduleId;
  if (ref.type === 'resource') return makeResourceId({ namespace: ref.namespace, localKey: ref.localKey });
  return undefined;
}

/** Records whose subject is this graph node, in store order. */
export function extensionsForNode(store: ExtensionStore, nodeId: string): readonly ExtensionRecord[] {
  return store.records.filter(record => record.subjectRef && subjectNodeId(record.subjectRef) === nodeId);
}

/** Owners and schemas present, for a generic listing that does not read payloads. */
export function extensionSchemas(store: ExtensionStore): Array<{ pluginId: string; schema: string; count: number }> {
  const counts = new Map<string, { pluginId: string; schema: string; count: number }>();
  for (const record of store.records) {
    const key = `${record.pluginId}\0${record.schema}`;
    const seen = counts.get(key);
    if (seen) seen.count += 1;
    else counts.set(key, { pluginId: record.pluginId, schema: record.schema, count: 1 });
  }
  return [...counts.values()].sort((a, b) =>
    compareCodeUnits(`${a.pluginId}\0${a.schema}`, `${b.pluginId}\0${b.schema}`));
}
