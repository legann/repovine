// GraphState — the typed channel set the LangGraph orchestrator threads through
// its nodes. Mirrors the "State schema" in docs/langgraph-orchestrator-design.md.
//
// LangGraph merges each node's returned partial into state per-channel. We use
// last-value-wins channels (the default reducer) with explicit defaults so a
// fresh invoke / resumed thread always starts from a known shape.
import { Annotation } from '@langchain/langgraph';

/** last-value-wins channel with an optional default factory. */
const value = (def) => Annotation({ reducer: (_prev, next) => next, default: def });

export const GraphState = Annotation.Root({
  // ── Input (from Telegram or the CLI trigger) ──────────────────────────────
  chatId: value(() => undefined),
  // task: { id, task, scope, acceptanceCriteria?, requestedChecks?, ... }
  task: value(() => undefined),

  // ── Workspace ─────────────────────────────────────────────────────────────
  repoRoot: value(() => undefined),
  // Target behavior: 'sandbox' | 'attach' (lib/target-repo.mjs resolveTargetFromEnv).
  // Distinct from the routing `mode` channel ('single' | 'multi') below — attach
  // invoke input must never alter that one. Capabilities are NOT threaded through
  // state: nodes derive them via targetPolicy(targetMode).
  targetMode: value(() => undefined),

  // ── Protocol artifacts ─────────────────────────────────────────────────────
  assignment: value(() => undefined),
  assignmentFile: value(() => undefined),
  assignmentValid: value(() => undefined),

  result: value(() => undefined),
  resultFile: value(() => undefined),
  schemaValid: value(() => undefined),

  report: value(() => undefined), // AgentComplianceReport from the CLI
  ok: value(() => undefined),

  // ── Worker / session ────────────────────────────────────────────────────────
  llmProvider: value(() => undefined),
  agentArgs: value(() => undefined), // { resume?, capture? } passed to the adapter
  // Per-role provider resume handles: { [role]: sessionId }. Reset to {} at each
  // intake (fresh LLM sessions per /goal). Intra-task resume accumulates via
  // liveSessions in multi.mjs and run_sub_agent capture within one invoke.
  workerSessions: value(() => ({})),
  // turn persists across invokes on the same thread (checkpointed), so a reducer
  // that keeps the larger value survives partial updates from non-intake nodes.
  turn: Annotation({ reducer: (prev, next) => next ?? prev ?? 0, default: () => 0 }),
  // attempts counts run_sub_agent entries within one invoke; bounds the compliance
  // retry loop (HARNESS_MAX_RETRIES) so a persistently-failing run can't spin.
  attempts: Annotation({ reducer: (prev, next) => next ?? prev ?? 0, default: () => 0 }),

  // ── Multi-agent ────────────────────────────────────────────────────────────────
  mode: value(() => 'single'), // graph routing: 'single' | 'multi'
  planMode: value(() => undefined), // decomposition: 'explicit' | 'keyword' | 'auto' | 'single' | 'greenfield-single'
  subAgents: value(() => undefined), // per-sub-agent records (result + own compliance + handoff)
  // multi-agent verdicts + greenfield flag threaded from multiAgent's return so
  // formatMultiReply and repovine-process read the authoritative values instead of
  // recomputing (these were dropped silently before being declared as channels).
  goalOk: value(() => undefined), // goal acceptance (repovineGoalOk)
  processOk: value(() => undefined), // process/run acceptance (equals `ok`)
  signals: value(() => undefined), // gate signal block (multi mode) persisted into summary.json
  greenfield: value(() => undefined), // greenfield sandbox flag from orient
  repovineOrientTrail: value(() => undefined),
  repovineCriteria: value(() => undefined),
  execution: value(() => undefined), // 'sequential' | 'worktree-parallel'
  runtimeCheck: value(() => undefined), // orchestrator spawnSync result (build/test in sandbox)
  leftRunning: value(() => undefined), // procs/ports/containers a worker left running (reaper)
  reaped: value(() => undefined), // true when the reaper killed leftRunning items
  usage: value(() => undefined), // provider-normalized usage total for single or multi run
  usageRollup: value(() => undefined), // run-level usage rollup with fresh/resume split
  mcpRollup: value(() => undefined), // run-level repovine MCP tool-call rollup
  usageRecords: Annotation({
    reducer: (prev, next) => [...(prev ?? []), ...(Array.isArray(next) ? next : next ? [next] : [])],
    default: () => [],
  }),
  telemetry: value(() => undefined), // .harness current-run/summary snapshot

  // ── Control / output ─────────────────────────────────────────────────────────
  error: value(() => undefined),
  replyText: value(() => undefined),
});
