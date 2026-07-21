import type { SemanticSyncReport } from '../../semantic/store.js';
import type { SemanticSearchRefresh } from '../types.js';

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
