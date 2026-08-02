// LangGraph workflow — compiles GraphState + nodes into a runnable graph.
//
// LangGraph owns step order, branching, retries and persisted state; it does NOT
// pick the LLM (that is run_sub_agent via LLM_PROVIDER) and never imports repovine
// internals (orchestrator nodes shell out to the CLI). Swapping LangGraph for
// another engine means re-wiring these same node functions — the protocol
// boundary stays put.
import { StateGraph, START, END, MemorySaver } from '@langchain/langgraph';
import { GraphState } from './state.mjs';
import {
  intake,
  buildAssignmentNode,
  validateAssignmentNode,
  runSubAgent,
  persistResult,
  validateResultNode,
  complianceNode,
  runtimeCheckNode,
  composeReply,
} from './nodes.mjs';
import { multiAgent } from './multi.mjs';
import { isRetriable } from './retry.mjs';

// Default to one retry: a rejected run (e.g. the harness annotation-coverage gate
// firing because the agent left unannotated/stale/orphan nodes) is re-run once
// with the blocker context folded into the task, which is usually enough to drain
// the queue. Set HARNESS_MAX_RETRIES=0 to disable.
const MAX_RETRIES = Number(process.env.HARNESS_MAX_RETRIES ?? 1);

// After intake: a bad provider (or other intake error) skips straight to the
// reply; a multi-agent task goes to the fan-out node; otherwise the single subAgent.
function routeAfterIntake(state) {
  if (state.error) return 'compose_reply';
  return state.mode === 'multi' ? 'multi_agent' : 'build_assignment';
}

// After the schema gate: only spend on a worker if the assignment is valid.
function routeAfterAssignment(state) {
  return state.assignmentValid ? 'run_sub_agent' : 'compose_reply';
}

// After compliance: optionally retry a rejected run (bounded by HARNESS_MAX_RETRIES).
// Shared policy with the multi-subAgent loop (isRetriable in lib/graph/retry.mjs): only a
// non-blocked/non-failed run that compliance rejected WITH actionable notes is retried
// (a blocked/failed worker — e.g. missing auth — won't fix itself).
function routeAfterCompliance(state) {
  if (!state.ok && isRetriable(state.result, state.report, state.assignment) && (state.attempts ?? 0) <= MAX_RETRIES) {
    return 'run_sub_agent';
  }
  return 'runtime_check';
}

/** Build (and compile) the orchestrator graph. Pass a checkpointer for threaded state. */
export function buildGraph({ checkpointer = new MemorySaver() } = {}) {
  const workflow = new StateGraph(GraphState)
    .addNode('intake', intake)
    .addNode('multi_agent', multiAgent)
    .addNode('build_assignment', buildAssignmentNode)
    .addNode('validate_assignment', validateAssignmentNode)
    .addNode('run_sub_agent', runSubAgent)
    .addNode('persist_result', persistResult)
    .addNode('validate_result', validateResultNode)
    .addNode('compliance', complianceNode)
    .addNode('runtime_check', runtimeCheckNode)
    .addNode('compose_reply', composeReply)
    .addEdge(START, 'intake')
    .addConditionalEdges('intake', routeAfterIntake, ['multi_agent', 'build_assignment', 'compose_reply'])
    .addEdge('multi_agent', 'compose_reply')
    .addEdge('build_assignment', 'validate_assignment')
    .addConditionalEdges('validate_assignment', routeAfterAssignment, ['run_sub_agent', 'compose_reply'])
    .addEdge('run_sub_agent', 'persist_result')
    .addEdge('persist_result', 'validate_result')
    .addEdge('validate_result', 'compliance')
    .addConditionalEdges('compliance', routeAfterCompliance, ['run_sub_agent', 'runtime_check'])
    .addEdge('runtime_check', 'compose_reply')
    .addEdge('compose_reply', END);

  return workflow.compile({ checkpointer });
}

/**
 * Convenience invoke for a single task. `threadId` keys the checkpointer (one
 * thread per Telegram chat). Each invoke runs intake (fresh workerSessions,
 * prior-run summary, active/ wipe only; runs/ archive survives until /reset).
 */
export async function invokeGraph(graph, input, { threadId, signal, capture } = {}) {
  return graph.invoke(input, {
    // `signal` (top-level + configurable) carries /stop into run_sub_agent; `capture`
    // is a shared object the channel reads the provider sessionId back from.
    configurable: { thread_id: threadId || `task:${input.task?.id || Date.now()}`, signal, capture },
    ...(signal ? { signal } : {}),
  });
}
