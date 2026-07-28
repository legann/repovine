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
import type { GraphNode, ModuleInfo, RepositoryFactsSnapshot } from '../../src/types.js';

// Law: `validate_annotations` reports the annotation field-to-graph consistency axis.
//
// This is deliberately NOT a totality law over every validation axis the engine may ever add. The
// engine has no registry that makes such a claim enforceable: an independent `namingConsistency`
// count can be added without this fixture learning about it. This law owns the narrower regression
// that exists today: the write path computes whether filled annotation fields contradict graph facts,
// and the validation report must publish that same advisory axis and point to its details.
//
// Accounting is reporting, not gating. The axis stays advisory: it is a claim about content the
// author wrote, while `status` answers whether the drain queue is empty, and folding one into the
// other would make `repovine status` exit non-zero on a repository whose notes are all current.

const NODE = 'mod:pkg/service';
const REAL_EXPORT = 'realExport';
const GHOST_EXPORT = 'ghostExportTheModuleDoesNotHave';

function moduleInfo(): ModuleInfo {
  return {
    id: NODE,
    packageName: 'pkg',
    filePath: '/repo/pkg/service.ts',
    relativeFilePath: 'pkg/service.ts',
    contentHash: 'revision-one',
    imports: [],
    exports: [{ name: REAL_EXPORT, kind: 'function', isDefault: false, lineRange: { start: 1, end: 3 } }],
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

function runtime(repoRoot: string, annotations: AnnotationStoreType): McpToolRuntime {
  const graph = createEmptyGraph();
  addNode(graph, moduleNode());
  const modules = [moduleInfo()];
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

interface NextAction {
  tool?: string;
  args?: Record<string, unknown>;
  reason: string;
}

function validation(value: unknown): {
  status?: string;
  counts?: Record<string, number>;
  nextActions?: NextAction[];
} {
  return (value as { result?: { validation?: Record<string, never> } }).result?.validation ?? {};
}

/** Identity of one next action: two runs offer the same action when tool, args and reason all match. */
function actionKey(action: NextAction): string {
  return JSON.stringify([action.tool, action.args, action.reason]);
}

/** The contradicting names as the pointed-at view publishes them. */
function inconsistentSample(value: unknown): Array<{ nodeId: string; issues: string[] }> {
  const coverage = (value as {
    result?: {
      coverage?: { anomalies?: { inconsistent?: { sample?: Array<{ nodeId: string; issues: string[] }> } } };
    };
  }).result?.coverage;
  return coverage?.anomalies?.inconsistent?.sample ?? [];
}

function persistence(value: unknown): { durable?: boolean; persisted?: boolean } {
  return (value as {
    result?: { persistence?: { durable?: boolean; persisted?: boolean } };
  }).result?.persistence ?? {};
}

describe('core-laws validate reports annotation field-to-graph consistency', () => {
  let repoRoot: string;
  let store: AnnotationStoreType;
  let ctx: McpToolRuntime;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-validate-axis-law-'));
    store = AnnotationStore.createSync(repoRoot);
    ctx = runtime(repoRoot, store);
  });

  afterEach(async () => {
    await store.drain();
    fs.rmSync(repoRoot, { recursive: true, force: true });
    expect(fs.existsSync(repoRoot)).toBe(false);
  });

  it('reports zero contradictions and leaves the durable store untouched', async () => {
    const write = await toolHandlers.write_annotation(ctx, {
      nodeId: NODE,
      annotation: {
        summary: 'Service module whose declared export is the one the module really has.',
        keyExports: { [REAL_EXPORT]: 'the export the module really has' },
      },
      durable: true,
    });
    expect(persistence(write)).toEqual({ durable: true, persisted: true });

    const filePath = path.join(repoRoot, 'repovine.annots.json');
    const bytesBefore = fs.readFileSync(filePath);
    const memoryBefore = JSON.stringify(store.get(NODE));

    const report = validation(await toolHandlers.validate_annotations(ctx, {}));
    expect(report.status).toBe('clean');
    expect(report.counts?.inconsistent).toBe(0);
    expect(fs.readFileSync(filePath)).toEqual(bytesBefore);
    expect(JSON.stringify(store.get(NODE))).toBe(memoryBefore);
  });

  it('reports the contradiction it was handed, points to its names, and keeps it advisory', async () => {
    // Baseline taken before the contradiction exists. Other axes offer calls to the same tool on this
    // fixture and in a real repository, so an assertion that only asks whether some
    // `get_annotation_status` action is present answers yes with this axis deleted.
    const before = validation(await toolHandlers.validate_annotations(ctx, {}));
    const offeredBefore = new Set((before.nextActions ?? []).map(actionKey));

    const write = await toolHandlers.write_annotation(ctx, {
      nodeId: NODE,
      annotation: {
        summary: 'Service module declaring an export name the graph has no record of at all.',
        keyExports: { [GHOST_EXPORT]: 'declared but absent from the module' },
      },
      durable: true,
    });
    expect(persistence(write)).toEqual({ durable: true, persisted: true });

    // The write path sees the contradiction — this is the signal the health report used to drop.
    const consistency = (write as { result?: { quality?: { consistency?: { ok?: boolean } } } })
      .result?.quality?.consistency;
    expect(consistency?.ok).toBe(false);

    const filePath = path.join(repoRoot, 'repovine.annots.json');
    const bytesBefore = fs.readFileSync(filePath);
    const memoryBefore = JSON.stringify(store.get(NODE));
    const report = validation(await toolHandlers.validate_annotations(ctx, {}));
    expect(report.counts?.inconsistent).toBe(1);
    expect(fs.readFileSync(filePath)).toEqual(bytesBefore);
    expect(JSON.stringify(store.get(NODE))).toBe(memoryBefore);

    // The contradicting names are reachable from the verdict, not left for the caller to find. Two
    // halves: the contradiction earns the report a call it did not offer before, and that call answers
    // with the name the graph does not have.
    const gained = (report.nextActions ?? []).filter(action => !offeredBefore.has(actionKey(action)));
    const pointer = gained.find(action => action.tool === 'get_annotation_status');
    if (!pointer?.args) {
      throw new Error(`No get_annotation_status call was added for the contradiction. Added: ${JSON.stringify(gained)}`);
    }

    const pointed = await toolHandlers.get_annotation_status(ctx, pointer.args);
    expect(JSON.stringify(pointed)).toContain(GHOST_EXPORT);
    expect(inconsistentSample(pointed)).toEqual([
      { nodeId: NODE, issues: [`keyExports:${GHOST_EXPORT}`] },
    ]);

    // Advisory: the note is current, so the drain queue is empty and the verdict says so.
    expect(report.status).toBe('clean');
  });
});
