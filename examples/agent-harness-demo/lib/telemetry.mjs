// Demo-local dev-session telemetry: small JSON artifacts for "what is happening
// right now?" without pulling in a metrics backend. The durable protocol contract
// stays AgentRunResult; this is operator feedback for CLI/HTTP/Telegram.
import fs from 'node:fs';
import path from 'node:path';
import { totalUsage } from './workers/usage.mjs';
import { formatMcpMetrics, totalMcpMetrics } from './workers/mcp-telemetry.mjs';

import {
  CURRENT_RUN_BASENAME,
  EVENTS_BASENAME,
  RUN_LEVEL,
  activeTelemetryPath,
  archiveActiveRun,
  findLatestArchivedRunId,
  runLevelPath,
} from './harness-paths.mjs';

export const TELEMETRY_SCHEMA_VERSION = 3;
export const CURRENT_RUN_FILE = CURRENT_RUN_BASENAME;
export const EVENTS_FILE = EVENTS_BASENAME;

const nowIso = () => new Date().toISOString();
const nowMs = () => Date.now();

function currentRunFile(repoRoot) {
  return activeTelemetryPath(repoRoot, CURRENT_RUN_BASENAME);
}

function eventsFile(repoRoot) {
  return activeTelemetryPath(repoRoot, EVENTS_BASENAME);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function baseRun({ runId, provider, mode, targetMode, workspace, task, at, atMs }) {
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    runId: runId ?? task?.id ?? 'run',
    provider: provider ?? null,
    mode: mode ?? null,
    // Target metadata: the mode and the workspace path AS THIS PROCESS SEES IT
    // (/workspace inside the attach container) — host source paths never enter
    // run telemetry.
    targetMode: targetMode ?? null,
    workspace: workspace ?? null,
    status: 'running',
    phase: 'intake',
    startedAt: at,
    startedAtMs: atMs,
    updatedAt: at,
    elapsedMs: 0,
    task: {
      scope: task?.scope ?? [],
      roles: task?.roles ?? [],
      review: Boolean(task?.review),
    },
    current: { phase: 'intake', label: 'intake', startedAt: at, startedAtMs: atMs },
    phases: {},
    subAgents: [],
    usage: null,
    mcp: null,
    runtimeCheck: null,
    eventsCount: 0,
  };
}

function upsertSubAgent(run, event) {
  const subAgentId = event.subAgent ?? event.role ?? 'default';
  let subAgent = run.subAgents.find((a) => a.subAgent === subAgentId);
  if (!subAgent) {
    subAgent = {
      subAgent: subAgentId,
      role: event.role ?? subAgentId,
      status: 'pending',
      attempts: 0,
    };
    run.subAgents.push(subAgent);
  }
  return subAgent;
}

function recomputeDerived(run) {
  const finishedSubAgents = run.subAgents.filter((a) => typeof a.durationMs === 'number');
  run.slowestSubAgent = finishedSubAgents.reduce((slowest, subAgent) => {
    if (!slowest || subAgent.durationMs > slowest.durationMs) return {
      subAgent: subAgent.subAgent,
      role: subAgent.role,
      durationMs: subAgent.durationMs,
    };
    return slowest;
  }, null);

  if (!run.usage?.total) {
    const total = totalUsage(run.subAgents.map((a) => a.usage));
    if (total) run.usage = { total };
  }
  if (!run.mcp?.total) {
    const total = totalMcpMetrics(run.subAgents.map((a) => a.mcp));
    if (total) run.mcp = { total };
  }
}

