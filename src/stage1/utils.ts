import type { PackageInfo } from '../types.js';

/**
 * Identity + path helpers shared by the orchestrator and source plugins. Extension ranking uses the
 * engine's fixed module-collision order; package-name extraction follows the npm scoped spelling.
 * Intentionally free of any AST dependency (no ts-morph / typescript) so the Stage 1
 * orchestrator can import it without pulling in a language toolchain.
 */

/** Engine-side name for the SDK minter: one implementation, so the conformance kit and a real build
 *  produce identical ids for the same file. */
export { mintModuleId as makeModuleId } from '@repovine/plugin-sdk';

/** Engine-side name for the SDK reader: the package name at the head of a `mod:` id tail, and the
 *  same reading a producer applies to a scoped import specifier. */
export { extractPackageName } from '@repovine/plugin-sdk';

/** Unique identity for a discovered package entry across source plugins. */
export function packageJobKey(pkg: Pick<PackageInfo, 'name' | 'path' | 'sourcePluginId'>): string {
  return `${pkg.sourcePluginId ?? ''}\u0000${pkg.name}\u0000${pkg.path}`;
}

/**
 * Extension preference when several discovered files collapse to one module id, best first.
 *
 * The order is the fact; the pattern that reads a path is built from this list rather than written
 * beside it. Written twice, the two drifted the moment an extension was added: the list learned
 * `.mts`/`.cts` and the pattern did not, so every `.mts` path scored the no-match sentinel and lost
 * a collision to the index form the doc promises it beats.
 */
const MODULE_PATH_EXT_PRIORITY = ['ts', 'tsx', 'mts', 'cts', 'd.ts', 'js', 'jsx', 'mjs', 'cjs'];

const MODULE_PATH_EXT_RE = new RegExp(
  `(/index)?\\.(${MODULE_PATH_EXT_PRIORITY.map(ext => ext.replace(/\./g, '\\.')).join('|')})$`,
  'i',
);

/**
 * Lower score wins. Mirrors TypeScript's resolver priority:
 * - file form (`foo.ts`) beats index form (`foo/index.ts`)
 * - within a form, extension order is {@link MODULE_PATH_EXT_PRIORITY}
 *
 * Used to deterministically pick a single owner when multiple discovered files would
 * collapse to the same moduleId (`./foo` could mean `foo.ts` or `foo/index.ts`).
 *
 * The index-form penalty is keyed to the `/` spelling. Extension rank is separator-independent, so
 * a backslash-spelled path still ranks by extension while its `index` segment scores as a file form.
 * Absolute-path spelling depends on the producer: TypeScript's tsconfig parser normalizes to `/`
 * even on win32, while paths assembled by filesystem walkers may retain `\`. Only the latter take
 * this backslash branch and can tie with, or outrank, a file-form collision by extension alone.
 */
export function modulePathResolverPriority(filePath: string): number {
  const match = filePath.match(MODULE_PATH_EXT_RE);
  if (!match) return 9999;
  const isIndex = match[1] === '/index';
  const ext = match[2].toLowerCase();
  const baseRank = isIndex ? 1000 : 0;
  const extRank = MODULE_PATH_EXT_PRIORITY.indexOf(ext);
  return baseRank + (extRank >= 0 ? extRank : 100);
}
