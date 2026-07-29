import type { PluginRuntimeDescriptor, ProjectionContributor } from '@repovine/plugin-sdk';
import { stampDeclarationCatalog } from '@repovine/plugin-sdk';
import { getActiveIaCPlugins, installIaCPlugins, type ActiveIaCPlugin } from '../../src/plugin-host/iac-set.js';
import { defaultPluginsConfig, loadPluginSet } from '../../src/plugin-host/load.js';
import { buildPluginRuntime } from '../../src/plugin-host/runtime.js';
import { rememberPluginRuntime } from '../../src/plugin-host/runtime-store.js';
import type { RepositoryFactsSnapshot } from '../../src/types.js';

/**
 * A package's published descriptor as the active set holds its IaC half.
 *
 * The loader does this after validating the descriptor; a test that imports a built-in package
 * directly skips the resolve and the import, so it does the same narrowing here.
 */
export function asActiveIaC(descriptor: PluginRuntimeDescriptor): ActiveIaCPlugin {
  const iac = descriptor.capabilities.iac;
  if (!iac) throw new Error(`plugin "${descriptor.id}" declares no iac capability`);
  return {
    id: descriptor.id,
    parsers: iac.parsers,
    ...(iac.kindDomains === undefined ? {} : { kindDomains: iac.kindDomains }),
  };
}

/**
 * Install one more IaC plugin beside the set this isolate already has.
 *
 * The engine installs a plugin set whole, because a build's set is what its config named. A test
 * that adds a fictional ecosystem to the bundled defaults is stating the same thing a config with an
 * `add` entry states, so it goes through the same install.
 */
export function installOneMore(plugin: ActiveIaCPlugin): void {
  installIaCPlugins([...getActiveIaCPlugins(), plugin]);
}

/**
 * Key a projector to a hand-built snapshot, the way the loader keys one to a real build.
 *
 * Projectors are code, so they travel beside the snapshot rather than on it. A test that composes a
 * snapshot it wrote itself has no loader to do that, and without it composition sees no contributor
 * and reports an honest empty projection.
 */
export function attachProjectors(
  snapshot: RepositoryFactsSnapshot,
  pluginId: string,
  projectors: readonly ProjectionContributor[],
): void {
  const owner = { pluginId, packageName: `@test/plugin-${pluginId}`, packageVersion: '0.0.0' };
  rememberPluginRuntime(snapshot, buildPluginRuntime({
    plugins: [{
      owner,
      capabilities: ['projectors'],
      declarations: stampDeclarationCatalog(undefined, owner),
      projectors,
    }],
  }));
}

/** Reload the bundled preset, dropping whatever a test installed on top of it. */
export async function restoreBuiltinPlugins(): Promise<void> {
  await loadPluginSet({ repoRoot: process.cwd(), config: defaultPluginsConfig() });
}
