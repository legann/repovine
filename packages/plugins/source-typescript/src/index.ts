/**
 * `@repovine/plugin-source-typescript` — the TypeScript/JavaScript source plugin.
 *
 * The package owns the whole ecosystem vertical: `tsconfig` parsing, the ts-morph AST pass, the
 * TypeScript module resolver, single-file-component extraction, and the semantic hints a
 * TypeScript/JavaScript file yields. It compiles against `@repovine/plugin-sdk` alone.
 */
import { PLUGIN_API_VERSION } from '@repovine/plugin-sdk';
import typescriptSourcePlugin from './plugin.js';

export { TYPESCRIPT_SOURCE_EXTENSIONS } from './extensions.js';
export type { TypeScriptExtractContext } from './plugin.js';
export { typescriptSourcePlugin };

export const builtinPluginPackage = Object.freeze({
  packageName: '@repovine/plugin-source-typescript',
  pluginId: 'typescript',
  capability: 'source',
  apiVersion: PLUGIN_API_VERSION,
  activation: 'source-plugin',
  sourcePlugin: typescriptSourcePlugin,
} as const);

export default builtinPluginPackage;
