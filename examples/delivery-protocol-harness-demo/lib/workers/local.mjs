// Vendor-neutral `local` worker adapter (LLM_PROVIDER=local).
//
// Runs ANY tool-capable local model (Qwen, Mistral, Llama, DeepSeek, …) through an
// OpenAI-compatible /v1/chat/completions endpoint (Ollama, vLLM, LM Studio, llama.cpp
// server). Unlike the claude adapter, there is no vendor SDK doing the
// agent loop and the MCP wiring for us — this module IS the loop:
//
//   chat-completions(tools) → tool calls? (native tool_calls OR inline fallback)
//     → execute (file ops + sandbox shell + repovine MCP) → feed results back
//       → repeat until a final plain-text answer / max turns / timeout / abort.
//
// The model is CONFIG, not code: LOCAL_MODEL picks it, LOCAL_BASE_URL picks the
// runtime. We talk plain HTTP via fetch — no new heavy dependency.
//
// Same async seam as the other workers:
//   runAgent(task, assignment, repoRoot, opts) => AgentRunResult.
// Auth: resolveAuth('local') — presence of LOCAL_BASE_URL (no cloud key, not fail-closed).
//
// repovine MCP parity: we spawn `node REPOVINE_CLI` as a stdio MCP server (the same
// descriptor the SDK adapters use), speak minimal JSON-RPC to it, and expose its
// allow-listed tools to the model as `mcp__repovine__*` function tools. That is the
// headline feature — repovine MCP on any local model.
//
// Robustness over trust: weak local models rarely emit a clea Delivery Protocol JSON
// block. So we SYNTHESIZE the AgentRunResult from what the adapter OBSERVED (files it
// wrote, MCP calls it saw), and only borrow prose (summary/status/blockers) from a
// model-emitted block when present. Observed state is the source of truth.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveAuth, authBlockedReason } from './auth.mjs';
import { blockedResult, normalizeResult, extractResultObject, preserveOptionalArtifacts, toContractStrings } from '../claude-agent.mjs';
import { REPOVINE_WORKER_MCP_TOOLS, buildRepovineMcpStdio } from './mcp.mjs';
import { resolveLocalRole } from '../model-role.mjs';
import {
  localApiKey,
  localBaseUrl,
  localTimeoutMs,
  localRequestTimeoutMs,
  localMaxTurns,
  localContextTokens,
  localTemperature,
  localOutputLimitBytes,
  localMaxWriteBytes,
  localShellTimeoutMs,
  stripReasoning,
} from './local-config.mjs';
import { localUsage } from './usage.mjs';
import { attachmentsBrief, policyForAssignment, resolveHarnessBrief } from './prompt.mjs';

// Stateless chat-completions loop — no conversation resume. Retries must re-fold
// the FULL task text; a compact "continue our conversation" pointer would leave
// the retry with no assignment at all (subAgent.mjs reads this flag).
export const supportsResume = false;
import { logBullet } from '../log.mjs';

export const provider = 'local';
export { stripReasoning };

const VERBOSE = process.env.LOCAL_VERBOSE !== '0';
const MCP_PREFIX = 'mcp__repovine__';
const RUN_STATUSES = ['complete', 'partial', 'blocked', 'failed'];

// ── Fixed worker tool contract (names/schemas must not change) ──
const LOCAL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a UTF-8 text file from the sandbox repo. Returns content with 1-based line numbers. Use start_line/end_line to page large files.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Path relative to repo root. Must stay inside the sandbox.' },
          start_line: { type: 'integer', minimum: 1, description: 'Optional 1-based first line.' },
          end_line: { type: 'integer', minimum: 1, description: 'Optional 1-based last line (inclusive).' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create or overwrite a UTF-8 text file with the exact content provided. Creates parent dirs. Prefer apply_patch for edits to existing files.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Path relative to repo root. Must stay inside the sandbox.' },
          content: { type: 'string', description: 'Full file content to write.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description:
        'Apply a git-apply-compatible unified diff to the sandbox repo (one or more files). Atomic: if any hunk fails, nothing is changed.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          patch: { type: 'string', description: 'Unified diff text (a/ b/ prefixes ok). Must apply cleanly against current state.' },
        },
        required: ['patch'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description:
        'Run a non-interactive shell command inside the sandbox repo (build, tests, grep, ls). No network unless the run allows it. Returns stdout, stderr, exit code.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string', description: 'Command line, executed in the sandbox repo.' },
          cwd: { type: 'string', description: 'Optional working dir relative to repo root. Default: repo root.' },
          timeout_ms: { type: 'integer', minimum: 1, description: 'Optional timeout. Default: worker shell timeout.' },
        },
        required: ['command'],
      },
    },
  },
];

