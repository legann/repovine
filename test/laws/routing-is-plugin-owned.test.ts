import { asRepoRelPath } from '@repovine/plugin-sdk';
import { asHostPath } from '@repovine/plugin-sdk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';
import ts from 'typescript';
import type {
  IaCParser,
  InfraResource,
  PluginProjectionBatch,
  ProjectionContributor,
  ReadonlyFactRecord,
  ReadonlyProjectionInput,
  SemanticInfraDelta,
  SemanticLinkContribution,
} from '@repovine/plugin-sdk';
import { collectInfraModules } from '../../src/stage1/infra.js';
import { composeRepositoryGraph } from '../../src/stage2/index.js';
import type { RepositoryFactsSnapshot, RepositoryGraph } from '../../src/types.js';
import { attachProjectors, installOneMore, restoreBuiltinPlugins } from '../helpers/plugins.js';
import { repoRoot, sourceFiles } from './graph-law-helpers.js';

/**
 * Law: routing between infrastructure resources belongs to the plugin that understands it.
 *
 * A relation between two resources is a statement about one ecosystem's semantics: which name an
 * edge router resolves, and how far that name reaches. The engine draws the edge and knows neither.
 *
 * The ecosystem below exists nowhere but this file. Its provider, its object kinds, its scope
 * spelling and its routing rule are all invented here, and each reaches the graph through the same
 * contract Kubernetes uses. A green run means the corresponding core branch does not exist: a core
 * that still recognised one ecosystem would leave this one unrouted.
 */

const PLUGIN_ID = 'meridian';
const SCHEMA = 'meridian/object@1';

interface MeridianObject {
  localKey: string;
  objectKind: string;
  name: string;
  refScope: string;
  backends: readonly string[];
}

function meridianResource(object: MeridianObject): InfraResource {
  return {
    id: object.name,
    kind: 'meridian-node',
    provider: 'meridian',
    identity: { namespace: 'meridian', localKey: object.localKey },
    refScope: object.refScope,
    contentHash: object.localKey,
    attributes: { objectKind: object.objectKind },
  };
}

function meridianFact(object: MeridianObject): ReadonlyFactRecord {
  return {
    schema: SCHEMA,
    subjectRef: { type: 'resource', namespace: 'meridian', localKey: object.localKey },
    value: { ...object, backends: [...object.backends] },
  };
}

/**
 * The routing this ecosystem declares: an `edge` object names `target` objects by bare name, and
 * that name reaches its own zone only.
 */
const meridianRouter: ProjectionContributor = {
  id: 'meridian-routes',
  requires: [{ schema: SCHEMA }],
  project(input: ReadonlyProjectionInput): readonly PluginProjectionBatch[] {
    const objects = input.facts
      .select({ schema: SCHEMA })
      .map(record => record.value as unknown as MeridianObject);
    const targets = new Map<string, MeridianObject>();
    for (const object of objects) {
      if (object.objectKind === 'target') targets.set(`${object.refScope} ${object.name}`, object);
    }

    const batches: PluginProjectionBatch[] = [];
    for (const edge of objects) {
      if (edge.backends.length === 0) continue;
      const links: SemanticLinkContribution[] = [];
      for (const backend of edge.backends) {
        const target = targets.get(`${edge.refScope} ${backend}`);
        if (!target) continue;
        if (!input.facts.hasResource({ namespace: 'meridian', localKey: target.localKey })) continue;
        links.push({
          from: { type: 'resource', namespace: 'meridian', localKey: edge.localKey },
          to: { type: 'resource', namespace: 'meridian', localKey: target.localKey },
          relation: 'routes-to',
          because: 'the meridian edge names this target',
        });
      }
      if (links.length > 0) batches.push({ batchId: `edge:${edge.localKey}`, delta: { links } });
    }
    return batches;
  },
};

function resourceId(object: MeridianObject): string {
  return `resource:meridian:${object.localKey}`;
}

function graphOf(objects: MeridianObject[]): RepositoryGraph {
  const snapshot: RepositoryFactsSnapshot = {
    repoRoot: '/repo',
    timestamp: new Date(0).toISOString(),
    packages: [],
    modules: [],
    infraModules: [{
      id: 'infra:meridian:deploy/mesh.meridian',
      kind: 'meridian',
      absPath: asHostPath('/repo/deploy/mesh.meridian'),
      repoRelPath: asRepoRelPath('deploy/mesh.meridian'),
      contentHash: 'mesh',
      resources: objects.map(meridianResource),
    }],
    facts: objects.map(meridianFact),
  };
  attachProjectors(snapshot, PLUGIN_ID, [meridianRouter]);
  return composeRepositoryGraph(snapshot);
}

