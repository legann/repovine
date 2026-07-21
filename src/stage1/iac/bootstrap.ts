/**
 * Internal IaC plugin bootstrap.
 *
 * Every built-in IaC plugin lives in `src/iac-plugins/<vendor>/` and default-exports a declarative
 * `IaCPluginDescriptor` (authored via `defineIaCPlugin`). This file holds the explicit ordered list
 * and registers each as a unit — no manifest/setup ceremony, and the plugins never touch the
 * registry directly (the engine does, here and later in the loader).
 *
 * To add a new built-in: create `src/iac-plugins/<name>/index.ts` that default-exports a
 * `defineIaCPlugin({...})` descriptor, then add it to `INTERNAL_IAC_PLUGINS` below. Core code
 * (registry/utils) does not need to change.
 *
 * Side-effect: bootstrapInternalPlugins() is invoked once on first import so existing modules
 * that simply `import './iac/bootstrap.js'` get the same auto-register behavior.
 */

import { registerIaCPlugin, resetIaCParsers } from './registry.js';
import type { IaCPluginDescriptor } from '@repovine/plugin-sdk';

import samIacPlugin from '../../iac-plugins/sam/index.js';
import helmIacPlugin from '../../iac-plugins/helm/index.js';
import kubernetesIacPlugin from '../../iac-plugins/kubernetes/index.js';
import dockerComposeIacPlugin from '../../iac-plugins/docker-compose/index.js';
import dockerfileIacPlugin from '../../iac-plugins/dockerfile/index.js';
import terraformIacPlugin from '../../iac-plugins/terraform/index.js';
import vercelIacPlugin from '../../iac-plugins/vercel/index.js';

/**
 * Order matters: parsers are tried in registration order against each document. SAM must
 * register before kubernetes/helm so CloudFormation-shaped docs win over the k8s fallback.
 * Each plugin's own `parsers` array fixes its intra-plugin order (Helm: values before chart).
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
