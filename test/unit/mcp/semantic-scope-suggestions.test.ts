import { describe, it, expect } from '@jest/globals';
import { appendSemanticScopeSuggestions } from '../../../src/mcp/response/semantic-scope-suggestions.js';
import type { McpToolRuntime } from '../../../src/mcp/types.js';

type Hit = { id: string; score: number };

function fakeCtx(hits: Hit[], options: { size?: number; throwOnEmbed?: boolean; graphNodeIds?: string[] } = {}): Pick<McpToolRuntime, 'getState'> {
  const semanticIndex = {
    size: options.size ?? Math.max(1, hits.length),
    embedQuery: async () => {
      if (options.throwOnEmbed) throw new Error('embedder unavailable');
      return new Float32Array([1]);
    },
    query: () => hits,
  };
  // Suggestions are gated on the graph still holding the id. Default: every ranked hit exists.
  const graph = { nodes: new Set(options.graphNodeIds ?? hits.map(h => h.id)) };
  return { getState: () => ({ semanticIndex, graph }) } as unknown as Pick<McpToolRuntime, 'getState'>;
}

function unresolvedResponse(): Record<string, unknown> {
  return {
    scope: 'auth sessions',
    result: {
      emptyDiagnostic: {
        reason: 'scope_unresolved',
        message: 'The scope "auth sessions" did not resolve.',
        nextActions: [{ when: 'if this is a symbol or path', tool: 'search_context', args: { query: 'auth sessions' } }],
      },
    },
  };
}

function emptyQueryScopeResponse(reason: string, scopeKind = 'query'): Record<string, unknown> {
  return {
    scope: 'annotation quality scoring',
    resolvedScope: { kind: scopeKind, id: 'query:annotation quality scoring' },
    result: {
      emptyDiagnostic: {
        reason,
        message: 'Nothing matched.',
        nextActions: [],
      },
    },
  };
}

function diagnosticActions(response: Record<string, unknown>): Array<Record<string, unknown>> {
  const result = response.result as Record<string, unknown>;
  const diagnostic = result.emptyDiagnostic as Record<string, unknown>;
  return diagnostic.nextActions as Array<Record<string, unknown>>;
}

