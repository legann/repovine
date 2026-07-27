import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { ContextSessionStore, DEFAULT_CONTEXT_QUALITY_CONFIG, calculateReport, bootstrapContextSessionsOnMcpStart } from '../../../src/context-quality/session-store.js';

function envelope(toolResult: Record<string, unknown>, confidence = 'high', kind = 'module', id = 'mod:pkg/src/file') {
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
        { id: 'export:pkg/a/Foo', label: 'Foo', type: 'export-symbol' },
        { id: 'export:pkg/a/Bar', label: 'Bar', type: 'export-symbol' },
        { id: 'export:pkg/a/Baz', label: 'Baz', type: 'export-symbol' },
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
      suggestedScopes: topResults.map(r => ({ scope: r.id })),
      totalResults: options.total ?? topResults.length,
      returned: topResults.length,
      truncated: (options.total ?? 0) > topResults.length,
    },
  }, 'medium', 'query', 'query:audit route');
}

describe('ContextSessionStore', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'context-quality-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('ships the inspect_node baseline while the 14-weight score is unvalidated', () => {
    expect(DEFAULT_CONTEXT_QUALITY_CONFIG.weights).toEqual({
      or: 0,
      cap: 0,
      volume: 0,
      low: 0,
      unresolved: 0,
      test: 0,
      bytes: 0,
      chain: 0,
      map: 0,
      inspect: 1,
      impact: 0,
      anchor: 0,
      recover: 0,
      end: 0,
    });

    const store = new ContextSessionStore({ repoRoot });
    const sessionId = 'sess-baseline';
    const result = envelope({ id: 'mod:prod/src/a' }, 'high', 'module', 'mod:prod/src/a');
    store.recordToolCall({
      sessionId,
      tool: 'inspect_node',
      args: { nodeId: 'mod:prod/src/a', contextSessionId: sessionId },
      result,
      responseText: JSON.stringify(result),
    });

    const report = store.getReport(sessionId);
    expect(report?.overall).toBe(1);
    expect(report?.structureBonus).toBe(1);
    expect(report?.noisePenalty).toBe(0);
  });

  it('rejects a noisy search-only session with deterministic followups', () => {
    const store = new ContextSessionStore({ repoRoot });
    const result = searchEnvelope({ used: 'or', relaxed: true, cap: true, total: 1000 });
    store.recordToolCall({
      sessionId: 'sess-noisy',
      tool: 'search_context',
      args: { query: 'audit route', contextSessionId: 'sess-noisy' },
      result,
      responseText: JSON.stringify(result),
    });

    const report = store.getReport('sess-noisy');
    expect(report?.acceptHandoff).toBe(false);
    expect(report?.rejectReasons).toEqual(expect.arrayContaining([
      'OR_WITHOUT_RECOVERY',
      'NO_STABLE_ANCHORS',
      'ENDED_ON_SEARCH',
    ]));
    expect(report?.aggregates.capabilityDominantSearchCount).toBe(1);
    expect(report?.requestEchoes[0].request).toEqual({ query: 'audit route' });
  });

  it('does not reject a strong session on an unrecovered OR search alone (quality-gated)', () => {
    // recoveryWindow: 0 makes the OR search unrecoverable by construction; the funnel
    // that follows still produces a strong overall score. The unconditional variant of
    // OR_WITHOUT_RECOVERY rejected sessions scoring above both thresholds.
    const store = new ContextSessionStore({
      repoRoot,
      config: { ...DEFAULT_CONTEXT_QUALITY_CONFIG, recoveryWindow: 0 },
    });
    const sessionId = 'sess-strong-or';
    const calls = [
      { tool: 'search_context', args: { query: 'audit route', contextSessionId: sessionId }, result: searchEnvelope({ used: 'or', relaxed: true, cap: false, total: 20 }) },
      { tool: 'map_context', args: { scope: 'pkg:prod', contextSessionId: sessionId }, result: envelope({ focus: { id: 'pkg:prod' } }, 'high', 'package', 'pkg:prod') },
      { tool: 'inspect_node', args: { nodeId: 'mod:prod/src/a', contextSessionId: sessionId }, result: envelope({ id: 'mod:prod/src/a' }, 'high', 'module', 'mod:prod/src/a') },
      { tool: 'inspect_node', args: { nodeId: 'mod:prod/src/b', contextSessionId: sessionId }, result: envelope({ id: 'mod:prod/src/b' }, 'high', 'module', 'mod:prod/src/b') },
      { tool: 'analyze_dependencies', args: { scope: 'mod:prod/src/a', mode: 'impact', contextSessionId: sessionId }, result: envelope({ mode: 'impact', analysis: { upstream: [], downstream: [] } }, 'high', 'module', 'mod:prod/src/a') },
    ];
    for (const call of calls) {
      store.recordToolCall({
        sessionId,
        tool: call.tool,
        args: call.args,
        result: call.result,
        responseText: JSON.stringify(call.result),
      });
    }

    const report = store.getReport(sessionId);
    expect(report?.aggregates.unrecoveredOrSearchCount).toBeGreaterThan(0);
    expect(report?.rejectReasons).not.toContain('OR_WITHOUT_RECOVERY');
    expect(report?.acceptHandoff).toBe(true);
  });

  it('does not count service-tool responses as unresolved-scope noise (compliance followups must not poison the retry)', () => {
    const store = new ContextSessionStore({ repoRoot });
    const sessionId = 'sess-service-tools';
    const funnel = [
      { tool: 'map_context', args: { scope: 'pkg:prod', contextSessionId: sessionId }, result: envelope({ focus: { id: 'pkg:prod' } }, 'high', 'package', 'pkg:prod') },
      { tool: 'inspect_node', args: { nodeId: 'mod:prod/src/a', contextSessionId: sessionId }, result: envelope({ id: 'mod:prod/src/a' }, 'high', 'module', 'mod:prod/src/a') },
      { tool: 'analyze_dependencies', args: { scope: 'mod:prod/src/a', mode: 'impact', contextSessionId: sessionId }, result: envelope({ mode: 'impact', analysis: { upstream: [], downstream: [] } }, 'high', 'module', 'mod:prod/src/a') },
    ];
    for (const call of funnel) {
      store.recordToolCall({ sessionId, tool: call.tool, args: call.args, result: call.result, responseText: JSON.stringify(call.result) });
    }
    const clean = store.getReport(sessionId);

    // What a rejected handoff's followups require the agent to run: a
    // string-scope validate (envelope kind:'unknown' by construction), a failed
    // write_annotation, and a status check. None of it is navigation.
    const serviceCalls = [
      { tool: 'validate_annotations', args: { scope: 'packages/prod', contextSessionId: sessionId }, result: envelope({ validation: { status: 'clean' } }, 'high', 'unknown', 'packages/prod') },
      { tool: 'write_annotation', args: { nodeId: 'mod:prod/src/a', contextSessionId: sessionId }, result: { error: 'Invalid annotation: expected record, received array' } },
      { tool: 'get_annotation_status', args: { view: 'queue', contextSessionId: sessionId }, result: envelope({ queue: [] }, 'medium', 'unknown', 'packages/prod') },
    ];
    for (const call of serviceCalls) {
      store.recordToolCall({ sessionId, tool: call.tool, args: call.args, result: call.result, responseText: JSON.stringify(call.result) });
    }

    const after = store.getReport(sessionId);
    expect(after?.aggregates.unresolvedScopeCount).toBe(clean?.aggregates.unresolvedScopeCount);
    expect(after?.rejectReasons).not.toContain('UNRESOLVED_SCOPE');
  });

  it('still counts unresolved scopes from navigation tools', () => {
    const store = new ContextSessionStore({ repoRoot });
    const sessionId = 'sess-nav-unresolved';
    const bad = envelope({ id: 'pkg:nope' }, 'low', 'unknown', 'pkg:nope');
    store.recordToolCall({ sessionId, tool: 'inspect_node', args: { nodeId: 'pkg:nope', contextSessionId: sessionId }, result: bad, responseText: JSON.stringify(bad) });
    expect(store.getReport(sessionId)?.aggregates.unresolvedScopeCount).toBe(1);
  });

  it('does not count a filter that emptied a resolved scope as an unresolved scope', () => {
    // The scope anchored and held rows; the caller's own narrowing removed them. Scoring that as a
    // navigation miss reads a working filter as a failure to find the scope.
    const store = new ContextSessionStore({ repoRoot });
    const sessionId = 'sess-nav-filtered';
    const filtered = envelope({
      total: 0,
      emptyDiagnostic: {
        reason: 'filtered_out',
        message: '4 entrypoint(s) exist in pkg:prod, but the requested kind removed all of them.',
        confidence: 'high',
        nextActions: [],
        details: { narrowings: [{ by: 'kind', value: 'queue-consumer', before: 4, after: 0 }] },
      },
    }, 'low', 'package', 'pkg:prod');
    store.recordToolCall({ sessionId, tool: 'get_entrypoints', args: { scope: 'pkg:prod', kind: 'queue-consumer', contextSessionId: sessionId }, result: filtered, responseText: JSON.stringify(filtered) });
    expect(store.getReport(sessionId)?.aggregates.unresolvedScopeCount).toBe(0);
  });

  it('discounts recovered OR searches and persists sessions to disk', () => {
    const store = new ContextSessionStore({ repoRoot });
    const sessionId = 'sess-clean';
    const calls = [
      { tool: 'search_context', args: { query: 'audit route', contextSessionId: sessionId }, result: searchEnvelope({ used: 'or', relaxed: true, cap: true, total: 50 }) },
      { tool: 'map_context', args: { scope: 'pkg:prod', contextSessionId: sessionId }, result: envelope({ focus: { id: 'pkg:prod' } }, 'high', 'package', 'pkg:prod') },
      { tool: 'inspect_node', args: { nodeId: 'mod:prod/src/a', contextSessionId: sessionId }, result: envelope({ id: 'mod:prod/src/a' }, 'high', 'module', 'mod:prod/src/a') },
      { tool: 'analyze_dependencies', args: { scope: 'mod:prod/src/a', mode: 'impact', contextSessionId: sessionId }, result: envelope({ mode: 'impact', analysis: { upstream: [], downstream: [] } }, 'high', 'module', 'mod:prod/src/a') },
    ];
    for (const call of calls) {
      store.recordToolCall({
        sessionId,
        tool: call.tool,
        args: call.args,
        result: call.result,
        responseText: JSON.stringify(call.result),
      });
    }

    const report = store.getReport(sessionId);
    expect(report?.acceptHandoff).toBe(true);
    expect(report?.aggregates.recoveredFromNoise).toBe(true);
    expect(report?.aggregates.stableAnchors).toEqual(expect.arrayContaining(['pkg:prod', 'mod:prod/src/a']));

    const file = path.join(repoRoot, '.repovine', '.cache', 'sessions', `${sessionId}.json`);
    const stored = JSON.parse(fs.readFileSync(file, 'utf-8')) as { events?: unknown[]; aggregates?: { toolCallCount: number }; requestEchoes?: unknown[] };
    expect(stored.events).toEqual([]);
    expect(stored.aggregates?.toolCallCount).toBe(4);
    expect(stored.requestEchoes).toHaveLength(4);

    const reloaded = new ContextSessionStore({ repoRoot });
    expect(reloaded.getReport(sessionId)?.aggregates.toolCallCount).toBe(4);
    expect(reloaded.getReport(sessionId, { includeEvents: true })?.events).toBeUndefined();
  });

  it('consumes sessions after reporting unless retained for debug', () => {
    const store = new ContextSessionStore({ repoRoot });
    const sessionId = 'sess-consume';
    const result = envelope({ focus: { id: 'pkg:prod' } }, 'high', 'package', 'pkg:prod');
    store.recordToolCall({
      sessionId,
      tool: 'map_context',
      args: { scope: 'pkg:prod', contextSessionId: sessionId },
      result,
      responseText: JSON.stringify(result),
    });
    const file = path.join(repoRoot, '.repovine', '.cache', 'sessions', `${sessionId}.json`);
    expect(fs.existsSync(file)).toBe(true);

    expect(store.getReport(sessionId, { consume: true })?.sessionId).toBe(sessionId);
    expect(fs.existsSync(file)).toBe(false);
    expect(store.getReport(sessionId)).toBeUndefined();

    const retained = new ContextSessionStore({
      repoRoot,
      config: { ...DEFAULT_CONTEXT_QUALITY_CONFIG, retainSessions: true },
    });
    retained.recordToolCall({
      sessionId: 'sess-retained',
      tool: 'map_context',
      args: { scope: 'pkg:prod', contextSessionId: 'sess-retained' },
      result,
      responseText: JSON.stringify(result),
    });
    const retainedFile = path.join(repoRoot, '.repovine', '.cache', 'sessions', 'sess-retained.json');
    retained.getReport('sess-retained', { consume: true });
    expect(fs.existsSync(retainedFile)).toBe(true);
  });

  it('flags belowWarningThreshold when score is above hard threshold but under soft bar', () => {
    const store = new ContextSessionStore({
      repoRoot,
      config: {
        ...DEFAULT_CONTEXT_QUALITY_CONFIG,
        weights: { ...DEFAULT_CONTEXT_QUALITY_CONFIG.weights, inspect: 0.5 },
      },
    });
    const sessionId = 'sess-soft-warn';
    const calls = [
      { tool: 'search_context', args: { query: 'audit route', contextSessionId: sessionId }, result: searchEnvelope({ used: 'or', relaxed: true, cap: true, total: 50 }) },
      { tool: 'map_context', args: { scope: 'pkg:prod', contextSessionId: sessionId }, result: envelope({ focus: { id: 'pkg:prod' } }, 'high', 'package', 'pkg:prod') },
      { tool: 'inspect_node', args: { nodeId: 'mod:prod/src/a', contextSessionId: sessionId }, result: envelope({ id: 'mod:prod/src/a' }, 'high', 'module', 'mod:prod/src/a') },
    ];
    for (const call of calls) {
      store.recordToolCall({
        sessionId,
        tool: call.tool,
        args: call.args,
        result: call.result,
        responseText: JSON.stringify(call.result),
      });
    }
    const report = store.getReport(sessionId, {
      policy: { phase: 'explore', qualityThreshold: 0.2, warningThreshold: 0.99 },
    });
    expect(report?.acceptHandoff).toBe(true);
    expect(report?.belowWarningThreshold).toBe(true);
    expect(report?.warnings.join(' ')).toMatch(/below warningThreshold/);
    expect(report?.requiredFollowups).toEqual(expect.arrayContaining([
      'Repeat the context funnel: search_context(types:["package","module"]) → map_context → inspect_node / analyze_dependencies.',
    ]));
  });

  it('resolveContextSessionPolicy prefers assignment overrides over config defaults', () => {
    const session = {
      sessionId: 'sess-policy',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      events: [],
      aggregates: {
        toolCallCount: 0,
        searchCallCount: 0,
        mapCallCount: 0,
        inspectCallCount: 0,
        totalResponseBytes: 0,
        maxSingleResponseBytes: 0,
        maxArchitectureResponseBytes: 0,
        maxTotalResultsInSearch: 0,
        orSearchCount: 0,
        recoveredOrSearchCount: 0,
        unrecoveredOrSearchCount: 0,
        lowConfidenceCount: 0,
        unresolvedScopeCount: 0,
        capabilityDominantSearchCount: 0,
        avgCapRatio: 0,
        testPackageHitCount: 0,
        stableAnchors: [],
        recoveredFromNoise: false,
        hadImpactOnModule: false,
        endedWithSearchOnly: false,
      },
    };
    const report = calculateReport(session, DEFAULT_CONTEXT_QUALITY_CONFIG, {
      mode: 'harness',
      warningThreshold: 0.8,
      phase: 'implement',
    });
    expect(report.policy.mode).toBe('harness');
    expect(report.policy.warningThreshold).toBe(0.8);
    expect(report.policy.qualityThreshold).toBe(0.55);
  });

  it('purges all persisted sessions', () => {
    const store = new ContextSessionStore({ repoRoot });
    const sessionId = 'sess-purge';
    store.recordToolCall({
      sessionId,
      tool: 'map_context',
      args: { scope: 'pkg:prod', contextSessionId: sessionId },
      result: envelope({ focus: { id: 'pkg:prod' } }, 'high', 'package', 'pkg:prod'),
      responseText: '{}',
    });
    const file = path.join(repoRoot, '.repovine', '.cache', 'sessions', `${sessionId}.json`);
    expect(fs.existsSync(file)).toBe(true);
    expect(store.purgeAllSessions()).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
    expect(store.getReport(sessionId)).toBeUndefined();
  });

  it('bootstraps client MCP with startup purge unless retainSessions is enabled', () => {
    const store = new ContextSessionStore({ repoRoot });
    store.recordToolCall({
      sessionId: 'sess-boot',
      tool: 'map_context',
      args: { scope: 'pkg:prod', contextSessionId: 'sess-boot' },
      result: envelope({ focus: { id: 'pkg:prod' } }, 'high', 'package', 'pkg:prod'),
      responseText: '{}',
    });
    const clientBoot = bootstrapContextSessionsOnMcpStart(store, DEFAULT_CONTEXT_QUALITY_CONFIG);
    expect(clientBoot.skipped).toBe(false);
    expect(clientBoot.purged).toBe(1);

    store.recordToolCall({
      sessionId: 'sess-harness',
      tool: 'map_context',
      args: { scope: 'pkg:prod', contextSessionId: 'sess-harness' },
      result: envelope({ focus: { id: 'pkg:prod' } }, 'high', 'package', 'pkg:prod'),
      responseText: '{}',
    });
    const harnessBoot = bootstrapContextSessionsOnMcpStart(store, {
      ...DEFAULT_CONTEXT_QUALITY_CONFIG,
      enforcement: { mode: 'harness' },
      purgeSessionsOnMcpStart: false,
    });
    expect(harnessBoot.skipped).toBe(true);
    expect(harnessBoot.reason).toBe('purgeSessionsOnMcpStart=false');
    expect(store.getReport('sess-harness')).toBeDefined();
  });

  it('retains sessions across bootstrap when retainSessions is enabled', () => {
    const store = new ContextSessionStore({
      repoRoot,
      config: { ...DEFAULT_CONTEXT_QUALITY_CONFIG, retainSessions: true },
    });
    store.recordToolCall({
      sessionId: 'sess-retain-boot',
      tool: 'map_context',
      args: { scope: 'pkg:prod', contextSessionId: 'sess-retain-boot' },
      result: envelope({ focus: { id: 'pkg:prod' } }, 'high', 'package', 'pkg:prod'),
      responseText: '{}',
    });
    const file = path.join(repoRoot, '.repovine', '.cache', 'sessions', 'sess-retain-boot.json');
    expect(fs.existsSync(file)).toBe(true);

    // retainSessions=true wins even though purgeSessionsOnMcpStart defaults to true.
    const boot = bootstrapContextSessionsOnMcpStart(store, {
      ...DEFAULT_CONTEXT_QUALITY_CONFIG,
      retainSessions: true,
    });
    expect(boot.skipped).toBe(true);
    expect(boot.reason).toBe('retainSessions=true');
    expect(boot.purged).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
    expect(store.getReport('sess-retain-boot')).toBeDefined();
  });
});
