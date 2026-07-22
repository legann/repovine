/**
 * Local embedding backend for the semantic search layer.
 *
 * In-process ONNX inference via the OPT-IN `@huggingface/transformers` peer
 * dependency (~23 MB quantized MiniLM, downloaded on first use, offline after).
 * Installing repovine does not pull it; its ONNX runtime weighs ~700 MB.
 * No cloud APIs, no external daemons.
 *
 * The embedder ranks graph node cards for fuzzy queries; structure/impact tools
 * stay deterministic.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_EMBEDDING_MODEL } from '../config.js';
import { createSerializer } from './serialize.js';

export interface Embedder {
  /** Stable identity used for cache invalidation: `local:${model}`. */
  readonly id: string;
  /** Embed a batch of texts; returns one vector per input, in input order. */
  embed(texts: string[]): Promise<number[][]>;
}

/** Minimal surface of the transformers.js feature-extraction pipeline we rely on. */
type FeatureExtractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

type TransformersModule = {
  env?: { cacheDir?: string };
  pipeline: (
    task: 'feature-extraction',
    model: string,
    options?: {
      dtype?: string;
      session_options?: { logSeverityLevel?: number; intraOpNumThreads?: number; interOpNumThreads?: number };
    },
  ) => Promise<unknown>;
};

const TRANSFORMERS_PACKAGE = '@huggingface/transformers';
/** Explicit CPU dtype — avoids transformers.js "dtype not specified" console.warn on load. */
const PIPELINE_DTYPE = 'fp32';

// Module-scoped so every embedder instance shares them. A refresh / reloadConfig can leave two
// generations' embedders live at once; per-instance state would run concurrent ONNX inference and
// hold two copies of the model in RAM. One serializer bounds inference to one at a time process-wide;
// one pipeline promise per model loads each model once.
const embedSerialize = createSerializer();
const pipelineByModel = new Map<string, Promise<FeatureExtractor>>();

/** Test seam: inject a fake transformers module so embed paths run without the ONNX dependency.
 *  Clears the pipeline memo so the next load picks up the override. */
let transformersModuleOverride: TransformersModule | undefined;
export function __setTransformersModuleForTest(mod: TransformersModule | undefined): void {
  transformersModuleOverride = mod;
  pipelineByModel.clear();
}

/**
 * Absolute path of the transformers entry as resolved from the workspace, or undefined.
 *
 * A bare `import('@huggingface/transformers')` resolves next to repovine. Under
 * `npx -y repovine@<version>` repovine runs out of the npx cache, which never sees the
 * workspace's `node_modules` — the one place a user installs the opt-in package. Resolving
 * from the workspace root is what makes `npm install @huggingface/transformers` take effect
 * for MCP clients that launch repovine through npx.
 */
export function resolveTransformersFromWorkspace(workspaceRoot: string): string | undefined {
  try {
    const requireFromWorkspace = createRequire(path.join(workspaceRoot, 'package.json'));
    return requireFromWorkspace.resolve(TRANSFORMERS_PACKAGE);
  } catch {
    return undefined;
  }
}

export interface TransformersInstallInfo {
  resolved: boolean;
  source?: 'repovine' | 'workspace';
  entryPath?: string;
  version?: string;
}

/**
 * Diagnostic view of which transformers install the runtime would load, mirroring
 * the `importTransformers` order: next to repovine first, workspace second.
 * Resolution and fs reads only — the module is never imported (its ONNX runtime
 * init weighs ~700MB). `createRequire` resolution can differ from ESM `import()`
 * conditions in exotic setups; acceptable for a diagnostic.
 */
export function describeTransformersInstall(workspaceRoot: string): TransformersInstallInfo {
  let bare: string | undefined;
  try {
    bare = createRequire(import.meta.url).resolve(TRANSFORMERS_PACKAGE);
  } catch {
    bare = undefined;
  }
  if (bare) {
    return { resolved: true, source: 'repovine', entryPath: bare, version: readTransformersVersion(bare) };
  }
  const fromWorkspace = resolveTransformersFromWorkspace(workspaceRoot);
  if (fromWorkspace) {
    return { resolved: true, source: 'workspace', entryPath: fromWorkspace, version: readTransformersVersion(fromWorkspace) };
  }
  return { resolved: false };
}

/**
 * Package version read by walking up from the resolved entry path. The package's
 * exports map does not expose `./package.json` (ERR_PACKAGE_PATH_NOT_EXPORTED),
 * so `require.resolve('@huggingface/transformers/package.json')` is not an option.
 */
