/**
 * Deterministic repovine orient — search_context + trace_flow without an LLM.
 * Used by harness pre-orient and `repovine agents orient --query "..."`.
 */
import { loadConfig } from '../config.js';
import { RepovineRuntime } from '../mcp/context.js';
import { handleSearchContext } from '../mcp/tools/search-context.js';
import { handleTraceFlow } from '../mcp/tools/trace-flow.js';
import { firstResultId, topSearchResultIds } from '../mcp/scope/resolve.js';
import type { McpToolRuntime } from '../mcp/types.js';
import { setPipelineLogSink } from './ui.js';
import type { AgentsCliEnv } from './agents.js';

export type OrientReport = {
  query: string;
  ok: boolean;
  flowChecked: boolean;
  graphNodes: string[];
  traceScope: string;
  search: {
    summary: string;
    confidence: unknown;
    gaps: unknown;
    nodeCount: number;
    strategy?: unknown;
  };
  traceFlow: {
    summary: string;
    confidence: unknown;
    gaps: unknown;
    serviceCount: number;
    dataFlowCount: number;
    entrypointCount: number;
  };
  mcpTools: ['search_context', 'trace_flow'];
};

function buildToolCtx(ctx: RepovineRuntime, cfg: ReturnType<typeof loadConfig>, repoRoot: string): McpToolRuntime {
  return {
    getState: () => ctx.getState(),
    getConfig: () => cfg,
    refreshRepoState: async () => {
      await ctx.refresh();
    },
    repoRoot,
  };
}

function pickTraceScope(searchMatches: Record<string, unknown>, graphNodes: string[]): string {
  for (const id of graphNodes) {
    if (id.startsWith('mod:') || id.startsWith('pkg:')) {
      const tail = id.slice(id.indexOf(':') + 1);
      const slash = tail.indexOf('/');
      if (slash > 0) return tail.slice(0, slash);
      return tail;
    }
  }
  const first = firstResultId(searchMatches);
  if (first?.startsWith('mod:')) {
    const tail = first.slice(4);
    const slash = tail.indexOf('/');
    if (slash > 0) return tail.slice(0, slash);
  }
  if (first?.startsWith('pkg:')) return first.slice(4);
  return 'all';
}

function serviceIds(services: unknown): string[] {
  if (!Array.isArray(services)) return [];
  return services
    .map((s) => (s as { id?: string }).id)
    .filter((id): id is string => typeof id === 'string');
}

const PRIOR_RUN_MARKER = '## Prior harness run';

/** Strip harness prior-run preamble and trim overly long coordination blobs to the last paragraph. */
export function normalizeOrientQuery(raw: string): string {
  let t = String(raw ?? '').trim();
  if (!t) return t;
  const idx = t.indexOf(PRIOR_RUN_MARKER);
  if (idx >= 0) {
    const after = t.slice(idx + PRIOR_RUN_MARKER.length);
    const split = after.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    if (split.length >= 2) t = split[split.length - 1];
    else if (split.length === 1) t = split[0];
  }
  if (t.length > 800) {
    const paras = t.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    t = (paras[paras.length - 1] ?? t).slice(0, 800);
  }
  return t.trim();
}

/** Run search_context → trace_flow for a natural-language task query. */
export async function buildOrientReport(
  env: AgentsCliEnv,
  query: string,
  options?: { scope?: string },
): Promise<OrientReport> {
  setPipelineLogSink('stderr');
  const trimmed = String(query ?? '').trim();
  if (!trimmed) {
    return {
      query: '',
      ok: false,
      flowChecked: false,
      graphNodes: [],
      traceScope: 'all',
      search: { summary: 'query is required', confidence: 'low', gaps: ['query is required'], nodeCount: 0 },
      traceFlow: {
        summary: 'skipped — empty query',
        confidence: 'low',
        gaps: ['query is required'],
        serviceCount: 0,
        dataFlowCount: 0,
        entrypointCount: 0,
      },
      mcpTools: ['search_context', 'trace_flow'],
    };
  }

  const cfg = loadConfig(env.repoRoot);
  const ctx = await RepovineRuntime.create(env.repoRoot, env.artifactsDir, cfg);
  const toolCtx = buildToolCtx(ctx, cfg, env.repoRoot);

  const searchQuery = normalizeOrientQuery(trimmed);
  const searchEnv = await handleSearchContext(toolCtx, {
    query: searchQuery,
    // auto = AND across all tokens, then bounded OR when no single node matches every token. A
    // natural-language task query rarely lands all tokens on one node; strict 'and' returns zero
    // hits whenever token extraction is even slightly reduced (e.g. a lean CI build), so orient
    // degrades to OR instead of orienting to nothing.
    match: 'auto',
    limit: 8,
  });
  // Search hits nest under result.matches (topResults/strategy); topSearchResultIds/firstResultId
  // read that inner object — passing the outer result leaves graphNodes permanently empty.
  const searchResult = (searchEnv.result ?? {}) as Record<string, unknown>;
  const searchMatches = (searchResult.matches ?? {}) as Record<string, unknown>;
  const graphNodes = topSearchResultIds(searchMatches, 8);

  const traceScope = options?.scope ?? pickTraceScope(searchMatches, graphNodes);

  const traceEnv = await handleTraceFlow(toolCtx, {
    scope: traceScope,
    include: ['services', 'resources', 'flows', 'entrypoints'],
    limit: 12,
  });
  const traceResult = (traceEnv.result ?? {}) as Record<string, unknown>;
  const services = traceResult.services;
  const serviceNodeIds = serviceIds(services);
  const dataFlows = Array.isArray(traceResult.dataFlows) ? traceResult.dataFlows : [];
  const entrypoints = Array.isArray(traceResult.entrypoints) ? traceResult.entrypoints : [];
  const allNodes = [...new Set([...graphNodes, ...serviceNodeIds.slice(0, 5)])];

  return {
    query: searchQuery,
    ok: graphNodes.length > 0 || serviceNodeIds.length > 0 || dataFlows.length > 0,
    flowChecked: true,
    graphNodes: allNodes,
    traceScope,
    search: {
      summary: String(searchEnv.summary ?? ''),
      confidence: searchEnv.confidence,
      gaps: searchEnv.gaps,
      nodeCount: graphNodes.length,
      strategy: searchMatches.strategy,
    },
    traceFlow: {
      summary: String(traceEnv.summary ?? ''),
      confidence: traceEnv.confidence,
      gaps: traceEnv.gaps,
      serviceCount: serviceNodeIds.length,
      dataFlowCount: dataFlows.length,
      entrypointCount: entrypoints.length,
    },
    mcpTools: ['search_context', 'trace_flow'],
  };
}
