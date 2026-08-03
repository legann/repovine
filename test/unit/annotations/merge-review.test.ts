import {
  applyMergeReviewHints,
  clearMergeReviewHints,
  listMergeReviewFields,
  mergeReviewPatternForField,
} from '../../../src/annotations/merge-review.js';
import type { AnnotationContent } from '../../../src/types.js';

describe('merge-review hints', () => {
  it('adds patterns and assumptions for scalar merge conflicts', () => {
    const annotation: AnnotationContent = {
      summary: 'Ours summary',
      assumptions: ['existing assumption'],
    };
    const result = applyMergeReviewHints(annotation, [{
      nodeId: 'mod:a',
      field: 'annotation.summary',
      reason: 'both sides changed this scalar field differently',
      oursPreview: 'Ours summary',
      theirsPreview: 'Theirs summary',
    }], 'mod:a');

    expect(result.patterns).toEqual(['merge-review:summary']);
    expect(result.assumptions).toEqual([
      'existing assumption',
      '[merge-review:summary:ours] Ours summary',
      '[merge-review:summary:theirs] Theirs summary',
    ]);
    expect(listMergeReviewFields(result)).toEqual(['summary']);
  });

  it('clears merge-review markers when a field is rewritten', () => {
    const annotation: AnnotationContent = {
      summary: 'Draft summary',
      patterns: [mergeReviewPatternForField('summary')],
      assumptions: [
        '[merge-review:summary:ours] Ours summary',
        '[merge-review:summary:theirs] Theirs summary',
        'keep me',
      ],
    };
    const result = clearMergeReviewHints(annotation, ['summary']);

    expect(result.summary).toBe('Draft summary');
    expect(result.patterns).toBeUndefined();
    expect(result.assumptions).toEqual(['keep me']);
  });

  it('clears only the rewritten field when multiple merge-review markers exist', () => {
    const annotation: AnnotationContent = {
      summary: 'Draft summary',
      flowDescription: 'Draft flow',
      patterns: ['merge-review:flowDescription', 'merge-review:summary'],
      assumptions: [
        '[merge-review:summary:ours] Ours summary',
        '[merge-review:summary:theirs] Theirs summary',
        '[merge-review:flowDescription:ours] Ours flow',
        '[merge-review:flowDescription:theirs] Theirs flow',
      ],
    };
    const result = clearMergeReviewHints(annotation, ['summary']);

    expect(result.patterns).toEqual(['merge-review:flowDescription']);
    expect(result.assumptions).toEqual([
      '[merge-review:flowDescription:ours] Ours flow',
      '[merge-review:flowDescription:theirs] Theirs flow',
    ]);
  });

  it('replaces stale merge-review assumptions when hints are reapplied for the same field', () => {
    const annotation: AnnotationContent = {
      summary: 'Winner v2',
      patterns: ['merge-review:summary'],
      assumptions: [
        '[merge-review:summary:ours] old ours',
        '[merge-review:summary:theirs] old theirs',
      ],
    };
    const result = applyMergeReviewHints(annotation, [{
      nodeId: 'mod:a',
      field: 'annotation.summary',
      reason: 'both sides changed this scalar field differently',
      oursPreview: 'new ours',
      theirsPreview: 'new theirs',
    }], 'mod:a');

    expect(result.assumptions).toEqual([
      '[merge-review:summary:ours] new ours',
      '[merge-review:summary:theirs] new theirs',
    ]);
  });

  it('ignores conflicts for other nodes and non-scalar reasons', () => {
    const annotation: AnnotationContent = { summary: 'Stable summary' };
    const result = applyMergeReviewHints(annotation, [
      {
        nodeId: 'mod:b',
        field: 'annotation.summary',
        reason: 'both sides changed this scalar field differently',
        oursPreview: 'x',
        theirsPreview: 'y',
      },
      {
        nodeId: 'mod:a',
        field: 'annotation.summary',
        reason: 'ours deleted field while theirs changed it',
        theirsPreview: 'y',
      },
    ], 'mod:a');

    expect(result).toEqual(annotation);
  });

  it('is a no-op when updatedFields is empty', () => {
    const annotation: AnnotationContent = {
      summary: 'Draft summary',
      patterns: ['merge-review:summary'],
    };
    expect(clearMergeReviewHints(annotation, [])).toBe(annotation);
  });
});
