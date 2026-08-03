import { formatSubmittedAnnotationMetrics, type SubmittedAnnotationMetrics } from '../../../annotations/annotation-metrics.js';
import type { ToolHandler } from '../../types.js';
import { resolveScope } from '../../scope/resolve.js';
import { scopeNavigation } from '../../scope/navigation.js';
import { envelope, nav } from '../../response/envelope.js';
import { annotateModule } from '../../lib/annotations.js';

export const handleWriteAnnotation: ToolHandler = async (ctx, args) => {
  const result = annotateModule(ctx, args) as Record<string, unknown>;
  const scope = resolveScope(ctx, args.nodeId);
  const navigation = scopeNavigation(scope);
  const error = typeof result.error === 'string' ? result.error : undefined;
  if (!error) {
    navigation.validate.push(nav('inspect_node', { nodeId: args.nodeId }, 'Read back the annotation and quality score for this node.'));
  }

  const annotations = ctx.getState().annotations;
  // The store persists via an 800ms debounced save; the write is in memory now, on disk shortly.
  // `durable: true` blocks on the flush so the response reflects a durable commit.
  const durable = args.durable === true;
  let persisted = false;
  let durableFailure: string | undefined;
  if (!error && durable) {
    try {
      await annotations.flushAsync();
      persisted = true;
    } catch (e) {
      // The annotation is safe in memory and re-armed for retry; report that durability was NOT achieved.
      durableFailure = (e as Error).message;
      result.persistenceError = durableFailure;
    }
  }
  const lastSaveError = annotations.lastSaveError;
  if (!error) {
    result.persistence = {
      durable,
      persisted,
      ...(lastSaveError ? { lastSaveError } : {}),
    };
  }

  const submittedMetrics = !error && result.submittedAnnotation
    ? result.submittedAnnotation as SubmittedAnnotationMetrics
    : undefined;
  const submittedLabel = submittedMetrics ? formatSubmittedAnnotationMetrics(submittedMetrics) : undefined;
  // durable+failed is not "queued" — the flush was attempted and failed; say so.
  const durabilityNote = persisted
    ? 'persisted to disk'
    : durableFailure ? 'in memory, disk write FAILED' : 'disk write queued';
  const summary = error
    ? `Failed to save annotation: ${error}`
    : submittedLabel
      ? `Saved annotation (${submittedLabel}) — ${durabilityNote}.`
      : `Saved annotation — ${durabilityNote}.`;

  const gaps: string[] = [];
  if (error) gaps.push(error);
  else {
    if (durableFailure) {
      gaps.push(`durable: true requested but the disk write failed: ${durableFailure}. The annotation is held in memory and will retry; it is NOT yet on disk.`);
    }
    if (lastSaveError && lastSaveError !== durableFailure) {
      gaps.push(`A previous annotation save failed: ${lastSaveError}. Writes retry automatically; run validate_annotations to confirm the file is healthy.`);
    }
  }

  // A durable write that did not reach disk is a weaker guarantee than the caller asked for.
  const confidence = error || durableFailure ? 'low' : 'high';
  return envelope(scope, summary, result, {
    confidence,
    gaps,
    navigation,
  });
};
