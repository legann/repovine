/**
 * Architecture analysis thresholds: per-repo tunable values that gate detector emission.
 *
 * Three-tier model:
 *   1. Tool API (per-call) — scope, categories, limit, annotationReasoning, etc. The confidence
 *      floor is not among them: `analyze_architecture` declares no `minConfidence`, and an
 *      undeclared argument is stripped on the way in.
 *   2. Config file (per-repo) — this module. Sets `strictness` preset or
 *      per-knob overrides in `.repovine.config.json`.
 *   3. Hardcoded (research-level) — confidence formulas, severity mapping,
 *      truncation budgets. Not exposed.
 *
 * The resolver merges:
 *   defaults (= "normal" profile) ← strictness profile ← per-knob overrides.
 */

import type { ModuleKind } from '../../annotations/module-kind.js';

export type RefactoringStrictness = 'loose' | 'normal' | 'strict';

/**
 * Realistic max scores per `moduleKind` under the kind-aware quality model:
 *   types       ~2.5  (only summary + keyExports are relevant)
 *   ui          ~5    (summary, assumptions, sideEffects, stateShape)
 *   api-handler ~7    (+ flowDescription, risks)
 *   service-mgr ~7    (+ invariants, risks)
 *   adapter     ~7    (+ patterns, integrationPoints)
 *   generic     ~5
 *
 * The per-kind bar below targets "annotation is acceptable for this kind of code".
 */
export type AnnotationRiskQualityByKind = Partial<Record<ModuleKind, number>>;

