import { afterEach, describe, expect, it } from '@jest/globals';
import { createEmptyGraph } from '../../../../src/graph/index.js';
import { contributeStructural } from '../../../../src/interpreters/code-structure/graph.js';
import { contributeInfraLink } from '../../../../src/interpreters/infra-runtime-links/graph.js';
import type { DomainsConfig } from '../../../../src/stage2/domains.js';
import type { InfraModuleInfo, ModuleInfo, RepositoryFactsSnapshot } from '../../../../src/types.js';
import { setSourcePluginsForTest } from '../../../../src/stage1/source/registry.js';
import type { SourcePlugin } from '@repovine/plugin-sdk';

let restoreSourcePlugins: (() => void) | undefined;

afterEach(() => {
  restoreSourcePlugins?.();
  restoreSourcePlugins = undefined;
});

function sourceModule(options: {
  id?: string;
  packageName?: string;
  filePath?: string;
  relativeFilePath?: string;
  sourcePluginId?: string;
} = {}): ModuleInfo {
  return {
    id: options.id ?? 'mod:app/handler',
    packageName: options.packageName ?? 'app',
    filePath: options.filePath ?? '/repo/handler.ts',
    relativeFilePath: options.relativeFilePath ?? 'handler.ts',
    contentHash: 'h',
    imports: [],
    exports: [],
    sourcePluginId: options.sourcePluginId ?? 'typescript',
  };
}

function infraModule(
  handler = 'handler.handler',
  attributes: Record<string, string> = {},
): InfraModuleInfo {
  return {
    id: 'infra:sam:template',
    kind: 'sam',
    filePath: '/repo/template.yaml',
    relativeFilePath: 'template.yaml',
    contentHash: 't',
    resources: [
      {
        id: 'MyFn',
        kind: 'lambda',
        provider: 'aws',
        identity: { namespace: 'aws-lambda', localKey: 'MyFn' },
        contentHash: 'fn',
        attributes: { ...attributes, handler },
      },
      {
        id: 'AlarmNoise',
        kind: 'alarm',
        provider: 'aws',
        identity: { namespace: 'aws', localKey: 'AlarmNoise' },
        contentHash: 'al',
        attributes: {},
      },
    ],
  };
}

function snapshotWith(
  infra: InfraModuleInfo[],
  modules: ModuleInfo[] = [sourceModule()],
  packages: RepositoryFactsSnapshot['packages'] = [
    { name: 'app', path: '.', sourcePluginId: 'typescript' },
  ],
): RepositoryFactsSnapshot {
  return {
    repoRoot: '/repo',
    timestamp: '2026-06-13T00:00:00.000Z',
    packages,
    modules,
    infraModules: infra,
  };
}

function hasInfraEdgeTo(graph: ReturnType<typeof createEmptyGraph>, to: string): boolean {
  return (graph.outEdges.get('resource:aws-lambda:MyFn') ?? []).some(
    e => e.kind === 'infra' && e.to === to,
  );
}

function stubPlugin(id: string, capabilities?: SourcePlugin['capabilities']): SourcePlugin {
  return {
    id,
    capabilities,
    discover: () => ({ packages: [], pendingByPath: new Map() }),
    extract: () => ({ deltas: [], reused: 0, rescanned: 0 }),
  };
}