function routesFrom(graph: RepositoryGraph, from: string): string[] {
  return (graph.outEdges.get(from) ?? [])
    .filter(edge => edge.kind === 'routes_to')
    .map(edge => edge.to)
    .sort();
}

const edge = (name: string, zone: string, backends: string[]): MeridianObject =>
  ({ localKey: `${zone}/edge/${name}`, objectKind: 'edge', name, refScope: `meridian/${zone}`, backends });

const target = (name: string, zone: string): MeridianObject =>
  ({ localKey: `${zone}/target/${name}`, objectKind: 'target', name, refScope: `meridian/${zone}`, backends: [] });

describe('core-laws routing between resources is plugin-owned', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    await restoreBuiltinPlugins();
  });

  it('draws a routing edge for an ecosystem the engine has no name for', () => {
    const front = edge('web', 'north', ['api']);
    const api = target('api', 'north');
    const graph = graphOf([front, api]);

    expect(routesFrom(graph, resourceId(front))).toEqual([resourceId(api)]);
  });

  it('lets a projected link point at resources an IaC producer minted, not only at its own', () => {
    const front = edge('web', 'north', ['api']);
    const api = target('api', 'north');
    const graph = graphOf([front, api]);

    // Both ends were minted by the IaC pass. The projector contributed no resource of its own, and
    // the batch still applied: a reference reaches what the graph holds.
    for (const id of [resourceId(front), resourceId(api)]) {
      expect(graph.nodes.get(id)?.description).toBe(`meridian-node declared in deploy/mesh.meridian`);
    }
    expect(routesFrom(graph, resourceId(front))).toEqual([resourceId(api)]);
  });

  it('drops the link, not the batch, when the target resource is not in the graph', () => {
    const front = edge('web', 'north', ['api', 'ghost']);
    const api = target('api', 'north');
    // A fact about an object this repository does not declare as a resource: named by the edge,
    // absent from the graph. The reference would resolve to nothing and take the batch with it.
    const ghost = target('ghost', 'north');
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: '/repo',
      timestamp: new Date(0).toISOString(),
      packages: [],
      modules: [],
      infraModules: [{
        id: 'infra:meridian:deploy/mesh.meridian',
        kind: 'meridian',
        absPath: asHostPath('/repo/deploy/mesh.meridian'),
        repoRelPath: asRepoRelPath('deploy/mesh.meridian'),
        contentHash: 'mesh',
        resources: [front, api].map(meridianResource),
      }],
      facts: [front, api, ghost].map(meridianFact),
    };
    attachProjectors(snapshot, PLUGIN_ID, [meridianRouter]);
    const graph = composeRepositoryGraph(snapshot);

    expect(routesFrom(graph, resourceId(front))).toEqual([resourceId(api)]);
    expect(graph.nodes.has(resourceId(ghost))).toBe(false);
  });

  it('keeps a routing name inside the scope its plugin declared', () => {
    // The edge lives in the zone that sorts last, and the decoy is declared first: neither the fact
    // view's order nor the declaration order can hand back the right answer by accident.
    const north = edge('web', 'north', ['api']);
    const alphaApi = target('api', 'alpha');
    const northApi = target('api', 'north');
    const graph = graphOf([north, alphaApi, northApi]);

    expect(routesFrom(graph, resourceId(north))).toEqual([resourceId(northApi)]);
  });

  it('refuses a logical-id reference that leaves the scope its plugin declared', async () => {
    // The generic resolver, not the projector: a declared scope confines every reference the
    // resource makes, and a name outside it is recorded unresolved rather than bound to a guess.
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: '/repo',
      timestamp: new Date(0).toISOString(),
      packages: [],
      modules: [],
      infraModules: [{
        id: 'infra:meridian:deploy/mesh.meridian',
        kind: 'meridian',
        absPath: asHostPath('/repo/deploy/mesh.meridian'),
        repoRelPath: asRepoRelPath('deploy/mesh.meridian'),
        contentHash: 'mesh',
        resources: [
          {
            ...meridianResource(edge('web', 'north', [])),
            envRefs: [{ varName: 'STORE', refType: 'literal', targetLogicalId: 'store' }],
          },
          { ...meridianResource(target('store', 'south')), id: 'store' },
        ],
      }],
    };
    const graph = composeRepositoryGraph(snapshot);

    const referrer = graph.nodes.get('resource:meridian:north/edge/web');
    expect(referrer?.type).toBe('runtime-resource');
    expect((graph.outEdges.get('resource:meridian:north/edge/web') ?? [])
      .filter(item => item.kind === 'uses_env')).toEqual([]);
    expect(referrer?.type === 'runtime-resource' ? referrer.data?.unresolvedRefs : undefined)
      .toEqual([expect.objectContaining({ logicalId: 'store', reason: 'out-of-scope' })]);
  });

  it('still scopes a reference by its declaring document when no scope is declared', () => {
    // Without a declared scope the default rule applies unchanged: the document decides, and a
    // repository-wide single candidate still resolves.
    const producer: InfraResource = {
      id: 'writer',
      kind: 'meridian-node',
      provider: 'meridian',
      identity: { namespace: 'meridian', localKey: 'writer' },
      contentHash: 'writer',
      attributes: {},
      envRefs: [{ varName: 'STORE', refType: 'literal', targetLogicalId: 'store' }],
    };
    const store: InfraResource = {
      id: 'store',
      kind: 'meridian-node',
      provider: 'meridian',
      identity: { namespace: 'meridian', localKey: 'store' },
      contentHash: 'store',
      attributes: {},
    };
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: '/repo',
      timestamp: new Date(0).toISOString(),
      packages: [],
      modules: [],
      infraModules: [{
        id: 'infra:meridian:deploy/mesh.meridian',
        kind: 'meridian',
        absPath: asHostPath('/repo/deploy/mesh.meridian'),
        repoRelPath: asRepoRelPath('deploy/mesh.meridian'),
        contentHash: 'mesh',
        resources: [producer, store],
      }],
    };
    const graph = composeRepositoryGraph(snapshot);

    expect((graph.outEdges.get('resource:meridian:writer') ?? [])
      .filter(item => item.kind === 'uses_env')
      .map(item => item.to)).toEqual(['resource:meridian:store']);
  });

  it('routes an invented ecosystem discovered from real files, end to end', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-routing-'));
    tmpDirs.push(root);
    fs.mkdirSync(path.join(root, 'deploy'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'deploy', 'mesh.meridian'),
      JSON.stringify({ edges: [{ name: 'web', backends: ['api'] }], targets: ['api'], zone: 'north' }),
    );

    const parser: IaCParser = {
      kind: 'meridian',
      loaderId: 'json',
      fileMatch: { extensions: ['.meridian'] },
      supports: () => true,
      parse: (_filePath, _relPath, doc): SemanticInfraDelta => {
        const parsed = doc as { edges: Array<{ name: string; backends: string[] }>; targets: string[]; zone: string };
        const objects: MeridianObject[] = [
          ...parsed.edges.map(entry => edge(entry.name, parsed.zone, entry.backends)),
          ...parsed.targets.map(name => target(name, parsed.zone)),
        ];
        return {
          kind: 'meridian',
          resources: objects.map(meridianResource),
          facts: objects.map(meridianFact),
        };
      },
    };
    installOneMore({ id: PLUGIN_ID, parsers: [parser] });

    const { modules, facts, refusals } = collectInfraModules({ repoRoot: root });
    expect(refusals).toEqual([]);
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: root,
      timestamp: new Date(0).toISOString(),
      packages: [],
      modules: [],
      infraModules: modules,
      facts,
    };
    attachProjectors(snapshot, PLUGIN_ID, [meridianRouter]);
    const graph = composeRepositoryGraph(snapshot);

    expect(routesFrom(graph, 'resource:meridian:north/edge/web'))
      .toEqual(['resource:meridian:north/target/api']);
  });

  it('leaves no Kubernetes vocabulary in engine sources', () => {
    // Read through the parser rather than the text, so the guard sees what a branch could compare
    // and not what a sentence mentions: a value the engine tests against is a literal or a name.
    const literals = new Set(['k8s', 'k8s-service', 'k8s-deployment', 'Ingress']);
    const names = new Set(['k8sKind']);
    const offenders: string[] = [];

    for (const file of sourceFiles(path.join(repoRoot(), 'src'))) {
      const text = fs.readFileSync(file, 'utf8');
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
      const visit = (node: ts.Node): void => {
        const found = (ts.isStringLiteralLike(node) && literals.has(node.text))
          || (ts.isIdentifier(node) && names.has(node.text));
        if (found) offenders.push(`${path.relative(repoRoot(), file)}: ${(node as ts.LiteralLikeNode).text}`);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(offenders.sort()).toEqual([]);
  });
});
