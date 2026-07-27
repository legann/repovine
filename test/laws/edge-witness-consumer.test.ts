import { describe, expect, it } from '@jest/globals';
import { addEdge, addNode, createEmptyGraph } from '../../src/graph/index.js';
import { analyzeImpact } from '../../src/mcp/lib/dependencies/impact.js';
import { findInterfaceImplementations } from '../../src/mcp/lib/dependencies/interfaces.js';
import { collectConfigSurface } from '../../src/mcp/lib/config-surface.js';
import { projectRuntimeTopology } from '../../src/mcp/lib/topology.js';
import { EDGE_KINDS } from '../../src/types.js';
import type { EdgeKind, ModuleInfo, RepositoryFactsSnapshot, RepositoryGraph } from '../../src/types.js';
import { cloneWithoutEdgeKind, lawRuntime } from './graph-law-helpers.js';
import { deliveredValue } from '../../src/response/refusal.js';

function expectDifferential(
  kind: EdgeKind,
  graph: RepositoryGraph,
  project: (graph: RepositoryGraph) => unknown,
): void {
  const withKind = project(graph);
  const withoutKind = project(cloneWithoutEdgeKind(graph, kind));
  expect(withoutKind).not.toEqual(withKind);
}

function moduleInfo(id: string, imports: ModuleInfo['imports'] = []): ModuleInfo {
  return {
    id,
    packageName: 'app',
    filePath: `/repo/${id}.ts`,
    relativeFilePath: `${id}.ts`,
    contentHash: id,
    imports,
    exports: [],
  };
}

// binds_to is module → runtime-resource (a handler reaching a resource). config-surface reads it
// from a source module's outgoing edges (the module-centric path).
function bindsToGraph(): { graph: RepositoryGraph; snapshot: RepositoryFactsSnapshot } {
  const graph = createEmptyGraph();
  addNode(graph, { id: 'mod:app/config', type: 'module', label: 'config.ts', description: 'config module' });
  addNode(graph, {
    id: 'resource:aws-dynamodb:UsersTable',
    type: 'runtime-resource',
    label: 'UsersTable',
    description: 'resource',
    data: { kind: 'table', provider: 'aws' },
  });
  addEdge(graph, 'mod:app/config', 'resource:aws-dynamodb:UsersTable', 'binds_to');
  return {
    graph,
    snapshot: { repoRoot: '/repo', timestamp: '2024-01-01', packages: [], modules: [moduleInfo('mod:app/config')] },
  };
}

// uses_env is runtime-resource → runtime-resource (an env-ref to another resource); both producers
// emit this shape (infra-runtime-links/graph.ts). The load-bearing consumer is the resource→resource
// secret surface in config-surface (the path that surfaces secrets consumed by resources without a
// code handler) — NOT the module-centric path. Witnessing it as module→resource would only exercise
// a branch the producer never creates, so this builds the real resource→resource secret edge.
function secretUsesEnvGraph(): { graph: RepositoryGraph; snapshot: RepositoryFactsSnapshot } {
  const graph = createEmptyGraph();
  addNode(graph, {
    id: 'resource:aws-lambda:ApiFn',
    type: 'runtime-resource',
    label: 'ApiFn',
    description: 'Lambda',
    data: { kind: 'lambda', provider: 'aws' },
  });
  addNode(graph, {
    id: 'resource:aws-secretsmanager:DbSecret',
    type: 'runtime-resource',
    label: 'DbSecret',
    description: 'secret',
    data: { kind: 'secret', provider: 'aws' },
  });
  addEdge(graph, 'resource:aws-lambda:ApiFn', 'resource:aws-secretsmanager:DbSecret', 'uses_env');
  return { graph, snapshot: { repoRoot: '/repo', timestamp: '2024-01-01', packages: [], modules: [] } };
}

function configSurfaceProjection(snapshot: RepositoryFactsSnapshot): (graph: RepositoryGraph) => unknown {
  return graph => {
    const surface = collectConfigSurface(lawRuntime(graph, snapshot), { scope: 'all', kind: 'all', limit: 100 });
    return surface.items.map(item => ({
      kind: item.kind,
      relation: item.relation,
      name: item.name,
      resourceId: item.resourceId,
    }));
  };
}