// ── Fixed worker system prompt (sent verbatim every request) ────────
const WORKER_SYSTEM_PROMPT = `You are a coding agent running inside the repovine harness \`local\` provider. You work
autonomously on a sandboxed copy of a git repository to complete ONE assignment, then stop.

You act ONLY through tools. Describing a change is not enough — you must call a tool to
inspect or modify the repository.

Tools available to you:
- Local file tools (scoped to the sandbox repo root): read_file, write_file, apply_patch,
  run_shell.
- repovine MCP tools (mcp__repovine__*): repository structure, dependencies, config surface,
  and graph sync. Use them to orient before reading or editing files.

Workflow:
1. Orient FIRST. Use mcp__repovine__search_context / map_context / inspect_node to locate the
   relevant code. Do not read or edit files blindly.
2. Read only the parts you need with read_file.
3. Edit: apply_patch for changes to existing files; write_file for new files or full
   rewrites. Keep edits minimal and scoped strictly to the assignment.
4. Verify with run_shell (build / tests / lint) when applicable.
5. When the assignment is complete OR blocked, STOP: emit a final plain-text assistant
   message (no tool call) summarizing what changed and why, or what blocked you.

Tool-calling rules:
- Prefer the native tool_calls mechanism. Emit tool calls directly, not wrapped in prose.
- ONLY if native tool calls are unsupported, emit exactly ONE call per turn as this fenced
  block and nothing else:
  \`\`\`tool_call
  {"name": "<toolName>", "arguments": { ... }}
  \`\`\`
- Arguments must be valid JSON matching the tool schema. Never invent tool names.

Constraints:
- Stay inside the sandbox repo root. Never touch paths outside it; never modify .git internals.
- run_shell is non-interactive and may have no network. Do not start long-running servers or
  wait for input.
- Keep private reasoning brief; <think>…</think> content is stripped and never shown.
- Never fabricate results. Report command and test output exactly as it occurred.

Your input (in the user message):
- TASK: the concrete change to make.
- ASSIGNMENT: scope, acceptance criteria, contracts, and any prior handoff context.
- REPO_ROOT: the sandbox path; all tool paths are relative to it.`;

const REMINDER =
  'You returned neither a tool call nor a final answer. Either call exactly one tool (native ' +
  'tool_calls, or the ```tool_call fenced block), or reply with your final plain-text summary now.';

// ── Minimal MCP stdio JSON-RPC client (newline-delimited messages) ───────────────
// No SDK: the SDK adapters get MCP from their vendor runtime; here we spawn the same
// `node REPOVINE_CLI` stdio server and speak just enough JSON-RPC (initialize,
// tools/list, tools/call) to expose repovine tools to the model.
export class McpStdioClient {
  constructor({ command, args, env }) {
    this.spec = { command, args, env };
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
  }

