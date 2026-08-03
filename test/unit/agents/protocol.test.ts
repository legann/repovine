import { describe, expect, it } from '@jest/globals';
import {
  PROTOCOL_VERSION,
  AGENT_ROLES,
  AgentManifestSchema,
  AgentAssignmentSchema,
  AgentRunResultSchema,
  ContextPackSchema,
  ArchitectureAuditResultSchema,
  CodeReviewResultSchema,
  AgentComplianceReportSchema,
  SubagentHandoffSchema,
  buildDeliveryProtocol,
  AGENT_JSON_SCHEMAS,
  SCHEMA_IDS,
  DELIVERY_PROTOCOL_MCP_TOOLS,
} from '../../../src/agents/protocol.js';

describe('delivery protocol', () => {
  it('pins protocol version independently from the repovine package version', () => {
    expect(PROTOCOL_VERSION).toBe('1');
  });

  it('builds a self-consistent protocol descriptor', () => {
    const protocol = buildDeliveryProtocol();
    expect(protocol.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(protocol.schemas).toEqual(SCHEMA_IDS);
    expect(protocol.mcpTools).toEqual([]);
    expect(DELIVERY_PROTOCOL_MCP_TOOLS).toEqual([]);
    expect(protocol.cliCommands.length).toBeGreaterThan(0);
  });

  it('exports JSON Schema for each public protocol object', () => {
    // Representative property that each schema must expose. Pins content so an
    // empty or wrong object ({}, or a schema built from a different type) fails,
    // rather than passing on mere presence/typeof.
    const REQUIRED_PROPERTY: Record<string, string> = {
      [SCHEMA_IDS.agentManifest]: 'role',
      [SCHEMA_IDS.agentAssignment]: 'runId',
      [SCHEMA_IDS.agentRunResult]: 'compliance',
      [SCHEMA_IDS.agentComplianceReport]: 'valid',
      [SCHEMA_IDS.contextPack]: 'resolvedAnchors',
      [SCHEMA_IDS.architectureAuditResult]: 'findings',
      [SCHEMA_IDS.codeReviewResult]: 'verdict',
      [SCHEMA_IDS.reviewInput]: 'assignment',
      [SCHEMA_IDS.deliveryVerificationResult]: 'criteriaResults',
    };

    for (const id of Object.values(SCHEMA_IDS)) {
      const schema = AGENT_JSON_SCHEMAS[id] as {
        type?: unknown;
        properties?: Record<string, unknown>;
      };
      expect(schema).toBeDefined();
      expect(typeof schema).toBe('object');
      // A zod object schema serializes to a JSON Schema object with non-empty
      // properties; {} or a scalar schema would fail these.
      expect(schema.type).toBe('object');
      expect(schema.properties).toBeDefined();
      const propKeys = Object.keys(schema.properties ?? {});
      expect(propKeys.length).toBeGreaterThan(0);
      expect(propKeys).toContain(REQUIRED_PROPERTY[id]);
    }

    // Every SCHEMA_ID has an exported JSON Schema and vice versa (no extra keys).
    expect(Object.keys(AGENT_JSON_SCHEMAS).sort()).toEqual(
      Object.values(SCHEMA_IDS).slice().sort(),
    );
  });

  it('declares the six built-in roles', () => {
    expect(AGENT_ROLES).toEqual([
      'main',
      'explorer',
      'implementer',
      'annotation-writer',
      'architecture-auditor',
      'code-reviewer',
    ]);
  });

  it('accepts a well-formed assignment and rejects an unsupported version', () => {
    const ok = AgentAssignmentSchema.safeParse({
      protocolVersion: '1',
      runId: 'r1',
      role: 'implementer',
      task: 't',
      scope: [],
      version: 1,
      acceptanceCriteria: [],
      constraints: [],
      contracts: [],
      requestedChecks: ['tests', 'code-review'],
      contextSession: { sessionId: 'sess-1', required: true, mode: 'harness', phase: 'explore', qualityThreshold: 0.55, warningThreshold: 0.7 },
      priorContext: {
        scope: ['pkg:a'],
        resolvedAnchors: [{ nodeId: 'mod:a/b', role: 'primary', reason: 'task anchor' }],
        entrypoints: [],
        contracts: [],
        dependencyNotes: [],
        configNotes: [],
        flowNotes: [],
        architectureSignals: [],
        assumptions: [],
        openQuestions: [],
        recommendedNextActions: [],
      },
    });
    expect(ok.success).toBe(true);

    const clientMode = AgentAssignmentSchema.safeParse({
      protocolVersion: '1',
      runId: 'r1',
      role: 'explorer',
      task: 't',
      scope: [],
      version: 1,
      acceptanceCriteria: [],
      constraints: [],
      contracts: [],
      requestedChecks: [],
      contextSession: { mode: 'client' },
    });
    expect(clientMode.success).toBe(true);

    const bad = AgentAssignmentSchema.safeParse({ protocolVersion: '2', runId: 'r1', task: 't' });
    expect(bad.success).toBe(false);
  });

  it('rejects unknown enum values in a run result', () => {
    const bad = AgentRunResultSchema.safeParse({
      protocolVersion: '1',
      runId: 'r',
      status: 'nope',
      summary: '',
      scope: [],
      filesChanged: [],
      graphNodesTouched: [],
      contractsChanged: [],
      testsRun: [],
      annotationsWritten: [],
      compliance: {
        refreshContextRun: true,
        annotationsClean: true,
        dependencyImpactChecked: true,
        configSurfaceChecked: true,
        flowChecked: true,
        architectureChecked: true,
      },
      blockers: [],
    });
    expect(bad.success).toBe(false);
  });

  it('treats internalTrace as optional on a run result', () => {
    const base = {
      protocolVersion: '1' as const,
      runId: 'r',
      status: 'complete' as const,
      summary: 's',
      scope: [],
      filesChanged: [],
      graphNodesTouched: [],
      contractsChanged: [],
      testsRun: [],
      annotationsWritten: [],
      compliance: {
        refreshContextRun: true,
        annotationsClean: true,
        dependencyImpactChecked: true,
        configSurfaceChecked: true,
        flowChecked: true,
        architectureChecked: true,
      },
      blockers: [],
    };
    expect(AgentRunResultSchema.safeParse(base).success).toBe(true);
    expect(AgentRunResultSchema.safeParse({ ...base, internalTrace: { subagentsUsed: ['x'], handoffCount: 1 } }).success).toBe(true);
    expect(AgentRunResultSchema.safeParse({
      ...base,
      contextSessionId: 'sess_1',
      contextQuality: { overall: 0.8, stableAnchors: ['pkg:x'], rejectReasons: [] },
    }).success).toBe(true);
  });

  it('accepts ContextPack, ArchitectureAuditResult, and CodeReviewResult artifacts', () => {
    const contextPack = {
      scope: ['pkg:a'],
      resolvedAnchors: [{ nodeId: 'mod:a/b', role: 'primary', reason: 'main module' }],
      entrypoints: ['entry:api:get-users'],
      contracts: ['GET /users'],
      dependencyNotes: ['exports UserService'],
      configNotes: [],
      flowNotes: [],
      architectureSignals: ['low cohesion candidate suppressed'],
      assumptions: ['tests run in package a'],
      openQuestions: [],
      recommendedNextActions: ['implement change'],
    };
    expect(ContextPackSchema.safeParse(contextPack).success).toBe(true);

    const architectureAudit = {
      auditScope: ['pkg:a'],
      categories: ['boundary'],
      findings: [{
        findingId: 'boundary:f1',
        status: 'confirmed',
        severity: 'medium',
        confidence: 0.8,
        nodes: ['mod:a/b'],
        evidence: ['module crosses package boundary'],
        recommendedAction: 'split adapter',
        proposedAssignment: {
          task: 'Split adapter',
          scope: ['pkg:a'],
          acceptanceCriteria: ['adapter owns external call'],
          constraints: [],
          contracts: [],
          requestedChecks: ['dependencies'],
        },
      }],
    };
    expect(ArchitectureAuditResultSchema.safeParse(architectureAudit).success).toBe(true);

    const review = {
      verdict: 'changes-requested',
      reviewedFiles: ['packages/a/src/b.ts'],
      reviewedDiffBase: 'HEAD~1',
      criteriaChecked: ['tests pass'],
      testReview: {
        claimedTestsRun: ['jest b.test.ts'],
        reviewerTestsRun: [],
        coverageAssessment: 'insufficient',
        missingTests: [{ behavior: 'error path', suggestedTest: 'add rejection test', severity: 'major' }],
      },
      findings: [{
        severity: 'major',
        file: 'packages/a/src/b.ts',
        line: 12,
        graphNodeId: 'mod:a/b',
        summary: 'Missing error handling',
        evidence: 'throws are swallowed',
        recommendation: 'return explicit failure',
      }],
      residualRisks: ['reviewer did not rerun tests'],
    };
    expect(CodeReviewResultSchema.safeParse(review).success).toBe(true);

    expect(AgentRunResultSchema.safeParse({
      protocolVersion: '1',
      runId: 'r',
      status: 'complete',
      summary: 'reviewed',
      scope: ['pkg:a'],
      filesChanged: [],
      graphNodesTouched: [],
      contractsChanged: [],
      testsRun: [],
      annotationsWritten: [],
      compliance: {
        refreshContextRun: true,
        annotationsClean: true,
        dependencyImpactChecked: true,
        configSurfaceChecked: false,
        flowChecked: false,
        architectureChecked: true,
      },
      blockers: [],
      contextPack,
      architectureAudit,
      review,
    }).success).toBe(true);
  });

  it('validates compliance report and subagent handoff shapes', () => {
    expect(AgentComplianceReportSchema.safeParse({
      protocolVersion: '1',
      runId: 'r',
      valid: true,
      errors: [],
      warnings: [],
      missingFields: [],
      staleAnnotations: [],
      orphanedAnnotations: [],
      missingAnnotations: [],
      unresolvedGraphNodes: [],
      scopeCollisions: [],
      requiredFollowups: [],
    }).success).toBe(true);

    expect(SubagentHandoffSchema.safeParse({
      protocolVersion: '1',
      parentRunId: 'p',
      subRunId: 's',
      agentName: 'impl',
      role: 'code-reviewer',
      status: 'complete',
      claims: { summary: 'did a thing' },
      blockers: [],
    }).success).toBe(true);
  });

  it('keeps every built-in manifest valid against AgentManifestSchema', async () => {
    const { BUILTIN_MANIFESTS } = await import('../../../src/agents/manifests.js');
    for (const m of BUILTIN_MANIFESTS) {
      expect(AgentManifestSchema.safeParse(m).success).toBe(true);
    }
  });
});
