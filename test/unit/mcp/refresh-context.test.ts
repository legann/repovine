import { describe, it, expect, jest } from '@jest/globals';
import { graphStats } from '../../../src/graph/index.js';
import { refreshContextCore } from '../../../src/mcp/lib/annotations.js';
import { semanticSearchRefreshFromSync } from '../../../src/mcp/lib/refresh-summary.js';
import { CONFIG_DEFAULTS } from '../../../src/config.js';
import type { RepovineState, McpToolRuntime, RefreshRepoStateOptions } from '../../../src/mcp/types.js';
import type { GraphNode } from '../../../src/types.js';

function moduleNode(id: string): GraphNode {
  return { id, type: 'module', label: id, description: '' };
}

describe('semanticSearchRefreshFromSync', () => {
  it('returns disabled when embeddings are off', () => {
    expect(semanticSearchRefreshFromSync(null, { enabled: false })).toEqual({ status: 'disabled' });
  });

  it('returns up_to_date when nothing was embedded', () => {
    expect(semanticSearchRefreshFromSync({ embedded: 0, reused: 10, removed: 0, total: 10 }))
      .toEqual({ status: 'up_to_date', total: 10 });
  });

  it('returns updated with embedded count', () => {
    expect(semanticSearchRefreshFromSync({ embedded: 3, reused: 7, removed: 1, total: 10 }))
      .toEqual({ status: 'updated', embedded: 3, total: 10 });
  });

  it('returns failed with cached total and error', () => {
    expect(semanticSearchRefreshFromSync(null, { enabled: true, error: 'boom', cachedTotal: 99 }))
      .toEqual({ status: 'failed', total: 99, error: 'boom' });
  });
});

