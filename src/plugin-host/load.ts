import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { logPipelineWarn } from '../cli/ui.js';
import {
  PLUGIN_API_VERSION,
  installDirLayoutTable,
  stampDeclarationCatalog,
  validatePluginManifest,
  validatePluginRuntimeDescriptor,
  validatePresetManifest,
  validateSemanticModuleDelta,
  validateSemanticInfraDelta,
} from '@repovine/plugin-sdk';
import type {
  DocumentLoader,
  HostPath,
  IaCParser,
  PluginCapabilityName,
  PluginManifest,
  PluginOwnerIdentity,
  PluginRuntimeDescriptor,
  ProjectionContributor,
  SemanticInfraDelta,
  RepoRelPath,
  SourcePlugin,
  SourceExtractInput,
  SourceExtractResult,
  StampedDeclarationCatalog,
} from '@repovine/plugin-sdk';
import { installSourcePlugins, getActiveSourcePluginIds, getSourcePlugins } from './source-set.js';
import { installIaCPlugins, getActiveIaCPluginIds, type ActiveIaCPlugin } from './iac-set.js';
import { buildPluginRuntime, type PluginRuntime } from './runtime.js';
import { buildDeclarationCatalog, dirLayoutTableOf, type DeclarationCatalog } from './declaration-catalog.js';

/**
 * The one plugin loading path.
 *
 * Every plugin reaches the engine through this file: the bundled preset and an independently
 * installed package alike. One manifest schema, one entry-containment check, one descriptor
 * validation, one provenance stamp. The single difference is where the package is resolved from —
 * the engine's own installation for a bundled default, the analyzed repository for a package the
 * user installed and listed in `config.plugins.add`. Arbitrary npm is never auto-installed; listing
 * a plugin is the user's trust decision.
 *
 * Ownership is host-stamped throughout. The plugin id comes from the manifest after the descriptor
 * confirms it, the package name and version come from package metadata, and declarations are
 * stamped from that identity — a payload never states who it belongs to.
 *
 * The result has two halves with different transports. Declarations are data: they are merged into
 * the per-run catalog that travels on the snapshot, across both worker boundaries and into the
 * cache. Capabilities are code: the source and IaC sets are installed into this isolate, and loaders
 * and projectors are handed to composition as an argument. Every isolate that runs plugin code —
 * the control plane, the Stage 1 pool, the Stage 2 worker — calls this function with the same
 * serialisable spec, so a build's plugin set is the same set wherever it is read, and a build that
 * loaded an external plugin leaves nothing behind for the next build in the same process.
 */

export interface PluginsConfigInput {
  defaults: boolean;
  add: string[];
  disable: string[];
  /** Catalog keys this build retracts, in the spelling `src/plugin-host/declaration-catalog.ts` mints. */
  retract?: string[];
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
  /** What this build's plugin set declares and contributes. Rebuilt from nothing on every call. */
  runtime: PluginRuntime;
}

/**
 * Everything an isolate needs to reconstruct one build's plugin set.
 *
 * Serialisable by construction: it is what the workers receive. The set itself is code and cannot
 * cross a structured clone, so what crosses is the spec that produces it.
 */
export interface PluginLoadSpec {
  repoRoot: string;
  config: PluginsConfigInput;
}

/** The config a build with no `plugins` section runs under: the bundled preset, nothing added. */
export function defaultPluginsConfig(): PluginsConfigInput {
  return { defaults: true, add: [], disable: [] };
}

