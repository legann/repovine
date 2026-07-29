import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { composeRepositoryGraph } from '../../../src/stage2/index.js';
import type { ModuleInfo, RepositoryFactsSnapshot } from '../../../src/types.js';

function makeModule(partial?: Partial<ModuleInfo>): ModuleInfo {
  return {
    id: 'mod:@acme/api/src/handlers/user',
    packageName: '@acme/api',
    filePath: '/repo/apps/api/src/handlers/user.ts',
    relativeFilePath: 'src/handlers/user.ts',
    contentHash: 'm1',
    imports: [],
    exports: [],
    // Stage 1 stamps every module with its owning source plugin; honor that invariant here so
    // handler resolution identifies ownership by id (no language-identity fallback in core).
    sourcePluginId: 'typescript',
    ...partial,
  };
}

describe('Lambda handler resolver', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-resolver-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves handlers through CodeUri and creates publish data-flow edges', () => {
    const mod = makeModule({
      semanticHints: {
        envVars: ['USER_QUEUE_URL'],
        runtimeActions: [{ action: 'sqs.sendMessage', envVar: 'USER_QUEUE_URL' }],
      },
    });
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: tmpDir,
      timestamp: new Date(0).toISOString(),
      packages: [{ name: '@acme/api', path: 'apps/api'}],
      modules: [mod],
      infraModules: [{
        id: 'infra:aws-sam:infra/template.yaml',
        kind: 'aws-sam',
        filePath: path.join(tmpDir, 'infra/template.yaml'),
        relativeFilePath: 'infra/template.yaml',
        contentHash: 'i1',
        resources: [
          {
            id: 'UserQueue',
            kind: 'queue',
            provider: 'aws',
            identity: { namespace: 'aws-sqs', localKey: 'UserQueue' },
            contentHash: 'q1',
            attributes: {},
          },
          {
            id: 'UserFunction',
            kind: 'lambda',
            provider: 'aws',
            identity: { namespace: 'aws-lambda', localKey: 'UserFunction' },
            contentHash: 'f1',
            attributes: { handler: 'handlers/user.main', codeUri: 'apps/api/src' },
            envRefs: [{ varName: 'USER_QUEUE_URL', refType: 'ref', targetLogicalId: 'UserQueue' }],
          },
        ],
      }],
    };

    const graph = composeRepositoryGraph(snapshot, new Map([[mod.id, mod]]));
    expect(graph.outEdges.get('resource:aws-lambda:UserFunction')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'infra', to: mod.id }),
        expect.objectContaining({ kind: 'publishes', to: 'resource:aws-sqs:UserQueue' }),
      ]),
    );
  });

  it('follows imported modules when linking runtime publishes', () => {
    const handler = makeModule({
      imports: [{
        moduleSpecifier: '@acme/shared/metrics',
        resolvedModuleId: 'mod:@acme/shared/src/metrics',
        importedNames: ['recordMetric'],
        isTypeOnly: false,
        isExternal: false,
      }],
    });
    const shared = makeModule({
      id: 'mod:@acme/shared/src/metrics',
      packageName: '@acme/shared',
      filePath: '/repo/packages/shared/src/metrics.ts',
      relativeFilePath: 'src/metrics.ts',
      semanticHints: { runtimeActions: [{ action: 'sqs.sendMessage', envVar: 'USER_QUEUE_URL' }] },
    });
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: tmpDir,
      timestamp: new Date(0).toISOString(),
      packages: [
        { name: '@acme/api', path: 'apps/api'},
        { name: '@acme/shared', path: 'packages/shared'},
      ],
      modules: [handler, shared],
      infraModules: [{
        id: 'infra:aws-sam:infra/template.yaml',
        kind: 'aws-sam',
        filePath: path.join(tmpDir, 'infra/template.yaml'),
        relativeFilePath: 'infra/template.yaml',
        contentHash: 'i1',
        resources: [
          {
            id: 'UserQueue',
            kind: 'queue',
            provider: 'aws',
            identity: { namespace: 'aws-sqs', localKey: 'UserQueue' },
            contentHash: 'q1',
            attributes: {},
          },
          {
            id: 'UserFunction',
            kind: 'lambda',
            provider: 'aws',
            identity: { namespace: 'aws-lambda', localKey: 'UserFunction' },
            contentHash: 'f1',
            attributes: { handler: 'handlers/user.main', codeUri: 'apps/api/src' },
            envRefs: [{ varName: 'USER_QUEUE_URL', refType: 'ref', targetLogicalId: 'UserQueue' }],
          },
        ],
      }],
    };

    const graph = composeRepositoryGraph(snapshot, new Map([[handler.id, handler], [shared.id, shared]]));
    expect(graph.outEdges.get('resource:aws-lambda:UserFunction')).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'publishes', to: 'resource:aws-sqs:UserQueue' })]),
    );
  });

  it('resolves resource suffix aliases for runtime publishes', () => {
    const mod = makeModule({
      semanticHints: { runtimeActions: [{ action: 'sqs.sendMessage', envVar: 'WEBHOOK_QUEUE_URL' }] },
    });
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: tmpDir,
      timestamp: new Date(0).toISOString(),
      packages: [{ name: '@acme/api', path: 'apps/api'}],
      modules: [mod],
      infraModules: [{
        id: 'infra:aws-sam:infra/template.yaml',
        kind: 'aws-sam',
        filePath: path.join(tmpDir, 'infra/template.yaml'),
        relativeFilePath: 'infra/template.yaml',
        contentHash: 'i1',
        resources: [
          {
            id: 'WebhookQueue',
            kind: 'queue',
            provider: 'aws',
            identity: { namespace: 'aws-sqs', localKey: 'WebhookQueue' },
            contentHash: 'q1',
            attributes: {},
          },
          {
            id: 'UserFunction',
            kind: 'lambda',
            provider: 'aws',
            identity: { namespace: 'aws-lambda', localKey: 'UserFunction' },
            contentHash: 'f1',
            attributes: { handler: 'handlers/user.main', codeUri: 'apps/api/src' },
            envRefs: [{ varName: 'WEBHOOK_QUEUE_URL', refType: 'ref', targetLogicalId: 'WebhookQueueUrl' }],
          },
        ],
      }],
    };

    const graph = composeRepositoryGraph(snapshot, new Map([[mod.id, mod]]));
    expect(graph.outEdges.get('resource:aws-lambda:UserFunction')).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'publishes', to: 'resource:aws-sqs:WebhookQueue' })]),
    );
  });

  it('resolves handlers from configured runtime handler roots', () => {
    const mod = makeModule();
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: tmpDir,
      timestamp: new Date(0).toISOString(),
      packages: [{ name: '@acme/api', path: 'apps/api'}],
      modules: [mod],
      linkingConfig: { handlers: { searchRoots: ['apps/api/src'] } },
      infraModules: [{
        id: 'infra:aws-sam:template.yaml',
        kind: 'aws-sam',
        filePath: path.join(tmpDir, 'template.yaml'),
        relativeFilePath: 'template.yaml',
        contentHash: 'i1',
        resources: [{
          id: 'UserFunction',
          kind: 'lambda',
          provider: 'aws',
          identity: { namespace: 'aws-lambda', localKey: 'UserFunction' },
          contentHash: 'f1',
          attributes: { handler: 'handlers/user.main' },
        }],
      }],
    };

    const graph = composeRepositoryGraph(snapshot, new Map([[mod.id, mod]]));
    expect(graph.outEdges.get('resource:aws-lambda:UserFunction')).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'infra', to: mod.id })]),
    );
  });

  it('does not link a broken handler reference to an unrelated module', () => {
    const mod = makeModule();
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: tmpDir,
      timestamp: new Date(0).toISOString(),
      packages: [{ name: '@acme/api', path: 'apps/api'}],
      modules: [mod],
      infraModules: [{
        id: 'infra:aws-sam:template.yaml',
        kind: 'aws-sam',
        filePath: path.join(tmpDir, 'template.yaml'),
        relativeFilePath: 'template.yaml',
        contentHash: 'i1',
        resources: [{
          id: 'BrokenFunction',
          kind: 'lambda',
          provider: 'aws',
          identity: { namespace: 'aws-lambda', localKey: 'BrokenFunction' },
          contentHash: 'f1',
          attributes: { handler: 'handlers/missing.main', codeUri: 'apps/api/src' },
        }],
      }],
    };

    const graph = composeRepositoryGraph(snapshot, new Map([[mod.id, mod]]));
    const out = graph.outEdges.get('resource:aws-lambda:BrokenFunction') ?? [];
    expect(graph.nodes.get('resource:aws-lambda:BrokenFunction')).toBeDefined();
    expect(out.some(edge => edge.kind === 'infra' && edge.to.startsWith('mod:'))).toBe(false);
  });
});
