import { asHostPath, asPkgRelPath } from '@repovine/plugin-sdk';
import { describe, expect, it } from '@jest/globals';
import { computeRiskScopeCandidates } from '../../../src/annotations/risk-scope-candidates.js';
import { addNode, createEmptyGraph } from '../../../src/graph/index.js';
import type { ModuleInfo, RepositoryFactsSnapshot, RepositoryGraph, RiskEntry, StoredAnnotation } from '../../../src/types.js';

function makeMod(id: string, relativeFilePath?: string): ModuleInfo {
  const rel = relativeFilePath ?? `${id.replace(/^mod:/, '')}.ts`;
  return {
    id,
    packageName: 'test',
    absPath: asHostPath(`/repo/${rel}`),
    pkgRelPath: asPkgRelPath(rel),
    contentHash: `${id}:hash`,
    imports: [],
    exports: [],
  };
}

function addModule(graph: RepositoryGraph, id: string, relativeFilePath?: string): void {
  const rel = relativeFilePath ?? `${id.replace(/^mod:/, '')}.ts`;
  addNode(graph, {
    id,
    type: 'module',
    label: rel,
    description: '',
    data: { absPath: asHostPath(`/repo/${rel}`), pkgRelPath: asPkgRelPath(rel) },
  });
}

function annotation(
  nodeId: string,
  risks: RiskEntry[],
  extra: Partial<StoredAnnotation> = {},
): StoredAnnotation {
  return {
    nodeId,
    nodeType: 'module',
    contentHash: `${nodeId}:hash`,
    pass: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    annotation: { summary: 'Annotation summary for candidate tests', risks },
    schemaVersion: 1,
    ...extra,
  };
}

function run(
  annotations: Record<string, StoredAnnotation>,
  options: { paths?: Record<string, string>; scopeHints?: string[]; limit?: number; offset?: number } = {},
) {
  const graph = createEmptyGraph();
  const modules: ModuleInfo[] = [];
  for (const nodeId of Object.keys(annotations)) {
    const rel = options.paths?.[nodeId];
    addModule(graph, nodeId, rel);
    modules.push(makeMod(nodeId, rel));
  }
  const snapshot: RepositoryFactsSnapshot = {
    repoRoot: '/repo',
    timestamp: '2026-01-01T00:00:00.000Z',
    packages: [],
    modules,
  };
  return computeRiskScopeCandidates({
    graph,
    snapshot,
    annotations,
    sampleLimit: 20,
    ...(options.scopeHints ? { scopeHints: options.scopeHints } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.offset !== undefined ? { offset: options.offset } : {}),
  });
}

