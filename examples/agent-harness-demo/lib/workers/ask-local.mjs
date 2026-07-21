// Read-only /ask runner for the local provider (LLM_PROVIDER=local).
//
// Same OpenAI-compatible loop as the worker (lib/workers/local.mjs), but with a
// READ-ONLY toolset — read_file + the repovine READ MCP tools (REPOVINE_ASK_MCP_TOOLS,
// no refresh_context / write_annotation) — and it returns a prose answer, not an
// AgentRunResult. This gives /ask parity with ask-claude so
// `LLM_PROVIDER=local` works for /ask, not just /task (otherwise /ask would silently
// fall through to the Claude runner).
//
// Contract (matches the other ask runners):
//   runAsk(question, repoRoot, opts) =>
//     { ok: true, text, contextSessionId } | { ok: false, reason }
import fs from 'node:fs';
import path from 'node:path';
import { resolveAuth, authBlockedReason } from './auth.mjs';
import { buildAskPrompt, ASK_POLICY } from './ask-prompt.mjs';
import { REPOVINE_ASK_MCP_TOOLS, buildRepovineMcpStdio } from './mcp.mjs';
import { resolveLocalRole } from '../model-role.mjs';
import {
  localApiKey,
  localBaseUrl,
  localTimeoutMs,
  localMaxTurns,
  localContextTokens,
  localTemperature,
  stripReasoning,
} from './local-config.mjs';
import { localUsage } from './usage.mjs';
import {
  McpStdioClient,
  mcpToolsToFunctions,
  execReadFile,
  mcpResultToContent,
  chatCompletion,
  compactHistory,
  estimateHistoryChars,
  normalizeNativeToolCalls,
  parseInlineToolCall,
} from './local.mjs';
import { logBullet } from '../log.mjs';

const VERBOSE = process.env.LOCAL_VERBOSE !== '0';
const MCP_PREFIX = 'mcp__repovine__';
const numOr0 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// Read-only tool set: read_file ONLY. No write_file/apply_patch/run_shell — /ask must
// never mutate the repo or run commands.
const ASK_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a UTF-8 text file from the repo, returned with 1-based line numbers. Use start_line/end_line to page large files.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Path relative to repo root. Must stay inside the repo.' },
          start_line: { type: 'integer', minimum: 1, description: 'Optional 1-based first line.' },
          end_line: { type: 'integer', minimum: 1, description: 'Optional 1-based last line (inclusive).' },
        },
        required: ['path'],
      },
    },
  },
];

const ASK_SYSTEM = `${ASK_POLICY}

You act through tools: read_file and the repovine MCP tools (mcp__repovine__*, read-only).
Prefer the native tool_calls mechanism; ONLY if native tool calls are unsupported, emit
exactly ONE call as a fenced block and nothing else:
\`\`\`tool_call
{"name": "<toolName>", "arguments": { ... }}
\`\`\`
When you have enough to answer, reply with your final answer in plain prose and NO tool
call. Never create/edit/delete files and never call refresh_context or write_annotation.
<think>…</think> content is stripped and never shown.`;

