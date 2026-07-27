/**
 * Tests for the fuzzy-entry stack of search_context:
 *  - annotation text in the token index (search-index)
 *  - repository-vocabulary suggestions for unknown tokens
 *  - semantic (embedding) fusion in searchGraph and the search_context handler
 *  - SemanticIndex store: hash-diff sync, persistence, cosine query
 *  - node cards as the embedding corpus
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fsPromises from 'node:fs/promises';
import {
  annotationSearchText,
  buildTokenIndex,
  suggestVocabulary,
} from '../../../src/mcp/lib/search-index.js';
import { searchGraph, isSuggestedScopeCandidate, applyExportSymbolDampeningIfNeeded } from '../../../src/mcp/lib/search-graph.js';
import { SemanticIndex, cardHash, semanticIndexFilePath } from '../../../src/semantic/store.js';
import {
  buildNodeCard,
  buildNodeCardProjection,
  projectNodeCards,
  SEMANTIC_CARD_CHAR_BUDGET,
} from '../../../src/semantic/cards.js';
import { createEmbedder, type Embedder } from '../../../src/semantic/embedder.js';
import { createEmptyGraph, addNode, addEdge } from '../../../src/graph/index.js';
import { DEFAULT_THRESHOLDS } from '../../../src/analysis/architecture/config.js';
import { CONFIG_DEFAULTS } from '../../../src/config.js';
import type { RepovineState, McpToolRuntime } from '../../../src/mcp/types.js';
import type { ModuleInfo, RepositoryGraph, StoredAnnotation } from '../../../src/types.js';

// ── Fixtures ──

function makeStoredAnnotation(nodeId: string, summary: string, extra?: Partial<StoredAnnotation['annotation']>): StoredAnnotation {
  return {
    nodeId,
    nodeType: 'module',
    contentHash: 'hash',
    pass: 1,
    updatedAt: '2026-01-01',
    annotation: { summary, ...extra },
  };
}

function makeFixtureGraph(): RepositoryGraph {
  const g = createEmptyGraph();
  addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
  addNode(g, { id: 'pkg:test', type: 'package', label: 'test', description: '' });
  addNode(g, { id: 'mod:test/session-store', type: 'module', label: 'session-store', description: '' });
  addNode(g, { id: 'mod:test/formatting', type: 'module', label: 'formatting', description: '' });
  addNode(g, { id: 'resource:aws-lambda:Authorizer', type: 'runtime-resource', label: 'Authorizer', description: '' });
  addEdge(g, 'root', 'pkg:test', 'contains');
  addEdge(g, 'pkg:test', 'mod:test/session-store', 'contains');
  addEdge(g, 'pkg:test', 'mod:test/formatting', 'contains');
  return g;
}

const FIXTURE_ANNOTATIONS: Record<string, StoredAnnotation> = {
  'mod:test/session-store': makeStoredAnnotation(
    'mod:test/session-store',
    'Handles user authentication tokens and session persistence.',
    { risks: ['Token expiry races with refresh'] },
  ),
};

function makeCtx(overrides?: Partial<RepovineState>): McpToolRuntime {
  const graph = overrides?.graph ?? makeFixtureGraph();
  const state: RepovineState = {
    graph,
    snapshot: { repoRoot: '/repo', timestamp: '2026-01-01', packages: [], modules: [] },
    modulesById: new Map(),
    searchIndex: buildTokenIndex(graph, FIXTURE_ANNOTATIONS),
    semanticIndex: null,
    semanticSearchRefresh: { status: 'disabled' },
    annotations: { getAll: () => FIXTURE_ANNOTATIONS, get: () => undefined, isFresh: () => true } as unknown as RepovineState['annotations'],
    domainsConfig: null,
    domainsSuggestions: { additions: [], count: 0, axes: [], declinedHidden: 0, mergedConfig: {}, keepConfig: {} },
    refactoringThresholds: DEFAULT_THRESHOLDS,
    builtAt: '2026-01-01',
    ...overrides,
  };
  return { getState: () => state, refreshRepoState: () => {}, getConfig: () => CONFIG_DEFAULTS, repoRoot: '/repo' };
}

class MockEmbedder implements Embedder {
  readonly id: string;
  calls: string[][] = [];
  constructor(id = 'mock:v1') { this.id = id; }
  /** Deterministic keyword-presence vectors so cosine ranking is predictable. */
  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return texts.map(text => {
      const t = text.toLowerCase();
      return [t.includes('auth') ? 1 : 0, t.includes('format') ? 1 : 0, t.includes('retry') ? 1 : 0, 0.1];
    });
  }
}

// ── search-index: annotations in the token index ──