function runtimeFlowGraph(edgeKinds: Array<'publishes' | 'consumes'> = ['publishes', 'consumes']): RepositoryGraph {
  const graph = createEmptyGraph();
  addNode(graph, { id: 'resource:aws-lambda:Producer', type: 'runtime-resource', label: 'Producer', description: 'Lambda' });
  addNode(graph, { id: 'resource:aws-sqs:Jobs', type: 'runtime-resource', label: 'Jobs', description: 'Queue' });
  addNode(graph, { id: 'resource:aws-lambda:Worker', type: 'runtime-resource', label: 'Worker', description: 'Lambda' });
  if (edgeKinds.includes('publishes')) addEdge(graph, 'resource:aws-lambda:Producer', 'resource:aws-sqs:Jobs', 'publishes');
  if (edgeKinds.includes('consumes')) addEdge(graph, 'resource:aws-sqs:Jobs', 'resource:aws-lambda:Worker', 'consumes');
  return graph;
}

function topologyProjection(graph: RepositoryGraph): Record<string, unknown> {
  const result = projectRuntimeTopology(lawRuntime(graph), {}) as Record<string, unknown>;
  return {
    dataFlows: result.dataFlows ?? [],
    services: (result.services as Array<Record<string, unknown>>).map(service => ({
      label: service.label,
      // `handler` is the IaC declaration; `handlerModules` is what the infra edge resolved to.
      // The infra edge witnesses the second, so both belong in the ablation projection.
      handler: service.handler,
      handlerModules: service.handlerModules ?? [],
      publishes: service.publishes ?? [],
      routesTo: service.routesTo ?? [],
      routedFrom: service.routedFrom ?? [],
    })),
  };
}

function infraGraph(): RepositoryGraph {
  const graph = createEmptyGraph();
  addNode(graph, {
    id: 'resource:aws-lambda:HandlerFunction',
    type: 'runtime-resource',
    label: 'HandlerFunction',
    description: 'Lambda',
  });
  addNode(graph, { id: 'mod:app/handler', type: 'module', label: 'handler.ts', description: 'handler module' });
  addEdge(graph, 'resource:aws-lambda:HandlerFunction', 'mod:app/handler', 'infra');
  return graph;
}

function importsGraph(): { graph: RepositoryGraph; snapshot: RepositoryFactsSnapshot } {
  const graph = createEmptyGraph();
  addNode(graph, { id: 'mod:app/source', type: 'module', label: 'source.ts', description: 'source module' });
  addNode(graph, { id: 'mod:app/target', type: 'module', label: 'target.ts', description: 'target module' });
  addEdge(graph, 'mod:app/source', 'mod:app/target', 'imports');
  const source = moduleInfo('mod:app/source', [
    { moduleSpecifier: './target', resolvedModuleId: 'mod:app/target', importedNames: ['target'], isTypeOnly: false, isExternal: false },
  ]);
  return {
    graph,
    snapshot: { repoRoot: '/repo', timestamp: '2024-01-01', packages: [], modules: [source, moduleInfo('mod:app/target')] },
  };
}

// reexports is barrel → re-exported module. The load-bearing consumer is analyze_dependencies
// impact: "who depends on the leaf" includes the barrel that re-exports it. Ablating reexports drops
// the barrel from the leaf's downstream.
function reExportsGraph(): RepositoryGraph {
  const graph = createEmptyGraph();
  addNode(graph, { id: 'mod:pkg/index', type: 'module', label: 'index.ts', description: 'barrel' });
  addNode(graph, { id: 'mod:pkg/utils', type: 'module', label: 'utils.ts', description: 'leaf' });
  addEdge(graph, 'mod:pkg/index', 'mod:pkg/utils', 'reexports');
  return graph;
}

