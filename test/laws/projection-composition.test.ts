import { describe, expect, it } from '@jest/globals';
import { ENTRYPOINT_CONTRIBUTION_KINDS, SEMANTIC_LINK_RELATIONS } from '@repovine/plugin-sdk';
import type {
  PluginOwnerIdentity,
  PluginProjectionBatch,
  ProjectionContributor,
  ReadonlyProjectionInput,
} from '@repovine/plugin-sdk';
import { EDGE_KINDS } from '../../src/types.js';
import { RELATION_EDGE_KINDS } from '../../src/stage2/projection/relations.js';
import { CONVERTED_ENTRYPOINT_KINDS, toEntrypointFragment } from '../../src/stage2/projection/entrypoints.js';
import { createFactView } from '../../src/stage2/projection/fact-view.js';
import {
  composeProjections,
  type ProjectionCompositionResult,
} from '../../src/stage2/projection/compose.js';
import type { RepositoryFactsSnapshot } from '../../src/types.js';

/**
 * Law: plugin projection is decided by what was contributed, never by who ran first.
 *
 * Registration order is the channel this composer exists to close. Every guard below therefore runs
 * its case in BOTH contributor orders and asserts the two results are identical — a composer that
 * quietly reintroduced sequential apply would pass the forward order and fail the reverse.
 *
 * Atomicity is the second half. A batch is one module or one document, so a refused batch leaves
 * none of its nodes behind, and its contributor's other batches are untouched.
 */

const OWNER_A: PluginOwnerIdentity = { pluginId: 'alpha', packageName: 'repovine-plugin-alpha', packageVersion: '1.0.0' };
const OWNER_B: PluginOwnerIdentity = { pluginId: 'beta', packageName: 'repovine-plugin-beta', packageVersion: '2.0.0' };

function snapshotWithModules(moduleIds: string[]): RepositoryFactsSnapshot {
  return {
    repoRoot: '/repo',
    timestamp: '2026-07-29T00:00:00.000Z',
    packages: [],
    modules: moduleIds.map(id => ({
      id,
      packageName: 'app',
      filePath: `/repo/${id.replace('mod:', '')}.ts`,
      relativeFilePath: `${id.replace('mod:', '')}.ts`,
      contentHash: 'h',
      imports: [],
      exports: [],
    })),
  };
}

function contributor(id: string, batches: PluginProjectionBatch[]): ProjectionContributor {
  return { id, project: () => batches };
}

interface Case {
  contributors: Array<{ owner: PluginOwnerIdentity; contributor: ProjectionContributor }>;
  moduleIds?: string[];
  knownNodeIds?: string[];
}

function run(input: Case): ProjectionCompositionResult {
  const snapshot = snapshotWithModules(input.moduleIds ?? ['mod:app/index']);
  const projectionInput: ReadonlyProjectionInput = {
    repoRoot: snapshot.repoRoot,
    facts: createFactView({ snapshot }),
  };
  return composeProjections({
    contributors: input.contributors,
    input: projectionInput,
    knownModuleIds: new Set(snapshot.modules.map(m => m.id)),
    knownNodeIds: new Set(input.knownNodeIds ?? snapshot.modules.map(m => m.id)),
  });
}

/** The same case in both registration orders. A difference between them is the defect this law names. */
function runBothOrders(input: Case): ProjectionCompositionResult {
  const forward = run(input);
  const reverse = run({ ...input, contributors: [...input.contributors].reverse() });
  expect(JSON.stringify(reverse)).toEqual(JSON.stringify(forward));
  return forward;
}

const RESOURCE_BATCH: PluginProjectionBatch = {
  batchId: 'doc:queue.yaml',
  delta: {
    resources: [{
      namespace: 'alpha-cloud',
      localKey: 'orders-queue',
      provider: 'alpha',
      kind: 'queue',
      contentHash: 'q1',
    }],
  },
};

