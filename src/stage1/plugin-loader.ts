import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { logPipelineWarn } from '../cli/ui.js';
import {
  PLUGIN_API_VERSION,
  validateSemanticModuleDelta,
  validateSemanticInfraDelta,
} from '@repovine/plugin-sdk';
import type {
  SourcePlugin,
  SourceExtractInput,
  SourceExtractResult,
  IaCPluginDescriptor,
  IaCParser,
  SemanticInfraDelta,
} from '@repovine/plugin-sdk';
import {
  registerSourcePlugin,
  unregisterSourcePlugin,
  getRegisteredSourcePluginIds,
} from './source/registry.js';
import { registerIaCPlugin, unregisterIaCPlugin, getRegisteredIaCPluginIds } from './iac/registry.js';
import { getBuiltinSourcePluginIds, resetToBuiltinSourcePlugins } from './source/bootstrap.js';
import { getBuiltinIaCPluginIds, resetToBuiltinIaCPlugins } from './iac/bootstrap.js';

/**
 * External plugin loader.
 *
 * Resolves third-party source/IaC plugins from the ANALYZED repo's node_modules (same
 * mechanism in CLI, MCP, and embed), checks `apiVersion` against the SDK contract major, wraps their
 * fact output in Zod validation (`trusted:false`), and registers them alongside the bundled
 * preset. Arbitrary npm is never auto-installed — the user installs + lists a plugin in
 * `config.plugins`, which is their trust decision.
 *
 * The registries are process-global singletons, so every build re-derives the active set from a
 * clean built-in baseline (`resetToBuiltin*`) and re-applies `{defaults, add, disable}`. That makes
 * repeated builds with the same config idempotent (no double registration) in a long-lived MCP
 * process.
 */

/** `package.json#repovine` manifest a third-party plugin must declare. */
const RepovinePluginManifestSchema = z.object({
  kind: z.enum(['source-plugin', 'iac-plugin']),
  // Accept "1" or 1; compared as a number against PLUGIN_API_VERSION.
  apiVersion: z.union([z.string(), z.number()]),
  /** Entry module relative to the package dir. Falls back to package.json#main, then index.js. */
  entry: z.string().optional(),
});

export type RepovinePluginManifest = z.infer<typeof RepovinePluginManifestSchema>;

export interface PluginsConfigInput {
  defaults: boolean;
  add: string[];
  disable: string[];
}

export interface LoadedPlugin {
  name: string;
  id: string;
  kind: 'source-plugin' | 'iac-plugin';
}

export interface PluginLoadReport {
  loaded: LoadedPlugin[];
  refused: Array<{ name: string; reason: string }>;
  disabled: string[];
  defaultsOff: boolean;
  /** Ids of external source plugins loaded this run — the caller forces inline extraction for them
   *  (worker isolates only carry the bundled preset). */
  externalSourceIds: Set<string>;
}

interface ResolvedPluginPackage {
  manifest: RepovinePluginManifest;
  entryAbsPath: string;
  packageDir: string;
}

function resolvePluginPackage(repoRoot: string, name: string): ResolvedPluginPackage {
  // Resolve from the analyzed repo's node_modules, not from where repovine is installed.
  const requireFromRepo = createRequire(path.join(repoRoot, 'package.json'));
  let packageJsonPath: string;
  try {
    packageJsonPath = requireFromRepo.resolve(`${name}/package.json`);
  } catch {
    // Packages with a strict "exports" map may not expose package.json. Fall back to resolving the
    // entry and walking up to the nearest package.json.
    const entry = requireFromRepo.resolve(name);
    let dir = path.dirname(entry);
    while (dir !== path.dirname(dir) && !fs.existsSync(path.join(dir, 'package.json'))) {
      dir = path.dirname(dir);
    }
    packageJsonPath = path.join(dir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      throw new Error(`could not locate package.json for "${name}"`);
    }
  }

  const packageDir = path.dirname(packageJsonPath);
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
    repovine?: unknown;
    main?: string;
  };
  const parsed = RepovinePluginManifestSchema.safeParse(pkg.repovine);
  if (!parsed.success) {
    throw new Error(`missing/invalid "repovine" manifest in package.json (${parsed.error.issues[0]?.message ?? 'unknown'})`);
  }
  const entry = parsed.data.entry ?? pkg.main ?? 'index.js';
  return { manifest: parsed.data, entryAbsPath: path.resolve(packageDir, entry), packageDir };
}

/** Wrap an untrusted source plugin so each emitted module delta is Zod-validated; malformed deltas
 *  are dropped with a warning instead of poisoning the graph. */
function wrapUntrustedSourcePlugin(plugin: SourcePlugin): SourcePlugin {
  return {
    ...plugin,
    async extract(input: SourceExtractInput): Promise<SourceExtractResult> {
      const result = await plugin.extract(input);
      const deltas = result.deltas.filter(delta => {
        const v = validateSemanticModuleDelta(delta);
        if (!v.ok) {
          logPipelineWarn(`  ⚠ Plugin "${plugin.id}" emitted an invalid module delta (dropped): ${v.error}`);
        }
        return v.ok;
      });
      return { ...result, deltas };
    },
  };
}

