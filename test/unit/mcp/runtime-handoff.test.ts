import { asPkgRelPath } from '@repovine/plugin-sdk';
import { describe, expect, it, jest } from '@jest/globals';
import { CONFIG_DEFAULTS } from '../../../src/config.js';
import { createEmptyGraph, addNode, addEdge } from '../../../src/graph/index.js';
import {
  computeRuntimeHandoff,
  resolveHandlerModuleId,
  RUNTIME_HANDOFF_LIMIT,
  RUNTIME_HANDOFF_NOTE,
} from '../../../src/mcp/lib/runtime-handoff.js';
import type { ResolvedScope } from '../../../src/scope/resolved.js';
import type { McpToolRuntime, RepovineState } from '../../../src/mcp/types.js';
import type { RepositoryGraph, StoredAnnotation } from '../../../src/types.js';

const ALL_SCOPE: ResolvedScope = { raw: 'all', resolvedScope: 'all', kind: 'all' };

function annotation(nodeId: string, risks: StoredAnnotation['annotation']['risks']): StoredAnnotation {
  return {
    nodeId,
    nodeType: nodeId.startsWith('resource:') ? 'runtime-resource' : 'module',
    contentHash: `${nodeId}:hash`,
    pass: 1,
    updatedAt: '2026-07-01T00:00:00.000Z',
    annotation: {
      summary: `${nodeId} summary`,
      risks,
    },
  };
}

function makeCtx(
  graph: RepositoryGraph,
  annotationsById: Record<string, StoredAnnotation> = {},
): McpToolRuntime {
  const annotations = {
    get: (nodeId: string) => annotationsById[nodeId],
    set: jest.fn(),
    isFresh: () => true,
    getQueue: () => [],
    getStats: () => ({}),
    getAll: () => annotationsById,
  } as unknown as RepovineState['annotations'];
  const state = { graph, annotations } as unknown as RepovineState;
  return {
    getState: () => state,
    getConfig: () => CONFIG_DEFAULTS,
    refreshRepoState: () => {},
    repoRoot: '/repo',
  };
}

function makeGraph(): RepositoryGraph {
  const graph = createEmptyGraph();
  addNode(graph, { id: 'root', type: 'root', label: 'root', description: '' });
  return graph;
}

function addModule(graph: RepositoryGraph, id: string, label = id.replace(/^mod:/, '')): void {
  addNode(graph, {
    id,
    type: 'module',
    label,
    description: '',
    data: { pkgRelPath: asPkgRelPath(`${label}.ts`) },
  });
}

function addResource(graph: RepositoryGraph, id: string, label = id.replace(/^resource:/, '')): void {
  addNode(graph, {
    id,
    type: 'runtime-resource',
    label,
    description: 'resource',
    data: { kind: 'lambda' },
  });
}

function addSecret(graph: RepositoryGraph, id: string, label = id.replace(/^resource:/, '')): void {
  addNode(graph, {
    id,
    type: 'runtime-resource',
    label,
    description: 'secret',
    data: { kind: 'secret' },
  });
}

function addHandledResource(graph: RepositoryGraph, resourceId: string, handlerId: string): void {
  addResource(graph, resourceId);
  addModule(graph, handlerId);
  addEdge(graph, resourceId, handlerId, 'infra');
}

