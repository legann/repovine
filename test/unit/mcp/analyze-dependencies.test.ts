import { asHostPath, asPkgRelPath } from '@repovine/plugin-sdk';
import { describe, expect, it } from '@jest/globals';
import { CONFIG_DEFAULTS } from '../../../src/config.js';
import { addEdge, addNode, createEmptyGraph } from '../../../src/graph/index.js';
import { buildTokenIndex } from '../../../src/mcp/lib/search-index.js';
import { defaultDependencyMode } from '../../../src/mcp/tools/analyze-dependencies.js';
import { toolHandlers } from '../../../src/mcp/tools/registry.js';
import type { ResolvedScope } from '../../../src/scope/resolved.js';
import type { McpToolRuntime, RepovineState } from '../../../src/mcp/types.js';
import type { ModuleInfo, RepositoryGraph } from '../../../src/types.js';

type HandlerEnvelope = {
  confidence: 'high' | 'medium' | 'low';
  result: {
    mode?: string;
    analysis?: Record<string, unknown>;
    error?: string;
    emptyDiagnostic?: Record<string, unknown>;
  };
  gaps: string[];
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

function runtime(graph: RepositoryGraph, modulesById: Map<string, ModuleInfo>): McpToolRuntime {
  const modules = [...modulesById.values()];
  const state: RepovineState = {
    graph,
    snapshot: {
      repoRoot: '/repo',
      timestamp: '2026-01-01T00:00:00.000Z',
      packages: [],
      modules,
    },
    modulesById,
    searchIndex: buildTokenIndex(graph, {}),
    semanticIndex: null,
    semanticSearchRefresh: { status: 'disabled' },
    annotations: {
      getAll: () => ({}),
      get: () => undefined,
      isFresh: () => true,
    } as unknown as RepovineState['annotations'],
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

function baseGraph(): RepositoryGraph {
  const graph = createEmptyGraph();
  addNode(graph, { id: 'root', type: 'root', label: 'root', description: '' });
  addNode(graph, { id: 'pkg:app', type: 'package', label: 'app', description: '' });
  addNode(graph, { id: 'pkg:shared', type: 'package', label: 'shared', description: '' });
  addEdge(graph, 'root', 'pkg:app', 'contains');
  addEdge(graph, 'root', 'pkg:shared', 'contains');
  return graph;
}

function addModule(graph: RepositoryGraph, packageId: string, id: string, label = id.replace(/^mod:[^/]+\//, '')): ModuleInfo {
  addNode(graph, {
    id,
    type: 'module',
    label,
    description: '',
    data: { absPath: asHostPath(`/repo/${id}.ts`), pkgRelPath: asPkgRelPath(`${id}.ts`) },
  });
  addEdge(graph, packageId, id, 'contains');
  return moduleInfo(id);
}

describe('analyze_dependencies handler strictness', () => {
  it('selects default modes from scope kind', () => {
    expect(defaultDependencyMode({ kind: 'module', raw: 'mod:x', resolvedScope: 'mod:x', nodeId: 'mod:x' } as ResolvedScope)).toBe('impact');
    expect(defaultDependencyMode({ kind: 'export-symbol', raw: 'export:x/Foo', resolvedScope: 'export:x/Foo', nodeId: 'export:x/Foo' } as ResolvedScope)).toBe('impact');
    expect(defaultDependencyMode({ kind: 'package', raw: 'pkg:x', resolvedScope: 'pkg:x', packageId: 'pkg:x' } as ResolvedScope)).toBe('package-boundaries');
  });

  it('uses impact mode by default for module scopes', async () => {
    const graph = baseGraph();
    const shared = addModule(graph, 'pkg:shared', 'mod:shared/lib', 'lib');
    const consumer = addModule(graph, 'pkg:app', 'mod:app/consumer', 'consumer');
    addEdge(graph, consumer.id, shared.id, 'imports');
    consumer.imports = [{
      moduleSpecifier: '@shared/lib',
      resolvedModuleId: shared.id,
      importedNames: ['makeThing'],
      isTypeOnly: false,
      isExternal: false,
    }];
    const ctx = runtime(graph, new Map([[shared.id, shared], [consumer.id, consumer]]));

    const response = await toolHandlers.analyze_dependencies(ctx, {
      scope: shared.id,
    }) as HandlerEnvelope;
    const analysis = response.result.analysis!;

    expect(response.result.mode).toBe('impact');
    expect(analysis.downstream).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: consumer.id, uses: ['makeThing'] }),
    ]));
    expect(response.navigation.validate).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'inspect_node', args: expect.objectContaining({ scope: shared.id }) }),
    ]));
  });

  it('uses package-boundaries by default for package scopes and explains empty edges', async () => {
    const graph = baseGraph();
    const service = addModule(graph, 'pkg:app', 'mod:app/service', 'service');
    const ctx = runtime(graph, new Map([[service.id, service]]));

    const response = await toolHandlers.analyze_dependencies(ctx, {
      scope: 'pkg:app',
    }) as HandlerEnvelope;

    expect(response.result.mode).toBe('package-boundaries');
    expect(response.result.emptyDiagnostic).toEqual(expect.objectContaining({
      reason: 'no_cross_package_edges',
    }));
    expect(response.gaps).toEqual(expect.arrayContaining([
      expect.stringContaining('No cross-package import edges'),
    ]));
  });

  it('resolves module plus exportName for callgraph mode', async () => {
    const graph = baseGraph();
    const service = addModule(graph, 'pkg:app', 'mod:app/service', 'service');
    service.exports = [{
      name: 'run',
      kind: 'function',
      lineRange: { start: 1, end: 3 },
      isDefault: false,
      calls: ['doWork'],
    }];
    addNode(graph, {
      id: 'export:app/service/run',
      type: 'export-symbol',
      label: 'run',
      description: '',
      data: { symbolKind: 'function', calls: ['doWork'], lineRange: { start: 1, end: 3 } },
    });
    addEdge(graph, service.id, 'export:app/service/run', 'contains');
    const ctx = runtime(graph, new Map([[service.id, service]]));

    const response = await toolHandlers.analyze_dependencies(ctx, {
      scope: service.id,
      mode: 'callgraph',
      exportName: 'run',
    }) as HandlerEnvelope;

    expect(response.result.mode).toBe('callgraph');
    expect(response.result.analysis).toEqual(expect.objectContaining({
      nodeId: 'export:app/service/run',
      calls: ['doWork'],
    }));
  });

  it('returns scope-mismatch guidance for callgraph on package scopes', async () => {
    const graph = baseGraph();
    const service = addModule(graph, 'pkg:app', 'mod:app/service', 'service');
    const ctx = runtime(graph, new Map([[service.id, service]]));

    const response = await toolHandlers.analyze_dependencies(ctx, {
      scope: 'pkg:app',
      mode: 'callgraph',
    }) as HandlerEnvelope;

    expect(response.confidence).toBe('low');
    expect(response.result.error).toBe('mode callgraph requires an export-symbol scope, or a module scope with exportName');
    expect(response.result.emptyDiagnostic).toEqual(expect.objectContaining({
      reason: 'dependency_mode_scope_mismatch',
      details: expect.objectContaining({ mode: 'callgraph', scopeKind: 'package' }),
    }));
  });

  it('infers the interface name from an export-symbol scope', async () => {
    const graph = baseGraph();
    const contracts = addModule(graph, 'pkg:app', 'mod:app/contracts', 'contracts');
    const repo = addModule(graph, 'pkg:app', 'mod:app/repo', 'repo');
    addNode(graph, {
      id: 'export:app/contracts/IRepo',
      type: 'export-symbol',
      label: 'IRepo',
      description: '',
      data: { symbolKind: 'interface', signature: 'interface IRepo' },
    });
    addNode(graph, {
      id: 'export:app/repo/SqlRepo',
      type: 'export-symbol',
      label: 'SqlRepo',
      description: '',
      data: { symbolKind: 'class', signature: 'class SqlRepo implements IRepo' },
    });
    addEdge(graph, contracts.id, 'export:app/contracts/IRepo', 'contains');
    addEdge(graph, repo.id, 'export:app/repo/SqlRepo', 'contains');
    addEdge(graph, 'export:app/repo/SqlRepo', 'export:app/contracts/IRepo', 'implements');
    const ctx = runtime(graph, new Map([[contracts.id, contracts], [repo.id, repo]]));

    const response = await toolHandlers.analyze_dependencies(ctx, {
      scope: 'export:app/contracts/IRepo',
      mode: 'interface-implementations',
    }) as HandlerEnvelope;

    expect(response.result.mode).toBe('interface-implementations');
    expect(response.result.analysis).toEqual(expect.objectContaining({
      interface: 'IRepo',
      count: 1,
      implementations: [
        expect.objectContaining({ classId: 'export:app/repo/SqlRepo', moduleId: repo.id }),
      ],
    }));
  });

  it('requires interfaceName when no scope can provide one', async () => {
    const graph = baseGraph();
    const service = addModule(graph, 'pkg:app', 'mod:app/service', 'service');
    const ctx = runtime(graph, new Map([[service.id, service]]));

    const response = await toolHandlers.analyze_dependencies(ctx, {
      scope: 'all',
      mode: 'interface-implementations',
    }) as HandlerEnvelope;

    expect(response.confidence).toBe('low');
    expect(response.result.error).toBe('interfaceName is required for mode interface-implementations');
    expect(response.result.emptyDiagnostic).toEqual(expect.objectContaining({
      reason: 'dependency_mode_scope_mismatch',
      details: expect.objectContaining({ mode: 'interface-implementations', scopeKind: 'all' }),
    }));
  });
});
