import { describe, expect, it } from '@jest/globals';
import { envelopeError } from '../../../src/mcp/response/envelope.js';
import {
  NavigationRefRegistry,
  responseConfigWithOverride,
  shapeToolResult,
  toCallToolMcpResult,
  type McpResponseConfig,
} from '../../../src/mcp/response-format.js';

const concise: McpResponseConfig = {
  mode: 'concise',
  pretty: false,
  maxChars: 50_000,
};

const debug: McpResponseConfig = {
  mode: 'debug',
  pretty: true,
  maxChars: 50_000,
};

function envelope() {
  return {
    scope: 'mod:pkg/src/session',
    resolvedScope: {
      kind: 'module',
      id: 'mod:pkg/src/session',
      raw: 'mod:pkg/src/session',
      nodeId: 'mod:pkg/src/session',
    },
    summary: 'Mapped module.',
    confidence: 'high',
    result: { id: 'mod:pkg/src/session' },
    gaps: [],
    navigation: {
      deeper: [
        {
          tool: 'inspect_node',
          args: { nodeId: 'mod:pkg/src/session' },
          reason: 'Read a bounded source slice now that the node is narrowed.',
        },
      ],
      sideways: [],
      up: [],
      crossLayer: [],
      validate: [],
    },
  };
}

describe('MCP response formatting', () => {
  it('compacts the public envelope in concise mode', () => {
    expect(shapeToolResult(envelope(), concise)).toEqual({
      scope: 'mod:pkg/src/session',
      resolvedScope: { kind: 'module', id: 'mod:pkg/src/session' },
      summary: 'Mapped module.',
      confidence: 'high',
      result: { id: 'mod:pkg/src/session' },
      navigation: {
        deeper: [
          {
            tool: 'inspect_node',
            args: { nodeId: 'mod:pkg/src/session' },
            reason: 'Read a bounded source slice…',
          },
        ],
      },
    });
  });

  it('preserves the full payload in debug mode', () => {
    expect(shapeToolResult(envelope(), debug)).toEqual(envelope());
  });

  it('uses copyable refs for repeated long navigation args', () => {
    const refs = new NavigationRefRegistry();
    const result = shapeToolResult({
      ...envelope(),
      navigation: {
        deeper: [
          {
            tool: 'inspect_node',
            args: { nodeId: 'export:@scope/pkg/src/deep/module/ExportWithLongName' },
            reason: 'Inspect the strongest matching node.',
          },
        ],
        sideways: [
          {
            tool: 'map_context',
            args: { scope: 'export:@scope/pkg/src/deep/module/ExportWithLongName' },
            reason: 'Map where the strongest match sits in the repository.',
          },
        ],
        up: [],
        crossLayer: [],
        validate: [],
      },
    }, concise, refs) as Record<string, unknown>;

    const refMap = result.refs as Record<string, string>;
    const ref = Object.keys(refMap)[0];
    expect(ref).toMatch(/^\$/);
    expect(refMap[ref]).toBe('export:@scope/pkg/src/deep/module/ExportWithLongName');
    expect(result.navigation).toEqual({
      deeper: [
        {
          tool: 'inspect_node',
          args: { nodeId: ref },
          reason: 'Inspect the strongest matching node',
        },
      ],
      sideways: [
        {
          tool: 'map_context',
          args: { scope: ref },
          reason: 'Map where the strongest match…',
        },
      ],
    });
    expect(refs.resolveArgs({ nodeId: ref })).toEqual({
      nodeId: 'export:@scope/pkg/src/deep/module/ExportWithLongName',
    });
  });

  it('minifies concise tool output and pretty-prints debug output', () => {
    const conciseResult = toCallToolMcpResult(envelope(), concise);
    const debugResult = toCallToolMcpResult(envelope(), debug);

    expect(conciseResult.content[0].text).not.toContain('\n');
    expect(debugResult.content[0].text).toContain('\n  "scope"');
  });

  it('marks tool error payloads as MCP errors', () => {
    expect(toCallToolMcpResult(envelopeError('all', 'nope'), concise)).toMatchObject({ isError: true });
  });

  it('applies per-call responseFormat overrides and preserves maxChars', () => {
    expect(responseConfigWithOverride(concise, 'debug')).toEqual({ mode: 'debug', pretty: true, maxChars: 50_000 });
    expect(responseConfigWithOverride(debug, 'concise')).toEqual({ mode: 'concise', pretty: false, maxChars: 50_000 });
    expect(responseConfigWithOverride(concise, 'wat')).toBe(concise);
  });

  it('bounds an oversized result below the ceiling and marks responseTruncated', () => {
    const small: McpResponseConfig = { mode: 'concise', pretty: false, maxChars: 2_000 };
    const big = {
      ...envelope(),
      result: { rows: Array.from({ length: 500 }, (_, i) => ({ id: `mod:pkg/src/file-${i}`, blob: 'x'.repeat(40) })) },
    };
    const out = toCallToolMcpResult(big, small);
    expect(out.content[0].text.length).toBeLessThanOrEqual(2_000);
    const parsed = JSON.parse(out.content[0].text) as Record<string, unknown>;
    const result = parsed.result as { responseTruncated?: { originalChars: number; limitChars: number; narrow: string[] } };
    expect(result.responseTruncated).toBeDefined();
    expect(result.responseTruncated!.limitChars).toBe(2_000);
    expect(result.responseTruncated!.originalChars).toBeGreaterThan(2_000);
    expect(result.responseTruncated!.narrow).toEqual(expect.arrayContaining(['page with offset/limit']));
    // Identity fields survive so the agent still knows what it asked.
    expect(parsed.scope).toBe('mod:pkg/src/session');
    expect(parsed.confidence).toBe('low');
    expect(Array.isArray(parsed.gaps)).toBe(true);
  });

  it('leaves a normal-sized result untouched by the ceiling', () => {
    const out = toCallToolMcpResult(envelope(), concise);
    const parsed = JSON.parse(out.content[0].text) as Record<string, unknown>;
    expect((parsed.result as Record<string, unknown>).responseTruncated).toBeUndefined();
    expect(parsed.result).toEqual({ id: 'mod:pkg/src/session' });
  });
});
