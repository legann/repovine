export const CONTEXT_PHASES = ['explore', 'implement', 'annotate'] as const;
export type ContextPhase = typeof CONTEXT_PHASES[number];

export const CONTEXT_ENFORCEMENT_MODES = ['harness', 'client'] as const;
export type ContextEnforcementMode = typeof CONTEXT_ENFORCEMENT_MODES[number];

/**
 * Why a session's recorded call sequence did not clear the quality bar.
 *
 * Not a refusal, and kept apart from the engine's refusal vocabulary (`response/refusal.ts`) on
 * purpose. Three differences decide it, and all three are in the code:
 *
 * - **Subject.** A refusal answers one request the engine would not serve. A member here is a fact
 *   about a whole recorded sequence — how many calls searched without mapping, how many bytes the
 *   session accumulated, what it ended on. `calculateReport` never sees a graph or a scope; its
 *   only input is `ContextSession.events`.
 * - **Delivery.** The report ships inside a SUCCESS envelope at `confidence: 'high'`
 *   (`mcp/tools/context-session-quality.ts`). The refusals in that same handler are `envelopeError`.
 *   A low score is a finding in `result`, not a failure to answer.
 * - **Authority.** It has none: `CONTEXT_QUALITY_HARD_GATE_VALIDATED` is false, so both gates in
 *   `agents/validation.ts` degrade to warnings, and the CLI returns 0 regardless.
 *
 * Two members do read the other vocabularies rather than duplicate them: `UNRESOLVED_SCOPE` counts
 * how often the engine answered with `SCOPE_UNRESOLVED` or a refusal, and `LOW_CONFIDENCE_CONTEXT`
 * counts how often it answered at low confidence. Both are counts OF those answers, not peers of
 * them, which is why they are computed from the published response in `metrics.ts` rather than
 * produced alongside it.
 */
export type ContextRejectReason =
  | 'QUALITY_BELOW_THRESHOLD'
  | 'OR_WITHOUT_RECOVERY'
  | 'CAPABILITY_FLOOD'
  | 'SEARCH_WITHOUT_MAP'
  | 'UNRESOLVED_SCOPE'
  | 'TEST_PACKAGE_ANCHOR'
  | 'BYTE_BUDGET_EXCEEDED'
  | 'ARCH_RESPONSE_OVERSIZE'
  | 'NO_STABLE_ANCHORS'
  | 'ENDED_ON_SEARCH'
  | 'LOW_CONFIDENCE_CONTEXT'
  | 'NO_RECORDED_EVENTS';

export interface ContextSessionPolicy {
  required?: boolean;
  /** Harness strict gate vs client advisory warnings. Assignment overrides repo default. */
  mode?: ContextEnforcementMode;
  phase?: ContextPhase;
  qualityThreshold?: number;
  warningThreshold?: number;
  minAnchors?: number;
  byteBudget?: number;
  maxRecoveryAttempts?: number;
  assignmentScope?: string[];
  retain?: boolean;
}

export interface ContextQualityWeights {
  or: number;
  cap: number;
  volume: number;
  low: number;
  unresolved: number;
  test: number;
  bytes: number;
  chain: number;
  map: number;
  inspect: number;
  impact: number;
  anchor: number;
  recover: number;
  end: number;
}

export interface ContextQualityThreshold {
  threshold: number;
  warningThreshold: number;
  minAnchors: number;
  byteBudget: number;
}

export interface ContextQualityEnforcementConfig {
  mode: ContextEnforcementMode;
}

export interface ContextQualityConfig {
  weights: ContextQualityWeights;
  thresholds: Record<ContextPhase, ContextQualityThreshold>;
  enforcement: ContextQualityEnforcementConfig;
  recoveryWindow: number;
  recoveryDiscount: number;
  exportSymbolFloodRatio: number;
  archResponseOversizeBytes: number;
  lowConfidenceRejectRatio: number;
  testPackageRegex: string;
  retainSessions: boolean;
  persistEvents: boolean;
  maxRequestEchoes: number;
  /** When true, MCP startup purges persisted context sessions (default follows enforcement.mode). */
  purgeSessionsOnMcpStart: boolean;
}

export interface ContextEventMetrics {
  confidence?: string;
  resolvedScopeKind?: string;
  resolvedScopeId?: string;
  emptyDiagnosticReason?: string;
  hasEmptyDiagnostic: boolean;
  hasError: boolean;
  unresolvedScope: boolean;
  isOrSearch: boolean;
  capRatio: number;
  totalResults: number;
  returned: number;
  truncated: boolean;
  capabilityDominantSearch: boolean;
  testPackageHit: boolean;
  stableAnchor?: string;
  hadImpactOnModule: boolean;
  returnedFindings?: number;
  emptyResult: boolean;
}

export interface ContextEvent {
  seq: number;
  tool: string;
  at: string;
  responseBytes: number;
  requestEcho: Record<string, unknown>;
  metrics: ContextEventMetrics;
}

export interface ContextRequestEcho {
  seq: number;
  tool: string;
  responseBytes: number;
  request: Record<string, unknown>;
}

export interface ContextSession {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  events: ContextEvent[];
  aggregates?: ContextSessionAggregates;
  requestEchoes?: ContextRequestEcho[];
}

export interface ContextSessionAggregates {
  toolCallCount: number;
  searchCallCount: number;
  mapCallCount: number;
  inspectCallCount: number;
  totalResponseBytes: number;
  maxSingleResponseBytes: number;
  maxArchitectureResponseBytes: number;
  maxTotalResultsInSearch: number;
  orSearchCount: number;
  recoveredOrSearchCount: number;
  unrecoveredOrSearchCount: number;
  lowConfidenceCount: number;
  unresolvedScopeCount: number;
  capabilityDominantSearchCount: number;
  avgCapRatio: number;
  testPackageHitCount: number;
  stableAnchors: string[];
  recoveredFromNoise: boolean;
  hadImpactOnModule: boolean;
  endedWithSearchOnly: boolean;
  lastTool?: string;
  lastResolvedScope?: string;
}

export interface ContextQualityReport {
  sessionId: string;
  phase: ContextPhase;
  overall: number;
  noisePenalty: number;
  structureBonus: number;
  acceptHandoff: boolean;
  belowWarningThreshold: boolean;
  rejectReasons: ContextRejectReason[];
  warnings: string[];
  requiredFollowups: string[];
  aggregates: ContextSessionAggregates;
  policy: {
    required: boolean;
    mode: ContextEnforcementMode;
    qualityThreshold: number;
    warningThreshold: number;
    minAnchors: number;
    byteBudget: number;
    maxRecoveryAttempts?: number;
    retain: boolean;
  };
  requestEchoes: ContextRequestEcho[];
  events?: ContextEvent[];
}