describe('buildTokenIndex with annotations', () => {
  it('indexes annotation text tokens and exposes annotationText for scoring', () => {
    const graph = makeFixtureGraph();
    const index = buildTokenIndex(graph, FIXTURE_ANNOTATIONS);
    expect(index.tokens.get('authentication')).toEqual(new Set(['mod:test/session-store']));
    expect(index.tokens.get('expiry')).toEqual(new Set(['mod:test/session-store']));
    expect(index.annotationText.get('mod:test/session-store')).toContain('authentication tokens');
  });

  it('skips annotations whose nodes are not in the graph and filters stopwords', () => {
    const graph = makeFixtureGraph();
    const annotations = {
      ...FIXTURE_ANNOTATIONS,
      'mod:gone/away': makeStoredAnnotation('mod:gone/away', 'Vanished module summary.'),
    };
    const index = buildTokenIndex(graph, annotations);
    expect(index.annotationText.has('mod:gone/away')).toBe(false);
    expect(index.tokens.has('vanished')).toBe(false);
    // 'and' from the summary prose is a stopword-class token for annotations.
    expect(index.tokens.get('and') ?? new Set()).not.toContain('mod:test/session-store');
  });

  it('annotationSearchText walks nested fields generically', () => {
    const stored = makeStoredAnnotation('mod:test/x', 'Top summary', {
      keyExports: { createSession: 'Creates a session row' },
      dataFlow: { ingress: 'SQS queue to DynamoDB table' },
    });
    const text = annotationSearchText(stored);
    expect(text).toContain('createsession');
    expect(text).toContain('sqs queue to dynamodb table');
  });

  it('indexes consumer-scoped risk object entries via normalized text', () => {
    const stored = makeStoredAnnotation('mod:test/x', 'Top summary', {
      risks: [{ text: 'importers must verify gate', scope: 'consumer' }],
    });
    const card = buildNodeCard(
      { id: 'mod:test/x', type: 'module', label: 'x', description: '' },
      undefined,
      stored,
    );
    expect(card).toContain('risk: importers must verify gate');
  });
});

describe('searchGraph annotation scoring', () => {
  it('finds a node by annotation wording absent from its id/label and flags annotationMatched', () => {
    const ctx = makeCtx();
    const result = searchGraph(ctx, { query: 'authentication' }) as Record<string, unknown>;
    const top = (result.topResults as Array<{ id: string; annotationMatched?: boolean }>)[0];
    expect(top.id).toBe('mod:test/session-store');
    expect(top.annotationMatched).toBe(true);
  });
});

// ── vocabulary suggestions ──

describe('suggestVocabulary', () => {
  it('ranks prefix matches first', () => {
    const graph = makeFixtureGraph();
    const index = buildTokenIndex(graph, FIXTURE_ANNOTATIONS);
    const suggestions = suggestVocabulary('authoriz', index);
    expect(suggestions[0]).toBe('authorizer');
  });

  it('suggests near-miss spellings via bounded edit distance', () => {
    const graph = makeFixtureGraph();
    const index = buildTokenIndex(graph, FIXTURE_ANNOTATIONS);
    expect(suggestVocabulary('formating', index)).toContain('formatting');
  });

  it('returns empty for short tokens', () => {
    const graph = makeFixtureGraph();
    const index = buildTokenIndex(graph, FIXTURE_ANNOTATIONS);
    expect(suggestVocabulary('au', index)).toEqual([]);
  });
});

describe('searchGraph vocabulary surfacing', () => {
  it('returns vocabulary for unknown strong tokens', () => {
    const ctx = makeCtx();
    const result = searchGraph(ctx, { query: 'formating' }) as Record<string, unknown>;
    const vocabulary = result.vocabulary as Record<string, string[]>;
    expect(vocabulary.formating).toContain('formatting');
  });

  it('omits vocabulary when all strong tokens hit', () => {
    const ctx = makeCtx();
    const result = searchGraph(ctx, { query: 'formatting' }) as Record<string, unknown>;
    expect(result.vocabulary).toBeUndefined();
  });
});