  async start() {
    this.proc = spawn(this.spec.command, this.spec.args, {
      env: this.spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.on('data', () => {}); // repovine build logs go to stderr — ignore.
    this.proc.on('error', (e) => this._rejectAll(e));
    this.proc.on('exit', () => this._rejectAll(new Error('MCP server exited')));
    await this._request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'repovine-local-worker', version: '1' },
    });
    this._notify('notifications/initialized', {});
  }

  _rejectAll(err) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  _onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not a framed JSON-RPC line
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'MCP error'));
        else p.resolve(msg.result);
      }
      // Server-initiated requests/notifications are ignored (we declare no capabilities).
    }
  }

  _send(obj) {
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  _request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP ${method} timed out`));
        }
      }, localRequestTimeoutMs());
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this._send({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  _notify(method, params) {
    this._send({ jsonrpc: '2.0', method, params });
  }

  async listTools() {
    const r = await this._request('tools/list', {});
    return Array.isArray(r?.tools) ? r.tools : [];
  }

  callTool(name, args) {
    return this._request('tools/call', { name, arguments: args || {} });
  }

  stop() {
    const p = this.proc;
    if (!p) return;
    try { p.stdin.end(); } catch { /* already closed */ }
    try { p.kill('SIGTERM'); } catch { /* already gone */ }
    // Escalate to SIGKILL if the server ignores SIGTERM (e.g. stuck mid graph build),
    // so a spawned MCP server can never outlive the run. unref so the timer never keeps
    // the harness process alive; cleared as soon as the child exits.
    const kill = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
    kill.unref?.();
    p.once?.('exit', () => clearTimeout(kill));
  }
}

// A real repovine graph node id is "<kind>:<path>"; a raw filesystem path is not one.
// Weak models sometimes pass a path as nodeId — keep those out of the result's
// annotationsWritten / graphNodesTouched so we never declare a node that doesn't exist.
const NODE_ID_RE = /^(mod|cap|domain|service|infra):/;

/** MCP tools/list → OpenAI function tools, filtered to the worker allow-list and prefixed. */
export function mcpToolsToFunctions(tools, allow) {
  const out = [];
  for (const t of tools) {
    if (!t?.name) continue;
    const exposed = `${MCP_PREFIX}${t.name}`;
    if (!allow.has(exposed)) continue;
    out.push({
      type: 'function',
      function: {
        name: exposed,
        description: String(t.description || `repovine ${t.name}`).slice(0, 1024),
        parameters: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
      },
    });
  }
  return out;
}

// ── Guardrails ───────────────────────────────────────────────────────────────
// Every path is resolved against the realpath'd sandbox root and rejected if it
// escapes (absolute, .., or via a symlink). Writes additionally refuse .git internals.
export function resolveInSandbox(root, p, { forWrite = false } = {}) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('path is required');
  // Accept an absolute path ONLY when it lands inside the sandbox — weak models
  // routinely echo REPO_ROOT back (e.g. "/sandbox/NOTES.md"). True escapes are still
  // rejected below by the relative-path containment check, so this stays safe.
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('path must stay inside the repo root (use a path relative to the repo root)');
  }
  if (forWrite && rel.split(path.sep)[0] === '.git') throw new Error('writing inside .git is not allowed');
  // Symlink-escape guard: realpath the deepest existing ancestor and re-check.
  let probe = abs;
  while (probe !== root && !fs.existsSync(probe)) probe = path.dirname(probe);
  const realProbe = fs.realpathSync(probe);
  const realRel = path.relative(root, realProbe);
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) throw new Error('path resolves outside the sandbox via a symlink');
  return { abs, rel };
}

function clampText(s) {
  const limit = localOutputLimitBytes();
  const str = String(s ?? '');
  if (Buffer.byteLength(str, 'utf8') <= limit) return { text: str, truncated: false };
  const cut = Buffer.from(str, 'utf8').subarray(0, limit).toString('utf8');
  return { text: `${cut}\n…[truncated]`, truncated: true };
}

const SECRET_ENV_RE = /(KEY|TOKEN|SECRET|PASSWORD|OPENAI|ANTHROPIC|CURSOR|CODEX|TELEGRAM)/i;
/** Process env minus token-like vars, so shelled commands cannot read provider secrets. */
export function scrubbedEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_ENV_RE.test(k)) out[k] = v;
  return out;
}

// ── Local tool executors (return the worker result contract objects) ─────────────────
export function execReadFile(root, args) {
  const { abs, rel } = resolveInSandbox(root, args.path);
  const st = fs.statSync(abs);
  if (st.isDirectory()) return { ok: false, path: rel, error: 'path is a directory' };
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) return { ok: false, path: rel, error: 'binary file (contains NUL byte); not read as text' };
  const allLines = buf.toString('utf8').split('\n');
  const total = allLines.length;
  let start = Number.isInteger(args.start_line) ? Math.max(1, args.start_line) : 1;
  let end = Number.isInteger(args.end_line) ? Math.min(total, args.end_line) : total;
  if (end < start) end = start;
  const numbered = allLines.slice(start - 1, end).map((ln, i) => `${start + i}\t${ln}`).join('\n');
  const { text, truncated } = clampText(numbered);
  return { ok: true, path: rel, content: text, lines: total, ...(truncated ? { truncated: true } : {}) };
}

function execWriteFile(root, args) {
  const { abs, rel } = resolveInSandbox(root, args.path, { forWrite: true });
  const content = String(args.content ?? '');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > localMaxWriteBytes()) return { ok: false, path: rel, error: `content ${bytes}B exceeds limit ${localMaxWriteBytes()}B` };
  const created = !fs.existsSync(abs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return { ok: true, path: rel, bytes_written: bytes, created };
}

export function execApplyPatch(root, args) {
  const patch = String(args.patch ?? '');
  if (!patch.trim()) return { ok: false, error: 'empty patch' };
  // In-repo apply in both target modes: sandbox is its own repo, attach carries
  // the disposable repo behind the read-only pointer (removed the
  // no-repo neutral-cwd path).
  // Dry-run --numstat first: validates the patch AND yields the file list to report.
  const dry = spawnSync('git', ['apply', '--numstat', '-p1', '-'], { cwd: root, input: patch, encoding: 'utf8' });
  if (dry.status !== 0) {
    return { ok: false, rejected: (dry.stderr || '').trim().slice(0, 2000) || 'patch does not apply cleanly', error: 'git apply --numstat failed' };
  }
  const files = dry.stdout.trim().split('\n').map((l) => l.split('\t')[2]).filter(Boolean);
  for (const f of files) {
    try {
      resolveInSandbox(root, f, { forWrite: true });
    } catch (e) {
      return { ok: false, error: `patch touches disallowed path "${f}": ${e.message}` };
    }
  }
  const applied = spawnSync('git', ['apply', '-p1', '-'], { cwd: root, input: patch, encoding: 'utf8' });
  if (applied.status !== 0) return { ok: false, rejected: (applied.stderr || '').trim().slice(0, 2000), error: 'git apply failed' };
  return { ok: true, files_changed: files };
}

function execRunShell(root, args) {
  const command = String(args.command ?? '');
  if (!command.trim()) return { ok: false, exit_code: null, stdout: '', stderr: '', error: 'empty command' };
  let cwd = root;
  if (args.cwd) {
    try {
      cwd = resolveInSandbox(root, args.cwd).abs;
    } catch (e) {
      return { ok: false, exit_code: null, stdout: '', stderr: '', error: `bad cwd: ${e.message}` };
    }
  }
  // Cap the model-controlled timeout at the configured shell ceiling so one command
  // can't exceed the run budget. spawnSync is synchronous, so this bound — not the
  // run-level wall-clock or an external /stop — is what limits a running command.
  const shellCap = localShellTimeoutMs();
  const requested = Number.isInteger(args.timeout_ms) && args.timeout_ms > 0 ? args.timeout_ms : shellCap;
  const timeout = Math.min(requested, shellCap);
  const res = spawnSync('/bin/sh', ['-c', command], {
    cwd,
    env: scrubbedEnv(),
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timed_out = res.error?.code === 'ETIMEDOUT';
  const out = clampText(res.stdout || '');
  const err = clampText(res.stderr || '');
  return {
    ok: !res.error && res.status === 0,
    exit_code: res.status,
    stdout: out.text,
    stderr: err.text,
    ...(timed_out ? { timed_out: true } : {}),
    ...(out.truncated || err.truncated ? { truncated: true } : {}),
    ...(res.error && !timed_out ? { error: res.error.message } : {}),
  };
}

const jstr = (obj) => JSON.stringify(obj);

/** Read MCP tools/call result content (repovine returns JSON text in content[0].text). */
export function mcpResultToContent(res) {
  const parts = Array.isArray(res?.content) ? res.content : [];
  const text = parts.map((p) => (typeof p?.text === 'string' ? p.text : JSON.stringify(p))).join('\n');
  const body = text || JSON.stringify(res ?? {});
  const prefix = res?.isError ? 'MCP tool reported an error:\n' : '';
  return clampText(prefix + body).text;
}

/** Record observable compliance signals from successful repovine MCP calls. */
function recordMcpObservation(real, args, res, ctx) {
  if (res?.isError) return;
  switch (real) {
    case 'refresh_context':
      ctx.observed.refreshContextRun = true;
      break;
    case 'write_annotation':
      if (typeof args?.nodeId === 'string' && NODE_ID_RE.test(args.nodeId)) {
        ctx.annotations.add(args.nodeId);
        ctx.nodes.add(args.nodeId);
      }
      break;
    case 'analyze_dependencies':
      ctx.observed.dependencyImpactChecked = true;
      break;
    case 'get_config_surface':
      ctx.observed.configSurfaceChecked = true;
      break;
    case 'trace_flow':
    case 'get_entrypoints':
      ctx.observed.flowChecked = true;
      break;
    case 'analyze_architecture':
      ctx.observed.architectureChecked = true;
      break;
    default:
      break;
  }
}

/** Run one tool call; returns the string to feed back as the tool result. Tracks observed state. */
async function dispatchTool(name, args, ctx) {
  const a = args && typeof args === 'object' ? args : {};
  try {
    if (name === 'read_file') return jstr(execReadFile(ctx.root, a));
    if (name === 'write_file') {
      const r = execWriteFile(ctx.root, a);
      if (r.ok) ctx.filesChanged.add(r.path);
      return jstr(r);
    }
    if (name === 'apply_patch') {
      const r = execApplyPatch(ctx.root, a);
      if (r.ok) (r.files_changed || []).forEach((f) => ctx.filesChanged.add(f));
      return jstr(r);
    }
    if (name === 'run_shell') return jstr(execRunShell(ctx.root, a));
    if (name.startsWith(MCP_PREFIX)) {
      if (!ctx.mcp || !ctx.mcpAllow.has(name)) return jstr({ ok: false, error: `tool "${name}" is not available` });
      const real = name.slice(MCP_PREFIX.length);
      const res = await ctx.mcp.callTool(real, a);
      recordMcpObservation(real, a, res, ctx);
      return mcpResultToContent(res);
    }
    return jstr({ ok: false, error: `unknown tool: ${name}` });
  } catch (e) {
    return jstr({ ok: false, error: e.message });
  }
}

// ── Tool-call parsing ────────────────────────────────────────────────────────
export function normalizeNativeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .map((t, i) => {
      const fn = t?.function || {};
      const argStr = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
      let argsObj;
      try {
        argsObj = JSON.parse(argStr || '{}');
      } catch {
        argsObj = {};
      }
      if (!argsObj || typeof argsObj !== 'object') argsObj = {};
      return { id: t?.id || `call_${i}_${Date.now().toString(36)}`, name: fn.name, args: argsObj, argStr: argStr || '{}' };
    })
    .filter((c) => c.name);
}

function tryParseObj(s) {
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

const isToolCallObj = (o) => o && typeof o.name === 'string' && o.arguments && typeof o.arguments === 'object';

/**
 * Scan for a JSON object carrying {name, arguments} embedded ANYWHERE in the text —
 * weaker models often emit prose then an UNFENCED `{"name":...,"arguments":{...}}`.
 * Balanced-brace walk (string-literal aware) from each `{`; first valid call wins.
 */
function scanEmbeddedToolCall(text) {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const o = tryParseObj(text.slice(i, j + 1));
          if (isToolCallObj(o)) return { name: o.name, arguments: o.arguments };
          break; // this `{` did not yield a call; advance to the next one
        }
      }
    }
  }
  return null;
}

/**
 * Qwen/Hermes XML tool format some models emit in text instead of native tool_calls:
 *   <function=NAME><parameter=KEY>VALUE</parameter>…</function>
 * Each VALUE is parsed as JSON when possible (arrays/objects/numbers/bools), else kept
 * as a trimmed string. Tolerant of a stray wrapping </tool_call>.
 */
function parseXmlToolCall(text) {
  const fn = /<function\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\/function\s*>/i.exec(text);
  if (!fn) return null;
  const name = fn[1].trim();
  if (!name) return null;
  const args = {};
  const paramRe = /<parameter\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\/parameter\s*>/gi;
  let pm;
  while ((pm = paramRe.exec(fn[2]))) {
    const key = pm[1].trim();
    const raw = pm[2].replace(/^\s+|\s+$/g, '');
    let val;
    try {
      val = JSON.parse(raw);
    } catch {
      val = raw;
    }
    args[key] = val;
  }
  return { name, arguments: args };
}

/** Inline-fallback: ```tool_call``` fence, whole-text object, Qwen/Hermes XML, or embedded {name,arguments}. */
export function parseInlineToolCall(text) {
  if (!text) return null;
  const fence = /```(?:tool_call|json)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fence.exec(text))) {
    const o = tryParseObj(m[1].trim());
    if (isToolCallObj(o)) return { name: o.name, arguments: o.arguments };
  }
  const whole = tryParseObj(text.trim());
  if (isToolCallObj(whole)) return { name: whole.name, arguments: whole.arguments };
  const xml = parseXmlToolCall(text);
  if (xml) return xml;
  return scanEmbeddedToolCall(text);
}