export interface RefactoringThresholds {
  duplicateLike: {
    /** Min modules per responsibility group before emitting a finding. */
    minGroupSize: number;
    /** Min distinct packages required (OR-ed with minGroupSize). */
    minPackages: number;
  };
  godModule: {
    /** Composite score threshold (exports*1.5 + fanIn + fanOut + envVars*2 + lines/N). */
    minScore: number;
    /** Lines-per-score-point divisor used in score formula. */
    linesPerScorePoint: number;
  };
  godDomain: {
    /** Min modules tagged to a domain before considering it a god-domain. */
    minModules: number;
    /** Min recorded subdomains (OR-ed with minModules). */
    minSubdomains: number;
  };
  lowCohesion: {
    /** Min modules in a domain before low-cohesion check kicks in. */
    minDomainSize: number;
  };
  flowConvergence: {
    /** BFS max depth when searching flow paths from frontend entrypoints. */
    maxBfsDepth: number;
  };
  effectSpaghetti: {
    /** Min lifecycle/effect blocks before effect-spaghetti can emit. */
    minEffects: number;
    /** Min side-effect operations inside lifecycle blocks before emitting. */
    minNestedSideEffects: number;
    /** Min distinct side-effect kinds before emitting. */
    minSideEffectKinds: number;
  };
  propDrillingOrchestration: {
    /** Min accepted props before considering a component a prop orchestration candidate. */
    minProps: number;
    /** Min callback/setter props before callback-heavy orchestration can emit. */
    minCallbackProps: number;
    /** Min rendered child components for a container-style signal. */
    minChildComponents: number;
    /** Min ratio of accepted props forwarded to children. */
    minForwardedRatio: number;
    /** Min forwarded prop count before the ratio is meaningful. */
    minForwardedProps: number;
    /** Min repeated prop tunnel depth across component modules. */
    minTunnelDepth: number;
    /** Min workflow signal kinds (state/effect/data/nav/service/policy) before emitting. */
    minWorkflowSignals: number;
  };
  serviceWrapperExplosion: {
    /** Min wrappers in one package/feature group before emitting. */
    minGroupSize: number;
    /** Max fan-in for a wrapper to count as low-ownership. */
    maxFanIn: number;
    /** Max line estimate for a wrapper candidate. */
    maxLineCount: number;
  };
  uiDomainCoupling: {
    /** Min direct coupled imports before emitting. */
    minCoupledImports: number;
  };
  routeConvergence: {
    /** BFS max depth when searching from route/screen entrypoints to data-access targets. */
    maxBfsDepth: number;
    /** Min route/screen entrypoints converging on the same target. */
    minEntrypoints: number;
  };
  annotationRisk: {
    /** Min importance score (fanIn + fanOut + exportCount) to consider the module a hub. */
    minImportance: number;
    /**
     * Scalar quality bar (0–10) — at-or-above => skip finding. This is the FALLBACK: it applies only
     * to a module whose `moduleKind` has no `minQualityScoreByKind` entry. Every built-in profile
     * sets all six common kinds, so the scalar bites only custom configs that omit a per-kind bar, or
     * an unknown/absent kind. Use `minQualityScoreByKind` to steer the common case.
     */
    minQualityScore: number;
    /**
     * Optional per-kind quality bar — the PRIMARY control surface. Takes precedence over
     * `minQualityScore` for matching kinds. Calibrated against realistic max scores per kind
     * (see {@link AnnotationRiskQualityByKind}).
     */
    minQualityScoreByKind?: AnnotationRiskQualityByKind;
    /**
     * Added to a module's quality bar when it is `derived-stale` (an upstream import changed within
     * `derivedStaleHopLimit` import hops). A derived-stale module is ALWAYS surfaced (the detector
     * never skips it), so the penalty does not change whether it is flagged — it raises the bar that
     * decides confidence: an annotation still clearing the raised bar → low-confidence "may still
     * hold" (0.6); below it → "annotate" (0.72). Default: 2.
     */
    derivedStalePenalty: number;
    /** How many import hops to walk when computing the derived-stale set. Default: 2. */
    derivedStaleHopLimit: number;
  };
  unclearArchitecture: {
    /** Min root-domain tags before flagging multi-domain module. */
    minDomainTags: number;
  };
  secretConfigBoundary: {
    /** Min composite evidence score before emitting a secret/public-config boundary finding. */
    minEvidenceScore: number;
    /** Whether generic public env names containing AUTH/SESSION count as secret-like. */
    flagGenericPublicAuthEnv: boolean;
  };
  authorizationPolicyDrift: {
    /** Min modules sharing the same policy responsibility before emitting. */
    minModules: number;
    /** Min distinct feature/package groups sharing the policy responsibility. */
    minFeatureGroups: number;
    /** Whether broad "permissions:general" groups are eligible. */
    allowGeneralSubject: boolean;
    /** Require at least one syntactic authz signal in the group. */
    requireAuthzSignal: boolean;
  };
  /**
   * `isTrustBoundaryModule` admits a module on its directory name alone (`api/`, `routes/`,
   * `handlers/`, …). With `requireRouteOrSideEffect: false` the evidence score then clears its floor
   * on the mere existence of exports, so the finding rests on the path and nothing else. Requiring a
   * route, a side effect or an authz signal is what makes it evidence-led rather than name-led.
   */
  trustBoundaryValidation: {
    /** Min composite evidence score before emitting a missing-validation finding. */
    minEvidenceScore: number;
    /** Require route, mutation, runtime side effect, or authz evidence. */
    requireRouteOrSideEffect: boolean;
  };
  privilegedClientSideEffect: {
    /** Min composite evidence score before emitting a privileged-client finding. */
    minEvidenceScore: number;
    /** Whether mutation/API-client calls alone can trigger the finding. */
    includeMutationOnly: boolean;
    /** Whether frontend-named files ending in storage/db/repo count as privileged storage targets. */
    allowGenericStorageName: boolean;
  };
  sensitiveBrowserStorage: {
    /** Require statically sensitive storage/cookie keys instead of semantic-only storage hints. */
    requireSensitiveKey: boolean;
    /** Min generic storage signals when sensitivity comes only from annotations. */
    minAnnotationStorageSignals: number;
  };
  serverClientBoundary: {
    /** Min leaked target imports before emitting. */
    minTargets: number;
    /** Whether frontend-named files ending in storage/db/repo count as privileged storage targets. */
    allowGenericStorageName: boolean;
  };
  sourceDisclosureSurface: {
    /** Min weighted evidence before emitting; each source-disclosure signal weighs 1. */
    minEvidenceScore: number;
  };
  annotationSecretHygiene: {
    /** Allow repo owners to disable annotation hygiene reports if they run a separate scanner. */
    enabled: boolean;
  };
}

