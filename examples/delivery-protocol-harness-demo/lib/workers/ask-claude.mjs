// Read-only /ask via Claude Agent SDK — MCP + Read/Grep/Glob, no writes.
import { REPOVINE_CLI } from '../repovine.mjs';
import { resolveAuth, authBlockedReason } from './auth.mjs';
import { ASK_POLICY, buildAskPrompt } from './ask-prompt.mjs';
import { REPOVINE_ASK_MCP_TOOLS, REPOVINE_WRITE_MCP_TOOLS, repovineMcpEnv } from './mcp.mjs';
import { resolveClaudeRole } from '../model-role.mjs';
import { claudeSandbox, claudeTimeoutMs } from './claude-config.mjs';
import { logBullet } from '../log.mjs';

const MAX_TURNS = Number(process.env.ASK_MAX_TURNS || process.env.CLAUDE_AGENT_MAX_TURNS || 24);
const VERBOSE = process.env.CLAUDE_AGENT_VERBOSE !== '0';

// Read-only allow-list: Read/Glob/Grep + read-only repovine MCP tools.
export const ASK_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', ...REPOVINE_ASK_MCP_TOOLS];
const ASK_ALLOWED = new Set(ASK_ALLOWED_TOOLS);
// Hard-block the write/exec built-ins and mutating MCP tools even if a preset
// re-adds them. Belt to the canUseTool suspenders below.
export const ASK_DISALLOWED_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', ...REPOVINE_WRITE_MCP_TOOLS];

// Deny-by-default permission gate: only allow-listed read tools run. This
// enforces read-only in the engine, not just in the ASK_POLICY prose.
export const askReadOnlyGate = async (toolName, input) =>
  ASK_ALLOWED.has(toolName)
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: '/ask is read-only: writes and command execution are disabled.' };

export async function runAsk(question, repoRoot, opts = {}) {
  let query;
  try {
    ({ query } = await import('@anthropic-ai/claude-agent-sdk'));
  } catch {
    return { ok: false, reason: 'Claude Agent SDK not installed (npm install).' };
  }

  const auth = resolveAuth('claude');
  if (!auth.ok) return { ok: false, reason: authBlockedReason('claude', auth) };

  const contextSessionId = opts.contextSessionId || `ctx-ask-${Date.now()}`;
  const abortController = new AbortController();
  const timeoutMs = claudeTimeoutMs({ primaryEnv: 'ASK_TIMEOUT_MS' });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abortController.abort(); }, timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) abortController.abort();
    else opts.signal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  const prompt = buildAskPrompt(question, { resuming: Boolean(opts.resume), contextSessionId, attachments: opts.attachments });
  const claudeModel = resolveClaudeRole('ask');
  const sandbox = claudeSandbox({ autoAllowBashIfSandboxed: false });

  const response = query({
    prompt,
    options: {
      cwd: repoRoot,
      model: claudeModel.model,
      ...(claudeModel.effort ? { effort: claudeModel.effort } : {}),
      maxTurns: MAX_TURNS,
      abortController,
      ...(opts.resume ? { resume: opts.resume } : {}),
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: ASK_POLICY,
      },
      // Read-only: no bypassPermissions. canUseTool denies anything off the
      // allow-list; disallowedTools hard-blocks the write/exec built-ins.
      canUseTool: askReadOnlyGate,
      disallowedTools: ASK_DISALLOWED_TOOLS,
      ...(sandbox ? { sandbox } : {}),
      mcpServers: {
        repovine: {
          type: 'stdio',
          command: 'node',
          args: [REPOVINE_CLI],
          env: repovineMcpEnv(repoRoot, contextSessionId, { inheritProcessEnv: true }),
        },
      },
      allowedTools: ASK_ALLOWED_TOOLS,
    },
  });

  let resultText = '';
  let assistantText = '';
  try {
    for await (const message of response) {
      if (message.session_id && opts.capture) opts.capture.sessionId = message.session_id;
      if (message.type === 'assistant') {
        for (const block of message.message?.content ?? []) {
          if (block.type === 'text') assistantText += block.text;
          else if (block.type === 'tool_use') logBullet(`ask ${block.name}`, { enabled: VERBOSE, scope: 'claude' });
        }
      } else if (message.type === 'result' && typeof message.result === 'string') {
        resultText = message.result;
      }
    }
  } catch (e) {
    const reason = abortController.signal.aborted
      ? (timedOut
          ? `Ask timed out after ${Math.round(timeoutMs / 1000)}s (ASK_TIMEOUT_MS).`
          : 'Ask aborted.')
      : `Claude ask error: ${e.message}`;
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }

  const text = (resultText || assistantText).trim();
  if (!text) return { ok: false, reason: 'Claude ask finished with an empty reply.' };
  return { ok: true, text, contextSessionId };
}
