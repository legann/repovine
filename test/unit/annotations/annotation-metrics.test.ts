import {
  countAnnotationTextChars,
  formatCompactCount,
  formatSubmittedAnnotationMetrics,
  measureSubmittedAnnotationText,
} from '../../../src/annotations/annotation-metrics.js';

describe('annotation-metrics', () => {
  it('counts string leaves only', () => {
    expect(countAnnotationTextChars({
      summary: 'Hello world',
      assumptions: ['one', 'two'],
      keyExports: { foo: 'bar' },
    })).toBe('Hello world'.length + 'one'.length + 'two'.length + 'bar'.length);
  });

  it('estimates tokens as ceil(chars / 4)', () => {
    // 17 chars: 17/4 = 4.25 -> ceil 5, but floor/round would give 4.
    const metrics = measureSubmittedAnnotationText({
      summary: 'abcdefghijklmnopq',
    });
    expect(metrics.chars).toBe(17);
    expect(metrics.estimatedTokens).toBe(5);
    expect(metrics.estimateMethod).toBe('chars/4');
  });

  it('formats compact human-readable sizes', () => {
    expect(formatSubmittedAnnotationMetrics({ chars: 4180, estimatedTokens: 1045, estimateMethod: 'chars/4' }))
      .toBe('~4.2k chars (~1k tok est.)');
  });

  it('rounds thousands to integers in the n>=10000 branch', () => {
    // 12_500/1000 = 12.5 -> Math.round -> 13 (integer k, no decimal).
    expect(formatCompactCount(12_500)).toBe('13k');
    expect(formatCompactCount(42_000)).toBe('42k');
  });

  it('renders raw counts below 1000 without a k suffix', () => {
    expect(formatCompactCount(999)).toBe('999');
    expect(formatCompactCount(0)).toBe('0');
  });
});
