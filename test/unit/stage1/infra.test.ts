import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileScanPatterns } from '../../../src/scan-filters.js';
import { collectInfraModules } from '../../../src/stage1/infra.js';

describe('collectInfraModules', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('merges Kubernetes resources from multi-document YAML', () => {
    fs.writeFileSync(path.join(tmpDir, 'k8s.yaml'), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
---
apiVersion: v1
kind: Service
metadata:
  name: api
---
apiVersion: v1
kind: Secret
metadata:
  name: api-secret
`);

    const modules = collectInfraModules({ repoRoot: tmpDir, packages: [] });
    const k8s = modules.find(m => m.kind === 'kubernetes');
    expect(k8s?.resources.map(r => r.kind).sort()).toEqual(['k8s-deployment', 'k8s-service', 'secret']);
  });

  it('captures SAM CodeUri on Lambda resources', () => {
    fs.writeFileSync(path.join(tmpDir, 'template.yaml'), `
Transform: AWS::Serverless-2016-10-31
Resources:
  UserFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: apps/api/src
      Handler: handlers/user.main
`);

    const modules = collectInfraModules({ repoRoot: tmpDir, packages: [] });
    const fn = modules.flatMap(m => m.resources).find(r => r.id === 'UserFunction');
    expect(fn?.attributes).toMatchObject({ codeUri: 'apps/api/src', handler: 'handlers/user.main' });
  });

  it('synthesizes external SAM secret resources from secret parameters and dynamic refs', () => {
    fs.writeFileSync(path.join(tmpDir, 'template.yaml'), `
Transform: AWS::Serverless-2016-10-31
Parameters:
  GoogleSecretsArn:
    Type: String
  TokenParameter:
    Type: AWS::SSM::Parameter::Value<SecureString>
Resources:
  UserFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: handlers/user.main
      Environment:
        Variables:
          GOOGLE_SECRETS_ARN: !If [UseGoogleSecretsManager, !Ref GoogleSecretsArn, '']
          GOOGLE_CLIENT_SECRET: !Sub '{{resolve:secretsmanager:\${GoogleSecretsArn}:SecretString:GOOGLE_CLIENT_SECRET}}'
          TOKEN_FROM_PARAMETER: !Ref TokenParameter
          SSM_TOKEN: '{{resolve:ssm-secure:/demo/token:1}}'
`);

    const modules = collectInfraModules({ repoRoot: tmpDir, packages: [] });
    const resources = modules.flatMap(m => m.resources);
    const byId = Object.fromEntries(resources.map(r => [r.id, r]));
    const fn = byId.UserFunction;

    expect(byId['secret:GoogleSecretsArn']).toMatchObject({
      kind: 'secret',
      provider: 'aws',
      attributes: { external: 'true', source: 'param', parameterName: 'GoogleSecretsArn' },
    });
    expect(byId['secret:TokenParameter']).toMatchObject({
      kind: 'secret',
      provider: 'aws',
      attributes: { external: 'true', source: 'param', parameterName: 'TokenParameter' },
    });
    expect(byId['secret:/demo/token']).toMatchObject({
      kind: 'secret',
      provider: 'aws',
      attributes: { external: 'true', source: 'ssm-secure' },
    });
    expect(fn?.envRefs).toEqual(expect.arrayContaining([
      { varName: 'GOOGLE_SECRETS_ARN', refType: 'ref', targetLogicalId: 'secret:GoogleSecretsArn' },
      { varName: 'GOOGLE_CLIENT_SECRET', refType: 'sub', targetLogicalId: 'secret:GoogleSecretsArn' },
      { varName: 'TOKEN_FROM_PARAMETER', refType: 'ref', targetLogicalId: 'secret:TokenParameter' },
      { varName: 'SSM_TOKEN', refType: 'sub', targetLogicalId: 'secret:/demo/token' },
    ]));
  });

  it('classifies Terraform secrets and extracts Lambda env interpolations', () => {
    fs.writeFileSync(path.join(tmpDir, 'main.tf'), `
resource "aws_lambda_function" "api" {
  function_name = "api"
  handler       = "api.handler"
  role          = aws_iam_role.api_role.arn
  environment {
    variables = {
      USERS_TABLE   = aws_dynamodb_table.users.name
      DB_SECRET_ARN = aws_secretsmanager_secret.db_password.arn
      API_KEY_PARAM = aws_ssm_parameter.api_key.name
      LOG_LEVEL     = "info"
    }
  }
}

resource "aws_secretsmanager_secret" "db_password" {
  name = "app/db-password"
}

resource "aws_ssm_parameter" "api_key" {
  name = "/app/api-key"
  type = "SecureString"
}

resource "aws_ssm_parameter" "log_setting" {
  name = "/app/log-setting"
  type = "String"
}

resource "google_secret_manager_secret" "gcp_key" {
  secret_id = "gcp-api-key"
}
`);

    const modules = collectInfraModules({ repoRoot: tmpDir, packages: [] });
    const byId = Object.fromEntries(modules.flatMap(m => m.resources).map(r => [r.id, r]));

    // Pattern A: declared secrets classified by kind across providers; SecureString gates SSM.
    expect(byId.db_password).toMatchObject({ kind: 'secret', provider: 'terraform' });
    expect(byId.api_key).toMatchObject({ kind: 'secret', provider: 'terraform' });
    expect(byId.gcp_key).toMatchObject({ kind: 'secret', provider: 'terraform' });
    expect(byId.log_setting.kind).toBe('other');

    // Pattern B: env-map interpolations become envRefs targeting the referenced node's logical name.
    // The role attribute (outside the env map) and the plain string literal are not refs.
    expect(byId.api.envRefs).toEqual([
      { varName: 'USERS_TABLE', refType: 'getatt', targetLogicalId: 'users' },
      { varName: 'DB_SECRET_ARN', refType: 'getatt', targetLogicalId: 'db_password' },
      { varName: 'API_KEY_PARAM', refType: 'getatt', targetLogicalId: 'api_key' },
    ]);
    expect(byId.api.envVars).toEqual(['USERS_TABLE', 'DB_SECRET_ARN', 'API_KEY_PARAM', 'LOG_LEVEL']);
  });

  it('models docker-compose secrets and service consumption (secrets/_FILE/env_file)', () => {
    fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), `
secrets:
  db_password:
    file: ./secrets/db.txt
  api_token:
    external: true
services:
  api:
    image: demo/api
    secrets:
      - db_password
      - source: api_token
        target: api_token
    environment:
      DB_PASSWORD_FILE: /run/secrets/db_password
    env_file:
      - .env.production
`);

    const modules = collectInfraModules({ repoRoot: tmpDir, packages: [] });
    const byId = Object.fromEntries(modules.flatMap(m => m.resources).map(r => [r.id, r]));

    expect(byId.db_password).toMatchObject({
      kind: 'secret', provider: 'generic', attributes: { source: 'compose-secret', file: './secrets/db.txt' },
    });
    expect(byId.api_token).toMatchObject({ kind: 'secret', attributes: { external: 'true' } });
    expect(byId['secret:.env.production']).toMatchObject({
      kind: 'secret', attributes: { external: 'true', source: 'env_file' },
    });
    expect(byId.api.envRefs).toEqual(expect.arrayContaining([
      { varName: 'secret:db_password', refType: 'literal', targetLogicalId: 'db_password' },
      { varName: 'secret:api_token', refType: 'literal', targetLogicalId: 'api_token' },
      { varName: 'DB_PASSWORD_FILE', refType: 'literal', targetLogicalId: 'db_password' },
      { varName: 'env_file:.env.production', refType: 'literal', targetLogicalId: 'secret:.env.production' },
    ]));
  });

  it('synthesizes Vercel secrets from @-prefixed env references (best-effort)', () => {
    fs.writeFileSync(path.join(tmpDir, 'vercel.json'), JSON.stringify({
      version: 2,
      env: { DATABASE_URL: '@database-url', PLAIN: 'literal-value' },
      build: { env: { BUILD_TOKEN: '@build-token' } },
    }));

    const modules = collectInfraModules({ repoRoot: tmpDir, packages: [] });
    const byId = Object.fromEntries(modules.flatMap(m => m.resources).map(r => [r.id, r]));

    expect(byId['secret:database-url']).toMatchObject({
      kind: 'secret', provider: 'vercel',
      attributes: { external: 'true', source: 'vercel-secret', secretName: 'database-url' },
    });
    expect(byId['secret:build-token']).toMatchObject({ kind: 'secret', provider: 'vercel' });
    expect(byId.project.envRefs).toEqual(expect.arrayContaining([
      { varName: 'DATABASE_URL', refType: 'ref', targetLogicalId: 'secret:database-url' },
      { varName: 'BUILD_TOKEN', refType: 'ref', targetLogicalId: 'secret:build-token' },
    ]));
    // A plain literal env value is not a secret reference.
    expect(byId.project.envRefs?.some((r: { varName: string }) => r.varName === 'PLAIN')).toBe(false);
  });

  it('detects Helm secret references from explicit values keys (best-effort)', () => {
    fs.mkdirSync(path.join(tmpDir, 'helm'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'helm', 'values.yaml'), `
app:
  image:
    repository: demo/app
    tag: "1.0"
  existingSecret: app-db-credentials
`);

    const modules = collectInfraModules({ repoRoot: tmpDir, packages: [] });
    const byId = Object.fromEntries(modules.flatMap(m => m.resources).map(r => [r.id, r]));

    expect(byId['secret:app-db-credentials']).toMatchObject({
      kind: 'secret', provider: 'generic',
      attributes: { external: 'true', source: 'helm-values', secretName: 'app-db-credentials' },
    });
    // The co-located image consumes the secret (image → secret link).
    expect(byId.app.envRefs).toEqual([
      { varName: 'app.existingSecret', refType: 'literal', targetLogicalId: 'secret:app-db-credentials' },
    ]);
  });

  it('parses plain CloudFormation from a non-standard file name', () => {
    // Intentionally not "template.yaml" to ensure parser is content-based, not filename-based.
    fs.writeFileSync(path.join(tmpDir, 'sam.modules.yml'), `
Resources:
  UsersTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: users
      BillingMode: PAY_PER_REQUEST
  JobsQueue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: jobs
`);

    const modules = collectInfraModules({ repoRoot: tmpDir, packages: [] });
    const cfn = modules.find(m => m.kind === 'cloudformation');
    expect(cfn).toMatchObject({
      id: 'infra:cloudformation:sam.modules.yml',
      relativeFilePath: 'sam.modules.yml',
    });

    const byId = Object.fromEntries((cfn?.resources ?? []).map(r => [r.id, r]));
    expect(byId.UsersTable).toMatchObject({
      kind: 'table',
      provider: 'aws',
    });
    expect(byId.JobsQueue).toMatchObject({
      kind: 'queue',
      provider: 'aws',
    });
  });

  it('honors repo-root path fragment excludes for infra files', () => {
    const ignoredDir = path.join(tmpDir, 'vendor', 'fixture-app', 'infra');
    const keptDir = path.join(tmpDir, 'apps', 'api', 'infra');
    fs.mkdirSync(ignoredDir, { recursive: true });
    fs.mkdirSync(keptDir, { recursive: true });
    const template = `
Transform: AWS::Serverless-2016-10-31
Resources:
  UserFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: users.handler
`;
    fs.writeFileSync(path.join(ignoredDir, 'template.yaml'), template.replace('UserFunction', 'IgnoredFunction'));
    fs.writeFileSync(path.join(keptDir, 'template.yaml'), template.replace('UserFunction', 'KeptFunction'));

    const modules = collectInfraModules({
      repoRoot: tmpDir,
      packages: [],
      scanPatterns: compileScanPatterns([], ['vendor/fixture-app/**']),
    });
    const resourceIds = modules.flatMap(m => m.resources.map(r => r.id));
    expect(resourceIds).toContain('KeptFunction');
    expect(resourceIds).not.toContain('IgnoredFunction');
  });

  it('parses Vercel project config into functions, crons, and route resources', () => {
    fs.writeFileSync(path.join(tmpDir, 'vercel.json'), JSON.stringify({
      version: 2,
      framework: 'nextjs',
      env: {
        API_TOKEN: '@api-token',
        NEXT_PUBLIC_SITE_URL: 'https://example.com',
      },
      functions: {
        'app/api/users/route.ts': {
          runtime: 'nodejs20.x',
          maxDuration: 10,
          memory: 1024,
          regions: ['iad1'],
        },
      },
      crons: [
        { path: '/api/users', schedule: '0 5 * * *' },
      ],
      rewrites: [
        { source: '/legacy-users', destination: '/api/users' },
      ],
    }, null, 2));

    const modules = collectInfraModules({ repoRoot: tmpDir, packages: [] });
    const vercel = modules.find(m => m.kind === 'vercel');
    expect(vercel).toMatchObject({
      id: 'infra:vercel:vercel.json',
      relativeFilePath: 'vercel.json',
    });

    const byId = Object.fromEntries((vercel?.resources ?? []).map(r => [r.id, r]));
    expect(byId.project).toMatchObject({
      kind: 'other',
      provider: 'vercel',
      attributes: { version: '2', framework: 'nextjs' },
      envVars: ['API_TOKEN', 'NEXT_PUBLIC_SITE_URL'],
    });
    expect(byId['function:app/api/users/route.ts']).toMatchObject({
      kind: 'vercel-function',
      provider: 'vercel',
      attributes: {
        handler: 'app/api/users/route.ts',
        runtime: 'nodejs20.x',
        maxDuration: '10',
        memory: '1024',
        regions: 'iad1',
      },
    });
    expect(byId['cron:/api/users']).toMatchObject({
      kind: 'vercel-cron',
      provider: 'vercel',
      attributes: { path: '/api/users', schedule: '0 5 * * *' },
      triggers: [expect.objectContaining({ type: 'schedule', path: '/api/users', schedule: '0 5 * * *' })],
    });
    expect(byId['rewrite:/legacy-users']).toMatchObject({
      kind: 'vercel-route',
      provider: 'vercel',
      attributes: { type: 'rewrite', source: '/legacy-users', destination: '/api/users' },
    });
  });

  it('derives a schedule trigger from a standalone AWS::Events::Rule targeting a Lambda', () => {
    fs.writeFileSync(path.join(tmpDir, 'template.yaml'), `
Transform: AWS::Serverless-2016-10-31
Resources:
  PollerFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: poller.handler
  PollerScheduleRule:
    Type: AWS::Events::Rule
    Properties:
      ScheduleExpression: rate(1 minute)
      State: ENABLED
      Targets:
        - Arn: !GetAtt PollerFunction.Arn
          Id: PollerTarget
`);

    const modules = collectInfraModules({ repoRoot: tmpDir, packages: [] });
    const fn = modules.flatMap(m => m.resources).find(r => r.id === 'PollerFunction');
    expect(fn?.triggers).toEqual([
      expect.objectContaining({
        type: 'schedule',
        name: 'PollerTarget',
        schedule: 'rate(1 minute)',
        queueRef: 'PollerScheduleRule',
      }),
    ]);
  });

  it('derives an event-bus trigger from an AWS::Events::Rule with EventPattern', () => {
    fs.writeFileSync(path.join(tmpDir, 'template.yaml'), `
Transform: AWS::Serverless-2016-10-31
Resources:
  AlarmHandlerFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: alarm.handler
  AlarmRule:
    Type: AWS::Events::Rule
    Properties:
      EventPattern:
        source:
          - aws.cloudwatch
      Targets:
        - Arn: !GetAtt AlarmHandlerFunction.Arn
          Id: AlarmTarget
`);

    const modules = collectInfraModules({ repoRoot: tmpDir, packages: [] });
    const fn = modules.flatMap(m => m.resources).find(r => r.id === 'AlarmHandlerFunction');
    expect(fn?.triggers).toEqual([
      expect.objectContaining({ type: 'event-bus', name: 'AlarmTarget', queueRef: 'AlarmRule' }),
    ]);
  });

  it('derives an sqs trigger from a standalone AWS::Lambda::EventSourceMapping', () => {
    fs.writeFileSync(path.join(tmpDir, 'template.yaml'), `
Transform: AWS::Serverless-2016-10-31
Resources:
  WorkQueue:
    Type: AWS::SQS::Queue
  WorkerFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: worker.handler
  WorkerSourceMapping:
    Type: AWS::Lambda::EventSourceMapping
    Properties:
      EventSourceArn: !GetAtt WorkQueue.Arn
      FunctionName: !Ref WorkerFunction
      BatchSize: 10
`);

    const modules = collectInfraModules({ repoRoot: tmpDir, packages: [] });
    const fn = modules.flatMap(m => m.resources).find(r => r.id === 'WorkerFunction');
    expect(fn?.triggers).toEqual([
      expect.objectContaining({ type: 'sqs', name: 'WorkerSourceMapping', queueRef: 'WorkQueue' }),
    ]);
  });

  it('derives a dynamodb-stream trigger from an EventSourceMapping pointing at a DDB table', () => {
    fs.writeFileSync(path.join(tmpDir, 'template.yaml'), `
Transform: AWS::Serverless-2016-10-31
Resources:
  EventsTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: events
  EventsStreamConsumer:
    Type: AWS::Serverless::Function
    Properties:
      Handler: events.handler
  EventsStreamMapping:
    Type: AWS::Lambda::EventSourceMapping
    Properties:
      EventSourceArn: !GetAtt EventsTable.StreamArn
      FunctionName: !Ref EventsStreamConsumer
      StartingPosition: LATEST
`);

    const modules = collectInfraModules({ repoRoot: tmpDir, packages: [] });
    const fn = modules.flatMap(m => m.resources).find(r => r.id === 'EventsStreamConsumer');
    expect(fn?.triggers).toEqual([
      expect.objectContaining({ type: 'dynamodb-stream', queueRef: 'EventsTable' }),
    ]);
  });

  it('derives websocket triggers by following ApiGatewayV2 Route -> Integration -> Lambda', () => {
    fs.writeFileSync(path.join(tmpDir, 'template.yaml'), `
Transform: AWS::Serverless-2016-10-31
Resources:
  WsApi:
    Type: AWS::ApiGatewayV2::Api
    Properties:
      Name: WsApi
      ProtocolType: WEBSOCKET
      RouteSelectionExpression: $request.body.action
  WsFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: ws.handler
  WsConnectIntegration:
    Type: AWS::ApiGatewayV2::Integration
    Properties:
      ApiId: !Ref WsApi
      IntegrationType: AWS_PROXY
      IntegrationUri: !Sub 'arn:aws:apigateway:\${AWS::Region}:lambda:path/2015-03-31/functions/\${WsFunction.Arn}/invocations'
  WsConnectRoute:
    Type: AWS::ApiGatewayV2::Route
    Properties:
      ApiId: !Ref WsApi
      RouteKey: $connect
      Target: !Sub 'integrations/\${WsConnectIntegration}'
  WsDefaultRoute:
    Type: AWS::ApiGatewayV2::Route
    Properties:
      ApiId: !Ref WsApi
      RouteKey: $default
      Target: !Sub 'integrations/\${WsConnectIntegration}'
`);

    const modules = collectInfraModules({ repoRoot: tmpDir, packages: [] });
    const fn = modules.flatMap(m => m.resources).find(r => r.id === 'WsFunction');
    expect(fn?.triggers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'websocket', name: 'WsConnectRoute', path: '$connect', queueRef: 'WsApi',
      }),
      expect.objectContaining({
        type: 'websocket', name: 'WsDefaultRoute', path: '$default', queueRef: 'WsApi',
      }),
    ]));
  });

  it('parses SAM SSM secrets, dynamic refs, resource aliases, and IAM policy table refs', () => {
    fs.writeFileSync(path.join(tmpDir, 'template.yaml'), `
Transform: AWS::Serverless-2016-10-31
Parameters:
  ApiSecretName:
    Type: SecureString
    Default: /demo/api-token
  GoogleSecretsArn:
    Type: String
    Default: arn:aws:secretsmanager:us-east-1:123456789012:secret:google/oauth
Resources:
  PlainParameter:
    Type: AWS::SSM::Parameter
    Properties:
      Type: String
      Value: public
  SecureParameter:
    Type: AWS::SSM::Parameter
    Properties:
      Type: SecureString
      Value: secret
  DataTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: data
  TableAccessPolicy:
    Type: AWS::IAM::ManagedPolicy
    Properties:
      PolicyDocument:
        Statement:
          - Effect: Allow
            Action:
              - dynamodb:GetItem
            Resource: DataTable
  ApiFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: api.handler
      Environment:
        Variables:
          DYNAMIC_SECRET: '{{resolve:ssm-secure:/demo/token:1}}'
          PARAM_SECRET: !Ref ApiSecretName
          SUB_SECRET: !Sub '\${GoogleSecretsArn}'
          TABLE_NAME_ALIAS: DataTableName
      Policies:
        - DataTable
        - !Ref TableAccessPolicy
        - Statement:
            - Effect: Allow
              Action:
                - dynamodb:PutItem
              Resource: DataTable
`);

    const modules = collectInfraModules({ repoRoot: tmpDir, packages: [] });
    const resources = modules.flatMap(m => m.resources);
    const byId = Object.fromEntries(resources.map(r => [r.id, r]));
    const fn = byId.ApiFunction;

    expect(byId.PlainParameter).toMatchObject({ kind: 'other', provider: 'aws' });
    expect(byId.SecureParameter).toMatchObject({ kind: 'secret', provider: 'aws' });
    expect(byId['secret:/demo/token']).toMatchObject({
      kind: 'secret',
      provider: 'aws',
      attributes: { external: 'true', source: 'ssm-secure' },
    });
    expect(byId['secret:ApiSecretName']).toMatchObject({
      kind: 'secret',
      attributes: { source: 'param', parameterName: 'ApiSecretName', parameterType: 'SecureString' },
    });
    expect(byId['secret:GoogleSecretsArn']).toMatchObject({
      kind: 'secret',
      attributes: { source: 'param', parameterName: 'GoogleSecretsArn' },
    });
    expect(fn.envRefs).toEqual(expect.arrayContaining([
      { varName: 'DYNAMIC_SECRET', refType: 'sub', targetLogicalId: 'secret:/demo/token' },
      { varName: 'PARAM_SECRET', refType: 'ref', targetLogicalId: 'secret:ApiSecretName' },
      { varName: 'SUB_SECRET', refType: 'ref', targetLogicalId: 'secret:GoogleSecretsArn' },
      { varName: 'TABLE_NAME_ALIAS', refType: 'ref', targetLogicalId: 'DataTableName' },
      // GetItem from the managed policy plus PutItem from the inline statement.
      { varName: 'iamPolicy:DataTable', refType: 'ref', targetLogicalId: 'DataTable', access: 'read-write' },
    ]));
  });

  it('reads the access mode a Lambda grant declares instead of assuming read-write', () => {
    fs.writeFileSync(path.join(tmpDir, 'template.yaml'), `
Transform: AWS::Serverless-2016-10-31
Resources:
  ReadTable:
    Type: AWS::DynamoDB::Table
  WriteTable:
    Type: AWS::DynamoDB::Table
  CrudTable:
    Type: AWS::DynamoDB::Table
  OpaqueTable:
    Type: AWS::DynamoDB::Table
  ReaderFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: reader.handler
      Policies:
        - Statement:
            - Effect: Allow
              Action:
                - dynamodb:GetItem
                - dynamodb:Query
              Resource: !GetAtt ReadTable.Arn
        - Statement:
            - Effect: Allow
              Action: dynamodb:PutItem
              Resource: !GetAtt WriteTable.Arn
        - DynamoDBCrudPolicy:
            TableName: !Ref CrudTable
        - SomeUnknownShape:
            Target: !Ref OpaqueTable
`);

    const modules = collectInfraModules({ repoRoot: tmpDir, packages: [] });
    const fn = modules.flatMap(m => m.resources).find(r => r.id === 'ReaderFunction');
    const accessByTarget = Object.fromEntries(
      (fn?.envRefs ?? []).map(ref => [ref.targetLogicalId, ref.access]),
    );

    expect(accessByTarget).toEqual({
      ReadTable: 'read',
      WriteTable: 'write',
      CrudTable: 'read-write',
      // Grant shape the parser cannot read: the binding stands, the verb stays unread.
      OpaqueTable: undefined,
    });
  });

  it('skips Deny statements and attaches the grant to an existing env-var ref', () => {
    fs.writeFileSync(path.join(tmpDir, 'template.yaml'), `
Transform: AWS::Serverless-2016-10-31
Resources:
  AuditTable:
    Type: AWS::DynamoDB::Table
  AuditFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: audit.handler
      Environment:
        Variables:
          AUDIT_TABLE: !Ref AuditTable
      Policies:
        - Statement:
            - Effect: Allow
              Action: dynamodb:Scan
              Resource: !GetAtt AuditTable.Arn
            - Effect: Deny
              Action: dynamodb:DeleteItem
              Resource: !GetAtt AuditTable.Arn
`);

    const modules = collectInfraModules({ repoRoot: tmpDir, packages: [] });
    const fn = modules.flatMap(m => m.resources).find(r => r.id === 'AuditFunction');

    // One ref, not two: the env var and the grant name the same table.
    expect(fn?.envRefs).toEqual([
      { varName: 'AUDIT_TABLE', refType: 'ref', targetLogicalId: 'AuditTable', access: 'read' },
    ]);
  });

  it('reads grants for every resource family the policy-template table advertises, not only DynamoDB', () => {
    fs.writeFileSync(path.join(tmpDir, 'template.yaml'), `
Transform: AWS::Serverless-2016-10-31
Resources:
  Uploads:
    Type: AWS::S3::Bucket
  Reports:
    Type: AWS::S3::Bucket
  Jobs:
    Type: AWS::SQS::Queue
  Events:
    Type: AWS::SNS::Topic
  DbSecret:
    Type: AWS::SecretsManager::Secret
  WorkerRole:
    Type: AWS::IAM::Role
  Worker:
    Type: AWS::Serverless::Function
    Properties:
      Handler: worker.handler
      Policies:
        - S3ReadPolicy:
            BucketName: !Ref Uploads
        - Statement:
            - Effect: Allow
              Action: s3:PutObject
              Resource: !GetAtt Reports.Arn
        - SQSPollerPolicy:
            QueueName: !Ref Jobs
        - SNSPublishMessagePolicy:
            TopicName: !Ref Events
        - SecretsManagerGetSecretValuePolicy:
            SecretArn: !Ref DbSecret
        - Statement:
            - Effect: Allow
              Action: sts:AssumeRole
              Resource: !GetAtt WorkerRole.Arn
`);

    const modules = collectInfraModules({ repoRoot: tmpDir, packages: [] });
    const fn = modules.flatMap(m => m.resources).find(r => r.id === 'Worker');
    const accessByTarget = Object.fromEntries(
      (fn?.envRefs ?? []).map(ref => [ref.targetLogicalId, ref.access]),
    );

    expect(accessByTarget).toEqual({
      Uploads: 'read',
      Reports: 'write',
      Jobs: 'read',
      Events: 'write',
      DbSecret: 'read',
      // A role is the subject of a grant, never its target, so it is not a bound resource.
    });
  });

  it('parses docker-compose services and resolves build dockerfile paths', () => {
    fs.mkdirSync(path.join(tmpDir, 'infrastructure', 'k8s-services', 'lmtify-worker'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'infrastructure', 'k8s-services', 'lmtify-operator'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'infrastructure', 'k8s-services', 'lmtify-worker', 'Dockerfile.dev'), 'FROM node:22-alpine\n');
    fs.writeFileSync(path.join(tmpDir, 'infrastructure', 'k8s-services', 'lmtify-operator', 'Dockerfile'), 'FROM node:22-alpine\n');
    fs.writeFileSync(path.join(tmpDir, 'docker-compose.repovine-test.yml'), `
services:
  postgres:
    image: postgres:16-alpine
    ports:
      - '5432:5432'
    environment:
      POSTGRES_DB: jobs
      POSTGRES_USER: jobs
      POSTGRES_PASSWORD: jobs

  lmtify-worker:
    build:
      context: ./infrastructure/k8s-services/lmtify-worker
      dockerfile: Dockerfile.dev
    depends_on:
      - postgres

  lmtify-operator:
    build:
      context: ./infrastructure/k8s-services/lmtify-operator
      dockerfile: Dockerfile
    depends_on:
      - postgres
`);

    const modules = collectInfraModules({ repoRoot: tmpDir, packages: [] });
    const compose = modules.find(m => m.kind === 'docker-compose');
    expect(compose).toMatchObject({
      id: 'infra:docker-compose:docker-compose.repovine-test.yml',
      relativeFilePath: 'docker-compose.repovine-test.yml',
    });

    const byId = Object.fromEntries((compose?.resources ?? []).map(r => [r.id, r]));
    expect(byId.postgres).toMatchObject({
      provider: 'generic',
      kind: 'other',
      attributes: {
        image: 'postgres:16-alpine',
        ports: '1',
        environment: '3',
      },
    });
    expect(byId['lmtify-worker']).toMatchObject({
      provider: 'generic',
      kind: 'other',
      attributes: {
        dockerfile: 'infrastructure/k8s-services/lmtify-worker/Dockerfile.dev',
      },
    });
    expect(byId['lmtify-operator']).toMatchObject({
      provider: 'generic',
      kind: 'other',
      attributes: {
        dockerfile: 'infrastructure/k8s-services/lmtify-operator/Dockerfile',
      },
    });
  });
});
