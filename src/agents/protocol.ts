/**
 * Agent Protocol v1 — canonical schemas and types.
 *
 * repovine is the contract + validation + projection layer for verifiable
 * software development with coding agents. Agent Protocol is the harness-facing
 * integration contract inside repovine core. This module is the single source of
 * truth for the protocol objects a harness or IDE projection exchanges with
 * repovine:
 *
 *   Harness / IDE   -> AgentAssignment
 *                   <- AgentRunResult
 *   repovine        -> AgentComplianceReport (validates result + observable state)
 *
 * Zod schemas are authoritative; TypeScript types are inferred from them so the
 * runtime validator and the static types never drift. JSON Schema is exported
 * via `toJSONSchema` for non-TypeScript / non-MCP harnesses.
 *
 * repovine does NOT own execution, scheduling, retries, model routing, budgets,
 * isolation, permissions, or task queues — those belong to the harness.
 */
import { z, toJSONSchema } from 'zod';
import { CONTEXT_ENFORCEMENT_MODES, CONTEXT_PHASES } from '../context-quality/types.js';

/** Current Agent Protocol schema-contract version (independent from package.json). */
export const PROTOCOL_VERSION = '1' as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

const ProtocolVersionSchema = z.literal(PROTOCOL_VERSION);

// ── Enumerations ──

/** Roles repovine knows how to project or validate. */
export const AGENT_ROLES = [
  'main',
  'explorer',
  'implementer',
  'annotation-writer',
  'architecture-auditor',
  'code-reviewer',
] as const;
export const AgentRoleSchema = z.enum(AGENT_ROLES);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

/** Client/projection targets a manifest can render to. */
export const PROJECTION_TARGETS = ['agents-md', 'cursor', 'codex', 'claude', 'json'] as const;
export const ProjectionTargetSchema = z.enum(PROJECTION_TARGETS);
export type ProjectionTarget = z.infer<typeof ProjectionTargetSchema>;

/** repovine checks an assignment can request and a result can claim. */
export const REQUESTED_CHECKS = [
  'dependencies',
  'config',
  'runtime-flow',
  'architecture',
  'code-review',
  'annotations',
  'tests',
] as const;
export const RequestedCheckSchema = z.enum(REQUESTED_CHECKS);
export type RequestedCheck = z.infer<typeof RequestedCheckSchema>;

/** Terminal status of a run or sub-run. */
export const RUN_STATUSES = ['complete', 'partial', 'blocked', 'failed'] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export { CONTEXT_PHASES, CONTEXT_ENFORCEMENT_MODES };
export const ContextPhaseSchema = z.enum(CONTEXT_PHASES);
export const ContextEnforcementModeSchema = z.enum(CONTEXT_ENFORCEMENT_MODES);

export const ContextSessionPolicySchema = z.object({
  sessionId: z.string().min(1).optional(),
  required: z.boolean().optional(),
  mode: ContextEnforcementModeSchema.optional(),
  phase: ContextPhaseSchema.optional(),
  qualityThreshold: z.number().min(0).max(1).optional(),
  warningThreshold: z.number().min(0).max(1).optional(),
  minAnchors: z.number().int().min(0).optional(),
  byteBudget: z.number().int().min(1).optional(),
  maxRecoveryAttempts: z.number().int().min(0).max(10).optional(),
  retain: z.boolean().optional(),
});
export type ContextSessionPolicy = z.infer<typeof ContextSessionPolicySchema>;

export const ContextSessionLinkSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  taskRef: z.string().min(1).optional(),
  phase: ContextPhaseSchema,
  scope: z.array(z.string()),
});
export type ContextSessionLink = z.infer<typeof ContextSessionLinkSchema>;

export const ContextQualitySummarySchema = z.object({
  sessionId: z.string().min(1).optional(),
  overall: z.number().min(0).max(1).optional(),
  noisePenalty: z.number().min(0).max(1).optional(),
  structureBonus: z.number().min(0).max(1).optional(),
  stableAnchors: z.array(z.string()).optional(),
  rejectReasons: z.array(z.string()).optional(),
  acceptHandoff: z.boolean().optional(),
}).catchall(z.unknown());
export type ContextQualitySummary = z.infer<typeof ContextQualitySummarySchema>;

