import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { PROTOCOL_VERSION } from '../../src/agents/protocol.js';

const REPOVINE_ROOT = process.cwd();
const CLI = path.join(REPOVINE_ROOT, 'dist', 'mcp', 'index.js');
const FIXTURE_PATH = path.join(
  REPOVINE_ROOT,
  'test',
  'fixtures',
  'agent-protocol-harness',
  'harness-spec-fixtures.json',
);

type JsonObject = Record<string, unknown>;

function parseJsonObject(text: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
  } catch {
    // Non-JSON output is surfaced through stdout/stderr assertions.
  }
  return undefined;
}

function run(command: string[], cwd: string): { status: number | null; stdout: string; stderr: string; json?: JsonObject } {
  const res = spawnSync(process.execPath, [CLI, ...command], {
    cwd,
    env: { ...process.env, REPOVINE_ROOT: cwd },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  const json = parseJsonObject(res.stdout);
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, ...(json === undefined ? {} : { json }) };
}

function writeJson(dir: string, name: string, value: unknown): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

function createMiniRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-protocol-blackbox-'));
  const pkgRoot = path.join(repoRoot, 'packages', 'orders');
  const srcRoot = path.join(pkgRoot, 'src');
  fs.mkdirSync(srcRoot, { recursive: true });

  fs.writeFileSync(path.join(repoRoot, 'repovine.annots.json'), '{"version":1,"annotations":{}}\n');
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: 'orders', version: '0.0.0' }, null, 2));
  fs.writeFileSync(path.join(pkgRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
    },
    include: ['src/**/*.ts'],
  }, null, 2));
  fs.writeFileSync(path.join(srcRoot, 'audit-log-writer.ts'), [
    'export interface AuditEvent {',
    '  orderId: string;',
    '  status: string;',
    '}',
    '',
    'export class AuditLogWriter {',
    '  write(event: AuditEvent): void {',
    '    void event;',
    '  }',
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(srcRoot, 'order-service.ts'), [
    "import { AuditLogWriter } from './audit-log-writer';",
    '',
    'export class OrderService {',
    '  constructor(private readonly auditLogWriter = new AuditLogWriter()) {}',
    '',
    '  transition(orderId: string, status: string): void {',
    '    this.auditLogWriter.write({ orderId, status });',
    '  }',
    '}',
    '',
  ].join('\n'));

  return repoRoot;
}

