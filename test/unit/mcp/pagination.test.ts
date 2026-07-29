import { asHostPath, asPkgRelPath } from '@repovine/plugin-sdk';
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

  it('slices to a page and says how to reach the rest when it does not fit', () => {
    const { page, truncation } = paginateList(items, { limit: 2, offset: 0 });
    expect(page).toEqual([0, 1]);
    expect(truncation).toEqual({
      shown: 2,
      total: 5,
      unit: 'item',
      more: { kind: 'page', arg: 'offset', nextOffset: 2, hint: expect.any(String) },
    });
  });

  it('says nothing when the page covers the whole list', () => {
    const { page, truncation } = paginateList(items, { limit: 10, offset: 0 });
    expect(page).toEqual(items);
    expect(truncation).toBeUndefined();
  });

  it('pages a middle slice with offset', () => {
    const { page, truncation } = paginateList(items, { limit: 2, offset: 2 });
    expect(page).toEqual([2, 3]);
    expect(truncation?.shown).toBe(2);
    expect(truncation?.more).toEqual(expect.objectContaining({ kind: 'page', nextOffset: 4 }));
  });

  // A last page is smaller than the list and still holds everything left, so the end is decided by
  // nextOffset, not by comparing the page size with the total.
  it('says nothing on the final partial page', () => {
    const { page, truncation } = paginateList(items, { limit: 2, offset: 4 });
    expect(page).toEqual([4]);
    expect(truncation).toBeUndefined();
  });

  // Advancing from an offset past the end would hand back the offset that just returned nothing, so
  // the answer is to restart rather than to page on.
  it('sends an offset past the end back to the start instead of forward', () => {
    const { page, truncation } = paginateList(items, { limit: 2, offset: 99 });
    expect(page).toEqual([]);
    expect(truncation).toEqual({
      shown: 0,
      total: 5,
      unit: 'item',
      more: { kind: 'arg', arg: 'offset', value: 0, hint: expect.stringContaining('past the end') },
    });
  });

  // An unclamped slice(-5, -3) would hand back [0, 1] too, so the page alone cannot tell the clamp
  // from its absence — the reported offset is what does.
  it('clamps a negative offset to 0', () => {
    const { page, truncation } = paginateList(items, { limit: 2, offset: -5 });
    expect(page).toEqual([0, 1]);
    expect(truncation?.more).toEqual(expect.objectContaining({ kind: 'page', nextOffset: 2 }));
  });

  it('embeds noun + narrow guidance in the hint (how to get the rest)', () => {
    const { truncation } = paginateList(items, {
      limit: 2, offset: 0, noun: 'downstream importer', narrow: 'pass exportName to scope to one export',
    });
    const hint = truncation?.more.kind === 'page' ? truncation.more.hint : undefined;
    expect(hint).toContain('5 downstream importer(s)');
    expect(hint).toContain('Showing 1-2');
    expect(hint).toContain('offset 2');
    expect(hint).toContain('pass exportName to scope to one export');
  });

  it('falls back to a generic noun + narrow when none given', () => {
    const { truncation } = paginateList(items, { limit: 2, offset: 0 });
    const hint = truncation?.more.kind === 'page' ? truncation.more.hint : undefined;
    expect(hint).toContain('5 item(s)');
    expect(hint).toContain('narrow the scope or reduce depth');
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
    absPath: asHostPath(`/repo/${rel}.ts`),
    pkgRelPath: asPkgRelPath(`${rel}.ts`),
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
      data: { absPath: asHostPath(`/repo/${id}.ts`), pkgRelPath: asPkgRelPath(`${id}.ts`) },
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
    const truncation = response.result.truncation as Record<string, Record<string, unknown>>;

    expect(response.confidence).toBe('high');
    expect(response.summary).toContain('Repository map');
    expect(response.result.packageTotal).toBe(2);
    expect(response.result.packages).toEqual([
      expect.objectContaining({ id: 'pkg:app' }),
    ]);
    expect(truncation.packages).toEqual(expect.objectContaining({
      shown: 1,
      total: 2,
      more: expect.objectContaining({ kind: 'page', arg: 'offset', nextOffset: 1 }),
    }));
  });

  it('surfaces out-of-range focus pagination as an empty diagnostic', async () => {
    const { graph, modules } = mapFixture();
    const response = await toolHandlers.map_context(runtime(graph, modules), {
      scope: 'pkg:app',
      limit: 1,
      offset: 99,
    }) as HandlerEnvelope;
    const focus = response.result.focus as { drillDown: unknown[]; truncation: Record<string, Record<string, unknown>> };

    expect(response.confidence).toBe('low');
    expect(focus.drillDown).toEqual([]);
    // An offset past the end is answered by a restart, never by a cursor pointing at itself.
    expect(focus.truncation.children).toEqual(expect.objectContaining({
      shown: 0,
      total: 2,
      more: expect.objectContaining({ kind: 'arg', arg: 'offset', value: 0 }),
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
    const focus = response.result.focus as { drillDown: unknown[]; truncation?: unknown };

    expect(response.confidence).toBe('low');
    // No children at all, so nothing was bounded: the page IS the whole (empty) list.
    expect(focus.drillDown).toEqual([]);
    expect(focus.truncation).toBeUndefined();
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
