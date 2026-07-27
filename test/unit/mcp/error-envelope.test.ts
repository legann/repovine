import { describe, expect, it } from '@jest/globals';
import { envelope, envelopeError, type ToolResponse } from '../../../src/mcp/response/envelope.js';
import { toCallToolMcpResult, toolErrorMessage } from '../../../src/mcp/response-format.js';
import { notReadyResponse } from '../../../src/mcp/lib/not-ready-response.js';
import type { IndexBuildStatus } from '../../../src/mcp/build-controller.js';

const RESPONSE = { mode: 'debug' as const, pretty: false, maxChars: 100_000 };

const flag = (result: unknown): boolean | undefined => toCallToolMcpResult(result, RESPONSE).isError;

// A client decides "did this fail" from `isError`, and failure has one shape: `result.error` inside
// the envelope. Every refusal comes back that way — an unknown tool, invalid arguments, an
// unresolved scope, a handler that threw — so the flag is read in one place.
describe('every failure class reaches the client flagged', () => {
  it.each([
    ['unknown tool', envelopeError('all', 'Unknown tool: nope')],
    ['missing argument with a retry call', envelopeError('all', 'Missing required argument(s): nodeId', { nextAction: { tool: 'inspect_node', args: { nodeId: '...' }, reason: 'Retry with every required argument filled in.' } })],
    ['envelopeError (nested under result)', envelopeError('all', 'query is required')],
    ['envelopeError from a resolved scope', envelopeError({ kind: 'query', raw: 'x', resolvedScope: 'query:x' }, 'Could not resolve node: x')],
    ['envelope whose result carries a not-found', envelope('pkg:a', 'Not found', { error: 'Not found: pkg:a' })],
  ])('flags %s', (_name, result) => {
    expect(flag(result)).toBe(true);
    expect(toolErrorMessage(result)).toEqual(expect.any(String));
  });

  it.each([
    ['a normal envelope', envelope('all', 'Found 2 matches', { matches: [1, 2] })],
    ['an envelope whose result is empty', envelope('all', 'Nothing to report', {})],
    ['a progress payload', notReadyResponse(status({}))],
    // No producer builds this any more; reading it as a failure would restore the split.
    ['a bare top-level error object', { error: 'Unknown tool: nope' }],
  ])('leaves %s unflagged', (_name, result) => {
    expect(flag(result)).toBeUndefined();
    expect(toolErrorMessage(result)).toBeUndefined();
  });

  it('does not read a withheld oversized payload as a failure', () => {
    // The size backstop emits confidence:'low' with `truncation.result` and no `result.error`.
    // Keying the flag on confidence instead of the error field would mark a withheld body an error.
    const huge = envelope('all', 'Big', { items: Array.from({ length: 5_000 }, (_, i) => `item-${i}`) });
    const out = toCallToolMcpResult(huge, { ...RESPONSE, maxChars: 500 });

    expect(out.isError).toBeUndefined();
    // `truncation.result` is emitted by the size backstop and by nothing else.
    expect(out.content[0].text).toContain('"truncation":{"result":');
  });

  it('keeps a failure flagged when it is withheld for size', () => {
    // Failure is a property of the payload, not of its length. Deciding the flag after the size
    // branch loses it exactly when the body is replaced by the bound.
    const bulky = envelopeError('all', 'Could not resolve node: x', {
      candidates: Array.from({ length: 5_000 }, (_, i) => `mod:pkg/candidate-${i}`),
    });
    const out = toCallToolMcpResult(bulky, { ...RESPONSE, maxChars: 500 });

    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('"truncation":{"result":');
    expect(out.content[0].text).toContain('Could not resolve node: x');
  });
});

function result(response: ToolResponse): Record<string, unknown> {
  return response.result as Record<string, unknown>;
}

function status(over: Partial<IndexBuildStatus>): IndexBuildStatus {
  return { status: 'building', stage: 'stage1', retryAfterSec: 5, message: 'Building.', ...over } as IndexBuildStatus;
}

