/**
 * Internal source-plugin bootstrap.
 *
 * Every built-in source plugin lives in `src/source-plugins/<lang>/` and default-exports a
 * `SourcePlugin`. This file holds the explicit list and registers each directly into the source
 * registry — no manifest/setup ceremony.
 *
 * To add a new built-in language: create `src/source-plugins/<name>/index.ts` that default-exports
 * a `SourcePlugin`, then add it to `INTERNAL_SOURCE_PLUGINS` below. Core code
 * (orchestrator/registry) does not need to change — mirror of `stage1/iac/bootstrap.ts`.
 *
 * Side-effect: bootstrapInternalSourcePlugins() is invoked once on first import.
 */

import type { SourcePlugin } from '@repovine/plugin-sdk';
import { registerSourcePlugin, setSourcePluginsForTest } from './registry.js';

import typescriptPlugin from '../../source-plugins/typescript/index.js';
import pythonPlugin from '../../source-plugins/python/index.js';

/**
 * Order matters only when two plugins could claim the same file (first registered wins). The
 * built-in set uses non-overlapping extensions (`.ts`/`.tsx`/… vs `.py`), so order is not
 * load-bearing today.
 */
const INTERNAL_SOURCE_PLUGINS: SourcePlugin[] = [
  typescriptPlugin,
  pythonPlugin,
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
