// Telegram channel for the LangGraph orchestrator.
//
// Transport + allowlist ONLY (the design's division of responsibility).
//   /task …  → full LangGraph protocol run (assignment → worker → compliance)
//   /ask …   → read-only Q&A: agent + repovine MCP + file reads (no graph, no edits)
//   plain text (no command) → help — NOT a task
// Commands /help /new /reset /stop /status are fast paths that MUST NOT run the agent
// graph: a destructive /reset confirmation is not a task (the Confirm-as-task bug).
//
// Concurrency model: the poll loop NEVER awaits a running graph invoke. Each task
// runs in the background (one active run per chat, tracked in `activeRuns`) so the
// loop keeps polling and commands stay responsive mid-run:
//   - a second task while busy is rejected (use /stop),
//   - /stop aborts the in-flight run but does NOT preserve LLM worker sessions for
//     the next /task (each /task starts fresh provider sessions; intra-task resume
//     is handled inside the graph invoke),
//   - /reset and /new abort task and /ask FIRST, then wipe / start a fresh thread.
// Cancellation rides invoke config → run_sub_agent → the provider adapter, which all
// support abort (Claude abortController).
//
// Zero extra deps: raw HTTPS long-polling for the LangGraph Telegram entry.
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { invokeGraph } from '../graph/workflow.mjs';
import { resetTarget, resolveTargetFromEnv, targetPolicy } from '../target-repo.mjs';
import { reapAll } from '../sandbox-procs.mjs';
import { isKnownRole, agentsMode, rolesFromMentions } from '../agents.mjs';
import { runAsk, splitForTelegram } from '../ask.mjs';
import { logLine } from '../log.mjs';
import { formatCurrentRunStatus, readCurrentRun } from '../telemetry.mjs';

// Conservative: only explicit @-mentions trigger multi-agent in chat (so plain
// words like "frontend button" don't accidentally fan out). Matching is
// catalog-aware full-id (agents.mjs) — "@dexrx-frontend" resolves to the
// project role, never to a prefix-stripped bundled name.

const RESET_PENDING_MS = 5 * 60 * 1000;
const RESET_CONFIRM_RE = /^(?:confirm|yes|y|ok|reset)$/i;
const RESET_CANCEL_RE = /^(?:cancel|no|n)$/i;
const RESET_KEYBOARD = {
  inline_keyboard: [[
    { text: '✅ Confirm reset', callback_data: 'reset:confirm' },
    { text: 'Cancel', callback_data: 'reset:cancel' },
  ]],
};
// Abort still in flight can take a moment to propagate into the provider SDK;
// /reset and /new wait at most this long for the worker to actually stop.
const STOP_GRACE_MS = 30000;
// Liveness heartbeat: the poll loop touches this file each iteration (≤ the 30s
// long-poll timeout). The container healthcheck checks its mtime, so a wedged
// loop — not just a dead process — is detected and the bot is restarted.
const HEARTBEAT_FILE = process.env.HARNESS_HEARTBEAT_FILE || '/tmp/harness-tg-bot.alive';
// Where downloaded photos land inside the workspace, split per flow so /task and
// /ask (independent tracks that can be in flight at once) never clear each other's
// files: .harness/attachments/task/ and .harness/attachments/ask/. Living under
// `.harness` keeps chat attachments out of workspace custody/diffs in both modes —
// in attach that directory is the external runtime mount, so /new, /task, and
// photo downloads never touch worktree files. The worker/ask agent runs with
// cwd = repoRoot, so it opens them via the relative path with its image-capable
// Read/file tool (provider-agnostic — no inline image plumbing).
export const ATTACHMENTS_ROOT = path.join('.harness', 'attachments');
const ATTACH_ROOT = ATTACHMENTS_ROOT;

/**
 * Reset command decision per target policy. Both target modes arm the
 * confirmation flow since Phase 2 (attach reset restores the launch baseline);
 * the refusal branch serves any future resetAllowed:false policy. Exported for
 * the adapter-level unit test.
 */