describe('runtime handoff', () => {
  it('includes resources whose handler carries a consumer-scoped risk', () => {
    const graph = makeGraph();
    addHandledResource(graph, 'resource:orders', 'mod:app/orders-handler');
    const ctx = makeCtx(graph, {
      'mod:app/orders-handler': annotation('mod:app/orders-handler', [
        { text: 'Importers must verify auth locally.', scope: 'consumer' },
      ]),
    });

    expect(computeRuntimeHandoff(ctx, {
      scope: ALL_SCOPE,
      serviceIds: ['resource:orders'],
    })).toEqual({
      items: [{
        resourceId: 'resource:orders',
        handlerModuleId: 'mod:app/orders-handler',
        trigger: 'annotation',
        note: RUNTIME_HANDOFF_NOTE,
      }],
    });
  });

  it('includes resources linked to secret bindings', () => {
    const graph = makeGraph();
    addHandledResource(graph, 'resource:billing', 'mod:app/billing-handler');
    addSecret(graph, 'resource:secret:DATABASE_URL');
    addEdge(graph, 'resource:billing', 'resource:secret:DATABASE_URL', 'uses_env');
    const ctx = makeCtx(graph);

    const result = computeRuntimeHandoff(ctx, {
      scope: ALL_SCOPE,
      serviceIds: ['resource:billing'],
    });

    expect(result.items).toEqual([
      expect.objectContaining({
        resourceId: 'resource:billing',
        handlerModuleId: 'mod:app/billing-handler',
        trigger: 'secret-binding',
      }),
    ]);
  });

  it('emits one scoped-resource handoff for an exact resource without other signals', () => {
    const graph = makeGraph();
    addHandledResource(graph, 'resource:jobs', 'mod:app/jobs-handler');
    const ctx = makeCtx(graph);

    const result = computeRuntimeHandoff(ctx, {
      scope: {
        raw: 'resource:jobs',
        resolvedScope: 'resource:jobs',
        kind: 'runtime-resource',
        nodeId: 'resource:jobs',
      },
      serviceIds: ['resource:jobs'],
    });

    expect(result.items).toEqual([
      expect.objectContaining({
        resourceId: 'resource:jobs',
        handlerModuleId: 'mod:app/jobs-handler',
        trigger: 'scoped-resource',
      }),
    ]);
  });

  it('promotes the single infra seed of a module-scoped request to a scoped-resource handoff', () => {
    const graph = makeGraph();
    // Resource -> handler infra edge; the resource carries no annotation/secret signal.
    addHandledResource(graph, 'resource:reports', 'mod:app/reports-handler');
    const ctx = makeCtx(graph);

    const result = computeRuntimeHandoff(ctx, {
      scope: {
        raw: 'mod:app/reports-handler',
        resolvedScope: 'mod:app/reports-handler',
        kind: 'module',
        nodeId: 'mod:app/reports-handler',
      },
      // The resource is NOT in serviceIds: only the module-scope branch can surface it.
      serviceIds: [],
    });

    expect(result.items).toEqual([
      expect.objectContaining({
        resourceId: 'resource:reports',
        handlerModuleId: 'mod:app/reports-handler',
        trigger: 'scoped-resource',
      }),
    ]);
  });

  it('does not promote a module-scoped request when the module has multiple infra seeds', () => {
    const graph = makeGraph();
    addModule(graph, 'mod:app/shared-handler');
    addResource(graph, 'resource:seed-a');
    addResource(graph, 'resource:seed-b');
    addEdge(graph, 'resource:seed-a', 'mod:app/shared-handler', 'infra');
    addEdge(graph, 'resource:seed-b', 'mod:app/shared-handler', 'infra');
    const ctx = makeCtx(graph);

    const result = computeRuntimeHandoff(ctx, {
      scope: {
        raw: 'mod:app/shared-handler',
        resolvedScope: 'mod:app/shared-handler',
        kind: 'module',
        nodeId: 'mod:app/shared-handler',
      },
      serviceIds: [],
    });

    expect(result).toEqual({ items: [] });
  });

  it('omits a plain broad resource with no annotation or secret signal', () => {
    const graph = makeGraph();
    addHandledResource(graph, 'resource:plain', 'mod:app/plain-handler');
    const ctx = makeCtx(graph);

    expect(computeRuntimeHandoff(ctx, {
      scope: ALL_SCOPE,
      serviceIds: ['resource:plain'],
    })).toEqual({ items: [] });
  });

  it('caps eligible pairs at three and reports omitted entries', () => {
    const graph = makeGraph();
    const annotationsById: Record<string, StoredAnnotation> = {};
    for (let i = 0; i < RUNTIME_HANDOFF_LIMIT + 2; i += 1) {
      const resourceId = `resource:fn-${i}`;
      const handlerId = `mod:app/fn-${i}`;
      addHandledResource(graph, resourceId, handlerId);
      annotationsById[resourceId] = annotation(resourceId, [
        { text: 'Callers must verify this runtime boundary locally.', scope: 'consumer' },
      ]);
    }
    const ctx = makeCtx(graph, annotationsById);

    const result = computeRuntimeHandoff(ctx, {
      scope: ALL_SCOPE,
      serviceIds: Array.from({ length: RUNTIME_HANDOFF_LIMIT + 2 }, (_, i) => `resource:fn-${i}`),
    });

    expect(result.items).toHaveLength(RUNTIME_HANDOFF_LIMIT);
    expect(result.truncation?.items).toEqual({
      shown: RUNTIME_HANDOFF_LIMIT,
      total: RUNTIME_HANDOFF_LIMIT + 2,
      unit: 'item',
      more: { kind: 'narrow', hint: expect.stringContaining('trace_flow') },
    });
  });

  it('omits resources that do not resolve to handler modules', () => {
    const graph = makeGraph();
    addResource(graph, 'resource:no-handler');
    const ctx = makeCtx(graph, {
      'resource:no-handler': annotation('resource:no-handler', [
        { text: 'Importers must verify this locally.', scope: 'consumer' },
      ]),
    });

    expect(computeRuntimeHandoff(ctx, {
      scope: ALL_SCOPE,
      serviceIds: ['resource:no-handler'],
    })).toEqual({ items: [] });
  });

  it('includes handlers with boundary-scoped risks', () => {
    const graph = makeGraph();
    addHandledResource(graph, 'resource:import', 'mod:app/import-handler');
    const ctx = makeCtx(graph, {
      'mod:app/import-handler': annotation('mod:app/import-handler', [
        { text: 'Importer must not edit this boundary in place.', scope: 'boundary' },
      ]),
    });

    const result = computeRuntimeHandoff(ctx, {
      scope: ALL_SCOPE,
      serviceIds: ['resource:import'],
    });

    expect(result.items).toEqual([
      expect.objectContaining({
        resourceId: 'resource:import',
        handlerModuleId: 'mod:app/import-handler',
        trigger: 'annotation',
      }),
    ]);
  });

  it('chooses the first stable-sorted infra handler module when multiple modules are linked', () => {
    const graph = makeGraph();
    addResource(graph, 'resource:multi');
    addModule(graph, 'mod:app/z-handler');
    addModule(graph, 'mod:app/a-handler');
    addEdge(graph, 'resource:multi', 'mod:app/z-handler', 'infra');
    addEdge(graph, 'resource:multi', 'mod:app/a-handler', 'infra');

    expect(resolveHandlerModuleId(graph, 'resource:multi')).toBe('mod:app/a-handler');
  });

  it('falls back to a direct mod: handler id when the resource has no infra edge', () => {
    const graph = makeGraph();
    addNode(graph, {
      id: 'resource:direct',
      type: 'runtime-resource',
      label: 'direct',
      description: 'resource',
      data: { kind: 'lambda', handler: 'mod:app/direct-handler' },
    });
    addModule(graph, 'mod:app/direct-handler');

    expect(resolveHandlerModuleId(graph, 'resource:direct')).toBe('mod:app/direct-handler');
  });

  it('falls back to the module whose pkgRelPath matches the resource handler string', () => {
    const graph = makeGraph();
    addNode(graph, {
      id: 'resource:by-path',
      type: 'runtime-resource',
      label: 'by-path',
      description: 'resource',
      data: { kind: 'lambda', handler: 'services/worker.ts' },
    });
    addNode(graph, {
      id: 'mod:app/worker',
      type: 'module',
      label: 'worker',
      description: '',
      data: { pkgRelPath: asPkgRelPath('services/worker.ts') },
    });

    expect(resolveHandlerModuleId(graph, 'resource:by-path')).toBe('mod:app/worker');
  });

  it('returns undefined when neither an infra edge nor a data.handler resolves', () => {
    const graph = makeGraph();
    addNode(graph, {
      id: 'resource:orphan',
      type: 'runtime-resource',
      label: 'orphan',
      description: 'resource',
      data: { kind: 'lambda', handler: 'nowhere/missing.ts' },
    });

    expect(resolveHandlerModuleId(graph, 'resource:orphan')).toBeUndefined();
  });
});
