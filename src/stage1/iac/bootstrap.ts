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

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { registerIaCPlugin, resetIaCParsers } from './registry.js';
import { stampDeclarationCatalog, validatePluginManifest } from '@repovine/plugin-sdk';
import type {
  IaCPluginDescriptor,
  PluginOwnerIdentity,
  StampedDeclarationCatalog,
} from '@repovine/plugin-sdk';

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
 *
 * Each entry names the package its descriptor came from, because that package's `package.json` is
 * where its declarations and its identity are read from.
 */
const INTERNAL_IAC_PLUGINS: Array<{ packageName: string; descriptor: IaCPluginDescriptor }> = [
  { packageName: '@repovine/plugin-iac-sam', descriptor: samIacPlugin },
  { packageName: '@repovine/plugin-iac-helm', descriptor: helmIacPlugin },
  { packageName: '@repovine/plugin-iac-kubernetes', descriptor: kubernetesIacPlugin },
  { packageName: '@repovine/plugin-iac-docker-compose', descriptor: dockerComposeIacPlugin },
  { packageName: '@repovine/plugin-iac-dockerfile', descriptor: dockerfileIacPlugin },
  { packageName: '@repovine/plugin-iac-terraform', descriptor: terraformIacPlugin },
  { packageName: '@repovine/plugin-iac-vercel', descriptor: vercelIacPlugin },
];

let bootstrapped = false;

/** Register all built-in IaC plugins. Idempotent — safe to call from multiple entry-points. */
export function bootstrapInternalPlugins(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  for (const { descriptor } of INTERNAL_IAC_PLUGINS) {
    registerIaCPlugin(descriptor);
  }
}

/** Ids of the built-in IaC plugins (the default preset). */
export function getBuiltinIaCPluginIds(): string[] {
  return INTERNAL_IAC_PLUGINS.map(p => p.descriptor.id);
}

/**
 * Reset the IaC registry to exactly the built-in preset, dropping any externally-loaded parsers.
 * Called by the external-plugin loader for an idempotent baseline before applying
 * `plugins.{defaults,add,disable}` on each build. Order matches bootstrap (SAM before k8s/helm).
 */
export function resetToBuiltinIaCPlugins(): void {
  resetIaCParsers();
  for (const { descriptor } of INTERNAL_IAC_PLUGINS) {
    registerIaCPlugin(descriptor);
  }
}

/* ---------------------------- declarations ---------------------------- */

/** One built-in's package identity and the declarations stamped with it. */
export interface BuiltinDeclarations {
  owner: PluginOwnerIdentity;
  declarations: StampedDeclarationCatalog;
}

export interface BuiltinDeclarationProblem {
  packageName: string;
  reason: string;
}

export interface BuiltinDeclarationsResult {
  entries: BuiltinDeclarations[];
  /** Packages whose declarations could not be read. What they would have declared is absent. */
  problems: BuiltinDeclarationProblem[];
}

let builtinDeclarationsCache: BuiltinDeclarationsResult | undefined;

/**
 * Declarations of the built-in IaC plugins, read from the same `package.json#repovine` an external
 * package publishes.
 *
 * A built-in's metadata is data, so it is read from its package rather than stamped from a value in
 * engine code: one file states the package name, its version and what it declares, and nothing here
 * has a second spelling of any of them to drift from.
 *
 * Lazy and memoized: the read happens when a build assembles its runtime, not when this module is
 * imported, and a process serving many builds pays for it once.
 */
export function builtinIaCDeclarations(): BuiltinDeclarationsResult {
  if (builtinDeclarationsCache) return builtinDeclarationsCache;
  const requireFromHere = createRequire(import.meta.url);
  const entries: BuiltinDeclarations[] = [];
  const problems: BuiltinDeclarationProblem[] = [];

  for (const { packageName, descriptor } of INTERNAL_IAC_PLUGINS) {
    try {
      const packageJsonPath = requireFromHere.resolve(`${packageName}/package.json`);
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
        name?: string;
        version?: string;
        repovine?: unknown;
      };
      const validated = validatePluginManifest(pkg.repovine);
      if (!validated.ok) {
        problems.push({ packageName, reason: `invalid "repovine" manifest: ${validated.error}` });
        continue;
      }
      // The manifest names the plugin and the descriptor must agree, exactly as the external loader
      // requires — a built-in gets no weaker check for being bundled.
      if (validated.manifest.id !== descriptor.id) {
        problems.push({
          packageName,
          reason: `manifest id "${validated.manifest.id}" does not match descriptor id "${descriptor.id}"`,
        });
        continue;
      }
      const owner: PluginOwnerIdentity = {
        pluginId: validated.manifest.id,
        packageName: pkg.name ?? packageName,
        packageVersion: pkg.version ?? '0.0.0',
      };
      entries.push({
        owner,
        declarations: stampDeclarationCatalog(validated.manifest.declarations, owner),
      });
    } catch (e) {
      problems.push({ packageName, reason: (e as Error).message });
    }
  }

  builtinDeclarationsCache = { entries, problems };
  return builtinDeclarationsCache;
}

// Auto-invoke on first import — keeps the legacy "side-effect import" pattern working so any
// module that does `import './bootstrap.js'` gets registrations for free.
bootstrapInternalPlugins();