const numOr0 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function clampSummary(text, max = 1500) {
  const s = String(text ?? '').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function userMessage(task, assignment, root) {
  const attachments = attachmentsBrief(task);
  return [
    `REPO_ROOT: ${root}`,
    '',
    `TASK: ${task.task}`,
    '',
    'ASSIGNMENT:',
    `- runId: ${assignment.runId}`,
    `- scope (stay within): ${JSON.stringify(assignment.scope ?? [])}`,
    `- acceptanceCriteria: ${JSON.stringify(assignment.acceptanceCriteria ?? [])}`,
    `- constraints: ${JSON.stringify(assignment.constraints ?? [])}`,
    // task.task embeds the inter-sub-agent section (full contract ledger) — skip
    // the duplicate contracts line when present. Single source.
    ...(task?.embedsContracts ? [] : [`- contracts: ${JSON.stringify(assignment.contracts ?? [])}`]),
    `- requestedChecks: ${JSON.stringify(assignment.requestedChecks ?? [])}`,
    ...(attachments ? ['', attachments] : []),
    '',
    'COMPLETION PROTOCOL:',
    '- After editing any files, call mcp__repovine__refresh_context to sync the graph.',
    '- When done (or blocked), reply with a final plain-text message (NO tool call) that',
    '  summarizes what you changed and why, or what blocked you.',
  ].join('\n');
}

export async function chatCompletion({ baseUrl, apiKey, model, messages, tools, temperature, signal }) {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  const timer = setTimeout(() => ac.abort(), localRequestTimeoutMs());
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', temperature, stream: false }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * Sum the character weight of a message list — the sizing primitive shared by the
 * context-budget guard and its server-calibrated chars→tokens ratio. Counts string
 * content plus tool_call argument/name text, with a small per-message envelope so
 * empty messages still cost something.
 */
export function estimateHistoryChars(messages) {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') n += m.content.length;
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) n += (tc.function?.arguments?.length || 0) + (tc.function?.name?.length || 0);
    }
    n += 16; // role/envelope overhead
  }
  return n;
}

