import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AnnotationStore } from '../../src/annotations/store.js';
import { computeAnnotationQuality } from '../../src/annotations/quality.js';
import { refactoringCategoryDetail, refactoringNodeSummary } from '../../src/analysis/architecture/detail.js';
import { CONFIG_DEFAULTS } from '../../src/config.js';
import { addNode, createEmptyGraph } from '../../src/graph/index.js';
import { toolHandlers } from '../../src/mcp/tools/registry.js';
import { ProvenanceSchema } from '../../src/response/provenance.js';
import type { AnnotationStore as AnnotationStoreType } from '../../src/annotations/store.js';
import type { RefactoringFinding } from '../../src/analysis/architecture/types.js';
import type { McpToolRuntime, RepovineState } from '../../src/mcp/types.js';
import type { GraphNode, ModuleInfo, RepositoryFactsSnapshot } from '../../src/types.js';

// Law: a value the engine GRADES hands the reader the one provenance shape saying what produced it,
// on every surface that hands the value over — not only on the surface that also reports a problem.
//
// `quality.tier` reaching `comprehensive` is a weighted count of filled fields; the consistency axis
// deliberately does not move it (see annotations/quality.ts). That separation is sound only while the
// word arrives with its basis attached. It did not: the sentence naming what the score measures lived
// inside the provenance warning, which fires only when the write was NOT grounded in a context
// session. A write that inspected the node first — the correct path — got `comprehensive` with no
// statement of what the word measures, and so did every `inspect_node` reader.
//
// Each surface is checked against the literal basis, not against a second call of the code that
// produced it: a method the engine swapped for another valid one still passes a schema check.

const NODE = 'mod:pkg/service';

/**
 * What the completeness score is graded by, written out rather than computed.
 *
 * `provenance('field-completeness')` on both sides of the assertion would move together with any
 * swap and grade whatever the engine happens to say.
 */
const COMPLETENESS_BASIS = { basis: 'computed', method: 'field-completeness' };

function moduleInfo(id: string): ModuleInfo {
  const rel = id.replace(/^mod:/, '');
  return {
    id,
    packageName: rel.split('/')[0] ?? 'pkg',
    filePath: `/repo/${rel}.ts`,
    relativeFilePath: `${rel}.ts`,
    contentHash: `${id}:hash`,
    imports: [],
    exports: [],
  };
}

function moduleNode(id: string): GraphNode {
  const rel = id.replace(/^mod:/, '');
  return { id, type: 'module', label: rel, description: `Module ${rel}`, data: { relativeFilePath: `${rel}.ts` } };
}

function runtime(repoRoot: string, annotations: AnnotationStoreType): McpToolRuntime {
  const graph = createEmptyGraph();
  addNode(graph, moduleNode(NODE));
  const modules = [moduleInfo(NODE)];
  const state: RepovineState = {
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
  return { repoRoot, getState: () => state, getConfig: () => CONFIG_DEFAULTS, refreshRepoState: () => undefined };
}

/** An architecture finding over the annotated node, standing in for the report that selects one. */
function annotationRiskFinding(): RefactoringFinding {
  return {
    id: `annotation-risk:${NODE}`,
    category: 'annotation-risk',
    title: 'Annotation risk',
    severity: 'low',
    impact: 'low',
    confidence: 0.5,
    nodes: [NODE],
    evidence: [],
    suggestion: 'Read the annotation.',
  };
}

/** Only fields no ground truth can contradict, so the graded value is the sole subject of the test. */
const UNVERIFIABLE_ONLY = {
  summary: 'Service module filled with fields no graph fact can confirm or contradict.',
  invariants: ['first invariant', 'second invariant'],
  assumptions: ['first assumption', 'second assumption'],
  patterns: ['a pattern'],
  risks: [{ text: 'a risk' }],
  dataFlow: 'in -> out',
  extensionPoints: ['an extension point'],
  flowDescription: 'linear',
};

function qualityOf(value: unknown): Record<string, unknown> {
  return (value as { result?: { quality?: Record<string, unknown> } }).result?.quality ?? {};
}

describe('core-laws a graded value names what produced it', () => {
  let repoRoot: string;
  let store: AnnotationStoreType;
  let ctx: McpToolRuntime;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-graded-value-law-'));
    store = AnnotationStore.createSync(repoRoot);
    ctx = runtime(repoRoot, store);
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('grades the completeness score at its source', () => {
    const quality = computeAnnotationQuality(UNVERIFIABLE_ONLY, { exportCount: 0, lineCount: 10 });

    expect(quality.tier).toBe('comprehensive');
    expect(quality.provenance).toEqual(COMPLETENESS_BASIS);
    expect(ProvenanceSchema.safeParse(quality.provenance).success).toBe(true);
  });

  it('carries the basis on the write surface, with no warning to carry it', async () => {
    const response = await toolHandlers.write_annotation(ctx, {
      nodeId: NODE,
      annotation: UNVERIFIABLE_ONLY,
      durable: false,
    });

    // The path under test is the clean one: no consistency issue, no provenance warning.
    expect((response as { result?: { warnings?: unknown } }).result?.warnings).toBeUndefined();
    expect(qualityOf(response).tier).toBe('comprehensive');
    expect(qualityOf(response).provenance).toEqual(COMPLETENESS_BASIS);
    expect(ProvenanceSchema.safeParse(qualityOf(response).provenance).success).toBe(true);
  });

  it('carries the basis on the read surface', async () => {
    await toolHandlers.write_annotation(ctx, { nodeId: NODE, annotation: UNVERIFIABLE_ONLY, durable: false });

    const inspected = await toolHandlers.inspect_node(ctx, { nodeId: NODE });
    const meta = (inspected as { result?: { annotationMeta?: { quality?: Record<string, unknown> } } })
      .result?.annotationMeta?.quality ?? {};

    expect(meta.tier).toBe('comprehensive');
    expect(meta.provenance).toEqual(COMPLETENESS_BASIS);
    expect(ProvenanceSchema.safeParse(meta.provenance).success).toBe(true);
  });

  it('carries the basis on both architecture-detail projections', async () => {
    await toolHandlers.write_annotation(ctx, { nodeId: NODE, annotation: UNVERIFIABLE_ONLY, durable: false });
    const { graph, modulesById, annotations } = ctx.getState();
    const noFreshness = (): undefined => undefined;

    // The node summary under `affectedNodes`, and the per-category block beside it: two call sites,
    // one graded value, so a basis added on one of them is not the law being met.
    const summary = refactoringNodeSummary(graph, modulesById, annotations, NODE, noFreshness);
    const summaryQuality = (summary as { annotation?: { quality?: Record<string, unknown> } })
      .annotation?.quality ?? {};
    const detail = refactoringCategoryDetail(graph, modulesById, annotations, annotationRiskFinding(), noFreshness);
    const detailQuality = (detail as { quality?: Record<string, unknown> }).quality ?? {};

    expect(summaryQuality.tier).toBe('comprehensive');
    expect(summaryQuality.provenance).toEqual(COMPLETENESS_BASIS);
    expect(detailQuality.tier).toBe('comprehensive');
    expect(detailQuality.provenance).toEqual(COMPLETENESS_BASIS);
  });
});
