/**
 * `@repovine/plugin-source-typescript` — the TypeScript/JavaScript source plugin.
 *
 * The package owns the whole ecosystem vertical: `tsconfig` parsing, the ts-morph AST pass, the
 * TypeScript module resolver, single-file-component extraction, and the semantic hints a
 * TypeScript/JavaScript file yields. It compiles against `@repovine/plugin-sdk` alone.
 */
import { definePlugin } from '@repovine/plugin-sdk';
import typescriptSourcePlugin from './plugin.js';

export { TYPESCRIPT_SOURCE_EXTENSIONS } from './extensions.js';
export type { TypeScriptExtractContext } from './plugin.js';
export { typescriptSourcePlugin };

/**
 * The package's entry point, in the one shape the host loads: manifest identity, lifecycle, and the
 * capabilities this package activates. A bundled package and an independently installed one are
 * read through this same object.
 */
export const plugin = definePlugin({
  id: typescriptSourcePlugin.id,
  capabilities: { source: typescriptSourcePlugin },
});

export default plugin;
