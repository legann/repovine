/**
 * Backlog builders for tests that stub `AnnotationStore`.
 *
 * Typed against the real shapes and projecting through the real counters, so a stub answers about
 * its rows the way the store does — only the walk is faked.
 */
import {
  countBacklogPhases,
  countBacklogRows,
  filterRowsByStaleKind,
  type AnnotationQueuePage,
  type BacklogCoverage,
  type BacklogRow,
  type KindCoverage,
  type QueuePhase,
  type QueueStatus,
  type StaleKind,
} from '../../src/annotations/backlog.js';

export function kindCoverage(overrides: Partial<KindCoverage> = {}): KindCoverage {
  return { total: 0, annotated: 0, fresh: 0, stale: 0, unannotated: 0, unconfirmable: 0, ...overrides };
}

export function backlogCoverage(overrides: Partial<BacklogCoverage> = {}): BacklogCoverage {
  return {
    modules: kindCoverage(),
    templates: kindCoverage(),
    infraModules: kindCoverage(),
    services: kindCoverage(),
    domains: { ...kindCoverage(), list: [] },
    byDomain: {},
    byTier: {},
    ...overrides,
  };
}

/** A stubbed needs-work row: classification and phase, with whatever item fields the test asserts on. */
export type FakeQueueRow = {
  nodeId: string;
  status: QueueStatus;
  staleKind?: StaleKind;
  phase: QueuePhase;
} & Record<string, unknown>;

/** A `getQueuePage` stub over fixed rows, filtered/counted/paged by the real projection. */
export function fakeQueuePage(rows: readonly FakeQueueRow[]) {
  return (
    _graph: unknown,
    _snapshot: unknown,
    options: { limit?: number; offset?: number; derivedOnly?: boolean; staleKind?: StaleKind } = {},
  ): AnnotationQueuePage => {
    const all = rows as unknown as BacklogRow[];
    let display = options.derivedOnly ? filterRowsByStaleKind(all, 'propagation') : all;
    if (options.staleKind) display = filterRowsByStaleKind(display, options.staleKind);
    const limit = options.limit ?? 10;
    const offset = options.offset ?? 0;
    return {
      items: display.slice(offset, offset + limit) as unknown as AnnotationQueuePage['items'],
      counts: countBacklogRows(all),
      displayCounts: countBacklogRows(display),
      byType: countBacklogPhases(display),
    };
  };
}
