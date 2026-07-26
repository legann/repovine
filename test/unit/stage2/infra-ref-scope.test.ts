import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../../src/stage2/index.js';
import type { GraphEdge, ModuleInfo, RepositoryGraph } from '../../../src/types.js';

function hasEdge(graph: RepositoryGraph, from: string, to: string, kind: GraphEdge['kind']): boolean {
  return (graph.outEdges.get(from) ?? []).some(e => e.to === to && e.kind === kind);
}

function unresolvedRefs(graph: RepositoryGraph, serviceId: string): Array<Record<string, unknown>> {
  const node = graph.nodes.get(serviceId);
  return node?.type === 'runtime-resource' ? (node.data?.unresolvedRefs ?? []) as unknown as Array<Record<string, unknown>> : [];
}

async function buildGraph(repoRoot: string): Promise<RepositoryGraph> {
  const snapshot = await collectRepositoryFactsAsync(repoRoot);
  const modulesById = new Map<string, ModuleInfo>(snapshot.modules.map(m => [m.id, m]));
  return composeRepositoryGraph(snapshot, modulesById);
}

/** Minimal TS project so infra discovery runs. */
function seedTsProject(root: string): void {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'tmp', version: '1.0.0' }));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
    include: ['src/**/*.ts'],
  }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const ok = true;\n');
}

