import type { ToolHandler } from '../../types.js';
import { emptyNavigation, envelope, nav } from '../../response/envelope.js';
import { cleanupOrphanedAnnotations, refreshContextCore } from '../../lib/annotations.js';

export const handleRefreshContext: ToolHandler = async (ctx, args) => {
  const result = await refreshContextCore(ctx, args) as Record<string, unknown>;
  const cleanupOrphans = args.cleanupOrphans === true;
  const orphanNodeType = (args.orphanNodeType as string | undefined) ?? 'all';
  const navigation = emptyNavigation();
  let cleanupResult: unknown;

  const orphanCount = typeof (result.annotations as { orphaned?: unknown } | undefined)?.orphaned === 'number'
    ? (result.annotations as { orphaned: number }).orphaned
    : 0;

  if (cleanupOrphans && orphanCount > 0) {
    cleanupResult = await cleanupOrphanedAnnotations(ctx, { mode: 'remove', nodeType: orphanNodeType });
  } else if (orphanCount > 0) {
    navigation.validate.push(nav('refresh_context', { cleanupOrphans: true, orphanNodeType }, 'Remove orphaned annotations after reviewing the refresh result.'));
    navigation.validate.push(nav('get_annotation_status', { view: 'orphans' }, 'Preview orphaned annotations before deleting them.'));
  }
  navigation.validate.push(nav('get_annotation_status', { view: 'coverage' }, 'Check annotation freshness after refresh.'));

  const gaps: string[] = [];
  if (orphanCount > 0 && !cleanupOrphans) gaps.push(`${orphanCount} orphaned annotation(s) remain until cleanup is requested.`);
  const outsideRepo = result.outsideRepo as { warning?: string } | undefined;
  if (outsideRepo?.warning) gaps.push(outsideRepo.warning);

  return envelope('all', cleanupOrphans ? 'Refreshed graph and cleaned orphaned annotations when present.' : 'Refreshed repository context graph.', {
    refresh: result,
    ...(cleanupResult ? { cleanup: cleanupResult } : {}),
  }, {
    confidence: 'high',
    gaps,
    navigation,
  });
};