describe('refreshContextCore', () => {
  it('includes searchTokens and semanticSearch in the refresh payload', async () => {
    const graph = {
      nodes: new Map<string, GraphNode>([['mod:a', moduleNode('mod:a')]]),
      edges: [],
      outEdges: new Map(),
      inEdges: new Map(),
      byType: new Map(),
    } satisfies RepovineState['graph'];
    const beforeStats = graphStats(graph);
    const searchIndex = {
      tokens: new Map([['auth', new Set(['mod:a'])], ['token', new Set(['mod:a'])]]),
      annotationText: new Map(),
    };
    const annotations = {
      getAll: () => ({ 'mod:a': { summary: 'x' } }),
      detectOrphaned: () => ({ total: 0, byType: {}, orphaned: [] }),
    } as unknown as RepovineState['annotations'];

    const state: RepovineState = {
      graph,
      snapshot: { repoRoot: '/repo', timestamp: '2026-06-10T00:00:00.000Z', modules: [], packages: [] },
      modulesById: new Map(),
      searchIndex,
      semanticIndex: null,
      semanticSearchRefresh: { status: 'updated', embedded: 2, total: 50 },
      annotations,
      domainsConfig: null,
      domainsSuggestions: { additions: [], count: 0, axes: [], declinedHidden: 0, mergedConfig: {}, keepConfig: {} },
      refactoringThresholds: {} as RepovineState['refactoringThresholds'],
      builtAt: '2026-06-10T00:00:00.000Z',
    };

    const ctx: McpToolRuntime = {
      repoRoot: '/repo',
      getState: () => state,
      getConfig: () => CONFIG_DEFAULTS,
      refreshRepoState: jest.fn(async () => {
        state.graph = {
          ...graph,
          nodes: new Map<string, GraphNode>([
            ...graph.nodes,
            ['mod:b', moduleNode('mod:b')],
          ]),
        };
      }),
    };

    const result = await refreshContextCore(ctx, {}) as Record<string, unknown>;

    expect(result.searchTokens).toBe(2);
    expect(result.semanticSearch).toEqual({ status: 'updated', embedded: 2, total: 50 });
    expect(result.before).toEqual({ nodes: beforeStats.totalNodes, edges: beforeStats.totalEdges });
    // refreshRepoState mock adds mod:b, so the post-rebuild graph has 2 nodes / 0 edges.
    // Pinning the exact after-count catches a stale after-count regression (reporting `before` twice).
    expect(result.after).toEqual({ nodes: 2, edges: 0 });
    expect(result.builtAt).toBe('2026-06-10T00:00:00.000Z');
  });

  it('surfaces the orphan warning when detectOrphaned reports orphans', async () => {
    const graph = {
      nodes: new Map<string, GraphNode>([['mod:a', moduleNode('mod:a')]]),
      edges: [],
      outEdges: new Map(),
      inEdges: new Map(),
      byType: new Map(),
    } satisfies RepovineState['graph'];
    const annotations = {
      getAll: () => ({ 'mod:gone': { summary: 'x' }, 'mod:also-gone': { summary: 'y' } }),
      detectOrphaned: () => ({ total: 2, byType: { module: 2 }, orphaned: ['mod:gone', 'mod:also-gone'] }),
    } as unknown as RepovineState['annotations'];
    const state: RepovineState = {
      graph,
      snapshot: { repoRoot: '/repo', timestamp: '2026-06-10T00:00:00.000Z', modules: [], packages: [] },
      modulesById: new Map(),
      searchIndex: { tokens: new Map(), annotationText: new Map() },
      semanticIndex: null,
      semanticSearchRefresh: { status: 'disabled' },
      annotations,
      domainsConfig: null,
      domainsSuggestions: { additions: [], count: 0, axes: [], declinedHidden: 0, mergedConfig: {}, keepConfig: {} },
      refactoringThresholds: {} as RepovineState['refactoringThresholds'],
      builtAt: '2026-06-10T00:00:00.000Z',
    };
    const ctx: McpToolRuntime = {
      repoRoot: '/repo',
      getState: () => state,
      getConfig: () => CONFIG_DEFAULTS,
      refreshRepoState: jest.fn(async () => undefined),
    };

    const result = await refreshContextCore(ctx, {}) as Record<string, unknown>;
    const annotationsResult = result.annotations as Record<string, unknown>;

    expect(annotationsResult.orphaned).toBe(2);
    expect(annotationsResult.orphanedByType).toEqual({ module: 2 });
    expect(typeof annotationsResult.warning).toBe('string');
    expect(annotationsResult.warning).toContain('2 annotations reference nodes that no longer exist');
    expect(annotationsResult.warning).toContain('cleanupOrphans');
  });

  it('forwards reloadConfig and reports configReloaded when requested', async () => {
    const graph = {
      nodes: new Map<string, GraphNode>([['mod:a', moduleNode('mod:a')]]),
      edges: [],
      outEdges: new Map(),
      inEdges: new Map(),
      byType: new Map(),
    } satisfies RepovineState['graph'];
    const annotations = {
      getAll: () => ({}),
      detectOrphaned: () => ({ total: 0, byType: {}, orphaned: [] }),
    } as unknown as RepovineState['annotations'];
    const state: RepovineState = {
      graph,
      snapshot: { repoRoot: '/repo', timestamp: '2026-06-10T00:00:00.000Z', modules: [], packages: [] },
      modulesById: new Map(),
      searchIndex: { tokens: new Map(), annotationText: new Map() },
      semanticIndex: null,
      semanticSearchRefresh: { status: 'disabled' },
      annotations,
      domainsConfig: null,
      domainsSuggestions: { additions: [], count: 0, axes: [], declinedHidden: 0, mergedConfig: {}, keepConfig: {} },
      refactoringThresholds: {} as RepovineState['refactoringThresholds'],
      builtAt: '2026-06-10T00:00:00.000Z',
    };
    const refreshRepoState = jest.fn(async (_options?: RefreshRepoStateOptions) => ({ configReloaded: true }));
    const ctx: McpToolRuntime = {
      repoRoot: '/repo',
      getState: () => state,
      getConfig: () => CONFIG_DEFAULTS,
      refreshRepoState,
    };

    const result = await refreshContextCore(ctx, { reloadConfig: true }) as Record<string, unknown>;

    expect(refreshRepoState).toHaveBeenCalledWith({ reloadConfig: true });
    expect(result.configReloaded).toBe(true);
  });
});
