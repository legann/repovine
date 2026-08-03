import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ContextSessionStore } from '../../../src/context-quality/session-store.js';
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

/** The orientation order the fixture replays. AGENTS.md and the workflow skill document this order. */
const ORIENT_ORDER = ['search_context', 'map_context', 'inspect_node'] as const;

/** The three tools in the order the document first mentions them; a tool the document omits drops out. */
function documentedOrientOrder(doc: string): string[] {
  return ORIENT_ORDER
    .map(tool => ({ tool, at: doc.indexOf(tool) }))
    .filter(entry => entry.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map(entry => entry.tool);
}

/**
 * The graded fields plus the one aggregate the search volume feeds. Carrying the aggregate keeps the
 * volume observable: a scorer that never ingested the reported `totalResults` grades every volume
 * from the same input and reaches the same verdict.
 */
function verdict(report: ContextQualityReport | undefined): Record<string, unknown> {
  expect(report).toBeDefined();
  return {
    overall: report!.overall,
    structureBonus: report!.structureBonus,
    noisePenalty: report!.noisePenalty,
    acceptHandoff: report!.acceptHandoff,
    rejectReasons: report!.rejectReasons,
    belowWarningThreshold: report!.belowWarningThreshold,
    maxTotalResultsInSearch: report!.aggregates.maxTotalResultsInSearch,
  };
}

/** The four policy bars a report echoes for its phase. */
function phaseBars(report: ContextQualityReport | undefined): Record<string, unknown> {
  expect(report).toBeDefined();
  return {
    qualityThreshold: report!.policy.qualityThreshold,
    warningThreshold: report!.policy.warningThreshold,
    minAnchors: report!.policy.minAnchors,
    byteBudget: report!.policy.byteBudget,
  };
}

/**
 * The shipped per-phase bars, written out as literals. An expectation read from
 * DEFAULT_CONTEXT_QUALITY_CONFIG moves with the config the report is built from, so both sides of
 * the comparison travel together and a change to the shipped bars stays invisible.
 */
const SHIPPED_PHASE_BARS: Record<ContextPhase, Record<string, number>> = {
  explore: { qualityThreshold: 0.40, warningThreshold: 0.55, minAnchors: 1, byteBudget: 80_000 },
  implement: { qualityThreshold: 0.55, warningThreshold: 0.70, minAnchors: 1, byteBudget: 120_000 },
  annotate: { qualityThreshold: 0.35, warningThreshold: 0.50, minAnchors: 0, byteBudget: 100_000 },
};

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

  it('passes every default phase on the documented workflow, with the same verdict at every search volume', () => {
    // The documents state the orientation order the fixture replays; the fixture is written out here
    // rather than read from them, so a document that loses or reorders a tool fails this comparison.
    const workflowSkill = SHARED_SKILLS.find(skill => skill.name === 'repovine-workflow')?.body ?? '';
    expect(documentedOrientOrder(AGENTS_MD)).toEqual([...ORIENT_ORDER]);
    expect(documentedOrientOrder(workflowSkill)).toEqual([...ORIENT_ORDER]);
    expect(workflowCalls('concise', 20, 'sess-order').map(call => call.tool)).toEqual([...ORIENT_ORDER]);

    // The search volume feeds one aggregate, maxTotalResultsInSearch. Pinning that aggregate to the
    // volume the fixture reported keeps the axis real, and pinning every graded field beside it
    // states what the shipped weights do with it: nothing. The volume and phase travel into the
    // comparison so a failure names the case that moved.
    const passingVerdict = {
      overall: 1,
      structureBonus: 1,
      noisePenalty: 0,
      acceptHandoff: true,
      rejectReasons: [],
      belowWarningThreshold: false,
    };
    for (const searchVolume of [20, 11_758, 1_000_000]) {
      const store = new ContextSessionStore({ repoRoot: path.join(repoRoot, String(searchVolume)) });
      const sessionId = `sess-workflow-${searchVolume}`;
      recordWorkflow(store, sessionId, 'concise', searchVolume);

      for (const phase of ['explore', 'implement', 'annotate'] satisfies ContextPhase[]) {
        const report = store.getReport(sessionId, { policy: { phase } });
        expect({ searchVolume, phase, ...verdict(report) })
          .toEqual({ searchVolume, phase, ...passingVerdict, maxTotalResultsInSearch: searchVolume });
        expect({ phase, ...phaseBars(report) }).toEqual({ phase, ...SHIPPED_PHASE_BARS[phase] });
      }
    }
  });
});
