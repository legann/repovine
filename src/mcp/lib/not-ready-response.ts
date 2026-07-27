import type { IndexBuildStatus } from '../build-controller.js';
import { envelope, envelopeError, type ToolResponse } from '../response/envelope.js';
import { nextCall } from '../../response/next-call.js';

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
      nextAction: snapshot.status === 'cancelled'
        ? nextCall('refresh_context', {}, 'Start a fresh build; `repovine build` plus a server restart does the same from outside.')
        : nextCall('refresh_context', {}, 'Fix the reported build error first, then rebuild. Direct file reads work meanwhile.'),
      ...(snapshot.errorMessage ? { errorMessage: snapshot.errorMessage } : {}),
    });
  }
  return envelope('all', snapshot.message, {
    ...snapshot,
    // The one payload that carries its next call outside `navigation`: navigation needs a resolved
    // scope, and this answers before there is one. Same shape, different slot.
    nextAction: nextCall(
      'get_build_status',
      { waitSec: 45 },
      'Wait server-side until the build settles. If it returns still building, report stage/remainingStages and continue with direct file reads when possible instead of polling.',
    ),
  }, { confidence: 'low' });
}
