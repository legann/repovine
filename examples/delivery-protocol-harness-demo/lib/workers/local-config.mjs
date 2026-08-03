// Config for the vendor-neutral `local` provider (LLM_PROVIDER=local).
//
// Like claude-config.mjs, split the CLIENT wiring (which endpoint to hit,
// optional key) from the per-RUN options (which model, sampling, and the
// repovine MCP stdio descriptor). The whole premise of `local` is that the MODEL
// IS CONFIG — point LOCAL_BASE_URL at any OpenAI-compatible chat endpoint (Ollama,
// vLLM, LM Studio, llama.cpp server) and set LOCAL_MODEL; switching Qwen↔Mistral is
// an env change, never a code change.
import { resolveLocalRole } from '../model-role.mjs';
import { buildRepovineMcpStdio } from './mcp.mjs';
import { finitePositive } from '../num.mjs';

/**
 * Strip private reasoning blocks many OSS models leak into chat content
 * (`<think>…</think>`, `<reasoning>…</reasoning>`) so they never reach the user or
 * the AgentRunResult summary. Shared by the worker loop and the planner.
 */
export function stripReasoning(text) {
  return String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .trim();
}

/** Optional bearer key. Most local runtimes ignore it; Ollama accepts any value. */
export function localApiKey() {
  return process.env.LOCAL_API_KEY || undefined;
}

/**
 * OpenAI-compatible base url, trailing slash trimmed so callers append
 * `/chat/completions` uniformly. This is the local provider's "credential" — its
 * presence is what makes auth pass (see lib/workers/auth.mjs).
 */
export function localBaseUrl() {
  const raw = process.env.LOCAL_BASE_URL?.trim();
  return raw ? raw.replace(/\/+$/, '') : undefined;
}

/** Hard wall-clock cap for a worker run (mirrors WORKER_TIMEOUT_MS). */
export function localTimeoutMs() {
  return finitePositive(process.env.LOCAL_TIMEOUT_MS || process.env.WORKER_TIMEOUT_MS, 600000);
}

/**
 * Per-request timeout for a single chat-completions / MCP round trip. Defaults high
 * (5 min) because a big local model's FIRST request pays a cold model-load cost (a
 * 32B model is ~20 GB to page in) on top of processing the full tool schema — 18+
 * tools (local + repovine MCP) make that first prompt large. The run-level
 * LOCAL_TIMEOUT_MS is the real budget; this just stops a single wedged request.
 */
export function localRequestTimeoutMs() {
  return finitePositive(process.env.LOCAL_REQUEST_TIMEOUT_MS, 300000);
}

/** Max tool-use turns before the loop stops with a partial result. */
export function localMaxTurns() {
  return Number(process.env.LOCAL_MAX_TURNS || 40);
}

/**
 * Soft context-window budget (in prompt tokens) for the local tool-use loop.
 *
 * Unlike claude — where the vendor SDK owns the conversation and compacts
 * context for us — the `local` provider IS the loop, so the harness must
 * keep the growing message history under the model's window itself. The loop
 * evicts the oldest tool rounds as the live prompt approaches this budget, and
 * surfaces a clear hint if a request still overflows.
 *
 * Default 24k sits comfortably under a 32k OSS window after leaving room for the
 * completion. RAISE it when LOCAL_BASE_URL points at a long-context model (set it
 * near the real window minus a few k for the answer); set it to 0 to disable
 * compaction entirely and let the model/server enforce its own limit.
 */
export function localContextTokens() {
  return Number(process.env.LOCAL_CONTEXT_TOKENS ?? 24000);
}

/** Sampling temperature. Default 0 — deterministic tool use is what we want here. */
export function localTemperature() {
  const raw = process.env.LOCAL_TEMPERATURE;
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Per-tool-result / per-shell-output byte cap before truncation. */
export function localOutputLimitBytes() {
  return Number(process.env.LOCAL_OUTPUT_LIMIT_BYTES || 16 * 1024);
}

/** Max bytes write_file will accept (binary/runaway guard). */
export function localMaxWriteBytes() {
  return Number(process.env.LOCAL_MAX_WRITE_BYTES || 1024 * 1024);
}

/** Default run_shell timeout when the model does not pass one. */
export function localShellTimeoutMs() {
  return finitePositive(process.env.LOCAL_SHELL_TIMEOUT_MS, 120000);
}

/** Vendor-neutral client options: where to send chat completions, and the optional key. */
export function localClientOptions() {
  return {
    baseUrl: localBaseUrl(),
    ...(localApiKey() ? { apiKey: localApiKey() } : {}),
  };
}

/**
 * Per-run options for the worker loop: the resolved model for the role, sampling,
 * and the repovine MCP stdio descriptor (command/args/env) the adapter spawns and
 * speaks JSON-RPC to. inheritProcessEnv:true so the MCP child gets PATH/HOME — the
 * adapter spawns it directly (no SDK to merge env for us).
 */
export function localRunOptions(repoRoot, contextSessionId, { modelRole = 'implementer' } = {}) {
  return {
    model: resolveLocalRole(modelRole).model,
    temperature: localTemperature(),
    maxTurns: localMaxTurns(),
    mcp: buildRepovineMcpStdio(repoRoot, contextSessionId, { inheritProcessEnv: true }),
  };
}