/**
 * Keep the growing local tool-use history under a soft token budget.
 *
 * The harness OWNS the conversation for the `local` provider (the claude adapter
 * lets the vendor SDK manage context), so on a small-window OSS model the message
 * array can outgrow the context before maxTurns — overflowing into a hard request
 * error (vLLM/llama.cpp) or a silent left-truncation that drops the system prompt
 * and task (Ollama). This evicts the OLDEST tool round(s) — pinning the system
 * prompt and the original task — and subAgents a single elision note, so a long run
 * degrades gracefully instead of breaking the AgentRunResult contract.
 *
 * A "round" is an assistant message plus the tool/user result messages that follow
 * it, so tool results are never orphaned from their tool_calls. Sizing uses a
 * server-calibrated `tokensPerChar` (pass usage.prompt_tokens ÷ chars from the last
 * response) so the estimate tracks the model's real tokenizer rather than a fixed
 * guess. Mutates `messages` in place; returns { dropped, estTokens, fits }.
 */
export function compactHistory(messages, { budgetTokens, tokensPerChar = 0.25, pin = 2 } = {}) {
  const estOf = (msgs) => Math.round(estimateHistoryChars(msgs) * tokensPerChar);
  const estTokens = estOf(messages);
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0 || messages.length <= pin + 1 || estTokens <= budgetTokens) {
    return { dropped: 0, estTokens, fits: estTokens <= budgetTokens };
  }

  // Split the evictable tail (after the pinned head) into rounds.
  const head = messages.slice(0, pin);
  const rounds = [];
  for (const m of messages.slice(pin)) {
    if (m.role === 'assistant' && rounds.length && rounds[rounds.length - 1].length) rounds.push([]);
    if (!rounds.length) rounds.push([]);
    rounds[rounds.length - 1].push(m);
  }

  // Drop oldest rounds down to ~70% of budget (hysteresis avoids compacting every
  // turn) but always keep the most recent round.
  const target = budgetTokens * 0.7;
  let dropped = 0;
  while (rounds.length > 1 && estOf([head, ...rounds].flat()) > target) {
    rounds.shift();
    dropped++;
  }
  if (!dropped) return { dropped: 0, estTokens, fits: false };

  const note = { role: 'user', content: `[context compacted: ${dropped} earlier tool round(s) elided to stay within ~${budgetTokens} tokens]` };
  messages.splice(pin, messages.length - pin, note, ...rounds.flat());
  const finalEst = estOf(messages);
  return { dropped, estTokens: finalEst, fits: finalEst <= budgetTokens };
}