describe('searchGraph posting-list truncation', () => {
  function makePostingGraph(): RepositoryGraph {
    const graph = createEmptyGraph();
    addNode(graph, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(graph, { id: 'pkg:alpha-beta', type: 'package', label: 'alpha-beta', description: '' });
    addNode(graph, { id: 'mod:test/alpha', type: 'module', label: 'alpha', description: '' });
    addNode(graph, { id: 'mod:test/beta', type: 'module', label: 'beta', description: '' });
    return graph;
  }

  // The default budget is a measured choice, not an arbitrary constant: at 20 the posting lists of
  // 3.6% of repovine's tokens (3.7% of a 1979-module app repo) were truncated; at 50 that halves,
  // while the extreme tail — tokens matching thousands of nodes — stays cut, which is correct.
  it('defaults the per-token budget to 50 for the default result size', () => {
    const graph = makePostingGraph();
    const ctx = makeCtx({ graph, searchIndex: buildTokenIndex(graph, {}) });
    const result = searchGraph(ctx, { query: 'alpha beta', match: 'or' }) as Record<string, unknown>;
    expect((result.strategy as { perTokenLimit: number }).perTokenLimit).toBe(50);
  });

  it('scales the per-token budget with maxResults and caps it at 100', () => {
    const graph = makePostingGraph();
    const ctx = makeCtx({ graph, searchIndex: buildTokenIndex(graph, {}) });
    const wide = searchGraph(ctx, { query: 'alpha beta', match: 'or', maxResults: 40 }) as Record<string, unknown>;
    expect((wide.strategy as { perTokenLimit: number }).perTokenLimit).toBe(100);
  });

  it('exposes when perTokenLimit drops the globally best multi-token node', () => {
    const graph = makePostingGraph();
    const ctx = makeCtx({ graph, searchIndex: buildTokenIndex(graph, {}) });
    const unbounded = searchGraph(ctx, {
      query: 'alpha beta',
      match: 'or',
      perTokenLimit: 100,
    }) as Record<string, unknown>;
    const truncated = searchGraph(ctx, {
      query: 'alpha beta',
      match: 'or',
      perTokenLimit: 1,
    }) as Record<string, unknown>;

    expect((unbounded.topResults as Array<{ id: string }>)[0].id).toBe('pkg:alpha-beta');
    expect((truncated.topResults as Array<{ id: string }>).map(item => item.id))
      .not.toContain('pkg:alpha-beta');
    expect((truncated.strategy as {
      truncation: Record<string, Record<string, unknown>>;
    }).truncation).toEqual({
      alpha: expect.objectContaining({
        shown: 1,
        total: 2,
        unit: 'item',
        more: expect.objectContaining({ kind: 'arg', arg: 'perTokenLimit', value: 2 }),
      }),
      beta: expect.objectContaining({
        shown: 1,
        total: 2,
        more: expect.objectContaining({ kind: 'arg', arg: 'perTokenLimit' }),
      }),
    });
  });
});

// ── semantic fusion ──

describe('searchGraph semantic fusion', () => {
  it('adds semantic-only candidates with rank/score and marks strategy.semantic', () => {
    const ctx = makeCtx();
    const result = searchGraph(ctx, {
      query: 'zzzunknownconcept',
      semantic: [{ id: 'mod:test/formatting', score: 0.81 }],
    }) as Record<string, unknown>;
    const top = (result.topResults as Array<Record<string, unknown>>)[0];
    expect(top.id).toBe('mod:test/formatting');
    expect(top.semanticRank).toBe(0);
    expect(top.semanticScore).toBeCloseTo(0.81);
    expect(top.matchedTokenCount).toBe(0);
    expect((result.strategy as { semantic: { used: boolean } }).semantic.used).toBe(true);
  });

  it('adds cosine similarity to the fusion score, not only RRF rank', () => {
    const ctx = makeCtx();
    const rrfOnly = searchGraph(ctx, {
      query: 'zzzunknownconcept',
      semantic: [{ id: 'mod:test/formatting', score: 0 }],
    }, { minCosine: 0, rrfWeight: 15, rrfK: 1, cosineWeight: 20 }) as Record<string, unknown>;
    const withCosine = searchGraph(ctx, {
      query: 'zzzunknownconcept',
      semantic: [{ id: 'mod:test/formatting', score: 0.75 }],
    }, { minCosine: 0, rrfWeight: 15, rrfK: 1, cosineWeight: 20 }) as Record<string, unknown>;
    const rrfScore = (rrfOnly.topResults as Array<{ score: number }>)[0].score;
    const fusedScore = (withCosine.topResults as Array<{ score: number }>)[0].score;
    expect(fusedScore - rrfScore).toBeCloseTo(0.75 * 20, 4);
  });

  it('boosts nodes matched by both token and semantic ranking above token-only peers', () => {
    const ctx = makeCtx();
    const withoutSemantic = searchGraph(ctx, { query: 'test' }) as Record<string, unknown>;
    const withSemantic = searchGraph(ctx, {
      query: 'test',
      semantic: [{ id: 'mod:test/formatting', score: 0.9 }],
    }) as Record<string, unknown>;
    const before = (withoutSemantic.topResults as Array<{ id: string; score: number }>).find(m => m.id === 'mod:test/formatting');
    const after = (withSemantic.topResults as Array<{ id: string; score: number }>).find(m => m.id === 'mod:test/formatting');
    expect(after!.score).toBeGreaterThan(before!.score);
  });

  it('respects nodeTypes filters for semantic-only candidates', () => {
    const ctx = makeCtx();
    const result = searchGraph(ctx, {
      query: 'zzzunknownconcept',
      nodeTypes: ['runtime-resource'],
      semantic: [{ id: 'mod:test/formatting', score: 0.9 }],
    }) as Record<string, unknown>;
    expect((result.results as unknown[]).length).toBe(0);
  });
});

describe('searchGraph suggestedScopes', () => {
  function makeAuthGraph(): RepositoryGraph {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, {
      id: 'domain:auth', type: 'domain', label: 'auth', description: '',
      data: { tier: 'business', weight: 'heavy' },
    });
    addNode(g, { id: 'mod:test/session-store', type: 'module', label: 'session-store', description: '' });
    addEdge(g, 'root', 'domain:auth', 'contains');
    addEdge(g, 'domain:auth', 'mod:test/session-store', 'contains');
    return g;
  }

  it('includes domains with semanticRank <= 2 in suggestedScopes', () => {
    const graph = makeAuthGraph();
    const ctx = makeCtx({ graph, searchIndex: buildTokenIndex(graph, FIXTURE_ANNOTATIONS) });
    const result = searchGraph(ctx, {
      query: 'handle user authentication',
      semantic: [
        { id: 'domain:auth', score: 0.92 },
        { id: 'mod:test/session-store', score: 0.88 },
      ],
    }) as Record<string, unknown>;
    const scopes = result.suggestedScopes as Array<{ scope: string }>;
    expect(scopes.some(s => s.scope === 'domain:auth')).toBe(true);
    expect(scopes.some(s => s.scope.startsWith('export:'))).toBe(false);
  });

  it('includes business-tier domains even without semantic rank', () => {
    expect(isSuggestedScopeCandidate({
      id: 'domain:auth', label: 'auth', type: 'domain', score: 5, linksCount: 0,
      matchedTokens: ['auth'], annotationMatched: false, tier: 'business',
    })).toBe(true);
    expect(isSuggestedScopeCandidate({
      id: 'domain:infra', label: 'infra', type: 'domain', score: 5, linksCount: 0,
      matchedTokens: ['infra'], annotationMatched: false, tier: 'technical',
    })).toBe(false);
  });
});

