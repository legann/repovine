import { PLUGIN_API_VERSION, defineIaCPlugin } from '@repovine/plugin-sdk';
import { dockerfileParser } from './parser.js';

/** Built-in plugin: Dockerfile / Dockerfile.<variant>. Owns InfraKind: 'dockerfile'. */
export const dockerfileIacPlugin = defineIaCPlugin({
  id: 'dockerfile',
  parsers: [dockerfileParser],
  kindDomains: [
    {
      kind: 'dockerfile',
      meta: {
        domainId: 'domain:infra-dockerfile',
        label: 'infra-dockerfile',
        description: 'Domain: infra-dockerfile (Dockerfiles)',
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
  packageName: '@repovine/plugin-iac-dockerfile',
  pluginId: 'dockerfile',
  capability: 'iac',
  apiVersion: PLUGIN_API_VERSION,
  activation: 'iac-plugin',
  iacPlugin: dockerfileIacPlugin,
} as const);

export default builtinPluginPackage;
