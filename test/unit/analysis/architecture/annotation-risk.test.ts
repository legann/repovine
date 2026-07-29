import { asHostPath, asPkgRelPath } from '@repovine/plugin-sdk';
/**
 * Tests for detectAnnotationRisk — kind-aware quality bar and derived-stale
 * propagation (the refactoring-side counterparts to the staleness changes).
 */
import { detectAnnotationRisk } from '../../../../src/analysis/architecture/detectors.js';
import { DEFAULT_THRESHOLDS } from '../../../../src/analysis/architecture/config.js';
import { AnnotationStore } from '../../../../src/annotations/store.js';
import type { RefactoringScope } from '../../../../src/analysis/architecture/types.js';
import type {
  RepositoryGraph, GraphNode, GraphEdge, ModuleInfo, StoredAnnotation,
} from '../../../../src/types.js';
import { CURRENT_ANNOTATION_SCHEMA_VERSION } from '../../../../src/types.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function makeGraph(nodes: GraphNode[], edges: GraphEdge[]): RepositoryGraph {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of nodes) nodeMap.set(n.id, n);
  const outEdges = new Map<string, GraphEdge[]>();
  const inEdges = new Map<string, GraphEdge[]>();
  const byType = new Map<GraphNode['type'], Set<string>>();
  for (const e of edges) {
    if (!outEdges.has(e.from)) outEdges.set(e.from, []);
    outEdges.get(e.from)!.push(e);
    if (!inEdges.has(e.to)) inEdges.set(e.to, []);
    inEdges.get(e.to)!.push(e);
  }
  for (const n of nodes) {
    if (!byType.has(n.type)) byType.set(n.type, new Set());
    byType.get(n.type)!.add(n.id);
  }
  return { nodes: nodeMap, edges, outEdges, inEdges, byType };
}

function makeMod(id: string, relPath: string, exports: ModuleInfo['exports'], hash = 'h1'): ModuleInfo {
  return {
    id,
    packageName: 'test',
    absPath: asHostPath(`/abs/${relPath}`),
    pkgRelPath: asPkgRelPath(relPath),
    contentHash: hash,
    imports: [],
    exports,
    semanticHints: {},
  };
}

function makeAnn(nodeId: string, contentHash: string, semantic: StoredAnnotation['annotation']): StoredAnnotation {
  return {
    nodeId,
    nodeType: 'module',
    contentHash,
    pass: 1,
    updatedAt: new Date().toISOString(),
    annotation: semantic,
    schemaVersion: CURRENT_ANNOTATION_SCHEMA_VERSION,
  };
}

function makeStore(annotations: StoredAnnotation[]): AnnotationStore {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-risk-test-'));
  const store = AnnotationStore.createSync(tmpDir);
  for (const a of annotations) store.set(a.nodeId, a);
  return store;
}

function makeScope(moduleIds: string[]): RefactoringScope {
  return {
    kind: 'all',
    scope: 'all',
    moduleIds: new Set(moduleIds),
    serviceIds: new Set(),
    domainIds: new Set(),
  };
}

const fanInImports = (count: number, targetId: string): GraphEdge[] =>
  Array.from({ length: count }, (_, i) => ({
    from: `mod:importer-${i}`,
    to: targetId,
    kind: 'imports' as const,
  }));

describe('detectAnnotationRisk — per-kind quality bar', () => {
  it('types-only module with summary+keyExports is NOT flagged (low bar for kind)', () => {
    const modId = 'mod:test/types';
    const mod = makeMod(modId, 'src/types.ts', [
      { name: 'User', kind: 'type', lineRange: { start: 1, end: 3 }, isDefault: false },
      { name: 'Order', kind: 'interface', lineRange: { start: 5, end: 8 }, isDefault: false },
    ]);
    const ann = makeAnn(modId, 'h1', {
      summary: 'Domain entity types used across services.',
      keyExports: { User: 'User shape', Order: 'Order shape' },
    });
    // Importance = fanIn(10) + fanOut(0) + exports(2) = 12, above minImportance(8)
    const graph = makeGraph(
      [{ id: modId, type: 'module', label: 'types', description: '' }],
      fanInImports(10, modId),
    );
    const store = makeStore([ann]);

    const findings = detectAnnotationRisk(
      graph,
      new Map([[modId, mod]]),
      store,
      makeScope([modId]),
    );
    expect(findings).toHaveLength(0);
  });

  it('api-handler with only summary+keyExports IS flagged (high bar for kind)', () => {
    const modId = 'mod:service/handlers/createOrder';
    const mod = makeMod(modId, 'src/handlers/createOrder.ts', [
      { name: 'handler', kind: 'function', lineRange: { start: 1, end: 80 }, isDefault: false },
    ]);
    const ann = makeAnn(modId, 'h1', {
      summary: 'POST /orders handler that creates an order.',
      keyExports: { handler: 'AWS Lambda entrypoint' },
    });
    const graph = makeGraph(
      [{ id: modId, type: 'module', label: 'createOrder', description: '' }],
      fanInImports(8, modId),
    );
    const store = makeStore([ann]);

    const findings = detectAnnotationRisk(
      graph,
      new Map([[modId, mod]]),
      store,
      makeScope([modId]),
    );
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.title).toMatch(/weak annotation|no semantic/i);
    // Evidence mentions the kind and the bar used
    expect(finding.evidence.some(e => /kind: api-handler/.test(e))).toBe(true);
    expect(finding.evidence.some(e => /Missing fields/.test(e))).toBe(true);
  });

  it('falls back to minQualityScore when per-kind bar is not specified', () => {
    const modId = 'mod:lib/utils';
    const mod = makeMod(modId, 'src/lib/helpers.ts', [
      { name: 'helper', kind: 'function', lineRange: { start: 1, end: 5 }, isDefault: false },
    ]);
    const ann = makeAnn(modId, 'h1', { summary: 'Generic helper.' });
    const graph = makeGraph(
      [{ id: modId, type: 'module', label: 'helpers', description: '' }],
      fanInImports(8, modId),
    );
    const store = makeStore([ann]);

    // Custom thresholds with NO per-kind bar — should use minQualityScore (3)
    const findings = detectAnnotationRisk(
      graph,
      new Map([[modId, mod]]),
      store,
      makeScope([modId]),
      {
        thresholds: {
          minImportance: 8,
          minQualityScore: 3,
          derivedStalePenalty: 2,
          derivedStaleHopLimit: 2,
        },
      },
    );
    // Score < 3 → flagged
    expect(findings).toHaveLength(1);
  });
});

