import { asRepoRelPath } from '@repovine/plugin-sdk';
import { asHostPath, asPkgRelPath } from '@repovine/plugin-sdk';
import { describe, expect, it } from '@jest/globals';
import { buildDeclarationCatalog } from '../../src/plugin-host/declaration-catalog.js';
import { presetDeclarationCatalog } from '../../src/plugin-host/load.js';
import { composeRepositoryGraph } from '../../src/stage2/index.js';
import { projectRuntimeTopology } from '../../src/mcp/lib/topology.js';
import { ALL_SCOPE } from '../../src/scope/resolved.js';
import type { McpToolRuntime } from '../../src/mcp/types.js';
import type {
  InfraModuleInfo,
  ModuleInfo,
  RepositoryFactsSnapshot,
  RepositoryGraph,
} from '../../src/types.js';
import type { StampedDeclarationCatalog } from '@repovine/plugin-sdk';

/**
 * Law: what a runtime resource means is declared, not recognised.
 *
 * Three passes used to read AWS out of a value: `kind === 'lambda'` decided which resources carry
 * code, an id prefix decided where a runtime call writes, and another id prefix decided the service
 * label the topology publishes. Each is now a declaration, so an ecosystem nobody has heard of gets
 * the same linking by declaring — and the engine that stopped recognising AWS also stopped
 * recognising `zephyr`.
 *
 * The fixtures below therefore use an invented ecosystem end to end. A green run means no core table
 * names a provider, kind or action: a core that still branched would link nothing here.
 */

const OWNER = { pluginId: 'zephyr', packageName: 'repovine-plugin-zephyr', packageVersion: '1.0.0' };

function stamped(entries: Partial<StampedDeclarationCatalog>): StampedDeclarationCatalog {
  return {
    dirs: [],
    values: [],
    resourceKinds: [],
    triggerTypes: [],
    runtimeActions: [],
    ...entries,
  };
}

/** What the zephyr plugin declares: its compute kind carries code, its bus kind is a service. */
const ZEPHYR = stamped({
  resourceKinds: [
    {
      namespace: 'zephyr-compute',
      provider: 'zephyr',
      kind: 'worker',
      service: 'worker',
      hasCodeHandler: true,
      declaredBy: OWNER,
    },
    // The service label deliberately differs from the kind: an engine reading `kind` back would
    // answer 'channel' and look right, which is how a guess passes for a declaration.
    { namespace: 'zephyr-bus', provider: 'zephyr', kind: 'channel', service: 'bus', declaredBy: OWNER },
  ],
  triggerTypes: [
    { type: 'channel-message', provider: 'zephyr', isStreamLike: true, entrypointKind: 'queue-consumer', declaredBy: OWNER },
  ],
  runtimeActions: [{ action: 'zephyr.emit', namespace: 'zephyr-bus', declaredBy: OWNER }],
});

function zephyrInfra(): InfraModuleInfo[] {
  return [{
    id: 'infra:zephyr:deploy.zephyr',
    kind: 'zephyr',
    absPath: asHostPath('/repo/deploy.zephyr'),
    repoRelPath: asRepoRelPath('deploy.zephyr'),
    contentHash: 'z1',
    resources: [
      {
        id: 'Emitter',
        kind: 'worker',
        provider: 'zephyr',
        identity: { namespace: 'zephyr-compute', localKey: 'Emitter' },
        contentHash: 'w1',
        attributes: { handler: 'handler.main' },
        envRefs: [{ varName: 'EVENTS_CHANNEL', refType: 'ref', targetLogicalId: 'Events' }],
        triggers: [{ type: 'channel-message', name: 'Incoming', queueRef: 'Events' }],
      },
      {
        id: 'Events',
        kind: 'channel',
        provider: 'zephyr',
        identity: { namespace: 'zephyr-bus', localKey: 'Events' },
        contentHash: 'c1',
        attributes: {},
      },
    ],
  }];
}

function handlerModule(): ModuleInfo {
  return {
    id: 'mod:app/handler',
    packageName: 'app',
    absPath: asHostPath('/repo/handler.ts'),
    pkgRelPath: asPkgRelPath('handler.ts'),
    contentHash: 'h1',
    imports: [],
    exports: [],
    sourcePluginId: 'typescript',
    semanticHints: {
      envVars: ['EVENTS_CHANNEL'],
      runtimeActions: [{ action: 'zephyr.emit', envVar: 'EVENTS_CHANNEL' }],
    },
  };
}

function snapshotWith(declarations: StampedDeclarationCatalog[]): RepositoryFactsSnapshot {
  return {
    repoRoot: '/repo',
    timestamp: new Date(0).toISOString(),
    packages: [{ name: 'app', repoRelDir: asRepoRelPath('.'), sourcePluginId: 'typescript' }],
    modules: [handlerModule()],
    infraModules: zephyrInfra(),
    declarations: buildDeclarationCatalog({ catalogs: declarations }),
  };
}

function edgeKinds(graph: RepositoryGraph, from: string): Array<[string, string]> {
  return (graph.outEdges.get(from) ?? []).map(edge => [edge.kind, edge.to] as [string, string]).sort();
}