describe('computeRiskScopeCandidates', () => {
  it('suggests consumer scope only when role and obligation cues both appear', () => {
    const report = run({
      'mod:alpha/a': annotation('mod:alpha/a', [
        'Importers must verify this gate locally before changing caller behavior.',
      ]),
    });

    expect(report.consumer).toBe(1);
    expect(report.boundary).toBe(0);
    expect(report.sample[0]).toMatchObject({
      nodeId: 'mod:alpha/a',
      nodeType: 'module',
      riskIndex: 0,
      suggestedScope: 'consumer',
      reasons: ['consumer-role-cue', 'consumer-obligation-cue'],
    });
  });

  it('does not suggest consumer scope for role-only or obligation-only prose', () => {
    const report = run({
      'mod:alpha/a': annotation('mod:alpha/a', [
        'Client requests can fail when the service is unavailable.',
        'Must verify the gate before changing behavior.',
      ]),
    });

    expect(report.total).toBe(0);
    expect(report.sample).toEqual([]);
  });

  it('suggests boundary scope for explicit published or off-limits contract cues', () => {
    const report = run({
      'mod:alpha/a': annotation('mod:alpha/a', [
        'Published contract for external clients is frozen; callers must not edit it in place.',
      ]),
    }, {
      paths: { 'mod:alpha/a': 'src/public-api/schema.ts' },
    });

    expect(report.boundary).toBe(1);
    expect(report.sample[0]).toMatchObject({
      suggestedScope: 'boundary',
      reasons: expect.arrayContaining([
        'boundary-explicit-cue',
        'published-contract-cue',
        'compatibility-surface-cue',
        'path-supporting-cue',
      ]),
    });
  });

  it('does not suggest boundary scope for schema words without a public compatibility cue', () => {
    const report = run({
      'mod:alpha/a': annotation('mod:alpha/a', [
        'Schema drift may make local validation noisy.',
      ]),
    }, {
      paths: { 'mod:alpha/a': 'src/schema/local-validator.ts' },
    });

    expect(report.total).toBe(0);
  });

  it('suggests boundary scope for schema drift paired with public compatibility cues', () => {
    const report = run({
      'mod:alpha/a': annotation('mod:alpha/a', [
        'Schema drift in the public API breaks older clients.',
      ]),
    });

    expect(report.boundary).toBe(1);
    expect(report.sample[0].reasons).toEqual(expect.arrayContaining([
      'compatibility-surface-cue',
      'published-contract-cue',
    ]));
  });

  it('suggests boundary scope for schema drift with a bare qualifier and no compatibility-surface phrase', () => {
    // Isolates DRIFT_WITH_QUALIFIER_CUE: 'external' is a bare drift qualifier but is NOT
    // 'external clients', so COMPATIBILITY_SURFACE_CUE does not match on its own here.
    const report = run({
      'mod:alpha/a': annotation('mod:alpha/a', [
        'Schema drift in the external service surfaces here.',
      ]),
    });

    expect(report.total).toBe(1);
    expect(report.boundary).toBe(1);
    expect(report.sample[0].suggestedScope).toBe('boundary');
    expect(report.sample[0].reasons).toEqual(['compatibility-surface-cue']);
  });

  it('drops an annotation whose nodeId is absent from the graph', () => {
    const graph = createEmptyGraph();
    addModule(graph, 'mod:alpha/a');
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: '/repo',
      timestamp: '2026-01-01T00:00:00.000Z',
      packages: [],
      modules: [makeMod('mod:alpha/a')],
    };
    const boundaryRisk = 'Published contract is frozen; callers must not edit it in place.';
    const report = computeRiskScopeCandidates({
      graph,
      snapshot,
      annotations: {
        'mod:alpha/a': annotation('mod:alpha/a', [boundaryRisk]),
        'mod:ghost/x': annotation('mod:ghost/x', [boundaryRisk]),
      },
      sampleLimit: 20,
    });

    expect(report.total).toBe(1);
    expect(report.sample.map((item) => item.nodeId)).toEqual(['mod:alpha/a']);
  });

  it('skips risks already marked consumer or boundary but still reviews explicit local risks', () => {
    const report = run({
      'mod:alpha/a': annotation('mod:alpha/a', [
        { text: 'Importers must verify this gate locally.', scope: 'consumer' },
        { text: 'Published contract is frozen.', scope: 'boundary' },
        { text: 'Callers must preserve this locally before changing behavior.', scope: 'local' },
      ]),
    });

    expect(report.consumer).toBe(1);
    expect(report.boundary).toBe(0);
    expect(report.sample[0].riskIndex).toBe(2);
  });

  it('emits one overlap candidate with boundary precedence and all reason codes', () => {
    const report = run({
      'mod:alpha/a': annotation('mod:alpha/a', [
        'Callers must verify the public API wire contract before changing behavior.',
      ]),
    });

    expect(report.total).toBe(1);
    expect(report.consumer + report.boundary).toBe(report.total);
    expect(report.sample[0]).toMatchObject({
      suggestedScope: 'boundary',
      reasons: expect.arrayContaining([
        'consumer-role-cue',
        'consumer-obligation-cue',
        'published-contract-cue',
        'stored-or-wire-identity-cue',
      ]),
    });
  });

  it('sorts boundary candidates before consumer candidates with stable node order', () => {
    const report = run({
      'mod:beta/b': annotation('mod:beta/b', [
        'Importers must verify this gate locally before changing behavior.',
      ]),
      'mod:alpha/a': annotation('mod:alpha/a', [
        'External clients rely on this wire contract.',
      ]),
      'mod:alpha/c': annotation('mod:alpha/c', [
        'Published contract is frozen for older clients.',
      ]),
    });

    expect(report.sample.map((item) => [item.nodeId, item.suggestedScope])).toEqual([
      ['mod:alpha/c', 'boundary'],
      ['mod:alpha/a', 'boundary'],
      ['mod:beta/b', 'consumer'],
    ]);
    expect(report.byReason['compatibility-surface-cue']).toBe(2);
  });

  it('applies scope filtering to counts, samples, and paged items', () => {
    const report = run({
      'mod:alpha/a': annotation('mod:alpha/a', [
        'Importers must verify this gate locally before changing behavior.',
      ]),
      'mod:beta/b': annotation('mod:beta/b', [
        'Importers must verify this gate locally before changing behavior.',
      ]),
    }, {
      scopeHints: ['alpha'],
      limit: 1,
      offset: 0,
    });

    expect(report.total).toBe(1);
    expect(report.sample.map((item) => item.nodeId)).toEqual(['mod:alpha/a']);
    expect(report.items?.map((item) => item.nodeId)).toEqual(['mod:alpha/a']);
    expect(report.totalItems).toBe(1);
    expect(report.nextOffset).toBeUndefined();
  });
});