/** Build a schema-valid AgentRunResult from OBSERVED state (+ optional model prose). */
export function synthResult({ assignment, ctx, finalText, stopReason, summaryOverride, extraBlockers = [], briefName }) {
  const filesChanged = [...ctx.filesChanged];
  const modelJson = summaryOverride ? {} : extractResultObject(finalText) || {};
  const summary =
    summaryOverride ||
    (typeof modelJson.summary === 'string' && modelJson.summary.trim()
      ? modelJson.summary.trim()
      : finalText
        ? clampSummary(finalText)
        : `Local worker run on: ${assignment.task ?? assignment.runId}`);
  const status = RUN_STATUSES.includes(modelJson.status) ? modelJson.status : stopReason;
  const baseBlockers = Array.isArray(modelJson.blockers)
    ? modelJson.blockers
    : stopReason === 'partial' && !extraBlockers.length
      ? ['Local worker stopped before a clean final summary (max turns or empty response).']
      : [];
  const parsed = {
    status,
    summary,
    scope: Array.isArray(modelJson.scope) && modelJson.scope.length ? modelJson.scope : assignment.scope,
    filesChanged,
    graphNodesTouched: [...ctx.nodes],
    contractsChanged: toContractStrings(modelJson.contractsChanged),
    testsRun: Array.isArray(modelJson.testsRun) ? modelJson.testsRun : [],
    annotationsWritten: [...ctx.annotations],
    blockers: [...new Set([...baseBlockers, ...extraBlockers].filter(Boolean))],
    compliance: {
      // Honest: true only if refresh_context was actually observed, or nothing changed.
      refreshContextRun: ctx.observed.refreshContextRun || filesChanged.length === 0,
      annotationsClean: assignment.contextSession?.phase === 'annotate' || filesChanged.length === 0,
      dependencyImpactChecked: ctx.observed.dependencyImpactChecked,
      configSurfaceChecked: ctx.observed.configSurfaceChecked,
      flowChecked: ctx.observed.flowChecked,
      architectureChecked: ctx.observed.architectureChecked,
    },
    // Carry the model's schema-supported optional artifacts (review, contextPack, …)
    // into the normalizer, which preserves them raw and strips a stray `review` for
    // non-code-reviewer briefs. Without this a local code-reviewer's `review` is
    // silently dropped and the subAgent fails its required-field validation.
    ...preserveOptionalArtifacts(modelJson),
  };
  return normalizeResult(parsed, assignment, { briefName });
}

