import type { EntrypointFragment } from '../../interpreter/types.js';
import type { RepositoryGraph } from '../../types.js';

const interpreterEntrypointsByGraph = new WeakMap<RepositoryGraph, readonly EntrypointFragment[]>();

export function rememberInterpreterEntrypoints(
  graph: RepositoryGraph,
  entrypoints: readonly EntrypointFragment[],
): void {
  interpreterEntrypointsByGraph.set(graph, entrypoints.map(entry => ({ ...entry })));
}

export function getInterpreterEntrypoints(graph: RepositoryGraph): readonly EntrypointFragment[] {
  return interpreterEntrypointsByGraph.get(graph) ?? [];
}
