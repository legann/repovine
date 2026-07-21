import type { ToolHandler } from '../types.js';

/** Worker-runtime context quality lookup (not harness protocol gate — use CLI for that). */
export const handleGetContextSessionQuality: ToolHandler = (ctx, args) => {
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
  if (!ctx.contextQualityStore) {
    return {
      error: 'Context session quality store is unavailable in this process.',
      sessionId,
    };
  }
  const report = ctx.contextQualityStore.getReport(sessionId, {
    policy: {
      phase: args.phase === 'explore' || args.phase === 'implement' || args.phase === 'annotate'
        ? args.phase
        : undefined,
      mode: args.mode === 'harness' || args.mode === 'client' ? args.mode : undefined,
      qualityThreshold: typeof args.qualityThreshold === 'number' ? args.qualityThreshold : undefined,
      warningThreshold: typeof args.warningThreshold === 'number' ? args.warningThreshold : undefined,
      minAnchors: typeof args.minAnchors === 'number' ? args.minAnchors : undefined,
      byteBudget: typeof args.byteBudget === 'number' ? args.byteBudget : undefined,
      maxRecoveryAttempts: typeof args.maxRecoveryAttempts === 'number' ? args.maxRecoveryAttempts : undefined,
      assignmentScope: Array.isArray(args.assignmentScope)
        ? args.assignmentScope.filter((item): item is string => typeof item === 'string')
        : undefined,
    },
    includeEvents: args.includeEvents === true,
    consume: args.consume === true,
    retain: args.retainSession === true,
  });
  if (!report) {
    return {
      error: `Context session not found: ${sessionId}`,
      sessionId,
    };
  }
  return report;
};
