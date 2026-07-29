import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { logPipelineWarn } from '../cli/ui.js';
import {
  PLUGIN_API_VERSION,
  stampDeclarationCatalog,
  validatePluginManifest,
  validatePluginRuntimeDescriptor,
  validateSemanticModuleDelta,
  validateSemanticInfraDelta,
} from '@repovine/plugin-sdk';
import type {
  IaCPluginDescriptor,
  IaCParser,
  PluginCapabilityName,
  PluginManifest,
  PluginRuntimeDescriptor,
  SemanticInfraDelta,
  SourcePlugin,
  SourceExtractInput,
  SourceExtractResult,
  StampedDeclarationCatalog,
} from '@repovine/plugin-sdk';
import {
  registerSourcePlugin,
  unregisterSourcePlugin,
  getRegisteredSourcePluginIds,
} from './source/registry.js';
import {
  registerIaCPlugin,
  registerResourceKindMeta,
  registerTriggerTypeMeta,
  unregisterIaCPlugin,
  getRegisteredIaCPluginIds,
} from './iac/registry.js';
import { getBuiltinSourcePluginIds, resetToBuiltinSourcePlugins } from './source/bootstrap.js';
import { getBuiltinIaCPluginIds, resetToBuiltinIaCPlugins } from './iac/bootstrap.js';

/**
 * Plugin loader.
 *
 * Resolves plugins from the ANALYZED repo's node_modules (same mechanism in CLI, MCP, and embed),
 * validates `package.json#repovine` against the SDK manifest schema, imports the entry module,
 * checks that the runtime descriptor claims the same id, and registers its capabilities. Arbitrary
 * npm is never auto-installed — the user installs + lists a plugin in `config.plugins`, which is
 * their trust decision.
 *
 * Ownership is host-stamped throughout. The plugin id comes from the manifest after the descriptor
 * confirms it, the package name and version come from package metadata, and declarations are
 * stamped from that identity — a payload never states who it belongs to.
 *
 * The registries are process-global singletons, so every build re-derives the active set from a
 * clean built-in baseline (`resetToBuiltin*`) and re-applies `{defaults, add, disable}`. That makes
 * repeated builds with the same config idempotent (no double registration) in a long-lived MCP
 * process.
 */

export interface PluginsConfigInput {
  defaults: boolean;
  add: string[];
  disable: string[];
}

export interface LoadedPlugin {
  /** npm package name as listed in `config.plugins.add`. */
  name: string;
  version: string;
  id: string;
  /** Capabilities the descriptor declared, in contract order. */
  capabilities: readonly PluginCapabilityName[];
  /** Declarations after the loader stamped package ownership onto every entry. */
  declarations: StampedDeclarationCatalog;
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
  manifest: PluginManifest;
  packageName: string;
  packageVersion: string;
  entryAbsPath: string;
  packageDir: string;
}

/** True when `child` is the package directory itself or lives under it. */
function isInsidePackage(packageDir: string, child: string): boolean {
  const rel = path.relative(packageDir, child);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Resolve symlinks so a link cannot point the entry out of the package it claims to be in. */
function realPathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
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
    name?: string;
    version?: string;
  };

  // One manifest schema for the whole product: the SDK declares it, the loader imports it, so an
  // author reading the SDK and the host reading the package cannot drift apart.
  const validated = validatePluginManifest(pkg.repovine);
  if (!validated.ok) {
    throw new Error(`invalid "repovine" manifest in package.json: ${validated.error}`);
  }

  // A declared entry is a package-root-relative POSIX path the SDK already parsed into segments;
  // `main` is npm's own field and keeps npm's spelling rules.
  const entryAbsPath = validated.entrySegments
    ? path.resolve(packageDir, ...validated.entrySegments)
    : path.resolve(packageDir, pkg.main ?? 'index.js');
  if (!isInsidePackage(realPathOrSelf(packageDir), realPathOrSelf(entryAbsPath))) {
    throw new Error('entry resolves outside the plugin package directory');
  }

  return {
    manifest: validated.manifest,
    packageName: pkg.name ?? name,
    packageVersion: pkg.version ?? '0.0.0',
    entryAbsPath,
    packageDir,
  };
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

