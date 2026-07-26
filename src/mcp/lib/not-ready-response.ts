import type { IndexBuildStatus } from '../build-controller.js';
import { envelope, envelopeError, type ToolResponse } from '../response/envelope.js';

/**
 * The payload a tool returns when the graph is not ready.
 *
 * Two different situations wear one shape badly. A build still running is informational: the caller
 * waits and retries, so it stays a success-shaped progress report and harness retry logic keeps its
 * nerve. A build that FAILED or was CANCELLED has already settled — telling that caller to wait for
 * it to settle and retry describes something that cannot happen, and the retry fails identically.
 * Terminal states therefore report an error with the action that actually recovers.
 *
 * Progress carries the snapshot itself, so the field names a caller reads here are the ones
 * `get_build_status` returns for the same build, under the envelope every tool answers in.
 *
 * `scope` is `all` because the payload describes the repository build rather than the scope the
 * caller asked about: with no graph there is nothing to resolve that scope against. `confidence` is
 * `low` for the same reason — the request did not resolve, which is what that field grades.
 */
export function notReadyResponse(snapshot: IndexBuildStatus): ToolResponse {
  if (snapshot.status === 'failed' || snapshot.status === 'cancelled') {
    return envelopeError('all', snapshot.message, {
      status: snapshot.status,
      stage: snapshot.stage,
      fix: snapshot.status === 'cancelled'
        ? 'Call refresh_context to start a fresh build, or run `repovine build` and restart the server.'
        : 'Fix the reported build error, then call refresh_context to rebuild. Direct file reads work meanwhile.',
      ...(snapshot.errorMessage ? { errorMessage: snapshot.errorMessage } : {}),
    });
  }
  return envelope('all', snapshot.message, {
    ...snapshot,
    // The only tool payload that names its own next call. Every other response steers through
    // `navigation`, which needs a resolved scope; this one answers before there is one.
    nextAction: 'Call get_build_status (always available) once with waitSec (e.g. { waitSec: 45 }) to wait server-side until the build settles. If it returns still building, report stage/remainingStages and continue with direct file reads when possible instead of polling.',
  }, { confidence: 'low' });
}
