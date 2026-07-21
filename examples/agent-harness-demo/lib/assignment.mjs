// task (from the queue / Telegram / an issue) -> AgentAssignment (Agent Protocol v1).
//
// This is the harness-facing request repovine schema-validates before dispatch.
// Schema source of truth: repovine/src/agents/protocol.ts (AgentAssignmentSchema).
import { toContractStrings } from './claude-agent.mjs';

export function buildAssignment(task) {
  return {
    protocolVersion: '1',
    runId: task.runId || `run-${task.id}`,
    task: task.task,
    scope: task.scope ?? [],
    acceptanceCriteria: task.acceptanceCriteria ?? [],
    constraints: task.constraints ?? [],
    // contracts must be string[]; a prior subAgent's contractsChanged (threaded by
    // buildSubAgentTask) or a planner-emitted object would otherwise fail the schema
    // gate and block the subAgent before it runs.
    contracts: toContractStrings(task.contracts ?? []),
    requestedChecks: task.requestedChecks ?? [],
    // contextSession is set by intake on every turn (sessionId/mode/required).
    // repovine itself exempts the greenfield first pass from context scoring, so the
    // harness does not special-case iteration 1. The worker threads
    // contextSession.sessionId on its MCP calls and echoes it on the result.
    ...(task.contextSession ? { contextSession: task.contextSession } : {}),
  };
}
