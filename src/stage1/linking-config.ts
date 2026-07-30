import type { RepositoryFactsSnapshot } from '../types.js';

export interface NormalizedLinkingConfig {
  handlers: { searchRoots: string[] };
  bundles: { scripts: string[]; autoDetect: boolean };
}

export function normalizeLinkingConfig(
  input?: RepositoryFactsSnapshot['linkingConfig'],
): NormalizedLinkingConfig {
  return {
    handlers: {
      searchRoots: uniqueStrings(input?.handlers?.searchRoots ?? []),
    },
    bundles: {
      scripts: uniqueStrings(input?.bundles?.scripts ?? []),
      autoDetect: input?.bundles?.autoDetect !== false,
    },
  };
}

export function hasLinkingConfig(input?: RepositoryFactsSnapshot['linkingConfig']): boolean {
  if (!input) return false;
  const n = normalizeLinkingConfig(input);
  return n.handlers.searchRoots.length > 0
    || n.bundles.scripts.length > 0;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(v => v.length > 0))];
}