export async function runAsk(question, repoRoot, opts = {}) {
  const auth = resolveAuth('local');
  if (!auth.ok) return { ok: false, reason: authBlockedReason('local', auth) };
  const baseUrl = localBaseUrl();
  if (!baseUrl) return { ok: false, reason: 'LOCAL_BASE_URL is not set for the local provider.' };

  let root;
  try {
    root = fs.realpathSync(repoRoot);
  } catch {
    root = path.resolve(repoRoot);
  }

  const contextSessionId = opts.contextSessionId || `ctx-ask-${Date.now()}`;
  const { model } = resolveLocalRole('ask');
  const maxTurns = localMaxTurns();
  const temperature = localTemperature();

  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, localTimeoutMs());
  if (opts.signal) {
    if (opts.signal.aborted) abortController.abort();
    else opts.signal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  // repovine MCP — READ-ONLY tool set (no refresh_context / write_annotation).
  const mcp = new McpStdioClient(buildRepovineMcpStdio(root, contextSessionId, { inheritProcessEnv: true }));
  const mcpAllow = new Set(REPOVINE_ASK_MCP_TOOLS);
  let mcpFns = [];
  let mcpUp = false;
  try {
    await mcp.start();
    mcpFns = mcpToolsToFunctions(await mcp.listTools(), mcpAllow);
    mcpUp = true;
    logBullet(`local ask model=${model} repovine-mcp=${mcpFns.length} tools`, { enabled: VERBOSE, scope: 'local' });
  } catch (e) {
    logBullet(`repovine MCP unavailable (${e.message}); read_file only`, { enabled: VERBOSE, scope: 'local' });
  }

  const tools = [...ASK_TOOLS, ...mcpFns];
  const messages = [
    { role: 'system', content: ASK_SYSTEM },
    {
      role: 'user',
      content: buildAskPrompt(question, {
        resuming: Boolean(opts.resume),
        contextSessionId,
        attachments: opts.attachments,
      }),
    },
  ];

  // Read-only dispatch: read_file locally, mcp__repovine__* via MCP; refuse anything else.
  const dispatch = async (name, args) => {
    const a = args && typeof args === 'object' ? args : {};
    try {
      if (name === 'read_file') return JSON.stringify(execReadFile(root, a));
      if (name.startsWith(MCP_PREFIX)) {
        if (!mcpUp || !mcpAllow.has(name)) return JSON.stringify({ ok: false, error: `tool "${name}" is not available` });
        const res = await mcp.callTool(name.slice(MCP_PREFIX.length), a);
        return mcpResultToContent(res);
      }
      return JSON.stringify({ ok: false, error: `read-only /ask: tool "${name}" is not allowed` });
    } catch (e) {
      return JSON.stringify({ ok: false, error: e.message });
    }
  };

  const usageAcc = { any: false, prompt_tokens: 0, completion_tokens: 0 };
  let finalText = '';
  let reminded = false;
  const contextBudget = localContextTokens();
  let tokensPerChar = 0.25; // calibrated from server usage.prompt_tokens each turn

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (abortController.signal.aborted) break;
      // Keep the growing history under the model window (the harness owns the loop).
      const comp = compactHistory(messages, { budgetTokens: contextBudget, tokensPerChar });
      if (comp.dropped) {
        logBullet(`ask context compacted: -${comp.dropped} round(s) ≈${comp.estTokens} tok`, { enabled: VERBOSE, scope: 'local' });
      }
      const projectedTokens = Math.round(estimateHistoryChars(messages) * tokensPerChar);
      let json;
      try {
        json = await chatCompletion({ baseUrl, apiKey: localApiKey(), model, messages, tools, temperature, signal: abortController.signal });
      } catch (e) {
        if (abortController.signal.aborted) break;
        const overBudget = contextBudget > 0 && projectedTokens > contextBudget;
        const hint = overBudget
          ? ` The prompt (~${projectedTokens} tokens) may exceed the model context window — point LOCAL_BASE_URL at a longer-context model, raise LOCAL_CONTEXT_TOKENS only if the real window is larger, or ask a narrower question.`
          : '';
        return { ok: false, reason: `Local ask request failed: ${e.message}.${hint}` };
      }
      const u = json?.usage;
      if (u) {
        usageAcc.any = true;
        usageAcc.prompt_tokens += numOr0(u.prompt_tokens);
        usageAcc.completion_tokens += numOr0(u.completion_tokens);
        const pt = numOr0(u.prompt_tokens);
        if (pt > 0) {
          const chars = estimateHistoryChars(messages);
          if (chars > 0) tokensPerChar = pt / chars;
        }
      }
      const msg = json?.choices?.[0]?.message || {};
      const rawContent = typeof msg.content === 'string' ? msg.content : '';
      const visible = stripReasoning(rawContent);

      let calls = normalizeNativeToolCalls(msg.tool_calls);
      let inline = false;
      if (!calls.length) {
        const ic = parseInlineToolCall(visible);
        if (ic) {
          calls = [{ id: `call_inline_${turn}`, name: ic.name, args: ic.arguments, argStr: JSON.stringify(ic.arguments) }];
          inline = true;
        }
      }

      if (calls.length) {
        if (inline) {
          messages.push({ role: 'assistant', content: rawContent });
          const c = calls[0];
          logBullet(`${c.name} (inline)`, { enabled: VERBOSE, scope: 'local' });
          messages.push({ role: 'user', content: `[tool:${c.name}] result:\n${await dispatch(c.name, c.args)}` });
        } else {
          messages.push({
            role: 'assistant',
            content: rawContent,
            tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.argStr } })),
          });
          for (const c of calls) {
            logBullet(c.name, { enabled: VERBOSE, scope: 'local' });
            messages.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: await dispatch(c.name, c.args) });
          }
        }
        continue;
      }

      if (visible) {
        finalText = visible;
        break;
      }
      if (!reminded) {
        reminded = true;
        messages.push({
          role: 'user',
          content: 'You returned neither an answer nor a tool call. Either call a read tool, or reply with your final plain-text answer now.',
        });
        continue;
      }
      break;
    }
  } finally {
    clearTimeout(timer);
    mcp.stop();
  }

  if (opts.capture && usageAcc.any) {
    opts.capture.usage = localUsage({ prompt_tokens: usageAcc.prompt_tokens, completion_tokens: usageAcc.completion_tokens }, { model });
  }
  // local is stateless: no resumable server session id to capture.

  if (abortController.signal.aborted) {
    return {
      ok: false,
      reason: timedOut ? `Ask timed out after ${Math.round(localTimeoutMs() / 1000)}s (LOCAL_TIMEOUT_MS).` : 'Ask aborted.',
    };
  }
  const text = finalText.trim();
  if (!text) return { ok: false, reason: 'Local ask finished with an empty reply.' };
  return { ok: true, text, contextSessionId };
}