describe('a settled build does not advise waiting for it to settle', () => {
  it.each([
    ['cancelled', status({ status: 'cancelled', stage: 'cancelled', retryAfterSec: 0, message: 'Build cancelled; the graph is not built.' })],
    ['failed', status({ status: 'failed', stage: 'failed', retryAfterSec: 0, message: 'Build failed: boom', errorMessage: 'boom' })],
  ])('reports %s as an error with a recovery action', (_name, snapshot) => {
    const payload = notReadyResponse(snapshot);

    expect(toolErrorMessage(payload)).toBe(snapshot.message);
    expect(flag(payload)).toBe(true);
    // The progress advice is what makes a terminal state look retryable.
    expect(JSON.stringify(payload)).not.toContain('until the build settles');
    expect(JSON.stringify(payload)).not.toContain('retry this tool');
    expect(result(payload).nextAction).toEqual(expect.objectContaining({ tool: 'refresh_context' }));
  });

  it('keeps a running build informational so retry logic does not spin', () => {
    const payload = notReadyResponse(status({
      pct: 40,
      stageEtaSec: 12,
      remainingStages: 2,
      retryAfterSec: 5,
    }));

    expect(flag(payload)).toBeUndefined();
    expect(result(payload).nextAction).toEqual(expect.objectContaining({ tool: 'get_build_status', args: { waitSec: 45 } }));
    expect(result(payload).retryAfterSec).toBe(5);
    expect(result(payload).stageEtaSec).toBe(12);
    expect(result(payload).remainingStages).toBe(2);
    expect(result(payload)).not.toHaveProperty('etaSec');
  });

  it('names build progress the same way get_build_status does', () => {
    // One build reported through two tools has to use one set of field names. Progress renamed the
    // snapshot's fields to snake_case, so a caller that hit a building tool read `remaining_stages`
    // while get_build_status answered `remainingStages` for the same build.
    const snapshot = status({
      doneModules: 10,
      totalModules: 20,
      donePackages: 1,
      totalPackages: 4,
      currentPackage: 'pkg:app',
      doneSemanticCards: 3,
      totalSemanticCards: 9,
      pct: 40,
      elapsedSec: 8,
      stageEtaSec: 12,
      remainingStages: 2,
    });
    const payload = result(notReadyResponse(snapshot));

    expect(new Set(Object.keys(payload))).toEqual(new Set([...Object.keys(snapshot), 'nextAction']));
    for (const key of Object.keys(payload)) expect(key).not.toMatch(/_/);
  });
});

// The attention block is capped and hoisted for primacy, so items that do not fit are the ones a
// reader would otherwise never learn exist. The cap stays; the silence does not.
describe('attention truncation is disclosed', () => {
  const item = (id: string) => ({ nodeId: id, note: `check ${id}`, next: { tool: 'inspect_node', args: { nodeId: id }, reason: `read ${id}` } });

  it('reports shown/total when the block is capped', () => {
    const result = envelope('all', 'Inspected x', { ok: true }, {
      attention: [item('a'), item('b'), item('c'), item('d'), item('e')],
    });

    expect((result.attention as unknown[]).length).toBe(3);
    expect(result.truncation?.attention).toEqual({
      shown: 3,
      total: 5,
      unit: 'item',
      more: { kind: 'inline', hint: expect.stringContaining('investigate tags') },
    });
  });

  it('says nothing when every item fits', () => {
    const result = envelope('all', 'Inspected x', { ok: true }, {
      attention: [item('a'), item('b')],
    });

    expect((result.attention as unknown[]).length).toBe(2);
    expect(result).not.toHaveProperty('truncation');
  });

  it('says nothing when there is no attention block at all', () => {
    const result = envelope('all', 'Inspected x', { ok: true });
    expect(result).not.toHaveProperty('attention');
    expect(result).not.toHaveProperty('truncation');
  });
});
