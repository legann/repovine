import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, expect, it, beforeEach, afterEach, jest } from '@jest/globals';
import type {
  RepositoryGraph,
  RepositoryFactsSnapshot,
  ModuleInfo,
  AnnotationContent,
  SemanticHints,
  GraphNode,
  GraphEdge,
  StoredAnnotation,
} from '../../../src/types.js';
import { DEFAULT_PROPAGATION_CONFIG } from '../../../src/config.js';
import { rememberInterpreterEntrypoints } from '../../../src/stage2/interpreter/entrypoint-store.js';
import { AnnotationStore as RealAnnotationStore, type AnnotationStore, type AnnotationHealthScan } from '../../../src/annotations/store.js';
import {
  validateAssignment,
  validateRunResult,
  validateReviewInput,
  checkCompliance,
  resolveGraphNodeId,
  validateAndCheckCompliance,
  type ComplianceState,
} from '../../../src/agents/validation.js';
import { nodeInScopeHints } from '../../../src/annotations/scope-hints.js';
import type { AgentRunResult, AgentAssignment } from '../../../src/agents/protocol.js';
import type { ContextQualityReport } from '../../../src/context-quality/types.js';

// ── Fakes ──

function fakeGraph(nodeIds: string[]): RepositoryGraph {
  const nodes = new Map(nodeIds.map(id => [id, { type: 'module' }]));
  return { nodes } as unknown as RepositoryGraph;
}

function realGraph(nodes: GraphNode[], edges: GraphEdge[]): RepositoryGraph {
  const nodeMap = new Map<string, GraphNode>();
  const outEdges = new Map<string, GraphEdge[]>();
  const inEdges = new Map<string, GraphEdge[]>();
  const byType = new Map<GraphNode['type'], Set<string>>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
    if (!byType.has(node.type)) byType.set(node.type, new Set());
    byType.get(node.type)!.add(node.id);
  }
  for (const edge of edges) {
    if (!outEdges.has(edge.from)) outEdges.set(edge.from, []);
    outEdges.get(edge.from)!.push(edge);
    if (!inEdges.has(edge.to)) inEdges.set(edge.to, []);
    inEdges.get(edge.to)!.push(edge);
  }
  return { nodes: nodeMap, edges, outEdges, inEdges, byType };
}

function realModule(id: string, contentHash: string): ModuleInfo {
  const rel = id.replace(/^mod:/, '');
  return {
    id,
    packageName: rel.split('/')[0] ?? 'pkg',
    filePath: `/repo/${rel}.ts`,
    relativeFilePath: `${rel}.ts`,
    contentHash,
    imports: [],
    exports: [],
  };
}

function realAnnotation(
  nodeId: string,
  contentHash: string,
  importBaseline?: Record<string, string>,
): StoredAnnotation {
  return {
    nodeId,
    nodeType: 'module',
    contentHash,
    pass: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    annotation: { summary: 'Stored annotation for compliance propagation checks.' },
    ...(importBaseline ? { importBaseline } : {}),
    schemaVersion: 2,
  };
}

type FakeScanRow = { nodeId: string; status: 'unannotated' | 'stale'; staleKind?: 'content' | 'propagation'; phase?: string };

/** Build an AnnotationHealthScan from plain rows, mirroring scanAnnotationHealth. */
function fakeScan(rows: FakeScanRow[]): AnnotationHealthScan {
  const full = rows.map(r => ({ phase: 'module', ...r }));
  let stale = 0;
  let staleContent = 0;
  let stalePropagation = 0;
  let unannotated = 0;
  for (const r of full) {
    if (r.status === 'unannotated') unannotated++;
    else if (r.staleKind === 'propagation') { stale++; stalePropagation++; }
    else { stale++; staleContent++; }
  }
  return {
    counts: { needsWork: full.length, stale, staleContent, stalePropagation, unannotated },
    rows: full,
    sample: (limit: number, predicate?: (row: FakeScanRow) => boolean) => {
      const out: Array<{ nodeId: string; status: string; staleKind?: string; moduleKind: string; reason: string }> = [];
      for (const r of full) {
        if (out.length >= limit) break;
        if (predicate && !predicate(r)) continue;
        out.push({ nodeId: r.nodeId, status: r.status, ...(r.staleKind ? { staleKind: r.staleKind } : {}), moduleKind: 'module', reason: 'needs work' });
      }
      return out;
    },
  } as unknown as AnnotationHealthScan;
}

function fakeStore(opts: { annotated?: string[]; orphaned?: string[]; stale?: string[]; derived?: string[] } = {}): AnnotationStore {
  const annotated = new Set(opts.annotated ?? []);
  const orphaned = opts.orphaned ?? [];
  const stale = opts.stale ?? [];
  const derived = opts.derived ?? [];
  return {
    get: (id: string) => (annotated.has(id) ? ({ nodeId: id, annotation: { summary: 's' } } as unknown) : undefined),
    getAll: () => Object.fromEntries([...annotated].map(id => [id, { nodeId: id, annotation: { summary: 's' } }])),
    detectOrphaned: () => ({
      total: orphaned.length,
      orphaned: orphaned.map(id => ({ nodeId: id, nodeType: 'module', pass: 1, updatedAt: '', summaryPreview: '', reason: 'node_missing' })),
      byType: {},
    }),
    scanAnnotationHealth: () => fakeScan([
      ...stale.map((id): FakeScanRow => ({ nodeId: id, status: 'stale', staleKind: 'content' })),
      ...derived.map((id): FakeScanRow => ({ nodeId: id, status: 'stale', staleKind: 'propagation' })),
    ]),
  } as unknown as AnnotationStore;
}

function makeResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    protocolVersion: '1',
    runId: 'r1',
    status: 'complete',
    summary: 'done',
    scope: [],
    filesChanged: [],
    graphNodesTouched: [],
    contractsChanged: [],
    testsRun: [],
    annotationsWritten: [],
    compliance: {
      refreshContextRun: true,
      annotationsClean: true,
      dependencyImpactChecked: true,
      configSurfaceChecked: true,
      flowChecked: true,
      architectureChecked: true,
    },
    blockers: [],
    ...overrides,
  };
}

function makeAssignment(overrides: Partial<AgentAssignment> = {}): AgentAssignment {
  return {
    protocolVersion: '1',
    runId: 'r1',
    task: 't',
    scope: [],
    acceptanceCriteria: [],
    constraints: [],
    contracts: [],
    requestedChecks: [],
    ...overrides,
  };
}

describe('schema validation', () => {
  it('accepts a valid assignment', () => {
    const v = validateAssignment(makeAssignment());
    expect(v.valid).toBe(true);
    expect(v.value?.runId).toBe('r1');
  });

  it('flags an unsupported protocol version distinctly', () => {
    const v = validateRunResult({ ...makeResult(), protocolVersion: '2' });
    expect(v.valid).toBe(false);
    expect(v.unsupportedVersion).toBe('2');
    expect(v.errors[0]).toMatch(/Unsupported protocolVersion/);
  });

  it('reports missing fields for a malformed run result', () => {
    const v = validateRunResult({ protocolVersion: '1', runId: 'r' });
    expect(v.valid).toBe(false);
    expect(v.errors.join(' ')).toMatch(/status|summary|compliance/);
  });

  it('rejects a result whose review is not an object (harness normalizers preserve it raw)', () => {
    const v = validateRunResult({ ...makeResult(), review: 'not an object' });
    expect(v.valid).toBe(false);
    expect(v.errors.join(' ')).toMatch(/review/);
  });
});

