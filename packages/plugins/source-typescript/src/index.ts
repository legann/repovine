import { PLUGIN_API_VERSION } from '@repovine/plugin-sdk';

export const builtinPluginPackage = Object.freeze({
  packageName: '@repovine/plugin-source-typescript',
  pluginId: 'typescript',
  capability: 'source',
  apiVersion: PLUGIN_API_VERSION,
  activation: 'scaffold-only',
} as const);

export default builtinPluginPackage;