export const ContextQualityReportSchema = z.object({
  sessionId: z.string().min(1),
  phase: ContextPhaseSchema,
  overall: z.number().min(0).max(1),
  noisePenalty: z.number().min(0).max(1),
  structureBonus: z.number().min(0).max(1),
  acceptHandoff: z.boolean(),
  belowWarningThreshold: z.boolean(),
  rejectReasons: z.array(z.string()),
  warnings: z.array(z.string()),
  requiredFollowups: z.array(z.string()),
  aggregates: z.object({
    toolCallCount: z.number(),
    searchCallCount: z.number(),
    mapCallCount: z.number(),
    inspectCallCount: z.number(),
    totalResponseBytes: z.number(),
    maxSingleResponseBytes: z.number(),
    maxArchitectureResponseBytes: z.number(),
    maxTotalResultsInSearch: z.number(),
    orSearchCount: z.number(),
    recoveredOrSearchCount: z.number(),
    unrecoveredOrSearchCount: z.number(),
    lowConfidenceCount: z.number(),
    unresolvedScopeCount: z.number(),
    capabilityDominantSearchCount: z.number(),
    avgCapRatio: z.number(),
    testPackageHitCount: z.number(),
    stableAnchors: z.array(z.string()),
    recoveredFromNoise: z.boolean(),
    hadImpactOnModule: z.boolean(),
    endedWithSearchOnly: z.boolean(),
    lastTool: z.string().optional(),
    lastResolvedScope: z.string().optional(),
  }),
  policy: z.object({
    required: z.boolean(),
    mode: ContextEnforcementModeSchema,
    qualityThreshold: z.number().min(0).max(1),
    warningThreshold: z.number().min(0).max(1),
    minAnchors: z.number().int().min(0),
    byteBudget: z.number().int().min(1),
    maxRecoveryAttempts: z.number().int().min(0).max(10).optional(),
    retain: z.boolean(),
  }),
  requestEchoes: z.array(z.object({
    seq: z.number(),
    tool: z.string(),
    responseBytes: z.number(),
    request: z.record(z.string(), z.unknown()),
  })),
  events: z.array(z.unknown()).optional(),
});

// ── Context artifacts ──

export const ContextAnchorRoleSchema = z.enum([
  'primary',
  'supporting',
  'entrypoint',
  'contract',
  'config',
]);
export type ContextAnchorRole = z.infer<typeof ContextAnchorRoleSchema>;

export const ContextPackSchema = z.object({
  scope: z.array(z.string()),
  resolvedAnchors: z.array(z.object({
    nodeId: z.string().min(1),
    role: ContextAnchorRoleSchema,
    reason: z.string(),
  })),
  entrypoints: z.array(z.string()),
  contracts: z.array(z.string()),
  dependencyNotes: z.array(z.string()),
  configNotes: z.array(z.string()),
  flowNotes: z.array(z.string()),
  architectureSignals: z.array(z.string()),
  assumptions: z.array(z.string()),
  openQuestions: z.array(z.string()),
  recommendedNextActions: z.array(z.string()),
});
export type ContextPack = z.infer<typeof ContextPackSchema>;

export const ContextPackRefSchema = z.object({
  ref: z.string().min(1),
  contextSessionId: z.string().min(1).optional(),
  scope: z.array(z.string()).optional(),
});
export type ContextPackRef = z.infer<typeof ContextPackRefSchema>;

export const PriorContextSchema = z.union([ContextPackSchema, ContextPackRefSchema]);
export type PriorContext = z.infer<typeof PriorContextSchema>;

// ── Capability result artifacts ──

export const ProposedAssignmentSchema = z.object({
  task: z.string().min(1),
  scope: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  constraints: z.array(z.string()),
  contracts: z.array(z.string()),
  requestedChecks: z.array(RequestedCheckSchema),
  scopeExpansion: z.boolean().optional(),
});
export type ProposedAssignment = z.infer<typeof ProposedAssignmentSchema>;

