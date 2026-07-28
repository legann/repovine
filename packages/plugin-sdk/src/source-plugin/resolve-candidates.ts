import { hostKeyedView, hostPathKey } from '../paths.js';

/**
 * The lookup half of import resolution: probe a base path against a map of absolute paths, in the
 * order the ecosystem prefers, and answer the first module id that exists.
 *
 * What a producer cannot know on its own is the KEY. `absPathToId` arrives keyed by whatever built
 * it — tsconfig enumeration and TypeScript's own resolver emit forward-slash absolutes, filesystem
 * walkers emit native ones, and win32 lookups are case-insensitive — so a probe that concatenated a
 * suffix and read the map raw answers on the spelling instead of on the file. Folding both sides
 * through {@link hostPathKey} is the whole contract, and it lives here so it is not restated per
 * ecosystem.
 *
 * The ORDER is the caller's, and deliberately so: it is not derivable from the ecosystem's declared
 * `moduleIdNormalize.stripSuffixes`, which is a set the id mint sorts longest-first. TypeScript
 * declares `.d.ts` among its strip suffixes and must try it AFTER `.ts` — a declaration that outran
 * its own implementation would resolve every import to the declaration file.
 */
export function resolveByCandidates(
  basePath: string,
  candidateSuffixes: readonly string[],
  absPathToId: ReadonlyMap<string, string>,
): string | undefined {
  const view = hostKeyedView(absPathToId);
  for (const suffix of candidateSuffixes) {
    const id = view.get(hostPathKey(basePath + suffix));
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * The candidate ladder for an ecosystem: every file suffix in preference order, then the same
 * suffixes under each index basename.
 *
 * Both halves are the ecosystem's own declared facts — the suffixes it strips when minting ids and
 * the basenames that stand for their own directory — so the resolver spells neither a second time.
 * `includeBareBase` adds the empty suffix for a specifier that already carries its extension.
 */
export function moduleCandidateSuffixes(opts: {
  fileSuffixes: readonly string[];
  indexBasenames: readonly string[];
  includeBareBase?: boolean;
}): string[] {
  const { fileSuffixes, indexBasenames, includeBareBase = false } = opts;
  const fileCandidates = includeBareBase ? [...fileSuffixes, ''] : [...fileSuffixes];
  const indexCandidates = indexBasenames.flatMap(basename =>
    fileSuffixes.map(suffix => `/${basename}${suffix}`),
  );
  return [...fileCandidates, ...indexCandidates];
}