describe('searchGraph export-symbol dampening', () => {
  function makeExportSymbolFloodGraph(): RepositoryGraph {
    const g = createEmptyGraph();
    addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(g, {
      id: 'domain:auth', type: 'domain', label: 'auth', description: '',
      data: { tier: 'business', weight: 'heavy' },
    });
    addNode(g, { id: 'mod:test/session-store', type: 'module', label: 'session-store', description: '' });
    for (let i = 0; i < 8; i++) {
      addNode(g, {
        id: `export:test/handle${i}`, type: 'export-symbol', label: `handle${i}`, description: '',
        data: { signature: `function handleUserAuthentication${i}(): void`, symbolKind: 'function', lineRange: { start: 1, end: 2 } },
      });
      addEdge(g, 'mod:test/session-store', `export:test/handle${i}`, 'contains');
    }
    addEdge(g, 'root', 'domain:auth', 'contains');
    addEdge(g, 'domain:auth', 'mod:test/session-store', 'contains');
    return g;
  }

  it('dampens an export-symbol flood on a token-only search, with no embedder involved', () => {
    // The flood is a property of the token hits, so it is dampened whether or not the optional
    // embedder peer is installed. Gating this on semantic availability used to rank the same query
    // on the same repository differently for two users.
    const graph = makeExportSymbolFloodGraph();
    const index = buildTokenIndex(graph, FIXTURE_ANNOTATIONS);
    const ctx = makeCtx({ graph, searchIndex: index });
    const tokenOnly = searchGraph(ctx, { query: 'handle user authentication', maxResults: 10 }) as Record<string, unknown>;

    expect((tokenOnly.strategy as { semantic: { used: boolean } }).semantic.used).toBe(false);
    expect((tokenOnly.strategy as { semantic: { exportSymbolDampened?: boolean } }).semantic.exportSymbolDampened).toBe(true);
    expect((tokenOnly.topResults as Array<{ id: string }>)[0].id).toMatch(/^domain:|^mod:/);
  });

  it('still dampens when semantic candidates are fused in', () => {
    const graph = makeExportSymbolFloodGraph();
    const index = buildTokenIndex(graph, FIXTURE_ANNOTATIONS);
    const ctx = makeCtx({ graph, searchIndex: index });
    const withSemantic = searchGraph(ctx, {
      query: 'handle user authentication',
      maxResults: 10,
      semantic: [{ id: 'domain:auth', score: 0.9 }, { id: 'mod:test/session-store', score: 0.85 }],
    }) as Record<string, unknown>;

    expect((withSemantic.strategy as { semantic: { exportSymbolDampened?: boolean } }).semantic.exportSymbolDampened).toBe(true);
    expect((withSemantic.topResults as Array<{ id: string }>)[0].id).toMatch(/^domain:|^mod:/);
  });

  it('leaves a non-flooding result set alone', () => {
    // Restraint: dampening must fire on the flood condition, not on every query that happens to
    // match an export symbol. Nothing measures how often a wanted symbol gets buried, so the guard
    // is that a single export-symbol hit is untouched.
    const graph = createEmptyGraph();
    addNode(graph, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(graph, { id: 'mod:test/solo', type: 'module', label: 'solo', description: '' });
    addNode(graph, {
      id: 'export:test/parseLedger', type: 'export-symbol', label: 'parseLedger', description: '',
      data: { signature: 'function parseLedger(): void', symbolKind: 'function', lineRange: { start: 1, end: 2 } },
    });
    addEdge(graph, 'root', 'mod:test/solo', 'contains');
    addEdge(graph, 'mod:test/solo', 'export:test/parseLedger', 'contains');
    const ctx = makeCtx({ graph, searchIndex: buildTokenIndex(graph, FIXTURE_ANNOTATIONS) });

    const result = searchGraph(ctx, { query: 'parseLedger', maxResults: 10 }) as Record<string, unknown>;
    expect((result.strategy as { semantic: { exportSymbolDampened?: boolean } }).semantic.exportSymbolDampened)
      .toBeUndefined();
    expect((result.topResults as Array<{ id: string }>)[0].id).toBe('export:test/parseLedger');
  });

  it('applyExportSymbolDampeningIfNeeded mirrors context-quality capRatio threshold', () => {
    const matches = Array.from({ length: 8 }, (_, i) => ({
      id: `export:x/${i}`, label: `h${i}`, type: 'export-symbol', score: 10 - i * 0.1,
      linksCount: 0, matchedTokens: ['handle'], annotationMatched: false,
    }));
    matches.push({
      id: 'domain:auth', label: 'auth', type: 'domain', score: 5,
      linksCount: 0, matchedTokens: [], annotationMatched: false,
    });
    matches.sort((a, b) => b.score - a.score);
    const dampened = applyExportSymbolDampeningIfNeeded(matches, 0.7, 10);
    expect(dampened).toBe(true);
    expect(matches[0].type).toBe('export-symbol');
    expect(matches[matches.length - 1].score).toBe(5);
    expect(matches[0].score).toBeCloseTo(10 * 0.35, 4);
  });

  it('dampens when top 5 are all export symbols even if wider window ratio is below threshold', () => {
    const matches = Array.from({ length: 5 }, (_, i) => ({
      id: `export:x/${i}`, label: `h${i}`, type: 'export-symbol', score: 20 - i,
      linksCount: 0, matchedTokens: ['handle'], annotationMatched: false,
    }));
    for (let i = 0; i < 5; i++) {
      matches.push({
        id: `mod:x/${i}`, label: `m${i}`, type: 'module', score: 10 - i * 0.5,
        linksCount: 0, matchedTokens: ['auth'], annotationMatched: false,
      });
    }
    matches.sort((a, b) => b.score - a.score);
    expect(applyExportSymbolDampeningIfNeeded(matches, 0.7, 10)).toBe(true);
  });
});

// ── SemanticIndex store ──

describe('SemanticIndex', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'repovine-semantic-'));
  });
  afterEach(async () => {
    await fsPromises.rm(dir, { recursive: true, force: true });
  });

  const filePathIn = (d: string) => semanticIndexFilePath(d);

  it('counts pending embed cards without loading the embedder', async () => {
    const embedder = new MockEmbedder();
    const index = new SemanticIndex(filePathIn(dir), embedder, 8);
    await index.sync(new Map([['a', 'auth login']]));
    expect(index.countPendingEmbed(new Map([['a', 'auth login']]))).toBe(0);
    expect(index.countPendingEmbed(new Map([['a', 'auth login'], ['b', 'new card']]))).toBe(1);
    expect(index.countPendingEmbed(new Map([['a', 'auth login changed']]))).toBe(1);
  });

  it('embeds only new/changed cards and prunes removed nodes', async () => {
    const embedder = new MockEmbedder();
    const index = new SemanticIndex(filePathIn(dir), embedder, 2);

    const first = await index.sync(new Map([['a', 'auth login'], ['b', 'date format']]));
    expect(first).toMatchObject({ embedded: 2, reused: 0, removed: 0, total: 2 });

    const second = await index.sync(new Map([['a', 'auth login'], ['b', 'date format']]));
    expect(second).toMatchObject({ embedded: 0, reused: 2, removed: 0, total: 2 });

    const third = await index.sync(new Map([['a', 'auth login'], ['b', 'date format with retry']]));
    expect(third).toMatchObject({ embedded: 1, reused: 1, removed: 0, total: 2 });

    const fourth = await index.sync(new Map([['a', 'auth login']]));
    expect(fourth).toMatchObject({ embedded: 0, reused: 1, removed: 1, total: 1 });
  });

  it('ranks query hits by cosine similarity', async () => {
    const embedder = new MockEmbedder();
    const index = new SemanticIndex(filePathIn(dir), embedder, 8);
    await index.sync(new Map([['a', 'auth login'], ['b', 'date format'], ['c', 'retry queue']]));
    const vector = await index.embedQuery('authentication for users');
    const hits = index.query(vector, 2);
    expect(hits[0].id).toBe('a');
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('reports when every persisted vector has incompatible dimensions', async () => {
    const embedder = new MockEmbedder();
    const index = new SemanticIndex(filePathIn(dir), embedder, 8);
    await index.sync(new Map([['a', 'auth login'], ['b', 'date format']]));

    const report = index.queryDetailed(new Float32Array([1, 0, 0]), 10);

    expect(report).toEqual({
      hits: [],
      indexed: 2,
      compared: 0,
      dimensionMismatches: 2,
    });
  });

  it('persists vectors and reloads them for the same embedder only', async () => {
    const embedder = new MockEmbedder();
    const index = new SemanticIndex(filePathIn(dir), embedder, 8);
    await index.sync(new Map([['a', 'auth login']]));

    const reloaded = await SemanticIndex.load(filePathIn(dir), new MockEmbedder(), 8);
    expect(reloaded.size).toBe(1);
    const report = await reloaded.sync(new Map([['a', 'auth login']]));
    expect(report.embedded).toBe(0);

    const otherModel = await SemanticIndex.load(filePathIn(dir), new MockEmbedder('mock:v2'), 8);
    expect(otherModel.size).toBe(0);
  });

  it('cardHash changes with embedder id and card text', () => {
    expect(cardHash('mock:v1', 'a')).not.toBe(cardHash('mock:v1', 'b'));
    expect(cardHash('mock:v1', 'a')).not.toBe(cardHash('mock:v2', 'a'));
  });

  it('reports batch progress while embedding pending cards', async () => {
    const embedder = new MockEmbedder();
    const index = new SemanticIndex(filePathIn(dir), embedder, 2);
    const progress: Array<[number, number]> = [];
    await index.sync(new Map([
      ['a', 'auth login'],
      ['b', 'date format'],
      ['c', 'retry queue'],
    ]), {
      onProgress: (done, total) => { progress.push([done, total]); },
    });
    expect(progress[0]).toEqual([0, 3]);
    expect(progress.at(-1)).toEqual([3, 3]);
    expect(progress.length).toBeGreaterThan(1);
  });
});

