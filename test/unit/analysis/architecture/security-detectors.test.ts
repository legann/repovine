import { runRefactoringReport } from '../../../../src/analysis/architecture/index.js';
import { STRICTNESS_PROFILES } from '../../../../src/analysis/architecture/config.js';
import { AnnotationStore } from '../../../../src/annotations/store.js';
import { addEdge, addNode, createEmptyGraph } from '../../../../src/graph/index.js';
import { CURRENT_ANNOTATION_SCHEMA_VERSION, type ModuleInfo, type RepositoryGraph, type StoredAnnotation } from '../../../../src/types.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function makeStore(annotations: StoredAnnotation[] = []): AnnotationStore {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-detectors-'));
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
    filePath: `/repo/packages/${packageName}/${relativeFilePath}`,
    relativeFilePath,
    contentHash: 'h1',
    imports: [],
    exports: [],
    ...options,
  };
}

function addModule(graph: RepositoryGraph, pkg: string, mod: ModuleInfo): void {
  addNode(graph, {
    id: mod.id,
    type: 'module',
    label: mod.relativeFilePath,
    description: '',
    data: {
      filePath: mod.filePath,
      relativeFilePath: mod.relativeFilePath,
      envVars: mod.semanticHints?.envVars,
      ssr: mod.semanticHints?.ssr,
    },
  });
  addEdge(graph, `pkg:${pkg}`, mod.id, 'contains');
}

