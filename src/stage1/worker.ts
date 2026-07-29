import { parentPort, workerData } from 'node:worker_threads';
import type { ModuleInfo, PackageInfo, PendingModule } from '../types.js';
import type { ReadonlyFactRecord } from '@repovine/plugin-sdk';
import { setPipelineLogSink } from '../cli/ui.js';
import { getSourcePlugin, getSourcePlugins } from '../plugin-host/source-set.js';
import { loadPluginSet, type PluginLoadSpec } from '../plugin-host/load.js';
import { runSourceExtraction } from './extract-runner.js';

interface WorkerInit {
  packages: PackageInfo[];
  absPathToIdEntries: [string, string][];
  repoRoot: string;
  extractContextEntries: [string, unknown][];
  analysisVersion: number;
  /** The set this isolate loads before it takes a job. */
  pluginSpec: PluginLoadSpec;
}

interface JobMessage {
  type: 'job';
  jobId: number;
  pkg: PackageInfo;
  sourcePluginId: string;
  pendingModules: PendingModule[];
  prevModuleEntries: [string, ModuleInfo][];
}

interface ShutdownMessage {
  type: 'shutdown';
}

type IncomingMessage = JobMessage | ShutdownMessage;

interface JobResultMessage {
  type: 'result';
  jobId: number;
  pkgName: string;
  modules: ModuleInfo[];
  reused: number;
  rescanned: number;
  /** Facts the shard's producer published, as data that survives the isolate boundary. */
  facts: ReadonlyFactRecord[];
  factRefusals: string[];
}

interface JobErrorMessage {
  type: 'error';
  jobId: number;
  pkgName: string;
  message: string;
  stack?: string;
}

if (!parentPort) {
  throw new Error('stage1 worker must be spawned via worker_threads');
}

// A worker thread shares the process stdout, which under the MCP server is the JSON-RPC channel.
// This isolate loads plugins and wraps their output, so it has warnings to emit — a refused package,
// a dropped delta — and every one of them would land in the protocol stream. Silence the pipeline
// sink and route stray console.log to stderr, the same treatment the Stage 2 worker gets.
setPipelineLogSink('silent');
console.log = (...args: unknown[]): void => console.error(...args);

const init = workerData as WorkerInit;
const packages = init.packages;
const absPathToId = new Map<string, string>(init.absPathToIdEntries);
const extractContextByPlugin = new Map<string, unknown>(init.extractContextEntries);
const repoRoot = init.repoRoot;
const analysisVersion = init.analysisVersion;

/**
 * This isolate's plugin set, loaded through the one loading path.
 *
 * Awaited before every job rather than at module scope: a message can arrive before a top-level
 * await settles, and a job that ran against an empty set would report a missing extractor for a
 * plugin the build has. The promise is created once, so the load happens once per isolate.
 *
 * A worker script is read from disk when the thread is spawned, so a long-lived process whose engine
 * was rebuilt underneath it spawns a new worker against an old control plane. That is the one way
 * `pluginSpec` goes missing, and it is worth saying out loud rather than failing on a destructure.
 */
const pluginsReady = init.pluginSpec
  ? loadPluginSet(init.pluginSpec)
  : Promise.reject(new Error(
    'stage1 worker received no plugin spec: the process that spawned it is running an older build '
    + 'of the engine than this worker script. Restart it after rebuilding or upgrading repovine.',
  ));
// The rejection is delivered per job (each handler awaits it); nothing else consumes it, and an
// unhandled rejection would take the whole process down instead.
pluginsReady.catch(() => undefined);

parentPort.on('message', (msg: IncomingMessage) => {
  void handleWorkerMessage(msg);
});

async function handleWorkerMessage(msg: IncomingMessage): Promise<void> {
  await pluginsReady;
  if (msg.type === 'shutdown') {
    // Kill any subprocess a plugin spawned during extraction (python AST) before this thread is torn
    // down, so a Worker.terminate() from the pool cannot orphan a child of the node process. Await so
    // the children are reaped by this loop rather than left as zombies.
    await Promise.all(getSourcePlugins().map(async plugin => {
      try { await plugin.terminateInFlight?.(); } catch { /* best-effort teardown */ }
    }));
    parentPort?.close();
    return;
  }
  const job = msg;
  try {
    const plugin = getSourcePlugin(job.sourcePluginId);
    if (!plugin) {
      throw new Error(`no source plugin registered for "${job.sourcePluginId}"`);
    }
    const result = await runSourceExtraction({
      plugin,
      repoRoot,
      packages,
      pendingModules: job.pendingModules,
      prevByPath: new Map(job.prevModuleEntries),
      absPathToId,
      extractContext: extractContextByPlugin.get(job.sourcePluginId),
      analysisVersion,
    });
    const reply: JobResultMessage = {
      type: 'result',
      jobId: job.jobId,
      pkgName: job.pkg.name,
      modules: result.modules,
      reused: result.reused,
      rescanned: result.rescanned,
      facts: result.facts,
      factRefusals: result.factRefusals,
    };
    parentPort!.postMessage(reply);
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    const reply: JobErrorMessage = {
      type: 'error',
      jobId: job.jobId,
      pkgName: job.pkg.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
    parentPort!.postMessage(reply);
  }
}
