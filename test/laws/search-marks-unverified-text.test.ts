import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AnnotationStore } from '../../src/annotations/store.js';
import { CONFIG_DEFAULTS } from '../../src/config.js';
import { addNode, createEmptyGraph } from '../../src/graph/index.js';
import { buildTokenIndex } from '../../src/mcp/lib/search-index.js';
import { toolHandlers } from '../../src/mcp/tools/registry.js';
import type { AnnotationStore as AnnotationStoreType } from '../../src/annotations/store.js';
import type { McpToolRuntime, RepovineState } from '../../src/mcp/types.js';
import type { GraphNode, ModuleInfo, RepositoryFactsSnapshot } from '../../src/types.js';

// Law: a search hit sourced from annotation text says whether that text is still verified.
//
// Annotation prose is indexed on purpose — it bridges question wording and repository terminology,
// and dropping a stale note from the index would cost coverage for no gain. What a stale note must
// not keep is the reader's assumption that its words describe the node: ranking scored verified and
// outrun text identically. Freshness was available from inspect/map/status surfaces, but the search
// hit itself exposed only `annotationMatched`, so the reader had to leave the result to distinguish it.

const NODE = 'mod:pkg/service';
const PHRASE = 'quarantines every inbound payload before dispatch';

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
      searchIndex: buildTokenIndex(graph, annotations.getAll()),
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

function topHit(value: unknown): Record<string, unknown> | undefined {
  const results = (value as { result?: { matches?: { topResults?: Array<Record<string, unknown>> } } })
    .result?.matches?.topResults ?? [];
  return results.find(hit => hit.id === NODE);
}

function resultHit(value: unknown): Record<string, unknown> | undefined {
  const results = (value as {
    result?: {
      matches?: {
        results?: Array<Record<string, unknown>> | Record<string, Array<Record<string, unknown>>>;
      };
    };
  }).result?.matches?.results;
  const rows = Array.isArray(results) ? results : Object.values(results ?? {}).flat();
  return rows.find(hit => hit.id === NODE);
}

async function searchHits(ctx: McpToolRuntime): Promise<Record<string, unknown>[]> {
  const grouped = await toolHandlers.search_context(ctx, { query: PHRASE });
  const filtered = await toolHandlers.search_context(ctx, { query: PHRASE, types: ['module'] });
  return [topHit(grouped), resultHit(grouped), resultHit(filtered)]
    .filter((hit): hit is Record<string, unknown> => hit !== undefined);
}

describe('core-laws a search hit says whether the text behind it is verified', () => {
  let repoRoot: string;
  let store: AnnotationStoreType;
  let ctx: McpToolRuntime;
  let hash: string;

  beforeEach(async () => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-search-mark-law-'));
    store = AnnotationStore.createSync(repoRoot);
    hash = 'revision-one';
    ctx = runtime(repoRoot, store, () => hash);
    await toolHandlers.write_annotation(ctx, {
      nodeId: NODE,
      annotation: { summary: `Service module that ${PHRASE} on the current revision.` },
      durable: true,
    });
  });

  afterEach(async () => {
    await store.drain();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('marks nothing while the note still describes the node', async () => {
    const hits = await searchHits(ctx);

    expect(hits).toHaveLength(3);
    for (const hit of hits) {
      expect(hit.annotationMatched).toBe(true);
      expect(hit.annotationStale).toBeUndefined();
    }
  });

  it('keeps the hit and marks the text the node has outrun', async () => {
    hash = 'revision-two';

    const hits = await searchHits(ctx);

    // Coverage is not the price of honesty: the stale note still answers the query.
    expect(hits).toHaveLength(3);
    for (const hit of hits) {
      expect(hit.annotationMatched).toBe(true);
      expect(hit.annotationStale).toBe(true);
    }
  });
});