describe('validateReviewInput', () => {
  function makeReviewInput(overrides: Record<string, unknown> = {}) {
    return {
      assignment: makeAssignment({ runId: 'run-impl-1', scope: ['pkg/src'] }),
      implementationResult: makeResult({
        runId: 'run-impl-1',
        filesChanged: ['pkg/src/a.ts', 'pkg/src/b.ts'],
        graphNodesTouched: ['mod:pkg/src/a', 'mod:pkg/src/b'],
      }),
      diffBase: 'tree-baseline',
      changedFiles: ['pkg/src/a.ts', 'pkg/src/b.ts'],
      graphNodesTouched: ['mod:pkg/src/a', 'mod:pkg/src/b'],
      ...overrides,
    };
  }

  it('accepts a linkage-consistent ReviewInput regardless of path/id ordering', () => {
    const v = validateReviewInput(makeReviewInput({
      changedFiles: ['./pkg/src/b.ts', 'pkg/src/a.ts'],
      graphNodesTouched: ['mod:pkg/src/b', 'mod:pkg/src/a'],
    }));
    expect(v.valid).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('rejects a runId linkage mismatch (assignment is the implementation assignment)', () => {
    const v = validateReviewInput(makeReviewInput({
      assignment: makeAssignment({ runId: 'run-review-1', scope: ['pkg/src'] }),
    }));
    expect(v.valid).toBe(false);
    expect(v.errors.join(' ')).toMatch(/linkage: assignment\.runId/);
  });

  it('rejects changedFiles that do not set-equal implementationResult.filesChanged', () => {
    const v = validateReviewInput(makeReviewInput({ changedFiles: ['pkg/src/a.ts'] }));
    expect(v.valid).toBe(false);
    expect(v.errors.join(' ')).toMatch(/changedFiles must set-equal/);
  });

  it('rejects graphNodesTouched that do not set-equal implementationResult.graphNodesTouched', () => {
    const v = validateReviewInput(makeReviewInput({ graphNodesTouched: ['mod:pkg/src/a'] }));
    expect(v.valid).toBe(false);
    expect(v.errors.join(' ')).toMatch(/graphNodesTouched must set-equal/);
  });

  it('rejects absolute and parent-traversal path entries', () => {
    const abs = validateReviewInput(makeReviewInput({
      changedFiles: ['/etc/passwd', 'pkg/src/b.ts'],
      implementationResult: makeResult({
        runId: 'run-impl-1',
        filesChanged: ['/etc/passwd', 'pkg/src/b.ts'],
        graphNodesTouched: ['mod:pkg/src/a', 'mod:pkg/src/b'],
      }),
    }));
    expect(abs.valid).toBe(false);
    expect(abs.errors.join(' ')).toMatch(/absolute path not allowed/);

    const traversal = validateReviewInput(makeReviewInput({
      changedFiles: ['../secret.ts', 'pkg/src/b.ts'],
      implementationResult: makeResult({
        runId: 'run-impl-1',
        filesChanged: ['../secret.ts', 'pkg/src/b.ts'],
        graphNodesTouched: ['mod:pkg/src/a', 'mod:pkg/src/b'],
      }),
    }));
    expect(traversal.valid).toBe(false);
    expect(traversal.errors.join(' ')).toMatch(/parent-traversal not allowed/);
  });

  it('rejects a structurally malformed ReviewInput', () => {
    const v = validateReviewInput({ assignment: {}, diffBase: '' });
    expect(v.valid).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
  });

  it('normalizes interior "." segments and trailing separators before set comparison', () => {
    const v = validateReviewInput(makeReviewInput({
      changedFiles: ['pkg/./src/a.ts', 'pkg/src/b.ts/'],
    }));
    expect(v.valid).toBe(true);
    expect(v.errors).toEqual([]);

    const dotTail = validateReviewInput(makeReviewInput({
      changedFiles: ['pkg/src/a.ts', 'pkg/src/b.ts/.'],
    }));
    expect(dotTail.valid).toBe(true);
  });
});

describe('resolveGraphNodeId', () => {
  it('matches exact then extension/index-normalized ids', () => {
    const g = fakeGraph(['mod:a/b']);
    expect(resolveGraphNodeId(g, 'mod:a/b')).toBe('mod:a/b');
    expect(resolveGraphNodeId(g, 'mod:a/b.ts')).toBe('mod:a/b');
    expect(resolveGraphNodeId(g, 'mod:missing')).toBeUndefined();
  });
});

describe('compliance validation', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-compliance-'));
    // Minimal, parseable annotations file so mergeStatus.file.exists is true.
    fs.writeFileSync(path.join(repoRoot, 'repovine.annots.json'), '{"version":1,"annotations":{}}\n');
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  function qualityReport(overrides: Partial<ContextQualityReport> = {}): ContextQualityReport {
    return {
      sessionId: 'sess-1',
      phase: 'explore',
      overall: 0.8,
      noisePenalty: 0.1,
      structureBonus: 0.9,
      acceptHandoff: true,
      belowWarningThreshold: false,
      rejectReasons: [],
      warnings: [],
      requiredFollowups: [],
      aggregates: {
        toolCallCount: 3,
        searchCallCount: 1,
        mapCallCount: 1,
        inspectCallCount: 1,
        totalResponseBytes: 1000,
        maxSingleResponseBytes: 500,
        maxArchitectureResponseBytes: 0,
        maxTotalResultsInSearch: 3,
        orSearchCount: 0,
        recoveredOrSearchCount: 0,
        unrecoveredOrSearchCount: 0,
        lowConfidenceCount: 0,
        unresolvedScopeCount: 0,
        capabilityDominantSearchCount: 0,
        avgCapRatio: 0,
        testPackageHitCount: 0,
        stableAnchors: ['pkg:a'],
        recoveredFromNoise: false,
        hadImpactOnModule: false,
        endedWithSearchOnly: false,
        lastTool: 'inspect_node',
        lastResolvedScope: 'pkg:a',
      },
      policy: { required: true, mode: 'harness', qualityThreshold: 0.55, warningThreshold: 0.7, minAnchors: 1, byteBudget: 80_000, retain: false },
      requestEchoes: [],
      ...overrides,
    };
  }

  function state(opts: {
    nodes?: string[];
    annotated?: string[];
    orphaned?: string[];
    stale?: string[];
    derived?: string[];
    contextQualityReport?: ContextQualityReport;
  } = {}): ComplianceState {
    return {
      repoRoot,
      graph: fakeGraph(opts.nodes ?? []),
      snapshot: {} as unknown as RepositoryFactsSnapshot,
      annotations: fakeStore(opts),
      ...(opts.contextQualityReport
        ? { getContextQualityReport: () => opts.contextQualityReport }
        : {}),
    };
  }

  it('passes a clean run', () => {
    const report = checkCompliance({
      result: makeResult({ scope: ['x'], filesChanged: ['a.ts'], graphNodesTouched: ['mod:a/b'] }),
      assignment: makeAssignment({ scope: ['x'] }),
      state: state({ nodes: ['mod:a/b'] }),
    });
    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.unresolvedGraphNodes).toEqual([]);
  });

  it('errors on unresolved graph nodes', () => {
    const report = checkCompliance({
      result: makeResult({ graphNodesTouched: ['mod:does/not/exist'] }),
      state: state({ nodes: ['mod:a/b'] }),
    });
    expect(report.valid).toBe(false);
    expect(report.unresolvedGraphNodes).toEqual(['mod:does/not/exist']);
  });

  it('errors on runId mismatch', () => {
    const report = checkCompliance({
      result: makeResult({ runId: 'r1' }),
      assignment: makeAssignment({ runId: 'r2' }),
      state: state(),
    });
    expect(report.valid).toBe(false);
    expect(report.errors.join(' ')).toMatch(/runId mismatch/);
  });

  it('errors on annotations claimed but not stored', () => {
    const report = checkCompliance({
      result: makeResult({ annotationsWritten: ['mod:a/b'] }),
      state: state({ nodes: ['mod:a/b'], annotated: [] }),
    });
    expect(report.missingAnnotations).toEqual(['mod:a/b']);
    expect(report.valid).toBe(false);
  });

  it('warns on stale declared annotations without claiming clean', () => {
    const report = checkCompliance({
      // annotationsClean:false is honest about the stale queue, so only the warning fires.
      result: makeResult({
        annotationsWritten: ['mod:a/b'],
        compliance: { ...makeResult().compliance, annotationsClean: false },
      }),
      state: state({ nodes: ['mod:a/b'], annotated: ['mod:a/b'], stale: ['mod:a/b'] }),
    });
    expect(report.staleAnnotations).toEqual(['mod:a/b']);
    expect(report.valid).toBe(true); // stale is a warning, not a hard failure
  });

  it('errors when annotationsClean is claimed but state is dirty', () => {
    const report = checkCompliance({
      result: makeResult({ compliance: { ...makeResult().compliance, annotationsClean: true } }),
      state: state({ orphaned: ['mod:ghost'] }),
    });
    expect(report.valid).toBe(false);
    expect(report.errors.join(' ')).toMatch(/annotationsClean=true but annotation hard checks are not clean/);
    expect(report.orphanedAnnotations).toContain('mod:ghost');
  });

  it('accepts scoped annotationsClean on harness implement when global stale is outside scope', () => {
    const report = checkCompliance({
      result: makeResult({
        scope: ['backend'],
        filesChanged: ['backend/src/a.ts'],
        graphNodesTouched: ['mod:backend/src/a'],
        compliance: { ...makeResult().compliance, annotationsClean: true },
      }),
      assignment: makeAssignment({
        scope: ['backend'],
        contextSession: { required: false, mode: 'harness', phase: 'implement' },
      }),
      state: state({
        nodes: ['mod:backend/src/a', 'infra:docker-compose:docker-compose.yml'],
        annotated: ['mod:backend/src/a'],
        stale: ['infra:docker-compose:docker-compose.yml'],
      }),
      manifestName: 'project-subagent-sample',
    });
    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings.join(' ')).toMatch(/outside-scope debt to annotation-sync/);
  });

  it('accepts scoped annotationsClean on an annotate-phase sync sub-agent when stale is outside its scope', () => {
    const report = checkCompliance({
      result: makeResult({
        scope: ['backend'],
        annotationsWritten: ['mod:backend/src/a'],
        compliance: { ...makeResult().compliance, annotationsClean: true },
      }),
      assignment: makeAssignment({
        scope: ['backend'],
        contextSession: { required: false, mode: 'harness', phase: 'annotate' },
      }),
      state: state({
        nodes: ['mod:backend/src/a', 'mod:frontend/src/b'],
        annotated: ['mod:backend/src/a'],
        stale: ['mod:frontend/src/b'], // sibling scope still draining — not this sub-agent's job
      }),
      manifestName: 'repovine-annotation-writer',
    });
    expect(report.errors.join(' ')).not.toMatch(/annotation hard checks are not clean/);
    expect(report.warnings.join(' ')).toMatch(/outside-scope debt to annotation-sync/);
  });

  it('builds a single annotation scan per run, even through the scoped annotationsClean gate', () => {
    const st = state({
      nodes: ['mod:backend/src/a', 'infra:docker-compose:docker-compose.yml'],
      annotated: ['mod:backend/src/a'],
      stale: ['infra:docker-compose:docker-compose.yml'],
    });
    const scanSpy = jest.spyOn(st.annotations, 'scanAnnotationHealth');
    checkCompliance({
      result: makeResult({
        scope: ['backend'],
        filesChanged: ['backend/src/a.ts'],
        graphNodesTouched: ['mod:backend/src/a'],
        compliance: { ...makeResult().compliance, annotationsClean: true },
      }),
      assignment: makeAssignment({
        scope: ['backend'],
        contextSession: { required: false, mode: 'harness', phase: 'implement' },
      }),
      state: st,
      manifestName: 'project-subagent-sample',
    });
    expect(scanSpy).toHaveBeenCalledTimes(1);
  });

  it('errors when annotationsClean is claimed but propagation-stale items remain', () => {
    const report = checkCompliance({
      result: makeResult({
        annotationsWritten: ['mod:a/b'],
        compliance: { ...makeResult().compliance, annotationsClean: true },
      }),
      state: state({
        nodes: ['mod:a/b'],
        annotated: ['mod:a/b'],
        derived: ['mod:a/b'],
      }),
    });

    expect(report.valid).toBe(false);
    expect(report.errors.join(' ')).toMatch(/propagation-stale/);
  });

  it('cross-checks propagation-stale annotations from the real store scan', () => {
    const moduleIds = ['mod:app/leaf', 'mod:app/consumer', 'mod:app/entry'];
    const graph = realGraph(
      moduleIds.map(id => ({
        id,
        type: 'module' as const,
        label: id.replace(/^mod:/, ''),
        description: '',
      })),
      [
        { from: 'mod:app/consumer', to: 'mod:app/leaf', kind: 'imports' },
        { from: 'mod:app/entry', to: 'mod:app/consumer', kind: 'imports' },
      ],
    );
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot,
      timestamp: '2026-01-01T00:00:00.000Z',
      packages: [],
      modules: [
        realModule('mod:app/leaf', 'h_leaf_v2'),
        realModule('mod:app/consumer', 'h_consumer'),
        realModule('mod:app/entry', 'h_entry'),
      ],
    };
    const entrypoints = [{ kind: 'route', moduleId: 'mod:app/entry', id: 'ep:app' }] as const;
    rememberInterpreterEntrypoints(graph, entrypoints);

    const annotations = RealAnnotationStore.createSync(repoRoot);
    annotations.set('mod:app/leaf', realAnnotation('mod:app/leaf', 'h_leaf_v1'));
    annotations.set('mod:app/consumer', realAnnotation('mod:app/consumer', 'h_consumer', {
      'mod:app/leaf': 'h_leaf_v1',
    }));
    annotations.set('mod:app/entry', realAnnotation('mod:app/entry', 'h_entry', {
      'mod:app/consumer': 'h_consumer',
    }));
    annotations.flush();

    const directScan = annotations.scanAnnotationHealth(graph, snapshot, {
      propagation: { ...DEFAULT_PROPAGATION_CONFIG },
      entrypoints,
    });
    expect(directScan.rows).toEqual([
      { nodeId: 'mod:app/leaf', status: 'stale', staleKind: 'content', phase: 'module' },
      { nodeId: 'mod:app/consumer', status: 'stale', staleKind: 'propagation', phase: 'module' },
    ]);

    const scanSpy = jest.spyOn(annotations, 'scanAnnotationHealth');
    const report = checkCompliance({
      result: makeResult({
        scope: ['app/consumer'],
        graphNodesTouched: ['mod:app/consumer'],
        annotationsWritten: ['mod:app/consumer'],
        compliance: { ...makeResult().compliance, annotationsClean: true },
      }),
      assignment: makeAssignment({
        scope: ['app/consumer'],
        contextSession: { required: false, mode: 'harness', phase: 'implement' },
      }),
      state: { repoRoot, graph, snapshot, annotations },
      manifestName: 'project-subagent-sample',
    });

    expect(scanSpy).toHaveBeenCalledTimes(1);
    expect(report.valid).toBe(false);
    expect(report.errors.join(' ')).toMatch(/Declared annotation is propagation-stale.*mod:app\/consumer/);
    expect(report.errors.join(' ')).toMatch(/propagation-stale annotation\(s\) remain in assignment scope/);
  });

  it('allows harness implement phase to defer annotation coverage honestly', () => {
    const report = checkCompliance({
      result: makeResult({
        filesChanged: ['a.ts'],
        graphNodesTouched: ['mod:a/b'],
        compliance: { ...makeResult().compliance, annotationsClean: false },
      }),
      assignment: makeAssignment({
        scope: ['.'],
        contextSession: { required: false, mode: 'harness', phase: 'implement' },
      }),
      state: state({ nodes: ['mod:a/b'], annotated: ['mod:a/b'], stale: ['mod:a/b'] }),
      manifestName: 'project-subagent-sample',
    });
    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it('enforces annotation coverage in harness annotate phase', () => {
    const report = checkCompliance({
      result: makeResult({
        scope: ['.'],
        compliance: { ...makeResult().compliance, annotationsClean: false },
      }),
      assignment: makeAssignment({
        scope: ['.'],
        contextSession: { required: false, mode: 'harness', phase: 'annotate' },
      }),
      state: state({ nodes: ['mod:a/b'], annotated: ['mod:a/b'], stale: ['mod:a/b'] }),
    });
    expect(report.valid).toBe(false);
    expect(report.errors.join(' ')).toMatch(/Annotation coverage incomplete/);
  });

  it('nodeInScopeHints: infra scope matches infra graph kinds, not app modules', () => {
    expect(nodeInScopeHints('infra:dockerfile:backend/Dockerfile', ['infra'])).toBe(true);
    expect(nodeInScopeHints('domain:infra-docker-compose', ['infra'])).toBe(true);
    expect(nodeInScopeHints('mod:backend/src/server', ['infra'])).toBe(false);
    expect(nodeInScopeHints('mod:backend/src/server', ['backend'])).toBe(true);
  });

  it('limits harness annotate coverage to infra scope without backend stale nodes', () => {
    const report = checkCompliance({
      result: makeResult({
        scope: ['infra'],
        compliance: { ...makeResult().compliance, annotationsClean: false },
      }),
      assignment: makeAssignment({
        scope: ['infra'],
        contextSession: { required: false, mode: 'harness', phase: 'annotate' },
      }),
      state: state({
        nodes: ['infra:docker-compose:docker-compose.yml', 'mod:backend/src/server'],
        annotated: ['mod:backend/src/server'],
        stale: ['infra:docker-compose:docker-compose.yml', 'mod:backend/src/server'],
      }),
    });
    expect(report.valid).toBe(false);
    expect(report.errors.join(' ')).toMatch(/infra:docker-compose:docker-compose.yml/);
    expect(report.errors.join(' ')).not.toMatch(/mod:backend\/src\/server/);
  });

  it('warns when refresh_context was not run after file changes', () => {
    const report = checkCompliance({
      result: makeResult({ filesChanged: ['a.ts'], compliance: { ...makeResult().compliance, refreshContextRun: false } }),
      state: state(),
    });
    expect(report.warnings.join(' ')).toMatch(/refreshContextRun=false/);
  });

  it('warns when requested checks are not reflected', () => {
    const report = checkCompliance({
      result: makeResult({ compliance: { ...makeResult().compliance, dependencyImpactChecked: false }, testsRun: [] }),
      assignment: makeAssignment({ requestedChecks: ['dependencies', 'tests'] }),
      state: state(),
    });
    expect(report.warnings.join(' ')).toMatch(/dependencies/);
    expect(report.warnings.join(' ')).toMatch(/tests/);
  });

  it('flags result scope outside the assignment scope', () => {
    const report = checkCompliance({
      result: makeResult({ scope: ['packages/a', 'packages/b'] }),
      assignment: makeAssignment({ scope: ['packages/a'] }),
      state: state(),
    });
    expect(report.scopeCollisions).toEqual(['packages/b']);
  });

  it('validates ContextPack anchors and warns on prior context scope drift', () => {
    const report = checkCompliance({
      result: makeResult({
        scope: ['packages/b'],
        contextPack: {
          scope: ['packages/a'],
          resolvedAnchors: [{ nodeId: 'mod:missing', role: 'primary', reason: 'task anchor' }],
          entrypoints: [],
          contracts: [],
          dependencyNotes: [],
          configNotes: [],
          flowNotes: [],
          architectureSignals: [],
          assumptions: [],
          openQuestions: [],
          recommendedNextActions: [],
        },
      }),
      assignment: makeAssignment({
        scope: ['packages/a'],
        priorContext: {
          ref: 'ctx-1',
          scope: ['packages/a'],
        },
      }),
      state: state({ nodes: ['mod:a/b'] }),
    });
    expect(report.valid).toBe(false);
    expect(report.unresolvedGraphNodes).toContain('mod:missing');
    expect(report.errors.join(' ')).toMatch(/contextPack\.resolvedAnchors/);
    expect(report.warnings.join(' ')).toMatch(/priorContext\.scope/);
  });

  it('validates architecture audit node claims and proposed assignment scope', () => {
    const report = checkCompliance({
      result: makeResult({
        compliance: { ...makeResult().compliance, architectureChecked: true },
        architectureAudit: {
          auditScope: ['packages/a'],
          categories: ['boundary'],
          findings: [{
            findingId: 'boundary:f1',
            status: 'confirmed',
            severity: 'high',
            confidence: 0.9,
            nodes: ['mod:missing'],
            evidence: ['crosses boundary'],
            recommendedAction: 'split module',
            proposedAssignment: {
              task: 'Split module',
              scope: ['packages/b'],
              acceptanceCriteria: [],
              constraints: [],
              contracts: [],
              requestedChecks: ['dependencies'],
            },
          }],
        },
      }),
      assignment: makeAssignment({ scope: ['packages/a'] }),
      state: state({ nodes: ['mod:a/b'] }),
    });
    expect(report.valid).toBe(false);
    expect(report.errors.join(' ')).toMatch(/architectureAudit finding/);
    expect(report.warnings.join(' ')).toMatch(/proposes assignment scope outside auditScope/);
  });

  it('requires a review object when code-review is requested', () => {
    const report = checkCompliance({
      result: makeResult(),
      assignment: makeAssignment({ requestedChecks: ['code-review'] }),
      state: state(),
    });
    expect(report.valid).toBe(false);
    expect(report.errors.join(' ')).toMatch(/Requested check "code-review"/);
  });

  it('enforces read-only review and rejects approve with serious findings', () => {
    const report = checkCompliance({
      result: makeResult({
        filesChanged: ['packages/a/src/b.ts'],
        review: {
          verdict: 'approve',
          reviewedFiles: ['packages/a/src/b.ts'],
          reviewedDiffBase: 'HEAD~1',
          criteriaChecked: ['tests pass'],
          testReview: {
            claimedTestsRun: [],
            reviewerTestsRun: [],
            coverageAssessment: 'adequate',
            missingTests: [],
          },
          findings: [{
            severity: 'major',
            file: 'packages/a/src/b.ts',
            graphNodeId: 'mod:a/b',
            summary: 'Breaks contract',
            evidence: 'returns wrong shape',
            recommendation: 'fix return type',
          }],
          residualRisks: [],
        },
      }),
      assignment: makeAssignment({ scope: ['packages/a'], requestedChecks: ['code-review'] }),
      state: state({ nodes: ['mod:a/b'] }),
    });
    expect(report.valid).toBe(false);
    expect(report.errors.join(' ')).toMatch(/read-only/);
    expect(report.errors.join(' ')).toMatch(/approve/);
  });

  it('rejects an otherwise-valid approve when test coverage is not adequate', () => {
    // Isolate the coverageAssessment gate: read-only (no filesChanged), no serious
    // findings, no serious missingTests (minor keeps the missing-tests gate quiet
    // while still explaining the weak coverage), reviewedFiles present, code-review
    // requested. Only the coverageAssessment gate should fire.
    const report = checkCompliance({
      result: makeResult({
        review: {
          verdict: 'approve',
          reviewedFiles: ['packages/a/src/b.ts'],
          reviewedDiffBase: 'HEAD~1',
          criteriaChecked: ['tests pass'],
          testReview: {
            claimedTestsRun: [],
            reviewerTestsRun: [],
            coverageAssessment: 'insufficient',
            missingTests: [{ behavior: 'error path', suggestedTest: 'add case', severity: 'minor' }],
          },
          findings: [],
          residualRisks: [],
        },
      }),
      assignment: makeAssignment({ scope: ['packages/a'], requestedChecks: ['code-review'] }),
      state: state(),
    });
    expect(report.valid).toBe(false);
    // Exactly this gate — not read-only, not the serious-findings gate.
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatch(/testReview\.coverageAssessment="insufficient"/);
    expect(report.errors.join(' ')).not.toMatch(/read-only/);
    expect(report.errors.join(' ')).not.toMatch(/blocker\/major/);
  });

  it('rejects approve when review.testReview.missingTests has blocker/major entries', () => {
    const report = checkCompliance({
      result: makeResult({
        review: {
          verdict: 'approve',
          reviewedFiles: ['packages/a/src/b.ts'],
          reviewedDiffBase: 'HEAD~1',
          criteriaChecked: ['tests pass'],
          testReview: {
            claimedTestsRun: [],
            reviewerTestsRun: [],
            coverageAssessment: 'adequate',
            missingTests: [{ behavior: 'error path', suggestedTest: 'add case', severity: 'blocker' }],
          },
          findings: [],
          residualRisks: [],
        },
      }),
      assignment: makeAssignment({ scope: ['packages/a'], requestedChecks: ['code-review'] }),
      state: state(),
    });
    expect(report.valid).toBe(false);
    expect(report.errors.join(' ')).toMatch(/missingTests contains 1 blocker\/major/);
  });

  it('rejects approve on a major missingTests entry too (not only blocker)', () => {
    const report = checkCompliance({
      result: makeResult({
        review: {
          verdict: 'approve',
          reviewedFiles: ['packages/a/src/b.ts'],
          reviewedDiffBase: 'HEAD~1',
          criteriaChecked: ['tests pass'],
          testReview: {
            claimedTestsRun: [],
            reviewerTestsRun: [],
            coverageAssessment: 'adequate',
            missingTests: [{ behavior: 'error path', suggestedTest: 'add case', severity: 'major' }],
          },
          findings: [],
          residualRisks: [],
        },
      }),
      assignment: makeAssignment({ scope: ['packages/a'], requestedChecks: ['code-review'] }),
      state: state(),
    });
    expect(report.valid).toBe(false);
    expect(report.errors.join(' ')).toMatch(/missingTests contains 1 blocker\/major/);
  });

  it('rejects a read-only manifest that reports source edits', () => {
    const report = checkCompliance({
      result: makeResult({ filesChanged: ['packages/a/src/b.ts'], graphNodesTouched: ['mod:a/b'] }),
      assignment: makeAssignment({ scope: ['packages/a'] }),
      state: state({ nodes: ['mod:a/b'] }),
      manifestName: 'repovine-code-reviewer',
    });
    expect(report.valid).toBe(false);
    expect(report.errors.join(' ')).toMatch(/read-only \(canEditFiles=false\).*filesChanged/);
  });

  it('rejects an annotate-phase result that reports source edits', () => {
    const report = checkCompliance({
      result: makeResult({ filesChanged: ['packages/a/src/b.ts'], graphNodesTouched: ['mod:a/b'], compliance: { ...makeResult().compliance, annotationsClean: false } }),
      assignment: makeAssignment({
        scope: ['packages/a'],
        contextSession: { required: false, mode: 'harness', phase: 'annotate' },
      }),
      state: state({ nodes: ['mod:a/b'] }),
      manifestName: 'repovine-annotation-writer',
    });
    expect(report.valid).toBe(false);
    expect(report.errors.join(' ')).toMatch(/phase="annotate".*filesChanged is non-empty/);
  });

  it('allows a read-only annotation-writer to report annotationsWritten (not filesChanged)', () => {
    const report = checkCompliance({
      result: makeResult({
        filesChanged: [],
        graphNodesTouched: ['mod:a/b'],
        annotationsWritten: ['mod:a/b'],
        compliance: { ...makeResult().compliance, annotationsClean: false },
      }),
      assignment: makeAssignment({ scope: ['packages/a'] }),
      state: state({ nodes: ['mod:a/b'], annotated: ['mod:a/b'] }),
      manifestName: 'repovine-annotation-writer',
    });
    expect(report.errors.join(' ')).not.toMatch(/canEditFiles=false/);
  });

  it('errors when contextSession.sessionId disagrees with result.contextSessionId', () => {
    // Matching runId, no context store → the only error is the sessionId-mismatch gate (:670).
    const report = checkCompliance({
      result: makeResult({ contextSessionId: 'sess-B' }),
      assignment: makeAssignment({ contextSession: { sessionId: 'sess-A' } }),
      state: state(),
    });
    expect(report.valid).toBe(false);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatch(/contextSession\.sessionId mismatch/);
    expect(report.errors[0]).toMatch(/"sess-A" != result "sess-B"/);
  });

  it('warns on a duplicate architectureAudit findingId', () => {
    const finding = {
      findingId: 'boundary:f1',
      status: 'confirmed' as const,
      severity: 'high' as const,
      confidence: 0.9,
      nodes: ['mod:a/b'],
      evidence: ['crosses boundary'],
      recommendedAction: 'split module',
    };
    const report = checkCompliance({
      result: makeResult({
        compliance: { ...makeResult().compliance, architectureChecked: true },
        architectureAudit: {
          auditScope: ['packages/a'],
          categories: ['boundary'],
          findings: [finding, { ...finding }],
        },
      }),
      assignment: makeAssignment({ scope: ['packages/a'] }),
      state: state({ nodes: ['mod:a/b'] }),
    });
    expect(report.warnings.join(' ')).toMatch(/duplicate findingId "boundary:f1"/);
  });

  it('uses manifest required fields to flag missing ones', () => {
    const report = checkCompliance({
      result: makeResult({ summary: '', filesChanged: [], graphNodesTouched: [] }),
      state: state(),
      manifestName: 'project-subagent-sample',
    });
    expect(report.missingFields).toEqual(expect.arrayContaining(['summary', 'filesChanged', 'graphNodesTouched']));
  });

  it('keeps a missing required contextSessionId advisory while the score is unvalidated', () => {
    const report = checkCompliance({
      result: makeResult(),
      // Prior annotated context exists (not written this run) → enforcement applies.
      assignment: makeAssignment({ contextSession: { required: true, mode: 'harness', phase: 'explore' } }),
      state: state({ annotated: ['mod:prior'] }),
    });
    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings.join(' ')).toMatch(/contextSessionId is missing/);
  });

  it('exempts a greenfield first pass (no prior annotated context) from harness context enforcement', () => {
    const report = checkCompliance({
      // Everything annotated this run was written by this run → no prior context.
      result: makeResult({ annotationsWritten: ['mod:fresh'] }),
      assignment: makeAssignment({ contextSession: { required: true, mode: 'harness', phase: 'explore' } }),
      state: state({ annotated: ['mod:fresh'] }),
    });
    expect(report.valid).toBe(true); // downgraded to advisory, not a hard fail
    expect(report.warnings.join(' ')).toMatch(/greenfield first pass/);
  });

  it('greenfieldRun holds the context exemption when a sibling already wrote annotations', () => {
    // The exact multi-sub-agent failure: an earlier sibling wrote mod:prior into the shared
    // store, so from this leaf's view "prior context" exists and its weak first-pass session
    // (0.2, rejected) remains advisory while the score is unvalidated.
    const rejected = qualityReport({
      acceptHandoff: false,
      overall: 0.2,
      rejectReasons: ['QUALITY_BELOW_THRESHOLD', 'UNRESOLVED_SCOPE'],
      policy: { required: true, mode: 'harness', qualityThreshold: 0.55, warningThreshold: 0.7, minAnchors: 1, byteBudget: 80_000, retain: false },
    });
    const args = {
      result: makeResult({ contextSessionId: 'sess-gf', annotationsWritten: ['mod:mine'] }),
      assignment: makeAssignment({ contextSession: { required: true, mode: 'harness' as const } }),
      state: state({ annotated: ['mod:prior', 'mod:mine'], contextQualityReport: rejected }),
    };
    // Both paths are advisory until the score clears the labelled-corpus return bar.
    expect(checkCompliance(args).valid).toBe(true);
    const exempt = checkCompliance({ ...args, greenfieldRun: true });
    expect(exempt.valid).toBe(true);
    expect(exempt.errors.join(' ')).not.toMatch(/Context session quality rejected/);
    expect(exempt.warnings.join(' ')).toMatch(/greenfield run/);
  });

  it('keeps a rejected context report advisory in an established repo', () => {
    const rejected = qualityReport({
      acceptHandoff: false,
      overall: 0.3,
      rejectReasons: ['OR_WITHOUT_RECOVERY'],
      policy: { required: true, mode: 'harness', qualityThreshold: 0.55, warningThreshold: 0.7, minAnchors: 1, byteBudget: 80_000, retain: false },
    });
    const report = checkCompliance({
      result: makeResult({ contextSessionId: 'sess-est' }),
      assignment: makeAssignment({ contextSession: { required: true, mode: 'harness' } }),
      state: state({ annotated: ['mod:prior'], contextQualityReport: rejected }),
    });
    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings.join(' ')).toMatch(/did not accept handoff/);
  });

  it('reports the recomputed context result without gating harness compliance', () => {
    const rejected = qualityReport({
      acceptHandoff: false,
      overall: 0.2,
      rejectReasons: ['OR_WITHOUT_RECOVERY'],
      requiredFollowups: ['Repeat search_context with types:["package","module"].'],
      policy: { required: true, mode: 'harness', qualityThreshold: 0.55, warningThreshold: 0.7, minAnchors: 1, byteBudget: 80_000, retain: false },
    });
    const report = checkCompliance({
      result: makeResult({ contextSessionId: 'sess-1', contextQuality: { overall: 0.9 } }),
      assignment: makeAssignment({ contextSession: { required: true, mode: 'harness', qualityThreshold: 0.55 } }),
      state: state({ annotated: ['mod:prior'], contextQualityReport: rejected }),
    });
    expect(report.valid).toBe(true);
    expect(report.contextQuality?.overall).toBe(0.2);
    expect(report.errors).toEqual([]);
    expect(report.warnings.join(' ')).toMatch(/did not accept handoff/);
    expect(report.warnings.join(' ')).toMatch(/Self-reported contextQuality/);
    expect(report.requiredFollowups).toContain('Repeat search_context with types:["package","module"].');
  });

  it('keeps a rejected advisory context session available for review', () => {
    const consumed: string[] = [];
    const rejected = qualityReport({
      acceptHandoff: false,
      overall: 0.2,
      rejectReasons: ['OR_WITHOUT_RECOVERY'],
      policy: { required: true, mode: 'harness', qualityThreshold: 0.55, warningThreshold: 0.7, minAnchors: 1, byteBudget: 80_000, retain: false },
    });
    const complianceState: ComplianceState = {
      ...state({ annotated: ['mod:prior'], contextQualityReport: rejected }),
      consumeContextQualitySession: id => {
        consumed.push(id);
        return true;
      },
    };
    const input = {
      result: makeResult({ contextSessionId: 'sess-retry' }),
      assignment: makeAssignment({ contextSession: { required: true, mode: 'harness' as const } }),
      state: complianceState,
    };

    expect(checkCompliance(input).valid).toBe(true);
    expect(checkCompliance(input).valid).toBe(true);
    expect(consumed).toEqual([]);
  });

  it('warns instead of failing weak required sessions in client mode', () => {
    const rejected = qualityReport({
      acceptHandoff: false,
      overall: 0.2,
      rejectReasons: ['OR_WITHOUT_RECOVERY'],
      warnings: ['client advisory'],
      policy: { required: true, mode: 'client', qualityThreshold: 0.55, warningThreshold: 0.7, minAnchors: 1, byteBudget: 80_000, retain: false },
    });
    const report = checkCompliance({
      result: makeResult({ contextSessionId: 'sess-1' }),
      assignment: makeAssignment({ contextSession: { required: true, mode: 'client' } }),
      state: state({ contextQualityReport: rejected }),
    });
    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings.join(' ')).toMatch(/did not accept handoff/);
  });

  it('warns on missing contextSessionId in client mode when required', () => {
    const report = checkCompliance({
      result: makeResult(),
      assignment: makeAssignment({ contextSession: { required: true, mode: 'client' } }),
      state: state(),
    });
    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings.join(' ')).toMatch(/contextSessionId is missing/);
  });

  it('adds annotation followups when context is weak and annotations are stale', () => {
    const weak = qualityReport({
      acceptHandoff: true,
      overall: 0.45,
      belowWarningThreshold: true,
      warnings: ['weak context'],
      policy: { required: false, mode: 'client', qualityThreshold: 0.4, warningThreshold: 0.55, minAnchors: 1, byteBudget: 80_000, retain: false },
    });
    const report = checkCompliance({
      result: makeResult({ contextSessionId: 'sess-1', graphNodesTouched: ['mod:a/b'] }),
      state: {
        ...state({
          nodes: ['mod:a/b'],
          annotated: ['mod:a/b'],
          stale: ['mod:a/b'],
          contextQualityReport: weak,
        }),
        contextQualityConfig: {
          enforcement: { mode: 'client' },
        } as ComplianceState['contextQualityConfig'],
      },
    });
    expect(report.requiredFollowups).toEqual(expect.arrayContaining([
      'Annotations in touched scope are stale or missing; run targeted review and write_annotation before relying on handoff context.',
      'Repeat the context funnel: search_context(types:["package","module"]) → map_context → inspect_node / analyze_dependencies.',
    ]));
  });

  it('consumes checked context sessions unless assignment retains them', () => {
    const consumed: Array<{ id: string; retain?: boolean }> = [];
    const baseState = state({ contextQualityReport: qualityReport() });
    const report = checkCompliance({
      result: makeResult({ contextSessionId: 'sess-1' }),
      assignment: makeAssignment({ contextSession: { required: true } }),
      state: {
        ...baseState,
        consumeContextQualitySession: (id, options) => {
          consumed.push({ id, retain: options?.retain });
          return true;
        },
      },
    });
    expect(report.valid).toBe(true);
    expect(consumed).toEqual([{ id: 'sess-1', retain: false }]);

    consumed.length = 0;
    checkCompliance({
      result: makeResult({ contextSessionId: 'sess-1' }),
      assignment: makeAssignment({ contextSession: { required: true, retain: true } }),
      state: {
        ...baseState,
        consumeContextQualitySession: (id, options) => {
          consumed.push({ id, retain: options?.retain });
          return false;
        },
      },
    });
    expect(consumed).toEqual([{ id: 'sess-1', retain: true }]);
  });

  it('skips compliance when the provided assignment is malformed', () => {
    const out = validateAndCheckCompliance({
      result: makeResult(),
      assignment: { protocolVersion: '1', runId: 'r1' },
      state: state(),
    });
    expect(out.schema.valid).toBe(true);
    expect(out.assignmentSchema?.valid).toBe(false);
    expect(out.complianceSkipped).toBe(true);
    expect(out.skipReason).toBe('assignment failed schema validation');
    expect(out.compliance).toBeUndefined();
  });
});