export function telegramResetPlan(policy) {
  if (policy.resetAllowed) return { action: 'confirm' };
  return {
    action: 'refuse',
    reply:
      '🚫 Reset is disabled in attach mode — the worktree is host-managed.\n' +
      'Stop the containers with `npm run docker:down`; review, promotion, and cleanup happen on the host.',
  };
}

// Pull the single best image off an incoming message: the largest photo size,
// or an image/* document. Returns null when there's nothing to attach. We carry
// only the file_id here; the actual download is deferred to /task or /ask
// (saveAttachment) so non-task/ask photos never hit the network.
function extractPhoto(msg) {
  if (Array.isArray(msg?.photo) && msg.photo.length) {
    const largest = msg.photo[msg.photo.length - 1]; // photo[] is sorted small→large
    return { fileId: largest.file_id, mediaType: 'image/jpeg', ext: '.jpg', caption: msg.caption };
  }
  if (msg?.document && /^image\//.test(msg.document.mime_type || '')) {
    return {
      fileId: msg.document.file_id,
      mediaType: msg.document.mime_type,
      ext: path.extname(msg.document.file_name || '') || '',
      caption: msg.caption,
    };
  }
  return null;
}

function isResetConfirmText(text) {
  const t = text.trim();
  if (/^\/reset\s+confirm$/i.test(t)) return true;
  return RESET_CONFIRM_RE.test(t);
}

/**
 * Run the Telegram long-poll loop against a compiled graph.
 * @param {object} o
 * @param {import('@langchain/langgraph').CompiledStateGraph} o.graph
 * @param {string} o.token       TELEGRAM_BOT_TOKEN
 * @param {string[]} o.allowedIds allowlisted sender ids (silent drop otherwise)
 * @param {string} o.provider    LLM_PROVIDER label for help text
 * @param {string} [o.repoRoot]  target workspace root (default: resolved from env)
 * @param {{mode: string, repoRoot: string}} [o.target]  resolved target; default sandbox over repoRoot
 */