function implementsGraph(): RepositoryGraph {
  const graph = createEmptyGraph();
  addNode(graph, { id: 'mod:app/ports', type: 'module', label: 'ports.ts', description: 'ports module' });
  addNode(graph, { id: 'mod:app/repo', type: 'module', label: 'repo.ts', description: 'repo module' });
  addNode(graph, {
    id: 'export:app/ports/IRepo',
    type: 'export-symbol',
    label: 'IRepo',
    description: 'interface',
    data: { symbolKind: 'interface' },
  });
  addNode(graph, {
    id: 'export:app/repo/SqlRepo',
    type: 'export-symbol',
    label: 'SqlRepo',
    description: 'class',
    data: { symbolKind: 'class', signature: 'class SqlRepo' },
  });
  addEdge(graph, 'mod:app/ports', 'export:app/ports/IRepo', 'contains');
  addEdge(graph, 'mod:app/repo', 'export:app/repo/SqlRepo', 'contains');
  addEdge(graph, 'export:app/repo/SqlRepo', 'export:app/ports/IRepo', 'implements');
  return graph;
}

function routesToGraph(): RepositoryGraph {
  const graph = createEmptyGraph();
  addNode(graph, { id: 'resource:k8s:_/Ingress/web-ingress', type: 'runtime-resource', label: 'web-ingress', description: 'Service' });
  addNode(graph, { id: 'resource:k8s:_/Service/web', type: 'runtime-resource', label: 'web', description: 'Service' });
  addEdge(graph, 'resource:k8s:_/Ingress/web-ingress', 'resource:k8s:_/Service/web', 'routes_to');
  return graph;
}

// renders is render-unit -> template. The load-bearing consumer is analyze_dependencies impact:
// "who renders home.html" = the template's dependents. Ablating renders drops the render unit from
// that answer (template composition).
function rendersGraph(): RepositoryGraph {
  const graph = createEmptyGraph();
  addNode(graph, { id: 'mod:app/views', type: 'module', label: 'views.py', description: 'views module' });
  addNode(graph, {
    id: 'template:app/templates/home.html',
    type: 'template',
    label: 'home.html',
    description: 'template',
    data: { relPath: 'app/templates/home.html' },
  });
  addEdge(graph, 'mod:app/views', 'template:app/templates/home.html', 'renders');
  return graph;
}

// extends/includes are template → template composition edges. The load-bearing consumer is the same
// impact query as renders, but now "who depends on base/partial" walks page → layout/partial and then
// transitively back to the rendering view.
function templateCompositionGraph(): RepositoryGraph {
  const graph = rendersGraph();
  addNode(graph, {
    id: 'template:app/templates/base.html',
    type: 'template',
    label: 'base.html',
    description: 'base template',
    data: { relPath: 'app/templates/base.html' },
  });
  addNode(graph, {
    id: 'template:app/templates/partials/nav.html',
    type: 'template',
    label: 'nav.html',
    description: 'partial template',
    data: { relPath: 'app/templates/partials/nav.html' },
  });
  addEdge(graph, 'template:app/templates/home.html', 'template:app/templates/base.html', 'extends');
  addEdge(graph, 'template:app/templates/home.html', 'template:app/templates/partials/nav.html', 'includes');
  return graph;
}

type ConsumerWitness = (() => void) | 'carveout';

/**
 * Consumer registry: every EdgeKind is either witnessed by an ablation/differential check or an
 * explicit structural `carveout`. The `Record<EdgeKind, …>` type documents that intent and flags a
 * missing kind in the IDE, but it is NOT the enforced gate — test files are excluded from tsconfig
 * and transpiled with isolatedModules, so type errors here never fail CI. The enforced gate is the
 * runtime meta test below: it pins the registry to exactly EDGE_KINDS and the carveout set to exactly
 * the structural pair, so a new kind without a witness — or a load-bearing kind silently marked
 * `carveout` to dodge one — fails at run time. This closes the producer/consumer asymmetry:
 * producers are exhaustive over EdgeKind, and now so is the consumer side.
 */
