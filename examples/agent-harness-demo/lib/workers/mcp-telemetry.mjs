// repovine MCP tool-call metrics for harness telemetry — normalized like usage.mjs.
//
// Source of truth: ContextSessionStore (`.repovine/.cache/sessions/<id>.json`) populated
// when workers pass REPOVINE_CONTEXT_SESSION_ID. Prefer `report.contextQuality` from
// compliance (already loaded in-memory); fall back to reading the session file.
import fs from 'node:fs';
import path from 'node:path';

const SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export function byToolFromEchoes(echoes = []) {
  const byTool = {};
  for (const e of echoes) {
    if (!e?.tool) continue;
    byTool[e.tool] = (byTool[e.tool] ?? 0) + 1;
  }
  return byTool;
}

export function mcpMetricsFromEchoes(echoes = []) {
  if (!Array.isArray(echoes) || echoes.length === 0) return null;
  const byTool = byToolFromEchoes(echoes);
  const totalResponseBytes = echoes.reduce(
    (n, e) => n + (typeof e.responseBytes === 'number' ? e.responseBytes : 0),
    0,
  );
  return {
    toolCallCount: echoes.length,
    totalResponseBytes,
    byTool,
  };
}

/** Build metrics from a compliance `contextQuality` report (preferred). */
export function mcpMetricsFromContextQuality(contextQuality) {
  if (!contextQuality) return null;
  const sessionId = typeof contextQuality.sessionId === 'string' ? contextQuality.sessionId : undefined;
  if (Array.isArray(contextQuality.requestEchoes) && contextQuality.requestEchoes.length > 0) {
    const base = mcpMetricsFromEchoes(contextQuality.requestEchoes);
    if (!base) return null;
    return {
      ...base,
      ...(sessionId ? { contextSessionId: sessionId } : {}),
      ...(typeof contextQuality.overall === 'number' ? { overall: contextQuality.overall } : {}),
    };
  }
  const agg = contextQuality.aggregates;
  if (!agg || typeof agg.toolCallCount !== 'number' || agg.toolCallCount <= 0) return null;
  return {
    toolCallCount: agg.toolCallCount,
    totalResponseBytes: typeof agg.totalResponseBytes === 'number' ? agg.totalResponseBytes : null,
    searchCallCount: agg.searchCallCount,
    mapCallCount: agg.mapCallCount,
    inspectCallCount: agg.inspectCallCount,
    byTool: null,
    ...(sessionId ? { contextSessionId: sessionId } : {}),
    ...(typeof contextQuality.overall === 'number' ? { overall: contextQuality.overall } : {}),
  };
}

function sessionCacheFile(repoRoot, sessionId) {
  const trimmed = String(sessionId ?? '').trim();
  if (!SESSION_ID_RE.test(trimmed)) return null;
  return path.join(repoRoot, '.repovine', '.cache', 'sessions', `${trimmed}.json`);
}

/** Read persisted session JSON when compliance did not return contextQuality. */
export function mcpMetricsFromSessionFile(repoRoot, sessionId) {
  const file = sessionCacheFile(repoRoot, sessionId);
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const echoes = Array.isArray(parsed.requestEchoes)
      ? parsed.requestEchoes
      : (Array.isArray(parsed.events) ? parsed.events : []);
    const base = mcpMetricsFromEchoes(echoes);
    if (!base) return null;
    return { ...base, contextSessionId: parsed.sessionId ?? sessionId };
  } catch {
    return null;
  }
}

/** Resolve MCP metrics from compliance report and/or session file. */
export function resolveMcpMetrics({ contextQuality, repoRoot, contextSessionId } = {}) {
  const fromReport = mcpMetricsFromContextQuality(contextQuality);
  if (fromReport) return fromReport;
  if (repoRoot && contextSessionId) return mcpMetricsFromSessionFile(repoRoot, contextSessionId);
  return null;
}

/** Snapshot repovine MCP metrics from the on-disk session store (call before compliance consumes it). */
export function snapshotMcpSession(repoRoot, contextSessionId) {
  if (!repoRoot || !contextSessionId) return null;
  return mcpMetricsFromSessionFile(repoRoot, contextSessionId);
}

/** Sum per-sub-agent MCP rows into a run total (merges byTool maps). */
export function totalMcpMetrics(records = []) {
  const present = records.filter(Boolean);
  if (!present.length) return null;
  const byTool = {};
  let toolCallCount = 0;
  let totalResponseBytes = 0;
  let hasBytes = false;
  for (const r of present) {
    toolCallCount += r.toolCallCount ?? 0;
    if (typeof r.totalResponseBytes === 'number') {
      totalResponseBytes += r.totalResponseBytes;
      hasBytes = true;
    }
    if (r.byTool && typeof r.byTool === 'object') {
      for (const [tool, count] of Object.entries(r.byTool)) {
        byTool[tool] = (byTool[tool] ?? 0) + count;
      }
    }
  }
  if (toolCallCount <= 0) return null;
  return {
    toolCallCount,
    ...(hasBytes ? { totalResponseBytes } : {}),
    ...(Object.keys(byTool).length ? { byTool } : {}),
  };
}

/**
 * Roll a run's sub-agents into one MCP record + per-sub-agent breakdown. Pure — caller
 * writes `.harness/<run>.run.mcp.json` (mirrors buildRunUsage).
 */
export function buildRunMcp(runId, rowsInput = []) {
  const rows = (rowsInput || []).map((r) => ({
    subAgent: r.subAgent ?? r.role ?? null,
    role: r.role ?? null,
    contextSessionId: r.contextSessionId ?? r.mcp?.contextSessionId ?? null,
    ok: Boolean(r.ok),
    mcp: r.mcp ?? null,
  }));
  return {
    run: runId ?? null,
    subAgentCount: rows.length,
    total: totalMcpMetrics(rows.map((r) => r.mcp)),
    subAgents: rows,
  };
}

/** One-line MCP summary for Telegram/CLI reply (top tools by count). */
export function formatMcpMetrics(mcp, { maxTools = 6 } = {}) {
  const m = mcp?.total ?? mcp;
  if (!m?.toolCallCount) return '';
  const parts = [`${m.toolCallCount} calls`];
  if (m.byTool && typeof m.byTool === 'object') {
    const top = Object.entries(m.byTool)
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxTools)
      .map(([tool, count]) => `${tool}×${count}`);
    if (top.length) parts.push(top.join(' '));
  }
  return `mcp: ${parts.join(' · ')}`;
}