describe('security refactoring detectors', () => {
  function buildSecurityFixture() {
    const graph = createEmptyGraph();
    addNode(graph, { id: 'root', type: 'root', label: 'root', description: '' });
    for (const pkg of ['app', 'shared']) {
      addNode(graph, { id: `pkg:${pkg}`, type: 'package', label: pkg, description: '' });
      addEdge(graph, 'root', `pkg:${pkg}`, 'contains');
    }

    const client = makeMod('mod:app/src/app/page', 'app', 'src/app/page.tsx', {
      imports: [{
        moduleSpecifier: '../server/db',
        resolvedModuleId: 'mod:app/src/server/db',
        importedNames: ['saveSession'],
        isTypeOnly: false,
        isExternal: false,
      }],
      exports: [{ name: 'Page', kind: 'component', lineRange: { start: 1, end: 20 }, isDefault: false }],
      semanticHints: {
        envVars: ['STRIPE_SECRET_KEY'],
        ssr: { useClient: true },
        security: [{ kind: 'secret-env', name: 'STRIPE_SECRET_KEY', lineRange: { start: 3, end: 3 } }],
        ui: {
          framework: 'next',
          dataAccess: [{ kind: 'mutation', callee: 'api.post', target: '/api/session', lineRange: { start: 8, end: 8 } }],
        },
      },
    });

    const serverDb = makeMod('mod:app/src/server/db', 'app', 'src/server/db.ts', {
      exports: [{ name: 'saveSession', kind: 'function', lineRange: { start: 1, end: 30 }, isDefault: false }],
      semanticHints: { ssr: { useServer: true } },
    });

    const apiRoute = makeMod('mod:app/src/api/orders/route', 'app', 'src/api/orders/route.ts', {
      exports: [{ name: 'POST', kind: 'function', lineRange: { start: 1, end: 40 }, isDefault: false }],
      semanticHints: { hasRoutes: true, routes: [{ path: '/api/orders', component: '(file-route)', kind: 'api' }] },
    });

    const browserStorage = makeMod('mod:app/src/auth/session-store', 'app', 'src/auth/session-store.tsx', {
      exports: [{ name: 'SessionStore', kind: 'component', lineRange: { start: 1, end: 15 }, isDefault: false }],
      semanticHints: {
        ssr: { useClient: true },
        security: [{ kind: 'browser-storage-sensitive', callee: 'localStorage.setItem', target: 'refresh_token', lineRange: { start: 6, end: 6 } }],
        ui: { framework: 'react' },
      },
    });

    const policyA = makeMod('mod:app/src/policies/submit-policy', 'app', 'src/policies/submit-policy.ts', {
      exports: [{ name: 'canSubmit', kind: 'function', lineRange: { start: 1, end: 15 }, isDefault: false }],
      semanticHints: { security: [{ kind: 'authz', callee: 'hasPermission', lineRange: { start: 3, end: 3 } }] },
    });
    const policyB = makeMod('mod:shared/src/policies/submit-policy', 'shared', 'src/policies/submit-policy.ts', {
      exports: [{ name: 'canSubmit', kind: 'function', lineRange: { start: 1, end: 15 }, isDefault: false }],
      semanticHints: { security: [{ kind: 'authz', callee: 'hasPermission', lineRange: { start: 3, end: 3 } }] },
    });

    const sourceSurface = makeMod('mod:shared/src/mcp/handlers', 'shared', 'src/mcp/handlers.ts', {
      exports: [{ name: 'inspectNode', kind: 'function', lineRange: { start: 1, end: 120 }, isDefault: false }],
      semanticHints: { security: [{ kind: 'source-disclosure', name: 'source-body-surface', lineRange: { start: 45, end: 45 } }] },
    });

    const annotated = makeMod('mod:shared/src/annotated', 'shared', 'src/annotated.ts', {
      exports: [{ name: 'annotated', kind: 'function', lineRange: { start: 1, end: 5 }, isDefault: false }],
    });

    const modules = [client, serverDb, apiRoute, browserStorage, policyA, policyB, sourceSurface, annotated];
    for (const mod of modules) addModule(graph, mod.packageName, mod);
    addEdge(graph, client.id, serverDb.id, 'imports');

    const annotations = makeStore([
      makeAnn(policyA.id, {
        summary: 'Checks whether a user can submit an order.',
        invariants: ['Only owners or tenant admins can submit orders'],
      }),
      makeAnn(policyB.id, {
        summary: 'Checks whether a user can submit an order.',
        invariants: ['Only owners or tenant admins can submit orders'],
      }),
      makeAnn(annotated.id, {
        summary: 'Calls external API with token: sk_live_1234567890abcdef',
      }),
    ]);

    return {
      graph,
      modulesById: new Map(modules.map(mod => [mod.id, mod])),
      annotations,
    };
  }

  it('reports every requested security category', () => {
    const { graph, modulesById, annotations } = buildSecurityFixture();
    const report = runRefactoringReport({
      graph,
      modulesById,
      annotations,
    }, {
      categories: [
        'secret-config-boundary',
        'authorization-policy-drift',
        'trust-boundary-validation',
        'privileged-client-side-effect',
        'sensitive-browser-storage',
        'server-client-boundary',
        'source-disclosure-surface',
        'annotation-secret-hygiene',
      ],
      limit: 50,
      minConfidence: 0,
      annotationReasoning: 'on',
    });

    const findings = report.findings as Array<{ id: string; category: string; annotationContext?: unknown; evidence: string[] }>;
    expect(findings.map(f => f.category)).toEqual(expect.arrayContaining([
      'secret-config-boundary',
      'authorization-policy-drift',
      'trust-boundary-validation',
      'privileged-client-side-effect',
      'sensitive-browser-storage',
      'server-client-boundary',
      'source-disclosure-surface',
      'annotation-secret-hygiene',
    ]));
    expect(findings.find(f => f.category === 'authorization-policy-drift')?.annotationContext).toBeDefined();
    expect(findings.find(f => f.category === 'annotation-secret-hygiene')?.evidence.join(' ')).not.toContain('sk_live_1234567890abcdef');
  });

  it('applies strict security thresholds to suppress weak/noisy candidates', () => {
    const graph = createEmptyGraph();
    addNode(graph, { id: 'root', type: 'root', label: 'root', description: '' });
    for (const pkg of ['app', 'shared']) {
      addNode(graph, { id: `pkg:${pkg}`, type: 'package', label: pkg, description: '' });
      addEdge(graph, 'root', `pkg:${pkg}`, 'contains');
    }

    const publicAuthMode = makeMod('mod:app/src/login-demo', 'app', 'src/login-demo.ts', {
      semanticHints: {
        ssr: { useClient: true },
        security: [{ kind: 'public-env', name: 'VITE_AUTH_MODE', lineRange: { start: 12, end: 12 } }],
      },
    });

    const mutationOnlyClient = makeMod('mod:app/src/features/admin/services/tenant-api.service', 'app', 'src/features/admin/services/tenant-api.service.ts', {
      semanticHints: {
        ui: {
          framework: 'react',
          dataAccess: [
            { kind: 'api-client', callee: 'api.post', target: '/tenant/admin', lineRange: { start: 10, end: 10 } },
            { kind: 'mutation', callee: 'api.patch', target: '/tenant/admin', lineRange: { start: 11, end: 11 } },
          ],
        },
      },
    });

    const formulaComposed = makeMod('mod:app/src/features/formula-editor/hooks/useFormulaComposed', 'app', 'src/features/formula-editor/hooks/useFormulaComposed.ts', {
      imports: [{
        moduleSpecifier: './useFormulaStorage',
        resolvedModuleId: 'mod:app/src/features/formula-editor/hooks/useFormulaStorage',
        importedNames: ['useFormulaStorage'],
        isTypeOnly: false,
        isExternal: false,
      }],
      exports: [{ name: 'useFormulaComposed', kind: 'function', lineRange: { start: 1, end: 40 }, isDefault: false }],
    });
    const formulaStorage = makeMod('mod:app/src/features/formula-editor/hooks/useFormulaStorage', 'app', 'src/features/formula-editor/hooks/useFormulaStorage.ts', {
      exports: [{ name: 'useFormulaStorage', kind: 'function', lineRange: { start: 1, end: 30 }, isDefault: false }],
    });

    const policyA = makeMod('mod:app/src/policies/index', 'app', 'src/policies/index.ts', {
      exports: [{ name: 'can', kind: 'function', lineRange: { start: 1, end: 8 }, isDefault: false }],
    });
    const policyB = makeMod('mod:shared/src/policies/index', 'shared', 'src/policies/index.ts', {
      exports: [{ name: 'can', kind: 'function', lineRange: { start: 1, end: 8 }, isDefault: false }],
    });

    const health = makeMod('mod:app/src/health', 'app', 'src/health.ts', {
      exports: [{ name: 'handler', kind: 'function', lineRange: { start: 1, end: 12 }, isDefault: false }],
    });

    const semanticStorage = makeMod('mod:app/src/features/auth/session-cache', 'app', 'src/features/auth/session-cache.tsx', {
      semanticHints: {
        ui: { framework: 'react' },
        security: [{ kind: 'browser-storage', callee: 'localStorage.setItem', lineRange: { start: 6, end: 6 } }],
      },
    });

    const modules = [publicAuthMode, mutationOnlyClient, formulaComposed, formulaStorage, policyA, policyB, health, semanticStorage];
    for (const mod of modules) addModule(graph, mod.packageName, mod);
    addEdge(graph, formulaComposed.id, formulaStorage.id, 'imports');

    const annotations = makeStore([
      makeAnn(policyA.id, { summary: 'Access permission helper for UI routes.' }),
      makeAnn(policyB.id, { summary: 'Access permission helper for backend routes.' }),
      makeAnn(semanticStorage.id, { summary: 'Caches auth session token information in the browser.' }),
    ]);
    const modulesById = new Map(modules.map(mod => [mod.id, mod]));
    // `trust-boundary-validation` is absent on purpose: no module here declares a route, a side
    // effect or an authz signal, and the default profile no longer treats a directory named `api/`
    // or an export named `handler` as evidence on its own. The route-backed fixture above still
    // exercises it.
    const categories = [
      'secret-config-boundary',
      'authorization-policy-drift',
      'privileged-client-side-effect',
      'sensitive-browser-storage',
      'server-client-boundary',
    ] as const;

    const normalReport = runRefactoringReport({
      graph,
      modulesById,
      annotations,
      refactoringThresholds: STRICTNESS_PROFILES.normal,
    }, {
      categories: [...categories],
      limit: 50,
      minConfidence: 0,
    });
    const normalCategories = (normalReport.findings as Array<{ category: string }>).map(f => f.category);
    expect(normalCategories).toEqual(expect.arrayContaining([...categories]));

    const strictReport = runRefactoringReport({
      graph,
      modulesById,
      annotations,
      refactoringThresholds: STRICTNESS_PROFILES.strict,
    }, {
      categories: [...categories],
      limit: 50,
      minConfidence: 0,
    });
    expect(strictReport.totalFindings).toBe(0);
  });
});

