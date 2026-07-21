// Worker session-map helpers — resume provider conversations within one invoke.
//
// Cross-/task policy: intake resets workerSessions to {} so each /task opens fresh
// LLM operator sessions. Intra-task resume (retries, implement → annotation-sync)
// uses liveSessions accumulated inside multi.mjs / run_sub_agent during one invoke.

/** Collect role→sessionId from finished sub-agents (last writer wins per role). */
export function collectSubAgentSessions(subAgents = []) {
  const out = {};
  for (const l of subAgents) {
    if (l?.role && l?.workerSessionId) out[l.role] = l.workerSessionId;
  }
  return out;
}

/**
 * Merge session maps (utility for tests / future channels). Not used for cross-/task
 * resume — each /task starts with workerSessions: {} from intake.
 */
export function mergeSessions(prior = {}, next = {}) {
  return { ...(prior || {}), ...(next || {}) };
}
