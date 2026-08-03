/** Heuristic size of annotation text submitted in one write_annotation call. */

export interface SubmittedAnnotationMetrics {
  /** Total characters across all string leaves in the submitted annotation object. */
  chars: number;
  /** Rough token estimate for budgeting; not LLM usage. */
  estimatedTokens: number;
  /** How estimatedTokens was derived. */
  estimateMethod: 'chars/4';
}

/** Recursively sum character length of string leaves (values only, not JSON keys). */
export function countAnnotationTextChars(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + countAnnotationTextChars(item), 0);
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .reduce<number>((sum, item) => sum + countAnnotationTextChars(item), 0);
  }
  return 0;
}

export function measureSubmittedAnnotationText(annotation: unknown): SubmittedAnnotationMetrics {
  const chars = countAnnotationTextChars(annotation);
  return {
    chars,
    estimatedTokens: Math.ceil(chars / 4),
    estimateMethod: 'chars/4',
  };
}

export function formatCompactCount(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) {
    const k = n / 1000;
    const rounded = k >= 10 ? Math.round(k) : Math.round(k * 10) / 10;
    return `${rounded}k`;
  }
  return String(n);
}

export function formatSubmittedAnnotationMetrics(metrics: SubmittedAnnotationMetrics): string {
  return `~${formatCompactCount(metrics.chars)} chars (~${formatCompactCount(metrics.estimatedTokens)} tok est.)`;
}
