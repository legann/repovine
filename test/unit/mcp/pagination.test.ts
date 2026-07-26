import { describe, expect, it } from '@jest/globals';
import { CONFIG_DEFAULTS } from '../../../src/config.js';
import { addEdge, addNode, createEmptyGraph } from '../../../src/graph/index.js';
import { buildTokenIndex } from '../../../src/mcp/lib/search-index.js';
import {
  DEFAULT_ARCHITECTURE_LIMIT,
  MAX_ARCHITECTURE_LIMIT,
  limitFrom,
  paginateList,
} from '../../../src/mcp/response/pagination.js';
import { toolHandlers } from '../../../src/mcp/tools/registry.js';
import type { McpToolRuntime, RepovineState } from '../../../src/mcp/types.js';
import type { ModuleInfo, RepositoryGraph } from '../../../src/types.js';

describe('paginateList', () => {
  const items = [0, 1, 2, 3, 4];

  it('slices to a page and reports total/returned/nextOffset when truncated', () => {
    const { page, pagination } = paginateList(items, { limit: 2, offset: 0 });
    expect(page).toEqual([0, 1]);
    expect(pagination.total).toBe(5);
    expect(pagination.returned).toBe(2);
    expect(pagination.offset).toBe(0);
    expect(pagination.truncated).toBe(true);
    expect(pagination.nextOffset).toBe(2);
    expect(pagination.hint).toBeDefined();
  });

  it('omits nextOffset/hint when the page covers the whole list', () => {
    const { page, pagination } = paginateList(items, { limit: 10, offset: 0 });
    expect(page).toEqual(items);
    expect(pagination.total).toBe(5);
    expect(pagination.truncated).toBe(false);
    expect(pagination.nextOffset).toBeUndefined();
    expect(pagination.hint).toBeUndefined();
  });

  it('pages a middle slice with offset', () => {
    const { page, pagination } = paginateList(items, { limit: 2, offset: 2 });
    expect(page).toEqual([2, 3]);
    expect(pagination.offset).toBe(2);
    expect(pagination.returned).toBe(2);
    expect(pagination.truncated).toBe(true);
    expect(pagination.nextOffset).toBe(4);
  });

  it('returns the final partial page without nextOffset', () => {
    const { page, pagination } = paginateList(items, { limit: 2, offset: 4 });
    expect(page).toEqual([4]);
    expect(pagination.returned).toBe(1);
    expect(pagination.truncated).toBe(false);
    expect(pagination.nextOffset).toBeUndefined();
  });

  it('handles an offset past the end as an empty, non-truncated page', () => {
    const { page, pagination } = paginateList(items, { limit: 2, offset: 99 });
    expect(page).toEqual([]);
    expect(pagination.returned).toBe(0);
    expect(pagination.offset).toBe(99);
    expect(pagination.truncated).toBe(false);
    expect(pagination.nextOffset).toBeUndefined();
  });

  it('clamps a negative offset to 0', () => {
    const { pagination } = paginateList(items, { limit: 2, offset: -5 });
    expect(pagination.offset).toBe(0);
  });

  it('embeds noun + narrow guidance in the truncation hint (how to get the rest)', () => {
    const { pagination } = paginateList(items, {
      limit: 2, offset: 0, noun: 'downstream importer', narrow: 'pass exportName to scope to one export',
    });
    expect(pagination.hint).toContain('5 downstream importer(s)');
    expect(pagination.hint).toContain('Showing 1-2');
    expect(pagination.hint).toContain('offset 2');
    expect(pagination.hint).toContain('pass exportName to scope to one export');
  });

  it('falls back to a generic noun + narrow when none given', () => {
    const { pagination } = paginateList(items, { limit: 2, offset: 0 });
    expect(pagination.hint).toContain('5 item(s)');
    expect(pagination.hint).toContain('narrow the scope or reduce depth');
  });
});

describe('architecture report limit', () => {
  it('caps broad reports at 30 findings even when a larger limit reaches the handler', () => {
    expect(limitFrom(
      { limit: 200 },
      DEFAULT_ARCHITECTURE_LIMIT,
      MAX_ARCHITECTURE_LIMIT,
    )).toBe(30);
  });
});

type HandlerEnvelope = {
  confidence: 'high' | 'medium' | 'low';
  summary: string;
  result: Record<string, unknown>;
  navigation: Record<'deeper' | 'sideways' | 'up' | 'crossLayer' | 'validate', Array<{ tool: string; args: Record<string, unknown> }>>;
};

function moduleInfo(id: string): ModuleInfo {
  const rel = id.replace(/^mod:/, '');
  return {
    id,
    packageName: rel.split('/')[0] ?? 'app',
    filePath: `/repo/${rel}.ts`,
    relativeFilePath: `${rel}.ts`,
    contentHash: `${id}:hash`,
    imports: [],
    exports: [],
  };
}

