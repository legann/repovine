import { validateAnnotationHealth } from '../../../annotations/maintenance.js';
import type { ToolHandler } from '../../types.js';
import { resolveScope } from '../../scope/resolve.js';
import { emptyNavigation, envelope, nav } from '../../response/envelope.js';
import { renderNextCall } from '../../../response/next-call.js';
import { limitFrom, DEFAULT_VALIDATE_LIMIT } from '../../response/pagination.js';

function scopeHintsFromArgs(args: Record<string, unknown>): string[] | undefined {
  if (typeof args.scope === 'string' && args.scope.trim()) return [args.scope.trim()];
  if (Array.isArray(args.scope)) {
    const hints = args.scope.filter((s): s is string => typeof s === 'string' && Boolean(s.trim())).map((s) => s.trim());
    if (hints.length) return hints;
  }
  return undefined;
}

export const handleValidateAnnotations: ToolHandler = (ctx, args) => {
  const { graph, snapshot, annotations } = ctx.getState();
  const limit = limitFrom(args, DEFAULT_VALIDATE_LIMIT, 100);
  const scopeHints = scopeHintsFromArgs(args);
  const validation = validateAnnotationHealth({
    repoRoot: ctx.repoRoot,
    graph,
    snapshot,
    annotations,
    limit,
    ...(scopeHints ? { scope: scopeHints } : {}),
  });
  const navigation = emptyNavigation();
  if (validation.mergeStatus.file.hasConflictMarkers) {
    navigation.validate.push(nav('merge_annotations', {}, 'Resolve repovine.annots.json before validation can be clean.'));
  }
  if (validation.counts.orphaned > 0) {
    navigation.validate.push(nav('get_annotation_status', { view: 'orphans' }, 'Review orphaned annotations.'));
    navigation.validate.push(nav('refresh_context', { cleanupOrphans: true }, 'Remove orphaned annotations after reviewing them.'));
  }
  if (validation.counts.stale > 0 || validation.counts.unannotated > 0
    || validation.counts.stalePropagation > 0) {
    navigation.validate.push(nav('get_annotation_status', { view: 'queue', limit, ...(scopeHints ? { scope: scopeHints[0] } : {}) }, 'Process annotation queue items.'));
  }
  if (validation.counts.stalePropagation > 0) {
    navigation.validate.push(nav('get_annotation_status', { view: 'queue', limit }, 'Drain queue top page (content-stale before propagation-stale).'));
  }
  const scopedReview = scopeHints && validation.scopedClean === false;
  const hasPropagationStale = validation.counts.stalePropagation > 0;
  const message = (scopeHints ? validation.scopedClean : validation.status === 'clean')
    ? scopeHints
      ? `Annotations are valid in scope [${scopeHints.join(', ')}].`
      : 'Annotations are valid for the current graph.'
    : scopedReview
      ? `Annotations need review in scope [${scopeHints.join(', ')}].`
      : hasPropagationStale
        ? 'Annotations need review (propagation-stale items remain).'
        : 'Annotations need review.';
  // Resolve the first hint like every navigation tool does (status.ts pattern):
  // a validated pkg:/mod:/domain: scope answers with its real kind instead of
  // the string-scope envelope default `kind:'unknown'`.
  return envelope(scopeHints ? resolveScope(ctx, scopeHints[0]) : 'all', message, {
    validation,
  }, {
    confidence: (scopeHints ? validation.scopedClean : validation.status === 'clean') ? 'high' : 'medium',
    // The health report's own next calls, rendered for the envelope's prose channel. `clean` is a
    // field on the report now, so nothing has to recognise a status line by its text.
    gaps: (scopeHints ? validation.scopedClean : validation.status === 'clean')
      ? []
      : validation.nextActions.map(renderNextCall),
    navigation,
  });
};
