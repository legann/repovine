/**
 * Temporary pre-boundary composition root for built-in IaC plugins.
 *
 * Every built-in IaC plugin lives in its own workspace package under `packages/plugins/` and
 * compiles against the public SDK alone. This file names those packages and registers what they
 * export directly into the IaC registry. Config-driven loading through the public plugin loader
 * replaces it; until then this is one of the two core files permitted to import a product package,
 * and the workspace-boundary law says so by naming it.
 *
 * Side-effect: bootstrapInternalPlugins() is invoked once on first import so existing modules
 * that simply `import './iac/bootstrap.js'` get the same auto-register behavior.
 */

import { registerIaCPlugin, resetIaCParsers } from './registry.js';
import type { IaCPluginDescriptor } from '@repovine/plugin-sdk';

import { samIacPlugin } from '@repovine/plugin-iac-sam';
import { helmIacPlugin } from '@repovine/plugin-iac-helm';
import { kubernetesIacPlugin } from '@repovine/plugin-iac-kubernetes';
import { dockerComposeIacPlugin } from '@repovine/plugin-iac-docker-compose';
import { dockerfileIacPlugin } from '@repovine/plugin-iac-dockerfile';
import { terraformIacPlugin } from '@repovine/plugin-iac-terraform';
import { vercelIacPlugin } from '@repovine/plugin-iac-vercel';

/**
 * The built-in set, in a fixed order so the registry reads the same on every host.
 *
 * Order is not precedence: a document is offered to every parser that claims its file, and a
 * disagreement is a refusal rather than a win for whoever registered first.
 */
const INTERNAL_IAC_PLUGINS: IaCPluginDescriptor[] = [
  samIacPlugin,
  helmIacPlugin,
  kubernetesIacPlugin,
  dockerComposeIacPlugin,
  dockerfileIacPlugin,
  terraformIacPlugin,
  vercelIacPlugin,
];

let bootstrapped = false;

/** Register all built-in IaC plugins. Idempotent — safe to call from multiple entry-points. */
export function bootstrapInternalPlugins(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  for (const plugin of INTERNAL_IAC_PLUGINS) {
    registerIaCPlugin(plugin);
  }
}

/** Ids of the built-in IaC plugins (the default preset). */
export function getBuiltinIaCPluginIds(): string[] {
  return INTERNAL_IAC_PLUGINS.map(p => p.id);
}

/**
 * Reset the IaC registry to exactly the built-in preset, dropping any externally-loaded parsers.
 * Called by the external-plugin loader for an idempotent baseline before applying
 * `plugins.{defaults,add,disable}` on each build. Order matches bootstrap (SAM before k8s/helm).
 */
export function resetToBuiltinIaCPlugins(): void {
  resetIaCParsers();
  for (const plugin of INTERNAL_IAC_PLUGINS) {
    registerIaCPlugin(plugin);
  }
}

// Auto-invoke on first import — keeps the legacy "side-effect import" pattern working so any
// module that does `import './bootstrap.js'` gets registrations for free.
bootstrapInternalPlugins();