describe('detectAnnotationRisk — derived-stale handling', () => {
  function setup() {
    // a is well-annotated and contentFresh, but imports b which is contentStale.
    const a = makeMod('mod:a', 'src/a.ts', [
      { name: 'doA', kind: 'function', lineRange: { start: 1, end: 50 }, isDefault: false },
    ]);
    const b = makeMod('mod:b', 'src/b.ts', [
      { name: 'doB', kind: 'function', lineRange: { start: 1, end: 30 }, isDefault: false },
    ]);
    const graph = makeGraph(
      [
        { id: 'mod:a', type: 'module', label: 'a', description: '' },
        { id: 'mod:b', type: 'module', label: 'b', description: '' },
        ...fanInImports(8, 'mod:a').map(e => e), // boost importance of a
      ].filter((x): x is GraphNode => 'type' in x),
      [
        ...fanInImports(8, 'mod:a'),
        { from: 'mod:a', to: 'mod:b', kind: 'imports' },
      ],
    );
    // a's annotation is very-high-quality (score >= baseBar + derivedStalePenalty)
    // so that derived-stale is the ONLY reason it could surface in the report.
    // generic baseBar(4) + derivedStalePenalty(2) = effective 6. Score below
    // adds up to: summary(1) + keyExports(1.5) + assumptions(0.5) + sideEffects(1)
    // + risks(1) + patterns(1) = 6 → qualityOk under the penalty.
    const annA = makeAnn('mod:a', 'h1', {
      summary: 'Module A that orchestrates B for the auth flow.',
      keyExports: { doA: 'orchestrator' },
      assumptions: ['B returns a typed result'],
      sideEffects: [{ kind: 'io-read', description: 'calls b.doB' }],
      risks: ['if B fails the orchestration aborts'],
      patterns: ['orchestrator pattern'],
    });
    const store = makeStore([annA]);
    return { graph, modulesById: new Map([['mod:a', a], ['mod:b', b]]), store };
  }

  it('flags fresh+well-annotated module as risk when an upstream import is in derived-stale set', () => {
    const { graph, modulesById, store } = setup();
    const findings = detectAnnotationRisk(
      graph,
      modulesById,
      store,
      makeScope(['mod:a']),
      {
        derivedStaleSet: new Set(['mod:a']),
      },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toMatch(/upstream/i);
    expect(findings[0]!.evidence.some(e => /Upstream import changed/.test(e))).toBe(true);
    expect(findings[0]!.confidence).toBeLessThan(0.72); // derived-stale-only gets lower confidence
  });

  it('does NOT flag when module is not in derived-stale set and quality is acceptable', () => {
    const { graph, modulesById, store } = setup();
    const findings = detectAnnotationRisk(
      graph,
      modulesById,
      store,
      makeScope(['mod:a']),
      {
        derivedStaleSet: new Set(),
      },
    );
    expect(findings).toHaveLength(0);
  });

  it('content-stale beats derived-stale in title/evidence even when both true', () => {
    const { graph, modulesById, store } = setup();
    // Mutate a's contentHash so its annotation goes contentStale
    modulesById.get('mod:a')!.contentHash = 'h2_different';
    const findings = detectAnnotationRisk(
      graph,
      modulesById,
      store,
      makeScope(['mod:a']),
      { derivedStaleSet: new Set(['mod:a']) },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toMatch(/own content changed|stale annotation/i);
  });
});

describe('detectAnnotationRisk — default thresholds calibration', () => {
  it('normal profile has per-kind bars for all common kinds', () => {
    const t = DEFAULT_THRESHOLDS.annotationRisk;
    expect(t.minQualityScoreByKind).toEqual({
      types: 2,
      ui: 4,
      'api-handler': 5,
      'service-mgr': 5,
      adapter: 5,
      generic: 4,
    });
  });

  it('derivedStalePenalty and derivedStaleHopLimit are set', () => {
    const t = DEFAULT_THRESHOLDS.annotationRisk;
    expect(t.derivedStalePenalty).toBe(2);
    expect(t.derivedStaleHopLimit).toBe(2);
  });
});
