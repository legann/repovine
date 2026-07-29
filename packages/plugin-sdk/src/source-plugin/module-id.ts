import type { ModuleIdNormalize } from './types.js';

/**
 * Separator normalization, and nothing else: every `\\` becomes `/`.
 *
 * Repo-relative identity is POSIX by contract — ids, annotation keys, and every hashed path are
 * compared as bytes, and a win32 producer hands out `src\\a.ts` where a POSIX one hands out
 * `src/a.ts`. Ships here because the id mint is the first thing that needs it and a plugin
 * reporting a path needs the same answer the engine will compare against.
 */
export function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

/**
 * Mint a graph module id from a package name and a repo-relative path.
 *
 * The HOST calls this, never a producer: `discover()` returns `PendingModuleDraft`, which has no id
 * field, so `mod:<pkg>/<path>` cannot depend on a plugin getting the format right. It ships in the SDK
 * so the conformance kit mints exactly what the engine mints, and a plugin verified against the kit
 * sees the same ids it will see in a real build.
 *
 * `normalize` carries the owning ecosystem's own facts, declared through its capabilities.
 */
export function mintModuleId(
  packageName: string,
  relPath: string,
  normalize?: ModuleIdNormalize,
): string {
  let normalized = toPosixPath(relPath);
  // Longest-first, so an ecosystem declaring both `.d.ts` and `.ts` strips the compound suffix whole
  // rather than leaving a `.d` tail behind.
  const suffixes = [...(normalize?.stripSuffixes ?? [])].sort((a, b) => b.length - a.length);
  for (const suffix of suffixes) {
    if (normalized.toLowerCase().endsWith(suffix.toLowerCase())) {
      normalized = normalized.slice(0, -suffix.length);
      break;
    }
  }
  for (const basename of normalize?.indexBasenames ?? []) {
    if (normalized === basename) { normalized = ''; break; }
    if (normalized.endsWith(`/${basename}`)) { normalized = normalized.slice(0, -(basename.length + 1)); break; }
  }
  return `mod:${packageName}/${normalized}`;
}

/**
 * The graph node id of a package, from its declared name.
 *
 * Ships beside {@link mintModuleId} for the same reason: a specifier that resolves to a package
 * rather than a file inside it (an external dependency, a workspace bare import) is reported by a
 * producer as `pkg:<name>`, so the spelling has to be one function rather than a template literal
 * copied into each ecosystem's resolver.
 */
export function packageNodeId(packageName: string): string {
  return `pkg:${packageName}`;
}

/** The package name a `pkg:` id carries. Returns the input unchanged when it carries no prefix. */
export function packageNameFromId(idOrName: string): string {
  return idOrName.startsWith('pkg:') ? idOrName.slice('pkg:'.length) : idOrName;
}

/**
 * The package name at the head of a slash-separated name (`@scope/pkg/sub` → `@scope/pkg`).
 *
 * Ships beside the id mint because that mint embeds the package name in `mod:<pkg>/<path>`: reading
 * the package back out of an id is this function, and a producer resolving a scoped import
 * specifier to a package node asks the same question of the same spelling. A scope prefix keeps two
 * segments; everything else keeps one.
 */
export function extractPackageName(specifier: string): string {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split('/')[0];
}
