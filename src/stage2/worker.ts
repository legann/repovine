import { parentPort, workerData } from 'node:worker_threads';
import { setPipelineLogSink } from '../cli/ui.js';
import type { RepositoryFactsSnapshot } from '../types.js';
// Importing ./index.js also side-effect registers the built-in interpreters (its bootstrap import),
// so composeRepositoryGraph has the full interpreter set inside this isolate.
import { composeRepositoryGraph, getComposedRefusals } from './index.js';
import { getInterpreterEntrypoints } from './interpreter/entrypoint-store.js';
import { getGraphExtensions, getProjectionReport } from '../graph/build-artifact.js';

if (!parentPort) {
  throw new Error('stage2 worker must be spawned via worker_threads');
}

// Protect the parent's MCP JSON-RPC channel (its stdout): silence pipeline logging and route any
// stray console.log to stderr, so nothing this isolate emits can corrupt the protocol stream.
setPipelineLogSink('silent');
console.log = (...args: unknown[]): void => console.error(...args);

try {
  const { snapshot } = workerData as { snapshot: RepositoryFactsSnapshot };
  // modulesById is rebuilt from snapshot.modules inside composeRepositoryGraph — only the snapshot
  // crosses the worker boundary.
  const graph = composeRepositoryGraph(snapshot);
  // Interpreter entrypoints live in a process-local WeakMap keyed by the graph object; structured
  // clone gives the parent a NEW graph object with no WeakMap entry, so carry them over the boundary
  // explicitly (the parent re-remembers them against the cloned graph).
  // Refusals composition made live in a process-local map keyed by the graph object, for the same
  // reason the entrypoints do, and cross the boundary the same way.
  parentPort.postMessage({
    type: 'ok',
    graph,
    entrypoints: getInterpreterEntrypoints(graph),
    refusals: getComposedRefusals(graph),
    extensions: getGraphExtensions(graph),
    contributors: getProjectionReport(graph),
  });
} catch (e) {
  const error = e instanceof Error ? e : new Error(String(e));
  parentPort.postMessage({ type: 'error', message: error.message, stack: error.stack });
}
// The result is queued; stop the port from keeping this isolate alive so it exits on its own.
parentPort.unref();