describe('agent protocol CLI black-box harness surface', () => {
  let repoRoot: string;
  let fixture: Record<string, unknown>;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`Compiled CLI missing at ${CLI}; Jest globalSetup should run npm run build before tests.`);
    }
  });

  beforeEach(() => {
    repoRoot = createMiniRepo();
    fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8')) as Record<string, unknown>;
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('validates the full harness contract through node dist/mcp/index.js agents ...', () => {
    const protocol = run(['agents', 'protocol', '--schemas'], repoRoot);
    expect(protocol.status).toBe(0);
    expect(protocol.json).toHaveProperty('protocol.protocolVersion', PROTOCOL_VERSION);
    expect(protocol.json).toHaveProperty('jsonSchemas.ContextPack');
    expect(protocol.json).toHaveProperty('jsonSchemas.ArchitectureAuditResult');
    expect(protocol.json).toHaveProperty('jsonSchemas.CodeReviewResult');
    expect(protocol.json).toHaveProperty('jsonSchemas.ReviewInput');

    const codeReviewer = run(['agents', 'manifests', '--role', 'code-reviewer'], repoRoot);
    expect(codeReviewer.status).toBe(0);
    expect(codeReviewer.json).toHaveProperty('manifests.0.name', 'repovine-code-reviewer');

    const architectureAuditor = run(['agents', 'manifests', '--role', 'architecture-auditor'], repoRoot);
    expect(architectureAuditor.status).toBe(0);
    expect(architectureAuditor.json).toHaveProperty('manifests.0.name', 'repovine-architecture-auditor');

    const cases = [
      ['implementation', 'implementationAssignment', 'implementationResult', 'project-subagent-sample'],
      ['architecture audit', 'architectureAuditAssignment', 'architectureAuditRunResult', 'repovine-architecture-auditor'],
      ['code review', 'codeReviewAssignment', 'codeReviewRunResult', 'repovine-code-reviewer'],
    ] as const;

    for (const [label, assignmentKey, resultKey, manifest] of cases) {
      const assignmentFile = writeJson(repoRoot, `${label.replace(/\s+/g, '-')}-assignment.json`, fixture[assignmentKey]);
      const resultFile = writeJson(repoRoot, `${label.replace(/\s+/g, '-')}-result.json`, fixture[resultKey]);

      const assignment = run(['agents', 'validate-assignment', assignmentFile], repoRoot);
      expect(assignment.status).toBe(0);
      expect(assignment.json).toHaveProperty('valid', true);

      // validate-result is schema-only (structural) — no compliance report.
      const validateResult = run([
        'agents',
        'validate-result',
        resultFile,
      ], repoRoot);
      expect(validateResult.status).toBe(0);
      expect(validateResult.json).toHaveProperty('valid', true);

      const compliance = run([
        'agents',
        'compliance',
        resultFile,
        '--assignment',
        assignmentFile,
        '--manifest',
        manifest,
      ], repoRoot);
      expect(compliance.status).toBe(0);
      expect(compliance.json).toHaveProperty('report.valid', true);
      expect(compliance.json).toHaveProperty('report.errors', []);
    }
  });

  it('validates a standalone ReviewInput and rejects linkage/set mismatches', () => {
    const reviewInput = fixture.reviewInput as JsonObject;
    const validFile = writeJson(repoRoot, 'review-input.json', reviewInput);
    const valid = run(['agents', 'validate-review-input', validFile], repoRoot);
    expect(valid.status).toBe(0);
    expect(valid.json).toHaveProperty('valid', true);
    expect(valid.json).toHaveProperty('errors', []);

    // runId linkage: assignment must be the implementation assignment.
    const badLink = {
      ...reviewInput,
      assignment: fixture.codeReviewAssignment,
    };
    const badLinkFile = writeJson(repoRoot, 'review-input-badlink.json', badLink);
    const badLinkRun = run(['agents', 'validate-review-input', badLinkFile], repoRoot);
    expect(badLinkRun.status).not.toBe(0);
    expect(badLinkRun.json).toHaveProperty('valid', false);
    expect(String((badLinkRun.json as JsonObject).errors)).toMatch(/linkage: assignment\.runId/);

    // changedFiles must set-equal implementationResult.filesChanged.
    const badFiles = { ...reviewInput, changedFiles: ['packages/orders/src/audit-log-writer.ts'] };
    const badFilesFile = writeJson(repoRoot, 'review-input-badfiles.json', badFiles);
    const badFilesRun = run(['agents', 'validate-review-input', badFilesFile], repoRoot);
    expect(badFilesRun.status).not.toBe(0);
    expect(String((badFilesRun.json as JsonObject).errors)).toMatch(/changedFiles must set-equal/);

    // graphNodesTouched must set-equal implementationResult.graphNodesTouched.
    const badNodes = { ...reviewInput, graphNodesTouched: ['mod:orders/src/audit-log-writer'] };
    const badNodesFile = writeJson(repoRoot, 'review-input-badnodes.json', badNodes);
    const badNodesRun = run(['agents', 'validate-review-input', badNodesFile], repoRoot);
    expect(badNodesRun.status).not.toBe(0);
    expect(String((badNodesRun.json as JsonObject).errors)).toMatch(/graphNodesTouched must set-equal/);
  });

  it('rejects a schema-valid result that claims a graph node which does not exist', () => {
    const assignmentFile = writeJson(
      repoRoot,
      'tampered-assignment.json',
      fixture.implementationAssignment,
    );
    const implementationResult = fixture.implementationResult as JsonObject;
    const tamperedResult = {
      ...implementationResult,
      graphNodesTouched: [
        ...(implementationResult.graphNodesTouched as string[]),
        'mod:orders/src/ghost-module',
      ],
    };
    const resultFile = writeJson(repoRoot, 'tampered-result.json', tamperedResult);

    // The claim is structurally valid AgentRunResult JSON; only repository-aware
    // compliance can determine that the declared node does not exist.
    const validateResult = run(['agents', 'validate-result', resultFile], repoRoot);
    expect(validateResult.status).toBe(0);
    expect(validateResult.json).toHaveProperty('valid', true);

    const compliance = run([
      'agents',
      'compliance',
      resultFile,
      '--assignment',
      assignmentFile,
      '--manifest',
      'project-subagent-sample',
    ], repoRoot);
    expect(compliance.status).not.toBe(0);
    expect(compliance.json).toHaveProperty('report.valid', false);
    expect(compliance.json).toHaveProperty(
      'report.unresolvedGraphNodes',
      ['mod:orders/src/ghost-module'],
    );
    expect(compliance.json).toHaveProperty(
      'report.errors',
      expect.arrayContaining([
        'Declared graphNodesTouched not found in graph: mod:orders/src/ghost-module.',
      ]),
    );
    expect(compliance.json).toHaveProperty(
      'report.requiredFollowups',
      expect.arrayContaining([
        'Run refresh_context and correct graphNodesTouched to canonical node ids.',
      ]),
    );
  });

  it('orient returns search + trace_flow without LLM', () => {
    // orient spawns a fresh CLI that rebuilds the fixture graph. TypeScript extraction in the
    // subprocess can under-build (fewer folded tokens on a node), so orient searches match:'auto' —
    // AND across every token, then bounded OR when no single node carries all of them. The retry
    // absorbs a transient total-build miss; a persistent one fails on the cause below.
    let orient = run(['agents', 'orient', '--query', 'OrderService audit transition'], repoRoot);
    for (let attempt = 0; attempt < 3 && (orient.json?.search as JsonObject | undefined)?.nodeCount === 0; attempt++) {
      orient = run(['agents', 'orient', '--query', 'OrderService audit transition'], repoRoot);
    }
    expect(orient.status).toBe(0);
    expect(orient.json).toMatchObject({
      query: 'OrderService audit transition',
      flowChecked: true,
      mcpTools: ['search_context', 'trace_flow'],
    });
    expect(orient.json).toHaveProperty('search.summary');
    expect(orient.json).toHaveProperty('traceFlow.summary');
    expect(orient.json).toHaveProperty('graphNodes');
    expect(Array.isArray(orient.json?.graphNodes)).toBe(true);

    // Assert the CAUSE, not the derived confidence: the build must produce the fixture's
    // `packages/orders` nodes and search must resolve them. graphNodes/nodeCount reflect the real top
    // hits (buildOrientReport reads result.matches.topResults). On failure, surface the subprocess
    // build log (Stage-1 "Discovered N modules") so a CI-only under-build is diagnosable.
    const search = orient.json?.search as Record<string, unknown>;
    const graphNodes = orient.json?.graphNodes as string[];
    if ((search.nodeCount as number) === 0) {
      // Surface the subprocess Stage-1 build log ("Discovered N modules") so a CI-only under-build
      // is diagnosable from the failure alone.
      throw new Error(`orient resolved no graph nodes.\norient stderr:\n${orient.stderr}\nsearch: ${JSON.stringify(search)}`);
    }
    expect(search.nodeCount as number).toBeGreaterThan(0);
    expect(graphNodes.some((id) => id.includes('order-service'))).toBe(true);
    // The relaxed-OR gap is fine; the empty-corpus gap is not — the fixture nodes must be found.
    expect((search.gaps as string[]).some((g) => /no graph node strongly matched/i.test(g))).toBe(false);
    // summary + confidence are stable once ≥ 2 tokens resolve to a hit (score no longer flips it).
    expect(String(search.summary)).toContain('Found context candidates');
    expect(search.confidence).toBe('medium');
  });
});
