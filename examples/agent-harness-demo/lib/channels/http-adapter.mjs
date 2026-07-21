// HTTP channel for the LangGraph orchestrator — a Telegram-free "handle" you
// drive from another console with curl. Transport + optional bearer auth ONLY;
// every structural concern (step order, worker, protocol gates) lives in the
// graph, exactly like the Telegram adapter.
//
//   curl -s localhost:8080/status
//   curl -s localhost:8080/goal -H 'content-type: application/json' \
//     -d '{"goal":"add a GET /health route returning { ok: true }"}'
//   curl -s localhost:8080/ask -H 'content-type: application/json' \
//     -d '{"question":"how is theme switching implemented?","thread":"demo"}'
//   curl -s -X POST localhost:8080/reset -H 'content-type: application/json' -d '{"confirm":true}'
//
// GET  /status — provider/agents + busy flags + current-run telemetry
//                (named /status for parity with the Telegram /status command).
// POST /goal   — harness protocol run (/task and body key `task` stay accepted; the wire keeps `task`).
// POST /ask    — read-only agent (MCP + file reads).
// POST /ask accepts optional "thread" (conversation key, default "default") and "new":true.
// POST /reset  — wipe the sandbox + reap leftover worker processes + drop /ask sessions.
//                Destructive: requires {"confirm":true} and only runs while idle.
//
// Zero extra deps: node:http.
import http from 'node:http';
import { invokeGraph } from '../graph/workflow.mjs';
import { ATTACH_RESET_DISABLED, resetTarget, resolveTargetFromEnv, targetPolicy } from '../target-repo.mjs';
import { reapAll } from '../sandbox-procs.mjs';
import { isKnownRole, agentsMode } from '../agents.mjs';
import { runAsk } from '../ask.mjs';
import { logLine } from '../log.mjs';
import { compactRunTelemetry, readCurrentRun } from '../telemetry.mjs';

const MAX_BODY_BYTES = 1 << 20; // 1 MiB — a task is text, not a payload dump.

function rolesFromList(roles) {
  if (!Array.isArray(roles)) return [];
  return [
    ...new Set(
      roles
        .map((r) => String(r).toLowerCase())
        .filter((r) => isKnownRole(r) && r !== 'default'),
    ),
  ];
}

function subAgentsFromList(subAgents) {
  if (!Array.isArray(subAgents)) return [];
  return subAgents
    .map((entry) => {
      if (typeof entry === 'string') {
        const [rawRole, rawScope] = entry.split(':');
        const role = String(rawRole || '').toLowerCase().trim();
        if (!isKnownRole(role) || role === 'default') return null;
        return rawScope?.trim() ? { role, scope: [rawScope.trim()] } : { role };
      }
      if (!entry || typeof entry !== 'object') return null;
      const role = String(entry.role || '').toLowerCase().trim();
      if (!isKnownRole(role) || role === 'default') return null;
      return {
        role,
        ...(Array.isArray(entry.scope) ? { scope: entry.scope.map(String).filter(Boolean) } : {}),
        ...(typeof entry.task === 'string' && entry.task.trim() ? { task: entry.task.trim() } : {}),
        ...(typeof entry.manifest === 'string' && entry.manifest.trim() ? { manifest: entry.manifest.trim() } : {}),
        ...(Array.isArray(entry.dependsOn) ? { dependsOn: entry.dependsOn.map(String).filter(Boolean) } : {}),
      };
    })
    .filter(Boolean);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        over = true;
        req.pause(); // stop buffering; let the handler write 413 on the still-open response
        const err = new Error('payload too large');
        err.statusCode = 413;
        reject(err);
        return;
      }
      data += c;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** Require a non-empty trimmed string field; returns { value } or { error }. */
function requireNonEmptyString(payload, field) {
  if (payload == null || typeof payload !== 'object') {
    return { error: `missing required field "${field}" (non-empty string in JSON body)` };
  }
  const raw = payload[field];
  if (typeof raw !== 'string') {
    return { error: `missing required field "${field}" (non-empty string in JSON body)` };
  }
  const value = raw.trim();
  if (!value) {
    return { error: `"${field}" must be a non-empty string (whitespace-only is rejected)` };
  }
  return { value };
}

// Same success rule the CLI entry uses: complete/partial AND compliance ok; in
// multi-agent mode every sub-agent must have completed and passed.
function runSucceeded(final) {
  if (final.mode === 'multi' && Array.isArray(final.subAgents)) {
    return (
      final.subAgents.length > 0 &&
      final.subAgents.every((l) => l.ok && ['complete', 'partial'].includes(l.result?.status))
    );
  }
  return Boolean(final.ok) && ['complete', 'partial'].includes(final.result?.status);
}

