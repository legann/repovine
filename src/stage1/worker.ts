import { parentPort, workerData } from 'node:worker_threads';
import type { ModuleInfo, PackageInfo, PendingModule } from '../types.js';
import type { ReadonlyFactRecord } from '@repovine/plugin-sdk';
// Side-effect: register built-in source plugins in this worker thread before extraction.
import './source/bootstrap.js';
import { getSourcePlugin, getSourcePlugins } from './source/registry.js';
import { runSourceExtraction } from './source/extract-runner.js';

interface WorkerInit {
  packages: PackageInfo[];
  absPathToIdEntries: [string, string][];
  repoRoot: string;
  extractContextEntries: [string, unknown][];
  analysisVersion: number;
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

const init = workerData as WorkerInit;
const packages = init.packages;
const absPathToId = new Map<string, string>(init.absPathToIdEntries);
const extractContextByPlugin = new Map<string, unknown>(init.extractContextEntries);
const repoRoot = init.repoRoot;
const analysisVersion = init.analysisVersion;

parentPort.on('message', (msg: IncomingMessage) => {
  void handleWorkerMessage(msg);
});

async function handleWorkerMessage(msg: IncomingMessage): Promise<void> {
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