// ── embedder providers ──

describe('createEmbedder', () => {
  it('returns null when search embeddings are disabled', () => {
    expect(createEmbedder(false)).toBeNull();
  });

  it('builds a local embedder with a fixed model id when enabled', () => {
    const local = createEmbedder(true);
    expect(local!.id).toMatch(
      /^local:Xenova\/all-MiniLM-L6-v2;transformers@\d+\.\d+\.\d+;dtype=fp32$/,
    );
  });
});

// ── node cards ──

describe('node cards', () => {
  it('includes label, exports, and annotation text; excludes export symbols from the corpus', () => {
    const graph = makeFixtureGraph();
    addNode(graph, {
      id: 'export:test/session-store/createSession', type: 'export-symbol', label: 'createSession', description: '',
      data: { signature: 'function createSession(): void', symbolKind: 'function', lineRange: { start: 1, end: 2 } },
    });
    const moduleInfo: ModuleInfo = {
      id: 'mod:test/session-store',
      packageName: 'test',
      filePath: '/repo/session-store.ts',
      relativeFilePath: 'session-store.ts',
      contentHash: 'h',
      imports: [],
      exports: [{ name: 'createSession', kind: 'function', lineRange: { start: 1, end: 2 }, isDefault: false }],
    };
    const modulesById = new Map([[moduleInfo.id, moduleInfo]]);

    const cards = projectNodeCards(graph, modulesById, FIXTURE_ANNOTATIONS);
    expect(cards.has('export:test/session-store/createSession')).toBe(false);
    const card = cards.get('mod:test/session-store')!;
    expect(card).toContain('session-store (module)');
    expect(card).toContain('exports: createSession');
    expect(card).toContain('authentication tokens');
    expect(card).toContain('risk: Token expiry races with refresh');
  });

  it('builds cards for graph nodes even when annotations are empty', () => {
    const graph = makeFixtureGraph();
    const moduleInfo: ModuleInfo = {
      id: 'mod:test/session-store',
      packageName: 'test',
      filePath: '/repo/session-store.ts',
      relativeFilePath: 'session-store.ts',
      contentHash: 'h',
      imports: [],
      exports: [{ name: 'createSession', kind: 'function', lineRange: { start: 1, end: 2 }, isDefault: false }],
    };
    const cards = projectNodeCards(graph, new Map([[moduleInfo.id, moduleInfo]]), {});
    expect(cards.size).toBeGreaterThan(0);
    expect(cards.has('mod:test/session-store')).toBe(true);
    const card = cards.get('mod:test/session-store')!;
    expect(card).toContain('session-store (module)');
    expect(card).toContain('exports: createSession');
    expect(card).not.toContain('authentication');
  });

  it('buildNodeCard is deterministic', () => {
    const node = { id: 'mod:test/x', type: 'module', label: 'x', description: 'desc' };
    expect(buildNodeCard(node, undefined, undefined)).toBe(buildNodeCard(node, undefined, undefined));
  });

  it('fits the model-window budget and preserves behavioural fields before verbose export prose', () => {
    const stored = makeStoredAnnotation('mod:test/x', 'Short summary.', {
      invariants: ['TAIL_ONLY_AUTHORIZATION_GUARD must hold'],
      keyExports: Object.fromEntries(
        Array.from({ length: 30 }, (_, index) => [
          `verboseExport${index}`,
          `Long descriptive export prose ${index} ${'x'.repeat(80)}`,
        ]),
      ),
    });
    const projection = buildNodeCardProjection(
      { id: 'mod:test/x', type: 'module', label: 'x', description: '' },
      undefined,
      stored,
    );

    expect(projection.text.length).toBe(SEMANTIC_CARD_CHAR_BUDGET);
    expect(projection.truncated).toBe(true);
    expect(projection.text).toContain('TAIL_ONLY_AUTHORIZATION_GUARD');
    expect(projection.retainedByField.invariants).toBeGreaterThan(0);
    expect(projection.retainedAnnotationChars).toBeLessThan(projection.annotationChars);
  });

  it('keeps a behavioural phrase retrievable when verbose export prose would have pushed it past the window', async () => {
    const stored = makeStoredAnnotation('mod:test/x', 'Short summary.', {
      invariants: ['TAIL_ONLY_AUTHORIZATION_GUARD must hold'],
      keyExports: Object.fromEntries(
        Array.from({ length: 30 }, (_, index) => [
          `verboseExport${index}`,
          `Long descriptive export prose ${index} ${'x'.repeat(80)}`,
        ]),
      ),
    });
    const targetCard = buildNodeCard(
      { id: 'mod:test/x', type: 'module', label: 'x', description: '' },
      undefined,
      stored,
    );
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'repovine-card-tail-'));
    try {
      const index = new SemanticIndex(semanticIndexFilePath(tempDir), new MockEmbedder(), 8);
      await index.sync(new Map([
        ['mod:test/x', targetCard],
        ['mod:test/other', 'date formatting and localization'],
      ]));
      const query = await index.embedQuery('authorization guard');
      expect(index.query(query, 1)[0].id).toBe('mod:test/x');
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('skips identifier-only nodes that carry no exports or annotation', () => {
    const graph = createEmptyGraph();
    addNode(graph, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(graph, { id: 'domain:abortable-timeout', type: 'domain', label: 'abortable-timeout', description: '' });
    addNode(graph, { id: 'pkg:thin', type: 'package', label: 'thin', description: '' });
    addNode(graph, { id: 'mod:thin/barrel', type: 'module', label: 'barrel', description: '' }); // no moduleInfo → no exports
    addNode(graph, { id: 'mod:thin/real', type: 'module', label: 'real', description: '' });
    const moduleInfo: ModuleInfo = {
      id: 'mod:thin/real', packageName: 'thin', filePath: '/repo/real.ts', relativeFilePath: 'real.ts',
      contentHash: 'h', imports: [],
      exports: [{ name: 'doThing', kind: 'function', lineRange: { start: 1, end: 2 }, isDefault: false }],
    };
    const cards = projectNodeCards(graph, new Map([[moduleInfo.id, moduleInfo]]), {});
    // identifier-only nodes are redundant with the token index → not embedded
    expect(cards.has('domain:abortable-timeout')).toBe(false);
    expect(cards.has('pkg:thin')).toBe(false);
    expect(cards.has('mod:thin/barrel')).toBe(false);
    // a module with real export surface stays in the corpus
    expect(cards.has('mod:thin/real')).toBe(true);
  });

  it('promotes an un-exported node into the corpus once it has an annotation', () => {
    const graph = createEmptyGraph();
    addNode(graph, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(graph, { id: 'domain:auth', type: 'domain', label: 'auth', description: '' });
    const annotations = { 'domain:auth': makeStoredAnnotation('domain:auth', 'Authentication and session domain.') };
    const cards = projectNodeCards(graph, new Map(), annotations);
    expect(cards.has('domain:auth')).toBe(true);
    expect(cards.get('domain:auth')!).toContain('Authentication and session domain.');
  });
});

// ── search_context handler integration ──

describe('search_context handler with semantic backend', () => {
  let toolHandlers: Record<string, (ctx: McpToolRuntime, args: Record<string, unknown>) => unknown | Promise<unknown>>;
  beforeAll(async () => {
    ({ toolHandlers } = await import('../../../src/mcp/tools/registry.js'));
  });

  it('rejects a blank query before touching the search index', async () => {
    const ctx = makeCtx();
    const response = await toolHandlers['search_context'](ctx, { query: '   ' }) as Record<string, unknown>;

    expect(response.confidence).toBe('low');
    expect(response.summary).toBe('query is required');
    expect(response.result).toEqual(expect.objectContaining({ error: 'query is required' }));
  });

  it('reports a gap and stays token-only when the embedder fails', async () => {
    const failing = {
      size: 3,
      embedQuery: () => Promise.reject(new Error('connect ECONNREFUSED')),
    } as unknown as RepovineState['semanticIndex'];
    const ctx = makeCtx({ semanticIndex: failing });
    const envelope = await toolHandlers['search_context'](ctx, { query: 'authentication' }) as Record<string, unknown>;
    const gaps = envelope.gaps as string[];
    expect(gaps.some(g => g.includes('Semantic backend unavailable'))).toBe(true);
    const matches = (envelope.result as { matches: Record<string, unknown> }).matches;
    expect((matches.strategy as { semantic: { used: boolean } }).semantic.used).toBe(false);
  });

  it('fuses semantic hits into matches when the backend works', async () => {
    const embedder = new MockEmbedder();
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'repovine-semantic-handler-'));
    try {
      const index = new SemanticIndex(semanticIndexFilePath(dir), embedder, 8);
      await index.sync(new Map([['mod:test/formatting', 'date format helpers']]));
      const ctx = makeCtx({ semanticIndex: index });
      const envelope = await toolHandlers['search_context'](ctx, { query: 'format dates nicely' }) as Record<string, unknown>;
      const matches = (envelope.result as { matches: Record<string, unknown> }).matches;
      const top = (matches.topResults as Array<Record<string, unknown>>)[0];
      expect(top.id).toBe('mod:test/formatting');
      const semanticStrategy = (matches.strategy as { semantic: Record<string, unknown> }).semantic;
      expect(semanticStrategy.used).toBe(true);
      // The handler enriches what the ranker reported; it must not replace it. `candidates` is
      // set by searchGraph and is the only signal saying how many nodes the fusion actually saw.
      expect(semanticStrategy.candidates).toBeGreaterThan(0);
      expect(semanticStrategy.minCosine).toBeDefined();
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  });

  it('labels a semantic-only nearest neighbour as advisory rather than evidence of an answer', async () => {
    const semanticIndex = {
      size: 1,
      embedQuery: async () => new Float32Array([1]),
      queryDetailed: () => ({
        hits: [{ id: 'mod:test/formatting', score: 0.91 }],
        indexed: 1,
        compared: 1,
        dimensionMismatches: 0,
      }),
    } as unknown as RepovineState['semanticIndex'];
    const ctx = makeCtx({ semanticIndex });

    const response = await toolHandlers['search_context'](ctx, {
      query: 'quantum payroll blockchain',
    }) as Record<string, unknown>;
    const result = response.result as {
      matches: { suggestedScopes: Array<{ reason: string }> };
      emptyDiagnostic?: unknown;
    };

    expect(response.confidence).toBe('low');
    expect(response.summary).toContain('No token-backed match');
    expect((response.gaps as string[]).some(gap => gap.includes('not evidence'))).toBe(true);
    expect(result.matches.suggestedScopes[0].reason).toContain('Advisory semantic similarity');
    expect(result.emptyDiagnostic).toBeUndefined();
  });

  it('reports an empty dimension-mismatched semantic ranking instead of silently hiding it', async () => {
    const semanticIndex = {
      size: 2,
      embedQuery: async () => new Float32Array([1, 0, 0]),
      queryDetailed: () => ({
        hits: [],
        indexed: 2,
        compared: 0,
        dimensionMismatches: 2,
      }),
    } as unknown as RepovineState['semanticIndex'];
    const ctx = makeCtx({ semanticIndex });

    const response = await toolHandlers['search_context'](ctx, {
      query: 'quantum payroll blockchain',
    }) as Record<string, unknown>;
    const result = response.result as {
      matches: { strategy: { semantic: Record<string, unknown> } };
      emptyDiagnostic?: Record<string, unknown>;
    };

    expect(response.confidence).toBe('low');
    expect(result.emptyDiagnostic).toEqual(expect.objectContaining({ reason: 'no_token_hits' }));
    expect(result.matches.strategy.semantic).toEqual(expect.objectContaining({
      attempted: true,
      used: false,
      incompatibleDimensions: true,
      dimensionMismatches: 2,
    }));
    expect((response.gaps as string[]).some(gap => gap.includes('incompatible'))).toBe(true);
  });

  it('surfaces repository vocabulary for unknown tokens in gaps', async () => {
    const ctx = makeCtx();
    const envelope = await toolHandlers['search_context'](ctx, { query: 'formating' }) as Record<string, unknown>;
    const gaps = envelope.gaps as string[];
    expect(gaps.some(g => g.includes("Token 'formating' is unknown") && g.includes('formatting'))).toBe(true);
  });

  it('lowers confidence and reports posting-list truncation before global ranking', async () => {
    const graph = createEmptyGraph();
    addNode(graph, { id: 'root', type: 'root', label: 'root', description: '' });
    addNode(graph, { id: 'pkg:alpha-beta', type: 'package', label: 'alpha-beta', description: '' });
    addNode(graph, { id: 'mod:test/alpha', type: 'module', label: 'alpha', description: '' });
    addNode(graph, { id: 'mod:test/beta', type: 'module', label: 'beta', description: '' });
    const ctx = makeCtx({ graph, searchIndex: buildTokenIndex(graph, {}) });

    const response = await toolHandlers['search_context'](ctx, {
      query: 'alpha beta',
      match: 'or',
      perTokenLimit: 1,
    }) as Record<string, unknown>;
    const result = response.result as {
      matches: { strategy: { truncation: Record<string, unknown> } };
    };

    expect(response.confidence).toBe('low');
    expect(response.summary).toContain('truncated before global ranking');
    expect((response.gaps as string[]).some(gap => (
      gap.includes('posting lists were truncated')
      && gap.includes('alpha (1/2)')
      && gap.includes('beta (1/2)')
    ))).toBe(true);
    expect(Object.keys(result.matches.strategy.truncation)).toEqual(['alpha', 'beta']);
  });

  it('reports the types narrowing when node hits are removed by the requested type filter', async () => {
    const ctx = makeCtx();
    const response = await toolHandlers['search_context'](ctx, {
      query: 'authentication',
      types: ['runtime-resource'],
    }) as Record<string, unknown>;
    const result = response.result as { emptyDiagnostic?: Record<string, unknown> };

    expect(response.confidence).toBe('low');
    expect(result.emptyDiagnostic).toEqual(expect.objectContaining({
      reason: 'filtered_out',
      details: expect.objectContaining({
        types: ['runtime-resource'],
        narrowings: [{ by: 'types', value: ['runtime-resource'], after: 0, restoreWith: { arg: 'types', value: [] } }],
      }),
    }));
  });

  it('serves config-only searches without graph hits or empty diagnostics', async () => {
    const configModule: ModuleInfo = {
      id: 'mod:test/session-store',
      packageName: 'test',
      filePath: '/repo/session-store.ts',
      relativeFilePath: 'session-store.ts',
      contentHash: 'h',
      imports: [],
      exports: [],
      semanticHints: { envVars: ['SESSION_STORE_TOKEN'] },
    };
    const ctx = makeCtx({
      snapshot: {
        repoRoot: '/repo',
        timestamp: '2026-01-01',
        packages: [],
        modules: [configModule],
      },
      modulesById: new Map([[configModule.id, configModule]]),
    });

    const response = await toolHandlers['search_context'](ctx, {
      query: 'session-store',
      types: ['config'],
    }) as Record<string, unknown>;
    const result = response.result as {
      matches: Record<string, unknown>;
      configMatches: Array<Record<string, unknown>>;
      emptyDiagnostic?: unknown;
    };
    const navigation = response.navigation as { sideways: Array<{ tool: string }> };

    expect(result.matches).toEqual(expect.objectContaining({ totalResults: 0 }));
    expect(result.configMatches).toEqual([
      expect.objectContaining({ kind: 'env', name: 'SESSION_STORE_TOKEN' }),
    ]);
    expect(result.emptyDiagnostic).toBeUndefined();
    expect(navigation.sideways.some(item => item.tool === 'get_config_surface')).toBe(true);
  });

  it('pins one graph generation across the embed await (no stale-ranking-on-new-graph mix)', async () => {
    // S0's graph holds the semantically-ranked node; a refresh during the embed await swaps to S1
    // without it. Pinning makes searchGraph resolve the ranking against S0 (the generation that
    // produced it); without pinning it joins the G0 ranking onto G1 and drops the node.
    const graph0 = makeFixtureGraph();
    const graph1 = createEmptyGraph();
    addNode(graph1, { id: 'root', type: 'root', label: 'root', description: '' });

    let swapped = false;
    const semanticIndex = {
      size: 1,
      embedQuery: async () => { swapped = true; return new Float32Array([0, 1, 0, 0.1]); }, // swap mid-await
      queryDetailed: () => ({
        hits: [{ id: 'mod:test/formatting', score: 0.9 }],
        indexed: 1,
        compared: 1,
        dimensionMismatches: 0,
      }),
    } as unknown as RepovineState['semanticIndex'];

    const state0 = makeCtx({ graph: graph0, searchIndex: buildTokenIndex(graph0, {}), semanticIndex }).getState();
    const state1 = makeCtx({ graph: graph1, searchIndex: buildTokenIndex(graph1, {}) }).getState();
    const ctx: McpToolRuntime = {
      getState: () => (swapped ? state1 : state0),
      refreshRepoState: () => {},
      getConfig: () => CONFIG_DEFAULTS,
      repoRoot: '/repo',
    };

    const envelope = await toolHandlers['search_context'](ctx, { query: 'zzzunknownconcept' }) as Record<string, unknown>;
    const matches = (envelope.result as { matches: Record<string, unknown> }).matches;
    const ids = (matches.topResults as Array<{ id: string }>).map(r => r.id);
    expect(ids).toContain('mod:test/formatting');
  });
});
