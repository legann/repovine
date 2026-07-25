import type { ModuleIdNormalize } from './types.js';

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
  let normalized = relPath.replace(/\\/g, '/');
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
