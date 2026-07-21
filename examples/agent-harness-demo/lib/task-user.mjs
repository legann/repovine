// Extract the PM/user task body — without harness prior-run coordination preamble.

const PRIOR_RUN_MARKER = '## Prior harness run';

/** User-facing task text for orient, claims, and CLI query (no prior-run block). */
export function extractUserTask(task = {}) {
  if (typeof task?.userTask === 'string' && task.userTask.trim()) {
    return task.userTask.trim();
  }
  return stripPriorRunBlock(String(task?.task ?? '')).trim();
}

/** Remove harness prior-run summary injected at intake. */
export function stripPriorRunBlock(text = '') {
  const t = String(text);
  const idx = t.indexOf(PRIOR_RUN_MARKER);
  if (idx < 0) return t.trim();
  const after = t.slice(idx + PRIOR_RUN_MARKER.length);
  const nl = after.indexOf('\n\n');
  if (nl >= 0) return after.slice(nl + 2).trim();
  return t.trim();
}