function applyEvent(run, event) {
  run.updatedAt = event.at;
  run.elapsedMs = Math.max(0, event.atMs - (run.startedAtMs ?? event.atMs));
  run.eventsCount = (run.eventsCount ?? 0) + 1;
  if (event.phase) run.phase = event.phase;

  if (event.event === 'phase_started') {
    run.phase = event.phase;
    run.current = {
      phase: event.phase,
      label: event.label ?? event.phase,
      startedAt: event.at,
      startedAtMs: event.atMs,
    };
    run.phases[event.phase] = {
      ...(run.phases[event.phase] ?? {}),
      lastStartedAt: event.at,
      lastStartedAtMs: event.atMs,
    };
  } else if (event.event === 'phase_finished') {
    const phase = event.phase;
    const prev = run.phases[phase] ?? {};
    const durationMs = event.durationMs
      ?? (prev.lastStartedAtMs ? Math.max(0, event.atMs - prev.lastStartedAtMs) : null);
    run.phases[phase] = {
      ...prev,
      ok: event.ok ?? prev.ok,
      count: (prev.count ?? 0) + 1,
      durationMs: (prev.durationMs ?? 0) + (durationMs ?? 0),
      lastFinishedAt: event.at,
    };
    if (run.current?.phase === phase) run.current = null;
  } else if (event.event === 'plan_finished') {
    run.plan = {
      mode: event.planMode ?? null,
      subAgentCount: event.subAgentCount ?? null,
      stages: event.stages ?? null,
      durationMs: event.durationMs ?? null,
    };
    run.phase = 'plan';
  } else if (event.event === 'sub_agent_started') {
    const subAgent = upsertSubAgent(run, event);
    Object.assign(subAgent, {
      role: event.role ?? subAgent.role,
      scope: event.scope ?? subAgent.scope,
      status: 'running',
      resumed: Boolean(event.resumed),
      startedAt: event.at,
      startedAtMs: event.atMs,
    });
    run.phase = `sub_agent:${subAgent.role}`;
    run.current = { phase: 'sub_agent', label: subAgent.subAgent, startedAt: event.at, startedAtMs: event.atMs };
  } else if (event.event === 'sub_agent_attempt_finished') {
    const subAgent = upsertSubAgent(run, event);
    subAgent.attempts = Math.max(subAgent.attempts ?? 0, event.attempt ?? 0);
    subAgent.lastAttempt = {
      attempt: event.attempt ?? subAgent.attempts,
      ok: Boolean(event.ok),
      status: event.status ?? null,
      durationMs: event.durationMs ?? null,
      syncOnlyRejection: Boolean(event.syncOnlyRejection),
      complianceErrors: event.complianceErrors ?? 0,
    };
    if (event.usage) subAgent.usage = event.usage;
  } else if (event.event === 'sub_agent_finished') {
    const subAgent = upsertSubAgent(run, event);
    Object.assign(subAgent, {
      status: event.ok ? 'complete' : 'blocked',
      ok: Boolean(event.ok),
      resultStatus: event.resultStatus ?? null,
      durationMs: event.durationMs ?? (
        subAgent.startedAtMs ? Math.max(0, event.atMs - subAgent.startedAtMs) : null
      ),
      attempts: event.attempts ?? subAgent.attempts ?? 0,
      blockers: event.blockers ?? 0,
      filesChanged: event.filesChanged ?? 0,
      usage: event.usage ?? subAgent.usage ?? null,
      mcp: event.mcp ?? subAgent.mcp ?? null,
      updatedAt: event.at,
    });
    if (run.current?.label === subAgent.subAgent) run.current = null;
  } else if (event.event === 'sub_agent_mcp') {
    const subAgent = upsertSubAgent(run, event);
    if (event.mcp) subAgent.mcp = event.mcp;
  } else if (event.event === 'runtime_check_started') {
    run.phase = 'runtime_check';
    run.current = { phase: 'runtime_check', label: 'runtime_check', startedAt: event.at, startedAtMs: event.atMs };
  } else if (event.event === 'runtime_check_finished') {
    run.runtimeCheck = {
      ok: Boolean(event.ok),
      skipped: Boolean(event.skipped),
      command: event.command ?? null,
      commands: event.commands ?? [],
      exitCode: event.exitCode ?? null,
      durationMs: event.durationMs ?? null,
      fixAttempts: event.fixAttempts ?? 0,
    };
    if (run.current?.phase === 'runtime_check') run.current = null;
  } else if (event.event === 'run_usage') {
    run.usage = event.usage ?? null;
  } else if (event.event === 'run_mcp') {
    run.mcp = event.mcp ?? null;
  } else if (event.event === 'run_finished') {
    run.status = event.status ?? (event.ok ? 'complete' : 'failed');
    run.ok = Boolean(event.ok);
    run.phase = 'done';
    run.current = null;
    if (event.usage) run.usage = event.usage;
    if (event.mcp) run.mcp = event.mcp;
    if (event.summary) run.summary = event.summary;
  }

  recomputeDerived(run);
  return run;
}

