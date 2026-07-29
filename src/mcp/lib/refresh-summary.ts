import type { SemanticSyncReport } from '../../semantic/store.js';
import type { RepositoryFactsSnapshot, RepositoryGraph } from '../../types.js';
import { getGraphExtensions, getProjectionReport } from '../../graph/build-artifact.js';
import { extensionSchemas } from '../../graph/extension-store.js';
import type { SemanticSearchRefresh } from '../types.js';
import type { Refusal } from '../../response/refusal.js';
import { OUTSIDE_WORKSPACE_REFUSAL } from '../../stage1/refusal-kinds.js';

export interface OutsideRepoReport {
  count: number;
  sample: string[];
  warning: string;
}

/**
 * Everything the build refused, for `refresh_context`, `get_build_status` and `repovine status`.
 * The pipeline log carries the same facts and is silent under all three, so without this a reader
 * sees the files simply missing from the graph. Absent when the build refused nothing.
 */
export function buildRefusalReport(snapshot: RepositoryFactsSnapshot): Refusal[] | undefined {
  const refusals = snapshot.buildRefusals ?? [];
  return refusals.length > 0 ? refusals : undefined;
}

export interface ProjectionReport {
  /** One entry per projector that ran, with its batch tally. */
  contributors: Array<{
    pluginId: string;
    contributorId: string;
    status: 'applied' | 'skipped' | 'failed';
    reason?: string;
    appliedBatches: number;
    rejectedBatches: number;
  }>;
  /** Namespaced extensions the build stored, counted by owner and schema. */
  extensions: Array<{ pluginId: string; schema: string; count: number }>;
}

/**
 * What plugin projection did this build, for `refresh_context` and `get_build_status`.
 *
 * Refusals already carry every rejection and its cause; this carries the other half, so a projector
 * that ran and contributed nothing is distinguishable from one that was never asked. The extension
 * inventory names owners and schemas without reading a payload — generic tools enumerate them, they
 * do not interpret them. Absent when the build had no projector and stored no extension.
 */
export function projectionReport(graph: RepositoryGraph): ProjectionReport | undefined {
  const contributors = getProjectionReport(graph).map(outcome => ({
    pluginId: outcome.pluginId,
    contributorId: outcome.contributorId,
    status: outcome.status,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    appliedBatches: outcome.batches.filter(batch => batch.status === 'applied').length,
    rejectedBatches: outcome.batches.filter(batch => batch.status === 'rejected').length,
  }));
  const extensions = extensionSchemas(getGraphExtensions(graph));
  if (contributors.length === 0 && extensions.length === 0) return undefined;
  return { contributors, extensions };
}

/**
 * The containment slice of the same sink, in the shape `refresh_context` has always published it.
 * Picked out by the refusal's declared `kind`, not by whichever field it happens to carry: a second
 * refusal that also names paths would otherwise be published as this one and hide it. The sentence
 * is the refusal's own, composed where the paths were refused, so the report does not re-derive a
 * cause from a list that has already lost the context it was refused in.
 */
export function outsideRepoReport(snapshot: RepositoryFactsSnapshot): OutsideRepoReport | undefined {
  const found = (snapshot.buildRefusals ?? []).find(r => r.kind === OUTSIDE_WORKSPACE_REFUSAL);
  if (!found) return undefined;
  const count = typeof found.details?.count === 'number' ? found.details.count : 0;
  const sample = Array.isArray(found.details?.sample) ? found.details.sample as string[] : [];
  if (count === 0) return undefined;
  return { count, sample, warning: found.message };
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
