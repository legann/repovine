import { describe, expect, it, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AnnotationStore } from '../../../src/annotations/store.js';
import {
  serializeAnnotationFile,
  ANNOTATIONS_RELATIVE_PATH,
} from '../../../src/annotations/maintenance.js';
import { rememberInterpreterEntrypoints } from '../../../src/stage2/interpreter/entrypoint-store.js';
import { addEdge, addNode, createEmptyGraph } from '../../../src/graph/index.js';
import { CONFIG_DEFAULTS } from '../../../src/config.js';
import { toolHandlers } from '../../../src/mcp/tools/registry.js';
import { readBoundaryIndex, boundaryIndexFilePath } from '../../../src/mcp/boundary-index.js';
import type { AnnotationStore as AnnotationStoreType } from '../../../src/annotations/store.js';
import type { McpToolRuntime, RepovineState } from '../../../src/mcp/types.js';
import type {
  GraphNode,
  GraphEdge,
  ModuleInfo,
  RepositoryFactsSnapshot,
  StoredAnnotation,
} from '../../../src/types.js';

type NavItem = { tool: string; args: Record<string, unknown>; reason: string };
type ToolEnvelope = {
  scope: string;
  resolvedScope: Record<string, unknown>;
  summary: string;
  confidence: 'high' | 'medium' | 'low';
  result: Record<string, unknown>;
  gaps: string[];
  navigation: Record<'deeper' | 'sideways' | 'up' | 'cross_layer' | 'validate', NavItem[]>;
};

function envelope(value: unknown): ToolEnvelope {
  return value as ToolEnvelope;
}

function nestedRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function navTools(response: ToolEnvelope, section: keyof ToolEnvelope['navigation']): string[] {
  return response.navigation[section].map(item => item.tool);
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-mcp-annotation-tools-'));
}

function annotation(
  nodeId: string,
  summary = 'Stable annotation summary',
  extra: Partial<StoredAnnotation['annotation']> = {},
  updatedAt = '2026-01-01T00:00:00.000Z',
  contentHash = `${nodeId}:hash`,
): StoredAnnotation {
  return {
    nodeId,
    nodeType: 'module',
    contentHash,
    pass: 1,
    updatedAt,
    annotation: { summary, ...extra },
    schemaVersion: 1,
  };
}

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
  return {
    id,
    type: 'module',
    label: rel,
    description: `Module ${rel}`,
    data: { relativeFilePath: `${rel}.ts` },
  };
}

function graphFor(moduleIds: string[], edges: GraphEdge[] = []) {
  const graph = createEmptyGraph();
  for (const id of moduleIds) addNode(graph, moduleNode(id));
  for (const edge of edges) addEdge(graph, edge.from, edge.to, edge.kind, edge.metadata);
  return graph;
}

function writeAnnotationFile(repoRoot: string, annotations: Record<string, StoredAnnotation>): void {
  const filePath = path.join(repoRoot, ANNOTATIONS_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, serializeAnnotationFile({ version: 1, annotations }), 'utf-8');
}

