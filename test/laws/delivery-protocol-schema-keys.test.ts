import { describe, expect, it } from '@jest/globals';
import * as protocol from '../../src/agents/protocol.js';
import {
  AcceptanceCriterionSchema,
  AgentAssignmentSchema,
  AgentComplianceReportSchema,
  AgentManifestSchema,
  DeliveryProtocolSchema,
  AgentRunResultSchema,
  ArchitectureAuditResultSchema,
  CodeReviewResultSchema,
  ComplianceFlagsSchema,
  ContextPackRefSchema,
  ContextPackSchema,
  ContextQualityReportSchema,
  ContextQualitySummarySchema,
  ContextSessionLinkSchema,
  ContextSessionPolicySchema,
  CriterionResultSchema,
  DeliveryVerdictSchema,
  DeliveryVerificationResultSchema,
  EvidenceReferenceSchema,
  InternalTraceSchema,
  ProposedAssignmentSchema,
  ReviewInputSchema,
  SubagentAssignmentSchema,
  SubagentHandoffSchema,
  VerificationPolicySchema,
} from '../../src/agents/protocol.js';

// Law: every protocol object schema carries a pinned key set.
//
// The zod object schemas strip unknown keys, so renaming an OPTIONAL field passes a plain
// safeParse — old-keyed data still parses because the renamed field is absent-and-optional and the
// stale key is dropped as unknown. `.strict()` would catch it but changes runtime behaviour (it would
// reject the extra keys a harness or agent may legitimately send), so the guard is a key snapshot
// instead: the pinned array is the frozen expectation, `Object.keys(schema.shape)` is the SSOT. A
// renamed or dropped field diverges the two; a new field must be added to the pin, which forces the
// change to be intentional. The completeness case makes an unpinned new schema fail too.

