import type { AnnotationContent } from '../types.js';
import { canonicalAnnotationContent } from './format.js';

export const MERGE_REVIEW_PATTERN_PREFIX = 'merge-review:';

export interface MergeReviewConflictInput {
  nodeId: string;
  field: string;
  reason: string;
  oursPreview?: string;
  theirsPreview?: string;
}

export function mergeReviewPatternForField(field: string): string {
  return `${MERGE_REVIEW_PATTERN_PREFIX}${field}`;
}

export function mergeReviewAssumptionPrefix(field: string, side: 'ours' | 'theirs'): string {
  return `[merge-review:${field}:${side}]`;
}

function isMergeReviewAssumptionForField(assumption: string, field: string): boolean {
  return assumption.startsWith(`[merge-review:${field}:`);
}

/** Persist agent-facing hints after a scalar annotation merge conflict. */
export function applyMergeReviewHints(
  annotation: AnnotationContent,
  conflicts: readonly MergeReviewConflictInput[],
  nodeId: string,
): AnnotationContent {
  const scalarConflicts = conflicts.filter(
    c => c.nodeId === nodeId
      && c.field.startsWith('annotation.')
      && c.reason === 'both sides changed this scalar field differently'
      && c.oursPreview !== undefined
      && c.theirsPreview !== undefined,
  );
  if (scalarConflicts.length === 0) return annotation;

  const patterns = new Set(annotation.patterns ?? []);
  let assumptions = [...(annotation.assumptions ?? [])];

  for (const conflict of scalarConflicts) {
    const field = conflict.field.slice('annotation.'.length);
    if (field === 'patterns' || field === 'assumptions') continue;

    patterns.add(mergeReviewPatternForField(field));
    assumptions = assumptions.filter(a => !isMergeReviewAssumptionForField(a, field));
    assumptions.push(`${mergeReviewAssumptionPrefix(field, 'ours')} ${conflict.oursPreview}`);
    assumptions.push(`${mergeReviewAssumptionPrefix(field, 'theirs')} ${conflict.theirsPreview}`);
  }

  return canonicalAnnotationContent({
    ...annotation,
    ...(patterns.size > 0 ? { patterns: [...patterns].sort() } : {}),
    ...(assumptions.length > 0 ? { assumptions } : {}),
  });
}

/** Remove merge-review markers for fields the agent rewrote via write_annotation. */
export function clearMergeReviewHints(
  annotation: AnnotationContent,
  updatedFields: readonly string[],
): AnnotationContent {
  if (updatedFields.length === 0) return annotation;

  let patterns = annotation.patterns ?? [];
  let assumptions = annotation.assumptions ?? [];
  let changed = false;

  for (const field of updatedFields) {
    const pattern = mergeReviewPatternForField(field);
    const nextPatterns = patterns.filter(p => p !== pattern);
    if (nextPatterns.length !== patterns.length) {
      patterns = nextPatterns;
      changed = true;
    }
    const nextAssumptions = assumptions.filter(a => !isMergeReviewAssumptionForField(a, field));
    if (nextAssumptions.length !== assumptions.length) {
      assumptions = nextAssumptions;
      changed = true;
    }
  }

  if (!changed) return annotation;

  const out: AnnotationContent = { ...annotation };
  if (patterns.length > 0) out.patterns = patterns;
  else delete out.patterns;
  if (assumptions.length > 0) out.assumptions = assumptions;
  else delete out.assumptions;
  return canonicalAnnotationContent(out);
}

export function listMergeReviewFields(annotation: AnnotationContent): string[] {
  return (annotation.patterns ?? [])
    .filter(p => p.startsWith(MERGE_REVIEW_PATTERN_PREFIX))
    .map(p => p.slice(MERGE_REVIEW_PATTERN_PREFIX.length));
}
