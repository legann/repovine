import {
  nodeFreshnessLookup,
  runRefactoringOpportunityDetail,
  type RefactoringState,
} from '../../../../src/analysis/architecture/index.js';
import {
  affectedNodeEdges,
  refactoringCategoryDetail,
  refactoringNextCalls,
  refactoringNodeSummary,
} from '../../../../src/analysis/architecture/detail.js';
import type { RefactoringFinding } from '../../../../src/analysis/architecture/types.js';
import { addEdge, addNode, createEmptyGraph } from '../../../../src/graph/index.js';
import type { AnnotationStore } from '../../../../src/annotations/store.js';
import {
  CURRENT_ANNOTATION_SCHEMA_VERSION,
  type ModuleInfo,
  type RepositoryGraph,
  type StoredAnnotation,
} from '../../../../src/types.js';

function makeExports(count: number, kind: ModuleInfo['exports'][number]['kind'] = 'function'): ModuleInfo['exports'] {
  return Array.from({ length: count }, (_, i) => ({
    name: `export${i}`,
    kind,
    lineRange: { start: i * 10 + 1, end: i * 10 + 8 },
    isDefault: false,
  }));
}

function makeMod(
  id: string,
  packageName: string,
  relativeFilePath: string,
  overrides: Partial<ModuleInfo> = {},
): ModuleInfo {
  return {
    id,
    packageName,
    filePath: `/repo/packages/${packageName}/${relativeFilePath}`,
    relativeFilePath,
    contentHash: 'h1',
    imports: [],
    exports: [],
    ...overrides,
  };
}

function makeAnn(
  nodeId: string,
  contentHash = 'h1',
  annotation: Partial<StoredAnnotation['annotation']> = {},
): StoredAnnotation {
  return {
    nodeId,
    nodeType: 'module',
    contentHash,
    pass: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    annotation: {
      summary: 'Focused annotation for architecture detail tests.',
      ...annotation,
    },
    schemaVersion: CURRENT_ANNOTATION_SCHEMA_VERSION,
  };
}

function makeAnnotationStore(annotations: StoredAnnotation[] = []): AnnotationStore {
  const byId = Object.fromEntries(annotations.map(ann => [ann.nodeId, ann]));
  return {
    get: (id: string) => byId[id],
    getAll: () => byId,
    isFresh: (id: string, hash: string) => {
      const ann = byId[id];
      return !!ann
        && ann.contentHash === hash
        && (ann.schemaVersion ?? 1) >= CURRENT_ANNOTATION_SCHEMA_VERSION;
    },
  } as unknown as AnnotationStore;
}

function buildState(modules: ModuleInfo[], annotations: StoredAnnotation[] = []): RefactoringState {
  const graph: RepositoryGraph = createEmptyGraph();
  addNode(graph, { id: 'root', type: 'root', label: 'root', description: '' });
  const packages = new Set(modules.map(mod => mod.packageName));
  for (const pkg of packages) {
    addNode(graph, { id: `pkg:${pkg}`, type: 'package', label: pkg, description: '' });
    addEdge(graph, 'root', `pkg:${pkg}`, 'contains');
  }
  for (const mod of modules) {
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
    addEdge(graph, `pkg:${mod.packageName}`, mod.id, 'contains');
  }
  for (const mod of modules) {
    for (const imp of mod.imports) {
      if (imp.resolvedModuleId) addEdge(graph, mod.id, imp.resolvedModuleId, 'imports');
    }
  }

  return {
    graph,
    modulesById: new Map(modules.map(mod => [mod.id, mod])),
    annotations: makeAnnotationStore(annotations),
    snapshot: {
      repoRoot: '/repo',
      timestamp: '2026-01-01T00:00:00.000Z',
      packages: [],
      modules,
    },
  };
}

function detail(state: RefactoringState, findingId: string, maxNodes?: number): Record<string, unknown> {
  return runRefactoringOpportunityDetail(state, {
    findingId,
    ...(maxNodes ? { maxNodes } : {}),
  });
}

function finding(
  category: RefactoringFinding['category'],
  id: string,
  nodes: string[],
  overrides: Partial<RefactoringFinding> = {},
): RefactoringFinding {
  return {
    id,
    category,
    title: id,
    severity: 'medium',
    impact: 'medium',
    confidence: 0.9,
    nodes,
    evidence: [],
    suggestion: 'Inspect detail output.',
    ...overrides,
  };
}

