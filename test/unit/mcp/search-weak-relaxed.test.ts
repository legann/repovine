import { describe, it, expect } from '@jest/globals';
import { isWeakRelaxedSearchMatch } from '../../../src/mcp/tools/search-context.js';

/** The confidence heuristic: a relaxed OR match is weak only when the top hit matched ≤ 1 token. */
describe('isWeakRelaxedSearchMatch', () => {
  const relaxed = { relaxedFrom: 'and' as const };

  it('is not weak when the query was a single token', () => {
    expect(isWeakRelaxedSearchMatch(relaxed, { score: 1, matchedTokenCount: 1 }, 1)).toBe(false);
  });

  it('is not weak when the search did not relax from AND', () => {
    expect(isWeakRelaxedSearchMatch({ relaxedFrom: undefined }, { score: 1, matchedTokenCount: 1 }, 3)).toBe(false);
    expect(isWeakRelaxedSearchMatch(undefined, { score: 1, matchedTokenCount: 1 }, 3)).toBe(false);
  });

  it('is not weak when there is no top hit quality', () => {
    expect(isWeakRelaxedSearchMatch(relaxed, undefined, 3)).toBe(false);
  });

  it('is weak when the relaxed top hit matched a single token', () => {
    expect(isWeakRelaxedSearchMatch(relaxed, { score: 99, matchedTokenCount: 1 }, 3)).toBe(true);
    expect(isWeakRelaxedSearchMatch(relaxed, { score: 0, matchedTokenCount: 0 }, 3)).toBe(true);
  });

  it('is NOT weak when the relaxed top hit matched ≥ 2 tokens — regardless of a low score', () => {
    // The old heuristic flipped this to weak (score < 15 && matchedTokenCount < tokenCount); score is
    // corpus-size-dependent, so a 2-of-4 relaxed hit stays a medium anchor now.
    expect(isWeakRelaxedSearchMatch(relaxed, { score: 3, matchedTokenCount: 2 }, 4)).toBe(false);
    expect(isWeakRelaxedSearchMatch(relaxed, { score: 41.5, matchedTokenCount: 3 }, 5)).toBe(false);
  });
});
