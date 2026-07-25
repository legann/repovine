import { compileGlob } from '../../src/stage2/domains.js';
import { compileScanPatterns, isScanExcluded } from '../../src/scan-filters.js';

/**
 * A glob with many globstars separated by literals is the catastrophic-backtracking shape: a regex
 * translation (`**` → `.*`) becomes `.*a.*a…b` and explores exponentially many splits on a
 * non-matching input. Scan filters and basename-domain matching both compile globs through the same
 * primitive, so the linear matcher covers both call sites. A committed `repovine.config.json` glob
 * runs on the discovery main thread; the bound below is generous (the regex form took tens of
 * seconds) yet still red on a regression.
 */
const HOSTILE = '**a'.repeat(20) + '**b';
const LONG_NONMATCH = 'a'.repeat(200) + 'x'; // ends in 'x', so the trailing 'b' is never satisfied

describe('compileGlob semantics', () => {
  it('matches * within a segment but not across /', () => {
    expect(compileGlob('*.ts').test('a.ts')).toBe(true);
    expect(compileGlob('*.ts').test('dir/a.ts')).toBe(false);
  });

  it('matches ** across directory separators, including zero directories', () => {
    expect(compileGlob('**/*.controller.ts').test('src/users/users.controller.ts')).toBe(true);
    expect(compileGlob('**/app.ts').test('app.ts')).toBe(true);
    expect(compileGlob('src/**').test('src/')).toBe(true);
    expect(compileGlob('src/**').test('src/a/b.ts')).toBe(true);
  });

  it('treats ? as a single non-separator char and other characters as literals', () => {
    expect(compileGlob('a?c').test('abc')).toBe(true);
    expect(compileGlob('a?c').test('a/c')).toBe(false);
    expect(compileGlob('a.b').test('a.b')).toBe(true);
    expect(compileGlob('a.b').test('aXb')).toBe(false);
  });

  it('matches literal-separated globstars against a satisfying path', () => {
    expect(compileGlob('**a**b').test('xaZZb')).toBe(true);
    expect(compileGlob('**a**b').test('xaZZ')).toBe(false);
  });
});

describe('compileGlob resists catastrophic backtracking', () => {
  it('decides a hostile globstar pattern against a long non-matching path in linear time', () => {
    const matcher = compileGlob(HOSTILE);
    const start = Date.now();
    const result = matcher.test(LONG_NONMATCH);
    const elapsedMs = Date.now() - start;
    expect(result).toBe(false);
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('keeps scan.exclude matching linear for a hostile committed glob', () => {
    const patterns = compileScanPatterns([], [HOSTILE]);
    const start = Date.now();
    const excluded = isScanExcluded(LONG_NONMATCH, patterns, 'source');
    const elapsedMs = Date.now() - start;
    expect(excluded).toBe(false);
    expect(elapsedMs).toBeLessThan(1000);
  });
});
