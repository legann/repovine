import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildContextEvent } from './metrics.js';
import type {
  ContextEvent,
  ContextEnforcementMode,
  ContextPhase,
  ContextQualityConfig,
  ContextQualityReport,
  ContextRequestEcho,
  ContextRejectReason,
  ContextSession,
  ContextSessionAggregates,
  ContextSessionPolicy,
} from './types.js';

export const DEFAULT_CONTEXT_QUALITY_CONFIG: ContextQualityConfig = {
  weights: {
    or: 0.22,
    cap: 0.18,
    volume: 0.12,
    low: 0.16,
    unresolved: 0.14,
    test: 0.10,
    bytes: 0.18,
    chain: 0.10,
    map: 0.18,
    inspect: 0.18,
    impact: 0.22,
    anchor: 0.22,
    recover: 0.10,
    end: 0.15,
  },
  thresholds: {
    explore: { threshold: 0.40, warningThreshold: 0.55, minAnchors: 1, byteBudget: 80_000 },
    implement: { threshold: 0.55, warningThreshold: 0.70, minAnchors: 1, byteBudget: 120_000 },
    annotate: { threshold: 0.35, warningThreshold: 0.50, minAnchors: 0, byteBudget: 100_000 },
  },
  enforcement: { mode: 'client' },
  purgeSessionsOnMcpStart: true,
  recoveryWindow: 3,
  recoveryDiscount: 0.3,
  exportSymbolFloodRatio: 0.7,
  archResponseOversizeBytes: 100_000,
  lowConfidenceRejectRatio: 0.5,
  testPackageRegex: '(^pkg:|-)test(-|_)|fixtures|ftr_',
  retainSessions: false,
  persistEvents: false,
  maxRequestEchoes: 20,
};

export interface ContextSessionStoreOptions {
  repoRoot: string;
  config?: ContextQualityConfig;
}

export interface RecordToolCallInput {
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  responseText: string;
}

export interface ResolvedContextSessionPolicy {
  phase: ContextPhase;
  mode: ContextEnforcementMode;
  qualityThreshold: number;
  warningThreshold: number;
  minAnchors: number;
  byteBudget: number;
  maxRecoveryAttempts?: number;
  required: boolean;
  retain: boolean;
}

export function resolveContextSessionPolicy(
  policy: ContextSessionPolicy = {},
  config: ContextQualityConfig = DEFAULT_CONTEXT_QUALITY_CONFIG,
): ResolvedContextSessionPolicy {
  const phase = policy.phase ?? 'explore';
  const phaseThreshold = config.thresholds[phase];
  return {
    phase,
    mode: policy.mode ?? config.enforcement.mode,
    qualityThreshold: policy.qualityThreshold ?? phaseThreshold.threshold,
    warningThreshold: policy.warningThreshold ?? phaseThreshold.warningThreshold,
    minAnchors: policy.minAnchors ?? phaseThreshold.minAnchors,
    byteBudget: policy.byteBudget ?? phaseThreshold.byteBudget,
    ...(policy.maxRecoveryAttempts !== undefined ? { maxRecoveryAttempts: policy.maxRecoveryAttempts } : {}),
    required: policy.required === true,
    retain: policy.retain === true,
  };
}

export interface GetContextQualityReportOptions {
  policy?: ContextSessionPolicy;
  includeEvents?: boolean;
  consume?: boolean;
  retain?: boolean;
}

export class ContextSessionStore {
  private readonly sessions = new Map<string, ContextSession>();
  private readonly sessionDir: string;
  private readonly config: ContextQualityConfig;
  private readonly testPackageRegex: RegExp;

  constructor(options: ContextSessionStoreOptions) {
    this.sessionDir = path.join(options.repoRoot, '.repovine', '.cache', 'sessions');
    this.config = options.config ?? DEFAULT_CONTEXT_QUALITY_CONFIG;
    this.testPackageRegex = compileRegex(this.config.testPackageRegex, DEFAULT_CONTEXT_QUALITY_CONFIG.testPackageRegex);
  }

  getConfig(): ContextQualityConfig {
    return this.config;
  }