function writeConflictFile(repoRoot: string, ours: Record<string, StoredAnnotation>, theirs: Record<string, StoredAnnotation>): string {
  const oursText = serializeAnnotationFile({ version: 1, annotations: ours });
  const theirsText = serializeAnnotationFile({ version: 1, annotations: theirs });
  const content = [
    '<<<<<<< HEAD',
    oursText,
    '=======',
    theirsText,
    '>>>>>>> feature',
  ].join('\n');
  const filePath = path.join(repoRoot, ANNOTATIONS_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return content;
}

function runtime(
  repoRoot: string,
  moduleIds: string[],
  annotations: AnnotationStoreType,
  refreshRepoState: McpToolRuntime['refreshRepoState'] = () => undefined,
  edges: GraphEdge[] = [],
): McpToolRuntime {
  const graph = graphFor(moduleIds, edges);
  const modules = moduleIds.map(moduleInfo);
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
  return {
    repoRoot,
    getState: () => state,
    getConfig: () => CONFIG_DEFAULTS,
    refreshRepoState,
  };
}

describe('annotation MCP tool contracts', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = tmpRoot();
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('validate_annotations reports conflict markers and navigates to merge_annotations', async () => {
    writeConflictFile(repoRoot, {
      'mod:a': annotation('mod:a', 'Ours summary'),
    }, {
      'mod:a': annotation('mod:a', 'Theirs summary'),
    });
    const ctx = runtime(repoRoot, ['mod:a'], AnnotationStore.createSync(repoRoot));

    const response = envelope(await toolHandlers.validate_annotations(ctx, {}));
    const validation = nestedRecord(response.result.validation);
    const mergeStatus = nestedRecord(validation.mergeStatus);
    const file = nestedRecord(mergeStatus.file);

    expect(response).toMatchObject({
      scope: 'all',
      confidence: 'medium',
      result: expect.any(Object),
      gaps: expect.any(Array),
      navigation: expect.objectContaining({
        deeper: expect.any(Array),
        sideways: expect.any(Array),
        up: expect.any(Array),
        cross_layer: expect.any(Array),
        validate: expect.any(Array),
      }),
    });
    expect(file.hasConflictMarkers).toBe(true);
    expect(navTools(response, 'validate')).toContain('merge_annotations');
  });

  it('validate_annotations reports orphans with review and cleanup navigation', async () => {
    writeAnnotationFile(repoRoot, {
      'mod:orphaned': annotation('mod:orphaned'),
    });
    const ctx = runtime(repoRoot, [], AnnotationStore.createSync(repoRoot));

    const response = envelope(await toolHandlers.validate_annotations(ctx, {}));
    const validation = nestedRecord(response.result.validation);
    const counts = nestedRecord(validation.counts);

    expect(counts.orphaned).toBe(1);
    expect(navTools(response, 'validate')).toEqual(expect.arrayContaining([
      'get_annotation_status',
      'refresh_context',
    ]));
    expect(response.navigation.validate).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'refresh_context', args: { cleanupOrphans: true } }),
    ]));
  });

  it('validate_annotations returns scopedClean for a clean scope while repo-wide work remains', async () => {
    writeAnnotationFile(repoRoot, {
      'mod:backend/service': annotation('mod:backend/service'),
    });
    const ctx = runtime(repoRoot, ['mod:backend/service', 'mod:frontend/page'], AnnotationStore.createSync(repoRoot));

    const response = envelope(await toolHandlers.validate_annotations(ctx, { scope: 'pkg:backend' }));
    const validation = nestedRecord(response.result.validation);
    const counts = nestedRecord(validation.counts);

    expect(response.confidence).toBe('high');
    expect(response.gaps).toEqual([]);
    expect(response.summary).toContain('Annotations are valid in scope [pkg:backend]');
    expect(validation.scopedClean).toBe(true);
    expect(validation.needsWorkInScope).toBe(0);
    expect(counts.unannotated).toBe(1);
  });

  it('validate_annotations resolves a graph-backed scope instead of echoing kind:"unknown"', async () => {
    writeAnnotationFile(repoRoot, {
      'mod:backend/service': annotation('mod:backend/service'),
    });
    const ctx = runtime(repoRoot, ['mod:backend/service'], AnnotationStore.createSync(repoRoot));

    const response = envelope(await toolHandlers.validate_annotations(ctx, { scope: 'mod:backend/service' }));
    const resolved = nestedRecord(response.resolvedScope);
    expect(resolved.kind).toBe('module');
    expect(resolved.id).toBe('mod:backend/service');
  });

  it('write_annotation refreshImportBaseline plus refresh_context validates a downstream scope clean', async () => {
    const moduleIds = ['mod:app/leaf', 'mod:app/consumer', 'mod:app/entry'];
    const imports: GraphEdge[] = [
      { from: 'mod:app/consumer', to: 'mod:app/leaf', kind: 'imports' },
      { from: 'mod:app/entry', to: 'mod:app/consumer', kind: 'imports' },
    ];
    writeAnnotationFile(repoRoot, {
      'mod:app/leaf': annotation(
        'mod:app/leaf',
        'Leaf still has an older annotation after its content changed.',
        {},
        '2026-01-01T00:00:00.000Z',
        'mod:app/leaf:old',
      ),
      'mod:app/consumer': {
        ...annotation('mod:app/consumer', 'Consumer imports leaf and has reviewed baseline notes.', {
          sideEffects: [{ kind: 'pure' }],
        }),
        importBaseline: { 'mod:app/leaf': 'mod:app/leaf:old' },
      },
      'mod:app/entry': {
        ...annotation('mod:app/entry', 'Entrypoint imports the consumer module.'),
        importBaseline: { 'mod:app/consumer': 'mod:app/consumer:hash' },
      },
    });
    const refreshRepoState = jest.fn<() => void>();
    const ctx = runtime(repoRoot, moduleIds, AnnotationStore.createSync(repoRoot), refreshRepoState, imports);
    rememberInterpreterEntrypoints(ctx.getState().graph, [{ kind: 'route', moduleId: 'mod:app/entry', id: 'ep:app' }]);

    const before = envelope(await toolHandlers.validate_annotations(ctx, { scope: 'pkg:app/consumer' }));
    const beforeValidation = nestedRecord(before.result.validation);
    expect(beforeValidation.scopedClean).toBe(false);
    expect(beforeValidation.needsWorkInScope).toBe(1);
    expect(nestedRecord(beforeValidation.counts).stalePropagation).toBe(1);

    const write = envelope(await toolHandlers.write_annotation(ctx, {
      nodeId: 'mod:app/consumer',
      refreshImportBaseline: true,
    }));
    expect(write.confidence).toBe('high');
    expect(nestedRecord(write.result).importBaselineRefreshed).toBe(true);
    expect(ctx.getState().annotations.get('mod:app/consumer')?.importBaseline).toEqual({
      'mod:app/leaf': 'mod:app/leaf:hash',
    });

    const refresh = envelope(await toolHandlers.refresh_context(ctx, {}));
    expect(refresh.confidence).toBe('high');
    expect(refreshRepoState).toHaveBeenCalledTimes(1);

    const after = envelope(await toolHandlers.validate_annotations(ctx, { scope: 'pkg:app/consumer' }));
    const afterValidation = nestedRecord(after.result.validation);
    const counts = nestedRecord(afterValidation.counts);
    expect(after.summary).toContain('Annotations are valid in scope [pkg:app/consumer]');
    expect(afterValidation.scopedClean).toBe(true);
    expect(afterValidation.needsWorkInScope).toBe(0);
    expect(counts.stalePropagation).toBe(0);
    expect(counts.staleContent).toBe(1);
  });

  it('write_annotation rejects nested secret values with fieldPaths before persistence', async () => {
    const ctx = runtime(repoRoot, ['mod:billing/secrets'], AnnotationStore.createSync(repoRoot));

    const response = envelope(await toolHandlers.write_annotation(ctx, {
      nodeId: 'mod:billing/secrets',
      annotation: {
        summary: 'Tracks config names without storing credential values.',
        assumptions: ['client_secret=supersecret123'],
        risks: [{ text: 'token=abcdefghi', scope: 'local' }],
      },
    }));

    expect(response.confidence).toBe('low');
    expect(response.result.error).toContain('secret values');
    expect(response.result.fieldPaths).toEqual([
      'annotation.assumptions[0]',
      'annotation.risks[0].text',
    ]);
    expect(ctx.getState().annotations.get('mod:billing/secrets')).toBeUndefined();
    const savedText = fs.existsSync(path.join(repoRoot, ANNOTATIONS_RELATIVE_PATH))
      ? fs.readFileSync(path.join(repoRoot, ANNOTATIONS_RELATIVE_PATH), 'utf-8')
      : '';
    expect(savedText).not.toContain('mod:billing/secrets');
    expect(savedText).not.toContain('supersecret123');
    expect(savedText).not.toContain('abcdefghi');
  });

  it('get_annotation_merge_status always suggests validate_annotations', async () => {
    writeAnnotationFile(repoRoot, {
      'mod:a': annotation('mod:a'),
    });
    const ctx = runtime(repoRoot, ['mod:a'], AnnotationStore.createSync(repoRoot));

    const response = envelope(await toolHandlers.get_annotation_merge_status(ctx, {}));

    expect(response.confidence).toBe('high');
    expect(response.gaps).toEqual([]);
    expect(navTools(response, 'validate')).toContain('validate_annotations');
  });

  it('merge_annotations refreshes state once after a successful non-dry-run write', async () => {
    writeConflictFile(repoRoot, {
      'mod:ours': annotation('mod:ours', 'Ours only summary'),
    }, {
      'mod:theirs': annotation('mod:theirs', 'Theirs only summary'),
    });
    const refreshRepoState = jest.fn<() => void>();
    const ctx = runtime(repoRoot, ['mod:ours', 'mod:theirs'], AnnotationStore.createSync(repoRoot), refreshRepoState);

    const response = envelope(await toolHandlers.merge_annotations(ctx, {}));
    const merge = nestedRecord(response.result.merge);

    expect(response.confidence).toBe('high');
    expect(merge.status).toBe('merged');
    expect(merge.wroteFile).toBe(true);
    expect(refreshRepoState).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(repoRoot, ANNOTATIONS_RELATIVE_PATH), 'utf-8')).not.toContain('<<<<<<<');
    expect(navTools(response, 'validate')).toContain('validate_annotations');
  });

  it('merge_annotations dryRun leaves disk unchanged and skips refresh', async () => {
    const before = writeConflictFile(repoRoot, {
      'mod:a': annotation('mod:a', 'Ours summary'),
    }, {
      'mod:b': annotation('mod:b', 'Theirs summary'),
    });
    const refreshRepoState = jest.fn<() => void>();
    const ctx = runtime(repoRoot, ['mod:a', 'mod:b'], AnnotationStore.createSync(repoRoot), refreshRepoState);

    const response = envelope(await toolHandlers.merge_annotations(ctx, { dryRun: true }));
    const merge = nestedRecord(response.result.merge);

    expect(merge.status).toBe('dry-run');
    expect(merge.wroteFile).toBe(false);
    expect(refreshRepoState).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(repoRoot, ANNOTATIONS_RELATIVE_PATH), 'utf-8')).toBe(before);
  });

  it('merge_annotations surfaces scalar conflicts with bounded inspect navigation', async () => {
    const ours: Record<string, StoredAnnotation> = {};
    const theirs: Record<string, StoredAnnotation> = {};
    for (let i = 0; i < 6; i++) {
      ours[`mod:conflict-${i}`] = annotation(`mod:conflict-${i}`, `Ours summary ${i}`, {}, '2026-01-03T00:00:00.000Z');
      theirs[`mod:conflict-${i}`] = annotation(`mod:conflict-${i}`, `Theirs summary ${i}`, {}, '2026-01-02T00:00:00.000Z');
    }
    writeConflictFile(repoRoot, ours, theirs);
    const ctx = runtime(repoRoot, Object.keys(ours), AnnotationStore.createSync(repoRoot));

    const response = envelope(await toolHandlers.merge_annotations(ctx, { dryRun: true }));
    const merge = nestedRecord(response.result.merge);
    const conflicts = merge.annotationConflicts as unknown[];

    expect(conflicts).toHaveLength(6);
    expect(response.confidence).toBe('medium');
    expect(response.gaps).toEqual(expect.arrayContaining([
      '6 annotation conflict(s) need review.',
      expect.stringContaining('Scalar conflicts add patterns merge-review:*'),
    ]));
    expect(response.navigation.deeper.length).toBeGreaterThan(0);
    expect(response.navigation.deeper.length).toBeLessThanOrEqual(5);
    expect(response.navigation.deeper.every(item => item.tool === 'inspect_node')).toBe(true);
    expect(navTools(response, 'validate')).toContain('validate_annotations');
  });

  it('write_annotation with a boundary risk keeps the pre-edit push index in sync (no refresh)', async () => {
    const ctx = runtime(repoRoot, ['mod:app/contracts/dto'], AnnotationStore.createSync(repoRoot));
    expect(fs.existsSync(boundaryIndexFilePath(repoRoot))).toBe(false);

    const write = envelope(await toolHandlers.write_annotation(ctx, {
      nodeId: 'mod:app/contracts/dto',
      annotation: {
        summary: 'Published DTO consumed across services; the fields are a wire contract.',
        risks: [{ text: 'published wire contract; do not rename fields', scope: 'boundary' }],
      },
    }));

    expect(write.confidence).toBe('high');
    const entries = (readBoundaryIndex(repoRoot)?.entries ?? {}) as Record<string, { risks: string[] }[]>;
    const risks = Object.values(entries).flat().flatMap(e => e.risks);
    expect(risks).toContain('published wire contract; do not rename fields');
  });

  it('write_annotation removing the last boundary risk drops it from the push index', async () => {
    const ctx = runtime(repoRoot, ['mod:app/contracts/dto'], AnnotationStore.createSync(repoRoot));
    await toolHandlers.write_annotation(ctx, {
      nodeId: 'mod:app/contracts/dto',
      annotation: {
        summary: 'Published DTO consumed across services; the fields are a wire contract.',
        risks: [{ text: 'published wire contract; do not rename fields', scope: 'boundary' }],
      },
    });
    expect(Object.keys(readBoundaryIndex(repoRoot)?.entries ?? {})).toHaveLength(1);

    await toolHandlers.write_annotation(ctx, {
      nodeId: 'mod:app/contracts/dto',
      annotation: { risks: [{ text: 'internal helper only', scope: 'local' }] },
    });
    expect(readBoundaryIndex(repoRoot)?.entries).toEqual({});
  });

  it('write_annotation without a risks change does not touch the push index', async () => {
    const ctx = runtime(repoRoot, ['mod:app/util'], AnnotationStore.createSync(repoRoot));
    const write = envelope(await toolHandlers.write_annotation(ctx, {
      nodeId: 'mod:app/util',
      annotation: { summary: 'A plain utility module with no boundary surface at all.' },
    }));
    expect(write.confidence).toBe('high');
    expect(fs.existsSync(boundaryIndexFilePath(repoRoot))).toBe(false);
  });
});