export function readCurrentRun(repoRoot) {
  if (!repoRoot) return null;
  const active = safeReadJson(currentRunFile(repoRoot));
  if (active) return active;
  const runId = findLatestArchivedRunId(repoRoot);
  if (!runId) return null;
  return safeReadJson(runLevelPath(repoRoot, runId, RUN_LEVEL.summary, { active: false }));
}

export function startRunTelemetry(repoRoot, { runId, provider, mode, targetMode, task } = {}) {
  if (!repoRoot) return null;
  try {
    const at = nowIso();
    const atMs = nowMs();
    const run = baseRun({ runId, provider, mode, targetMode, workspace: repoRoot, task, at, atMs });
    const event = { at, atMs, event: 'run_started', runId: run.runId, provider, mode };
    appendJsonl(eventsFile(repoRoot), event);
    run.eventsCount = 1;
    writeJson(currentRunFile(repoRoot), run);
    return run;
  } catch {
    return null;
  }
}

export function recordRunEvent(repoRoot, event = {}) {
  if (!repoRoot) return null;
  try {
    const at = event.at ?? nowIso();
    const atMs = event.atMs ?? nowMs();
    const stamped = { ...event, at, atMs };
    appendJsonl(eventsFile(repoRoot), stamped);
    const current = readCurrentRun(repoRoot);
    const run = current?.runId === stamped.runId || !stamped.runId
      ? current
      : null;
    const next = applyEvent(
      run ?? baseRun({ runId: stamped.runId, provider: stamped.provider, mode: stamped.mode, at, atMs }),
      stamped,
    );
    writeJson(currentRunFile(repoRoot), next);
    return next;
  } catch {
    return null;
  }
}

export function runSucceeded(state) {
  if (state.mode === 'multi' && Array.isArray(state.subAgents)) {
    // Align the archived status with the run's goal/process gates. processOk already accounts
    // for resolved review blockers (reviewGateIsOpen), gate-subAgent health, runtime, and verify;
    // goalOk covers delivery. The old `subAgents.every(l.ok)` counted a review subAgent that FOUND a
    // blocker later fixed as a run failure — a green run archived as "failed". A genuine failure
    // (unresolved blocker, failed gate/verify/runtime) subAgents processOk or goalOk false.
    return (
      state.subAgents.length > 0
      && Boolean(state.processOk ?? state.ok)
      && state.goalOk !== false
    );
  }
  return Boolean(state.ok) && ['complete', 'partial'].includes(state.result?.status);
}

