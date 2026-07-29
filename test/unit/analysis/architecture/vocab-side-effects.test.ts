import { asHostPath, asPkgRelPath } from '@repovine/plugin-sdk';
import { runRefactoringReport } from '../../../../src/analysis/architecture/index.js';
import { AnnotationStore } from '../../../../src/annotations/store.js';
import { addEdge, addNode, createEmptyGraph } from '../../../../src/graph/index.js';
import { CURRENT_ANNOTATION_SCHEMA_VERSION, type ModuleInfo, type RepositoryGraph, type StoredAnnotation } from '../../../../src/types.js';
import type { SideEffect } from '../../../../src/annotations/side-effect-vocab.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function makeStore(annotations: StoredAnnotation[] = []): AnnotationStore {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-side-effects-'));
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
  options: Partial<ModuleInfo> = {},
): ModuleInfo {
  return {
    id,
    packageName,
    absPath: asHostPath(`/repo/packages/${packageName}/${relativeFilePath}`),
    pkgRelPath: asPkgRelPath(relativeFilePath),
    contentHash: 'h1',
    imports: [],
    exports: [],
    ...options,
  };
}

function buildGraph(modules: ModuleInfo[]): { graph: RepositoryGraph; modulesById: Map<string, ModuleInfo> } {
  const graph = createEmptyGraph();
  addNode(graph, { id: 'root', type: 'root', label: 'root', description: '' });
  const packages = new Set(modules.map(m => m.packageName));
  for (const pkg of packages) {
    addNode(graph, { id: `pkg:${pkg}`, type: 'package', label: pkg, description: '' });
    addEdge(graph, 'root', `pkg:${pkg}`, 'contains');
  }
  for (const mod of modules) {
    addNode(graph, {
      id: mod.id,
      type: 'module',
      label: mod.pkgRelPath,
      description: '',
      data: { absPath: asHostPath(mod.absPath), pkgRelPath: asPkgRelPath(mod.pkgRelPath), ssr: mod.semanticHints?.ssr },
    });
    addEdge(graph, `pkg:${mod.packageName}`, mod.id, 'contains');
  }
  return { graph, modulesById: new Map(modules.map(m => [m.id, m])) };
}

function businessExports(): ModuleInfo['exports'] {
  return ['computeTotal', 'applyDiscount', 'validateCart', 'mapLineItems', 'resolveTax', 'buildSummary'].map((name, i) => ({
    name,
    kind: 'function' as const,
    lineRange: { start: i * 5 + 1, end: i * 5 + 5 },
    isDefault: false,
  }));
}

function report(graph: RepositoryGraph, modulesById: Map<string, ModuleInfo>, category: string, annotations: AnnotationStore) {
  const res = runRefactoringReport(
    { graph, modulesById, annotations },
    { categories: [category as never], limit: 50, minConfidence: 0, annotationReasoning: 'on' },
  );
  return (res.findings as Array<{ id: string; category: string }>).filter(f => f.category === category);
}

describe('vocab-aligned side-effect detectors', () => {
  describe('client-business-logic — isPure gate', () => {
    const modId = 'mod:app/src/features/cart/cart-rules';
    const mod = makeMod(modId, 'app', 'src/features/cart/cart-rules.ts', { exports: businessExports() });

    it('emits for an un-annotated frontend module with business exports', () => {
      const { graph, modulesById } = buildGraph([mod]);
      const findings = report(graph, modulesById, 'client-business-logic', makeStore());
      expect(findings.map(f => f.id)).toContain(`client-business-logic:${modId}`);
    });

    it('suppresses when the annotation explicitly declares { kind: "pure" }', () => {
      const { graph, modulesById } = buildGraph([mod]);
      const annotations = makeStore([
        makeAnn(modId, { summary: 'Pure cart math helpers.', sideEffects: [{ kind: 'pure' }] }),
      ]);
      const findings = report(graph, modulesById, 'client-business-logic', annotations);
      expect(findings).toHaveLength(0);
    });

    it('still emits when the annotation declares real effects (not pure)', () => {
      const { graph, modulesById } = buildGraph([mod]);
      const effects: SideEffect[] = [{ kind: 'io-write', subtype: 'http', description: 'POST /api/cart' }];
      const annotations = makeStore([makeAnn(modId, { summary: 'Cart ops.', sideEffects: effects })]);
      const findings = report(graph, modulesById, 'client-business-logic', annotations);
      expect(findings.map(f => f.id)).toContain(`client-business-logic:${modId}`);
    });
  });

  describe('privileged-client-side-effect — structured annotation gate', () => {
    const modId = 'mod:app/src/features/admin/admin-panel';
    const mod = makeMod(modId, 'app', 'src/features/admin/admin-panel.tsx', {
      semanticHints: { ssr: { useClient: true }, ui: { framework: 'react' } },
      exports: [{ name: 'AdminPanel', kind: 'component', lineRange: { start: 1, end: 20 }, isDefault: false }],
    });

    function findWith(sideEffects: SideEffect[] | undefined) {
      const { graph, modulesById } = buildGraph([mod]);
      const annotations = sideEffects
        ? makeStore([makeAnn(modId, { summary: 'Admin panel.', sideEffects })])
        : makeStore();
      return report(graph, modulesById, 'privileged-client-side-effect', annotations);
    }

    it('confirms a client module whose annotation declares io-write:db', () => {
      const findings = findWith([{ kind: 'io-write', subtype: 'db', description: 'writes tenant config' }]);
      expect(findings.map(f => f.id)).toContain(`privileged-client-side-effect:${modId}`);
    });

    it('confirms external SDK effects', () => {
      const findings = findWith([{ kind: 'external', subtype: 'sdk', description: 'aws-sdk SES.sendEmail' }]);
      expect(findings.map(f => f.id)).toContain(`privileged-client-side-effect:${modId}`);
    });

    it('does NOT flag logging-only io-write (stdout/stderr)', () => {
      const findings = findWith([{ kind: 'io-write', subtype: 'stdout', description: 'debug log' }]);
      expect(findings).toHaveLength(0);
    });

    it('does NOT flag a module that declares { kind: "pure" } with no syntactic signal', () => {
      const findings = findWith([{ kind: 'pure' }]);
      expect(findings).toHaveLength(0);
    });
  });
});
