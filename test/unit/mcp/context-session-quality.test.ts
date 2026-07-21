import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { ContextSessionStore } from '../../../src/context-quality/session-store.js';
import { handleGetContextSessionQuality } from '../../../src/mcp/tools/context-session-quality.js';
import type { ContextQualityReport } from '../../../src/context-quality/types.js';
import type { McpToolRuntime } from '../../../src/mcp/types.js';
import type { RepositoryGraph, RepositoryFactsSnapshot } from '../../../src/types.js';
import type { AnnotationStore } from '../../../src/annotations/store.js';

function fakeCtx(
  repoRoot: string,
  contextQualityReport?: unknown,
  consumed?: string[],
): McpToolRuntime {
  const graph = { nodes: new Map() } as unknown as RepositoryGraph;
  const annotations = {
    get: () => undefined,
    getAll: () => ({}),
    detectOrphaned: () => ({ total: 0, orphaned: [], byType: {} }),
    getQueue: () => [],
  } as unknown as AnnotationStore;
  return {
    repoRoot,
    refreshRepoState: () => undefined,
    getState: () => ({ graph, snapshot: {} as unknown as RepositoryFactsSnapshot, annotations }),
    ...(contextQualityReport
      ? {
          contextQualityStore: {
            getReport: (id: string, options?: { consume?: boolean; retain?: boolean }) => {
              if (options?.consume === true && options.retain !== true) consumed?.push(id);
              return contextQualityReport;
            },
            consumeSession: (id: string) => {
              consumed?.push(id);
              return true;
            },
          },
        }
      : {}),
  } as unknown as McpToolRuntime;
}

function ctxWithStore(repoRoot: string, store: ContextSessionStore): McpToolRuntime {
  return {
    ...fakeCtx(repoRoot),
    contextQualityStore: store,
  } as unknown as McpToolRuntime;
}

function envelope(
  toolResult: Record<string, unknown>,
  confidence = 'high',
  kind = 'module',
  id = 'mod:prod/src/a',
) {
  return {
    scope: id,
    resolvedScope: { kind, id },
    summary: 'ok',
    confidence,
    result: toolResult,
    gaps: [],
    navigation: {},
  };
}

function searchEnvelope(options: { used?: 'and' | 'or'; relaxed?: boolean; cap?: boolean; total?: number }) {
  const topResults = options.cap
    ? [
        { id: 'export:prod/a/Foo', label: 'Foo', type: 'export-symbol' },
        { id: 'export:prod/a/Bar', label: 'Bar', type: 'export-symbol' },
        { id: 'export:prod/a/Baz', label: 'Baz', type: 'export-symbol' },
      ]
    : [
        { id: 'pkg:prod', label: 'prod', type: 'package' },
        { id: 'mod:prod/src/a', label: 'src/a', type: 'module' },
      ];
  return envelope({
    matches: {
      strategy: {
        requested: 'auto',
        used: options.used ?? 'and',
        ...(options.relaxed ? { relaxedFrom: 'and' } : {}),
      },
      topResults,
      suggestedScopes: topResults.map(result => ({ scope: result.id })),
      totalResults: options.total ?? topResults.length,
      returned: topResults.length,
      truncated: (options.total ?? 0) > topResults.length,
    },
  }, 'medium', 'query', 'query:audit route');
}

function recordToolCall(
  store: ContextSessionStore,
  sessionId: string,
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
): void {
  store.recordToolCall({
    sessionId,
    tool,
    args: { ...args, contextSessionId: sessionId },
    result,
    responseText: JSON.stringify(result),
  });
}