describe('decline_advisory (carrier-link-gaps) and the carrier-gaps status view', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = tmpRoot();
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  const CHAIN_MODULES = ['mod:app/importer', 'mod:app/mid', 'mod:app/target'];
  const CHAIN_EDGES: GraphEdge[] = [
    { from: 'mod:app/importer', to: 'mod:app/mid', kind: 'imports' },
    { from: 'mod:app/mid', to: 'mod:app/target', kind: 'imports' },
  ];

  function chainCtx(): McpToolRuntime {
    writeAnnotationFile(repoRoot, {
      'mod:app/importer': annotation('mod:app/importer', 'Importer summary'),
      'mod:app/target': annotation('mod:app/target', 'Target summary', {
        risks: [{ text: 'importer must verify gate locally', scope: 'consumer' }],
      }),
    });
    return runtime(repoRoot, CHAIN_MODULES, AnnotationStore.createSync(repoRoot), () => undefined, CHAIN_EDGES);
  }

  it('declines a flagged target, persists review state, and drops the pair from counts', async () => {
    const ctx = chainCtx();

    const response = envelope(await toolHandlers.decline_advisory(ctx, {
      kind: 'carrier-link-gaps',
      ids: ['mod:app/target'],
      reason: 'direct importers already flagged 1-hop',
    }));

    expect(response.confidence).toBe('high');
    expect(response.result.declined).toEqual(['mod:app/target']);
    expect(response.result.ignored).toEqual([]);
    expect(nestedRecord(response.result.carrierLinkGaps)).toEqual({
      missingCarrierLinks: 0,
      suppressedTargets: 1,
    });
    expect(fs.existsSync(path.join(repoRoot, '.repovine', 'carrier-review.json'))).toBe(true);
    expect(navTools(response, 'sideways')).toContain('get_annotation_status');
    expect(navTools(response, 'validate')).toContain('validate_annotations');
  });

  it('declines every flagged target with all: true and echoes unknown ids as ignored', async () => {
    const ctx = chainCtx();

    const unknown = envelope(await toolHandlers.decline_advisory(ctx, {
      kind: 'carrier-link-gaps',
      ids: ['mod:app/not-flagged'],
    }));
    expect(unknown.result.declined).toEqual([]);
    expect(unknown.result.ignored).toEqual(['mod:app/not-flagged']);
    expect(unknown.confidence).toBe('medium');

    const all = envelope(await toolHandlers.decline_advisory(ctx, { kind: 'carrier-link-gaps', all: true }));
    expect(all.result.declined).toEqual(['mod:app/target']);
    expect(nestedRecord(all.result.carrierLinkGaps)).toEqual({
      missingCarrierLinks: 0,
      suppressedTargets: 1,
    });
  });

  it('requires ids or all and returns guidance without writing state', async () => {
    const ctx = chainCtx();

    const response = envelope(await toolHandlers.decline_advisory(ctx, { kind: 'carrier-link-gaps' }));

    expect(response.result.declined).toEqual([]);
    expect(response.gaps.some(gap => gap.includes('carrier-gaps'))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, '.repovine', 'carrier-review.json'))).toBe(false);
  });

  it('rejects a missing or unknown kind with an error envelope and writes nothing', async () => {
    const ctx = chainCtx();

    for (const args of [{}, { kind: 'risk-scope-candidates' }, { kind: 'carrier', all: true }]) {
      const response = envelope(await toolHandlers.decline_advisory(ctx, args));
      expect(String(nestedRecord(response.result).error)).toContain('kind');
      expect(response.gaps.some(gap => gap.includes('domains-config') && gap.includes('carrier-link-gaps'))).toBe(true);
    }
    expect(fs.existsSync(path.join(repoRoot, '.repovine', 'carrier-review.json'))).toBe(false);
  });

  it('carrier-gaps view groups pairs by target and keeps reviewed targets visible', async () => {
    const ctx = chainCtx();

    const before = envelope(await toolHandlers.get_annotation_status(ctx, { view: 'carrier-gaps' }));
    const beforeGaps = nestedRecord(before.result.carrierGaps);
    expect(beforeGaps.missingCarrierLinks).toBe(1);
    expect(beforeGaps.suppressedTargets).toBe(0);
    expect(beforeGaps.totalTargets).toBe(1);
    expect(beforeGaps.items).toEqual([
      expect.objectContaining({
        targetId: 'mod:app/target',
        reviewed: null,
        importerIds: ['mod:app/importer'],
      }),
    ]);

    await toolHandlers.decline_advisory(ctx, { kind: 'carrier-link-gaps', ids: ['mod:app/target'], reason: 'reviewed' });

    const after = envelope(await toolHandlers.get_annotation_status(ctx, { view: 'carrier-gaps' }));
    const afterGaps = nestedRecord(after.result.carrierGaps);
    expect(afterGaps.missingCarrierLinks).toBe(0);
    expect(afterGaps.suppressedTargets).toBe(1);
    expect(afterGaps.totalTargets).toBe(1);
    const items = afterGaps.items as Array<Record<string, unknown>>;
    expect(items[0]?.targetId).toBe('mod:app/target');
    expect(nestedRecord(items[0]?.reviewed)).toMatchObject({ hashValid: true, reason: 'reviewed' });
    const pagination = nestedRecord(afterGaps.pagination);
    expect(pagination).toMatchObject({ total: 1, returned: 1, nextOffset: null });
  });
});
