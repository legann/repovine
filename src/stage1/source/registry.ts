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

/**
 * Suffixes to strip when a path is reduced to a module NAME: the extensions plugins own plus the
 * suffixes they declare for module-id normalization. Sorted longest-first so a compound suffix
 * (`.d.ts`) strips whole instead of leaving a `.d` tail.
 */
export function getSourceStripSuffixes(): string[] {
  const suffixes = new Set<string>();
  for (const p of plugins) {
    for (const ext of p.capabilities?.extensions ?? []) suffixes.add(ext.toLowerCase());
    for (const suffix of p.capabilities?.moduleIdNormalize?.stripSuffixes ?? []) suffixes.add(suffix.toLowerCase());
  }
  return [...suffixes].sort((a, b) => b.length - a.length);
}

/**
 * Suffixes the module ID drops — only what each ecosystem declares in `moduleIdNormalize`, which
 * is a narrower list than {@link getSourceStripSuffixes}. Sorted longest-first for the same reason.
 *
 * The two lists differ where an ecosystem owns an extension it does not let the id drop. Vue and
 * Svelte are the live case: `+page.svelte` and `+page.ts` are two SvelteKit files in one directory,
 * so `.svelte` stays in the id and the two ids stay apart.
 */
export function getModuleIdStripSuffixes(): string[] {
  const suffixes = new Set<string>();
  for (const p of plugins) {
    for (const suffix of p.capabilities?.moduleIdNormalize?.stripSuffixes ?? []) suffixes.add(suffix.toLowerCase());
  }
  return [...suffixes].sort((a, b) => b.length - a.length);
}

/**
 * Basenames registered plugins declare as package/module markers (`index`, `__init__`). The name
 * marks a slot in the ecosystem's layout, so it carries no responsibility of its own.
 */
export function getSourceIndexBasenames(): string[] {
  const names = new Set<string>();
  for (const p of plugins) {
    for (const name of p.capabilities?.moduleIdNormalize?.indexBasenames ?? []) names.add(name.toLowerCase());
  }
  return [...names];
}

/**
 * Strip a registered source extension from a path or basename. Language-agnostic by construction:
 * every ecosystem is stripped by what its own plugin declares, so `main.py` reduces the same way
 * `main.ts` does and a name-derived label never carries an extension.
 *
 * This answers "what is this file called" — the input to a domain label or a responsibility key.
 * {@link stripModuleIdSuffix} answers the narrower "what does the module id keep".
 */
export function stripSourceExtension(value: string): string {
  return stripLongestSuffix(value, getSourceStripSuffixes());
}

/**
 * Reduce a path the way the module id does: drop only the suffixes the owning ecosystem declared
 * strippable, so the result is the id's own tail before the index basename collapses.
 *
 * A node's display label is built from this, which is why it is separate from
 * {@link stripSourceExtension}: a label that dropped a suffix the id keeps would give two SvelteKit
 * files in one directory (`+page.svelte`, `+page.ts`) one label and two ids.
 */
export function stripModuleIdSuffix(value: string): string {
  return stripLongestSuffix(value, getModuleIdStripSuffixes());
}

/** True when the path ends in an extension a registered source plugin owns. */
export function hasKnownSourceExtension(value: string): boolean {
  const lower = value.toLowerCase();
  return getKnownExtensions().some(ext => lower.endsWith(ext.toLowerCase()));
}

/**
 * Drop a trailing index basename an ecosystem declared (`/index`, `/__init__`), the way the module
 * id does. The input is expected to have lost its extension already — {@link stripModuleIdSuffix}
 * is the step before this one.
 */
export function stripIndexBasename(value: string): string {
  for (const basename of getSourceIndexBasenames()) {
    // Case-sensitive, because the mint is: `mintModuleId` compares the basename exactly, so
    // `Index.ts` is a plain module there and must be one here too.
    if (value.endsWith(`/${basename}`)) return value.slice(0, -(basename.length + 1));
  }
  return value;
}

function stripLongestSuffix(value: string, suffixes: readonly string[]): string {
  const lower = value.toLowerCase();
  for (const suffix of suffixes) {
    if (lower.endsWith(suffix)) return value.slice(0, -suffix.length);
  }
  return value;
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