const PINNED: ReadonlyArray<readonly [string, { shape: Record<string, unknown> }, readonly string[]]> = [
  ['ContextSessionPolicySchema', ContextSessionPolicySchema, [
    'sessionId', 'required', 'mode', 'phase', 'qualityThreshold', 'warningThreshold',
    'minAnchors', 'byteBudget', 'maxRecoveryAttempts', 'retain',
  ]],
  ['ContextSessionLinkSchema', ContextSessionLinkSchema, [
    'sessionId', 'runId', 'taskRef', 'phase', 'scope',
  ]],
  ['ContextQualitySummarySchema', ContextQualitySummarySchema, [
    'sessionId', 'overall', 'noisePenalty', 'structureBonus', 'stableAnchors',
    'rejectReasons', 'acceptHandoff',
  ]],
  ['ContextQualityReportSchema', ContextQualityReportSchema, [
    'sessionId', 'phase', 'overall', 'noisePenalty', 'structureBonus', 'acceptHandoff',
    'belowWarningThreshold', 'rejectReasons', 'warnings', 'requiredFollowups', 'aggregates',
    'policy', 'requestEchoes', 'events',
  ]],
  ['ContextPackSchema', ContextPackSchema, [
    'scope', 'resolvedAnchors', 'entrypoints', 'contracts', 'dependencyNotes', 'configNotes',
    'flowNotes', 'architectureSignals', 'assumptions', 'openQuestions', 'recommendedNextActions',
  ]],
  ['ContextPackRefSchema', ContextPackRefSchema, [
    'ref', 'contextSessionId', 'scope',
  ]],
  ['ProposedAssignmentSchema', ProposedAssignmentSchema, [
    'task', 'scope', 'acceptanceCriteria', 'constraints', 'contracts', 'requestedChecks', 'scopeExpansion',
  ]],
  ['ArchitectureAuditResultSchema', ArchitectureAuditResultSchema, [
    'auditScope', 'categories', 'findings',
  ]],
  ['CodeReviewResultSchema', CodeReviewResultSchema, [
    'verdict', 'reviewedFiles', 'reviewedDiffBase', 'criteriaChecked', 'testReview', 'findings', 'residualRisks',
  ]],
  ['AgentManifestSchema', AgentManifestSchema, [
    'protocolVersion', 'name', 'role', 'description', 'canEditFiles', 'allowedTools',
    'expectedInputs', 'requiredRunResultFields', 'projectionTargets',
  ]],
  ['AgentAssignmentSchema', AgentAssignmentSchema, [
    'protocolVersion', 'runId', 'role', 'task', 'scope', 'version', 'acceptanceCriteria', 'constraints',
    'contracts', 'requestedChecks', 'delivery', 'verificationPolicy', 'contextSession', 'priorContext',
  ]],
  ['ComplianceFlagsSchema', ComplianceFlagsSchema, [
    'refreshContextRun', 'annotationsClean', 'dependencyImpactChecked', 'configSurfaceChecked',
    'flowChecked', 'architectureChecked',
  ]],
  ['InternalTraceSchema', InternalTraceSchema, [
    'subagentsUsed', 'handoffCount',
  ]],
  ['AgentRunResultSchema', AgentRunResultSchema, [
    'protocolVersion', 'runId', 'status', 'summary', 'scope', 'filesChanged', 'graphNodesTouched',
    'contractsChanged', 'testsRun', 'annotationsWritten', 'compliance', 'blockers',
    'contextSessionId', 'contextQuality', 'contextPack', 'architectureAudit', 'review',
    'deliveryVerification', 'internalTrace',
  ]],
  ['ReviewInputSchema', ReviewInputSchema, [
    'assignment', 'priorContext', 'implementationResult', 'diffBase', 'changedFiles', 'graphNodesTouched',
  ]],
  ['AgentComplianceReportSchema', AgentComplianceReportSchema, [
    'protocolVersion', 'runId', 'valid', 'errors', 'warnings', 'diagnostics', 'missingFields', 'staleAnnotations',
    'orphanedAnnotations', 'missingAnnotations', 'ungroundedAnnotations', 'inconsistentAnnotations',
    'unresolvedGraphNodes', 'scopeCollisions', 'requiredFollowups', 'contextQuality',
  ]],
  ['SubagentAssignmentSchema', SubagentAssignmentSchema, [
    'protocolVersion', 'runId', 'role', 'task', 'scope', 'version', 'acceptanceCriteria', 'constraints', 'contracts',
    'requestedChecks', 'delivery', 'verificationPolicy', 'contextSession', 'priorContext', 'parentRunId', 'subRunId', 'agentName',
  ]],
  ['SubagentHandoffSchema', SubagentHandoffSchema, [
    'protocolVersion', 'parentRunId', 'subRunId', 'agentName', 'role', 'status', 'claims', 'blockers',
  ]],
  ['DeliveryProtocolSchema', DeliveryProtocolSchema, [
    'protocolVersion', 'schemas', 'mcpTools', 'cliCommands',
  ]],
  ['AcceptanceCriterionSchema', AcceptanceCriterionSchema, [
    'id', 'statement', 'required', 'kind',
  ]],
  ['EvidenceReferenceSchema', EvidenceReferenceSchema, [
    'kind', 'file', 'line', 'graphNodeId', 'symbol', 'artifactRef', 'revision', 'explanation',
  ]],
  ['VerificationPolicySchema', VerificationPolicySchema, [
    'assuranceProfile', 'version', 'requirements',
  ]],
  ['CriterionResultSchema', CriterionResultSchema, [
    'criterionId', 'status', 'evidence', 'explanation', 'resolution',
  ]],
  ['DeliveryVerdictSchema', DeliveryVerdictSchema, [
    'intentVerified', 'assuranceProfile', 'assurancePassed', 'deliveryAccepted',
  ]],
  ['DeliveryVerificationResultSchema', DeliveryVerificationResultSchema, [
    'criteriaResults', 'verdict',
  ]],
];

function isZodObjectSchema(value: unknown): value is { shape: Record<string, unknown> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'shape' in value &&
    typeof (value as { shape?: unknown }).shape === 'object' &&
    (value as { shape?: unknown }).shape !== null
  );
}

describe('core-laws every protocol object schema carries a pinned key set', () => {
  for (const [name, schema, keys] of PINNED) {
    it(`${name} key set is pinned to the schema shape`, () => {
      expect(keys.length).toBeGreaterThan(0);
      expect(Object.keys(schema.shape).sort()).toEqual([...keys].sort());
    });
  }

  it('pins every exported protocol object schema (a new one must be added here)', () => {
    const exported = Object.entries(protocol)
      .filter(([name, value]) => name.endsWith('Schema') && isZodObjectSchema(value))
      .map(([name]) => name)
      .sort();
    expect(exported.length).toBeGreaterThan(0);
    expect(exported).toEqual(PINNED.map(([name]) => name).sort());
  });
});
