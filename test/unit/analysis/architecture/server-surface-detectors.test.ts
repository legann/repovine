import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  runRefactoringOpportunityDetail,
  runRefactoringReport,
} from '../../../../src/analysis/architecture/index.js';
import { serverSurfaceApplies } from '../../../../src/analysis/architecture-detectors/server-surface/detectors.js';
import { AnnotationStore } from '../../../../src/annotations/store.js';
import { addEdge, addNode, createEmptyGraph } from '../../../../src/graph/index.js';
import type { ModuleInfo, RepositoryGraph } from '../../../../src/types.js';

function makeMod(
  id: string,
  packageName: string,
  relativeFilePath: string,
  options: Partial<ModuleInfo> = {},
): ModuleInfo {
  return {
    id,
    packageName,
    filePath: `/repo/packages/${packageName}/${relativeFilePath}`,
    relativeFilePath,
    contentHash: 'h1',
    imports: [],
    exports: [],
    ...options,
  };
}

function addPackage(graph: RepositoryGraph, pkg: string): void {
  addNode(graph, { id: `pkg:${pkg}`, type: 'package', label: pkg, description: '' });
  addEdge(graph, 'root', `pkg:${pkg}`, 'contains');
}

function addModule(graph: RepositoryGraph, mod: ModuleInfo): void {
  addNode(graph, {
    id: mod.id,
    type: 'module',
    label: mod.relativeFilePath,
    description: '',
    data: {
      filePath: mod.filePath,
      relativeFilePath: mod.relativeFilePath,
      envVars: mod.semanticHints?.envVars,
    },
  });
  addEdge(graph, `pkg:${mod.packageName}`, mod.id, 'contains');
}

function linkImport(from: ModuleInfo, to: ModuleInfo, importedName: string): void {
  from.imports.push({
    moduleSpecifier: to.relativeFilePath,
    resolvedModuleId: to.id,
    importedNames: [importedName],
    isTypeOnly: false,
    isExternal: false,
  });
}

function buildServerFixture() {
  const graph = createEmptyGraph();
  addNode(graph, { id: 'root', type: 'root', label: 'root', description: '' });
  addPackage(graph, 'app');

  const auth = makeMod('mod:app/src/server/auth', 'app', 'src/server/auth.ts');
  const repository = makeMod('mod:app/src/repositories/orders', 'app', 'src/repositories/orders.ts');
  const policy = makeMod('mod:app/src/domain/order-policy', 'app', 'src/domain/order-policy.ts');
  const apiClient = makeMod('mod:app/src/api/billing-api.client', 'app', 'src/api/billing-api.client.ts');
  const handler = makeMod('mod:app/src/api/orders/route', 'app', 'src/api/orders/route.ts', {
    exports: [
      { name: 'GET', kind: 'function', lineRange: { start: 1, end: 55 }, isDefault: false },
      { name: 'POST', kind: 'function', lineRange: { start: 57, end: 145 }, isDefault: false },
      { name: 'DELETE', kind: 'function', lineRange: { start: 147, end: 220 }, isDefault: false },
      { name: 'normalizeOrder', kind: 'function', lineRange: { start: 222, end: 260 }, isDefault: false },
    ],
    semanticHints: {
      envVars: ['ORDERS_TABLE', 'ORDER_EVENTS_QUEUE_URL'],
      routes: [{ path: '/api/orders', component: '(file-route)', kind: 'api' }],
      runtimeActions: [
        { action: 'sqs.sendMessage', envVar: 'ORDER_EVENTS_QUEUE_URL' },
      ],
    },
  });

  for (const mod of [handler, auth, repository, policy, apiClient]) addModule(graph, mod);
  for (const [target, name] of [
    [auth, 'requireUser'],
    [repository, 'saveOrder'],
    [policy, 'canEditOrder'],
    [apiClient, 'syncBilling'],
  ] as const) {
    linkImport(handler, target, name);
    addEdge(graph, handler.id, target.id, 'imports');
  }

  return {
    graph,
    modulesById: new Map([handler, auth, repository, policy, apiClient].map(mod => [mod.id, mod])),
    annotations: AnnotationStore.createSync(fs.mkdtempSync(path.join(os.tmpdir(), 'server-surface-'))),
    handler,
  };
}

describe('server-surface detector pack', () => {
  it('applies to backend context or HTTP handler signals', () => {
    expect(serverSurfaceApplies(makeMod('mod:app/src/server/jobs', 'app', 'src/server/jobs.ts'))).toBe(true);
    expect(serverSurfaceApplies(makeMod('mod:app/src/api/orders/route', 'app', 'src/api/orders/route.ts'))).toBe(true);
    expect(serverSurfaceApplies(makeMod('mod:app/src/components/Button', 'app', 'src/components/Button.tsx'))).toBe(false);
  });

  it('reports broad server handler orchestration under the god-module category', () => {
    const { graph, modulesById, annotations, handler } = buildServerFixture();
    const report = runRefactoringReport({
      graph,
      modulesById,
      annotations,
    }, {
      categories: ['god-module'],
      minConfidence: 0,
      limit: 50,
    });

    const findings = report.findings as Array<{ id: string; category: string; evidence: string[] }>;
    const finding = findings.find(item => item.id === `server-handler-orchestration:${handler.id}`);
    expect(finding).toMatchObject({
      category: 'god-module',
    });
    expect(finding?.evidence.join(' ')).toContain('Orchestration target roles: api, domain, server, storage');
  });

  it('round-trips its detector-prefixed finding id through detail mode', () => {
    const state = buildServerFixture();
    const findingId = `server-handler-orchestration:${state.handler.id}`;
    const detail = runRefactoringOpportunityDetail({
      graph: state.graph,
      modulesById: state.modulesById,
      annotations: state.annotations,
    }, { findingId });

    expect(detail).toMatchObject({
      findingId,
      finding: { id: findingId, category: 'god-module' },
    });
  });

  it('stays hidden when the caller filters to unrelated categories', () => {
    const { graph, modulesById, annotations } = buildServerFixture();
    const report = runRefactoringReport({
      graph,
      modulesById,
      annotations,
    }, {
      categories: ['boundary'],
      minConfidence: 0,
      limit: 50,
    });

    const findings = report.findings as Array<{ id: string }>;
    expect(findings.some(item => item.id.startsWith('server-handler-orchestration:'))).toBe(false);
  });
});
