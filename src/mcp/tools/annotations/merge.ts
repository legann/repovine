import { getAnnotationMergeStatus, mergeAnnotationsOnDisk } from '../../../annotations/maintenance.js';
import type { ToolHandler } from '../../types.js';
import { emptyNavigation, envelope, nav } from '../../response/envelope.js';

export const handleGetAnnotationMergeStatus: ToolHandler = (ctx, _args) => {
  const result = getAnnotationMergeStatus(ctx.repoRoot);
  const navigation = emptyNavigation();
  if (result.file.hasConflictMarkers) {
    navigation.validate.push(nav('merge_annotations', {}, 'Resolve repovine.annots.json with merge_annotations.'));
  }
  navigation.validate.push(nav('validate_annotations', {}, 'Validate annotation freshness and orphan status.'));
  return envelope('all', 'Checked annotation merge status.', result, {
    confidence: 'high',
    gaps: result.file.error ? [result.file.error] : [],
    navigation,
  });
};

export const handleMergeAnnotations: ToolHandler = async (ctx, args) => {
  const dryRun = args.dryRun === true;
  const fromIndex = args.fromIndex === true;
  const merge = mergeAnnotationsOnDisk(ctx.repoRoot, { dryRun, fromIndex });
  const navigation = emptyNavigation();
  const gaps: string[] = [];

  if (merge.status === 'error') {
    gaps.push(merge.message);
  } else if (!dryRun && merge.wroteFile) {
    // The refresh re-reads the merged file into the live store. Its never-drop net would restore
    // nodes this merge deleted, so hand the resolution over before refreshing.
    if (merge.deletedNodeIds?.length) {
      ctx.getState().annotations.forgetDeletedOnDisk(merge.deletedNodeIds);
    }
    await Promise.resolve(ctx.refreshRepoState());
  }

  if (merge.baseWarning) gaps.push(merge.baseWarning);
  if (merge.replacedBackupPath) {
    gaps.push(
      `Merged from git index stages; the replaced conflicted file is backed up at ${merge.replacedBackupPath}. `
      + 'Edits made directly in the conflicted worktree file are not part of the merge input.',
    );
  }
  if (merge.indexUnmerged) {
    navigation.validate.push(nav(
      'merge_annotations',
      { fromIndex: true },
      'Merge the unmerged git index stages for repovine.annots.json.',
    ));
  }

  if (merge.annotationConflicts.length > 0) {
    gaps.push(`${merge.annotationConflicts.length} annotation conflict(s) need review.`);
    gaps.push('Scalar conflicts add patterns merge-review:* and [merge-review:…:ours/theirs] assumptions; rewrite via write_annotation.');
    navigation.validate.push(nav('validate_annotations', {}, 'Validate the merged file, then inspect conflicted node IDs.'));
    for (const conflict of merge.annotationConflicts.slice(0, 5)) {
      navigation.deeper.push(nav('inspect_node', { nodeId: conflict.nodeId }, 'Inspect a node with an annotation merge conflict.'));
    }
  } else if (merge.status !== 'error') {
    navigation.validate.push(nav('validate_annotations', {}, 'Validate merged annotations against the current graph.'));
  }

  return envelope('all', merge.status === 'error' ? 'Annotation merge failed.' : 'Annotation merge completed.', {
    merge,
  }, {
    confidence: merge.status === 'error' ? 'low' : merge.annotationConflicts.length > 0 ? 'medium' : 'high',
    gaps,
    navigation,
  });
};