export const ArchitectureAuditResultSchema = z.object({
  auditScope: z.array(z.string()),
  categories: z.array(z.string()),
  findings: z.array(z.object({
    findingId: z.string().min(1),
    status: z.enum(['confirmed', 'suppressed', 'needs-inspection', 'accepted-risk']),
    severity: z.enum(['low', 'medium', 'high']),
    confidence: z.number().min(0).max(1),
    nodes: z.array(z.string()),
    evidence: z.array(z.string()),
    recommendedAction: z.string(),
    proposedAssignment: ProposedAssignmentSchema.optional(),
  })),
});
export type ArchitectureAuditResult = z.infer<typeof ArchitectureAuditResultSchema>;

export const CodeReviewResultSchema = z.object({
  verdict: z.enum(['approve', 'changes-requested', 'needs-developer', 'blocked']),
  reviewedFiles: z.array(z.string()),
  reviewedDiffBase: z.string(),
  criteriaChecked: z.array(z.string()),
  testReview: z.object({
    claimedTestsRun: z.array(z.string()),
    reviewerTestsRun: z.array(z.string()),
    coverageAssessment: z.enum(['adequate', 'insufficient', 'not-run', 'unclear']),
    missingTests: z.array(z.object({
      behavior: z.string(),
      suggestedTest: z.string(),
      severity: z.enum(['blocker', 'major', 'minor']),
    })),
  }).optional(),
  findings: z.array(z.object({
    severity: z.enum(['blocker', 'major', 'minor', 'nit']),
    file: z.string().optional(),
    line: z.number().int().min(1).optional(),
    graphNodeId: z.string().min(1).optional(),
    summary: z.string(),
    evidence: z.string(),
    recommendation: z.string(),
  })),
  residualRisks: z.array(z.string()),
});
export type CodeReviewResult = z.infer<typeof CodeReviewResultSchema>;

// ── Delivery verification artifacts ──
//
// Structured intent-to-delivery verification. Acceptance criteria carry stable ids; a
// verification policy names the evidence each criterion needs; a criterion result binds each
// criterion to repository-grounded evidence. The verifier's registry (criteria results plus a
// split delivery verdict) is a self-reported artifact repovine re-checks against observable state.

/**
 * Kinds of evidence a criterion result can cite. repovine recomputes truth only for `repository`;
 * the rest are recorded as declared, their execution owned by the harness's artifact custody.
 */
export const EVIDENCE_KINDS = [
  'repository', 'review', 'test', 'build', 'typecheck', 'runtime', 'security', 'developer', 'custom',
] as const;
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

/** One acceptance criterion with a stable identity, frozen before implementation. */
export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  required: z.boolean(),
  // delivery (absent = delivery): the run must CHANGE the cited node; invariant: a regression guard
  // the run must NOT change — its evidence is a node left untouched by the change-set.
  kind: z.enum(['delivery', 'invariant']).optional(),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

/** A pointer to observable evidence for a criterion; `repository` anchors resolve against the graph. */
export const EvidenceReferenceSchema = z.object({
  kind: EvidenceKindSchema,
  file: z.string().optional(),
  line: z.number().int().min(1).optional(),
  graphNodeId: z.string().min(1).optional(),
  symbol: z.string().optional(),
  artifactRef: z.string().optional(),
  revision: z.string().optional(),
  explanation: z.string(),
});
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;

/**
 * The harness's frozen choice of evidence per criterion. `version` is a counter checked against
 * the assignment's version; the word "revision" stays reserved for git.
 */
export const VerificationPolicySchema = z.object({
  assuranceProfile: z.string().min(1).optional(),
  version: z.number().int().min(1),
  requirements: z.array(z.object({
    criterionId: z.string().min(1),
    evidenceKinds: z.array(EvidenceKindSchema),
  })),
});
export type VerificationPolicy = z.infer<typeof VerificationPolicySchema>;

/** Terminal coverage status of one acceptance criterion. */
export const CRITERION_STATUSES = ['covered', 'gap', 'needs-developer'] as const;
export const CriterionStatusSchema = z.enum(CRITERION_STATUSES);
export type CriterionStatus = z.infer<typeof CriterionStatusSchema>;

