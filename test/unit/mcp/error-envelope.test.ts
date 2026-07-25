import { describe, expect, it } from '@jest/globals';
import { envelope, envelopeError } from '../../../src/mcp/response/envelope.js';
import { toCallToolMcpResult, toolErrorMessage } from '../../../src/mcp/response-format.js';
import { notReadyResponse } from '../../../src/mcp/lib/not-ready-response.js';
import type { IndexBuildStatus } from '../../../src/mcp/build-controller.js';

const RESPONSE = { mode: 'debug' as const, pretty: false, maxChars: 100_000 };

const flag = (result: unknown): boolean | undefined => toCallToolMcpResult(result, RESPONSE).isError;

// A client decides "did this fail" from `isError`. Handlers report failure in two shapes, and both
// have to reach that flag: a bare `{ error }`, and `envelopeError`, which nests the message under
// `result.error` inside an otherwise normal envelope. Reading only the top level marks a resolve
// failure as success — which is what inspect_node, search_context and get_config_surface return.
describe('every failure class reaches the client flagged', () => {
  it.each([
    ['bare error object', { error: 'Unknown tool: nope' }],
    ['error with a fix hint', { error: 'Missing required argument(s): nodeId', fix: 'tools/call { ... }' }],
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
    ['a progress payload', { status: 'building', stage: 'stage1', retry_after_sec: 5 }],
  ])('leaves %s unflagged', (_name, result) => {
    expect(flag(result)).toBeUndefined();
    expect(toolErrorMessage(result)).toBeUndefined();
  });

  it('does not read a withheld oversized payload as a failure', () => {
    // The size backstop emits confidence:'low' with `result.responseTruncated` and no `result.error`.
    // Keying the flag on confidence instead of the error field would mark truncation as an error.
    const huge = envelope('all', 'Big', { items: Array.from({ length: 5_000 }, (_, i) => `item-${i}`) });
    const out = toCallToolMcpResult(huge, { ...RESPONSE, maxChars: 500 });

    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toContain('responseTruncated');
  });
});

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
    expect(payload.fix).toEqual(expect.stringContaining('refresh_context'));
  });

  it('keeps a running build informational so retry logic does not spin', () => {
    const payload = notReadyResponse(status({ pct: 40, retryAfterSec: 5 }));

    expect(flag(payload)).toBeUndefined();
    expect(payload.next_action).toEqual(expect.stringContaining('get_build_status'));
    expect(payload.retry_after_sec).toBe(5);
  });
});