describe('core-laws projection composition (two-phase, order-independent)', () => {
  it('maps every published relation onto an edge kind the graph holds', () => {
    expect(Object.keys(RELATION_EDGE_KINDS).sort()).toEqual([...SEMANTIC_LINK_RELATIONS].sort());
    for (const relation of SEMANTIC_LINK_RELATIONS) {
      expect(EDGE_KINDS).toContain(RELATION_EDGE_KINDS[relation]);
    }
  });

  it('converts every canonical entrypoint kind into a fragment carrying an id', () => {
    expect([...CONVERTED_ENTRYPOINT_KINDS].sort()).toEqual([...ENTRYPOINT_CONTRIBUTION_KINDS].sort());
    const samples = [
      { kind: 'api-route' as const, moduleRef: { type: 'module' as const, moduleId: 'mod:a' }, path: '/x', method: 'GET' },
      { kind: 'file-route' as const, moduleRef: { type: 'module' as const, moduleId: 'mod:a' }, path: '/x', fileType: 'route' },
      { kind: 'ui-route' as const, moduleRef: { type: 'module' as const, moduleId: 'mod:a' }, path: '/x' },
      { kind: 'conditional-render' as const, moduleRef: { type: 'module' as const, moduleId: 'mod:a' }, component: 'Widget' },
      {
        kind: 'resource-trigger' as const,
        resourceRef: { type: 'resource' as const, namespace: 'ns', localKey: 'k' },
        triggerKind: 'queue-consumer',
        discriminator: 'main',
      },
    ];
    expect(samples.map(s => s.kind).sort()).toEqual([...ENTRYPOINT_CONTRIBUTION_KINDS].sort());
    for (const sample of samples) {
      const fragment = toEntrypointFragment(sample);
      expect(typeof fragment.id).toBe('string');
      expect(fragment.id).not.toHaveLength(0);
      expect(typeof fragment.kind).toBe('string');
    }
  });

  // GATE 1: reverse registration produces the same snapshot.
  it('produces the same graph delta in either registration order', () => {
    const result = runBothOrders({
      contributors: [
        { owner: OWNER_A, contributor: contributor('alpha-infra', [RESOURCE_BATCH]) },
        {
          owner: OWNER_B,
          contributor: contributor('beta-infra', [{
            batchId: 'doc:api.yaml',
            delta: {
              resources: [{
                namespace: 'beta-cloud', localKey: 'api', provider: 'beta', kind: 'api', contentHash: 'a1',
              }],
            },
          }]),
        },
      ],
    });
    expect(result.delta.nodes.map(node => node.id)).toEqual([
      'resource:alpha-cloud:orders-queue',
      'resource:beta-cloud:api',
    ]);
    expect(result.contributors.map(outcome => outcome.status)).toEqual(['applied', 'applied']);
  });

  // GATE 2: a reference to a later contributor's contribution resolves.
  it('resolves a cross-plugin reference to a contribution made by the other contributor', () => {
    const referencing: PluginProjectionBatch = {
      batchId: 'doc:worker.yaml',
      delta: {
        resources: [{
          namespace: 'beta-cloud', localKey: 'worker', provider: 'beta', kind: 'function', contentHash: 'w1',
        }],
        links: [{
          from: { type: 'resource', namespace: 'alpha-cloud', localKey: 'orders-queue' },
          to: { type: 'resource', namespace: 'beta-cloud', localKey: 'worker' },
          relation: 'consumes',
        }],
      },
    };
    const result = runBothOrders({
      contributors: [
        { owner: OWNER_A, contributor: contributor('alpha-infra', [RESOURCE_BATCH]) },
        { owner: OWNER_B, contributor: contributor('beta-infra', [referencing]) },
      ],
    });

    expect(result.refusals).toEqual([]);
    expect(result.delta.edges).toEqual([{
      from: 'resource:alpha-cloud:orders-queue',
      to: 'resource:beta-cloud:worker',
      kind: 'consumes',
    }]);
  });

  it('refuses a dangling reference and applies none of the batch that carried it', () => {
    const dangling: PluginProjectionBatch = {
      batchId: 'doc:dangling.yaml',
      delta: {
        resources: [{
          namespace: 'beta-cloud', localKey: 'orphan', provider: 'beta', kind: 'function', contentHash: 'o1',
        }],
        links: [{
          from: { type: 'resource', namespace: 'beta-cloud', localKey: 'orphan' },
          to: { type: 'resource', namespace: 'nowhere', localKey: 'missing' },
          relation: 'consumes',
        }],
      },
    };
    const result = runBothOrders({
      contributors: [
        { owner: OWNER_A, contributor: contributor('alpha-infra', [RESOURCE_BATCH]) },
        { owner: OWNER_B, contributor: contributor('beta-infra', [dangling]) },
      ],
    });

    // The dangling batch left NO node behind, and the independent batch was unaffected.
    expect(result.delta.nodes.map(node => node.id)).toEqual(['resource:alpha-cloud:orders-queue']);
    expect(result.delta.edges).toEqual([]);
    expect(result.refusals.map(r => r.kind)).toContain('projection-batch-rejected');
  });

  // GATE 3: an invalid batch is never applied in part.
  it('refuses an invalid batch whole while its contributor keeps its valid batches', () => {
    const invalid: PluginProjectionBatch = {
      batchId: 'doc:invalid.yaml',
      delta: {
        resources: [
          { namespace: 'alpha-cloud', localKey: 'good', provider: 'alpha', kind: 'queue', contentHash: 'g1' },
          // A minted node id where an identity component belongs.
          { namespace: 'alpha-cloud', localKey: 'resource:alpha-cloud:x', provider: 'alpha', kind: 'queue', contentHash: 'b1' },
        ],
      },
    };
    const result = run({
      contributors: [{ owner: OWNER_A, contributor: contributor('alpha-infra', [RESOURCE_BATCH, invalid]) }],
    });

    expect(result.delta.nodes.map(node => node.id)).toEqual(['resource:alpha-cloud:orders-queue']);
    const outcome = result.contributors[0]!;
    expect(outcome.status).toBe('applied');
    expect(outcome.batches.find(b => b.batchId === 'doc:invalid.yaml')?.status).toBe('rejected');
    expect(outcome.batches.find(b => b.batchId === 'doc:queue.yaml')?.status).toBe('applied');
  });

  it('refuses both sides of a conflicting contribution instead of letting order pick a winner', () => {
    const mine: PluginProjectionBatch = {
      batchId: 'doc:mine.yaml',
      delta: {
        resources: [{
          namespace: 'shared', localKey: 'thing', provider: 'alpha', kind: 'queue', contentHash: 'x1',
        }],
      },
    };
    const theirs: PluginProjectionBatch = {
      batchId: 'doc:theirs.yaml',
      delta: {
        resources: [{
          namespace: 'shared', localKey: 'thing', provider: 'beta', kind: 'topic', contentHash: 'x2',
        }],
      },
    };
    const result = runBothOrders({
      contributors: [
        { owner: OWNER_A, contributor: contributor('alpha-infra', [mine]) },
        { owner: OWNER_B, contributor: contributor('beta-infra', [theirs]) },
      ],
    });

    expect(result.delta.nodes).toEqual([]);
    const conflict = result.refusals.find(r => r.kind === 'projection-conflict');
    expect(conflict).toBeDefined();
    // Both owners are named; a reader can settle it without re-running the build.
    expect(JSON.stringify(conflict!.details)).toContain('alpha');
    expect(JSON.stringify(conflict!.details)).toContain('beta');
  });

  it('deduplicates byte-identical contributions from two plugins into one node', () => {
    const same = (): PluginProjectionBatch => ({
      batchId: 'doc:same.yaml',
      delta: {
        resources: [{
          namespace: 'shared', localKey: 'thing', provider: 'shared', kind: 'queue', contentHash: 'same',
        }],
      },
    });
    const result = runBothOrders({
      contributors: [
        { owner: OWNER_A, contributor: contributor('alpha-infra', [same()]) },
        { owner: OWNER_B, contributor: contributor('beta-infra', [same()]) },
      ],
    });

    expect(result.delta.nodes.map(node => node.id)).toEqual(['resource:shared:thing']);
    expect(result.refusals).toEqual([]);
  });

  it('attributes a throwing contributor to itself and keeps the other one', () => {
    const thrower: ProjectionContributor = {
      id: 'beta-infra',
      project: () => { throw new Error('parser blew up'); },
    };
    const result = runBothOrders({
      contributors: [
        { owner: OWNER_A, contributor: contributor('alpha-infra', [RESOURCE_BATCH]) },
        { owner: OWNER_B, contributor: thrower },
      ],
    });

    expect(result.delta.nodes.map(node => node.id)).toEqual(['resource:alpha-cloud:orders-queue']);
    const failed = result.contributors.find(outcome => outcome.contributorId === 'beta-infra')!;
    expect(failed.status).toBe('failed');
    expect(failed.reason).toContain('parser blew up');
  });

  it('refuses an extension published under another plugin\'s schema owner', () => {
    const forged: PluginProjectionBatch = {
      batchId: 'doc:forged.yaml',
      delta: {
        extensions: [{ schema: 'alpha/notes@1', localKey: 'n1', payload: { any: 'thing' } }],
      },
    };
    const result = run({
      contributors: [{ owner: OWNER_B, contributor: contributor('beta-infra', [forged]) }],
    });

    expect(result.extensions).toEqual([]);
    expect(result.refusals.map(r => r.kind)).toContain('projection-batch-rejected');
  });

  it('stamps host provenance onto an accepted extension', () => {
    const owned: PluginProjectionBatch = {
      batchId: 'doc:owned.yaml',
      delta: {
        extensions: [{
          schema: 'beta/notes@1',
          localKey: 'n1',
          subjectRef: { type: 'module', moduleId: 'mod:app/index' },
          payload: { note: 'opaque' },
        }],
      },
    };
    const result = run({
      contributors: [{ owner: OWNER_B, contributor: contributor('beta-infra', [owned]) }],
    });

    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0]).toMatchObject({
      pluginId: 'beta',
      schema: 'beta/notes@1',
      provenance: {
        pluginId: 'beta',
        packageName: 'repovine-plugin-beta',
        packageVersion: '2.0.0',
        contributorId: 'beta-infra',
        batchId: 'doc:owned.yaml',
      },
    });
  });

  it('refuses a projected resource whose minted id the graph already holds', () => {
    const result = run({
      contributors: [{ owner: OWNER_A, contributor: contributor('alpha-infra', [RESOURCE_BATCH]) }],
      knownNodeIds: ['mod:app/index', 'resource:alpha-cloud:orders-queue'],
    });

    expect(result.delta.nodes).toEqual([]);
    expect(result.refusals.map(r => r.kind)).toContain('projection-batch-rejected');
  });
});
