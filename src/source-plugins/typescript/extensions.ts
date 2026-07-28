/**
 * The file extensions the TypeScript source plugin owns, declared once.
 *
 * A leaf module on purpose: discovery, specifier resolution, and the plugin descriptor all read
 * this list, and a constant living beside the descriptor would make each reader import the plugin
 * that imports them. `.mts` and `.cts` are here because TypeScript emits and resolves them as
 * first-class source; a repository written in them is a repository with no modules otherwise.
 *
 * SFC extensions (`.vue`, `.svelte`) are not on this list — `sfc-extractor.ts` owns those, they
 * reach discovery through their own walk, and the module id keeps them.
 */
/** TypeScript source forms, in the order the module resolver prefers them. */
export const TYPESCRIPT_TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

/** JavaScript source forms, tried after the TypeScript ones and after `.d.ts`. */
export const TYPESCRIPT_JS_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'];

export const TYPESCRIPT_SOURCE_EXTENSIONS = [...TYPESCRIPT_TS_EXTENSIONS, ...TYPESCRIPT_JS_EXTENSIONS];

/** The declaration form. Its own constant because two readers need the same spelling: the id mint
 *  strips it (longest-first, so `global.d.ts` does not become `global.d`) and the resolver tries it
 *  after the implementations, never before. */
export const TYPESCRIPT_DECLARATION_EXTENSION = '.d.ts';

/** Basenames that stand for their own directory, for the id mint and the resolve ladder alike. */
export const TYPESCRIPT_INDEX_BASENAMES = ['index'];

/** {@link TYPESCRIPT_DECLARATION_EXTENSION} as a trailing-suffix pattern. */
export const DECLARATION_EXT_SUFFIX_RE = new RegExp(
  `${TYPESCRIPT_DECLARATION_EXTENSION.replace(/\./g, '\\.')}$`,
  'i',
);

/** The plugin's own extensions as a trailing-suffix pattern, for the places that strip one. */
export const SOURCE_EXT_SUFFIX_RE = new RegExp(
  `\\.(?:${TYPESCRIPT_SOURCE_EXTENSIONS.map(ext => ext.slice(1)).join('|')})$`,
  'i',
);

/** Single-file-component extensions. Discovery reaches them through its own SFC walk, and the
 *  module id keeps them, so they are not part of {@link TYPESCRIPT_SOURCE_EXTENSIONS}. */
export const SFC_EXTENSION_LIST = ['.vue', '.svelte'];

/** {@link SFC_EXTENSION_LIST} as a trailing-suffix pattern. */
export const SFC_EXT_SUFFIX_RE = new RegExp(
  `\\.(?:${SFC_EXTENSION_LIST.map(ext => ext.slice(1)).join('|')})$`,
  'i',
);

/** Extensions whose files may carry JSX syntax. Narrower than the family: `.ts` cannot. */
export const JSX_EXT_SUFFIX_RE = /\.(?:tsx|jsx)$/i;

/** The virtual name discovery gives an SFC's extracted script (`Button.vue` -> `Button.vue.ts`). */
export const SFC_VIRTUAL_TS_SUFFIX_RE = new RegExp(SFC_EXT_SUFFIX_RE.source.replace(/\$$/, '') + '\\.ts$', 'i');
