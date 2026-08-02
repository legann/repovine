// task (from the queue / Telegram / an issue) -> AgentAssignment (Delivery Protocol v1).
//
// This is the harness-facing request repovine schema-validates before dispatch.
// Schema source of truth: repovine/src/agents/protocol.ts (AgentAssignmentSchema).
import { toContractStrings } from './claude-agent.mjs';

// AcceptanceCriterion[] the schema requires: { id, statement, required }. A task may
// carry criteria as bare strings (the human/queue form) or already-structural
// objects (threaded parent->subAgent). Mint a stable id for the string form; pass the
// structural form through, defaulting `required` to true. Empty/absent -> [].
export function toAcceptanceCriteria(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((c, i) => {
    if (c && typeof c === 'object') {
      return {
        id: String(c.id ?? `c${i + 1}`),
        statement: String(c.statement ?? ''),
        required: c.required ?? true,
        ...(c.kind === 'invariant' || c.kind === 'delivery' ? { kind: c.kind } : {}),
      };
    }
    return { id: `c${i + 1}`, statement: String(c), required: true };
  });
}

export function buildAssignment(task) {
  return {
    protocolVersion: '1',
    runId: task.runId || `run-${task.id}`,
    // Required by the schema since S3/S4. `role` is the Delivery Protocol role
    // (buildSubAgentTask resolves it from the spec manifest; the main flow defaults
    // to `main`). `version` is the assignment-revision counter checked against
    // verificationPolicy.version when a policy is supplied; it starts at 1.
    role: task.role ?? 'main',
    task: task.task,
    scope: task.scope ?? [],
    version: task.version ?? 1,
    acceptanceCriteria: toAcceptanceCriteria(task.acceptanceCriteria),
    constraints: task.constraints ?? [],
    // contracts must be string[]; a prior subAgent's contractsChanged (threaded by
    // buildSubAgentTask) or a planner-emitted object would otherwise fail the schema
    // gate and block the subAgent before it runs.
    contracts: toContractStrings(task.contracts ?? []),
    requestedChecks: task.requestedChecks ?? [],
    // Optional delivery/verification custody, passed through when the harness froze
    // one for this task. `delivery` names the base/head revisions repovine diffs;
    // `verificationPolicy` freezes the evidence each criterion needs.
    ...(task.delivery ? { delivery: task.delivery } : {}),
    ...(task.verificationPolicy ? { verificationPolicy: task.verificationPolicy } : {}),
    // contextSession is set by intake on every turn (sessionId/mode/required).
    // repovine itself exempts the greenfield first pass from context scoring, so the
    // harness does not special-case iteration 1. The worker threads
    // contextSession.sessionId on its MCP calls and echoes it on the result.
    ...(task.contextSession ? { contextSession: task.contextSession } : {}),
  };
}
