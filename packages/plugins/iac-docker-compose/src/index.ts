import { PLUGIN_API_VERSION, defineIaCPlugin } from '@repovine/plugin-sdk';
import { dockerComposeParser } from './parser.js';

/** Built-in plugin: docker-compose / Compose-spec manifests. Owns InfraKind: 'docker-compose'. */
export const dockerComposeIacPlugin = defineIaCPlugin({
  id: 'docker-compose',
  parsers: [dockerComposeParser],
  kindDomains: [
    {
      kind: 'docker-compose',
      meta: {
        domainId: 'domain:infra-docker-compose',
        label: 'infra-docker-compose',
        description: 'Domain: infra-docker-compose (docker-compose / Compose files)',
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
  packageName: '@repovine/plugin-iac-docker-compose',
  pluginId: 'docker-compose',
  capability: 'iac',
  apiVersion: PLUGIN_API_VERSION,
  activation: 'iac-plugin',
  iacPlugin: dockerComposeIacPlugin,
} as const);

export default builtinPluginPackage;