/**
 * One criterion's coverage result. `covered` carries repository-grounded evidence; a resolved
 * needs-developer keeps status `needs-developer` and adds a custody `resolution` pointing at the artifact.
 */
export const CriterionResultSchema = z.object({
  criterionId: z.string().min(1),
  status: CriterionStatusSchema,
  evidence: z.array(EvidenceReferenceSchema),
  explanation: z.string(),
  resolution: z.object({ artifactRef: z.string().min(1) }).optional(),
});
export type CriterionResult = z.infer<typeof CriterionResultSchema>;

/**
 * The split verdict. repovine owns intentVerified (every required criterion covered). Authoritative
 * protocol validity is AgentComplianceReport.valid — the whole compliance run, including the delivery
 * diagnostics — not a field the agent claims. The harness owns assurancePassed and deliveryAccepted.
 */
export const DeliveryVerdictSchema = z.object({
  intentVerified: z.boolean(),
  assuranceProfile: z.string().min(1).optional(),
  assurancePassed: z.boolean().optional(),
  deliveryAccepted: z.boolean().optional(),
});
export type DeliveryVerdict = z.infer<typeof DeliveryVerdictSchema>;

/** The verifier's registry of per-criterion results plus the delivery verdict; distinct from open review. */
export const DeliveryVerificationResultSchema = z.object({
  criteriaResults: z.array(CriterionResultSchema),
  verdict: DeliveryVerdictSchema,
});
export type DeliveryVerificationResult = z.infer<typeof DeliveryVerificationResultSchema>;

// ── AgentManifest ──

/**
 * Describes one role repovine can project (to client assets) or validate
 * (a run result against). `requiredRunResultFields` drives both the generated
 * structured-result block and compliance validation.
 */
export const AgentManifestSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  name: z.string().min(1),
  role: AgentRoleSchema,
  description: z.string(),
  canEditFiles: z.boolean(),
  allowedTools: z.array(z.string()),
  expectedInputs: z.array(z.string()),
  requiredRunResultFields: z.array(z.string()),
  projectionTargets: z.array(ProjectionTargetSchema),
});
export type AgentManifest = z.infer<typeof AgentManifestSchema>;

// ── AgentAssignment ──

/**
 * The harness-facing request to repovine or to a repovine-managed main agent.
 *
 * `role` and `version` are validated for shape only: an unknown role is a schema error, but
 * resolving a role's required result fields, cross-checking `version` against a policy version,
 * and requiring `delivery` refs or a `verificationPolicy` for a given assurance level are compliance
 * rules the validator applies, not schema constraints. `delivery.baseRef`/`headRef` name the
 * revisions repovine computes the change-set delta between; their absence leaves the delta
 * unavailable.
 */
export const AgentAssignmentSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  runId: z.string().min(1),
  role: AgentRoleSchema,
  task: z.string().min(1),
  scope: z.array(z.string()),
  version: z.number().int().min(1),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema),
  constraints: z.array(z.string()),
  contracts: z.array(z.string()),
  requestedChecks: z.array(RequestedCheckSchema),
  delivery: z.object({
    baseRef: z.string().min(1).optional(),
    headRef: z.string().min(1).optional(),
  }).optional(),
  verificationPolicy: VerificationPolicySchema.optional(),
  contextSession: ContextSessionPolicySchema.optional(),
  priorContext: PriorContextSchema.optional(),
});
export type AgentAssignment = z.infer<typeof AgentAssignmentSchema>;

// ── AgentRunResult ──

/**
 * Self-reported compliance flags. `annotationsClean` is the one flag repovine re-checks against
 * observable state: a `true` claim over a queue that still needs work is an error. `refreshContextRun`
 * is read only in the `false` direction, against a non-empty `filesChanged`. `architectureChecked` is
 * compared with the presence of `architectureAudit`, itself self-reported. The remaining three stand
 * as the run declares them, and serve as the evidence that a requested check was performed.
 */