/** Node summary through the same freshness lookup the tool builds. */
function nodeSummary(state: RefactoringState, nodeId: string): Record<string, unknown> {
  return refactoringNodeSummary(state.graph, state.modulesById, state.annotations, nodeId, nodeFreshnessLookup(state));
}

function categoryDetail(state: RefactoringState, candidate: RefactoringFinding): Record<string, unknown> {
  return refactoringCategoryDetail(state.graph, state.modulesById, state.annotations, candidate, nodeFreshnessLookup(state));
}

describe('architecture detail expansion', () => {
  it('expands god-module findings with node summaries, category facts, and follow-up calls', () => {
    const dep = makeMod('mod:app/src/ports/logger', 'app', 'src/ports/logger.ts', {
      exports: makeExports(1),
    });
    const orchestrator = makeMod('mod:app/src/orders/orchestrator', 'app', 'src/orders/orchestrator.ts', {
      exports: makeExports(12),
      imports: [{
        moduleSpecifier: '../ports/logger',
        resolvedModuleId: dep.id,
        importedNames: ['export0'],
        isTypeOnly: false,
        isExternal: false,
      }],
    });
    const state = buildState([orchestrator, dep], [
      makeAnn(orchestrator.id, 'h1', { risks: ['Splitting changes orchestration order.'] }),
    ]);

    const result = detail(state, `god-module:${orchestrator.id}`);
    const affectedNodes = result.affectedNodes as Array<Record<string, unknown>>;
    const categoryDetail = result.categoryDetail as Record<string, unknown>;
    const nextCalls = result.nextCalls as string[];

    expect(result).toMatchObject({
      findingId: `god-module:${orchestrator.id}`,
      truncatedAffectedNodes: 0,
    });
    expect((result.finding as Record<string, unknown>).category).toBe('god-module');
    expect(affectedNodes).toHaveLength(1);
    expect(affectedNodes[0]).toMatchObject({
      id: orchestrator.id,
      relativeFilePath: 'src/orders/orchestrator.ts',
      exportCount: 12,
      fanOut: 1,
      annotation: expect.objectContaining({
        fresh: true,
        risks: ['Splitting changes orchestration order.'],
      }),
    });
    expect(categoryDetail).toMatchObject({
      moduleId: orchestrator.id,
      exportCount: 12,
      fanOut: 1,
      lineEstimate: 118,
    });
    expect(nextCalls).toEqual(expect.arrayContaining([
      `inspect_node({ "nodeId": "${orchestrator.id}" })`,
      `analyze_dependencies({ "scope": "${orchestrator.id}", "mode": "impact", "depth": 3 })`,
    ]));
  });

  it('bounds duplicate-like affected nodes and keeps category-specific responsibility detail', () => {
    const modules = [
      makeMod('mod:app/src/a/logger', 'app', 'src/a/logger.ts', { exports: makeExports(1) }),
      makeMod('mod:app/src/b/logger', 'app', 'src/b/logger.ts', { exports: makeExports(1) }),
      makeMod('mod:app/src/c/logger', 'app', 'src/c/logger.ts', { exports: makeExports(1) }),
    ];
    const state = buildState(modules);

    const result = detail(state, 'duplicate-like:logger', 2);
    const affectedNodes = result.affectedNodes as Array<Record<string, unknown>>;
    const categoryDetail = result.categoryDetail as Record<string, unknown>;

    expect((result.finding as Record<string, unknown>).category).toBe('duplicate-like');
    expect(affectedNodes.map(node => node.id)).toEqual([
      'mod:app/src/a/logger',
      'mod:app/src/b/logger',
    ]);
    expect(result.truncatedAffectedNodes).toBe(1);
    expect(categoryDetail).toEqual({
      responsibilityKey: 'logger',
      packages: ['pkg:app'],
    });
  });

  it('expands trust-boundary-validation findings with route and validation evidence slots', () => {
    const apiRoute = makeMod('mod:app/src/api/orders/route', 'app', 'src/api/orders/route.ts', {
      exports: [{ name: 'POST', kind: 'function', lineRange: { start: 1, end: 40 }, isDefault: false }],
      semanticHints: {
        hasRoutes: true,
        routes: [{ path: '/api/orders', component: '(file-route)', kind: 'api' }],
        runtimeActions: [{ action: 'sqs.sendMessage', envVar: 'ORDERS_QUEUE_URL' }],
      },
    });
    const state = buildState([apiRoute]);

    const result = detail(state, `trust-boundary-validation:${apiRoute.id}`);
    const categoryDetail = result.categoryDetail as Record<string, unknown>;
    const nextCalls = result.nextCalls as string[];

    expect((result.finding as Record<string, unknown>).category).toBe('trust-boundary-validation');
    expect(categoryDetail).toMatchObject({
      moduleId: apiRoute.id,
      routes: [{ path: '/api/orders', component: '(file-route)', kind: 'api' }],
      validationSignals: [],
      authzSignals: [],
      imports: [],
    });
    expect(nextCalls).toContain(
      `inspect_node({ "nodeId": "${apiRoute.id}", "grepBody": "schema|validate|safeParse|parse|guard|assert" })`,
    );
  });

  it('expands annotation-risk findings with freshness and quality facts', () => {
    const hub = makeMod('mod:app/src/domain/orders-hub', 'app', 'src/domain/orders-hub.ts', {
      exports: makeExports(8),
    });
    const state = buildState([hub], [
      makeAnn(hub.id, 'old-hash', { summary: 'Thin stale note.' }),
    ]);

    const result = detail(state, `annotation-risk:${hub.id}`);
    const affectedNodes = result.affectedNodes as Array<Record<string, unknown>>;
    const categoryDetail = result.categoryDetail as Record<string, unknown>;
    const nextCalls = result.nextCalls as string[];

    expect((result.finding as Record<string, unknown>).category).toBe('annotation-risk');
    expect(affectedNodes[0]).toMatchObject({
      id: hub.id,
      annotation: expect.objectContaining({ fresh: false }),
    });
    expect(categoryDetail).toMatchObject({
      moduleId: hub.id,
      hasAnnotation: true,
      fresh: false,
      moduleKind: 'generic',
      // Fixture: generic module, 8 exports, summary only 16 chars (fails >20),
      // no other fields → score 0, minimal tier, and the exact ordered missing set.
      quality: expect.objectContaining({
        score: 0,
        tier: 'minimal',
        moduleKind: 'generic',
        missingFields: [
          'summary (>20 chars)',
          'keyExports',
          'assumptions',
          'integrationPoints',
        ],
      }),
    });
    expect(nextCalls).toContain(`write_annotation({ "nodeId": "${hub.id}", "annotation": { "summary": "..." } })`);
  });

  it('returns structured errors for unknown and missing detail finding ids', () => {
    const mod = makeMod('mod:app/src/domain/orders-hub', 'app', 'src/domain/orders-hub.ts', {
      exports: makeExports(8),
    });
    const state = buildState([mod]);

    expect(detail(state, 'not-a-category:anything')).toMatchObject({
      error: expect.stringContaining('Unknown refactoring finding category'),
      knownCategories: expect.arrayContaining(['god-module', 'annotation-risk']),
    });
    expect(detail(state, 'god-module:mod:missing')).toMatchObject({
      error: expect.stringContaining('Refactoring finding not found'),
      searchedCategory: 'god-module',
      searchedScope: 'all',
      returnedInCategory: 0,
      sampleFindingIds: [],
    });
  });

  it('summarizes node kinds and affected edges with annotations and graph metadata', () => {
    const target = makeMod('mod:web/src/server/secrets', 'web', 'src/server/secrets.ts', {
      exports: [{ name: 'loadSecrets', kind: 'function', lineRange: { start: 1, end: 12 }, isDefault: false }],
      semanticHints: { envVars: ['STRIPE_SECRET_KEY'] },
    });
    const importer = makeMod('mod:web/src/features/orders/page', 'web', 'src/features/orders/page.tsx', {
      exports: [{ name: 'OrdersPage', kind: 'component', lineRange: { start: 1, end: 60 }, isDefault: false }],
      imports: [{
        moduleSpecifier: '../../server/secrets',
        resolvedModuleId: target.id,
        importedNames: ['loadSecrets'],
        isTypeOnly: false,
        isExternal: false,
      }],
    });
    const state = buildState([target, importer], [
      makeAnn(importer.id, 'h1', {
        assumptions: ['Client-only page.'],
        sideEffects: [{ kind: 'io-read', subtype: 'http' }],
      }),
      makeAnn('mod:web/src/legacy/annotated-only'),
    ]);
    addNode(state.graph, {
      id: 'domain:orders',
      type: 'domain',
      label: 'orders',
      description: '',
      data: { tier: 'business', subdomains: ['checkout'] },
    });
    addNode(state.graph, {
      id: 'resource:orders-queue',
      type: 'runtime-resource',
      label: 'orders-queue',
      description: '',
      data: { kind: 'queue', provider: 'aws', contentHash: 'rq1' },
    });
    addEdge(state.graph, importer.id, 'domain:orders', 'tagged');
    addEdge(state.graph, importer.id, 'domain:orders', 'implements');

    const summary = nodeSummary(state, importer.id);
    expect(summary).toMatchObject({
      id: importer.id,
      packageId: 'pkg:web',
      domains: ['domain:orders'],
      annotation: expect.objectContaining({
        assumptions: ['Client-only page.'],
        fresh: true,
      }),
    });
    expect(nodeSummary(state, 'mod:web/src/legacy/annotated-only')).toMatchObject({
      id: 'mod:web/src/legacy/annotated-only',
      type: 'unknown',
      annotation: expect.objectContaining({ summary: 'Focused annotation for architecture detail tests.' }),
    });
    expect(nodeSummary(state, 'resource:orders-queue')).toMatchObject({
      runtimeResource: { kind: 'queue', provider: 'aws', contentHash: 'rq1' },
    });
    expect(nodeSummary(state, 'domain:orders')).toMatchObject({
      domain: { tier: 'business', subdomains: ['checkout'] },
    });

    expect(affectedNodeEdges(
      state.graph,
      state.modulesById,
      [importer.id, target.id, 'domain:orders'],
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: importer.id,
        to: target.id,
        kind: 'imports',
        importedNames: ['loadSecrets'],
      }),
      expect.objectContaining({
        from: importer.id,
        to: 'domain:orders',
        kind: 'implements',
      }),
    ]));
  });

  it('expands UI, flow, policy, and domain category details directly', () => {
    const policy = makeMod('mod:web/src/features/orders/domain/policy', 'web', 'src/features/orders/domain/policy.ts', {
      exports: [
        { name: 'canShipOrder', kind: 'function', lineRange: { start: 1, end: 8 }, isDefault: false },
        { name: 'OrderPolicy', kind: 'type', lineRange: { start: 10, end: 12 }, isDefault: false },
      ],
      semanticHints: {
        security: [{ kind: 'authz', name: 'canShipOrder' }],
      },
    });
    const apiClient = makeMod('mod:web/src/api/orders-client', 'web', 'src/api/orders-client.ts', {
      exports: [{ name: 'fetchOrders', kind: 'function', lineRange: { start: 1, end: 10 }, isDefault: false }],
    });
    const storage = makeMod('mod:web/src/storage/browser', 'web', 'src/storage/browser.ts', {
      exports: [{ name: 'readToken', kind: 'function', lineRange: { start: 1, end: 9 }, isDefault: false }],
      semanticHints: {
        security: [{ kind: 'browser-storage-sensitive', callee: 'localStorage.getItem', target: 'authToken' }],
      },
    });
    const stateStore = makeMod('mod:web/src/features/orders/stores/order-store', 'web', 'src/features/orders/stores/order-store.ts', {
      exports: [{ name: 'useOrderStore', kind: 'function', lineRange: { start: 1, end: 22 }, isDefault: false }],
    });
    const wrapper = makeMod('mod:web/src/features/orders/services/orders-service', 'web', 'src/features/orders/services/orders-service.ts', {
      exports: [{ name: 'ordersService', kind: 'function', lineRange: { start: 1, end: 40 }, isDefault: false }],
      semanticHints: {
        ui: {
          serviceWrapper: { candidate: true, role: 'service', lineCount: 40, delegateCallCount: 3 },
        },
      },
    });
    const page = makeMod('mod:web/src/features/orders/page', 'web', 'src/features/orders/page.tsx', {
      exports: [
        { name: 'OrdersPage', kind: 'component', lineRange: { start: 1, end: 120 }, isDefault: false },
        { name: 'mapOrderViewModel', kind: 'function', lineRange: { start: 122, end: 150 }, isDefault: false },
        { name: 'default', kind: 'component', lineRange: { start: 152, end: 152 }, isDefault: true },
      ],
      imports: [
        {
          moduleSpecifier: '../domain/policy',
          resolvedModuleId: policy.id,
          importedNames: ['canShipOrder'],
          isTypeOnly: false,
          isExternal: false,
        },
        {
          moduleSpecifier: '../../api/orders-client',
          resolvedModuleId: apiClient.id,
          importedNames: ['fetchOrders'],
          isTypeOnly: false,
          isExternal: false,
        },
        {
          moduleSpecifier: '../../storage/browser',
          resolvedModuleId: storage.id,
          importedNames: ['readToken'],
          isTypeOnly: false,
          isExternal: false,
        },
      ],
      semanticHints: {
        hasRoutes: true,
        routes: [{ path: '/orders/[id]', component: 'OrdersPage', kind: 'frontend' }],
        runtimeActions: [{ action: 'lambda.invoke', envVar: 'ORDER_WORKER_ARN' }],
        ssr: { useClient: true },
        ui: {
          framework: 'react',
          lifecycleEffects: [{ kind: 'react-effect', name: 'useEffect' }],
          dataAccess: [{ kind: 'fetch', callee: 'fetch', target: '/api/orders/123' }],
          navigation: [{ kind: 'router-push', callee: 'router.push', target: '/orders' }],
          timers: [{ kind: 'timeout', callee: 'setTimeout' }],
          subscriptions: [{ kind: 'event-listener', callee: 'addEventListener' }],
          components: [{
            framework: 'react',
            name: 'OrdersPage',
            props: [
              { name: 'order', kind: 'data', source: 'destructured-param' },
              { name: 'onApprove', kind: 'callback', source: 'destructured-param' },
              { name: 'setDraft', kind: 'setter', source: 'destructured-param' },
            ],
            childComponents: [{
              componentName: 'OrderSummary',
              passedProps: ['order'],
              passedCallbacks: ['onApprove'],
              forwardedProps: ['order', 'onApprove'],
              spreadProps: [],
            }],
            localSignals: {
              localState: 1,
              effects: 1,
              dataAccess: 1,
              navigation: 1,
              timers: 1,
              subscriptions: 1,
              serviceImports: 1,
              validationOrMapping: 1,
            },
          }],
        },
      },
    });
    const state = buildState([page, policy, apiClient, storage, stateStore, wrapper], [
      makeAnn(policy.id, 'h1', {
        summary: 'Permission policy for order shipping.',
        invariants: ['Only paid orders can ship.'],
        risks: [{ text: 'Changing permissions can leak orders.', scope: 'local' }],
      }),
      makeAnn(storage.id, 'h1', {
        stateShape: 'Stores auth token and tenant id.',
        dataFlow: { token: 'localStorage -> request header' },
        risks: ['Token exposure if persisted too broadly.'],
      }),
    ]);
    addNode(state.graph, {
      id: 'domain:orders',
      type: 'domain',
      label: 'orders',
      description: '',
      data: { tier: 'business', subdomains: ['checkout'] },
    });
    addEdge(state.graph, 'domain:orders', page.id, 'contains');

    expect(categoryDetail(state, finding('god-domain', 'god-domain:domain:orders', [
      'domain:orders',
      page.id,
      policy.id,
    ]))).toMatchObject({
      domainId: 'domain:orders',
      tier: 'business',
      subdomains: ['checkout'],
      sampledModules: [page.id, policy.id],
      internalImports: 1,
      externalImports: 2,
    });
    expect(categoryDetail(state, finding('client-business-logic', `client-business-logic:${page.id}`, [page.id]))).toMatchObject({
      frontendFeature: 'feature:orders',
      businessExports: expect.arrayContaining([
        expect.objectContaining({ name: 'mapOrderViewModel', kind: 'function' }),
      ]),
      sideEffectHints: expect.objectContaining({
        runtimeActions: [{ action: 'lambda.invoke', envVar: 'ORDER_WORKER_ARN' }],
      }),
    });
    expect(categoryDetail(state, finding('flow-convergence', 'flow-convergence:orders', [page.id, apiClient.id]))).toEqual({
      targets: [apiClient.id],
      entrypoints: [page.id],
      targetOrGroupKey: 'orders',
    });
    expect(categoryDetail(state, finding('state-fragmentation', 'state-fragmentation:orders', [stateStore.id]))).toEqual({
      feature: 'orders',
      stateModules: [{ id: stateStore.id, kind: 'store' }],
    });
    expect(categoryDetail(state, finding('effect-spaghetti', `effect-spaghetti:${page.id}`, [page.id]))).toMatchObject({
      framework: 'react',
      lifecycleEffects: [{ kind: 'react-effect', name: 'useEffect' }],
      dataAccess: [{ kind: 'fetch', callee: 'fetch', target: '/api/orders/123' }],
    });
    expect(categoryDetail(state, finding(
      'prop-drilling-orchestration',
      `prop-drilling-orchestration:${page.id}:OrdersPage#0`,
      [page.id],
    ))).toMatchObject({
      componentName: 'OrdersPage',
      propCount: 3,
      callbackPropCount: 2,
      forwardedPropCount: 2,
      workflowSignals: [
        'local-state',
        'effects',
        'data-access',
        'navigation',
        'timers',
        'subscriptions',
        'service-imports',
        'validation/mapping',
      ],
    });
    expect(categoryDetail(state, finding('service-wrapper-explosion', 'service-wrapper-explosion:orders', [wrapper.id]))).toMatchObject({
      group: 'orders',
      wrappers: [expect.objectContaining({
        id: wrapper.id,
        role: 'service',
        lineCount: 40,
        delegateCallCount: 3,
      })],
    });
    expect(categoryDetail(state, finding('ui-domain-coupling', `ui-domain-coupling:${page.id}`, [page.id, policy.id]))).toMatchObject({
      moduleId: page.id,
      frontendFeature: 'feature:orders',
      coupledImports: expect.arrayContaining([
        { targetId: policy.id, role: 'domain', importedNames: ['canShipOrder'] },
        { targetId: apiClient.id, role: 'api', importedNames: ['fetchOrders'] },
        { targetId: storage.id, role: 'storage', importedNames: ['readToken'] },
      ]),
    });
    expect(categoryDetail(state, finding('route-convergence', 'route-convergence:/api/orders/:id', [page.id]))).toMatchObject({
      target: '/api/orders/:id',
      entries: [{
        id: page.id,
        routes: [{ path: '/orders/[id]', component: 'OrdersPage', kind: 'frontend' }],
        dataAccessTargets: [{ kind: 'fetch', target: '/api/orders/123', key: '/api/orders/:id' }],
      }],
    });
    expect(categoryDetail(state, finding('duplicated-client-policy', 'duplicated-client-policy:orders', [policy.id]))).toMatchObject({
      policyGroup: 'orders',
      modules: [expect.objectContaining({
        id: policy.id,
        feature: 'feature:orders',
        tokens: expect.arrayContaining(['permissions', 'policy-rules']),
        exports: ['canShipOrder', 'OrderPolicy'],
      })],
    });
    expect(categoryDetail(state, finding('authorization-policy-drift', 'authorization-policy-drift:orders', [policy.id]))).toMatchObject({
      policyGroup: 'orders',
      modules: [expect.objectContaining({
        id: policy.id,
        authzSignals: [{ kind: 'authz', name: 'canShipOrder' }],
      })],
    });
    expect(categoryDetail(state, finding('sensitive-browser-storage', `sensitive-browser-storage:${storage.id}`, [storage.id]))).toMatchObject({
      storageSignals: [{ kind: 'browser-storage-sensitive', callee: 'localStorage.getItem', target: 'authToken' }],
      annotation: {
        stateShape: 'Stores auth token and tenant id.',
        dataFlow: { token: 'localStorage -> request header' },
        risks: ['Token exposure if persisted too broadly.'],
      },
    });
  });

  it('expands boundary, infrastructure, and security category details directly', () => {
    const server = makeMod('mod:web/src/server/secrets', 'web', 'src/server/secrets.ts', {
      exports: [{ name: 'loadSecrets', kind: 'function', lineRange: { start: 1, end: 18 }, isDefault: false }],
      semanticHints: {
        envVars: ['STRIPE_SECRET_KEY', 'NEXT_PUBLIC_ANALYTICS_ID'],
        ssr: { useServer: true },
        security: [
          { kind: 'secret-env', name: 'STRIPE_SECRET_KEY' },
          { kind: 'public-env', name: 'NEXT_PUBLIC_ANALYTICS_ID' },
        ],
      },
    });
    const page = makeMod('mod:web/src/app/orders/page', 'web', 'src/app/orders/page.tsx', {
      exports: [{ name: 'OrdersPage', kind: 'component', lineRange: { start: 1, end: 80 }, isDefault: false }],
      imports: [{
        moduleSpecifier: '../../server/secrets',
        resolvedModuleId: server.id,
        importedNames: ['loadSecrets'],
        isTypeOnly: false,
        isExternal: false,
      }],
      semanticHints: {
        runtimeActions: [{ action: 'sns.publish', envVar: 'ORDER_TOPIC_ARN' }],
        ssr: { useClient: true },
        ui: {
          dataAccess: [{ kind: 'api-client', callee: 'ordersClient.create', target: '/api/orders' }],
        },
        security: [{ kind: 'authz', name: 'clientGuard' }],
      },
    });
    const designShell = makeMod('mod:web/src/components/OrderShell', 'web', 'src/components/OrderShell.tsx', {
      exports: [{ name: 'OrderShell', kind: 'component', lineRange: { start: 1, end: 40 }, isDefault: false }],
      imports: [{
        moduleSpecifier: '../features/orders/domain/policy',
        resolvedModuleId: 'mod:web/src/features/orders/domain/policy',
        importedNames: ['canShipOrder'],
        isTypeOnly: false,
        isExternal: false,
      }],
      semanticHints: {
        ui: {
          dataAccess: [{ kind: 'fetch', callee: 'fetch', target: '/api/design-preview' }],
        },
      },
    });
    const policy = makeMod('mod:web/src/features/orders/domain/policy', 'web', 'src/features/orders/domain/policy.ts', {
      exports: [{ name: 'canShipOrder', kind: 'function', lineRange: { start: 1, end: 8 }, isDefault: false }],
    });
    const disclosure = makeMod('mod:web/src/tools/source-viewer', 'web', 'src/tools/source-viewer.ts', {
      exports: [{ name: 'readPrivateMembers', kind: 'function', lineRange: { start: 1, end: 20 }, isDefault: false }],
      semanticHints: {
        security: [{ kind: 'source-disclosure', callee: 'readFile', target: 'source body' }],
      },
    });
    const worker = makeMod('mod:web/src/workers/orders', 'web', 'src/workers/orders.ts', {
      exports: [{ name: 'handleOrder', kind: 'function', lineRange: { start: 1, end: 30 }, isDefault: false }],
    });
    const state = buildState([server, page, designShell, policy, disclosure, worker], [
      makeAnn(disclosure.id, 'h1', {
        summary: 'Debug note leaks sk_live_abcdefghijkl.',
        assumptions: ['Token value xoxb-abcdefghijklmnop is redacted in production.'],
        envDependencies: { STRIPE: 'api_key=abcdefghijklmnop' },
      }),
    ]);
    addNode(state.graph, {
      id: 'resource:orders-topic',
      type: 'runtime-resource',
      label: 'orders-topic',
      description: '',
      data: { kind: 'queue', provider: 'aws', contentHash: 'topic1' },
    });
    addNode(state.graph, {
      id: 'domain:orders',
      type: 'domain',
      label: 'orders',
      description: '',
      data: { tier: 'feature' },
    });
    addEdge(state.graph, page.id, 'resource:orders-topic', 'publishes');
    addEdge(state.graph, 'resource:orders-topic', worker.id, 'consumes');

    expect(categoryDetail(state, finding('boundary', `boundary:${server.id}`, [server.id, page.id]))).toMatchObject({
      targetId: server.id,
      targetPackageId: 'pkg:web',
      importers: [page.id],
      importedSymbols: ['loadSecrets'],
    });
    expect(categoryDetail(state, finding('design-system-leakage', `design-system-leakage:${designShell.id}`, [designShell.id, policy.id]))).toMatchObject({
      moduleId: designShell.id,
      leakedImports: [{ targetId: policy.id, role: 'domain', importedNames: ['canShipOrder'] }],
      dataAccess: [{ kind: 'fetch', callee: 'fetch', target: '/api/design-preview' }],
    });
    expect(categoryDetail(state, finding('event-driven-boundary', 'event-driven-boundary:resource:orders-topic', [
      'resource:orders-topic',
      page.id,
      worker.id,
    ]))).toMatchObject({
      resourceId: 'resource:orders-topic',
      producers: [page.id],
      consumers: [worker.id],
      resource: { kind: 'queue', provider: 'aws', contentHash: 'topic1' },
    });
    expect(categoryDetail(state, finding('secret-config-boundary', `secret-config-boundary:${server.id}`, [server.id, page.id]))).toMatchObject({
      moduleId: server.id,
      envVars: ['STRIPE_SECRET_KEY', 'NEXT_PUBLIC_ANALYTICS_ID'],
      securitySignals: [
        { kind: 'secret-env', name: 'STRIPE_SECRET_KEY' },
        { kind: 'public-env', name: 'NEXT_PUBLIC_ANALYTICS_ID' },
      ],
      clientImporters: [page.id],
    });
    expect(categoryDetail(state, finding('privileged-client-side-effect', `privileged-client-side-effect:${page.id}`, [page.id, server.id]))).toMatchObject({
      moduleId: page.id,
      runtimeActions: [{ action: 'sns.publish', envVar: 'ORDER_TOPIC_ARN' }],
      securitySignals: [{ kind: 'authz', name: 'clientGuard' }],
      dataAccess: [{ kind: 'api-client', callee: 'ordersClient.create', target: '/api/orders' }],
      privilegedTargets: [{ id: server.id, role: 'server' }],
    });
    expect(categoryDetail(state, finding('server-client-boundary', `server-client-boundary:${page.id}`, [page.id, server.id]))).toMatchObject({
      moduleId: page.id,
      clientSsr: { useClient: true },
      leakedImports: [{ targetId: server.id, targetPath: 'src/server/secrets.ts', importedNames: ['loadSecrets'] }],
    });
    expect(categoryDetail(state, finding('source-disclosure-surface', `source-disclosure-surface:${disclosure.id}`, [disclosure.id]))).toMatchObject({
      moduleId: disclosure.id,
      sourceDisclosureSignals: [{ kind: 'source-disclosure', callee: 'readFile', target: 'source body' }],
      exports: [{ name: 'readPrivateMembers', kind: 'function', lineRange: { start: 1, end: 20 } }],
    });
    expect(categoryDetail(state, finding('annotation-secret-hygiene', `annotation-secret-hygiene:${disclosure.id}`, [disclosure.id]))).toMatchObject({
      moduleId: disclosure.id,
      fieldPaths: [
        'annotation.summary',
        'annotation.assumptions[0]',
        'annotation.envDependencies.STRIPE',
      ],
      note: 'Suspected secret values are intentionally not returned in detail output.',
    });
    expect(categoryDetail(state, finding('unclear-architecture', 'unclear-architecture:resource:orders-topic', [
      'resource:orders-topic',
      'domain:orders',
    ]))).toMatchObject({
      affectedNode: 'resource:orders-topic',
      domains: ['domain:orders'],
      runtimeResource: { kind: 'queue', provider: 'aws', contentHash: 'topic1' },
    });
  });

  it('builds category-specific next calls including annotation-context first steps', () => {
    const mod = makeMod('mod:web/src/app/orders/page', 'web', 'src/app/orders/page.tsx', {
      exports: [{ name: 'OrdersPage', kind: 'component', lineRange: { start: 1, end: 10 }, isDefault: false }],
    });
    const state = buildState([mod]);

    expect(refactoringNextCalls(
      state.graph,
      finding('boundary', `boundary:${mod.id}`, [mod.id]),
    )).toContain('analyze_dependencies({ "scope": "pkg:web", "mode": "package-boundaries" })');
    expect(refactoringNextCalls(
      state.graph,
      finding('event-driven-boundary', 'event-driven-boundary:resource:orders-topic', ['resource:orders-topic']),
    )).toContain('trace_flow({ "include": ["entrypoints", "services", "resources", "flows"] })');
    expect(refactoringNextCalls(
      state.graph,
      finding('server-client-boundary', `server-client-boundary:${mod.id}`, [mod.id]),
    )).toContain(`get_config_surface({ "scope": "${mod.id}", "kinds": ["env", "secret", "resource-binding"] })`);
    expect(refactoringNextCalls(
      state.graph,
      finding('source-disclosure-surface', `source-disclosure-surface:${mod.id}`, [mod.id]),
    )).toContain(`inspect_node({ "nodeId": "${mod.id}", "grepBody": "includeBody|grepBody|privateMembers|readFile" })`);
    expect(refactoringNextCalls(
      state.graph,
      finding('annotation-secret-hygiene', `annotation-secret-hygiene:${mod.id}`, [mod.id]),
    )).toContain(`write_annotation({ "nodeId": "${mod.id}", "annotation": { "summary": "redacted summary without secret values" } })`);

    const calls = refactoringNextCalls(
      state.graph,
      finding('duplicate-like', 'duplicate-like:orders', [mod.id], {
        annotationContext: {
          question: 'same-concept',
          relevantFields: ['summary', 'risks'],
          nodes: [{
            id: mod.id,
            label: 'page',
            annotation: { summary: 'Orders page.' },
            annotationContentFresh: true,
          }],
          hint: 'Compare annotations.',
        },
      }),
    );
    expect(calls[0]).toBe(
      'READ finding.annotationContext.nodes[].annotation.{summary, risks} '
      + 'and answer "same-concept". '
      + 'If annotations are stale or missing, call inspect_node on the listed nodes. '
      + 'Then suppress, confirm, or boost this finding when reporting to the user.',
    );
  });
});
