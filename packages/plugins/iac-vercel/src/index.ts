import { PLUGIN_API_VERSION, defineIaCPlugin } from '@repovine/plugin-sdk';
import { vercelParser } from './parser.js';

/**
 * Built-in plugin: Vercel project config (vercel.json).
 *
 * Owns InfraKind: 'vercel'. Emits resourceKind: 'vercel-function', 'vercel-cron', 'vercel-route'.
 * Crons emit schedule triggers; the declaration in `package.json#repovine` carries the Vercel
 * provider, so it answers for Vercel resources whether or not the SAM plugin is loaded.
 */
export const vercelIacPlugin = defineIaCPlugin({
  id: 'vercel',
  parsers: [vercelParser],
  kindDomains: [
    {
      kind: 'vercel',
      meta: {
        domainId: 'domain:infra-vercel',
        label: 'infra-vercel',
        description: 'Domain: infra-vercel (Vercel project configuration)',
      },
    },
  ],
});

/**
 * What this package activates, in the shape every bundled plugin package publishes.
 *
 * An installed tarball is probed through this object: the package name it claims, the plugin id it
 * carries and the capability it activates. A package that stopped carrying its implementation is
 * caught by name rather than by a graph that quietly lost a resource kind.
 */
export const builtinPluginPackage = Object.freeze({
  packageName: '@repovine/plugin-iac-vercel',
  pluginId: 'vercel',
  capability: 'iac',
  apiVersion: PLUGIN_API_VERSION,
  activation: 'iac-plugin',
  iacPlugin: vercelIacPlugin,
} as const);

export default builtinPluginPackage;