export const ComplianceFlagsSchema = z.object({
  refreshContextRun: z.boolean(),
  annotationsClean: z.boolean(),
  dependencyImpactChecked: z.boolean(),
  configSurfaceChecked: z.boolean(),
  flowChecked: z.boolean(),
  architectureChecked: z.boolean(),
});
export type ComplianceFlags = z.infer<typeof ComplianceFlagsSchema>;

/** Optional diagnostic trace of internal subagent coordination. */
export const InternalTraceSchema = z.object({
  subagentsUsed: z.array(z.string()),
  handoffCount: z.number().int().min(0),
});
export type InternalTrace = z.infer<typeof InternalTraceSchema>;

/**
 * The stable public artifact an external harness collects after a run. Internal
 * subagent topology is an implementation detail behind this aggregated result.
 */
export const AgentRunResultSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  runId: z.string().min(1),
  status: RunStatusSchema,
  summary: z.string(),
  scope: z.array(z.string()),
  filesChanged: z.array(z.string()),
  graphNodesTouched: z.array(z.string()),
  contractsChanged: z.array(z.string()),
  testsRun: z.array(z.string()),
  annotationsWritten: z.array(z.string()),
  compliance: ComplianceFlagsSchema,
  blockers: z.array(z.string()),
  contextSessionId: z.string().min(1).optional(),
  contextQuality: ContextQualitySummarySchema.optional(),
  contextPack: ContextPackSchema.optional(),
  architectureAudit: ArchitectureAuditResultSchema.optional(),
  review: CodeReviewResultSchema.optional(),
  deliveryVerification: DeliveryVerificationResultSchema.optional(),
  internalTrace: InternalTraceSchema.optional(),
});
export type AgentRunResult = z.infer<typeof AgentRunResultSchema>;

export const ReviewInputSchema = z.object({
  assignment: AgentAssignmentSchema,
  priorContext: PriorContextSchema.optional(),
  implementationResult: AgentRunResultSchema,
  diffBase: z.string().min(1),
  changedFiles: z.array(z.string()),
  graphNodesTouched: z.array(z.string()),
});
export type ReviewInput = z.infer<typeof ReviewInputSchema>;

// ── AgentComplianceReport ──

/** repovine validation output. Constructed by the validator, never parsed from input. */
export const AgentComplianceReportSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  runId: z.string(),
  valid: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  /**
   * Machine-readable companion to `errors`: one entry per error, in the same order, each carrying a
   * stable `code` beside the verbatim `message`. Consumers classify by `code` without matching prose.
   * `.default([])` keeps pre-diagnostics report literals valid.
   */
  diagnostics: z.array(z.object({ code: z.string(), message: z.string() })).default([]),
  missingFields: z.array(z.string()),
  staleAnnotations: z.array(z.string()),
  orphanedAnnotations: z.array(z.string()),
  missingAnnotations: z.array(z.string()),
  /**
   * Observable annotation-grounding facts (mode-independent), surfaced structurally so any consumer
   * can apply its own policy without parsing warning text. ungroundedAnnotations: written code-module
   * nodeIds not inspected/edited in the same session (provenance). inconsistentAnnotations: written
   * code-module notes whose filled fields contradict graph facts — HARD only (keyExports/sideEffects);
   * advisory env mismatches stay in warnings, never here. The engine's own error/warning severity is
   * unchanged; these are observations, not a verdict.
   */
  ungroundedAnnotations: z.array(z.string()).default([]),
  inconsistentAnnotations: z.array(z.object({
    nodeId: z.string(),
    issues: z.array(z.string()),
  })).default([]),
  unresolvedGraphNodes: z.array(z.string()),
  scopeCollisions: z.array(z.string()),
  requiredFollowups: z.array(z.string()),
  contextQuality: ContextQualityReportSchema.optional(),
});
export type AgentComplianceReport = z.infer<typeof AgentComplianceReportSchema>;

// ── Internal protocol objects ──
// Same schema family, but not the primary external API. Useful for main-agent
// orchestration; external harnesses should consume AgentRunResult.