export async function startTelegram({ graph, token, allowedIds, provider, repoRoot, target }) {
  // Entrypoints pass the resolved target. An explicit repoRoot alone (tests)
  // keeps the pre-attach sandbox assumption; with neither, the WHOLE target
  // comes from the environment — never an env repoRoot paired with a
  // fabricated sandbox mode.
  const resolvedTarget = target ?? (repoRoot ? { mode: 'sandbox', repoRoot } : resolveTargetFromEnv());
  repoRoot = resolvedTarget.repoRoot;
  const policy = targetPolicy(resolvedTarget.mode);
  const attach = resolvedTarget.mode === 'attach';
  // TELEGRAM_API_BASE points both the JSON Bot API and the file endpoint at a base URL.
  // In the hardened Docker path it is the egress-gw custody proxy (plain http on loopback)
  // that injects the real token and pins the outbound chat_id; it defaults to Telegram
  // directly for a bare run. http vs https follows the base scheme.
  const API_BASE = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  const httpClient = API_BASE.startsWith('http://') ? http : https;
  const API = `${API_BASE}/bot${token}`;
  // File downloads use a different host path than the JSON Bot API: getFile gives
  // a file_path, then the bytes come from /file/bot<token>/<file_path>.
  const FILE_API = `${API_BASE}/file/bot${token}`;

  // Per-chat thread generation: /new and /reset bump it so the next invoke uses a
  // fresh checkpointer thread (turn=0, no resumed worker session) WITHOUT touching
  // sandbox files. Thread id = telegram:<chatId>:<gen>.
  const threadGen = new Map();
  const pendingReset = new Map();
  // chatId -> { abort: AbortController, promise: Promise, startedAt: number }.
  // Presence === "a task is running for this chat" (one at a time).
  const activeRuns = new Map();
  // chatId -> { sessionId, contextSessionId } for /ask continuity (separate from /task).
  const askSessions = new Map();
  // Bumped on /new and /reset so in-flight /ask cannot restore sessions or post replies.
  const sessionGen = new Map();
  // chatId -> { abort: AbortController, promise: Promise, gen: number }.
  const activeAsks = new Map();
  const threadId = (chatId) => `telegram:${chatId}:${threadGen.get(chatId) ?? 0}`;
  const bumpThread = (chatId) => threadGen.set(chatId, (threadGen.get(chatId) ?? 0) + 1);
  const bumpSessionGen = (chatId) => sessionGen.set(chatId, (sessionGen.get(chatId) ?? 0) + 1);
  const isBusy = (chatId) => activeRuns.has(chatId);

  function api(method, payload) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload ?? {});
      const req = httpClient.request(
        `${API}/${method}`,
        { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // Graph replies are plain text (emoji ok), so no Markdown to escape. Help text
  // uses Markdown; fall back to plain text if Telegram rejects it.
  async function send(chatId, text, extra = {}) {
    let res = await api('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...extra });
    if (!res?.ok && extra.parse_mode) {
      const { parse_mode: _pm, ...plain } = extra;
      res = await api('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...plain });
    }
    if (!res?.ok) {
      const detail = res?.description || res?.error_code || JSON.stringify(res);
      logLine('telegram', `sendMessage failed chat=${chatId}: ${detail} (${Buffer.byteLength(String(text))} bytes)`);
    }
    return res;
  }

  /** Send prose longer than Telegram's limit as a sequence of messages. */
  async function sendLong(chatId, text, extra = {}) {
    const parts = splitForTelegram(text);
    let last;
    for (const part of parts) {
      last = await send(chatId, part, extra);
      if (!last?.ok) break;
    }
    return last;
  }

  const answerCallback = (id, text) =>
    api('answerCallbackQuery', { callback_query_id: id, text, show_alert: false });

  // Stream a Telegram file (by its getFile file_path) straight to disk.
  function downloadFile(filePath, dest) {
    return new Promise((resolve, reject) => {
      httpClient
        .get(`${FILE_API}/${filePath}`, (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`download HTTP ${res.statusCode}`));
            return;
          }
          const out = fs.createWriteStream(dest);
          res.pipe(out);
          out.on('finish', () => out.close(() => resolve(dest)));
          out.on('error', reject);
        })
        .on('error', reject);
    });
  }

  const attachDir = (kind) => path.join(repoRoot, ATTACH_ROOT, kind);

  // Wipe one flow's attachment dir so images don't accumulate. /task clears 'task' on
  // every run (each task is one-shot); /ask clears 'ask' when a new photo replaces the
  // prior one and on /new (a text-only /ask turn keeps the image for the live dialog).
  // Per-flow dirs mean a /task and a concurrent /ask never delete each other's files.
  function clearAttachments(kind) {
    try {
      fs.rmSync(attachDir(kind), { recursive: true, force: true });
    } catch {
      /* best-effort cleanup — never block on it */
    }
  }

  // Resolve a photo descriptor to a saved file in the sandbox and return the
  // attachment record the task/ask carries (path is RELATIVE to repoRoot = agent cwd).
  async function saveAttachment(photo, chatId, kind) {
    const info = await api('getFile', { file_id: photo.fileId });
    const filePath = info?.result?.file_path;
    if (!info?.ok || !filePath) {
      throw new Error(info?.description || 'getFile failed');
    }
    const ext = path.extname(filePath) || photo.ext || '.jpg';
    const dir = attachDir(kind);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `tg-${chatId}-${Date.now()}${ext}`);
    await downloadFile(filePath, dest);
    return {
      path: path.relative(repoRoot, dest),
      mediaType: photo.mediaType || 'image/jpeg',
      ...(photo.caption ? { caption: photo.caption } : {}),
    };
  }

  function resetPending(chatId) {
    const at = pendingReset.get(chatId);
    if (!at) return false;
    if (Date.now() - at > RESET_PENDING_MS) {
      pendingReset.delete(chatId);
      return false;
    }
    return true;
  }

  // ── run lifecycle ────────────────────────────────────────────────────────────
  async function sendHelp(chatId) {
    return send(
      chatId,
      [
        '*repovine × LangGraph harness*',
        `_orchestrator: LangGraph · worker: ${provider} · agents: ${agentsMode()}_`,
        '',
        '*Commands*',
        `\`/goal …\` — state a goal; one episode runs it (writes ${attach ? 'the attached workspace' : 'sandbox'}, full protocol cycle)`,
        '`/ask …` — read-only Q&A; follow-up `/ask` continues the same chat',
        '',
        '*Examples*',
        '`/goal add a GET /health route returning { ok: true }`',
        '`/ask how is theme switching implemented in the frontend?`',
        '',
        '📎 Attach a photo (caption it with `/goal …` or `/ask …`) to include the image.',
        '',
        'Plain text without a command shows this help (not a goal).',
        '',
        '`/stop` — interrupt the running *episode*',
        '`/status` — is an episode running? any open /goal or /ask session?',
        `\`/new\` — new LangGraph thread + fresh /ask chat (${attach ? 'workspace' : 'sandbox'} files kept; /goal always uses fresh LLM sessions)`,
        policy.resetAllowed
          ? (attach
            ? '`/reset` — reset the workspace to the launch baseline (confirm with button or `confirm`)'
            : '`/reset` — wipe `.workspace` + conversation (confirm with button or `confirm`)')
          : '`/reset` — disabled by the target policy; cleanup happens on the host',
      ].join('\n'),
      { parse_mode: 'Markdown' },
    );
  }

  /** Start a harness task in the BACKGROUND. One /task per chat at a time. */
  async function startTask(chatId, text, photo) {
    const body = String(text ?? '').trim();
    if (!body && !photo) {
      return send(chatId, '❌ Missing goal text. Usage: `/goal describe what to build or change`', { parse_mode: 'Markdown' });
    }
    if (isBusy(chatId)) {
      return send(chatId, '⏳ An episode is already running in this chat. /stop to interrupt, /status to check.');
    }
    // Start each task with a clean attachment slate — drop the previous task's image
    // (the prior run is done; isBusy guarantees no in-flight task is still reading it)
    // before downloading this task's, so .attachments/task never accumulates.
    clearAttachments('task');
    // Fetch the attached photo before announcing — a download failure should not
    // look like a started task.
    let attachments;
    if (photo) {
      try {
        attachments = [await saveAttachment(photo, chatId, 'task')];
      } catch (e) {
        return send(chatId, `❌ Could not fetch the attached photo: ${e.message}`);
      }
    }
    const roles = rolesFromMentions(text);
    const note = roles.length ? ` (multi-agent: ${roles.join(', ')})` : '';
    const photoNote = attachments ? ' 📎 photo attached' : '';
    await send(chatId, `▶️ On it — wrapping an assignment, ${attach ? 'attach mode (worktree)' : 'sandbox mode'}…${note}${photoNote} /stop to interrupt`);

    const abort = new AbortController();
    const capture = {};
    const task = {
      id: `tg-${chatId}-${Date.now()}`,
      task: body,
      scope: ['.'],
      requestedChecks: [],
      ...(roles.length ? { roles } : {}),
      ...(attachments ? { attachments } : {}),
    };

    const promise = invokeGraph(
      graph,
      { chatId, task, repoRoot, targetMode: resolvedTarget.mode, llmProvider: provider },
      { threadId: threadId(chatId), signal: abort.signal, capture },
    )
      .then((final) => {
        const footer = final.turn ? `\n🧵 turn ${final.turn} · /new to start fresh` : '';
        const body = `${final.replyText || '(no reply produced)'}${footer}`;
        return sendLong(chatId, body);
      })
      .catch((e) => {
        if (abort.signal.aborted) {
          return send(chatId, '🛑 Stopped.', { parse_mode: 'Markdown' });
        }
        return send(chatId, `Harness error: ${e.message}`);
      })
      .finally(() => {
        activeRuns.delete(chatId);
      });

    activeRuns.set(chatId, { abort, promise, startedAt: Date.now() });
  }

  /** Read-only Q&A — provider session resumes across /ask in the same chat. */
  async function startAsk(chatId, question, photo) {
    const q = String(question ?? '').trim();
    if (!q) {
      return send(chatId, '❌ Missing question. Usage: `/ask your question` (you can attach a photo)', { parse_mode: 'Markdown' });
    }
    if (activeAsks.has(chatId)) {
      return send(chatId, '⏳ Already answering — wait for the reply or ask again after it finishes.');
    }
    // /ask is conversational: a NEW photo replaces the dialog's prior image; a text-only
    // turn keeps it so the agent can re-read it (the image also rides the resumed session
    // history). /new clears it. Only clear+download when this turn actually carries a photo.
    let attachments;
    if (photo) {
      clearAttachments('ask');
      try {
        attachments = [await saveAttachment(photo, chatId, 'ask')];
      } catch (e) {
        return send(chatId, `❌ Could not fetch the attached photo: ${e.message}`);
      }
    }
    const resuming = askSessions.has(chatId);
    const photoNote = attachments ? ' 📎 photo attached' : '';
    await send(chatId, `${resuming ? '💭 Working on your question… (continuing chat)' : '💭 Working on your question…'}${photoNote}`);

    const gen = sessionGen.get(chatId) ?? 0;
    const abort = new AbortController();
    const capture = {};
    const prev = askSessions.get(chatId);
    const contextSessionId = prev?.contextSessionId || `ctx-ask-${chatId}-${Date.now()}`;

    const promise = runAsk(q, repoRoot, provider, {
      resume: prev?.sessionId,
      contextSessionId,
      capture,
      signal: abort.signal,
      ...(attachments ? { attachments } : {}),
    })
      .then((res) => {
        if ((sessionGen.get(chatId) ?? 0) !== gen) return;
        if (!res.ok) return send(chatId, `Ask failed: ${res.reason}`);
        const footer = capture.sessionId ? '\n\n(/new — fresh /ask chat)' : '';
        return sendLong(chatId, `${res.text || '(empty reply)'}${footer}`);
      })
      .catch((e) => {
        if ((sessionGen.get(chatId) ?? 0) !== gen) return;
        return send(chatId, `Ask error: ${e.message}`);
      })
      .finally(() => {
        if ((sessionGen.get(chatId) ?? 0) === gen && capture.sessionId) {
          askSessions.set(chatId, { sessionId: capture.sessionId, contextSessionId });
        }
        activeAsks.delete(chatId);
      });

    activeAsks.set(chatId, { abort, promise, gen });
    return undefined;
  }

  /** Abort the active run (non-blocking). Returns true if there was one. */
  function stopRun(chatId) {
    const run = activeRuns.get(chatId);
    if (run) run.abort.abort();
    return Boolean(run);
  }

  /** Abort the active run and WAIT for it to actually settle (bounded). */
  async function stopAndWait(chatId) {
    const run = activeRuns.get(chatId);
    if (!run) return false;
    run.abort.abort();
    await Promise.race([
      run.promise.catch(() => {}),
      new Promise((r) => setTimeout(r, STOP_GRACE_MS)),
    ]);
    return true;
  }

  /** Abort the active /ask and WAIT for it to settle (bounded). */
  async function stopAskAndWait(chatId) {
    const ask = activeAsks.get(chatId);
    if (!ask) return false;
    ask.abort.abort();
    await Promise.race([
      ask.promise.catch(() => {}),
      new Promise((r) => setTimeout(r, STOP_GRACE_MS)),
    ]);
    return true;
  }

  async function doReset(chatId) {
    // Defense in depth: the /reset command path already refuses in attach, and
    // resetTarget throws for attach — this guard keeps the wipe sequence
    // unreachable even from a future caller.
    const plan = telegramResetPlan(policy);
    if (plan.action !== 'confirm') return send(chatId, plan.reply);
    bumpSessionGen(chatId); // in-flight /ask must not restore sessions or reply
    await stopAndWait(chatId); // stop the worker BEFORE wiping the tree it writes to
    await stopAskAndWait(chatId);
    await reapAll(repoRoot); // kill any servers/containers the worker left bound
    resetTarget(resolvedTarget); // empty .workspace contents; next graph intake re-seeds the stubs
    bumpThread(chatId); // fresh graph thread (clears turn counter)
    askSessions.delete(chatId);
    pendingReset.delete(chatId);
    return send(
      chatId,
      attach
        ? '🧹 Reset done — workspace restored to the launch baseline, conversation cleared. Use `/goal …` for the next goal.'
        : '🧹 Reset done — workspace wiped and conversation cleared. Use `/goal …` for the next goal.',
    );
  }

  async function handleMessage(chatId, text, photo) {
    const trimmed = text.trim();
    const [cmd, ...args] = trimmed.split(/\s+/);

    if (cmd === '/start' || cmd === '/help') {
      return sendHelp(chatId);
    }

    // /goal is the outward name; /task stays accepted for muscle memory (the wire keeps `task`).
    if (cmd === '/task' || cmd === '/goal') {
      const body = trimmed.slice(cmd.length).trim();
      return startTask(chatId, body, photo);
    }

    if (cmd === '/ask') {
      const body = trimmed.slice('/ask'.length).trim();
      return startAsk(chatId, body, photo);
    }

    if (cmd === '/stop') {
      if (!stopRun(chatId)) return send(chatId, 'Nothing to stop — no episode is running.');
      // The background run settles and posts the final ⛔ stopped reply itself.
      return send(chatId, '🛑 Stopping the current episode…');
    }

    if (cmd === '/status') {
      const run = activeRuns.get(chatId);
      if (run) {
        const secs = Math.round((Date.now() - run.startedAt) / 1000);
        const current = formatCurrentRunStatus(readCurrentRun(repoRoot));
        const detail = current ? `\n${current}` : '';
        return send(chatId, `⏳ An episode is running (${secs}s elapsed). /stop to interrupt.${detail}`);
      }
      const askOpen = askSessions.has(chatId) ? ' A /ask chat is open — /ask … to continue it.' : '';
      const last = formatCurrentRunStatus(readCurrentRun(repoRoot));
      const detail = last ? `\n${last}` : '';
      const targetLine = resolvedTarget.mode === 'attach' ? `\n🎯 target: attach · workspace: ${repoRoot}` : '';
      return send(chatId, `✅ Idle. worker: ${provider}, agents: ${agentsMode()}.${askOpen}${targetLine}${detail}`);
    }

    if (cmd === '/new') {
      bumpSessionGen(chatId);
      await stopAndWait(chatId);
      await stopAskAndWait(chatId);
      bumpThread(chatId);
      askSessions.delete(chatId);
      clearAttachments('ask'); // the /ask dialog (and its image) ends here
      pendingReset.delete(chatId);
      return send(chatId, `🆕 New conversation. The ${attach ? 'workspace' : 'sandbox'} files are kept — /goal and /ask start fresh.`);
    }

    if (cmd === '/reset') {
      const plan = telegramResetPlan(policy);
      // A resetAllowed:false policy refuses before the flow arms (no mode sets
      // it since Phase 2; kept as the policy-driven guard).
      if (plan.action !== 'confirm') return send(chatId, plan.reply);
      if (args[0]?.toLowerCase() === 'confirm') return doReset(chatId);
      pendingReset.set(chatId, Date.now());
      return send(
        chatId,
        attach
          ? '⚠️ This stops any running episode or /ask, then resets the workspace to the *launch baseline* and clears the conversation. Committed `attach/run-*` snapshots survive.\n\nTap *Confirm reset*, or reply `confirm` / `yes` (also `/reset confirm`).'
          : '⚠️ This stops any running episode or /ask, then deletes everything under `.workspace` *and* the conversation.\n\nTap *Confirm reset*, or reply `confirm` / `yes` (also `/reset confirm`).',
        { parse_mode: 'Markdown', reply_markup: RESET_KEYBOARD },
      );
    }

    // After /reset, accept human confirmations — never let them become a task.
    if (resetPending(chatId)) {
      const plain = text.trim();
      if (isResetConfirmText(plain)) return doReset(chatId);
      if (RESET_CANCEL_RE.test(plain)) {
        pendingReset.delete(chatId);
        return send(chatId, attach ? 'Reset cancelled — workspace and conversation unchanged.' : 'Reset cancelled — sandbox and conversation unchanged.');
      }
      // Anything else while reset is pending → help, not a task.
      return sendHelp(chatId);
    }

    // Unknown /command or plain text → help (explicit /task required).
    if (trimmed.startsWith('/')) {
      return send(chatId, 'Unknown command. Use `/help` for /goal and /ask.', { parse_mode: 'Markdown' });
    }
    return sendHelp(chatId);
  }

  async function handleCallback(chatId, callbackId, data) {
    if (data === 'reset:confirm') {
      if (!resetPending(chatId)) {
        await answerCallback(callbackId, 'Reset prompt expired — send /reset again.');
        return send(chatId, '⏱ That reset prompt expired. Send `/reset` again.', { parse_mode: 'Markdown' });
      }
      await answerCallback(callbackId, 'Stopping + resetting…');
      return doReset(chatId);
    }
    if (data === 'reset:cancel') {
      pendingReset.delete(chatId);
      await answerCallback(callbackId, 'Cancelled.');
      return send(chatId, attach ? 'Reset cancelled — workspace and conversation unchanged.' : 'Reset cancelled — sandbox and conversation unchanged.');
    }
    return answerCallback(callbackId);
  }

  // ── Poll loop ──────────────────────────────────────────────────────────────
  const me = await api('getMe');
  if (!me?.ok) {
    throw new Error(`getMe failed — check TELEGRAM_BOT_TOKEN: ${JSON.stringify(me)}`);
  }
  logLine(
    'telegram',
    `Bot @${me.result.username} up. Orchestrator: LangGraph. Worker: ${provider}. Agents: ${agentsMode()}. ` +
      `Allowlist: [${allowedIds.join(', ')}]. ${resolvedTarget.mode === 'attach' ? `Target mode: attach. Workspace: ${repoRoot}` : `Sandbox: ${repoRoot}`}`,
    { stream: process.stdout },
  );

  let offset = 0;
  for (;;) {
    try {
      fs.writeFileSync(HEARTBEAT_FILE, String(Date.now())); // liveness for the healthcheck
    } catch {
      /* heartbeat is best-effort — never let it break the poll loop */
    }
    let updates;
    try {
      updates = await api('getUpdates', { offset, timeout: 30 });
    } catch (e) {
      logLine('telegram', `getUpdates failed, retrying: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    for (const u of updates?.result ?? []) {
      offset = u.update_id + 1;

      const cb = u.callback_query;
      if (cb) {
        const fromId = String(cb.from?.id ?? '');
        if (!allowedIds.includes(fromId)) {
          logLine('telegram', `IGNORED callback from ${fromId} (not allowlisted): ${cb.data}`, { stream: process.stdout });
          continue;
        }
        const chatId = cb.message?.chat?.id;
        if (!chatId || !cb.data) continue;
        logLine('telegram', `${cb.from?.username ? `@${cb.from.username}` : chatId}: [callback] ${cb.data}`, { stream: process.stdout });
        try {
          await handleCallback(chatId, cb.id, cb.data);
        } catch (e) {
          await send(chatId, `Harness error: ${e.message}`);
        }
        continue;
      }

      const msg = u.message;
      // A photo carries its command/text in `caption`, not `text`. Accept a
      // message if it has either text or an attachable image; drop the rest.
      const photo = msg ? extractPhoto(msg) : null;
      const text = msg?.text ?? msg?.caption ?? '';
      if (!msg || (!text && !photo)) continue;
      const fromId = String(msg.from?.id ?? '');
      const logText = text || (photo ? '[photo]' : '');
      if (!allowedIds.includes(fromId)) {
        logLine('telegram', `IGNORED ${msg.from?.username ? `@${msg.from.username}` : fromId} (not allowlisted): ${logText}`, { stream: process.stdout });
        continue;
      }
      logLine('telegram', `${msg.from?.username ? `@${msg.from.username}` : msg.chat.id}: ${photo ? '📎 ' : ''}${logText}`, { stream: process.stdout });
      try {
        // handleMessage returns quickly: commands run inline; tasks are dispatched
        // to the background, so the loop keeps polling (and accepting /stop) mid-run.
        await handleMessage(msg.chat.id, text, photo);
      } catch (e) {
        await send(msg.chat.id, `Harness error: ${e.message}`);
      }
    }
  }
}
