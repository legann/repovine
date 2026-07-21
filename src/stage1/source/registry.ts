import type { SourcePlugin } from '@repovine/plugin-sdk';

/**
 * Mutable registry of source plugins. Built-in plugins register themselves at bootstrap
 * (see ./bootstrap.ts). External callers register additional plugins via registerSourcePlugin().
 *
 * Registration order matters when two plugins could claim the same file: the orchestrator
 * resolves ownership "first registered wins". In practice extensions should not overlap
 * (`.ts` vs `.py`), so order is rarely load-bearing.
 */
const plugins: SourcePlugin[] = [];

export function registerSourcePlugin(plugin: SourcePlugin): void {
  plugins.push(plugin);
}

/** Remove a registered source plugin by id (used by the external-plugin loader to apply
 *  `plugins.disable` and `plugins.defaults:false`). Returns true when one was removed. No-op when
 *  the id is not registered. */
export function unregisterSourcePlugin(id: string): boolean {
  const idx = plugins.findIndex(p => p.id === id);
  if (idx === -1) return false;
  plugins.splice(idx, 1);
  return true;
}

export function getSourcePlugins(): readonly SourcePlugin[] {
  return plugins;
}

/** Ids of all currently-registered source plugins, in registration order. */
export function getRegisteredSourcePluginIds(): string[] {
  return plugins.map(p => p.id);
}

export function getSourcePlugin(id: string): SourcePlugin | undefined {
  return plugins.find(p => p.id === id);
}

/** Test-only: replace all registered plugins. Returns a restore callback. */
export function setSourcePluginsForTest(next: SourcePlugin[]): () => void {
  const prev = plugins.splice(0, plugins.length, ...next);
  return () => {
    plugins.splice(0, plugins.length, ...prev);
  };
}

/** Return true when (base, ext) is matched by plugin.fileMatch. A plugin without fileMatch
 * claims nothing by extension — source plugins are expected to declare their file types. */
export function sourcePluginMatchesFile(plugin: SourcePlugin, base: string, ext: string): boolean {
  const fm = plugin.fileMatch;
  if (!fm) return false;
  if (fm.fileNames?.includes(base)) return true;
  if (fm.extensions?.includes(ext)) return true;
  if (fm.fileNamePatterns?.some(re => re.test(base))) return true;
  return false;
}

/** Logical id of the first registered plugin that claims this file, or undefined. */
export function pickSourcePluginIdForFile(base: string, ext: string): string | undefined {
  for (const p of plugins) {
    if (sourcePluginMatchesFile(p, base, ext)) return p.id;
  }
  return undefined;
}

/**
 * Capability aggregators — core asks these instead of hardcoding language ids/extensions.
 * Callers must ensure the registry is populated first (side-effect `import './bootstrap.js'`);
 * this module cannot import bootstrap itself without forming a registry↔bootstrap cycle.
 */

/** Union of `capabilities.extensions` across registered plugins. Capabilities-only on purpose:
 *  a plugin that declares `fileMatch` but no `capabilities` (e.g. an external plugin) contributes
 *  nothing here, matching the previous hardcoded set and leaving its ids un-normalized as before. */
export function getKnownExtensions(): string[] {
  const exts = new Set<string>();
  for (const p of plugins) {
    for (const ext of p.capabilities?.extensions ?? []) exts.add(ext);
  }
  return [...exts];
}

/** True when the module's owning plugin produces frontend surfaces. `undefined` id → true: a module
 *  with no source plugin is treated as frontend-capable, preserving module-kind's legacy
 *  `sourcePluginId === undefined` (TS-default) branch. */
export function pluginHasUiSurfaces(sourcePluginId: string | undefined): boolean {
  if (sourcePluginId === undefined) return true;
  return getSourcePlugin(sourcePluginId)?.capabilities?.uiSurfaces === true;
}

/** True when the plugin's package/dist names use PEP-503-style interchangeable `-` `_` `.`
 *  separators. `undefined` id → false (matches the previous `sourcePluginId === 'python'` check —
 *  note the asymmetry with pluginHasUiSurfaces, which defaults undefined to true). */
export function pluginUsesLooseNameSeparators(sourcePluginId: string | undefined): boolean {
  if (sourcePluginId === undefined) return false;
  return getSourcePlugin(sourcePluginId)?.capabilities?.looseNameSeparators === true;
}
