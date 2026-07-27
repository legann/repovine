/**
 * `access` on a trace_flow resource reports the grant the IaC document declares.
 *
 * This half shipped unguarded: reverting `mcp/lib/topology.ts` to the old hardcoded
 * `access: 'read-write'` left the whole MCP suite green, so nothing distinguished a read grant
 * from a fabricated default. The assertions below fail on that revert.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { collectRepositoryFactsAsync } from '../../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../../src/stage2/index.js';
import { projectRuntimeTopology } from '../../../src/mcp/lib/topology.js';
import type { McpToolRuntime } from '../../../src/mcp/types.js';

type TopologyResource = {
  logicalId?: string;
  access?: string;
  provenance?: { basis: string; method: string };
  envVar?: string;
};

const TEMPLATE = `
Transform: AWS::Serverless-2016-10-31
Resources:
  ReadOnlyTable:
    Type: AWS::DynamoDB::Table
  UngrantedTable:
    Type: AWS::DynamoDB::Table
  Worker:
    Type: AWS::Serverless::Function
    Properties:
      Handler: worker.handler
      Environment:
        Variables:
          READ_TABLE: !Ref ReadOnlyTable
          PLAIN_TABLE: !Ref UngrantedTable
      Policies:
        - DynamoDBReadPolicy:
            TableName: !Ref ReadOnlyTable
`;

describe('trace_flow resource access provenance', () => {
  let resourcesByLogicalId: Map<string, TopologyResource>;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topology-access-'));
    fs.writeFileSync(path.join(tmpDir, 'template.yaml'), TEMPLATE);
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'access-fixture' }));

    const originalLog = console.log;
    console.log = () => {};
    let snapshot;
    try {
      snapshot = await collectRepositoryFactsAsync(tmpDir);
    } finally {
      console.log = originalLog;
    }
    const graph = composeRepositoryGraph(snapshot);
    const ctx = {
      getState: () => ({ graph, snapshot, modulesById: new Map(snapshot.modules.map(m => [m.id, m])) }),
      repoRoot: tmpDir,
    } as unknown as McpToolRuntime;

    const topology = projectRuntimeTopology(ctx, {}) as {
      services?: Array<{ resources?: TopologyResource[] }>;
    };
    resourcesByLogicalId = new Map();
    for (const service of topology.services ?? []) {
      for (const resource of service.resources ?? []) {
        if (resource.logicalId) resourcesByLogicalId.set(resource.logicalId, resource);
      }
    }
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports the declared verb and names the grant as its source', () => {
    expect(resourcesByLogicalId.get('ReadOnlyTable')).toMatchObject({
      access: 'read',
      provenance: { basis: 'declared', method: 'iam-policy' },
    });
  });

  it('reports unknown rather than a default when no grant names the target', () => {
    expect(resourcesByLogicalId.get('UngrantedTable')).toMatchObject({
      access: 'unknown',
      provenance: { basis: 'absent', method: 'not-declared' },
    });
  });

  it('never reports read-write for either binding in this template', () => {
    const modes = [...resourcesByLogicalId.values()].map(resource => resource.access);
    expect(modes).not.toContain('read-write');
  });
});
