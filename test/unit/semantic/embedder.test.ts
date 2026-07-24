import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  createEmbedder,
  importTransformersFromWorkspace,
  resolveModelCacheDir,
  resolveTransformersFromWorkspace,
  __setTransformersModuleForTest,
} from '../../../src/semantic/embedder.js';

// The embed serializer and the per-model pipeline memo live at module scope, so two embedder
// instances (e.g. two live generations across a refresh / reloadConfig) share one inference serializer
// and one loaded model. Per-instance state would run concurrent ONNX inference and load the model twice.

type FakeExtractor = (texts: string[], opts: unknown) => Promise<{ tolist(): number[][] }>;

describe('LocalTransformersEmbedder module-scoped inference', () => {
  let pipelineCreations: number;
  let activeInference: number;
  let maxActiveInference: number;

  beforeEach(() => {
    pipelineCreations = 0;
    activeInference = 0;
    maxActiveInference = 0;
    const pipeline = async (): Promise<FakeExtractor> => {
      pipelineCreations++;
      return async (texts: string[]) => {
        activeInference++;
        maxActiveInference = Math.max(maxActiveInference, activeInference);
        await new Promise(resolve => setTimeout(resolve, 5));
        activeInference--;
        return { tolist: () => texts.map(() => [0.1, 0.2, 0.3]) };
      };
    };
    __setTransformersModuleForTest({ pipeline } as unknown as Parameters<typeof __setTransformersModuleForTest>[0]);
  });

  afterEach(() => {
    __setTransformersModuleForTest(undefined);
  });

  it('shares one serializer and one model pipeline across two embedder instances', async () => {
    const a = createEmbedder(true)!;
    const b = createEmbedder(true)!;
    expect(a).not.toBe(b);

    // Interleave embed calls across both instances: with a shared serializer none overlap.
    await Promise.all([
      a.embed(['a1']),
      b.embed(['b1']),
      a.embed(['a2']),
      b.embed(['b2']),
    ]);

    expect(maxActiveInference).toBe(1); // shared serializer → inference never overlaps across generations
    expect(pipelineCreations).toBe(1); // shared per-model memo → the model loads once, not once per instance
  });
});

// Under `npx -y repovine@<version>` — how every client plugin launches the MCP — the engine runs
// from the npx cache and a bare specifier never sees the workspace's node_modules. Resolving from
// the workspace root is the only way a user's `npm install @huggingface/transformers` takes effect.
describe('resolveTransformersFromWorkspace', () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
    tmpRoots.length = 0;
  });

  function workspace(withTransformers: boolean): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-embedder-'));
    tmpRoots.push(root);
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"workspace","version":"1.0.0"}\n');
    if (withTransformers) {
      const pkgDir = path.join(root, 'node_modules', '@huggingface', 'transformers');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        '{"name":"@huggingface/transformers","version":"3.8.1","main":"./index.cjs"}\n',
      );
      // Mirrors the real package's CJS build: the named export is not statically detectable,
      // so `pipeline` arrives only under `default` and the loader must unwrap ESM interop.
      fs.writeFileSync(
        path.join(pkgDir, 'index.cjs'),
        'const mod = { pipeline: () => {} };\nmodule.exports = mod;\n',
      );
    }
    return root;
  }

  it('resolves the package installed in the workspace, not next to the engine', () => {
    const root = workspace(true);

    const resolved = resolveTransformersFromWorkspace(root);

    expect(resolved).toBeDefined();
    expect(resolved!.startsWith(fs.realpathSync(root))).toBe(true);
    expect(path.basename(resolved!)).toBe('index.cjs');
  });

  it('returns undefined when the workspace does not carry the opt-in package', () => {
    expect(resolveTransformersFromWorkspace(workspace(false))).toBeUndefined();
  });

  it('loads the workspace package through ESM interop (require.resolve lands on the CJS build)', async () => {
    // The engine checkout carries the package as a devDependency, so a bare import always
    // succeeds here — only this direct call exercises the path an npx-launched MCP takes.
    const mod = await importTransformersFromWorkspace(workspace(true));

    expect(typeof mod?.pipeline).toBe('function');
  });

  it('loads nothing from a workspace without the package', async () => {
    expect(await importTransformersFromWorkspace(workspace(false))).toBeUndefined();
  });

  it('embedders for different workspaces do not share one resolution', async () => {
    // The pipeline memo is keyed by workspace + model; two workspaces must not reuse one load.
    let creations = 0;
    __setTransformersModuleForTest({
      pipeline: async () => {
        creations++;
        return async (texts: string[]) => ({ tolist: () => texts.map(() => [0.1]) });
      },
    } as unknown as Parameters<typeof __setTransformersModuleForTest>[0]);

    await createEmbedder(true, '/workspace/a')!.embed(['x']);
    await createEmbedder(true, '/workspace/b')!.embed(['x']);
    await createEmbedder(true, '/workspace/a')!.embed(['y']);

    expect(creations).toBe(2);
    __setTransformersModuleForTest(undefined);
  });
});

describe('model cache pinning', () => {
  const savedOverride = process.env.REPOVINE_MODEL_CACHE;
  afterEach(() => {
    if (savedOverride === undefined) delete process.env.REPOVINE_MODEL_CACHE;
    else process.env.REPOVINE_MODEL_CACHE = savedOverride;
    __setTransformersModuleForTest(undefined);
  });

  it('resolveModelCacheDir honors REPOVINE_MODEL_CACHE and defaults to a per-user path', () => {
    process.env.REPOVINE_MODEL_CACHE = path.join(os.tmpdir(), 'repovine-model-cache-test');
    expect(resolveModelCacheDir()).toBe(path.resolve(path.join(os.tmpdir(), 'repovine-model-cache-test')));

    delete process.env.REPOVINE_MODEL_CACHE;
    const fallback = resolveModelCacheDir();
    // Stable per-user location outside any node_modules; exact root is per-OS.
    expect(path.isAbsolute(fallback)).toBe(true);
    expect(fallback).not.toContain('node_modules');
    expect(fallback.split(path.sep)).toEqual(expect.arrayContaining(['repovine', 'models']));
  });

  it('pins env.cacheDir on the transformers module before creating a pipeline', async () => {
    const cacheTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-cache-pin-'));
    process.env.REPOVINE_MODEL_CACHE = cacheTarget;
    const fakeEnv: { cacheDir?: string } = {};
    __setTransformersModuleForTest({
      env: fakeEnv,
      pipeline: async () => async (texts: string[]) => ({ tolist: () => texts.map(() => [0.1]) }),
    } as unknown as Parameters<typeof __setTransformersModuleForTest>[0]);

    await createEmbedder(true, '/workspace/cache-pin')!.embed(['x']);
    expect(fakeEnv.cacheDir).toBe(path.resolve(cacheTarget));
  });
});