/** One loaded plugin as the per-run runtime consumes it: identity, declarations, live capabilities. */
interface RuntimeCandidate {
  owner: PluginOwnerIdentity;
  capabilities: readonly PluginCapabilityName[];
  declarations: StampedDeclarationCatalog;
  loaders?: readonly DocumentLoader[];
  projectors?: readonly ProjectionContributor[];
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

/**
 * Where a package name is resolved from.
 *
 * `repo` is the analyzed repository: a plugin the user installed there, listed in
 * `config.plugins.add`. `engine` is repovine's own installation, which is where the bundled preset
 * and its members live. Both are `createRequire` anchors and nothing else differs between them —
 * every check below runs the same way on either.
 */
type PackageOrigin = { kind: 'repo'; repoRoot: string } | { kind: 'engine' };

function requireFor(origin: PackageOrigin): NodeJS.Require {
  return origin.kind === 'repo'
    ? createRequire(path.join(origin.repoRoot, 'package.json'))
    : createRequire(import.meta.url);
}

function resolvePluginPackage(origin: PackageOrigin, name: string): ResolvedPluginPackage {
  const requireFromRepo = requireFor(origin);
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
    parse(absPath: HostPath, repoRelPath: RepoRelPath, doc: unknown): SemanticInfraDelta | null {
      const out = parser.parse(absPath, repoRelPath, doc);
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
 * One loaded plugin, ready to be installed: identity, declarations, and the live capability objects.
 *
 * Untrusted output is wrapped at this point rather than at the call site, so a bundled package and
 * an installed one are held to the same validation on every delta they emit.
 */
interface LoadedCapabilities {
  loaded: LoadedPlugin;
  candidate: RuntimeCandidate;
  source?: SourcePlugin;
  iac?: ActiveIaCPlugin;
}

function capabilitiesOf(
  descriptor: PluginRuntimeDescriptor,
  manifest: PluginManifest,
): { source?: SourcePlugin; iac?: ActiveIaCPlugin } {
  const { capabilities } = descriptor;
  const lifecycle = {
    ...(descriptor.requires === undefined ? {} : { requires: descriptor.requires }),
    ...(descriptor.available === undefined ? {} : { available: descriptor.available.bind(descriptor) }),
  };

  const source = capabilities.source === undefined
    ? undefined
    : wrapUntrustedSourcePlugin({
      ...capabilities.source,
      ...lifecycle,
      id: manifest.id,
      apiVersion: PLUGIN_API_VERSION,
    });

  const iac = capabilities.iac === undefined
    ? undefined
    : {
      id: manifest.id,
      parsers: capabilities.iac.parsers.map(parser => wrapUntrustedParser(parser, manifest.id)),
      ...(capabilities.iac.kindDomains === undefined
        ? {}
        : { kindDomains: capabilities.iac.kindDomains }),
      ...(capabilities.loaders === undefined ? {} : { loaders: capabilities.loaders }),
    };

  return {
    ...(source === undefined ? {} : { source }),
    ...(iac === undefined ? {} : { iac }),
  };
}

/**
 * Load one plugin package by name. Throws on any failure; the caller records it as a refusal.
 *
 * `origin` is the only parameter that distinguishes a bundled default from an installed package.
 * Everything after it — manifest schema, entry containment, descriptor validation, id agreement,
 * provenance stamp — is one code path for both.
 */
async function loadPlugin(origin: PackageOrigin, name: string): Promise<LoadedCapabilities> {
  const resolved = resolvePluginPackage(origin, name);

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

  const owner: PluginOwnerIdentity = {
    pluginId: resolved.manifest.id,
    packageName: resolved.packageName,
    packageVersion: resolved.packageVersion,
  };
  const declarations = stampDeclarationCatalog(resolved.manifest.declarations, owner);
  const live = capabilitiesOf(descriptor.descriptor, resolved.manifest);

  const { capabilities } = descriptor.descriptor;
  return {
    loaded: {
      name,
      version: resolved.packageVersion,
      id: resolved.manifest.id,
      capabilities: descriptor.declared,
      declarations,
    },
    candidate: {
      owner,
      capabilities: descriptor.declared,
      declarations,
      ...(capabilities.loaders === undefined ? {} : { loaders: capabilities.loaders }),
      ...(capabilities.projectors === undefined ? {} : { projectors: capabilities.projectors }),
    },
    ...live,
  };
}

/** The package name of the bundled preset. Its manifest names the plugins selected by default. */
export const DEFAULT_PRESET_PACKAGE = '@repovine/plugin-default-preset';

/**
 * The plugin packages the bundled preset selects.
 *
 * Read from the preset's `package.json`, not imported from it: a composition root that imported its
 * members would pull every implementation into the module graph of every isolate that asks which
 * packages are selected, including isolates that go on to load a different set. Names are data.
 */
function presetPluginNames(): { names: string[]; problem?: string } {
  try {
    const requireFromEngine = createRequire(import.meta.url);
    const packageJsonPath = requireFromEngine.resolve(`${DEFAULT_PRESET_PACKAGE}/package.json`);
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { repovine?: unknown };
    const validated = validatePresetManifest(pkg.repovine);
    if (!validated.ok) return { names: [], problem: `invalid preset manifest: ${validated.error}` };
    return { names: validated.manifest.plugins };
  } catch (e) {
    return { names: [], problem: (e as Error).message };
  }
}

/**
 * What the bundled preset declares, read without importing any plugin code.
 *
 * Declarations are the data half of a plugin: they live in `package.json#repovine` and the host
 * reads them before it imports anything. That makes the default catalog answerable synchronously,
 * which is what a caller holding a hand-built snapshot needs — it wants the facts a real build
 * carries, not the capabilities.
 */
export function presetDeclarationCatalog(): {
  catalog: DeclarationCatalog;
  problems: Array<{ name: string; reason: string }>;
} {
  const problems: Array<{ name: string; reason: string }> = [];
  const preset = presetPluginNames();
  if (preset.problem !== undefined) {
    problems.push({ name: DEFAULT_PRESET_PACKAGE, reason: preset.problem });
  }
  const catalogs: StampedDeclarationCatalog[] = [];
  for (const name of preset.names) {
    try {
      const resolved = resolvePluginPackage({ kind: 'engine' }, name);
      catalogs.push(stampDeclarationCatalog(resolved.manifest.declarations, {
        pluginId: resolved.manifest.id,
        packageName: resolved.packageName,
        packageVersion: resolved.packageVersion,
      }));
    } catch (e) {
      problems.push({ name, reason: (e as Error).message });
    }
  }
  return { catalog: buildDeclarationCatalog({ catalogs }), problems };
}

/**
 * Load one build's plugin set and install it in this isolate.
 *
 * The bundled preset is loaded first, in the order its manifest states, then `add[]` in config
 * order, then `disable[]` removes ids from whatever is present. `defaults:false` skips the preset
 * entirely: the user supplies everything, and a preset that is not loaded declares nothing.
 *
 * A plugin that fails to load is recorded and skipped, never fatal: what it would have contributed
 * is absent from the graph, and the refusal says so by name.
 */
export async function loadPluginSet(spec: PluginLoadSpec): Promise<PluginLoadReport> {
  const { repoRoot, config } = spec;

  const report: PluginLoadReport = {
    loaded: [],
    refused: [],
    disabled: [],
    defaultsOff: config.defaults === false,
    runtime: buildPluginRuntime({ plugins: [] }),
  };

  const candidates = new Map<string, RuntimeCandidate>();
  const sourcePlugins = new Map<string, SourcePlugin>();
  const iacPlugins = new Map<string, ActiveIaCPlugin>();

  const load = async (origin: PackageOrigin, name: string): Promise<void> => {
    try {
      const result = await loadPlugin(origin, name);
      report.loaded.push(result.loaded);
      candidates.set(result.loaded.id, result.candidate);
      if (result.source) sourcePlugins.set(result.loaded.id, result.source);
      if (result.iac) iacPlugins.set(result.loaded.id, result.iac);
    } catch (e) {
      const reason = (e as Error).message;
      report.refused.push({ name, reason });
      logPipelineWarn(`  ⚠ Skipping plugin "${name}": ${reason}.`);
    }
  };

  if (config.defaults !== false) {
    const preset = presetPluginNames();
    if (preset.problem !== undefined) {
      report.refused.push({ name: DEFAULT_PRESET_PACKAGE, reason: preset.problem });
      logPipelineWarn(`  ⚠ Default preset unavailable: ${preset.problem}.`);
    }
    for (const name of preset.names) await load({ kind: 'engine' }, name);
  }

  for (const name of config.add) await load({ kind: 'repo', repoRoot }, name);

  // disable[] → remove a plugin by id, whichever half of the set it landed in.
  //
  // A disabled plugin loses its capabilities and its declarations together. Declarations outliving a
  // disabled CAPABILITY is the lifetime rule; a disabled PLUGIN is gone, and a catalog entry with no
  // package behind it is the accumulation this runtime exists to prevent.
  for (const id of config.disable) {
    if (candidates.has(id)) {
      report.disabled.push(id);
      candidates.delete(id);
      sourcePlugins.delete(id);
      iacPlugins.delete(id);
      report.loaded = report.loaded.filter(entry => entry.id !== id);
    } else {
      logPipelineWarn(`  ⚠ plugins.disable: "${id}" is not a loaded plugin id.`);
    }
  }

  installSourcePlugins([...sourcePlugins.values()]);
  installIaCPlugins([...iacPlugins.values()]);

  report.runtime = buildPluginRuntime({
    plugins: [...candidates.values()],
    ...(config.retract === undefined ? {} : { retract: config.retract }),
  });
  // Where the walk stops, and what it stops at, are decided by the set that was just installed, so
  // the table is installed beside it: every producer of this build then prunes in the same places
  // and looks for the same package markers. Read back from the installed set rather than from the
  // array handed to the installer — a test that pinned its own producers has a set this build did
  // not resolve, and a table describing plugins the isolate is not running would send discovery
  // looking for the wrong markers.
  installDirLayoutTable(dirLayoutTableOf(report.runtime.catalog, getSourcePlugins()));
  return report;
}

/**
 * Load the plugin set once for a process that does not build a graph.
 *
 * `repovine doctor` and `repovine setup` read what the ecosystems declare — which interpreters are
 * required, which extensions are source — without ever collecting a snapshot. They are entrypoints
 * like any other, so they load the set through this path rather than reading an empty one.
 *
 * Idempotent per process: a second call while a set is installed is a no-op, and a build that
 * follows replaces the set with its own.
 */
let ensured: Promise<void> | undefined;

export function ensurePluginsLoaded(spec: PluginLoadSpec): Promise<void> {
  ensured ??= loadPluginSet(spec).then(() => undefined);
  return ensured;
}

/** Test/diagnostic helper: the plugin ids active in this isolate. */
export function getActivePluginIds(): { source: string[]; iac: string[] } {
  return { source: getActiveSourcePluginIds(), iac: getActiveIaCPluginIds() };
}