function readTransformersVersion(entryPath: string): string | undefined {
  let dir = path.dirname(entryPath);
  for (let i = 0; i < 6; i++) {
    try {
      const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf-8');
      const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
      if (parsed.name === TRANSFORMERS_PACKAGE) {
        return typeof parsed.version === 'string' ? parsed.version : undefined;
      }
    } catch {
      /* no readable package.json at this level — keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Load the transformers module from the workspace, or undefined when it is not installed there. */
export async function importTransformersFromWorkspace(workspaceRoot: string): Promise<TransformersModule | undefined> {
  const resolved = resolveTransformersFromWorkspace(workspaceRoot);
  if (!resolved) return undefined;
  const mod = await import(pathToFileURL(resolved).href) as TransformersModule & { default?: TransformersModule };
  // require.resolve picks the CJS build, whose exports arrive under `default` through ESM interop.
  return typeof mod.pipeline === 'function' ? mod : (mod.default as TransformersModule);
}

async function importTransformers(workspaceRoot: string): Promise<TransformersModule> {
  if (transformersModuleOverride) return transformersModuleOverride;
  try {
    // Dynamic specifier on purpose: semantic search can be disabled, and the package is an
    // opt-in peer — installing repovine does not pull it (it carries ~700MB of ONNX runtime).
    return await import(TRANSFORMERS_PACKAGE) as TransformersModule;
  } catch {
    // Not next to repovine. Fall back to the workspace, where the user installs it.
  }

  const fromWorkspace = await importTransformersFromWorkspace(workspaceRoot);
  if (fromWorkspace) return fromWorkspace;

  throw new Error(
    `semantic_search_embeddings requires the opt-in peer dependency ${TRANSFORMERS_PACKAGE}, `
    + `which installing repovine does not pull (~700MB ONNX runtime). `
    + `Install it in the workspace to enable embeddings: npm install ${TRANSFORMERS_PACKAGE} `
    + `(in ${workspaceRoot}), or set "semantic_search_embeddings": false to silence this`,
  );
}

/**
 * Stable per-user model cache. transformers.js defaults `env.cacheDir`
 * INSIDE its own install dir (`node_modules/@huggingface/transformers/.cache`):
 * ephemeral/read-only under the npx cache, long-path-exposed on Windows, and
 * re-downloaded per install. `REPOVINE_MODEL_CACHE` overrides; otherwise the
 * platform cache convention applies.
 */
export function resolveModelCacheDir(): string {
  const override = process.env.REPOVINE_MODEL_CACHE;
  if (override) return path.resolve(override);
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'repovine', 'models');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Caches', 'repovine', 'models');
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(home, '.cache'), 'repovine', 'models');
}

function applyModelCache(mod: TransformersModule): void {
  if (!mod.env) return; // test fakes and exotic builds without an env surface
  const dir = resolveModelCacheDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* unwritable — transformers will surface the download/cache error itself */
  }
  mod.env.cacheDir = dir;
}

function loadPipeline(model: string, workspaceRoot: string): Promise<FeatureExtractor> {
  // Resolution depends on the workspace, so the memo key does too.
  const key = `${workspaceRoot}::${model}`;
  let promise = pipelineByModel.get(key);
  if (!promise) {
    promise = (async () => {
      const mod = await importTransformers(workspaceRoot);
      applyModelCache(mod);
      return await mod.pipeline('feature-extraction', model, {
        dtype: PIPELINE_DTYPE,
        // Single-threaded ORT on darwin: onnxruntime-node 1.21 aborts at
        // process exit tearing down its intra-op pool (libc++ "mutex lock
        // failed" → SIGABRT); session dispose alone does not prevent it. With
        // no pool threads the teardown is trivially clean. Other platforms
        // keep default threading.
        session_options: {
          logSeverityLevel: 3,
          ...(process.platform === 'darwin' ? { intraOpNumThreads: 1, interOpNumThreads: 1 } : {}),
        },
      }) as FeatureExtractor;
    })();
    // On load failure drop the memo so a later call retries; guard against clobbering a newer promise.
    promise.catch(() => { if (pipelineByModel.get(key) === promise) pipelineByModel.delete(key); });
    pipelineByModel.set(key, promise);
  }
  return promise;
}

/**
 * Release every loaded ONNX session and clear the pipeline memo — exit-path
 * hygiene (frees native sessions/memory before the process goes down).
 * Serialized behind the embed limiter: an in-flight batch finishes before its
 * session is released. A later embed lazily reloads the pipeline.
 *
 * This alone does NOT prevent the macOS exit-teardown SIGABRT (onnxruntime's
 * global pool aborts in static destructors regardless); the darwin
 * single-thread session_options in loadPipeline is that mitigation.
 */
export async function disposeEmbedderPipelines(): Promise<void> {
  const pending = [...pipelineByModel.values()];
  if (pending.length === 0) return;
  pipelineByModel.clear();
  await embedSerialize(async () => {
    for (const p of pending) {
      try {
        const pipe = (await p) as unknown as { dispose?: () => Promise<void> };
        await pipe.dispose?.();
      } catch {
        /* pipeline load failed — nothing to release */
      }
    }
  });
}

class LocalTransformersEmbedder implements Embedder {
  readonly id: string;
  private readonly model: string;
  private readonly workspaceRoot: string;

  constructor(model: string, workspaceRoot: string) {
    this.model = model;
    this.workspaceRoot = workspaceRoot;
    this.id = `local:${model}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const extractor = await loadPipeline(this.model, this.workspaceRoot);
    // The pipeline load above is memoized+shared per model; the shared serializer bounds inference.
    return embedSerialize(async () => {
      const output = await extractor(texts, { pooling: 'mean', normalize: true });
      return output.tolist();
    });
  }
}

/**
 * Returns null when `semantic_search_embeddings` is false in config.
 *
 * `workspaceRoot` is where the opt-in `@huggingface/transformers` is looked up when it does
 * not sit next to repovine — the npx case, which is how every client plugin launches the MCP.
 */
export function createEmbedder(enabled: boolean, workspaceRoot: string = process.cwd()): Embedder | null {
  if (!enabled) return null;
  return new LocalTransformersEmbedder(DEFAULT_EMBEDDING_MODEL, workspaceRoot);
}