describe('infra-link layer graph contribution', () => {
  it('creates runtime-resource nodes and links a resolved handler with an infra edge', () => {
    const snapshot = snapshotWith([infraModule()]);
    const graph = createEmptyGraph();
    const modulesById = new Map(snapshot.modules.map(m => [m.id, m]));
    contributeStructural(graph, snapshot);
    contributeInfraLink(graph, snapshot, modulesById, null);

    const fn = graph.nodes.get('resource:aws-lambda:MyFn');
    expect(fn?.type).toBe('runtime-resource');
    expect(fn?.data).toMatchObject({ kind: 'lambda', provider: 'aws', handler: 'handler.handler' });

    // Handler string "handler.handler" resolves to mod:app/handler → infra edge.
    expect(hasInfraEdgeTo(graph, 'mod:app/handler')).toBe(true);
  });

  it('preserves Python dotted handler resolution through the built-in source capability', () => {
    const mod = sourceModule({
      id: 'mod:app/handler',
      filePath: '/repo/handler.py',
      relativeFilePath: 'handler.py',
      sourcePluginId: 'python',
    });
    const snapshot = snapshotWith(
      [infraModule()],
      [mod],
      [{ name: 'app', path: '.', sourcePluginId: 'python' }],
    );
    const graph = createEmptyGraph();
    const modulesById = new Map(snapshot.modules.map(m => [m.id, m]));
    contributeStructural(graph, snapshot);
    contributeInfraLink(graph, snapshot, modulesById, null);

    expect(hasInfraEdgeTo(graph, 'mod:app/handler')).toBe(true);
  });

  it('prefers the CodeUri package when two TypeScript packages have the same handler basename', () => {
    const operatorHealth = sourceModule({
      id: 'mod:@lmtify/operator/src/health',
      packageName: '@lmtify/operator',
      filePath: '/repo/infrastructure/k8s-services/lmtify-operator/src/health.ts',
      relativeFilePath: 'src/health.ts',
      sourcePluginId: 'typescript',
    });
    const lambdaHealth = sourceModule({
      id: 'mod:@acme/lambda-functions/src/health',
      packageName: '@acme/lambda-functions',
      filePath: '/repo/packages/lambda-functions/src/health.ts',
      relativeFilePath: 'src/health.ts',
      sourcePluginId: 'typescript',
    });
    const snapshot = snapshotWith(
      [infraModule('health.handler', { codeUri: 'packages/lambda-functions/dist-bundled/health' })],
      [operatorHealth, lambdaHealth],
      [
        {
          name: '@lmtify/operator',
          path: 'infrastructure/k8s-services/lmtify-operator',
          sourcePluginId: 'typescript',
        },
        {
          name: '@acme/lambda-functions',
          path: 'packages/lambda-functions',
          sourcePluginId: 'typescript',
        },
      ],
    );
    const graph = createEmptyGraph();
    const modulesById = new Map(snapshot.modules.map(m => [m.id, m]));
    contributeStructural(graph, snapshot);
    contributeInfraLink(graph, snapshot, modulesById, null);

    expect(hasInfraEdgeTo(graph, 'mod:@acme/lambda-functions/src/health')).toBe(true);
    expect(hasInfraEdgeTo(graph, 'mod:@lmtify/operator/src/health')).toBe(false);
  });

  it('lets a source plugin resolve a Java FQCN handler shape', () => {
    restoreSourcePlugins = setSourcePluginsForTest([
      stubPlugin('java', {
        extensions: ['.java'],
        resolveHandlerToModule(handlerRef, ctx) {
          const [fqcn] = handlerRef.split('::');
          if (!fqcn) return undefined;
          const rel = `src/main/java/${fqcn.replace(/\./g, '/')}.java`;
          return ctx.resolveModuleByRepoPath(rel);
        },
      }),
    ]);
    const mod = sourceModule({
      id: 'mod:java-app/src/main/java/com/example/Handler',
      packageName: 'java-app',
      filePath: '/repo/src/main/java/com/example/Handler.java',
      relativeFilePath: 'src/main/java/com/example/Handler.java',
      sourcePluginId: 'java',
    });
    const snapshot = snapshotWith(
      [infraModule('com.example.Handler::handleRequest')],
      [mod],
      [{ name: 'java-app', path: '.', sourcePluginId: 'java' }],
    );
    const graph = createEmptyGraph();
    const modulesById = new Map(snapshot.modules.map(m => [m.id, m]));
    contributeStructural(graph, snapshot);
    contributeInfraLink(graph, snapshot, modulesById, null);

    expect(hasInfraEdgeTo(graph, 'mod:java-app/src/main/java/com/example/Handler')).toBe(true);
  });

  it('links env-ref to a secret resource via base edges; secret stays distinguishable by target.kind (service→service and handler module→secret)', () => {
    const infra: InfraModuleInfo = {
      id: 'infra:sam:template',
      kind: 'sam',
      filePath: '/repo/template.yaml',
      relativeFilePath: 'template.yaml',
      contentHash: 't',
      resources: [
        {
          id: 'MyFn',
          kind: 'lambda',
          provider: 'aws',
          identity: { namespace: 'aws-lambda', localKey: 'MyFn' },
          contentHash: 'fn',
          attributes: { handler: 'handler.handler' },
          envVars: ['DB_SECRET'],
          envRefs: [{ varName: 'DB_SECRET', refType: 'ref', targetLogicalId: 'DbSecret' }],
        },
        {
          id: 'DbSecret',
          kind: 'secret',
          provider: 'aws',
          identity: { namespace: 'aws', localKey: 'DbSecret' },
          contentHash: 'sec',
          attributes: {},
        },
      ],
    };
    const snapshot = snapshotWith([infra]);
    const graph = createEmptyGraph();
    const modulesById = new Map(snapshot.modules.map(m => [m.id, m]));
    contributeStructural(graph, snapshot);
    contributeInfraLink(graph, snapshot, modulesById, null);

    const secretId = 'resource:aws:DbSecret';
    expect(graph.nodes.get(secretId)?.data).toMatchObject({ kind: 'secret', provider: 'aws' });

    const hasEdge = (from: string, kind: string): boolean =>
      (graph.outEdges.get(from) ?? []).some(e => e.kind === kind && e.to === secretId);

    // Lambda → secret resource is the generic uses_env edge; secret-ness is read off target.data.kind.
    expect(hasEdge('resource:aws-lambda:MyFn', 'uses_env')).toBe(true);

    // Handler module → secret is the generic binds_to edge; get_config_surface reports kind:'secret'
    // by reading target.data.kind === 'secret', not from a dedicated edge kind.
    expect(hasEdge('mod:app/handler', 'binds_to')).toBe(true);
  });

  it('produces a consumes edge (queue → consumer lambda) from a stream-like trigger through the interpreter', () => {
    // Queue resource + a consumer lambda whose sqs trigger points back at the queue's logical id.
    const infra: InfraModuleInfo = {
      id: 'infra:sam:template',
      kind: 'sam',
      filePath: '/repo/template.yaml',
      relativeFilePath: 'template.yaml',
      contentHash: 't',
      resources: [
        {
          id: 'WorkQueue',
          kind: 'queue',
          provider: 'aws',
          identity: { namespace: 'aws-sqs', localKey: 'WorkQueue' },
          contentHash: 'q',
          attributes: {},
        },
        {
          id: 'MyFn',
          kind: 'lambda',
          provider: 'aws',
          identity: { namespace: 'aws-lambda', localKey: 'MyFn' },
          contentHash: 'fn',
          attributes: { handler: 'handler.handler' },
          triggers: [{ name: 'FromQueue', type: 'sqs', queueRef: 'WorkQueue' }],
        },
        {
          // Control: a non-stream-like trigger with a queueRef must NOT yield a consumes edge.
          id: 'HttpFn',
          kind: 'lambda',
          provider: 'aws',
          identity: { namespace: 'aws-lambda', localKey: 'HttpFn' },
          contentHash: 'hfn',
          attributes: { handler: 'handler.handler' },
          triggers: [{ name: 'FromApi', type: 'http', queueRef: 'WorkQueue' }],
        },
      ],
    };
    const snapshot = snapshotWith([infra]);
    const graph = createEmptyGraph();
    const modulesById = new Map(snapshot.modules.map(m => [m.id, m]));
    contributeStructural(graph, snapshot);
    contributeInfraLink(graph, snapshot, modulesById, null);

    const queueId = 'resource:aws-sqs:WorkQueue';
    const consumesTargets = (graph.outEdges.get(queueId) ?? [])
      .filter(e => e.kind === 'consumes')
      .map(e => e.to);
    // Stream-like sqs trigger → exactly the consumer lambda; the http-triggered lambda is excluded.
    expect(consumesTargets).toEqual(['resource:aws-lambda:MyFn']);
  });

  it('honors infra resource excludes from the threaded domains config (T2)', () => {
    const snapshot = snapshotWith([infraModule()]);
    const graph = createEmptyGraph();
    const modulesById = new Map(snapshot.modules.map(m => [m.id, m]));
    const config = { infra: { excludeSuffixes: ['Noise'] } } as DomainsConfig;
    contributeStructural(graph, snapshot);
    contributeInfraLink(graph, snapshot, modulesById, config);

    const serviceLabels = [...(graph.byType.get('runtime-resource') ?? [])].map(id => graph.nodes.get(id)?.label);
    expect(serviceLabels).toContain('MyFn');
    expect(serviceLabels).not.toContain('AlarmNoise');
  });
});