/**
 * Start the HTTP harness handle against a compiled graph.
 * @param {object} o
 * @param {import('@langchain/langgraph').CompiledStateGraph} o.graph
 * @param {number} [o.port]      listen port (default 8080)
 * @param {string} [o.host]      bind address (default 0.0.0.0 — isolated net)
 * @param {string} [o.token]     optional bearer token; empty = open endpoint
 * @param {string} o.provider    LLM_PROVIDER label
 * @param {string} [o.repoRoot]  target workspace root (default: resolved from env)
 * @param {{mode: string, repoRoot: string}} [o.target]  resolved target; default sandbox over repoRoot
 * @returns {Promise<import('node:http').Server>}
 */
export async function startHttp({ graph, port = 8080, host = '0.0.0.0', token = '', provider, repoRoot, target }) {
  // Entrypoints pass the resolved target. An explicit repoRoot alone (tests)
  // keeps the pre-attach sandbox assumption; with neither, the WHOLE target
  // comes from the environment — never an env repoRoot paired with a
  // fabricated sandbox mode.
  const resolvedTarget = target ?? (repoRoot ? { mode: 'sandbox', repoRoot } : resolveTargetFromEnv());
  repoRoot = resolvedTarget.repoRoot;
  const policy = targetPolicy(resolvedTarget.mode);
  let episodeBusy = false;
  let askBusy = false;
  /** thread key -> { sessionId, contextSessionId } for POST /ask continuity */
  const askThreads = new Map();

  const send = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  const authorized = (req) => !token || req.headers.authorization === `Bearer ${token}`;

  async function handleTask(req, res, payload) {
    // `goal` is the outward body key; `task` stays accepted (the wire keeps `task`).
    // A missing/invalid body reports the outward name.
    const useTaskAlias = payload != null && typeof payload === 'object' && !('goal' in payload) && typeof payload.task === 'string';
    const taskField = requireNonEmptyString(payload, useTaskAlias ? 'task' : 'goal');
    if (taskField.error) {
      return send(res, 400, { ok: false, error: taskField.error });
    }
    if (episodeBusy) {
      return send(res, 409, { ok: false, error: `an episode is already running (shared ${resolvedTarget.mode === 'attach' ? 'workspace' : 'sandbox'}) — retry when idle` });
    }
    episodeBusy = true;

    const roles = rolesFromList(payload.roles);
    const subAgents = subAgentsFromList(payload.subAgents);
    const review = Boolean(payload.review);
    const abort = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    const task = {
      id: `http-${Date.now()}`,
      task: taskField.value,
      scope: ['.'],
      requestedChecks: [],
      ...(subAgents.length ? { subAgents } : roles.length ? { roles } : {}),
      ...(review ? { review: true } : {}),
    };
    const threadId = payload.thread ? `http:${payload.thread}` : `http:${task.id}`;

    try {
      const final = await invokeGraph(
        graph,
        { task, repoRoot, targetMode: resolvedTarget.mode, llmProvider: provider },
        { threadId, signal: abort.signal },
      );
      send(res, 200, {
        ok: runSucceeded(final),
        mode: final.mode || 'single',
        status: final.result?.status,
        replyText: final.replyText || '',
        telemetry: compactRunTelemetry(final.telemetry),
        turn: final.turn,
        graphNodesTouched: final.result?.graphNodesTouched ?? [],
        ...(final.mode === 'multi' && Array.isArray(final.subAgents)
          ? { subAgents: final.subAgents.map((l) => ({ role: l.role, ok: l.ok, status: l.result?.status })) }
          : {}),
      });
    } catch (e) {
      if (abort.signal.aborted) {
        if (!res.writableEnded) send(res, 499, { ok: false, error: 'client closed request — episode aborted' });
      } else {
        send(res, 500, { ok: false, error: `harness error: ${e.message}` });
      }
    } finally {
      episodeBusy = false;
    }
  }

  async function handleAsk(req, res, payload) {
    const qField = requireNonEmptyString(payload, 'question');
    if (qField.error) {
      return send(res, 400, { ok: false, error: qField.error });
    }
    if (askBusy) {
      return send(res, 409, { ok: false, error: 'an ask is already running — retry when idle' });
    }
    askBusy = true;

    const threadKey = payload.thread != null && String(payload.thread).trim()
      ? String(payload.thread).trim()
      : 'default';
    if (payload.new) askThreads.delete(threadKey);

    const prev = askThreads.get(threadKey);
    const capture = {};
    const contextSessionId = prev?.contextSessionId || `ctx-ask-${threadKey}-${Date.now()}`;

    const abort = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    try {
      const result = await runAsk(qField.value, repoRoot, provider, {
        resume: prev?.sessionId,
        contextSessionId,
        capture,
        signal: abort.signal,
      });
      if (!result.ok) {
        const code = abort.signal.aborted ? 499 : 502;
        return send(res, code, { ok: false, error: result.reason || 'ask failed' });
      }
      if (capture.sessionId) {
        askThreads.set(threadKey, { sessionId: capture.sessionId, contextSessionId });
      }
      send(res, 200, {
        ok: true,
        answer: result.text || '',
        contextSessionId,
        thread: threadKey,
        ...(capture.sessionId ? { sessionId: capture.sessionId } : {}),
      });
    } catch (e) {
      send(res, 500, { ok: false, error: `ask error: ${e.message}` });
    } finally {
      askBusy = false;
    }
  }

  // Destructive housekeeping for the long-lived shared sandbox — the HTTP analogue
  // of the Telegram /reset. Reaps stray servers/containers a prior worker left
  // bound, wipes .workspace (the next /goal re-seeds the stubs via intake), and
  // drops all /ask session continuity. Two guards keep it safe in the synchronous
  // model where the only run handle is the open request itself:
  //   - {"confirm":true} required — an accidental POST cannot wipe the tree;
  //   - idle only — a running /goal or /ask would be writing the tree we delete,
  //     so refuse with 409 and let the caller abort it (close that request) first.
  async function handleReset(_req, res, payload) {
    // A resetAllowed:false policy refuses BEFORE confirm/busy handling with a
    // stable machine-readable code. No mode sets it since Phase 2 (attach reset
    // restores the launch baseline); kept as the policy-driven guard.
    if (!policy.resetAllowed) {
      return send(res, 409, {
        ok: false,
        code: ATTACH_RESET_DISABLED,
        error: 'reset is disabled in attach mode — worktree cleanup is host-side: docker compose --profile attach-* down, then remove the launch state and worktree',
      });
    }
    if (payload?.confirm !== true) {
      return send(res, 400, {
        ok: false,
        error: 'reset is destructive — send {"confirm":true} to wipe .workspace and clear /ask sessions',
      });
    }
    if (episodeBusy || askBusy) {
      return send(res, 409, {
        ok: false,
        error: 'busy — stop the in-flight goal/ask first (close its request), then POST /reset',
      });
    }
    try {
      await reapAll(repoRoot); // kill servers/containers the worker left bound
      resetTarget(resolvedTarget); // empty the sandbox workspace; next /goal intake re-seeds the stubs
      askThreads.clear(); // drop every /ask session — fresh chats next time
      return send(res, 200, { ok: true, reset: true });
    } catch (e) {
      return send(res, 500, { ok: false, error: `reset error: ${e.message}` });
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/status') {
      const base = {
        ok: true,
        provider,
        agents: agentsMode(),
        targetMode: resolvedTarget.mode,
        resetAllowed: policy.resetAllowed,
        busy: episodeBusy,
        episodeBusy,
        askBusy,
      };
      // Run telemetry (workspace paths, model, cost) is sensitive — withhold it
      // unless authorized. Liveness fields stay open so the healthcheck passes.
      if (!authorized(req)) return send(res, 200, base);
      return send(res, 200, { ...base, workspace: repoRoot, currentRun: compactRunTelemetry(readCurrentRun(repoRoot)) });
    }

    const postRoutes = new Set(['/task', '/goal', '/ask', '/reset']);
    if (req.method !== 'POST' || !postRoutes.has(url.pathname)) {
      return send(res, 404, {
        ok: false,
        error: 'not found — use GET /status, POST /goal {"goal":"…"}, POST /ask {"question":"…"}, or POST /reset {"confirm":true}',
      });
    }

    if (!authorized(req)) {
      return send(res, 401, { ok: false, error: 'unauthorized — send Authorization: Bearer <HARNESS_HTTP_TOKEN>' });
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch (e) {
      return send(res, e.statusCode || 400, { ok: false, error: `bad request body: ${e.message}` });
    }

    if (url.pathname === '/task' || url.pathname === '/goal') return handleTask(req, res, payload);
    if (url.pathname === '/reset') return handleReset(req, res, payload);
    return handleAsk(req, res, payload);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  logLine(
    'http',
    `HTTP harness up on http://${host}:${port}. Worker: ${provider}. Agents: ${agentsMode()}. ` +
      `Auth: ${token ? 'bearer token required' : 'OPEN (no token — bind localhost / isolated net only)'}. ` +
      `Endpoints: GET /status, POST /goal, POST /ask, POST /reset. ${resolvedTarget.mode === 'attach' ? `Target mode: attach. Workspace: ${repoRoot}` : `Sandbox: ${repoRoot}`}`,
    { stream: process.stdout },
  );
  return server;
}
