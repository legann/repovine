/**
 * Three categories fired on clean-code counterexamples during the silence-oracle
 * audit: `duplicate-like`, `god-module` and `authorization-policy-drift`. A
 * counterexample refutes the universal claim "a finding is led by evidence", so
 * these run only when a caller names them.
 *
 * This pins the decision behaviourally, not as a constant: the same fixture must
 * stay silent by default and still report when the category is requested. Without
 * it the default set is an unnamed literal that a later edit can widen unnoticed.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  runRefactoringReport,
  REFACTORING_CATEGORIES,
} from '../../../../src/analysis/architecture/index.js';
import { CLEAN_ORACLE_FAILING_CATEGORIES } from '../../../../src/analysis/architecture/types.js';
import { AnnotationStore } from '../../../../src/annotations/store.js';
import { addEdge, addNode, createEmptyGraph } from '../../../../src/graph/index.js';
import {
  CURRENT_ANNOTATION_SCHEMA_VERSION,
  type ModuleInfo,
  type RepositoryGraph,
  type StoredAnnotation,
} from '../../../../src/types.js';

function makeStore(annotations: StoredAnnotation[]): AnnotationStore {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'default-categories-'));
  const store = AnnotationStore.createSync(tmpDir);
  for (const ann of annotations) store.set(ann.nodeId, ann);
  return store;
}

function makeAnn(nodeId: string, semantic: StoredAnnotation['annotation']): StoredAnnotation {
  return {
    nodeId,
    nodeType: 'module',
    contentHash: 'h1',
    pass: 1,
    updatedAt: new Date().toISOString(),
    annotation: semantic,
    schemaVersion: CURRENT_ANNOTATION_SCHEMA_VERSION,
  };
}

function makeMod(
  id: string,
  packageName: string,
  relativeFilePath: string,
  exports: ModuleInfo['exports'] = [],
): ModuleInfo {
  return {
    id,
    packageName,
    filePath: `/repo/packages/${packageName}/${relativeFilePath}`,
    relativeFilePath,
    contentHash: 'h1',
    imports: [],
    exports,
  };
}

function addModule(graph: RepositoryGraph, mod: ModuleInfo): void {
  addNode(graph, {
    id: mod.id,
    type: 'module',
    label: mod.relativeFilePath,
    description: '',
    data: { filePath: mod.filePath, relativeFilePath: mod.relativeFilePath },
  });
  addEdge(graph, `pkg:${mod.packageName}`, mod.id, 'contains');
}

/** Two policy modules sharing vocabulary — the authorization-policy-drift trigger. */
function buildPolicyDriftFixture(): {
  graph: RepositoryGraph;
  modulesById: Map<string, ModuleInfo>;
  annotations: AnnotationStore;
} {
  const graph = createEmptyGraph();
  const policyA = makeMod('mod:app/src/policies/submit-policy', 'app', 'src/policies/submit-policy.ts');
  const policyB = makeMod('mod:shared/src/policies/submit-policy', 'shared', 'src/policies/submit-policy.ts');
  const modules = [policyA, policyB];
  for (const mod of modules) addModule(graph, mod);

  const annotations = makeStore([
    makeAnn(policyA.id, {
      summary: 'Checks whether a user can submit an order.',
      invariants: ['Only owners or tenant admins can submit orders'],
    }),
    makeAnn(policyB.id, {
      summary: 'Checks whether a user can submit an order.',
      invariants: ['Only owners or tenant admins can submit orders'],
    }),
  ]);

  return { graph, modulesById: new Map(modules.map(m => [m.id, m])), annotations };
}

/**
 * One module with a wide export surface — the god-module trigger. The score is
 * `exports * 1.5 + fanIn + fanOut + envVars * 2 + floor(lines / 100)`, so twelve exports clear the
 * `normal` bar of 13 on export count alone, with no edges or env vars to maintain.
 */
function buildGodModuleFixture(): {
  graph: RepositoryGraph;
  modulesById: Map<string, ModuleInfo>;
  annotations: AnnotationStore;
} {
  const graph = createEmptyGraph();
  const wide = makeMod(
    'mod:app/src/core/registry',
    'app',
    'src/core/registry.ts',
    Array.from({ length: 12 }, (_, i) => ({
      name: `member${i}`,
      kind: 'function' as const,
      lineRange: { start: i * 3 + 1, end: i * 3 + 2 },
      isDefault: false,
    })),
  );
  addModule(graph, wide);
  return {
    graph,
    modulesById: new Map([[wide.id, wide]]),
    annotations: makeStore([]),
  };
}

function categoriesOf(report: Record<string, unknown>): string[] {
  const findings = (report.findings ?? []) as Array<{ category: string }>;
  return findings.map(f => f.category);
}

describe('architecture analysis: default category set', () => {
  // Asserting `DEFAULT == ALL \ CLEAN_ORACLE_FAILING` would restate the definition: both sides
  // recompute from the same list, so widening the default set moves them together. Only the
  // membership half is checkable — every excluded category must still be a real category.
  it('excludes only categories that exist', () => {
    for (const category of CLEAN_ORACLE_FAILING_CATEGORIES) {
      expect(REFACTORING_CATEGORIES).toContain(category);
    }
  });

  // The behavioural pairs below are the actual guard: each fixture triggers its category, so a
  // category returning to the default set turns the "silent" case red.
  const CASES = [
    { category: 'authorization-policy-drift' as const, fixture: buildPolicyDriftFixture },
    { category: 'duplicate-like' as const, fixture: buildPolicyDriftFixture },
    { category: 'god-module' as const, fixture: buildGodModuleFixture },
  ];

  it.each(CASES)('$category is reported when requested explicitly', ({ category, fixture }) => {
    const { graph, modulesById, annotations } = fixture();
    const report = runRefactoringReport(
      { graph, modulesById, annotations, domainsConfig: null },
      { scope: 'all', categories: [category], minConfidence: 0, limit: 30 },
    );
    expect(categoriesOf(report)).toContain(category);
  });

  it.each(CASES)('$category stays silent on that same fixture by default', ({ category, fixture }) => {
    const { graph, modulesById, annotations } = fixture();
    const report = runRefactoringReport(
      { graph, modulesById, annotations, domainsConfig: null },
      { scope: 'all', minConfidence: 0, limit: 30 },
    );
    expect(categoriesOf(report)).not.toContain(category);
  });
});
