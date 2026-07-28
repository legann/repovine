import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AnnotationStore } from '../../src/annotations/store.js';
import { CONFIG_DEFAULTS } from '../../src/config.js';
import { addNode, createEmptyGraph } from '../../src/graph/index.js';
import { toolHandlers } from '../../src/mcp/tools/registry.js';
import type { AnnotationStore as AnnotationStoreType } from '../../src/annotations/store.js';
import type { McpToolRuntime, RepovineState } from '../../src/mcp/types.js';
import type {
  AnnotationContent,
  GraphNode,
  ModuleInfo,
  RepositoryFactsSnapshot,
} from '../../src/types.js';

// Law: the freshness stamp certifies the fields a write actually rewrote, never the ones beside them.
//
// The stamp is taken from the node's CURRENT content hash, and it answers for the whole note. Before
// this law, a partial write advanced it: rewriting one `summary` cleared staleness for every invariant
// next to it — fields authored against older content that nothing had re-read. The note came back
// `fresh` with the stale prose intact, one `pass` higher.

const NODE = 'mod:pkg/service';

function moduleInfo(contentHash: string): ModuleInfo {
  return {
    id: NODE,
    packageName: 'pkg',
    filePath: '/repo/pkg/service.ts',
    relativeFilePath: 'pkg/service.ts',
    contentHash,
    imports: [],
    exports: [],
  };
}

function moduleNode(): GraphNode {
  return {
    id: NODE,
    type: 'module',
    label: 'pkg/service',
    description: 'Module pkg/service',
    data: { relativeFilePath: 'pkg/service.ts' },
  };
}

/** The node's content hash is mutable so a test can move the file under an existing note. */
function runtime(repoRoot: string, annotations: AnnotationStoreType, hash: () => string): McpToolRuntime {
  const graph = createEmptyGraph();
  addNode(graph, moduleNode());
  const state = (): RepovineState => {
    const modules = [moduleInfo(hash())];
    return {
      graph,
      snapshot: {
        repoRoot,
        timestamp: '2026-01-01T00:00:00.000Z',
        packages: [],
        modules,
      } satisfies RepositoryFactsSnapshot,
      modulesById: new Map(modules.map(mod => [mod.id, mod])),
      searchIndex: { tokens: new Map(), annotationText: new Map() },
      semanticIndex: null,
      semanticSearchRefresh: { status: 'disabled' },
      annotations,
      domainsConfig: null,
      domainsSuggestions: { additions: [], count: 0, axes: [], declinedHidden: 0, mergedConfig: {}, keepConfig: {} },
      refactoringThresholds: {} as RepovineState['refactoringThresholds'],
      builtAt: '2026-01-01T00:00:00.000Z',
    };
  };
  return { repoRoot, getState: state, getConfig: () => CONFIG_DEFAULTS, refreshRepoState: () => undefined };
}

// Explicit rather than derived from the write implementation: a product field cannot disappear from
// this law by co-movement. `Required<AnnotationContent>` and the SameKeys check make an added schema
// field a compile-time demand to give it an independent fixture and carried-field assertion here.
const FULL_NOTE: Required<AnnotationContent> = {
  summary: 'Service module described in full so every field is certified against one content hash.',
  keyExports: {},
  invariants: ['the invariant authored against the first revision'],
  assumptions: ['the assumption authored against the first revision'],
  sideEffects: [{ kind: 'pure' }],
  risks: ['the standing risk authored against the first revision'],
  patterns: ['the pattern authored against the first revision'],
  flowDescription: 'The flow description authored against the first revision.',
  extensionPoints: ['the extension point authored against the first revision'],
  integrationPoints: 'The integration point authored against the first revision.',
  stateShape: 'The state shape authored against the first revision.',
  dataFlow: 'The data flow authored against the first revision.',
  envDependencies: {},
  propagationSlice: {
    anchor: NODE,
    path: [NODE],
    reviewedAt: '2026-01-01T00:00:00.000Z',
  },
};

const ANNOTATION_FIELD_KEYS = [
  'summary',
  'keyExports',
  'assumptions',
  'sideEffects',
  'risks',
  'patterns',
  'flowDescription',
  'invariants',
  'extensionPoints',
  'integrationPoints',
  'stateShape',
  'dataFlow',
  'envDependencies',
  'propagationSlice',
] as const satisfies readonly (keyof AnnotationContent)[];

type SameKeys<A, B> = [Exclude<A, B>, Exclude<B, A>] extends [never, never] ? true : false;
const annotationFieldKeysAreExhaustive: SameKeys<
  keyof AnnotationContent,
  typeof ANNOTATION_FIELD_KEYS[number]
