import type { SourcePlugin } from '@repovine/plugin-sdk';

/**
 * The source plugins active in this isolate, as the one loading path installed them.
 *
 * Nothing registers itself here. `src/plugin-host/load.ts` resolves a build's plugin set — bundled and
 * independently installed alike — and installs it whole; the next build replaces it whole. Every
 * isolate that runs plugin code, including both worker pools, installs its own set from the same
 * serialisable spec, so a build's active set is the same set wherever it is read.
 *
 * The set is ordered by the loading path (preset order, then config order). Order decides ownership
 * only when two plugins claim one file, and the bundled set uses non-overlapping extensions
 * (`.ts`/`.tsx` vs `.py`), so it is not load-bearing there.
 *
 * Language metadata is read from here outside a build too — module ids, domain labels and MCP scope
 * resolution all reduce a path by what the owning ecosystem declared — which is why the set is
 * ambient rather than threaded: a reader asks what is loaded, not who loaded it.
 */
let plugins: SourcePlugin[] = [];

/**
 * Set while a test pins the set to producers it constructed in process.
 *
 * A build installs its own set, which is the point: the set is what the config named. A test that
 * exercises the engine against a hand-written producer has no package to name, so it pins the set
 * and the build's install becomes a no-op until the pin is released. Nothing in `src/**` sets this.
 */
let pinned = false;

/** Install this build's source plugins, replacing whatever the previous build installed. */
export function installSourcePlugins(next: readonly SourcePlugin[]): void {
  if (pinned) return;
  plugins = [...next];
}

export function getSourcePlugins(): readonly SourcePlugin[] {
  return plugins;
}

/** Ids of the active source plugins, in installed order. */
export function getActiveSourcePluginIds(): string[] {
  return plugins.map(p => p.id);
}

export function getSourcePlugin(id: string): SourcePlugin | undefined {
  return plugins.find(p => p.id === id);
}

/** Test-only: pin the set to these producers. The returned callback restores and unpins. */
export function setSourcePluginsForTest(next: SourcePlugin[]): () => void {
  const prev = plugins;
  const wasPinned = pinned;
  plugins = [...next];
  pinned = true;
  return () => {
    plugins = prev;
    pinned = wasPinned;
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
 *
 * They answer over the installed set, so a caller that reads them before the loading path ran gets
 * the empty answer: no extension is known and no suffix is stripped. Every entrypoint installs the
 * set before it reads one (`src/plugin-host/load.ts`, `ensurePluginsLoaded`).
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
