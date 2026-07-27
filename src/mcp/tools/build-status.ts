import type { IndexBuildStatus } from '../build-controller.js';
import type { RepovineState, ToolHandler } from '../types.js';
import { envelope, envelopeError, type ToolResponse } from '../response/envelope.js';
import { buildRefusalReport, outsideRepoReport } from '../lib/refresh-summary.js';

/** Cap below the MCP SDK client's 60s default request timeout: a longer long-poll would always time
 *  out client-side and auto-cancel while the server pends and discards the eventual reply. */
const MAX_WAIT_SEC = 55;

/**
 * Build state as an answer, not as a failure.
 *
 * Asking what the build is doing and learning it failed is an answered question, so a settled-bad
 * build rides a normal envelope with the reason in `gaps`. The failure-shaped payload belongs to the
 * OTHER tools, which could not do their job — see `notReadyResponse`.
 */
function buildStatusEnvelope(snapshot: IndexBuildStatus, state: RepovineState | undefined): ToolResponse {
  const domainsSuggestions = state?.domainsSuggestions;
  // A cold start never calls refresh_context, so this is the only place the first build can report
  // what it refused.
  const outsideRepo = state ? outsideRepoReport(state.snapshot) : undefined;
  const buildRefusals = state ? buildRefusalReport(state.snapshot) : undefined;
  const settledBad = snapshot.status === 'failed' || snapshot.status === 'cancelled';
  return envelope('all', `Build status: ${snapshot.status}.`, {
    ...snapshot,
    ...(domainsSuggestions ? {
      domainsSuggestions: {
        count: domainsSuggestions.count,
        axes: domainsSuggestions.axes,
        declinedHidden: domainsSuggestions.declinedHidden,
      },
    } : {}),
    ...(outsideRepo ? { outsideRepo } : {}),
    ...(buildRefusals ? { buildRefusals } : {}),
  }, {
    confidence: 'high',
    gaps: [
      ...(settledBad ? [snapshot.message] : []),
      ...(buildRefusals ?? []).map(r => r.message),
    ],
  });
}

/**
 * Always callable, including before the graph exists — it reads the build lifecycle rather than the
 * graph, so it is dispatched ahead of the not-ready gate.
 */
export const handleGetBuildStatus: ToolHandler = async (ctx, args) => {
  const build = ctx.build;
  if (!build) return envelopeError('all', 'Build status is unavailable in this process.');

  // Mutating branch: stop the in-flight startup build and return the resulting status. Ignores
  // waitSec; a no-op (current snapshot) when no build is running.
  if (args.cancel === true) return buildStatusEnvelope(await build.cancel(), build.readyState());

  const raw = args.waitSec;
  const waitSec = typeof raw === 'number' && Number.isFinite(raw)
    ? Math.min(MAX_WAIT_SEC, Math.max(0, Math.floor(raw)))
    : 0;
  const snapshot = waitSec > 0 ? await build.waitForSettled(waitSec, ctx.signal) : build.snapshot();
  return buildStatusEnvelope(snapshot, snapshot.status === 'ready' ? build.readyState() : undefined);
};