describe('annotation grounding gates (Phase B)', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-grounding-'));
    fs.writeFileSync(path.join(repoRoot, 'repovine.annots.json'), '{"version":1,"annotations":{}}\n');
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  function modFixture(id: string, exportNames: string[], semanticHints?: SemanticHints): ModuleInfo {
    return {
      id,
      packageName: 'p',
      filePath: `/abs/${id.slice(4)}.ts`,
      relativeFilePath: `${id.slice(4)}.ts`,
      contentHash: 'h',
      imports: [],
      exports: exportNames.map(name => ({ name, kind: 'function', lineRange: { start: 1, end: 10 }, isDefault: false })),
      ...(semanticHints ? { semanticHints } : {}),
    } as unknown as ModuleInfo;
  }

  function groundingState(opts: {
    modules: ModuleInfo[];
    annotations: Record<string, AnnotationContent>;
    report?: ContextQualityReport;
  }): ComplianceState {
    const store = {
      get: (id: string) => (opts.annotations[id] ? { nodeId: id, annotation: opts.annotations[id] } : undefined),
      getAll: () => Object.fromEntries(Object.keys(opts.annotations).map(id => [id, { nodeId: id, annotation: opts.annotations[id] }])),
      detectOrphaned: () => ({ total: 0, orphaned: [], byType: {} }),
      scanAnnotationHealth: () => fakeScan([]),
    } as unknown as AnnotationStore;
    return {
      repoRoot,
      graph: fakeGraph(opts.modules.map(m => m.id)),
      snapshot: { modules: opts.modules } as unknown as RepositoryFactsSnapshot,
      annotations: store,
      ...(opts.report ? { getContextQualityReport: () => opts.report } : {}),
    };
  }

  function harnessAnnotate(): AgentAssignment {
    return makeAssignment({ scope: ['.'], contextSession: { required: false, mode: 'harness', phase: 'annotate' } });
  }

  function reportWithAnchors(anchors: string[]): ContextQualityReport {
    return {
      sessionId: 'sess-1',
      phase: 'annotate',
      overall: 0.9,
      noisePenalty: 0,
      structureBonus: 1,
      acceptHandoff: true,
      belowWarningThreshold: false,
      rejectReasons: [],
      warnings: [],
      requiredFollowups: [],
      aggregates: { stableAnchors: anchors },
      policy: { required: false, mode: 'harness', qualityThreshold: 0.55, warningThreshold: 0.7, minAnchors: 0, byteBudget: 80_000, retain: false },
      requestEchoes: [],
    } as unknown as ContextQualityReport;
  }

  const note = (keyExports: Record<string, string>): AnnotationContent => ({
    summary: 'A long-enough summary describing the feature module under test.',
    keyExports,
  });

  // ── Provenance ──

  it('fails the harness gate for an annotation written with no inspect and no edit', () => {
    const report = checkCompliance({
      result: makeResult({ annotationsWritten: ['mod:pkg/feature'] }),
      assignment: harnessAnnotate(),
      state: groundingState({
        modules: [modFixture('mod:pkg/feature', ['doThing'])],
        annotations: { 'mod:pkg/feature': note({ doThing: 'does the thing' }) },
      }),
    });
    expect(report.valid).toBe(false);
    expect(report.errors.join(' ')).toMatch(/Annotation provenance/);
    expect(report.requiredFollowups.join(' ')).toMatch(/inspect_node each annotated node/);
  });

  it('passes the provenance gate when the implementer edited the file (filesChanged grounds the module)', () => {
    const report = checkCompliance({
      result: makeResult({ filesChanged: ['pkg/feature.ts'], annotationsWritten: ['mod:pkg/feature'] }),
      assignment: harnessAnnotate(),
      state: groundingState({
        modules: [modFixture('mod:pkg/feature', ['doThing'])],
        annotations: { 'mod:pkg/feature': note({ doThing: 'does the thing' }) },
      }),
    });
    expect(report.errors.join(' ')).not.toMatch(/provenance/i);
  });

  it('grounds a written module via an export: anchor inspected in the same session', () => {
    const report = checkCompliance({
      result: makeResult({ contextSessionId: 'sess-1', annotationsWritten: ['mod:pkg/feature'] }),
      assignment: harnessAnnotate(),
      state: groundingState({
        modules: [modFixture('mod:pkg/feature', ['doThing'])],
        annotations: { 'mod:pkg/feature': note({ doThing: 'does the thing' }) },
        report: reportWithAnchors(['export:pkg/feature/doThing']),
      }),
    });
    expect(report.errors.join(' ')).not.toMatch(/provenance/i);
  });

  it('does NOT ground via a coarse pkg: anchor (the deliberate exclusion)', () => {
    const report = checkCompliance({
      result: makeResult({ contextSessionId: 'sess-1', annotationsWritten: ['mod:pkg/feature'] }),
      assignment: harnessAnnotate(),
      state: groundingState({
        modules: [modFixture('mod:pkg/feature', ['doThing'])],
        annotations: { 'mod:pkg/feature': note({ doThing: 'does the thing' }) },
        report: reportWithAnchors(['pkg:pkg']),
      }),
    });
    expect(report.errors.join(' ')).toMatch(/Annotation provenance/);
  });

  it('emits a warning (not an error) for an ungrounded annotation in client mode', () => {
    const report = checkCompliance({
      result: makeResult({ annotationsWritten: ['mod:pkg/feature'] }),
      assignment: makeAssignment({ scope: ['.'], requestedChecks: ['annotations'] }),
      state: groundingState({
        modules: [modFixture('mod:pkg/feature', ['doThing'])],
        annotations: { 'mod:pkg/feature': note({ doThing: 'does the thing' }) },
      }),
    });
    expect(report.warnings.join(' ')).toMatch(/Annotation provenance/);
    expect(report.errors.join(' ')).not.toMatch(/Annotation provenance/);
  });

  it('judges only the run\'s new writes — pre-existing annotations are never failed (no retroactive harness failure)', () => {
    const report = checkCompliance({
      result: makeResult({ filesChanged: ['pkg/fresh.ts'], annotationsWritten: ['mod:pkg/fresh'] }),
      assignment: harnessAnnotate(),
      state: groundingState({
        modules: [modFixture('mod:pkg/fresh', ['doThing']), modFixture('mod:pkg/legacy', ['old'])],
        annotations: {
          'mod:pkg/fresh': note({ doThing: 'does the thing' }), // grounded via filesChanged, in annotationsWritten
          'mod:pkg/legacy': note({ old: 'pre-existing, ungrounded, NOT written this run' }),
        },
      }),
    });
    // the pre-existing, ungrounded note is not in annotationsWritten → never provenance-judged
    expect(report.errors.join(' ')).not.toMatch(/provenance/i);
    expect(report.errors.join(' ')).not.toMatch(/mod:pkg\/legacy/);
  });

  // ── Structured grounding facts in the report (mode-independent; consumer applies policy) ──

  it('surfaces ungrounded writes structurally (report.ungroundedAnnotations) even in client mode', () => {
    const report = checkCompliance({
      result: makeResult({ annotationsWritten: ['mod:pkg/feature'] }),
      assignment: makeAssignment({ scope: ['.'] }), // client → warning, but the FACT is still surfaced
      state: groundingState({
        modules: [modFixture('mod:pkg/feature', ['doThing'])],
        annotations: { 'mod:pkg/feature': note({ doThing: 'does the thing' }) },
      }),
    });
    expect(report.ungroundedAnnotations).toContain('mod:pkg/feature');
    expect(report.errors.join(' ')).not.toMatch(/provenance/i); // client severity stays a warning
  });

  it('surfaces hard inconsistencies structurally and EXCLUDES advisory env', () => {
    const report = checkCompliance({
      result: makeResult({ graphNodesTouched: ['mod:pkg/cfg'] }),
      assignment: makeAssignment({ scope: ['.'] }),
      state: groundingState({
        modules: [modFixture('mod:pkg/cfg', ['realFn'], { envVars: ['DETECTED'] })],
        annotations: {
          'mod:pkg/cfg': { summary: 'Config note with a keyExports drift and an env drift.', keyExports: { ghostFn: 'x' }, envDependencies: { DETECTED: 'ok', UNDETECTED: 'missed' } },
        },
      }),
    });
    expect(report.inconsistentAnnotations).toHaveLength(1);
    expect(report.inconsistentAnnotations[0]).toEqual({ nodeId: 'mod:pkg/cfg', issues: ['keyExports:ghostFn'] });
    // env mismatch is advisory → never in the structured fact, only a warning
    expect(report.inconsistentAnnotations[0].issues.join(' ')).not.toMatch(/UNDETECTED|envDependencies/);
    expect(report.warnings.join(' ')).toMatch(/UNDETECTED/);
  });

  // ── Consistency (keyExports drift / declared-pure) as a gate reason ──

  it('surfaces keyExports drift as a harness gate error', () => {
    const report = checkCompliance({
      result: makeResult({ filesChanged: ['pkg/feature.ts'], graphNodesTouched: ['mod:pkg/feature'], annotationsWritten: ['mod:pkg/feature'] }),
      assignment: harnessAnnotate(),
      state: groundingState({
        modules: [modFixture('mod:pkg/feature', ['realFn'])],
        annotations: { 'mod:pkg/feature': note({ ghostFn: 'not a real export' }) },
      }),
    });
    expect(report.valid).toBe(false);
    expect(report.errors.join(' ')).toMatch(/contradicts graph facts/);
    expect(report.errors.join(' ')).toMatch(/keyExports:ghostFn/);
  });

  it('surfaces keyExports drift as a warning (not an error) in client mode', () => {
    const report = checkCompliance({
      result: makeResult({ graphNodesTouched: ['mod:pkg/feature'] }),
      assignment: makeAssignment({ scope: ['.'] }),
      state: groundingState({
        modules: [modFixture('mod:pkg/feature', ['realFn'])],
        annotations: { 'mod:pkg/feature': note({ ghostFn: 'not a real export' }) },
      }),
    });
    expect(report.warnings.join(' ')).toMatch(/contradicts graph facts/);
    expect(report.errors.join(' ')).not.toMatch(/contradicts graph facts/);
  });

  it('flags a touched module that declares pure while the graph detects effects', () => {
    const report = checkCompliance({
      result: makeResult({ graphNodesTouched: ['mod:pkg/sender'] }),
      assignment: makeAssignment({ scope: ['.'] }),
      state: groundingState({
        modules: [modFixture('mod:pkg/sender', ['send'], { runtimeActions: [{ action: 'sqs.sendMessage' }] })],
        annotations: {
          'mod:pkg/sender': { summary: 'Publishes messages to a queue at runtime.', sideEffects: [{ kind: 'pure' }] },
        },
      }),
    });
    expect(report.warnings.join(' ')).toMatch(/contradicts graph facts/);
    expect(report.warnings.join(' ')).toMatch(/sideEffects:declared pure/);
  });

  it('treats env-dependency drift as advisory (warning, never a hard error) even under harness annotate', () => {
    const report = checkCompliance({
      result: makeResult({ filesChanged: ['pkg/cfg.ts'], graphNodesTouched: ['mod:pkg/cfg'], annotationsWritten: ['mod:pkg/cfg'] }),
      assignment: harnessAnnotate(),
      state: groundingState({
        modules: [modFixture('mod:pkg/cfg', ['cfg'], { envVars: ['DETECTED_VAR'] })],
        annotations: {
          'mod:pkg/cfg': {
            summary: 'Config module that reads env vars at init time.',
            keyExports: { cfg: 'the config object' },
            envDependencies: { DETECTED_VAR: 'used', UNDETECTED_VAR: 'real but the detector missed it' },
          },
        },
      }),
    });
    // env mismatch is advisory: warned, with the var named, but never a hard "contradicts graph facts" error
    expect(report.warnings.join(' ')).toMatch(/env dependencies not detected/i);
    expect(report.warnings.join(' ')).toMatch(/UNDETECTED_VAR/);
    expect(report.errors.join(' ')).not.toMatch(/UNDETECTED_VAR/);
    expect(report.errors.join(' ')).not.toMatch(/contradicts graph facts/);
  });

  // ── Thin-annotation gate: keyed on missingFields, not the absolute tier score ──

  it('flags missing recommended fields as a harness annotate gate error', () => {
    const report = checkCompliance({
      result: makeResult({ filesChanged: ['pkg/feature.ts'], graphNodesTouched: ['mod:pkg/feature'], annotationsWritten: ['mod:pkg/feature'] }),
      assignment: harnessAnnotate(),
      state: groundingState({
        modules: [modFixture('mod:pkg/feature', ['realFn'])],
        annotations: {
          // exports exist but keyExports is absent → keyExports lands in missingFields
          'mod:pkg/feature': { summary: 'Feature module with real exports left undocumented here.' },
        },
      }),
    });
    expect(report.valid).toBe(false);
    expect(report.errors.join(' ')).toMatch(/missing recommended fields/);
    expect(report.errors.join(' ')).toMatch(/keyExports/);
  });

  it('accepts a small module whose recommended fields are all filled even below the detailed tier', () => {
    const report = checkCompliance({
      result: makeResult({ filesChanged: ['pkg/entry.ts'], graphNodesTouched: ['mod:pkg/entry'], annotationsWritten: ['mod:pkg/entry'] }),
      assignment: harnessAnnotate(),
      state: groundingState({
        // zero exports → keyExports is never recommendable; honest max score stays below `detailed`
        modules: [modFixture('mod:pkg/entry', [])],
        annotations: {
          'mod:pkg/entry': {
            summary: 'Entry point that mounts the application and exports nothing.',
            assumptions: ['index.html always contains the #root element.'],
            sideEffects: [{ kind: 'state-global', description: 'Mounts the React tree into #root.' }],
          },
        },
      }),
    });
    expect(report.errors.join(' ')).not.toMatch(/missing recommended fields/);
    expect(report.errors.join(' ')).not.toMatch(/detailed/);
  });
});