describe('infra logical-id resolution is scoped to the declaring document', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-infra-scope-'));
    seedTsProject(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('binds a Kubernetes reference inside its own namespace, not to the same name in another', async () => {
    fs.mkdirSync(path.join(tmpDir, 'manifests'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'manifests', 'blue.yaml'), `
apiVersion: v1
kind: Secret
metadata:
  name: app-secrets
  namespace: blue
stringData:
  TOKEN: blue-token
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: blue
spec:
  template:
    spec:
      containers:
        - name: api
          image: demo/api:1
          envFrom:
            - secretRef:
                name: app-secrets
`);
    fs.writeFileSync(path.join(tmpDir, 'manifests', 'green.yaml'), `
apiVersion: v1
kind: Secret
metadata:
  name: app-secrets
  namespace: green
stringData:
  TOKEN: green-token
`);

    const graph = await buildGraph(tmpDir);
    const blueDeployment = 'resource:k8s:blue/Deployment/api';
    const blueSecret = 'resource:k8s:blue/Secret/app-secrets';
    const greenSecret = 'resource:k8s:green/Secret/app-secrets';

    expect(graph.nodes.has(blueDeployment)).toBe(true);
    expect(graph.nodes.has(greenSecret)).toBe(true);
    expect(hasEdge(graph, blueDeployment, blueSecret, 'uses_env')).toBe(true);
    expect(hasEdge(graph, blueDeployment, greenSecret, 'uses_env')).toBe(false);
  });

  it('emits no edge and reports a gap when a Kubernetes reference has no target in its namespace', async () => {
    fs.mkdirSync(path.join(tmpDir, 'manifests'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'manifests', 'blue.yaml'), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: blue
spec:
  template:
    spec:
      containers:
        - name: api
          image: demo/api:1
          envFrom:
            - secretRef:
                name: app-secrets
`);
    fs.writeFileSync(path.join(tmpDir, 'manifests', 'green.yaml'), `
apiVersion: v1
kind: Secret
metadata:
  name: app-secrets
  namespace: green
stringData:
  TOKEN: green-token
`);

    const graph = await buildGraph(tmpDir);
    const blueDeployment = 'resource:k8s:blue/Deployment/api';

    expect(hasEdge(graph, blueDeployment, 'resource:k8s:green/Secret/app-secrets', 'uses_env')).toBe(false);
    expect(unresolvedRefs(graph, blueDeployment)).toEqual([
      {
        logicalId: 'app-secrets',
        envVar: expect.any(String),
        reason: 'out-of-scope',
        candidates: ['resource:k8s:green/Secret/app-secrets'],
      },
    ]);
  });

  it('binds a SAM reference to the queue its own template declares', async () => {
    fs.writeFileSync(path.join(tmpDir, 'orders.yaml'), `
Transform: AWS::Serverless-2016-10-31
Resources:
  Jobs:
    Type: AWS::SQS::Queue
  OrdersWorker:
    Type: AWS::Serverless::Function
    Properties:
      Handler: orders.handler
      Environment:
        Variables:
          QUEUE_URL: !Ref Jobs
`);
    fs.writeFileSync(path.join(tmpDir, 'billing.yaml'), `
Transform: AWS::Serverless-2016-10-31
Resources:
  Jobs:
    Type: AWS::SNS::Topic
  BillingWorker:
    Type: AWS::Serverless::Function
    Properties:
      Handler: billing.handler
      Environment:
        Variables:
          TOPIC_ARN: !Ref Jobs
`);

    const graph = await buildGraph(tmpDir);

    expect(hasEdge(graph, 'resource:aws-lambda:OrdersWorker', 'resource:aws-sqs:Jobs', 'uses_env')).toBe(true);
    expect(hasEdge(graph, 'resource:aws-lambda:OrdersWorker', 'resource:aws-sns:Jobs', 'uses_env')).toBe(false);
    expect(hasEdge(graph, 'resource:aws-lambda:BillingWorker', 'resource:aws-sns:Jobs', 'uses_env')).toBe(true);
    expect(hasEdge(graph, 'resource:aws-lambda:BillingWorker', 'resource:aws-sqs:Jobs', 'uses_env')).toBe(false);
  });

  it('reports a gap instead of picking one of two same-named resources from a third template', async () => {
    fs.writeFileSync(path.join(tmpDir, 'blue.yaml'), `
Transform: AWS::Serverless-2016-10-31
Resources:
  LedgerTable:
    Type: AWS::DynamoDB::Table
`);
    fs.writeFileSync(path.join(tmpDir, 'green.yaml'), `
Transform: AWS::Serverless-2016-10-31
Resources:
  LedgerTable:
    Type: AWS::S3::Bucket
`);
    fs.writeFileSync(path.join(tmpDir, 'worker.yaml'), `
Transform: AWS::Serverless-2016-10-31
Resources:
  Worker:
    Type: AWS::Serverless::Function
    Properties:
      Handler: worker.handler
      Environment:
        Variables:
          LEDGER: LedgerTableName
`);

    const graph = await buildGraph(tmpDir);
    const worker = 'resource:aws-lambda:Worker';

    expect(graph.nodes.has('resource:aws-dynamodb:LedgerTable')).toBe(true);
    expect(graph.nodes.has('resource:aws-s3:LedgerTable')).toBe(true);
    expect(hasEdge(graph, worker, 'resource:aws-dynamodb:LedgerTable', 'uses_env')).toBe(false);
    expect(hasEdge(graph, worker, 'resource:aws-s3:LedgerTable', 'uses_env')).toBe(false);
    expect(unresolvedRefs(graph, worker)).toEqual([
      {
        logicalId: 'LedgerTableName',
        envVar: 'LEDGER',
        reason: 'ambiguous',
        candidates: ['resource:aws-dynamodb:LedgerTable', 'resource:aws-s3:LedgerTable'],
      },
    ]);
  });

  it('stays ambiguous when the reference is scanned between the two colliding declarations', async () => {
    // File names order the scan: the reference sits between the declarations, so at the moment it
    // is read only one candidate exists. Resolving inline would take the repo-wide-unique branch
    // and emit an edge while also recording the ref as ambiguous — one answer contradicting itself.
    fs.writeFileSync(path.join(tmpDir, 'b-blue.yaml'), `
Transform: AWS::Serverless-2016-10-31
Resources:
  LedgerTable:
    Type: AWS::DynamoDB::Table
`);
    fs.writeFileSync(path.join(tmpDir, 'c-worker.yaml'), `
Transform: AWS::Serverless-2016-10-31
Resources:
  Worker:
    Type: AWS::Serverless::Function
    Properties:
      Handler: worker.handler
      Environment:
        Variables:
          LEDGER: LedgerTableName
`);
    fs.writeFileSync(path.join(tmpDir, 'd-green.yaml'), `
Transform: AWS::Serverless-2016-10-31
Resources:
  LedgerTable:
    Type: AWS::S3::Bucket
`);

    const graph = await buildGraph(tmpDir);
    const worker = 'resource:aws-lambda:Worker';

    expect(hasEdge(graph, worker, 'resource:aws-dynamodb:LedgerTable', 'uses_env')).toBe(false);
    expect(hasEdge(graph, worker, 'resource:aws-s3:LedgerTable', 'uses_env')).toBe(false);
    expect(unresolvedRefs(graph, worker)).toEqual([
      {
        logicalId: 'LedgerTableName',
        envVar: 'LEDGER',
        reason: 'ambiguous',
        candidates: ['resource:aws-dynamodb:LedgerTable', 'resource:aws-s3:LedgerTable'],
      },
    ]);
  });

  it('keeps cross-template resolution when only one resource carries the id', async () => {
    fs.writeFileSync(path.join(tmpDir, 'data.yaml'), `
Transform: AWS::Serverless-2016-10-31
Resources:
  OrdersTable:
    Type: AWS::DynamoDB::Table
`);
    fs.writeFileSync(path.join(tmpDir, 'compute.yaml'), `
Transform: AWS::Serverless-2016-10-31
Resources:
  Worker:
    Type: AWS::Serverless::Function
    Properties:
      Handler: worker.handler
      Environment:
        Variables:
          TABLE: OrdersTableName
`);

    const graph = await buildGraph(tmpDir);

    // The `TableName` -> `Table` alias is what nested stacks rely on; scope must not break it.
    expect(hasEdge(graph, 'resource:aws-lambda:Worker', 'resource:aws-dynamodb:OrdersTable', 'uses_env')).toBe(true);
  });

  it('resolves the same way whichever template the scan reaches first', async () => {
    const write = (dir: string): void => {
      fs.writeFileSync(path.join(dir, 'a-orders.yaml'), `
Transform: AWS::Serverless-2016-10-31
Resources:
  Jobs:
    Type: AWS::SQS::Queue
  OrdersWorker:
    Type: AWS::Serverless::Function
    Properties:
      Handler: orders.handler
      Environment:
        Variables:
          QUEUE_URL: !Ref Jobs
`);
      fs.writeFileSync(path.join(dir, 'z-billing.yaml'), `
Transform: AWS::Serverless-2016-10-31
Resources:
  Jobs:
    Type: AWS::SNS::Topic
  BillingWorker:
    Type: AWS::Serverless::Function
    Properties:
      Handler: billing.handler
      Environment:
        Variables:
          TOPIC_ARN: !Ref Jobs
`);
    };

    write(tmpDir);
    const graph = await buildGraph(tmpDir);

    // Renaming the files swaps scan order; the bindings must not follow it.
    fs.renameSync(path.join(tmpDir, 'a-orders.yaml'), path.join(tmpDir, 'zz-orders.yaml'));
    fs.renameSync(path.join(tmpDir, 'z-billing.yaml'), path.join(tmpDir, 'aa-billing.yaml'));
    const swapped = await buildGraph(tmpDir);

    for (const g of [graph, swapped]) {
      expect(hasEdge(g, 'resource:aws-lambda:OrdersWorker', 'resource:aws-sqs:Jobs', 'uses_env')).toBe(true);
      expect(hasEdge(g, 'resource:aws-lambda:BillingWorker', 'resource:aws-sns:Jobs', 'uses_env')).toBe(true);
    }
  });
});
