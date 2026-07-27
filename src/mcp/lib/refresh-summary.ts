import type { SemanticSyncReport } from '../../semantic/store.js';
import type { RepositoryFactsSnapshot } from '../../types.js';
import type { SemanticSearchRefresh } from '../types.js';
import { shortenList, omittedNote } from '../../platform/text.js';

/** How many refused paths the report names before it falls back to a count. */
const OUTSIDE_REPO_SAMPLE = 5;

export interface OutsideRepoReport {
  count: number;
  sample: string[];
  warning: string;
}

/**
 * Names the cause an operator has to act on. A path spelled with a leading `..` was reached by a
 * scan or tsconfig entry pointing past the workspace root; one spelled inside the repository got
 * out through a link. Sending someone hunting for the wrong one wastes the report.
 */
function outsideRepoCause(paths: readonly string[]): string {
  const named = paths.filter(p => p.startsWith('../')).length;
  if (named === paths.length) return 'are named past the workspace root by the scan or tsconfig configuration';
  if (named === 0) return 'name an in-repo path but resolve outside the repository through a link';
  return `resolve outside the repository — ${named} named past the workspace root, ${paths.length - named} through a link`;
}

/**
 * Files the build refused because they resolve outside the repository, for `refresh_context` and
 * `get_build_status`. The pipeline log carries the same fact, but it is silent under the MCP
 * server, so an agent would otherwise see the files simply missing from the graph.
 * Absent when nothing was refused.
 */
export function outsideRepoReport(snapshot: RepositoryFactsSnapshot): OutsideRepoReport | undefined {
  const paths = snapshot.outsideRepoPaths ?? [];
  if (paths.length === 0) return undefined;
  const { shown: sample, omitted } = shortenList(paths, OUTSIDE_REPO_SAMPLE);
  const more = omittedNote(omitted);
  return {
    count: paths.length,
    sample,
    warning: `${paths.length} file(s) ${outsideRepoCause(paths)}, `
      + `so they are absent from the graph: ${sample.join(', ')}${more}. `
      + 'repovine indexes one workspace root (see docs/workspace-files.md).',
  };
}

/** Map internal sync report to the compact refresh_context semanticSearch block. */
export function semanticSearchRefreshFromSync(
  report: SemanticSyncReport | null,
  options: { enabled: boolean; error?: string; cachedTotal?: number } = { enabled: true },
): SemanticSearchRefresh {
  if (!options.enabled) return { status: 'disabled' };
  if (options.error) {
    return { status: 'failed', total: options.cachedTotal ?? report?.total ?? 0, error: options.error };
  }
  if (!report) {
    return { status: 'failed', total: options.cachedTotal ?? 0, error: 'semantic index sync did not complete' };
  }
  if (report.embedded > 0) {
    return { status: 'updated', embedded: report.embedded, total: report.total };
  }
  return { status: 'up_to_date', total: report.total };
}