> = true;
void annotationFieldKeysAreExhaustive;

function meta(value: unknown): Record<string, unknown> {
  return (value as { result?: { annotationMeta?: Record<string, unknown> } }).result?.annotationMeta ?? {};
}

function warnings(value: unknown): string[] {
  return (value as { result?: { warnings?: string[] } }).result?.warnings ?? [];
}

function persistence(value: unknown): { durable?: boolean; persisted?: boolean } {
  return (value as {
    result?: { persistence?: { durable?: boolean; persisted?: boolean } };
  }).result?.persistence ?? {};
}

function carriedFields(value: unknown): Set<string> {
  const carriedWarning = warnings(value).find(warning => warning.includes('did not resubmit'));
  const fieldClause = carriedWarning?.match(/did not resubmit ([^.]+)\./)?.[1];
  return new Set(fieldClause?.split(', ') ?? []);
}

describe('core-laws a freshness stamp covers only what the write rewrote', () => {
  let repoRoot: string;
  let store: AnnotationStoreType;
  let ctx: McpToolRuntime;
  let hash: string;

  beforeEach(async () => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-stamp-law-'));
    store = AnnotationStore.createSync(repoRoot);
    hash = 'revision-one';
    ctx = runtime(repoRoot, store, () => hash);
    const write = await toolHandlers.write_annotation(ctx, {
      nodeId: NODE,
      annotation: FULL_NOTE,
      durable: true,
    });
    expect(persistence(write)).toEqual({ durable: true, persisted: true });
  });

  afterEach(async () => {
    await store.drain();
    fs.rmSync(repoRoot, { recursive: true, force: true });
    expect(fs.existsSync(repoRoot)).toBe(false);
  });

  it('certifies the whole note while nothing has moved', async () => {
    expect(meta(await toolHandlers.inspect_node(ctx, { nodeId: NODE })).fresh).toBe(true);
  });

  it('does not clear staleness for fields the write left alone', async () => {
    hash = 'revision-two';
    expect(meta(await toolHandlers.inspect_node(ctx, { nodeId: NODE })).fresh).toBe(false);

    const response = await toolHandlers.write_annotation(ctx, {
      nodeId: NODE,
      annotation: { summary: 'Rewritten summary while every other field stays exactly as authored before.' },
      durable: true,
    });
    expect(persistence(response)).toEqual({ durable: true, persisted: true });

    const after = meta(await toolHandlers.inspect_node(ctx, { nodeId: NODE }));
    expect(after.fresh).toBe(false);
    expect(after.staleReason).toBe('content');

    // Every carried field is preserved and named. The expected surface is independent of the product's
    // carriedOverFields calculation, so excluding (for example) `risks` makes this assertion red.
    expect(store.get(NODE)?.annotation).toEqual({
      ...FULL_NOTE,
      summary: 'Rewritten summary while every other field stays exactly as authored before.',
    });
    expect(carriedFields(response)).toEqual(new Set(
      ANNOTATION_FIELD_KEYS.filter(field => field !== 'summary'),
    ));
  });

  it('treats required summary as carried when a different field is the partial update', async () => {
    hash = 'revision-two';

    const response = await toolHandlers.write_annotation(ctx, {
      nodeId: NODE,
      annotation: { risks: ['the standing risk re-authored against the second revision'] },
      durable: true,
    });
    expect(persistence(response)).toEqual({ durable: true, persisted: true });

    const after = meta(await toolHandlers.inspect_node(ctx, { nodeId: NODE }));
    expect(after).toMatchObject({ fresh: false, staleReason: 'content' });
    expect(store.get(NODE)?.annotation).toEqual({
      ...FULL_NOTE,
      risks: ['the standing risk re-authored against the second revision'],
    });
    expect(carriedFields(response)).toEqual(new Set(
      ANNOTATION_FIELD_KEYS.filter(field => field !== 'risks'),
    ));
  });

  it('clears staleness when the write resubmits every field', async () => {
    hash = 'revision-two';

    const write = await toolHandlers.write_annotation(ctx, {
      nodeId: NODE,
      annotation: {
        ...FULL_NOTE,
        summary: 'Every field re-authored against the second revision, so the stamp may advance.',
        invariants: ['the invariant re-authored against the second revision'],
        assumptions: ['the assumption re-authored against the second revision'],
      },
      durable: true,
    });
    expect(persistence(write)).toEqual({ durable: true, persisted: true });

    expect(meta(await toolHandlers.inspect_node(ctx, { nodeId: NODE })).fresh).toBe(true);
  });
});