/** Wrap an untrusted IaC parser so its emitted infra delta is Zod-validated; malformed output is
 *  treated as "no match" (null) with a warning. */
function wrapUntrustedParser(parser: IaCParser, pluginId: string): IaCParser {
  return {
    ...parser,
    parse(filePath: string, relPath: string, doc: unknown): SemanticInfraDelta | null {
      const out = parser.parse(filePath, relPath, doc);
      if (out === null) return null;
      const v = validateSemanticInfraDelta(out);
      if (!v.ok) {
        logPipelineWarn(`  ⚠ Plugin "${pluginId}" emitted an invalid infra delta (dropped): ${v.error}`);
        return null;
      }
      return out;
    },
  };
}

async function importDefaultExport(entryAbsPath: string): Promise<unknown> {
  const mod = (await import(pathToFileURL(entryAbsPath).href)) as { default?: unknown };
  return mod.default;
}

/** Load and register one external plugin by package name. Throws on any failure (caller records it). */
async function loadExternalPlugin(repoRoot: string, name: string): Promise<LoadedPlugin> {
  const { manifest, entryAbsPath } = resolvePluginPackage(repoRoot, name);

  // apiVersion gate — the single runtime compatibility check.
  if (Number(manifest.apiVersion) !== PLUGIN_API_VERSION) {
    throw new Error(
      `apiVersion ${String(manifest.apiVersion)} is incompatible with SDK v${PLUGIN_API_VERSION}`,
    );
  }

  const exported = await importDefaultExport(entryAbsPath);
  if (!exported || typeof exported !== 'object') {
    throw new Error('default export is not a plugin object');
  }

  if (manifest.kind === 'source-plugin') {
    const plugin = exported as SourcePlugin;
    if (typeof plugin.id !== 'string' || typeof plugin.extract !== 'function' || typeof plugin.discover !== 'function') {
      throw new Error('source-plugin default export is missing id/discover/extract');
    }
    registerSourcePlugin(wrapUntrustedSourcePlugin(plugin));
    return { name, id: plugin.id, kind: 'source-plugin' };
  }

  const descriptor = exported as IaCPluginDescriptor;
  if (typeof descriptor.id !== 'string' || !Array.isArray(descriptor.parsers)) {
    throw new Error('iac-plugin default export is missing id/parsers');
  }
  const wrapped: IaCPluginDescriptor = {
    ...descriptor,
    parsers: descriptor.parsers.map(p => wrapUntrustedParser(p, descriptor.id)),
  };
  registerIaCPlugin(wrapped);
  return { name, id: descriptor.id, kind: 'iac-plugin' };
}

/**
 * Apply `config.plugins` to the global registries for one build. Re-derives the active set from the
 * built-in baseline each call (idempotent), loads external `add[]` plugins from the analyzed repo,
 * and removes `disable[]` ids (and all built-ins when `defaults:false`).
 */
export async function applyPluginConfig(args: {
  repoRoot: string;
  config: PluginsConfigInput;
}): Promise<PluginLoadReport> {
  const { repoRoot, config } = args;

  // Clean, idempotent baseline: exactly the bundled preset, no prior externals.
  resetToBuiltinSourcePlugins();
  resetToBuiltinIaCPlugins();

  const report: PluginLoadReport = {
    loaded: [],
    refused: [],
    disabled: [],
    defaultsOff: config.defaults === false,
    externalSourceIds: new Set(),
  };

  // defaults:false → drop the entire bundled preset; the user must supply everything via `add`.
  if (config.defaults === false) {
    for (const id of getBuiltinSourcePluginIds()) unregisterSourcePlugin(id);
    for (const id of getBuiltinIaCPluginIds()) unregisterIaCPlugin(id);
  }

  // add[] → resolve + validate + register external plugins from the analyzed repo.
  for (const name of config.add) {
    try {
      const loaded = await loadExternalPlugin(repoRoot, name);
      report.loaded.push(loaded);
      if (loaded.kind === 'source-plugin') report.externalSourceIds.add(loaded.id);
    } catch (e) {
      const reason = (e as Error).message;
      report.refused.push({ name, reason });
      logPipelineWarn(`  ⚠ Skipping plugin "${name}": ${reason}.`);
    }
  }

  // disable[] → remove a plugin (bundled or added) by id from either registry.
  for (const id of config.disable) {
    const removed = unregisterSourcePlugin(id) || unregisterIaCPlugin(id);
    if (removed) {
      report.disabled.push(id);
      report.externalSourceIds.delete(id);
    } else {
      logPipelineWarn(`  ⚠ plugins.disable: "${id}" is not a registered plugin id.`);
    }
  }

  return report;
}

/** Test/diagnostic helper: current active plugin ids across both registries. */
export function getActivePluginIds(): { source: string[]; iac: string[] } {
  return { source: getRegisteredSourcePluginIds(), iac: getRegisteredIaCPluginIds() };
}