/** Compact repovine-native process block for summary.json v3. */
function loadOrientArtifact(repoRoot, runId) {
  if (!repoRoot || !runId) return null;
  for (const active of [true, false]) {
    try {
      const file = runLevelPath(repoRoot, runId, RUN_LEVEL.orient, { active });
      if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

export function buildRepovineProcessSummary(state = {}, repoRoot = null) {
  let trail = state.repovineOrientTrail;
  let claims = state.repovineClaims ?? [];
  const runId = state.task?.id;
  const root = repoRoot ?? state.repoRoot;
  if (root && runId && (!trail?.graphNodes?.length || !claims.length)) {
    const artifact = loadOrientArtifact(root, runId);
    if (artifact?.trail) {
      trail = trail ?? artifact.trail;
      claims = claims.length ? claims : (artifact.trail?.claims ?? []);
    }
  }
  const subAgents = state.subAgents ?? [];
  const orientSubAgent = subAgents.find((l) => l.instanceId === 'orient');
  const verifySubAgent = subAgents.find((l) => l.instanceId === 'verify');
  if (!trail && !orientSubAgent && !verifySubAgent && !claims.length) return null;

  return {
    enabled: true,
    orient: {
      ok: orientSubAgent?.ok ?? null,
      graphNodeCount: trail?.graphNodes?.length ?? 0,
      claimCount: claims.length,
      flowChecked: trail?.cliPreOrient?.flowChecked
        ?? orientSubAgent?.result?.compliance?.flowChecked
        ?? null,
      cliPreOrient: trail?.cliPreOrient ?? null,
    },
    claims: claims.map((c) => ({ id: c.id, text: c.text, status: c.status ?? 'pending' })),
    verify: verifySubAgent
      ? {
        ok: verifySubAgent.ok,
        summary: String(verifySubAgent.result?.summary ?? '').slice(0, 240),
      }
      : null,
    artifacts: {
      orient: runId ? RUN_LEVEL.orient : null,
      verify: verifySubAgent && runId ? RUN_LEVEL.verify : null,
    },
  };
}

export function finishRunTelemetry(repoRoot, state = {}) {
  if (!repoRoot || !state.task?.id) return null;
  try {
    const usage = state.usageRollup ?? (state.usage ? { total: state.usage } : null);
    const mcp = state.mcpRollup ?? (state.mcp ? { total: state.mcp } : null);
    const ok = runSucceeded(state);
    const summary = state.mode === 'multi'
      ? `${state.subAgents?.filter((l) => l.ok).length ?? 0}/${state.subAgents?.length ?? 0} sub-agents ok`
      : state.result?.summary;
    const run = recordRunEvent(repoRoot, {
      event: 'run_finished',
      runId: state.task.id,
      ok,
      status: ok ? 'complete' : 'failed',
      summary,
      usage,
      mcp,
    });
    if (!run) return null;
    const runId = state.task.id;
    const summaryFile = runLevelPath(repoRoot, runId, RUN_LEVEL.summary, { active: true });
    const metricsSummary = formatTelemetrySummary({
      ...run,
      usage: usage ?? run.usage,
      mcp: mcp ?? run.mcp,
      elapsedMs: run.elapsedMs,
    });
    const repovineProcess = buildRepovineProcessSummary(state, repoRoot);
    const withArtifacts = {
      schemaVersion: run.schemaVersion,
      runId: run.runId,
      provider: run.provider,
      mode: run.mode,
      targetMode: run.targetMode ?? null,
      workspace: run.workspace ?? null,
      status: run.status,
      ok: run.ok,
      phase: run.phase,
      ...(metricsSummary ? { metricsSummary } : {}),
      startedAt: run.startedAt,
      startedAtMs: run.startedAtMs,
      updatedAt: run.updatedAt,
      elapsedMs: run.elapsedMs,
      summary: run.summary,
      task: run.task,
      current: run.current,
      phases: run.phases,
      subAgents: run.subAgents,
      usage: run.usage,
      mcp: run.mcp,
      runtimeCheck: run.runtimeCheck,
      eventsCount: run.eventsCount,
      plan: run.plan,
      slowestSubAgent: run.slowestSubAgent,
      ...(repovineProcess ? { repovineProcess } : {}),
      // Gate signal block (multi mode): which gate decided processOk/goalOk/runSucceeded.
      ...(state.signals ? { signals: state.signals } : {}),
      artifacts: {
        activeDir: 'active/',
        runsDir: `runs/${runId}/`,
        current: `active/${CURRENT_RUN_FILE}`,
        events: `active/${EVENTS_FILE}`,
        summary: RUN_LEVEL.summary,
        ...(repovineProcess?.artifacts?.orient ? { orient: repovineProcess.artifacts.orient } : {}),
        ...(repovineProcess?.artifacts?.verify ? { verify: repovineProcess.artifacts.verify } : {}),
        ...(run.mcp?.total ? { runMcp: RUN_LEVEL.rollupMcp } : {}),
        ...(run.usage?.total || run.usage?.subAgents ? { runUsage: RUN_LEVEL.rollupUsage } : {}),
      },
    };
    writeJson(summaryFile, withArtifacts);
    writeJson(currentRunFile(repoRoot), withArtifacts);
    archiveActiveRun(repoRoot, runId, {
      status: run.status,
      ok: run.ok,
      summary: run.summary,
      metricsSummary,
      partial: false,
    });
    return withArtifacts;
  } catch {
    return null;
  }
}

function formatInt(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : null;
}

export function formatDurationMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return `${min}m${String(rem).padStart(2, '0')}s`;
  const hrs = Math.floor(min / 60);
  const m = min % 60;
  return `${hrs}h${String(m).padStart(2, '0')}m`;
}

export function formatUsageMetrics(usage) {
  const u = usage?.total ?? usage;
  if (!u) return '';
  const tokenParts = [];
  const input = formatInt(u.inputTokens);
  const output = formatInt(u.outputTokens);
  const cache = formatInt(u.cacheReadTokens);
  if (input !== null) tokenParts.push(`in ${input}`);
  if (output !== null) tokenParts.push(`out ${output}`);
  if (cache !== null) tokenParts.push(`cache ${cache}`);
  if (typeof u.cacheHitRatio === 'number') tokenParts.push(`hit ${Math.round(u.cacheHitRatio * 100)}%`);
  const cost = typeof u.costUsd === 'number' ? `$${u.costUsd.toFixed(4)}` : null;
  if (!tokenParts.length && !cost) return '';
  const body = tokenParts.length ? `tokens: ${tokenParts.join(' / ')}` : '';
  if (cost) return body ? `${body} / ${cost}` : cost;
  return body;
}

export function formatTelemetrySummary(run) {
  if (!run) return '';
  const parts = [];
  const elapsed = formatDurationMs(run.elapsedMs);
  if (elapsed) parts.push(elapsed);
  const usage = formatUsageMetrics(run.usage?.total ?? run.usage);
  if (usage) parts.push(usage);
  const fresh = formatUsageMetrics(run.usage?.freshTotal);
  if (fresh) parts.push(`fresh sub-agents ${fresh}`);
  const mcp = formatMcpMetrics(run.mcp);
  if (mcp) parts.push(mcp);
  if (run.slowestSubAgent?.subAgent && typeof run.slowestSubAgent.durationMs === 'number') {
    parts.push(`slowest sub-agent ${run.slowestSubAgent.subAgent} ${formatDurationMs(run.slowestSubAgent.durationMs)}`);
  }
  return parts.length ? `episode: ${parts.join(' · ')}` : '';
}

export function formatCurrentRunStatus(run) {
  if (!run) return '';
  const elapsed = formatDurationMs(
    run.status === 'running' && run.startedAtMs ? Math.max(0, nowMs() - run.startedAtMs) : run.elapsedMs,
  );
  const lines = [
    `${run.status === 'running' ? 'running' : 'last'}: ${run.runId}${elapsed ? ` (${elapsed})` : ''}`,
  ];
  if (run.current?.label) lines.push(`phase: ${run.current.label}`);
  else if (run.phase) lines.push(`phase: ${run.phase}`);
  const metrics = formatTelemetrySummary({
    ...run,
    elapsedMs: run.status === 'running' && run.startedAtMs ? Math.max(0, nowMs() - run.startedAtMs) : run.elapsedMs,
  });
  if (metrics) lines.push(metrics);
  if (run.runtimeCheck) {
    const rc = run.runtimeCheck.skipped ? 'skipped' : run.runtimeCheck.ok ? 'ok' : `failed exit ${run.runtimeCheck.exitCode ?? '?'}`;
    lines.push(`runtime_check: ${rc}`);
  }
  if (run.subAgents?.length) {
    const done = run.subAgents.filter((a) => a.ok).length;
    lines.push(`sub-agents: ${done}/${run.subAgents.length} ok`);
  }
  return lines.join('\n');
}

export function compactRunTelemetry(run) {
  if (!run) return null;
  return {
    runId: run.runId,
    status: run.status,
    phase: run.phase,
    current: run.current ?? null,
    provider: run.provider,
    mode: run.mode,
    targetMode: run.targetMode ?? null,
    elapsedMs: run.elapsedMs,
    usage: run.usage ?? null,
    mcp: run.mcp ?? null,
    runtimeCheck: run.runtimeCheck ?? null,
    slowestSubAgent: run.slowestSubAgent ?? null,
    subAgents: (run.subAgents ?? []).map((a) => ({
      subAgent: a.subAgent,
      role: a.role,
      status: a.status,
      ok: a.ok,
      attempts: a.attempts,
      durationMs: a.durationMs,
      usage: a.usage ?? null,
      mcp: a.mcp ?? null,
    })),
    repovineProcess: run.repovineProcess ?? null,
    artifacts: run.artifacts ?? { current: CURRENT_RUN_FILE, events: EVENTS_FILE },
  };
}