describe('semantic scope suggestions on scope_unresolved', () => {
  it('appends up to three same-tool retry actions above the cosine floor', async () => {
    const ctx = fakeCtx([
      { id: 'domain:auth', score: 0.82 },
      { id: 'mod:web/src/session', score: 0.61 },
      { id: 'mod:web/src/login', score: 0.47 },
      { id: 'mod:web/src/extra', score: 0.41 },
      { id: 'mod:web/src/noise', score: 0.2 }, // below the 0.35 floor — dropped
    ]);
    const response = unresolvedResponse();
    await appendSemanticScopeSuggestions(ctx, 'map_context', { scope: 'auth sessions', view: 'summary' }, response);

    const actions = diagnosticActions(response);
    expect(actions).toHaveLength(1 + 3);
    const semantic = actions.slice(1);
    expect(semantic.map(a => a.tool)).toEqual(['map_context', 'map_context', 'map_context']);
    expect(semantic[0].args).toEqual({ scope: 'domain:auth', view: 'summary' });
    expect(String(semantic[0].when)).toContain('semantic similarity 0.82');
    expect(String(semantic[0].when)).toContain('advisory');
  });

  it('filters hits below the cosine floor and dedupes the original scope', async () => {
    const ctx = fakeCtx([
      { id: 'auth sessions', score: 0.9 }, // same as raw scope — skipped
      { id: 'mod:web/src/noise', score: 0.1 },
    ]);
    const response = unresolvedResponse();
    await appendSemanticScopeSuggestions(ctx, 'trace_flow', { scope: 'auth sessions' }, response);
    expect(diagnosticActions(response)).toHaveLength(1);
  });

  it('enriches any empty result on a free-text query: scope (bare phrases never hit scope_unresolved)', async () => {
    const ctx = fakeCtx([{ id: 'mod:repovine/src/annotations/store', score: 0.62 }]);
    const response = emptyQueryScopeResponse('scope_has_no_config_surface');
    await appendSemanticScopeSuggestions(ctx, 'get_config_surface', { scope: 'annotation quality scoring' }, response);

    const actions = diagnosticActions(response);
    expect(actions).toHaveLength(1);
    expect(actions[0].tool).toBe('get_config_surface');
    expect(actions[0].args).toEqual({ scope: 'mod:repovine/src/annotations/store' });
  });

  it('strips the explicit query: prefix before embedding', async () => {
    let embedded = '';
    const semanticIndex = {
      size: 1,
      embedQuery: async (text: string) => { embedded = text; return new Float32Array([1]); },
      query: () => [{ id: 'mod:repovine/src/annotations/store', score: 0.62 }],
    };
    const graph = { nodes: new Set(['mod:repovine/src/annotations/store']) };
    const ctx = { getState: () => ({ semanticIndex, graph }) } as unknown as Pick<McpToolRuntime, 'getState'>;
    const response = emptyQueryScopeResponse('scope_has_no_config_surface');
    await appendSemanticScopeSuggestions(ctx, 'get_config_surface', { scope: 'query:annotation quality scoring' }, response);

    expect(embedded).toBe('annotation quality scoring');
    expect(diagnosticActions(response)).toHaveLength(1);
  });

  it('does nothing for other diagnostic reasons on a RESOLVED (non-query) scope', async () => {
    const ctx = fakeCtx([{ id: 'domain:auth', score: 0.8 }]);
    const response = emptyQueryScopeResponse('package_has_no_entrypoints', 'package');
    await appendSemanticScopeSuggestions(ctx, 'get_entrypoints', { scope: 'pkg:repovine' }, response);
    expect(diagnosticActions(response)).toHaveLength(0);
  });

  it('treats a missed nodeId like a missed scope and retries via scope (nodeId dropped)', async () => {
    const ctx = fakeCtx([{ id: 'mod:repovine/src/cli/repovine-gitignore', score: 0.52 }]);
    const response = unresolvedResponse();
    await appendSemanticScopeSuggestions(ctx, 'inspect_node', { nodeId: 'mod:repovine/src/no/such/module' }, response);

    const actions = diagnosticActions(response);
    expect(actions).toHaveLength(2);
    expect(actions[1].tool).toBe('inspect_node');
    expect(actions[1].args).toEqual({ scope: 'mod:repovine/src/cli/repovine-gitignore' });
  });

  it('does nothing without scope or nodeId arguments', async () => {
    const ctx = fakeCtx([{ id: 'domain:auth', score: 0.8 }]);
    const response = unresolvedResponse();
    await appendSemanticScopeSuggestions(ctx, 'validate_annotations', { limit: 5 }, response);
    expect(diagnosticActions(response)).toHaveLength(1);
  });

  it('degrades silently when the semantic index is absent or empty', async () => {
    const noIndex = { getState: () => ({ semanticIndex: null }) } as unknown as Pick<McpToolRuntime, 'getState'>;
    const response = unresolvedResponse();
    await appendSemanticScopeSuggestions(noIndex, 'map_context', { scope: 'auth sessions' }, response);
    expect(diagnosticActions(response)).toHaveLength(1);

    const emptyIndex = fakeCtx([], { size: 0 });
    await appendSemanticScopeSuggestions(emptyIndex, 'map_context', { scope: 'auth sessions' }, response);
    expect(diagnosticActions(response)).toHaveLength(1);
  });

  it('degrades silently when the embedder throws', async () => {
    const ctx = fakeCtx([{ id: 'domain:auth', score: 0.8 }], { throwOnEmbed: true });
    const response = unresolvedResponse();
    await appendSemanticScopeSuggestions(ctx, 'map_context', { scope: 'auth sessions' }, response);
    expect(diagnosticActions(response)).toHaveLength(1);
  });

  it('skips a ranked id no longer in the graph (stale index vs concurrently refreshed graph)', async () => {
    // A refresh between the index read and this join can remove/rename a node the index still ranks.
    // Suggesting it as a retry scope would send the agent to a guaranteed second miss.
    const ctx = fakeCtx(
      [
        { id: 'domain:auth', score: 0.82 },      // still present
        { id: 'mod:web/removed', score: 0.61 },  // dropped by a refresh → must not be suggested
        { id: 'mod:web/login', score: 0.47 },    // still present
      ],
      { graphNodeIds: ['domain:auth', 'mod:web/login'] },
    );
    const response = unresolvedResponse();
    await appendSemanticScopeSuggestions(ctx, 'map_context', { scope: 'auth sessions' }, response);

    const scopes = diagnosticActions(response).slice(1).map(a => (a.args as Record<string, unknown>).scope);
    expect(scopes).toEqual(['domain:auth', 'mod:web/login']);
    expect(scopes).not.toContain('mod:web/removed');
  });
});
