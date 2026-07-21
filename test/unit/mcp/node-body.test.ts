import { describe, expect, it } from '@jest/globals';
import {
  isUnsafeRegexPattern,
  MAX_GREP_LINE_CHARS,
  scanLinesWithRegex,
} from '../../../src/mcp/lib/node-body.js';

describe('grepBody regex safety', () => {
  it.each([
    '(a+)+$',
    '(a|a)+$',
    '(a|aa)*$',
    '(?:a{1,3})+$',
  ])('rejects repeated ambiguous or nested pattern %s', pattern => {
    expect(isUnsafeRegexPattern(pattern)).toBe(true);
  });

  it.each([
    '.*.*',
    '.+.+',
    'foo.*.*bar',
    '.*.*.*',
  ])('rejects the scan-abuse wildcard chain %s', pattern => {
    // Exercises the second clause of isUnsafeRegexPattern (the (\.\*){2,}|(\.\+){2,}
    // detector). These patterns carry no risky repeated group, so removing that clause
    // flips them to false.
    expect(isUnsafeRegexPattern(pattern)).toBe(true);
  });

  it('does not reject ordinary bounded search patterns', () => {
    expect(isUnsafeRegexPattern('schema|validate|safeParse')).toBe(false);
    expect(isUnsafeRegexPattern('foo\\(bar\\)')).toBe(false);
    // A single wildcard is allowed; the scan-abuse clause requires two or more in a row.
    expect(isUnsafeRegexPattern('.*')).toBe(false);
    expect(isUnsafeRegexPattern('.+')).toBe(false);
  });

  it('hard-stops a regex stuck inside a single line', async () => {
    const result = await scanLinesWithRegex(
      [`${'a'.repeat(MAX_GREP_LINE_CHARS)}!`],
      '(a+)+$',
      { timeoutMs: 100, maxLineChars: MAX_GREP_LINE_CHARS + 1 },
    );
    // Catastrophic backtracking traps the worker inside a single RegExp.test, so the
    // worker's own per-line deadline never re-fires. Resolution can only come from the
    // parent timer hard-stop, whose payload is scannedLines:0 with no matches. Asserting
    // that exact shape (instead of a real wall-clock bound) proves the hard-stop fired
    // rather than the scan completing; dropping the parent timer hangs the promise and
    // the test times out red.
    expect(result).toMatchObject({
      timedOut: true,
      scannedLines: 0,
      matchIndices: [],
      totalMatches: 0,
    });
  });

  it('tests only the bounded prefix of oversized lines', async () => {
    const result = await scanLinesWithRegex(
      [`${'x'.repeat(MAX_GREP_LINE_CHARS)}NEEDLE`],
      'NEEDLE$',
      { timeoutMs: 1_000 },
    );
    expect(result).toMatchObject({
      matchIndices: [],
      totalMatches: 0,
      timedOut: false,
      truncatedLineCount: 1,
    });
  });

  it('returns promptly without scanning when the request is already cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    // A 30s timeout we must not wait: an aborted signal terminates the worker immediately.
    const result = await scanLinesWithRegex(['needle here'], 'needle', { timeoutMs: 30_000, signal: ac.signal });
    expect(result).toMatchObject({ timedOut: true, matchIndices: [], totalMatches: 0 });
  });

  it('terminates the scan when the signal aborts mid-flight', async () => {
    const ac = new AbortController();
    const scan = scanLinesWithRegex(
      [`${'a'.repeat(MAX_GREP_LINE_CHARS)}!`],
      '(a+)+$', // catastrophic backtracking — only an external stop resolves it
      { timeoutMs: 30_000, maxLineChars: MAX_GREP_LINE_CHARS + 1, signal: ac.signal },
    );
    ac.abort();
    const result = await scan;
    expect(result).toMatchObject({ timedOut: true, matchIndices: [], totalMatches: 0 });
  });

  it('runs many concurrent scans correctly under the worker-concurrency cap', async () => {
    // More concurrent scans than the worker cap: the limiter queues the overflow; every scan must
    // still return the correct result (admission control must not corrupt or drop work).
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        scanLinesWithRegex(['find the needle', 'no match here'], 'needle', { timeoutMs: 1_000 })),
    );
    for (const result of results) {
      expect(result.totalMatches).toBe(1);
      expect(result.matchIndices).toEqual([0]);
    }
  });
});
