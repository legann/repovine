import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ContextSessionStore, DEFAULT_CONTEXT_QUALITY_CONFIG } from '../../../src/context-quality/session-store.js';
import type { ContextPhase, ContextQualityReport } from '../../../src/context-quality/types.js';
import { SHARED_SKILLS } from '../../../src/cli/onboarding-assets.js';
import { AGENTS_MD } from '../../../src/cli/templates.js';

type ResponseFormat = 'concise' | 'debug';

function envelope(
  format: ResponseFormat,
  result: Record<string, unknown>,
  kind: 'query' | 'package' | 'module' | 'all',
  id: string,
): Record<string, unknown> {
  return {
    scope: id,
    resolvedScope: { kind, id },
    summary: 'ok',
    confidence: kind === 'query' ? 'medium' : 'high',
    result,
    gaps: [],
    navigation: {},
    ...(format === 'debug'
      ? {
          debug: {
            detector: 'context-quality-determinism',
            trace: ['same semantic response', 'extra client detail'],
          },
        }
      : {}),
  };
}

function workflowCalls(
  format: ResponseFormat,
  graphScale: number,
  sessionId: string,
): Array<{ tool: string; args: Record<string, unknown>; result: Record<string, unknown> }> {
  return [
    {
      tool: 'search_context',
      args: { query: 'authorization route', types: ['package', 'module'], responseFormat: format },
      result: envelope(format, {
        matches: {
          strategy: { requested: 'and', used: 'and' },
          topResults: [{ id: 'mod:prod/src/auth', label: 'src/auth', type: 'module' }],
          suggestedScopes: [{ scope: 'mod:prod/src/auth' }],
          totalResults: graphScale,
          returned: 1,
          truncated: graphScale > 1,
        },
      }, 'query', 'query:authorization route'),
    },
    {
      tool: 'map_context',
      args: { scope: 'pkg:prod', responseFormat: format },
      result: envelope(format, { focus: { id: 'pkg:prod' } }, 'package', 'pkg:prod'),
    },
    {
      tool: 'inspect_node',
      args: { nodeId: 'mod:prod/src/auth', responseFormat: format },
      result: envelope(format, { id: 'mod:prod/src/auth' }, 'module', 'mod:prod/src/auth'),
    },
  ].map(call => ({
    ...call,
    args: { ...call.args, contextSessionId: sessionId },
  }));
}

function recordWorkflow(
  store: ContextSessionStore,
  sessionId: string,
  format: ResponseFormat,
  graphScale: number,
): void {
  for (const call of workflowCalls(format, graphScale, sessionId)) {
    store.recordToolCall({
      sessionId,
      tool: call.tool,
      args: call.args,
      result: call.result,
      responseText: JSON.stringify(call.result),
    });
  }
}

function verdict(report: ContextQualityReport | undefined): Record<string, unknown> {
  expect(report).toBeDefined();
  return {
    overall: report!.overall,
    structureBonus: report!.structureBonus,
    noisePenalty: report!.noisePenalty,
    acceptHandoff: report!.acceptHandoff,
    rejectReasons: report!.rejectReasons,
    belowWarningThreshold: report!.belowWarningThreshold,
  };
}

describe('context-quality replay determinism and documented workflow', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'context-quality-replay-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('keeps one semantic replay invariant across process reload, response format, and post-edit refresh', () => {
    const conciseRoot = path.join(repoRoot, 'concise');
    const concise = new ContextSessionStore({ repoRoot: conciseRoot });
    recordWorkflow(concise, 'sess-replay', 'concise', 11_758);
    const fresh = verdict(concise.getReport('sess-replay', { policy: { phase: 'implement' } }));

    const reloaded = new ContextSessionStore({ repoRoot: conciseRoot });
    expect(verdict(reloaded.getReport('sess-replay', { policy: { phase: 'implement' } }))).toEqual(fresh);

    const debug = new ContextSessionStore({ repoRoot: path.join(repoRoot, 'debug') });
    recordWorkflow(debug, 'sess-debug', 'debug', 11_758);
    expect(verdict(debug.getReport('sess-debug', { policy: { phase: 'implement' } }))).toEqual(fresh);

    const refresh = envelope('concise', {
      refresh: {
        status: 'rebuilt',
        before: { nodes: 11_758, edges: 29_917 },
        after: { nodes: 11_759, edges: 29_919 },
      },
    }, 'all', 'all');
    concise.recordToolCall({
      sessionId: 'sess-replay',
      tool: 'refresh_context',
      args: { contextSessionId: 'sess-replay', responseFormat: 'concise' },
      result: refresh,
      responseText: JSON.stringify(refresh),
    });
    expect(verdict(concise.getReport('sess-replay', { policy: { phase: 'implement' } }))).toEqual(fresh);
  });

  it.each([
    ['small', 20],
    ['medium', 11_758],
    ['kibana-scale stress', 1_000_000],
  ] as const)('the documented workflow passes every default phase at %s scale', (_label, graphScale) => {
    const workflowSkill = SHARED_SKILLS.find(skill => skill.name === 'repovine-workflow')?.body ?? '';
    for (const tool of ['search_context', 'map_context', 'inspect_node']) {
      expect(AGENTS_MD).toContain(tool);
      expect(workflowSkill).toContain(tool);
    }

    const store = new ContextSessionStore({ repoRoot: path.join(repoRoot, String(graphScale)) });
    const sessionId = `sess-workflow-${graphScale}`;
    recordWorkflow(store, sessionId, 'concise', graphScale);

    for (const phase of ['explore', 'implement', 'annotate'] satisfies ContextPhase[]) {
      const report = store.getReport(sessionId, { policy: { phase } });
      expect(report?.overall).toBe(1);
      expect(report?.noisePenalty).toBe(0);
      expect(report?.acceptHandoff).toBe(true);
      expect(report?.rejectReasons).toEqual([]);
      const thresholds = DEFAULT_CONTEXT_QUALITY_CONFIG.thresholds[phase];
      expect(report?.policy).toEqual(expect.objectContaining({
        qualityThreshold: thresholds.threshold,
        warningThreshold: thresholds.warningThreshold,
        minAnchors: thresholds.minAnchors,
        byteBudget: thresholds.byteBudget,
      }));
    }
  });
});