/**
 * Register one descriptor's capabilities on the current pre-boundary registries.
 *
 * `loaders` and `projectors` are validated and reported here but not yet composed: document loading
 * and two-phase projection arrive with the composer, and a capability that silently did nothing
 * would be worse than one the report names.
 */
/**
 * Apply a stamped declaration catalog to the metadata registries.
 *
 * The declaration carries the composite `(namespace, provider, kind)` the contract defines; the
 * registry behind it still keys resource metadata by `kind` alone. Narrowing happens here, in the
 * pre-boundary path, so the composite key lands with the registry rewrite rather than reaching the
 * public contract as a single-component key.
 */
function applyDeclarations(catalog: StampedDeclarationCatalog): void {
  for (const declaration of catalog.resourceKinds) {
    registerResourceKindMeta(declaration.kind, {
      ...(declaration.hasCodeHandler === undefined ? {} : { hasCodeHandler: declaration.hasCodeHandler }),
    });
  }
  for (const declaration of catalog.triggerTypes) {
    registerTriggerTypeMeta(declaration.type, {
      ...(declaration.isStreamLike === undefined ? {} : { isStreamLike: declaration.isStreamLike }),
      ...(declaration.entrypointKind === undefined ? {} : { entrypointKind: declaration.entrypointKind }),
    });
  }
}

function registerCapabilities(
  descriptor: PluginRuntimeDescriptor,
  manifest: PluginManifest,
): void {
  const { capabilities } = descriptor;
  const lifecycle = {
    ...(descriptor.requires === undefined ? {} : { requires: descriptor.requires }),
    ...(descriptor.available === undefined ? {} : { available: descriptor.available.bind(descriptor) }),
  };

  if (capabilities.source) {
    registerSourcePlugin(wrapUntrustedSourcePlugin({
      ...capabilities.source,
      ...lifecycle,
      id: manifest.id,
      apiVersion: PLUGIN_API_VERSION,
    }));
  }

  if (capabilities.iac) {
    const iac: IaCPluginDescriptor = {
      ...lifecycle,
      id: manifest.id,
      apiVersion: PLUGIN_API_VERSION,
      parsers: capabilities.iac.parsers.map(parser => wrapUntrustedParser(parser, manifest.id)),
    };
    registerIaCPlugin(iac);
  }
}

/** Load and register one plugin by package name. Throws on any failure (caller records it). */
async function loadExternalPlugin(repoRoot: string, name: string): Promise<LoadedPlugin> {
  const resolved = resolvePluginPackage(repoRoot, name);

  const exported = await importDefaultExport(resolved.entryAbsPath);
  const descriptor = validatePluginRuntimeDescriptor(exported);
  if (!descriptor.ok) throw new Error(descriptor.error);

  // The manifest names the plugin and the descriptor must agree; neither side gets to rename the
  // other, and everything downstream reads the id the loader stamped.
  if (descriptor.descriptor.id !== resolved.manifest.id) {
    throw new Error(
      `descriptor id "${descriptor.descriptor.id}" does not match manifest id "${resolved.manifest.id}"`,
    );
  }

  const declarations = stampDeclarationCatalog(resolved.manifest.declarations, {
    pluginId: resolved.manifest.id,
    packageName: resolved.packageName,
    packageVersion: resolved.packageVersion,
  });
  applyDeclarations(declarations);
  registerCapabilities(descriptor.descriptor, resolved.manifest);

  return {
    name,
    version: resolved.packageVersion,
    id: resolved.manifest.id,
    capabilities: descriptor.declared,
    declarations,
  };
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
      if (loaded.capabilities.includes('source')) report.externalSourceIds.add(loaded.id);
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
