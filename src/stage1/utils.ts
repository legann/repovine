import * as path from 'node:path';
import type { PackageInfo } from '../types.js';

/**
 * Language-agnostic identity + path helpers shared by the orchestrator and source plugins.
 * Intentionally free of any AST dependency (no ts-morph / typescript) so the Stage 1
 * orchestrator can import it without pulling in a language toolchain.
 */

/** Engine-side name for the SDK minter: one implementation, so the conformance kit and a real build
 *  produce identical ids for the same file. */
export { mintModuleId as makeModuleId } from '@repovine/plugin-sdk';

/** Unique identity for a discovered package entry across source plugins. */
export function packageJobKey(pkg: Pick<PackageInfo, 'name' | 'path' | 'sourcePluginId'>): string {
  return `${pkg.sourcePluginId ?? ''}\u0000${pkg.name}\u0000${pkg.path}`;
}

/** Length of pkgPath as prefix of relFromRoot (for dedup: prefer package that owns the file). */
export function pathPrefixLength(pkgPath: string, relFromRoot: string): number {
  const norm = path.normalize(relFromRoot);
  const prefix = path.normalize(pkgPath);
  if (prefix === '.' || prefix === '') return 0;
  if (norm === prefix || norm.startsWith(prefix + path.sep)) return prefix.length;
  return 0;
}

const MODULE_PATH_EXT_PRIORITY = ['ts', 'tsx', 'd.ts', 'js', 'jsx', 'mjs', 'cjs'];

/**
 * Lower score wins. Mirrors TypeScript's resolver priority:
 * - file form (`foo.ts`) beats index form (`foo/index.ts`)
 * - within a form, extension order is `.ts > .tsx > .d.ts > .js > .jsx > .mjs > .cjs`
 *
 * Used to deterministically pick a single owner when multiple discovered files would
 * collapse to the same moduleId (`./foo` could mean `foo.ts` or `foo/index.ts`).
 */
export function modulePathResolverPriority(filePath: string): number {
  const match = filePath.match(/(\/index)?\.(d\.ts|tsx?|jsx?|mjs|cjs)$/i);
  if (!match) return 9999;
  const isIndex = match[1] === '/index';
  const ext = match[2].toLowerCase();
  const baseRank = isIndex ? 1000 : 0;
  const extRank = MODULE_PATH_EXT_PRIORITY.indexOf(ext);
  return baseRank + (extRank >= 0 ? extRank : 100);
}

/** Extract the package name from a module specifier (`@scope/pkg/sub` → `@scope/pkg`). */
export function extractPackageName(specifier: string): string {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split('/')[0];
}