/**
 * Named profiles. `normal` is the calibration target — `loose`/`strict` are
 * relative perturbations chosen so reports stay readable.
 *
 * Direction:
 *   - `loose`: lower skip thresholds → more findings, lower signal/noise.
 *   - `strict`: higher skip thresholds → fewer findings, higher confidence.
 *
 * Exception: `annotationRisk` quality bars are INVERTED — a higher bar demands more from an
 * annotation to count it "good enough to skip", which flags MORE modules. The primary lever is
 * `minQualityScoreByKind` (strict RAISES the per-kind bars → flags more weak annotations); the
 * scalar `minQualityScore` is only the no-per-kind-bar fallback and moves the opposite way (strict
 * lowers it), which matters solely for custom configs that omit the per-kind bars.
 */
export const STRICTNESS_PROFILES: Record<RefactoringStrictness, RefactoringThresholds> = {
  loose: {
    duplicateLike:        { minGroupSize: 2, minPackages: 1 },
    godModule:            { minScore: 13, linesPerScorePoint: 100 },
    godDomain:            { minModules: 35, minSubdomains: 3 },
    lowCohesion:          { minDomainSize: 5 },
    flowConvergence:      { maxBfsDepth: 6 },
    effectSpaghetti:      { minEffects: 2, minNestedSideEffects: 2, minSideEffectKinds: 2 },
    propDrillingOrchestration: { minProps: 6, minCallbackProps: 2, minChildComponents: 2, minForwardedRatio: 0.35, minForwardedProps: 3, minTunnelDepth: 2, minWorkflowSignals: 1 },
    serviceWrapperExplosion: { minGroupSize: 3, maxFanIn: 2, maxLineCount: 180 },
    uiDomainCoupling:     { minCoupledImports: 1 },
    routeConvergence:     { maxBfsDepth: 6, minEntrypoints: 2 },
    annotationRisk: {
      minImportance: 5,
      minQualityScore: 3,
      // Loose: gentle bars per kind; bar is "below this score => flag".
      minQualityScoreByKind: {
        types: 1.5,          // realistic max ~2.5; bar of 1.5 accepts summary+keyExports
        ui: 3,
        'api-handler': 4,
        'service-mgr': 4,
        adapter: 4,
        generic: 3,
      },
      derivedStalePenalty: 1.5,
      derivedStaleHopLimit: 2,
    },
    unclearArchitecture:  { minDomainTags: 3 },
    secretConfigBoundary: { minEvidenceScore: 1, flagGenericPublicAuthEnv: true },
    authorizationPolicyDrift: { minModules: 2, minFeatureGroups: 2, allowGeneralSubject: true, requireAuthzSignal: false },
    trustBoundaryValidation: { minEvidenceScore: 1, requireRouteOrSideEffect: true },
    privilegedClientSideEffect: { minEvidenceScore: 1, includeMutationOnly: true, allowGenericStorageName: true },
    sensitiveBrowserStorage: { requireSensitiveKey: false, minAnnotationStorageSignals: 1 },
    serverClientBoundary: { minTargets: 1, allowGenericStorageName: true },
    sourceDisclosureSurface: { minEvidenceScore: 1 },
    annotationSecretHygiene: { enabled: true },
  },
  normal: {
    duplicateLike:        { minGroupSize: 3, minPackages: 2 },
    godModule:            { minScore: 18, linesPerScorePoint: 150 },
    godDomain:            { minModules: 50, minSubdomains: 5 },
    lowCohesion:          { minDomainSize: 8 },
    flowConvergence:      { maxBfsDepth: 5 },
    effectSpaghetti:      { minEffects: 3, minNestedSideEffects: 3, minSideEffectKinds: 2 },
    propDrillingOrchestration: { minProps: 8, minCallbackProps: 3, minChildComponents: 3, minForwardedRatio: 0.45, minForwardedProps: 4, minTunnelDepth: 2, minWorkflowSignals: 2 },
    serviceWrapperExplosion: { minGroupSize: 4, maxFanIn: 1, maxLineCount: 140 },
    uiDomainCoupling:     { minCoupledImports: 1 },
    routeConvergence:     { maxBfsDepth: 5, minEntrypoints: 2 },
    annotationRisk: {
      minImportance: 8,
      minQualityScore: 3,
      // Normal: aligned with kind-aware scoring's intent.
      minQualityScoreByKind: {
        types: 2,            // accepts summary+keyExports, demands non-trivial summary
        ui: 4,
        'api-handler': 5,    // demands flowDescription OR sideEffects+risks
        'service-mgr': 5,    // demands invariants OR sideEffects+risks
        adapter: 5,          // demands patterns+integrationPoints OR sideEffects
        generic: 4,
      },
      derivedStalePenalty: 2,
      derivedStaleHopLimit: 2,
    },
    unclearArchitecture:  { minDomainTags: 5 },
    secretConfigBoundary: { minEvidenceScore: 1, flagGenericPublicAuthEnv: true },
    authorizationPolicyDrift: { minModules: 2, minFeatureGroups: 2, allowGeneralSubject: true, requireAuthzSignal: false },
    trustBoundaryValidation: { minEvidenceScore: 1, requireRouteOrSideEffect: true },
    privilegedClientSideEffect: { minEvidenceScore: 1, includeMutationOnly: true, allowGenericStorageName: true },
    sensitiveBrowserStorage: { requireSensitiveKey: false, minAnnotationStorageSignals: 1 },
    serverClientBoundary: { minTargets: 1, allowGenericStorageName: true },
    sourceDisclosureSurface: { minEvidenceScore: 1 },
    annotationSecretHygiene: { enabled: true },
  },
  strict: {
    duplicateLike:        { minGroupSize: 4, minPackages: 2 },
    godModule:            { minScore: 25, linesPerScorePoint: 200 },
    godDomain:            { minModules: 70, minSubdomains: 7 },
    lowCohesion:          { minDomainSize: 12 },
    flowConvergence:      { maxBfsDepth: 4 },
    effectSpaghetti:      { minEffects: 4, minNestedSideEffects: 5, minSideEffectKinds: 3 },
    propDrillingOrchestration: { minProps: 10, minCallbackProps: 4, minChildComponents: 4, minForwardedRatio: 0.55, minForwardedProps: 5, minTunnelDepth: 3, minWorkflowSignals: 2 },
    serviceWrapperExplosion: { minGroupSize: 6, maxFanIn: 1, maxLineCount: 100 },
    uiDomainCoupling:     { minCoupledImports: 2 },
    routeConvergence:     { maxBfsDepth: 4, minEntrypoints: 3 },
    annotationRisk: {
      minImportance: 11,
      minQualityScore: 2,
      // Strict: demand more from each kind to skip the finding.
      minQualityScoreByKind: {
        types: 2.5,          // basically demands max for the kind
        ui: 5,
        'api-handler': 6,
        'service-mgr': 6,
        adapter: 6,
        generic: 5,
      },
      derivedStalePenalty: 3,
      derivedStaleHopLimit: 3,
    },
    unclearArchitecture:  { minDomainTags: 7 },
    secretConfigBoundary: { minEvidenceScore: 2, flagGenericPublicAuthEnv: false },
    authorizationPolicyDrift: { minModules: 2, minFeatureGroups: 2, allowGeneralSubject: false, requireAuthzSignal: true },
    trustBoundaryValidation: { minEvidenceScore: 2, requireRouteOrSideEffect: true },
    privilegedClientSideEffect: { minEvidenceScore: 2, includeMutationOnly: false, allowGenericStorageName: false },
    sensitiveBrowserStorage: { requireSensitiveKey: false, minAnnotationStorageSignals: 2 },
    serverClientBoundary: { minTargets: 1, allowGenericStorageName: false },
    sourceDisclosureSurface: { minEvidenceScore: 1 },
    annotationSecretHygiene: { enabled: true },
  },
};

