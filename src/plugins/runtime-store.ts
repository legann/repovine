import type { RepositoryFactsSnapshot } from '../types.js';
import { emptyPluginRuntime, type PluginRuntime } from './runtime.js';

/**
 * The runtime that produced one snapshot, keyed by the snapshot object.
 *
 * The declaration half of a plugin travels on the snapshot as data. The capability half is code:
 * loaders and projectors are functions, and a function survives neither structured clone nor the
 * on-disk cache. So it stays here, process-local and keyed by object identity — the same shape the
 * interpreter entrypoints and the composition refusals already use.
 *
 * A lookup that finds nothing is the honest answer, not a gap to paper over: inside a worker
 * isolate, or against a snapshot restored from cache, there genuinely is no loaded plugin code.
 * Composition that needs contributors runs where they were loaded.
 */
const runtimeBySnapshot = new WeakMap<RepositoryFactsSnapshot, PluginRuntime>();

export function rememberPluginRuntime(snapshot: RepositoryFactsSnapshot, runtime: PluginRuntime): void {
  runtimeBySnapshot.set(snapshot, runtime);
}

/** The runtime that produced this snapshot, or an empty one when its code is not in this isolate. */
export function getPluginRuntime(snapshot: RepositoryFactsSnapshot): PluginRuntime {
  return runtimeBySnapshot.get(snapshot) ?? emptyPluginRuntime();
}
