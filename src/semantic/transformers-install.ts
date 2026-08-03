/**
 * Where the optional `@huggingface/transformers` peer resolves from, if anywhere.
 *
 * Resolution and fs reads only — the module is never imported, because loading it pulls in an ONNX
 * runtime measured in hundreds of megabytes. That is what lets config resolution and `doctor` ask
 * "is the peer installed" without paying for it.
 *
 * A leaf on purpose: `embedder.ts` reads `DEFAULT_EMBEDDING_MODEL` from `config.ts`, so a probe
 * living there could not be read back by `config.ts` without an import cycle.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

export const TRANSFORMERS_PACKAGE = '@huggingface/transformers';

export interface TransformersInstallInfo {
  resolved: boolean;
  source?: 'repovine' | 'workspace';
  entryPath?: string;
  version?: string;
}

/**
 * Resolve the peer as the workspace would. Resolving from the workspace root is what makes
 * `npm install @huggingface/transformers` take effect for MCP clients that launch repovine
 * through npx.
 */
export function resolveTransformersFromWorkspace(workspaceRoot: string): string | undefined {
  try {
    const requireFromWorkspace = createRequire(path.join(workspaceRoot, 'package.json'));
    return requireFromWorkspace.resolve(TRANSFORMERS_PACKAGE);
  } catch {
    return undefined;
  }
}

/**
 * Package version read by walking up from the resolved entry path. The package's exports map does
 * not expose `./package.json` (ERR_PACKAGE_PATH_NOT_EXPORTED), so resolving that path directly is
 * not an option.
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

/**
 * Which install the runtime would load, mirroring the import order: next to repovine first,
 * workspace second. `createRequire` resolution can differ from ESM `import()` conditions in exotic
 * setups; acceptable for a diagnostic and for choosing a default.
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
