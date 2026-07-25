import type { IndexBuildStatus } from '../build-controller.js';

/**
 * The payload a tool returns when the graph is not ready.
 *
 * Two different situations wear one shape badly. A build still running is informational: the caller
 * waits and retries, so it stays a success-shaped progress report and harness retry logic keeps its
 * nerve. A build that FAILED or was CANCELLED has already settled — telling that caller to wait for
 * it to settle and retry describes something that cannot happen, and the retry fails identically.
 * Terminal states therefore report an error with the action that actually recovers.
 */
export function notReadyResponse(snapshot: IndexBuildStatus): Record<string, unknown> {
  if (snapshot.status === 'failed' || snapshot.status === 'cancelled') {
    return {
      status: snapshot.status,
      stage: snapshot.stage,
      error: snapshot.message,
      fix: snapshot.status === 'cancelled'
        ? 'Call refresh_context to start a fresh build, or run `repovine build` and restart the server.'
        : 'Fix the reported build error, then call refresh_context to rebuild. Direct file reads work meanwhile.',
      ...(snapshot.errorMessage ? { errorMessage: snapshot.errorMessage } : {}),
    };
  }
  return {
    status: snapshot.status,
    stage: snapshot.stage,
    pct: snapshot.pct,
    done_packages: snapshot.donePackages,
    total_packages: snapshot.totalPackages,
    done_modules: snapshot.doneModules,
    total_modules: snapshot.totalModules,
    done_semantic_cards: snapshot.doneSemanticCards,
    total_semantic_cards: snapshot.totalSemanticCards,
    current_package: snapshot.currentPackage,
    elapsed_sec: snapshot.elapsedSec,
    eta_sec: snapshot.etaSec,
    retry_after_sec: snapshot.retryAfterSec,
    message: snapshot.message,
    next_action: 'Call get_build_status (always available) for live progress — pass waitSec (e.g. { waitSec: 45 }) to wait server-side until the build settles instead of polling; then retry this tool.',
    errorMessage: snapshot.errorMessage,
  };
}
