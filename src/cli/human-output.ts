/**
 * Human-readable CLI formatters for repovine operational commands.
 */

export interface CompactCoverage {
  totalModules: number;
  annotated: number;
  fresh: number;
  stale: number;
  unannotated: number;
}

export function formatModuleCoverageLine(coverage: CompactCoverage): string {
  return `${coverage.fresh}/${coverage.totalModules} modules fresh, ${coverage.unannotated} unannotated, ${coverage.stale} stale`;
}