function mapFixture(): { graph: RepositoryGraph; modules: ModuleInfo[] } {
  const graph = createEmptyGraph();
  addNode(graph, { id: 'root', type: 'root', label: 'root', description: '' });
  addNode(graph, { id: 'pkg:app', type: 'package', label: 'app', description: '' });
  addNode(graph, { id: 'pkg:empty', type: 'package', label: 'empty', description: '' });
  addNode(graph, {
    id: 'domain:billing',
    type: 'domain',
    label: 'billing',
    description: '',
    data: { tier: 'business', weight: 'heavy' },
  });
  const moduleIds = ['mod:app/orders', 'mod:app/invoices'];
  for (const id of moduleIds) {
    addNode(graph, {
      id,
      type: 'module',
      label: id.replace(/^mod:app\//, ''),
      description: '',
      data: { filePath: `/repo/${id}.ts`, relativeFilePath: `${id}.ts` },
    });
  }
  addEdge(graph, 'root', 'pkg:app', 'contains');
  addEdge(graph, 'root', 'pkg:empty', 'contains');
  for (const id of moduleIds) {
    addEdge(graph, 'pkg:app', id, 'contains');
    addEdge(graph, id, 'domain:billing', 'tagged', { tagSource: 'path' });
  }
  return { graph, modules: moduleIds.map(moduleInfo) };
}

function runtime(graph: RepositoryGraph, modules: ModuleInfo[]): McpToolRuntime {
  const annotations = {
    getAll: () => ({}),
    get: () => undefined,
    isFresh: () => true,
  } as unknown as RepovineState['annotations'];
  const state: RepovineState = {
    graph,
    snapshot: {
      repoRoot: '/repo',
      timestamp: '2026-01-01T00:00:00.000Z',
      packages: [],
      modules,
    },
    modulesById: new Map(modules.map(mod => [mod.id, mod])),
    searchIndex: buildTokenIndex(graph, {}),
    semanticIndex: null,
    semanticSearchRefresh: { status: 'disabled' },
    annotations,
    domainsConfig: null,
    domainsSuggestions: { additions: [], count: 0, axes: [], declinedHidden: 0, mergedConfig: {}, keepConfig: {} },
    refactoringThresholds: CONFIG_DEFAULTS.analyze_architecture.thresholds,
    builtAt: '2026-01-01T00:00:00.000Z',
  };
  return {
    repoRoot: '/repo',
    getState: () => state,
    getConfig: () => CONFIG_DEFAULTS,
    refreshRepoState: () => undefined,
  };
}

describe('map_context handler pagination branches', () => {
  it('maps repository packages through the all scope', async () => {
    const { graph, modules } = mapFixture();
    const response = await toolHandlers.map_context(runtime(graph, modules), {
      scope: 'all',
      limit: 1,
    }) as HandlerEnvelope;
    const pagination = response.result.pagination as Record<string, unknown>;

    expect(response.confidence).toBe('high');
    expect(response.summary).toContain('Repository map');
    expect(response.result.packages).toEqual([
      expect.objectContaining({ id: 'pkg:app' }),
    ]);
    expect(pagination).toEqual(expect.objectContaining({
      total: 2,
      returned: 1,
      offset: 0,
    }));
  });

  it('surfaces out-of-range focus pagination as an empty diagnostic', async () => {
    const { graph, modules } = mapFixture();
    const response = await toolHandlers.map_context(runtime(graph, modules), {
      scope: 'pkg:app',
      limit: 1,
      offset: 99,
    }) as HandlerEnvelope;
    const focus = response.result.focus as { childPagination: Record<string, unknown> };

    expect(response.confidence).toBe('low');
    expect(focus.childPagination).toEqual(expect.objectContaining({
      total: 2,
      returned: 0,
      offset: 99,
    }));
    expect(response.result.emptyDiagnostic).toEqual(expect.objectContaining({
      reason: 'offset_out_of_range',
    }));
  });

  it('reports a zero-child package scope without losing package navigation', async () => {
    const { graph, modules } = mapFixture();
    const response = await toolHandlers.map_context(runtime(graph, modules), {
      scope: 'pkg:empty',
    }) as HandlerEnvelope;
    const focus = response.result.focus as { childPagination: Record<string, unknown> };

    expect(response.confidence).toBe('low');
    expect(focus.childPagination).toEqual(expect.objectContaining({ total: 0 }));
    expect(response.result.emptyDiagnostic).toEqual(expect.objectContaining({
      reason: 'package_has_no_modules',
    }));
    expect(response.navigation.up.map(item => item.tool)).toContain('map_context');
  });

  it('maps domain summaries and points at high-connectivity modules', async () => {
    const { graph, modules } = mapFixture();
    const response = await toolHandlers.map_context(runtime(graph, modules), {
      scope: 'domain:billing',
      limit: 2,
    }) as HandlerEnvelope;
    const result = response.result as { domain: string; moduleCount: number; topModules?: Array<{ id: string }> };

    expect(response.confidence).toBe('high');
    expect(result.domain).toBe('domain:billing');
    expect(result.moduleCount).toBe(2);
    expect(result.topModules?.map(item => item.id).sort()).toEqual(['mod:app/invoices', 'mod:app/orders']);
    expect(response.navigation.deeper).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'inspect_node', args: expect.objectContaining({ nodeId: expect.stringMatching(/^mod:app\//) }) }),
    ]));
  });

  it('maps query scopes through search diagnostics when no tokens hit', async () => {
    const { graph, modules } = mapFixture();
    const response = await toolHandlers.map_context(runtime(graph, modules), {
      scope: 'missing feature anchor',
    }) as HandlerEnvelope;

    expect(response.confidence).toBe('low');
    expect(response.summary).toContain('Mapped query missing feature anchor');
    expect(response.result.emptyDiagnostic).toEqual(expect.objectContaining({
      reason: 'no_token_hits',
    }));
  });
});
