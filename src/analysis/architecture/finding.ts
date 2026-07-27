/**
 * Finding lifecycle helpers: confidence/severity, sorting, balanced selection,
 * category counters.
 */

import { type RefactoringCategory, type RefactoringFinding, REFACTORING_CATEGORIES } from './types.js';

export function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

/**
 * How sure a detector is: a base its cheapest evidence already earns, one contribution per further
 * signal, penalties for signals that argue against, and a ceiling it never claims past.
 *
 * The parts are named because they are not interchangeable. The base says what a bare match is
 * worth, the ceiling says how sure this category can ever be from static signals alone, and each
 * contribution weighs one axis. Written as one arithmetic expression per detector, those roles are
 * invisible: `Math.min(0.9, 0.55 + a * 0.08 + b * 0.08)` reads as a number, and two detectors that
 * disagree about what a base means look identical. Rounding is part of the answer, not of the
 * caller: {@link clampConfidence} lands every detector on the same two decimals.
 */
export function detectorConfidence(input: {
  base: number;
  ceiling: number;
  add?: readonly number[];
  subtract?: readonly number[];
}): number {
  const raised = (input.add ?? []).reduce((sum, contribution) => sum + contribution, input.base);
  const lowered = (input.subtract ?? []).reduce((sum, penalty) => sum - penalty, raised);
  return clampConfidence(Math.min(input.ceiling, lowered));
}

/**
 * How many independent evidence axes fired.
 *
 * A gate distinct from {@link detectorConfidence}: the score says how much evidence there is, this
 * says how many DIFFERENT things pointed the same way. One axis scoring high is a module with a big
 * number on it; four axes agreeing is a pattern. A detector that gates on the score alone fires on
 * a single inflated dimension, which is what the axis count exists to refuse.
 */
export function evidenceAxisCount(axes: readonly boolean[]): number {
  return axes.filter(Boolean).length;
}

export function findingSeverity(confidence: number, impact: RefactoringFinding['impact']): RefactoringFinding['severity'] {
  if (confidence >= 0.8 && impact !== 'low') return 'high';
  if (confidence >= 0.65 || impact === 'high') return 'medium';
  return 'low';
}

export function countFindingsByCategory(findings: RefactoringFinding[]): Record<RefactoringCategory, number> {
  return Object.fromEntries(
    REFACTORING_CATEGORIES.map(category => [category, findings.filter(f => f.category === category).length]),
  ) as Record<RefactoringCategory, number>;
}

export function sortFindings(findings: RefactoringFinding[]): RefactoringFinding[] {
  const severityRank = { high: 3, medium: 2, low: 1 } as const;
  return [...findings].sort((a, b) =>
    (severityRank[b.severity] - severityRank[a.severity])
    || b.confidence - a.confidence
    || b.nodes.length - a.nodes.length,
  );
}

export function selectBalancedFindings(
  findings: RefactoringFinding[],
  limit: number,
  categories: Set<RefactoringCategory>,
): RefactoringFinding[] {
  const sorted = sortFindings(findings);
  if (categories.size <= 1) return sorted.slice(0, limit);

  const byCategory = new Map<RefactoringCategory, RefactoringFinding[]>();
  for (const category of REFACTORING_CATEGORIES) {
    const entries = sorted.filter(f => f.category === category);
    if (entries.length > 0 && categories.has(category)) byCategory.set(category, entries);
  }
  if (byCategory.size <= 1) return sorted.slice(0, limit);

  const returned: RefactoringFinding[] = [];
  const seen = new Set<string>();
  while (returned.length < limit && byCategory.size > 0) {
    let addedThisRound = false;
    for (const category of REFACTORING_CATEGORIES) {
      const queue = byCategory.get(category);
      if (!queue) continue;
      const next = queue.shift();
      if (!next) {
        byCategory.delete(category);
        continue;
      }
      if (seen.has(next.id)) continue;
      returned.push(next);
      seen.add(next.id);
      addedThisRound = true;
      if (returned.length >= limit) break;
    }
    if (!addedThisRound) break;
  }
  return sortFindings(returned);
}

export function refactoringCategoryFromFindingId(findingId: string): RefactoringCategory | undefined {
  return REFACTORING_CATEGORIES.find(category => findingId.startsWith(`${category}:`));
}

/**
 * Collapse findings that share a category AND primary node (`nodes[0]`). Two detectors can emit the
 * same category for the same module — e.g. `detectGodModule` (`god-module:<id>`) and the
 * server-handler detector (`server-handler-orchestration:<id>`) both produce `god-module` for a
 * backend handler. Input is already severity/confidence-sorted, so keeping the first occurrence lets
 * the stronger finding win and stops the category summary count from double-inflating. Within every
 * other category each detector keys `nodes[0]` uniquely, so this only ever collapses that cross-detector
 * pair. Findings with no primary node pass through untouched.
 */
export function dedupeByCategoryAndPrimaryNode(findings: RefactoringFinding[]): RefactoringFinding[] {
  const seen = new Set<string>();
  const out: RefactoringFinding[] = [];
  for (const finding of findings) {
    const primary = finding.nodes[0];
    if (primary === undefined) { out.push(finding); continue; }
    const key = `${finding.category}\n${primary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}
