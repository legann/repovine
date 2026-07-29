/**
 * Temporary pre-boundary composition root for built-in source plugins.
 *
 * Every built-in source plugin lives in its own workspace package under `packages/plugins/` and
 * compiles against the public SDK alone. This file names those packages and registers what they
 * export directly into the source registry — the last place in the engine that knows a built-in by
 * name. Config-driven loading through the public plugin loader replaces it; until then this is the
 * one core file permitted to import a product package, and the workspace-boundary law says so by
 * naming it.
 *
 * Side-effect: bootstrapInternalSourcePlugins() is invoked once on first import.
 */

import type { SourcePlugin } from '@repovine/plugin-sdk';
import { typescriptSourcePlugin } from '@repovine/plugin-source-typescript';
import { pythonSourcePlugin } from '@repovine/plugin-source-python';
import { registerSourcePlugin, setSourcePluginsForTest } from './registry.js';

/**
 * Order matters only when two plugins could claim the same file (first registered wins). The
 * built-in set uses non-overlapping extensions (`.ts`/`.tsx`/… vs `.py`), so order is not
 * load-bearing today.
 */
const INTERNAL_SOURCE_PLUGINS: SourcePlugin[] = [
  typescriptSourcePlugin,
  pythonSourcePlugin,
];

let bootstrapped = false;

/** Register all built-in source plugins. Idempotent — safe to call from multiple entry-points. */
export function bootstrapInternalSourcePlugins(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  for (const plugin of INTERNAL_SOURCE_PLUGINS) {
    registerSourcePlugin(plugin);
  }
}

/** Ids of the built-in source plugins (the default preset). */
export function getBuiltinSourcePluginIds(): string[] {
  return INTERNAL_SOURCE_PLUGINS.map(p => p.id);
}

/**
 * Reset the source registry to exactly the built-in preset, dropping any externally-loaded plugins.
 * The external-plugin loader calls this to get a clean, idempotent baseline before applying
 * `plugins.{defaults,add,disable}` on each build (the registry is a process-global singleton).
 */
export function resetToBuiltinSourcePlugins(): void {
  setSourcePluginsForTest([...INTERNAL_SOURCE_PLUGINS]);
}

// Auto-invoke on first import — keeps the "side-effect import" pattern symmetric with IaC.
bootstrapInternalSourcePlugins();