const CONSUMER_WITNESSES: Record<EdgeKind, ConsumerWitness> = {
  // Structural / navigation edges: witnessed through graph navigation + scope/domain lookup, not ablation.
  contains: 'carveout',
  tagged: 'carveout',
  // Load-bearing non-structural edges: each must change a query tool's answer when ablated.
  uses_env: () => {
    const { graph, snapshot } = secretUsesEnvGraph();
    expectDifferential('uses_env', graph, configSurfaceProjection(snapshot));
  },
  binds_to: () => {
    const { graph, snapshot } = bindsToGraph();
    expectDifferential('binds_to', graph, configSurfaceProjection(snapshot));
  },
  publishes: () => expectDifferential('publishes', runtimeFlowGraph(), topologyProjection),
  consumes: () => expectDifferential('consumes', runtimeFlowGraph(), topologyProjection),
  infra: () => expectDifferential('infra', infraGraph(), topologyProjection),
  imports: () => {
    const { graph, snapshot } = importsGraph();
    expectDifferential('imports', graph, candidate => {
      const result = deliveredValue(analyzeImpact(lawRuntime(candidate, snapshot), { nodeId: 'mod:app/target' })) as {
        downstream: Array<{ id: string }>;
      };
      return result.downstream.map(entry => entry.id).sort();
    });
  },
  reexports: () => {
    expectDifferential('reexports', reExportsGraph(), candidate => {
      const result = deliveredValue(analyzeImpact(lawRuntime(candidate), { nodeId: 'mod:pkg/utils' })) as {
        downstream: Array<{ id: string }>;
      };
      return result.downstream.map(entry => entry.id).sort();
    });
  },
  implements: () => {
    expectDifferential('implements', implementsGraph(), candidate => {
      const result = findInterfaceImplementations(lawRuntime(candidate), { interfaceName: 'IRepo' }) as {
        implementations: Array<{ classId: string }>;
      };
      return result.implementations.map(entry => entry.classId).sort();
    });
  },
  routes_to: () => expectDifferential('routes_to', routesToGraph(), topologyProjection),
  renders: () => {
    expectDifferential('renders', rendersGraph(), candidate => {
      const result = deliveredValue(analyzeImpact(lawRuntime(candidate), { nodeId: 'template:app/templates/home.html' })) as {
        downstream: Array<{ id: string }>;
      };
      return result.downstream.map(entry => entry.id).sort();
    });
  },
  extends: () => {
    expectDifferential('extends', templateCompositionGraph(), candidate => {
      const result = deliveredValue(analyzeImpact(lawRuntime(candidate), { nodeId: 'template:app/templates/base.html' })) as {
        downstream: Array<{ id: string }>;
      };
      return result.downstream.map(entry => entry.id).sort();
    });
  },
  includes: () => {
    expectDifferential('includes', templateCompositionGraph(), candidate => {
      const result = deliveredValue(analyzeImpact(lawRuntime(candidate), { nodeId: 'template:app/templates/partials/nav.html' })) as {
        downstream: Array<{ id: string }>;
      };
      return result.downstream.map(entry => entry.id).sort();
    });
  },
};

const STRUCTURAL_CARVEOUTS = ['contains', 'tagged'] as const;

describe('core-laws edge-witness consumer side (D6 differential)', () => {
  const entries = Object.entries(CONSUMER_WITNESSES) as Array<[EdgeKind, ConsumerWitness]>;
  const witnessedKinds = entries.filter(([, w]) => typeof w === 'function').map(([kind]) => kind);

  it('covers every EdgeKind as either a witness or an explicit structural carveout', () => {
    const carveouts = entries.filter(([, w]) => w === 'carveout').map(([kind]) => kind).sort();
    // Only structural edges may skip the ablation witness; nothing load-bearing hides here.
    expect(carveouts).toEqual([...STRUCTURAL_CARVEOUTS].sort());
    // Registry spans exactly the canonical EdgeKind set (also enforced at compile time by Record<EdgeKind>).
    expect([...carveouts, ...witnessedKinds].sort()).toEqual([...EDGE_KINDS].sort());
  });

  it.each(witnessedKinds)('%s changes its consumer query when ablated', kind => {
    (CONSUMER_WITNESSES[kind] as () => void)();
  });
});