/**
 * Real implementer run on a local OpenAI-compatible model.
 *
 * NOTE on resume: a bare chat endpoint has no server-side session, so `opts.resume`
 * is not used — every run restates the task (the harness folds retry context into
 * task.task anyway). opts.capture.usage is filled from summed per-turn usage.
 */
export async function runAgent(task, assignment, repoRoot, opts = {}) {
  // Host-mode gate: run_shell is built on /bin/sh (execRunShell). Fail at run
  // start with the supported route, ahead of a mid-run spawn ENOENT.
  if (process.platform === 'win32') {
    throw new Error(
      'local worker host mode is unsupported on native Windows: run_shell requires /bin/sh. ' +
        'Use WSL2 or the Docker sandbox (docs/usage.md, "Platform support").',
    );
  }
  const auth = resolveAuth('local');
  if (!auth.ok) return blockedResult(assignment, authBlockedReason('local', auth));
  const baseUrl = localBaseUrl();
  if (!baseUrl) return blockedResult(assignment, 'LOCAL_BASE_URL is not set for the local provider.');

  let root;
  try {
    root = fs.realpathSync(repoRoot);
  } catch {
    root = path.resolve(repoRoot);
  }

  const modelRole = opts.modelRole || 'implementer';
  const { model } = resolveLocalRole(modelRole);
  const maxTurns = localMaxTurns();
  const temperature = localTemperature();

  // Run-level abort: hard timeout + external /stop signal.
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

  // Bring up repovine MCP (best-effort: file tools still work if the graph is down).
  const mcp = new McpStdioClient(buildRepovineMcpStdio(root, assignment.contextSession?.sessionId, { inheritProcessEnv: true }));
  const mcpAllow = new Set(REPOVINE_WORKER_MCP_TOOLS);
  let mcpFunctions = [];
  let mcpUp = false;
  try {
    await mcp.start();
    mcpFunctions = mcpToolsToFunctions(await mcp.listTools(), mcpAllow);
    mcpUp = true;
    logBullet(`local model=${model} repovine-mcp=${mcpFunctions.length} tools`, { enabled: VERBOSE, scope: 'local' });
  } catch (e) {
    logBullet(`repovine MCP unavailable (${e.message}); file tools only`, { enabled: VERBOSE, scope: 'local' });
  }

  const tools = [...LOCAL_TOOLS, ...mcpFunctions];
  // Same layered brief the claude adapter delivers: base loop rules + role prose
  // + phase policy + the engine-authored honesty brief. Without these the local
  // worker runs un-briefed against the same gates the brief teaches.
  const systemContent = [
    WORKER_SYSTEM_PROMPT,
    opts.agentPrompt,
    policyForAssignment(assignment),
    resolveHarnessBrief(root, assignment, opts.briefName),
  ].filter(Boolean).join('\n\n');
  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userMessage(task, assignment, root) },
  ];

  const ctx = {
    root,
    mcp: mcpUp ? mcp : null,
    mcpAllow,
    filesChanged: new Set(),
    annotations: new Set(),
    nodes: new Set(),
    observed: {
      refreshContextRun: false,
      dependencyImpactChecked: false,
      configSurfaceChecked: false,
      flowChecked: false,
      architectureChecked: false,
    },
  };

  const usageAcc = { any: false, prompt_tokens: 0, completion_tokens: 0 };
  let finalText = '';
  let reminded = false;
  let stopReason = 'partial'; // upgraded to 'complete' on a clean final answer
  const contextBudget = localContextTokens();
  let tokensPerChar = 0.25; // calibrated from server usage.prompt_tokens each turn

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (abortController.signal.aborted) break;
      // Keep the growing history under the model window (the harness owns the loop
      // here, so nothing else compacts it).
      const comp = compactHistory(messages, { budgetTokens: contextBudget, tokensPerChar });
      if (comp.dropped) {
        logBullet(`context compacted: -${comp.dropped} round(s) ≈${comp.estTokens} tok`, { enabled: VERBOSE, scope: 'local' });
      }
      const projectedTokens = Math.round(estimateHistoryChars(messages) * tokensPerChar);
      let json;
      try {
        json = await chatCompletion({ baseUrl, apiKey: localApiKey(), model, messages, tools, temperature, signal: abortController.signal });
      } catch (e) {
        if (abortController.signal.aborted) break;
        const overBudget = contextBudget > 0 && projectedTokens > contextBudget;
        const hint = overBudget
          ? ` The prompt (~${projectedTokens} tokens) may exceed the model context window — point LOCAL_BASE_URL at a longer-context model, raise LOCAL_CONTEXT_TOKENS only if the real window is larger, or narrow the task.`
          : '';
        return blockedResult(assignment, `Local model request failed: ${e.message}.${hint}`);
      }
      const u = json?.usage;
      if (u) {
        usageAcc.any = true;
        usageAcc.prompt_tokens += numOr0(u.prompt_tokens);
        usageAcc.completion_tokens += numOr0(u.completion_tokens);
        // Calibrate chars→tokens from the server's real prompt count for this exact
        // prompt (messages is still what we sent; tool results are pushed below).
        const pt = numOr0(u.prompt_tokens);
        if (pt > 0) {
          const chars = estimateHistoryChars(messages);
          if (chars > 0) tokensPerChar = pt / chars;
        }
      }
      const msg = json?.choices?.[0]?.message || {};
      const rawContent = typeof msg.content === 'string' ? msg.content : '';
      const visible = stripReasoning(rawContent);

      // Native tool calls are the primary path; inline fallback only when none.
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
          // No native tool_calls field: keep the assistant text, answer with a plain message.
          messages.push({ role: 'assistant', content: rawContent });
          const c = calls[0];
          logBullet(`${c.name} (inline)`, { enabled: VERBOSE, scope: 'local' });
          const out = await dispatchTool(c.name, c.args, ctx);
          messages.push({ role: 'user', content: `[tool:${c.name}] result:\n${out}` });
        } else {
          messages.push({
            role: 'assistant',
            content: rawContent,
            tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.argStr } })),
          });
          for (const c of calls) {
            logBullet(c.name, { enabled: VERBOSE, scope: 'local' });
            const out = await dispatchTool(c.name, c.args, ctx);
            messages.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: out });
          }
        }
        continue;
      }

      // No tool call → candidate final answer.
      if (visible) {
        finalText = visible;
        stopReason = 'complete';
        break;
      }
      // Empty content and no call: one format reminder, then stop as partial.
      if (!reminded) {
        reminded = true;
        messages.push({ role: 'user', content: REMINDER });
        continue;
      }
      break;
    }
  } finally {
    clearTimeout(timer);
    mcp.stop();
  }

  // Capture usage and clear the (non-resumable) session id regardless of how the loop ended.
  if (usageAcc.any && opts.capture) {
    opts.capture.usage = localUsage({ prompt_tokens: usageAcc.prompt_tokens, completion_tokens: usageAcc.completion_tokens }, { model });
  }
  if (opts.capture) opts.capture.sessionId = undefined; // no resumable session for local

  if (abortController.signal.aborted) {
    const reason = timedOut
      ? `Local run timed out after ${Math.round(localTimeoutMs() / 1000)}s (override LOCAL_TIMEOUT_MS or WORKER_TIMEOUT_MS).`
      : 'Stopped by /stop. Re-run to continue (local runs are stateless — the task is restated).';
    // Preserve any real edits made before the abort: a run that changed files is a
    // PARTIAL (work happened, incomplete), not a blank BLOCKED that hides the edits.
    return synthResult({
      assignment,
      ctx,
      finalText: '',
      stopReason: ctx.filesChanged.size > 0 ? 'partial' : 'blocked',
      summaryOverride: reason,
      extraBlockers: [reason],
      briefName: opts.briefName,
    });
  }

  return synthResult({ assignment, ctx, finalText, stopReason, briefName: opts.briefName });
}