describe('core-laws runtime resource semantics come from declarations', () => {
  it('links an invented ecosystem the same way it links a bundled one', () => {
    const graph = composeRepositoryGraph(snapshotWith([ZEPHYR]));
    const worker = 'resource:zephyr-compute:Emitter';
    const channel = 'resource:zephyr-bus:Events';

    // hasCodeHandler: the declared kind resolves its handler attribute to a module…
    expect(edgeKinds(graph, worker)).toContainEqual(['infra', 'mod:app/handler']);
    // …the handler module inherits the resource's env bindings…
    expect(edgeKinds(graph, 'mod:app/handler')).toContainEqual(['binds_to', channel]);
    // …a runtime action reaches the namespace its declaration names…
    expect(edgeKinds(graph, worker)).toContainEqual(['publishes', channel]);
    // …and a stream-like trigger drives the consumer.
    expect(edgeKinds(graph, channel)).toContainEqual(['consumes', worker]);
  });

  it('links nothing when the same resources arrive with no declaration behind them', () => {
    const graph = composeRepositoryGraph(snapshotWith([]));
    const worker = 'resource:zephyr-compute:Emitter';

    // The resources are still nodes: the graph carries what a producer emitted either way.
    expect(graph.nodes.has(worker)).toBe(true);
    expect(graph.nodes.has('resource:zephyr-bus:Events')).toBe(true);
    // What it does not do is guess. No handler edge, no publish edge, no consumes edge.
    const kinds = edgeKinds(graph, worker).map(([kind]) => kind);
    expect(kinds).not.toContain('infra');
    expect(kinds).not.toContain('publishes');
    expect(edgeKinds(graph, 'resource:zephyr-bus:Events').map(([kind]) => kind)).not.toContain('consumes');
  });

  it('publishes the declared service label, and a plain resource when none was declared', () => {
    const graph = composeRepositoryGraph(snapshotWith([ZEPHYR]));
    const ctx = { getState: () => ({ graph }) } as unknown as McpToolRuntime;
    const topology = projectRuntimeTopology(ctx, { scope: ALL_SCOPE }) as {
      services: Array<{ id: string; publishes?: Array<{ type: string; target: string }> }>;
    };

    const emitter = topology.services.find(service => service.id === 'resource:zephyr-compute:Emitter');
    expect(emitter?.publishes).toEqual([
      { type: 'bus', target: 'resource:zephyr-bus:Events', label: 'Events' },
    ]);

    // An undeclared kind is reported as a resource rather than given a label the engine invented.
    const undeclared = composeRepositoryGraph(snapshotWith([stamped({
      resourceKinds: [{
        namespace: 'zephyr-compute',
        provider: 'zephyr',
        kind: 'worker',
        hasCodeHandler: true,
        declaredBy: OWNER,
      }],
      runtimeActions: [{ action: 'zephyr.emit', namespace: 'zephyr-bus', declaredBy: OWNER }],
    })]));
    const plainCtx = { getState: () => ({ graph: undeclared }) } as unknown as McpToolRuntime;
    const plain = projectRuntimeTopology(plainCtx, { scope: ALL_SCOPE }) as {
      services: Array<{ id: string; publishes?: Array<{ type: string }> }>;
    };
    expect(plain.services.find(s => s.id === 'resource:zephyr-compute:Emitter')?.publishes)
      .toEqual([{ type: 'resource', target: 'resource:zephyr-bus:Events', label: 'Events' }]);
  });

  it('sends a runtime action only to the namespace its declaration names', () => {
    const misdirected = stamped({
      resourceKinds: ZEPHYR.resourceKinds,
      triggerTypes: ZEPHYR.triggerTypes,
      // The same action, declared against a namespace nothing in this repository mints.
      runtimeActions: [{ action: 'zephyr.emit', namespace: 'zephyr-archive', declaredBy: OWNER }],
    });
    const graph = composeRepositoryGraph(snapshotWith([misdirected]));

    // The handler still binds to the channel through its env ref; what it does not do is publish to
    // it, because the declaration says the call goes somewhere else.
    expect(edgeKinds(graph, 'mod:app/handler')).toContainEqual(['binds_to', 'resource:zephyr-bus:Events']);
    expect(edgeKinds(graph, 'resource:zephyr-compute:Emitter').map(([kind]) => kind))
      .not.toContain('publishes');
  });

  it('carries the bundled preset declarations on a build that names no plugins', () => {
    // The gate for the whole channel: a default build's catalog is what the shipped packages
    // declare. When it is empty, every pass above silently links nothing.
    const { catalog, problems } = presetDeclarationCatalog();
    expect(problems).toEqual([]);

    const keys = catalog.resourceKinds.map(record => record.key);
    expect(keys).toContain('resource-kind:aws-lambda/aws/lambda');
    expect(keys).toContain('resource-kind:terraform/terraform/lambda');
    expect(keys).toContain('resource-kind:vercel/vercel/vercel-function');
    // Every declaration is stamped from its own package, so a reader can name who declared it.
    for (const record of catalog.resourceKinds) {
      for (const declaration of record.declarations) {
        expect(declaration.declaredBy.packageName).toMatch(/^@repovine\/plugin-iac-/);
        expect(declaration.declaredBy.packageVersion).toMatch(/^\d+\.\d+\.\d+/);
      }
    }
    expect(catalog.runtimeActions.map(record => record.key))
      .toEqual(['runtime-action:lambda.invoke', 'runtime-action:sns.publish', 'runtime-action:sqs.sendMessage']);
  });
});