/**
 * Partial / per-knob overrides. The file config supplies one of these and
 * `resolveThresholds` merges it on top of the strictness profile.
 */
export type RefactoringThresholdOverrides = {
  [K in keyof RefactoringThresholds]?: Partial<RefactoringThresholds[K]>;
};

export interface RefactoringFileConfig {
  strictness?: RefactoringStrictness;
  thresholds?: RefactoringThresholdOverrides;
}

/**
 * Merge strictness profile with per-knob overrides into a fully resolved set
 * of thresholds. Missing pieces fall back to the named profile (default
 * "normal").
 */
export function resolveThresholds(file: RefactoringFileConfig | undefined): RefactoringThresholds {
  const strictness: RefactoringStrictness = file?.strictness ?? 'normal';
  const base = STRICTNESS_PROFILES[strictness];
  const overrides = file?.thresholds ?? {};

  // annotationRisk gets a deep merge for `minQualityScoreByKind` so that a user
  // overriding one kind's bar (e.g. tighten 'api-handler') doesn't wipe out the
  // calibrated defaults for other kinds.
  const annotationRiskOverride = overrides.annotationRisk ?? {};
  const annotationRiskByKind = (annotationRiskOverride.minQualityScoreByKind != null
    || base.annotationRisk.minQualityScoreByKind != null)
    ? { ...base.annotationRisk.minQualityScoreByKind, ...annotationRiskOverride.minQualityScoreByKind }
    : undefined;

  return {
    duplicateLike:        { ...base.duplicateLike,       ...overrides.duplicateLike },
    godModule:            { ...base.godModule,           ...overrides.godModule },
    godDomain:            { ...base.godDomain,           ...overrides.godDomain },
    lowCohesion:          { ...base.lowCohesion,         ...overrides.lowCohesion },
    flowConvergence:      { ...base.flowConvergence,     ...overrides.flowConvergence },
    effectSpaghetti:      { ...base.effectSpaghetti,     ...overrides.effectSpaghetti },
    propDrillingOrchestration: { ...base.propDrillingOrchestration, ...overrides.propDrillingOrchestration },
    serviceWrapperExplosion: { ...base.serviceWrapperExplosion, ...overrides.serviceWrapperExplosion },
    uiDomainCoupling:     { ...base.uiDomainCoupling,    ...overrides.uiDomainCoupling },
    routeConvergence:     { ...base.routeConvergence,    ...overrides.routeConvergence },
    annotationRisk: {
      ...base.annotationRisk,
      ...annotationRiskOverride,
      ...(annotationRiskByKind ? { minQualityScoreByKind: annotationRiskByKind } : {}),
    },
    unclearArchitecture:  { ...base.unclearArchitecture, ...overrides.unclearArchitecture },
    secretConfigBoundary: { ...base.secretConfigBoundary, ...overrides.secretConfigBoundary },
    authorizationPolicyDrift: { ...base.authorizationPolicyDrift, ...overrides.authorizationPolicyDrift },
    trustBoundaryValidation: { ...base.trustBoundaryValidation, ...overrides.trustBoundaryValidation },
    privilegedClientSideEffect: { ...base.privilegedClientSideEffect, ...overrides.privilegedClientSideEffect },
    sensitiveBrowserStorage: { ...base.sensitiveBrowserStorage, ...overrides.sensitiveBrowserStorage },
    serverClientBoundary: { ...base.serverClientBoundary, ...overrides.serverClientBoundary },
    sourceDisclosureSurface: { ...base.sourceDisclosureSurface, ...overrides.sourceDisclosureSurface },
    annotationSecretHygiene: { ...base.annotationSecretHygiene, ...overrides.annotationSecretHygiene },
  };
}

/** The "normal" profile, exposed so other layers can reference defaults. */
export const DEFAULT_THRESHOLDS: RefactoringThresholds = STRICTNESS_PROFILES.normal;

/**
 * Every tunable detector group, read off the profile that defines them. The config schema, the
 * generated config template and the workspace-file reference all name this same set; deriving it
 * here means adding a group in one place reaches all three.
 */
export const REFACTORING_THRESHOLD_GROUPS = Object.keys(DEFAULT_THRESHOLDS)
  .sort() as Array<keyof RefactoringThresholds>;
