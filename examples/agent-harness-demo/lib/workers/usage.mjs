// Per-provider token / cost usage, normalized into ONE shape the harness can log to
// .harness and compare across sub-agents and runs.
//
// The whole point: the cost of a sub-agent is uncached input tokens + output tokens, NOT the
// byte size of the transcript. Caching (Claude SDK auto cache_control; OpenAI prompt
// cache) absorbs most of the inter-sub-agent handoff WITHIN a resumed session — so to know
// whether the handoff snowball actually costs anything we must read cache_read vs
// cache_creation, not guess from KiB. This module captures exactly that.
//
// Each SDK exposes a different surface:
//   - Claude  (@anthropic-ai/claude-agent-sdk): final `result` message carries
//             `usage` (input_tokens, output_tokens, cache_read_input_tokens,
//             cache_creation_input_tokens) + `total_cost_usd` + `modelUsage`.
//   - Local   (OpenAI-compatible chat/completions): `usage` = { prompt_tokens,
//             completion_tokens, prompt_tokens_details.cached_tokens }; no cost.
//
// TOKEN ACCOUNTING — the providers disagree, and we normalize to ONE model:
//   * Anthropic (verified, prompt-caching docs): ADDITIVE — `input_tokens` is the
//     UNCACHED remainder; total prompt = input + cache_creation + cache_read.
//   * OpenAI-compatible (verified, OpenAI prompt-caching docs): SUBSET — `prompt_tokens`
//     is the TOTAL prompt and `cached_tokens` is the cached portion WITHIN it.
//   We normalize everything to the additive model: `inputTokens` here is ALWAYS the
//   uncached remainder. OpenAI-compatible: prompt_tokens - cached. This keeps one
//   cacheHitRatio formula correct and lets totalUsage sum without double-counting.
//
// Convention: unknown numeric fields are `null`, not `0`, so "we don't get this from the
// provider" is never confused with "this turn used zero tokens".

const FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'reasoningTokens',
  'costUsd',
  'durationMs',
];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const addNullable = (...xs) => {
  const present = xs.map(num).filter((x) => x !== null);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
};

/**
 * Fraction of the prompt served from cache: cache_read / total_input, where (by our
 * additive normalization) total_input = cache_read + cache_creation + inputTokens and
 * inputTokens is the UNCACHED remainder. Correct for every provider only because each
 * normalizer converts to this additive model first. Null when
 * cache reads aren't reported or there is no measurable input. The single number that
 * says whether the handoff snowball is actually paid for or absorbed by the cache.
 */
function cacheHitRatio({ cacheReadTokens, cacheCreationTokens, inputTokens }) {
  const read = num(cacheReadTokens);
  if (read === null) return null;
  const fresh = addNullable(cacheCreationTokens, inputTokens) ?? 0;
  const denom = read + fresh;
  return denom > 0 ? Number((read / denom).toFixed(4)) : null;
}

function withDerived(rec) {
  return { ...rec, cacheHitRatio: cacheHitRatio(rec) };
}

const base = (provider, model) => ({
  provider,
  model: model ?? null,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  reasoningTokens: null,
  costUsd: null,
  durationMs: null,
});

/** Total of every numeric field in one modelUsage entry (token counts dominate cost). */
function modelUsageWeight(entry) {
  if (!entry || typeof entry !== 'object') return 0;
  return Object.values(entry).reduce(
    (sum, v) => sum + (typeof v === 'number' && Number.isFinite(v) ? v : 0),
    0,
  );
}

/**
 * The model that did the sub-agent's work. When the SDK omits `result.model`, the
 * `modelUsage` map is the only source — and it also carries Claude Code's own small
 * helper calls (a cheap model summarizing, titling, compacting). The first key of that
 * map is arbitrary, so take the HEAVIEST entry: it names the model that produced the
 * result rather than the helper that happened to be listed first. Getting this wrong
 * makes the cost ledger report an entire run on a model it never used.
 */
export function claudeModelId(resultMessage = {}) {
  if (resultMessage.model) return resultMessage.model;
  const entries = Object.entries(resultMessage.modelUsage || {});
  if (entries.length === 0) return undefined;
  return entries.reduce((best, cur) => (modelUsageWeight(cur[1]) > modelUsageWeight(best[1]) ? cur : best))[0];
}

/** Normalize a Claude Agent SDK `result` message into the common usage shape. */
export function claudeUsage(resultMessage = {}) {
  const u = resultMessage.usage || {};
  return withDerived({
    ...base('claude', claudeModelId(resultMessage)),
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheCreationTokens: num(u.cache_creation_input_tokens),
    costUsd: num(resultMessage.total_cost_usd),
    durationMs: num(resultMessage.duration_ms),
  });
}

/**
 * Normalize an OpenAI-compatible chat-completions `usage` object (the `local`
 * provider sums one of these per turn). OpenAI/Ollama report prompt_tokens as the
 * TOTAL prompt with cached_tokens (when present) the subset within it — convert to
 * the additive convention so inputTokens is the UNCACHED remainder. Most local
 * runtimes report no cache split (cacheReadTokens stays null).
 */
export function localUsage(usage = {}, { model } = {}) {
  const total = num(usage.prompt_tokens);
  const cached = num(usage.prompt_tokens_details?.cached_tokens);
  const uncached = total !== null && cached !== null ? Math.max(0, total - cached) : total;
  return withDerived({
    ...base('local', model),
    inputTokens: uncached,
    outputTokens: num(usage.completion_tokens),
    cacheReadTokens: cached,
  });
}

/** A usage row with everything unavailable (e.g. a blocked run that never called the API). */
export function emptyUsage(provider, model) {
  return withDerived(base(provider, model));
}

/**
 * Sum per-attempt (or per-sub-agent) usage rows into a total. Nulls are skipped per field, so
 * a missing field in one row does not zero the sum; cacheHitRatio is recomputed from the
 * summed token counts. `attempts` counts the rows that carried any usage.
 */
export function totalUsage(records = []) {
  const present = records.filter(Boolean);
  if (!present.length) return null;
  const sumField = (k) => {
    const vals = present.map((r) => r[k]).filter((v) => typeof v === 'number' && Number.isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const providers = [...new Set(present.map((r) => r.provider))];
  const totals = { provider: providers.length === 1 ? providers[0] : 'mixed', model: present[present.length - 1].model ?? null, attempts: present.length };
  for (const f of FIELDS) totals[f] = sumField(f);
  return withDerived(totals);
}

/**
 * Roll a run's sub-agents into one usage record + a per-sub-agent breakdown. Pure: the
 * caller (multi.mjs join) writes the result to .harness/<run>.run.usage.json. `rowsInput`
 * carries { subAgent, role, fresh, ok, usage }. `freshTotal` isolates cold-cache fresh
 * sub-agents — the runs where the inline contract ledger is paid in full — so a single
 * file answers "did fresh sub-agent input grow with the contract count?" and "is the
 * snowball cached?".
 */
export function buildRunUsage(runId, rowsInput = []) {
  const rows = (rowsInput || []).map((r) => ({
    subAgent: r.subAgent ?? r.role ?? null,
    role: r.role ?? null,
    fresh: Boolean(r.fresh),
    ok: Boolean(r.ok),
    usage: r.usage ?? null,
  }));
  return {
    run: runId ?? null,
    subAgentCount: rows.length,
    total: totalUsage(rows.map((r) => r.usage)),
    freshTotal: totalUsage(rows.filter((r) => r.fresh).map((r) => r.usage)),
    resumeTotal: totalUsage(rows.filter((r) => !r.fresh).map((r) => r.usage)),
    subAgents: rows,
  };
}