  recordToolCall(input: RecordToolCallInput): void {
    const sessionId = normalizeSessionId(input.sessionId);
    if (!sessionId) return;
    const session = this.getOrCreateSession(sessionId);
    const previousCount = session.events.length > 0
      ? session.events.at(-1)!.seq
      : session.aggregates?.toolCallCount ?? 0;
    const event = buildContextEvent({
      seq: previousCount + 1,
      tool: input.tool,
      args: input.args,
      result: input.result,
      responseText: input.responseText,
      testPackageRegex: this.testPackageRegex,
      exportSymbolFloodRatio: this.config.exportSymbolFloodRatio,
    });
    session.events.push(event);
    session.updatedAt = event.at;
    this.persist(session);
  }

  getReport(sessionId: string, options: GetContextQualityReportOptions = {}): ContextQualityReport | undefined {
    const normalized = normalizeSessionId(sessionId);
    if (!normalized) return undefined;
    const session = this.getOrLoadSession(normalized);
    if (!session) return undefined;
    const report = calculateReport(session, this.config, options.policy, options.includeEvents === true);
    if (options.consume === true) {
      this.consumeSession(normalized, { retain: options.retain === true || options.policy?.retain === true });
    }
    return report;
  }

  consumeSession(sessionId: string, options: { retain?: boolean } = {}): boolean {
    if (options.retain === true || this.config.retainSessions) return false;
    return this.deleteSession(sessionId);
  }