// `isTrustBoundaryModule` admits a module on its path or on an export named `handler`/`POST`/…
// That is an admission test, not evidence. Without a route, a side effect or an authz signal the
// default profile must stay silent, or the finding rests on a directory name.
describe('trust-boundary findings are evidence-led, not name-led', () => {
  function reportFor(mod: ModuleInfo, profile = STRICTNESS_PROFILES.normal): string[] {
    const graph = createEmptyGraph();
    addModule(graph, mod.packageName, mod);
    const report = runRefactoringReport({
      graph,
      modulesById: new Map([[mod.id, mod]]),
      annotations: makeStore([]),
      refactoringThresholds: profile,
    }, { categories: ['trust-boundary-validation'], limit: 50, minConfidence: 0 });
    return (report.findings as Array<{ category: string }>).map(f => f.category);
  }

  it('stays silent on an api/ path whose only evidence is that it exports something', () => {
    expect(reportFor(makeMod('mod:app/src/api/orders/route', 'app', 'src/api/orders/route.ts', {
      exports: [{ name: 'POST', kind: 'function', lineRange: { start: 1, end: 40 }, isDefault: false }],
    }))).toEqual([]);
  });

  it('stays silent on a module admitted only by an export named handler', () => {
    expect(reportFor(makeMod('mod:app/src/health', 'app', 'src/health.ts', {
      exports: [{ name: 'handler', kind: 'function', lineRange: { start: 1, end: 12 }, isDefault: false }],
    }))).toEqual([]);
  });

  it('reports the same path once it declares a real api route', () => {
    expect(reportFor(makeMod('mod:app/src/api/orders/route', 'app', 'src/api/orders/route.ts', {
      exports: [{ name: 'POST', kind: 'function', lineRange: { start: 1, end: 40 }, isDefault: false }],
      semanticHints: { hasRoutes: true, routes: [{ path: '/api/orders', component: '(file-route)', kind: 'api' }] },
    }))).toEqual(['trust-boundary-validation']);
  });

  // Every other boolean knob in the profiles runs `loose == normal` and moves only at `strict`.
  // `requireRouteOrSideEffect` is a mode switch, not a bar: `false` admits a module on its directory
  // name alone, so a `loose` profile shipping it would emit findings resting on the path — on a
  // Kibana-scale tree that is 8837 of 9350, sampling to type files, mocks and mapping assets.
  it.each([['loose'], ['normal'], ['strict']] as const)('is evidence-led under the %s profile', (name) => {
    const profile = STRICTNESS_PROFILES[name];
    expect(profile.trustBoundaryValidation.requireRouteOrSideEffect).toBe(true);
    expect(reportFor(makeMod('mod:app/src/api/orders/route', 'app', 'src/api/orders/route.ts', {
      exports: [{ name: 'POST', kind: 'function', lineRange: { start: 1, end: 40 }, isDefault: false }],
    }), profile)).toEqual([]);
  });
});
