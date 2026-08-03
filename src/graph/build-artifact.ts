import type { EntrypointFragment } from '../interpreter/types.js';
import type { Refusal } from '../response/refusal.js';
import type { RepositoryGraph } from '../types.js';
import { emptyExtensionStore, type ExtensionStore } from './extension-store.js';
import type { ContributorOutcome } from '../stage2/projection/compose.js';

/**
 * What one build produced, in one value.
 *
 * The graph is one of four outputs, not the whole result. Entrypoints are an index beside it,
 * namespaced extensions are a sidecar the graph algorithms never walk into, and refusals say what
 * is deliberately missing from all three. A reader handed only the graph cannot tell an empty
 * repository from a refused one, which is why these travel together.
 *
 * Internal: `@repovine/plugin-sdk` publishes the contribution and the extension record, never this.
 */
export interface RepositoryBuildArtifact {
  graph: RepositoryGraph;
  entrypoints: readonly EntrypointFragment[];
  extensions: ExtensionStore;
  refusals: readonly Refusal[];
  /** Which projectors ran, applied, skipped or failed, and what happened to each of their batches. */
  contributors: readonly ContributorOutcome[];
}

/**
 * Extensions this graph carries, keyed by the graph object.
 *
 * Process-local and keyed by object identity, exactly like the interpreter entrypoints and the
 * composition refusals: the worker's map does not survive structured clone, so the value is posted
 * across the boundary and re-keyed onto the cloned graph on the parent side.
 */
const extensionsByGraph = new WeakMap<RepositoryGraph, ExtensionStore>();

/** The extensions composition stored for this graph. Empty for a build with no projected ones. */
export function getGraphExtensions(graph: RepositoryGraph): ExtensionStore {
  return extensionsByGraph.get(graph) ?? emptyExtensionStore();
}

/** Re-key extensions onto a graph that crossed an isolate boundary. */
export function rememberGraphExtensions(graph: RepositoryGraph, extensions: ExtensionStore): void {
  extensionsByGraph.set(graph, extensions);
}

/**
 * What each projector achieved on this graph, keyed the same way.
 *
 * Refusals already carry every rejection with its cause. This carries the other half — which
 * contributors ran and applied — so a reader can tell a plugin that contributed nothing from one
 * that was never asked.
 */
const projectionReportByGraph = new WeakMap<RepositoryGraph, readonly ContributorOutcome[]>();

export function getProjectionReport(graph: RepositoryGraph): readonly ContributorOutcome[] {
  return projectionReportByGraph.get(graph) ?? [];
}

export function rememberProjectionReport(
  graph: RepositoryGraph,
  contributors: readonly ContributorOutcome[],
): void {
  projectionReportByGraph.set(graph, contributors);
}