  deleteSession(sessionId: string): boolean {
    const normalized = normalizeSessionId(sessionId);
    if (!normalized) return false;
    this.sessions.delete(normalized);
    try {
      fs.rmSync(this.sessionFile(normalized), { force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Delete every persisted context session and clear the in-process cache. */
  purgeAllSessions(): number {
    this.sessions.clear();
    let purged = 0;
    try {
      if (!fs.existsSync(this.sessionDir)) return 0;
      for (const entry of fs.readdirSync(this.sessionDir)) {
        if (!entry.endsWith('.json')) continue;
        const file = path.join(this.sessionDir, entry);
        try {
          fs.rmSync(file, { force: true });
          purged++;
        } catch {
          // Best-effort cleanup; never block MCP startup.
        }
      }
    } catch {
      return purged;
    }
    return purged;
  }

  private getOrCreateSession(sessionId: string): ContextSession {
    const existing = this.getOrLoadSession(sessionId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const session: ContextSession = {
      sessionId,
      createdAt: now,
      updatedAt: now,
      events: [],
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  private getOrLoadSession(sessionId: string): ContextSession | undefined {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const file = this.sessionFile(sessionId);
    try {
      if (!fs.existsSync(file)) return undefined;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<ContextSession>;
      const events = Array.isArray(parsed.events) ? parsed.events.filter(isContextEvent) : [];
      const aggregates = isContextSessionAggregates(parsed.aggregates) ? parsed.aggregates : undefined;
      const requestEchoes = Array.isArray(parsed.requestEchoes) ? parsed.requestEchoes.filter(isContextRequestEcho) : undefined;
      if (parsed.sessionId !== sessionId || (events.length === 0 && !aggregates)) return undefined;
      const session: ContextSession = {
        sessionId,
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
        events,
        ...(aggregates ? { aggregates } : {}),
        ...(requestEchoes ? { requestEchoes } : {}),
      };
      this.sessions.set(sessionId, session);
      return session;
    } catch {
      return undefined;
    }
  }

  private persist(session: ContextSession): void {
    try {
      fs.mkdirSync(this.sessionDir, { recursive: true });
      const compactSession = compactForPersistence(session, this.config);
      const file = this.sessionFile(session.sessionId);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(compactSession)}\n`);
      fs.renameSync(tmp, file);
      session.aggregates = compactSession.aggregates;
      session.requestEchoes = compactSession.requestEchoes;
      if (!this.config.persistEvents && session.events[0]?.seq !== 1) {
        session.events = [];
      }
    } catch {
      // Session quality is advisory; never fail the user's primary MCP tool call.
    }
  }

  private sessionFile(sessionId: string): string {
    return path.join(this.sessionDir, `${sessionId}.json`);
  }
}

export function calculateReport(
  session: ContextSession,
  config: ContextQualityConfig,
  policy: ContextSessionPolicy = {},
  includeEvents = false,
): ContextQualityReport {
  const resolved = resolveContextSessionPolicy(policy, config);
  const { phase, mode, qualityThreshold, warningThreshold, minAnchors, byteBudget } = resolved;
  const aggregates = aggregatesForSession(session, config);
  const noisePenalty = calculateNoisePenalty(aggregates, config, byteBudget);
  const structureBonus = calculateStructureBonus(aggregates, config);
  const overall = clamp01(structureBonus - noisePenalty);
  const rejectReasons = buildRejectReasons({
    aggregates,
    config,
    overall,
    qualityThreshold,
    minAnchors,
    byteBudget,
  });
  const acceptHandoff =
    rejectReasons.length === 0
    && overall >= qualityThreshold
    && aggregates.stableAnchors.length >= minAnchors
    && !aggregates.endedWithSearchOnly;
  const belowWarningThreshold = overall < warningThreshold;
  const warnings = buildContextQualityWarnings({
    overall,
    acceptHandoff,
    belowWarningThreshold,
    warningThreshold,
    mode,
    rejectReasons,
  });

  const report: ContextQualityReport = {
    sessionId: session.sessionId,
    phase,
    overall,
    noisePenalty,
    structureBonus,
    acceptHandoff,
    belowWarningThreshold,
    rejectReasons,
    warnings,
    requiredFollowups: followupsFor(rejectReasons, { belowWarningThreshold, acceptHandoff }),
    aggregates,
    policy: {
      required: resolved.required,
      mode,
      qualityThreshold,
      warningThreshold,
      minAnchors,
      byteBudget,
      ...(resolved.maxRecoveryAttempts !== undefined ? { maxRecoveryAttempts: resolved.maxRecoveryAttempts } : {}),
      retain: resolved.retain,
    },
    requestEchoes: requestEchoesForSession(session, config.maxRequestEchoes),
  };
  if (includeEvents && session.events.length > 0) report.events = session.events;
  return report;
}

function compactForPersistence(session: ContextSession, config: ContextQualityConfig): ContextSession {
  const compact: ContextSession = {
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    events: config.persistEvents ? session.events : [],
    aggregates: aggregatesForSession(session, config),
    requestEchoes: requestEchoesForSession(session, config.maxRequestEchoes),
  };
  return { ...compact, version: 2 } as ContextSession;
}

function aggregatesForSession(session: ContextSession, config: ContextQualityConfig): ContextSessionAggregates {
  const eventAggregates = session.events.length > 0 ? aggregateSession(session.events, config) : undefined;
  if (!session.aggregates) return eventAggregates ?? emptyAggregates();
  if (!eventAggregates) return session.aggregates;
  if (session.events[0]?.seq === 1) return eventAggregates;
  return mergeAggregates(session.aggregates, eventAggregates);
}

function requestEchoesForSession(session: ContextSession, maxRequestEchoes: number): ContextRequestEcho[] {
  const eventEchoes = session.events.map(event => ({
    seq: event.seq,
    tool: event.tool,
    responseBytes: event.responseBytes,
    request: event.requestEcho,
  }));
  const combined =
    session.events[0]?.seq === 1
      ? eventEchoes
      : [...(session.requestEchoes ?? []), ...eventEchoes];
  return combined.slice(-Math.max(0, maxRequestEchoes));
}

function aggregateSession(events: ContextEvent[], config: ContextQualityConfig): ContextSessionAggregates {
  const stableAnchors = new Set<string>();
  let searchCallCount = 0;
  let mapCallCount = 0;
  let inspectCallCount = 0;
  let totalResponseBytes = 0;
  let maxSingleResponseBytes = 0;
  let maxArchitectureResponseBytes = 0;
  let maxTotalResultsInSearch = 0;
  let orSearchCount = 0;
  let recoveredOrSearchCount = 0;
  let lowConfidenceCount = 0;
  let unresolvedScopeCount = 0;
  let capabilityDominantSearchCount = 0;
  let capRatioSum = 0;
  let testPackageHitCount = 0;
  let hadImpactOnModule = false;
  let lastResolvedScope: string | undefined;

  const searchIndexesNeedingRecovery: number[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    totalResponseBytes += event.responseBytes;
    maxSingleResponseBytes = Math.max(maxSingleResponseBytes, event.responseBytes);
    if (event.tool === 'analyze_architecture') {
      maxArchitectureResponseBytes = Math.max(maxArchitectureResponseBytes, event.responseBytes);
    }
    if (event.tool === 'search_context') {
      searchCallCount++;
      capRatioSum += event.metrics.capRatio;
      maxTotalResultsInSearch = Math.max(maxTotalResultsInSearch, event.metrics.totalResults);
      if (event.metrics.isOrSearch) {
        orSearchCount++;
        searchIndexesNeedingRecovery.push(i);
      }
      if (event.metrics.capabilityDominantSearch) capabilityDominantSearchCount++;
    }
    if (event.tool === 'map_context') mapCallCount++;
    if (event.tool === 'inspect_node') inspectCallCount++;
    if (event.metrics.confidence === 'low') lowConfidenceCount++;
    if (event.metrics.unresolvedScope) unresolvedScopeCount++;
    if (event.metrics.testPackageHit) testPackageHitCount++;
    if (event.metrics.stableAnchor) {
      stableAnchors.add(event.metrics.stableAnchor);
      lastResolvedScope = event.metrics.stableAnchor;
    } else if (event.metrics.resolvedScopeId) {
      lastResolvedScope = event.metrics.resolvedScopeId;
    }
    if (event.metrics.hadImpactOnModule) hadImpactOnModule = true;
  }

  for (const searchIndex of searchIndexesNeedingRecovery) {
    const end = Math.min(events.length - 1, searchIndex + config.recoveryWindow);
    for (let i = searchIndex + 1; i <= end; i++) {
      const event = events[i];
      if ((event.tool === 'map_context' || event.tool === 'inspect_node') && event.metrics.stableAnchor) {
        recoveredOrSearchCount++;
        break;
      }
    }
  }

  const lastTool = events.at(-1)?.tool;
  return {
    toolCallCount: events.length,
    searchCallCount,
    mapCallCount,
    inspectCallCount,
    totalResponseBytes,
    maxSingleResponseBytes,
    maxArchitectureResponseBytes,
    maxTotalResultsInSearch,
    orSearchCount,
    recoveredOrSearchCount,
    unrecoveredOrSearchCount: Math.max(0, orSearchCount - recoveredOrSearchCount),
    lowConfidenceCount,
    unresolvedScopeCount,
    capabilityDominantSearchCount,
    avgCapRatio: searchCallCount > 0 ? capRatioSum / searchCallCount : 0,
    testPackageHitCount,
    stableAnchors: [...stableAnchors],
    recoveredFromNoise: recoveredOrSearchCount > 0,
    hadImpactOnModule,
    endedWithSearchOnly: lastTool === 'search_context' && searchCallCount > 0,
    ...(lastTool ? { lastTool } : {}),
    ...(lastResolvedScope ? { lastResolvedScope } : {}),
  };
}

function emptyAggregates(): ContextSessionAggregates {
  return {
    toolCallCount: 0,
    searchCallCount: 0,
    mapCallCount: 0,
    inspectCallCount: 0,
    totalResponseBytes: 0,
    maxSingleResponseBytes: 0,
    maxArchitectureResponseBytes: 0,
    maxTotalResultsInSearch: 0,
    orSearchCount: 0,
    recoveredOrSearchCount: 0,
    unrecoveredOrSearchCount: 0,
    lowConfidenceCount: 0,
    unresolvedScopeCount: 0,
    capabilityDominantSearchCount: 0,
    avgCapRatio: 0,
    testPackageHitCount: 0,
    stableAnchors: [],
    recoveredFromNoise: false,
    hadImpactOnModule: false,
    endedWithSearchOnly: false,
  };
}

function mergeAggregates(a: ContextSessionAggregates, b: ContextSessionAggregates): ContextSessionAggregates {
  const searchCallCount = a.searchCallCount + b.searchCallCount;
  const avgCapRatio = searchCallCount > 0
    ? ((a.avgCapRatio * a.searchCallCount) + (b.avgCapRatio * b.searchCallCount)) / searchCallCount
    : 0;
  return {
    toolCallCount: a.toolCallCount + b.toolCallCount,
    searchCallCount,
    mapCallCount: a.mapCallCount + b.mapCallCount,
    inspectCallCount: a.inspectCallCount + b.inspectCallCount,
    totalResponseBytes: a.totalResponseBytes + b.totalResponseBytes,
    maxSingleResponseBytes: Math.max(a.maxSingleResponseBytes, b.maxSingleResponseBytes),
    maxArchitectureResponseBytes: Math.max(a.maxArchitectureResponseBytes, b.maxArchitectureResponseBytes),
    maxTotalResultsInSearch: Math.max(a.maxTotalResultsInSearch, b.maxTotalResultsInSearch),
    orSearchCount: a.orSearchCount + b.orSearchCount,
    recoveredOrSearchCount: a.recoveredOrSearchCount + b.recoveredOrSearchCount,
    unrecoveredOrSearchCount: a.unrecoveredOrSearchCount + b.unrecoveredOrSearchCount,
    lowConfidenceCount: a.lowConfidenceCount + b.lowConfidenceCount,
    unresolvedScopeCount: a.unresolvedScopeCount + b.unresolvedScopeCount,
    capabilityDominantSearchCount: a.capabilityDominantSearchCount + b.capabilityDominantSearchCount,
    avgCapRatio,
    testPackageHitCount: a.testPackageHitCount + b.testPackageHitCount,
    stableAnchors: [...new Set([...a.stableAnchors, ...b.stableAnchors])],
    recoveredFromNoise: a.recoveredFromNoise || b.recoveredFromNoise,
    hadImpactOnModule: a.hadImpactOnModule || b.hadImpactOnModule,
    endedWithSearchOnly: b.toolCallCount > 0 ? b.endedWithSearchOnly : a.endedWithSearchOnly,
    ...(b.lastTool ?? a.lastTool ? { lastTool: b.lastTool ?? a.lastTool } : {}),
    ...(b.lastResolvedScope ?? a.lastResolvedScope ? { lastResolvedScope: b.lastResolvedScope ?? a.lastResolvedScope } : {}),
  };
}

function calculateNoisePenalty(
  aggregates: ContextSessionAggregates,
  config: ContextQualityConfig,
  byteBudget: number,
): number {
  const w = config.weights;
  const effectiveOrSearchCount =
    aggregates.unrecoveredOrSearchCount
    + aggregates.recoveredOrSearchCount * config.recoveryDiscount;
  const searchDenom = Math.max(1, aggregates.searchCallCount);
  const toolDenom = Math.max(1, aggregates.toolCallCount);
  const scopedDenom = Math.max(1, aggregates.searchCallCount + aggregates.mapCallCount);
  return clamp01(
    w.or * (effectiveOrSearchCount / searchDenom)
    + w.cap * aggregates.avgCapRatio
    + w.volume * Math.min(1, Math.log10(1 + aggregates.maxTotalResultsInSearch) / 3)
    + w.low * (aggregates.lowConfidenceCount / toolDenom)
    + w.unresolved * (aggregates.unresolvedScopeCount / scopedDenom)
    + w.test * Math.min(1, aggregates.testPackageHitCount / searchDenom)
    + w.bytes * Math.min(1, aggregates.totalResponseBytes / Math.max(1, byteBudget))
    + w.chain * Math.min(1, Math.max(0, aggregates.searchCallCount - aggregates.mapCallCount - 1) / 3),
  );
}

function calculateStructureBonus(aggregates: ContextSessionAggregates, config: ContextQualityConfig): number {
  const w = config.weights;
  const endedOnScopedTool =
    (aggregates.lastTool === 'inspect_node' || aggregates.lastTool === 'analyze_dependencies')
    && !!aggregates.lastResolvedScope;
  return clamp01(
    w.map * Math.min(1, aggregates.mapCallCount / 2)
    + w.inspect * Math.min(1, aggregates.inspectCallCount / 2)
    + w.impact * (aggregates.hadImpactOnModule ? 1 : 0)
    + w.anchor * Math.min(1, aggregates.stableAnchors.length / 3)
    + w.recover * (aggregates.recoveredFromNoise ? 1 : 0)
    + w.end * (endedOnScopedTool ? 1 : 0),
  );
}

function buildRejectReasons(input: {
  aggregates: ContextSessionAggregates;
  config: ContextQualityConfig;
  overall: number;
  qualityThreshold: number;
  minAnchors: number;
  byteBudget: number;
}): ContextRejectReason[] {
  const { aggregates, config, overall, qualityThreshold, minAnchors, byteBudget } = input;
  const reasons: ContextRejectReason[] = [];
  if (aggregates.toolCallCount === 0) reasons.push('NO_RECORDED_EVENTS');
  if (overall < qualityThreshold) reasons.push('QUALITY_BELOW_THRESHOLD');
  // Behavioral navigation-shape signals are quality-gated (like UNRESOLVED_SCOPE and
  // CAPABILITY_FLOOD): an unrecovered OR search co-explains a weak session; it does not
  // by itself reject a session whose overall score clears the hard threshold.
  if (aggregates.unrecoveredOrSearchCount > 0 && overall < qualityThreshold) reasons.push('OR_WITHOUT_RECOVERY');
  if (aggregates.capabilityDominantSearchCount > 0 && overall < qualityThreshold) reasons.push('CAPABILITY_FLOOD');
  if (aggregates.searchCallCount >= 2 && aggregates.mapCallCount === 0) reasons.push('SEARCH_WITHOUT_MAP');
  if (aggregates.unresolvedScopeCount > 0 && overall < qualityThreshold) reasons.push('UNRESOLVED_SCOPE');
  if (aggregates.testPackageHitCount > 0) reasons.push('TEST_PACKAGE_ANCHOR');
  if (aggregates.totalResponseBytes > byteBudget) reasons.push('BYTE_BUDGET_EXCEEDED');
  if (aggregates.maxArchitectureResponseBytes > config.archResponseOversizeBytes) reasons.push('ARCH_RESPONSE_OVERSIZE');
  if (aggregates.stableAnchors.length < minAnchors) reasons.push('NO_STABLE_ANCHORS');
  if (aggregates.endedWithSearchOnly) reasons.push('ENDED_ON_SEARCH');
  if (aggregates.toolCallCount > 0 && aggregates.lowConfidenceCount / aggregates.toolCallCount > config.lowConfidenceRejectRatio) {
    reasons.push('LOW_CONFIDENCE_CONTEXT');
  }
  return [...new Set(reasons)];
}

function buildContextQualityWarnings(input: {
  overall: number;
  acceptHandoff: boolean;
  belowWarningThreshold: boolean;
  warningThreshold: number;
  mode: ContextEnforcementMode;
  rejectReasons: ContextRejectReason[];
}): string[] {
  const warnings: string[] = [];
  const add = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };
  if (input.belowWarningThreshold && input.acceptHandoff) {
    add(
      `Context session score (${input.overall}) is below warningThreshold (${input.warningThreshold}); `
      + 'perform targeted code review because repovine context was weak.',
    );
  }
  if (!input.acceptHandoff && input.mode === 'client') {
    add(
      `Context session did not meet acceptHandoff (overall=${input.overall}); `
      + 'client advisory mode allows continuation, but verify edits with extra review.',
    );
  }
  if (input.rejectReasons.includes('NO_RECORDED_EVENTS')) {
    add('No repovine MCP tool calls were recorded for this contextSessionId.');
  }
  return warnings;
}

function followupsFor(
  reasons: ContextRejectReason[],
  options: { belowWarningThreshold: boolean; acceptHandoff: boolean } = { belowWarningThreshold: false, acceptHandoff: true },
): string[] {
  const out: string[] = [];
  const add = (message: string) => {
    if (!out.includes(message)) out.push(message);
  };
  for (const reason of reasons) {
    switch (reason) {
      case 'QUALITY_BELOW_THRESHOLD':
        add('Repeat the context funnel with narrower scopes, concise responses, and finish on map/inspect/impact anchors.');
        break;
      case 'OR_WITHOUT_RECOVERY':
        add('Repeat search_context with types:["package","module"] or match:"and", then map_context a suggested package/module scope.');
        break;
      case 'CAPABILITY_FLOOD':
        add('Do not hand off export-symbol-heavy search hits directly; choose a pkg:/mod: anchor and map it first.');
        break;
      case 'SEARCH_WITHOUT_MAP':
        add('Run map_context on the selected package/module before handoff.');
        break;
      case 'UNRESOLVED_SCOPE':
        add('Correct unresolved scope ids using search_context suggestedScopes or map_context diagnostics.');
        break;
      case 'TEST_PACKAGE_ANCHOR':
        add('Replace test/fixture/FTR anchors with the corresponding production package/module scope.');
        break;
      case 'BYTE_BUDGET_EXCEEDED':
        add('Reduce response volume: use responseFormat:"concise", smaller limits, and avoid broad architecture reports without categories.');
        break;
      case 'ARCH_RESPONSE_OVERSIZE':
        add('Re-run analyze_architecture with a narrower scope, explicit categories, and a smaller limit.');
        break;
      case 'NO_STABLE_ANCHORS':
        add('Establish at least the required number of stable anchors with high-confidence map_context or inspect_node calls.');
        break;
      case 'ENDED_ON_SEARCH':
        add('Do not end handoff on search_context; inspect_node or analyze_dependencies the selected anchor.');
        break;
      case 'LOW_CONFIDENCE_CONTEXT':
        add('Replace low-confidence or emptyDiagnostic-heavy calls with narrower package/module/resource scopes.');
        break;
      case 'NO_RECORDED_EVENTS':
        add('Pass contextSessionId/sessionId on repovine MCP calls before requesting session quality.');
        break;
    }
  }
  if (options.belowWarningThreshold && options.acceptHandoff) {
    add('Repeat the context funnel: search_context(types:["package","module"]) → map_context → inspect_node / analyze_dependencies.');
  }
  return out;
}

function normalizeSessionId(sessionId: string): string | undefined {
  const trimmed = sessionId.trim();
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(trimmed) ? trimmed : undefined;
}

function compileRegex(pattern: string, fallback: string): RegExp {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return new RegExp(fallback, 'i');
  }
}

function isContextEvent(value: unknown): value is ContextEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const event = value as Partial<ContextEvent>;
  return typeof event.seq === 'number'
    && typeof event.tool === 'string'
    && typeof event.at === 'string'
    && typeof event.responseBytes === 'number'
    && typeof event.requestEcho === 'object'
    && typeof event.metrics === 'object';
}

function isContextRequestEcho(value: unknown): value is ContextRequestEcho {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const echo = value as Partial<ContextRequestEcho>;
  return typeof echo.seq === 'number'
    && typeof echo.tool === 'string'
    && typeof echo.responseBytes === 'number'
    && typeof echo.request === 'object';
}

function isContextSessionAggregates(value: unknown): value is ContextSessionAggregates {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const aggregates = value as Partial<ContextSessionAggregates>;
  return typeof aggregates.toolCallCount === 'number'
    && typeof aggregates.totalResponseBytes === 'number'
    && Array.isArray(aggregates.stableAnchors);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}

export interface ContextSessionBootstrapResult {
  purged: number;
  skipped: boolean;
  reason?: string;
}

/**
 * Client MCP processes start with a clean session store so stale files from prior
 * IDE runs do not affect scoring. Harness runs rely on `repovine agents compliance`
 * consume by default; set purgeSessionsOnMcpStart=true to also purge on harness MCP boot.
 */
export function bootstrapContextSessionsOnMcpStart(
  store: ContextSessionStore,
  config: ContextQualityConfig,
): ContextSessionBootstrapResult {
  if (config.retainSessions) {
    return { purged: 0, skipped: true, reason: 'retainSessions=true' };
  }
  if (!config.purgeSessionsOnMcpStart) {
    return { purged: 0, skipped: true, reason: 'purgeSessionsOnMcpStart=false' };
  }
  return { purged: store.purgeAllSessions(), skipped: false };
}