/** A scoped assignment handed from a main agent to a sub-agent. */
export const SubagentAssignmentSchema = AgentAssignmentSchema.extend({
  parentRunId: z.string().min(1),
  subRunId: z.string().min(1),
  agentName: z.string().min(1),
  role: z.enum(['explorer', 'implementer', 'annotation-writer', 'architecture-auditor', 'code-reviewer']),
});
export type SubagentAssignment = z.infer<typeof SubagentAssignmentSchema>;

/** A subagent's reply to its parent. `claims` is a partial run result. */
export const SubagentHandoffSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  parentRunId: z.string().min(1),
  subRunId: z.string().min(1),
  agentName: z.string().min(1),
  role: z.string(),
  status: RunStatusSchema,
  claims: AgentRunResultSchema.partial(),
  blockers: z.array(z.string()),
});
export type SubagentHandoff = z.infer<typeof SubagentHandoffSchema>;

// ── AgentProtocol descriptor ──

/** Describes the protocol version, available schema ids, and surfaces. */
export const AgentProtocolSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  schemas: z.object({
    agentManifest: z.string(),
    agentAssignment: z.string(),
    agentRunResult: z.string(),
    agentComplianceReport: z.string(),
    contextPack: z.string(),
    architectureAuditResult: z.string(),
    codeReviewResult: z.string(),
    reviewInput: z.string(),
    deliveryVerificationResult: z.string(),
  }),
  mcpTools: z.array(z.string()),
  cliCommands: z.array(z.string()),
});
export type AgentProtocol = z.infer<typeof AgentProtocolSchema>;

/** Stable schema-id names referenced by the AgentProtocol descriptor. */
export const SCHEMA_IDS = {
  agentManifest: 'AgentManifest',
  agentAssignment: 'AgentAssignment',
  agentRunResult: 'AgentRunResult',
  agentComplianceReport: 'AgentComplianceReport',
  contextPack: 'ContextPack',
  architectureAuditResult: 'ArchitectureAuditResult',
  codeReviewResult: 'CodeReviewResult',
  reviewInput: 'ReviewInput',
  deliveryVerificationResult: 'DeliveryVerificationResult',
} as const;

/** Agent Protocol is CLI-only for harness/integration; worker MCP exposes context tools only. */
export const AGENT_PROTOCOL_MCP_TOOLS = [] as const;

/** CLI commands for harness/integration (`repovine agents <cmd>`). */
export const AGENT_PROTOCOL_CLI_COMMANDS = [
  'agents protocol',
  'agents manifests',
  'agents validate-assignment',
  'agents validate-result',
  'agents validate-review-input',
  'agents compliance',
  'agents session-quality',
  'agents run-brief',
  'agents roles',
  'agents orient',
] as const;

/** Build the AgentProtocol descriptor object. */
export function buildAgentProtocol(): AgentProtocol {
  return {
    protocolVersion: PROTOCOL_VERSION,
    schemas: { ...SCHEMA_IDS },
    mcpTools: [...AGENT_PROTOCOL_MCP_TOOLS],
    cliCommands: [...AGENT_PROTOCOL_CLI_COMMANDS],
  };
}

// ── JSON Schema export (for non-TypeScript / non-MCP harnesses) ──

/** JSON Schema for each public protocol object, keyed by schema id. */
export const AGENT_JSON_SCHEMAS: Record<string, unknown> = {
  [SCHEMA_IDS.agentManifest]: toJSONSchema(AgentManifestSchema),
  [SCHEMA_IDS.agentAssignment]: toJSONSchema(AgentAssignmentSchema),
  [SCHEMA_IDS.agentRunResult]: toJSONSchema(AgentRunResultSchema),
  [SCHEMA_IDS.agentComplianceReport]: toJSONSchema(AgentComplianceReportSchema),
  [SCHEMA_IDS.contextPack]: toJSONSchema(ContextPackSchema),
  [SCHEMA_IDS.architectureAuditResult]: toJSONSchema(ArchitectureAuditResultSchema),
  [SCHEMA_IDS.codeReviewResult]: toJSONSchema(CodeReviewResultSchema),
  [SCHEMA_IDS.reviewInput]: toJSONSchema(ReviewInputSchema),
  [SCHEMA_IDS.deliveryVerificationResult]: toJSONSchema(DeliveryVerificationResultSchema),
};
