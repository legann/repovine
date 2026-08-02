// Lightweight LLM completion seam — for PLANNING, not implementation.
//
// The worker adapters (lib/workers/*) run full coding agents that edit files and
// emit an AgentRunResult. The `plan` node needs the opposite: a single, cheap,
// NO-TOOLS completion that just returns text (a JSON plan). This is that seam.
//
// Auth goes through the same resolveAuth gate (no silent spend). Two providers are
// wired: claude via the Agent SDK with tools disabled, and local via an
// OpenAI-compatible chat completion. Any failure → { ok:false } and the caller
// falls back to the deterministic heuristic planner.
import { resolveAuth, authBlockedReason } from './workers/auth.mjs';
import { resolveClaudeRole, resolveLocalRole } from './model-role.mjs';
import { localBaseUrl, localApiKey, stripReasoning } from './workers/local-config.mjs';
import { finitePositive } from './num.mjs';

const defaultTimeoutMs = () => finitePositive(process.env.PLANNER_TIMEOUT_MS, 90000);

/** Caller-supplied budget wins; otherwise the env default. Resolved ONCE per call and threaded
 *  explicitly — a provider that suspends before reading it must still see the caller's value, and
 *  two concurrent calls with different budgets must not observe each other's. */
const resolveTimeoutMs = (timeoutMs) => finitePositive(timeoutMs, defaultTimeoutMs());

async function askClaude(prompt, systemAppend, timeoutMs) {
  let query;
  try {
    ({ query } = await import('@anthropic-ai/claude-agent-sdk'));
  } catch {
    return { ok: false, reason: 'Claude Agent SDK not installed (npm install).' };
  }
  const auth = resolveAuth('claude');
  if (!auth.ok) return { ok: false, reason: authBlockedReason('claude', auth) };

  const limitMs = resolveTimeoutMs(timeoutMs);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), limitMs);
  try {
    const claudeModel = resolveClaudeRole('planner');
    const resp = query({
      prompt,
      options: {
        model: claudeModel.model,
        ...(claudeModel.effort ? { effort: claudeModel.effort } : {}),
        maxTurns: 2,
        abortController: ac,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend },
        // Planning only: NO tools, NO MCP, NO edits.
        allowedTools: [],
        mcpServers: {},
      },
    });
    let resultText = '';
    let assistantText = '';
    for await (const message of resp) {
      if (message.type === 'assistant') {
        for (const block of message.message?.content ?? []) {
          if (block.type === 'text') assistantText += block.text;
        }
      } else if (message.type === 'result' && typeof message.result === 'string') {
        resultText = message.result;
      }
    }
    return { ok: true, text: resultText || assistantText };
  } catch (e) {
    return { ok: false, reason: ac.signal.aborted ? `planner timed out after ${Math.round(limitMs / 1000)}s` : `planner LLM error: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// Local provider planner: a single NO-TOOLS chat completion against the
// OpenAI-compatible endpoint (Ollama/vLLM/LM Studio/llama.cpp). Same contract as the
// other providers — any failure returns { ok:false } and the caller falls back to the
// deterministic heuristic planner, so a flaky local model never blocks a run.
async function askLocal(prompt, systemAppend, timeoutMs) {
  const auth = resolveAuth('local');
  if (!auth.ok) return { ok: false, reason: authBlockedReason('local', auth) };
  const baseUrl = localBaseUrl();
  if (!baseUrl) return { ok: false, reason: 'local planner needs LOCAL_BASE_URL.' };

  const { model } = resolveLocalRole('planner');
  const limitMs = resolveTimeoutMs(timeoutMs);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), limitMs);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(localApiKey() ? { authorization: `Bearer ${localApiKey()}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemAppend },
          { role: 'user', content: prompt },
        ],
        stream: false,
        temperature: 0,
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, reason: `local planner HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}` };
    }
    const json = await res.json();
    const text = stripReasoning(json?.choices?.[0]?.message?.content || '');
    return text.trim() ? { ok: true, text } : { ok: false, reason: 'local planner returned empty text.' };
  } catch (e) {
    return { ok: false, reason: ac.signal.aborted ? 'local planner timed out' : `local planner error: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the LLM a single planning question. Returns { ok, text } or { ok:false, reason }.
 * Wired for claude (SDK) and local (OpenAI-compatible chat). On any not-ok the caller
 * falls back to the heuristic planner (no spend, no surprise edits). Optional
 * `timeoutMs` overrides the default planner timeout (PLANNER_TIMEOUT_MS).
 */
export async function askLLM(prompt, {
  provider = 'claude',
  systemAppend = 'You are a planning assistant. Output only what is asked, with no extra prose.',
  timeoutMs,
} = {}) {
  switch (provider) {
    case 'local':
      return askLocal(prompt, systemAppend, timeoutMs);
    case 'claude':
    default:
      return askClaude(prompt, systemAppend, timeoutMs);
  }
}