describe('get_context_session_quality handler', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-quality-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('reads the store report', () => {
    const report = { sessionId: 'sess-1', acceptHandoff: true, overall: 0.8 };
    const out = handleGetContextSessionQuality(fakeCtx(repoRoot, report), {
      sessionId: 'sess-1',
    }) as { sessionId: string; acceptHandoff: boolean };
    expect(out.sessionId).toBe('sess-1');
    expect(out.acceptHandoff).toBe(true);
  });

  it('can consume the session when asked', () => {
    const report = { sessionId: 'sess-1', acceptHandoff: true, overall: 0.8 };
    const consumed: string[] = [];
    handleGetContextSessionQuality(fakeCtx(repoRoot, report, consumed), {
      sessionId: 'sess-1',
      consume: true,
    });
    expect(consumed).toEqual(['sess-1']);
  });

  it('surfaces required funnel violations with reject reasons and followups', () => {
    const store = new ContextSessionStore({ repoRoot });
    recordToolCall(
      store,
      'sess-noisy',
      'search_context',
      { query: 'audit route' },
      searchEnvelope({ used: 'or', relaxed: true, cap: true, total: 1000 }),
    );

    const out = handleGetContextSessionQuality(ctxWithStore(repoRoot, store), {
      sessionId: 'sess-noisy',
      mode: 'harness',
      qualityThreshold: 0.55,
    }) as ContextQualityReport;

    expect(out.acceptHandoff).toBe(false);
    expect(out.rejectReasons).toEqual(expect.arrayContaining([
      'OR_WITHOUT_RECOVERY',
      'NO_STABLE_ANCHORS',
      'ENDED_ON_SEARCH',
    ]));
    expect(out.requiredFollowups).toEqual(expect.arrayContaining([
      'Repeat search_context with types:["package","module"] or match:"and", then map_context a suggested package/module scope.',
      'Establish at least the required number of stable anchors with high-confidence map_context or inspect_node calls.',
      'Do not end handoff on search_context; inspect_node or analyze_dependencies the selected anchor.',
    ]));
    expect(out.policy.mode).toBe('harness');
  });

  it('distinguishes hard qualityThreshold failures from soft warningThreshold followups', () => {
    const store = new ContextSessionStore({ repoRoot });
    const sessionId = 'sess-soft-warn';
    recordToolCall(
      store,
      sessionId,
      'search_context',
      { query: 'audit route' },
      searchEnvelope({ used: 'or', relaxed: true, cap: true, total: 50 }),
    );
    recordToolCall(
      store,
      sessionId,
      'map_context',
      { scope: 'pkg:prod' },
      envelope({ focus: { id: 'pkg:prod' } }, 'high', 'package', 'pkg:prod'),
    );
    recordToolCall(
      store,
      sessionId,
      'inspect_node',
      { nodeId: 'mod:prod/src/a' },
      envelope({ id: 'mod:prod/src/a' }, 'high', 'module', 'mod:prod/src/a'),
    );

    const softOut = handleGetContextSessionQuality(ctxWithStore(repoRoot, store), {
      sessionId,
      qualityThreshold: 0.2,
      warningThreshold: 0.99,
    }) as ContextQualityReport;
    expect(softOut.acceptHandoff).toBe(true);
    expect(softOut.belowWarningThreshold).toBe(true);
    expect(softOut.warnings.join(' ')).toMatch(/below warningThreshold/);
    expect(softOut.requiredFollowups).toEqual(expect.arrayContaining([
      'Repeat the context funnel: search_context(types:["package","module"]) → map_context → inspect_node / analyze_dependencies.',
    ]));

    const hardOut = handleGetContextSessionQuality(ctxWithStore(repoRoot, store), {
      sessionId,
      qualityThreshold: 0.99,
      warningThreshold: 0.99,
    }) as ContextQualityReport;
    expect(hardOut.acceptHandoff).toBe(false);
    expect(hardOut.rejectReasons).toContain('QUALITY_BELOW_THRESHOLD');
  });

  it('keeps refresh_context sessions reportable until consume marks them stale', () => {
    const store = new ContextSessionStore({ repoRoot });
    const sessionId = 'sess-refresh';
    recordToolCall(
      store,
      sessionId,
      'refresh_context',
      {},
      envelope({ refresh: { status: 'rebuilt' } }, 'high', 'all', 'all'),
    );

    const reportable = handleGetContextSessionQuality(ctxWithStore(repoRoot, store), {
      sessionId,
      includeEvents: true,
    }) as ContextQualityReport;
    expect(reportable.aggregates.toolCallCount).toBe(1);
    expect(reportable.events?.[0]?.tool).toBe('refresh_context');

    const consumed = handleGetContextSessionQuality(ctxWithStore(repoRoot, store), {
      sessionId,
      consume: true,
    }) as ContextQualityReport;
    expect(consumed.sessionId).toBe(sessionId);

    const stale = handleGetContextSessionQuality(ctxWithStore(repoRoot, store), {
      sessionId,
    }) as { error: string; sessionId: string };
    expect(stale).toEqual({
      error: `Context session not found: ${sessionId}`,
      sessionId,
    });
  });
});
