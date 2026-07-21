/**
 * Refactoring detectors — one function per category. Each is a pure mapping
 * from (graph, modules, annotations, scope) to a list of findings; the
 * orchestrator in index.ts is responsible for category gating, minConfidence
 * filtering, and limit/balancing.
 */

import type { UiChildComponentHint, UiComponentHint, RepositoryGraph, ModuleInfo, SecuritySignal, StoredAnnotation } from '../../types.js';
import { type AnnotationStore, computeAnnotationQuality } from '../../annotations/store.js';
import { inferModuleKind } from '../../annotations/module-kind.js';
import { isPure } from '../../annotations/side-effect-vocab.js';
import { annotationSecretFieldPaths } from './annotation-secret.js';
import { workflowSignalKinds } from './component-signals.js';
import { DEFAULT_THRESHOLDS, type RefactoringThresholds } from './config.js';
import { clampConfidence, findingSeverity } from './finding.js';
import { modulePackageId } from './scope.js';
import { buildAnnotationContext } from './annotation-context.js';
import type { RefactoringFinding, RefactoringScope } from './types.js';
import {
  annotationText,
  convergenceTargetGroupKey,
  coupledTargetRole,
  exportedNamesText,
  findFlowPaths,
  flowPrepKeys,
  frontendDataAccessTargetKey,
  frontendFeatureKey,
  isBuildOrToolingModule,
  isBackendContext,
  isConvergenceTargetModule,
  isDesignSystemPrimitive,
  isFrontendFlowEntryModule,
  isFrontendServiceWrapperCandidate,
  isFrontendSurfaceModule,
  isGenericConvergenceTarget,
  hasHttpHandlerSignals,
  isPureTypesModule,
  isRouteOrScreenEntryModule,
  isRuntimeImportEdge,
  isUiCouplingSourceModule,
  uiCouplingTargetRole,
  maxModuleLine,
  normalizeResponsibilityKey,
  policySubjectKey,
  policyTokens,
  rootDomainId,
  stateModuleKind,
} from './heuristics.js';

export type DetectorOptions = {
  includeComponentEntrypoints?: boolean;
  annotationReasoning?: boolean;
};

function build(finding: Omit<RefactoringFinding, 'severity'>): RefactoringFinding {
  const confidence = clampConfidence(finding.confidence);
  return {
    ...finding,
    confidence,
    severity: findingSeverity(confidence, finding.impact),
  };
}

function labelsOf(graph: RepositoryGraph, ids: Iterable<string>): string[] {
  return [...ids].map(id => graph.nodes.get(id)?.label ?? id).slice(0, 8);
}

// ── duplicate-like ──

export function detectDuplicateLike(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  annotations: AnnotationStore,
  scope: RefactoringScope,
  options: { annotationReasoning?: boolean; thresholds?: RefactoringThresholds['duplicateLike'] } = {},
): RefactoringFinding[] {
  const t = options.thresholds ?? DEFAULT_THRESHOLDS.duplicateLike;
  const findings: RefactoringFinding[] = [];
  const groups = new Map<string, string[]>();
  for (const modId of scope.moduleIds) {
    const mod = modulesById.get(modId);
    const key = normalizeResponsibilityKey(mod?.relativeFilePath ?? graph.nodes.get(modId)?.label ?? modId);
    if (!key || key.length < 3) continue;
    let group = groups.get(key);
    if (!group) { group = []; groups.set(key, group); }
    group.push(modId);
  }
  for (const [key, ids] of groups) {
    const pkgs = new Set(ids.map(id => modulePackageId(graph, id)).filter((p): p is string => p != null));
    if (ids.length < t.minGroupSize && pkgs.size < t.minPackages) continue;
    const confidence = Math.min(0.9, 0.45 + ids.length * 0.08 + pkgs.size * 0.08);
    const finding = build({
      id: `duplicate-like:${key}`,
      category: 'duplicate-like',
      title: `Several modules appear to own similar "${key}" responsibility`,
      impact: ids.length >= 5 || pkgs.size >= 3 ? 'high' : 'medium',
      confidence,
      nodes: ids,
      evidence: [
        `${ids.length} modules normalize to the same responsibility key`,
        `${pkgs.size} package(s): ${[...pkgs].sort().join(', ') || 'unknown'}`,
        `Examples: ${labelsOf(graph, ids).join(', ')}`,
      ],
      suggestion: 'Compare their annotations and public exports; consider extracting a shared abstraction only if their invariants and side effects truly match.',
    });
    if (options.annotationReasoning) {
      const annotationContext = buildAnnotationContext('same-concept', ids, graph, modulesById, annotations);
      if (annotationContext) finding.annotationContext = annotationContext;
    }
    findings.push(finding);
  }
  return findings;
}

// ── boundary ──

export function detectBoundary(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  annotations: AnnotationStore,
  scope: RefactoringScope,
  options: { annotationReasoning?: boolean } = {},
): RefactoringFinding[] {
  const findings: RefactoringFinding[] = [];
  const targetGroups = new Map<string, { targetPackage: string; importers: string[]; symbols: Set<string> }>();
  for (const edge of graph.edges) {
    if (!isRuntimeImportEdge(edge)) continue;
    const fromInScope = scope.moduleIds.has(edge.from);
    const toInScope = scope.moduleIds.has(edge.to);
    if (scope.kind === 'package') {
      if (!fromInScope && !toInScope) continue;
    } else if (!fromInScope) {
      continue;
    }
    const fromPkg = modulePackageId(graph, edge.from);
    const toPkg = modulePackageId(graph, edge.to);
    if (!fromPkg || !toPkg || fromPkg === toPkg) continue;
    const target = graph.nodes.get(edge.to);
    if (target?.type !== 'module' || target.label.endsWith('/index') || target.label.endsWith('…/index')) continue;
    const hasIndex = [...graph.outEdges.get(toPkg) ?? []].some(e => {
      const n = graph.nodes.get(e.to);
      return e.kind === 'contains' && n?.type === 'module' && n.label.endsWith('/index');
    });
    if (!hasIndex) continue;
    let group = targetGroups.get(edge.to);
    if (!group) {
      group = { targetPackage: toPkg, importers: [], symbols: new Set() };
      targetGroups.set(edge.to, group);
    }
    group.importers.push(edge.from);
    const mod = modulesById.get(edge.from);
    for (const imported of mod?.imports.filter(i => i.resolvedModuleId === edge.to) ?? []) {
      for (const name of imported.importedNames) group.symbols.add(name);
    }
  }
  for (const [targetId, group] of targetGroups) {
    const confidence = Math.min(0.92, 0.6 + group.importers.length * 0.06);
    const finding = build({
      id: `boundary:${targetId}`,
      category: 'boundary',
      title: 'Cross-package imports bypass a public package boundary',
      impact: group.importers.length >= 5 ? 'high' : 'medium',
      confidence,
      nodes: [targetId, ...group.importers],
      evidence: [
        `${group.importers.length} importer(s) reach ${graph.nodes.get(targetId)?.label ?? targetId} directly`,
        `Target package has an index module, so a public re-export boundary likely exists`,
        `Imported symbols: ${[...group.symbols].slice(0, 10).join(', ') || 'unknown'}`,
      ],
      suggestion: 'Prefer a package-level public export or intentionally document this as an internal dependency if the bypass is part of the design.',
    });
    if (options.annotationReasoning) {
      // Only the TARGET annotation matters for intentional-internal — importers
      // don't carry the contract decision.
      const annotationContext = buildAnnotationContext('intentional-internal', [targetId], graph, modulesById, annotations);
      if (annotationContext) finding.annotationContext = annotationContext;
    }
    findings.push(finding);
  }
  return findings;
}

// ── god-module ──

export function detectGodModule(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  annotations: AnnotationStore,
  scope: RefactoringScope,
  options: { annotationReasoning?: boolean; thresholds?: RefactoringThresholds['godModule'] } = {},
): RefactoringFinding[] {
  const t = options.thresholds ?? DEFAULT_THRESHOLDS.godModule;
  const findings: RefactoringFinding[] = [];
  for (const modId of scope.moduleIds) {
    const mod = modulesById.get(modId);
    const fanIn = (graph.inEdges.get(modId) ?? []).filter(isRuntimeImportEdge).length;
    const fanOut = (graph.outEdges.get(modId) ?? []).filter(isRuntimeImportEdge).length;
    const exportCount = mod?.exports.length ?? 0;
    const envCount = mod?.semanticHints?.envVars?.length ?? 0;
    const lineCount = maxModuleLine(mod);
    const score = exportCount * 1.5 + fanIn + fanOut + envCount * 2 + Math.floor(lineCount / t.linesPerScorePoint);
    if (score < t.minScore) continue;
    const confidence = Math.min(0.95, 0.55 + score / 80);
    const finding = build({
      id: `god-module:${modId}`,
      category: 'god-module',
      title: 'Module has a broad responsibility surface',
      impact: fanIn >= 10 || exportCount >= 15 ? 'high' : 'medium',
      confidence,
      nodes: [modId],
      evidence: [
        `${exportCount} export(s), fan-in ${fanIn}, fan-out ${fanOut}`,
        lineCount > 0 ? `Largest exported line range ends at ${lineCount}` : 'No line estimate available',
        envCount > 0 ? `${envCount} env var reference(s)` : 'No env var references detected',
      ],
      suggestion: 'Split only along real responsibility boundaries: stable pure logic, side-effect adapters, orchestration, or framework entrypoints.',
    });
    if (options.annotationReasoning) {
      const annotationContext = buildAnnotationContext('type-only-or-barrel', [modId], graph, modulesById, annotations);
      if (annotationContext) finding.annotationContext = annotationContext;
    }
    findings.push(finding);
  }
  return findings;
}

export function detectServerHandlerOrchestration(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  annotations: AnnotationStore,
  scope: RefactoringScope,
  options: { annotationReasoning?: boolean; thresholds?: RefactoringThresholds['godModule'] } = {},
): RefactoringFinding[] {
  const t = options.thresholds ?? DEFAULT_THRESHOLDS.godModule;
  const findings: RefactoringFinding[] = [];
  for (const modId of scope.moduleIds) {
    const mod = modulesById.get(modId);
    if (!mod) continue;
    const rel = mod.relativeFilePath.replace(/\\/g, '/').toLowerCase();
    if (isBuildOrToolingModule(rel) || isPureTypesModule(mod)) continue;
    if (!isBackendContext(mod) && !hasHttpHandlerSignals(mod)) continue;

    const importEdges = (graph.outEdges.get(modId) ?? []).filter(isRuntimeImportEdge);
    const targetIds: string[] = [];
    const targetRoles = new Set<string>();
    for (const edge of importEdges) {
      const target = modulesById.get(edge.to);
      if (!target) continue;
      targetIds.push(edge.to);
      const role = coupledTargetRole(target);
      if (role && role !== 'feature' && role !== 'state') targetRoles.add(role);
    }

    const exportCount = mod.exports.length;
    const envCount = mod.semanticHints?.envVars?.length ?? 0;
    const runtimeActionCount = mod.semanticHints?.runtimeActions?.length ?? 0;
    const routeCount = mod.semanticHints?.routes?.filter(route => route.kind === 'api').length ?? 0;
    const lineCount = maxModuleLine(mod);
    const score = exportCount
      + importEdges.length * 1.5
      + targetRoles.size * 3
      + envCount * 2
      + runtimeActionCount * 2
      + routeCount * 2
      + Math.floor(lineCount / t.linesPerScorePoint);
    const evidenceAxes = [
      importEdges.length >= 3,
      targetRoles.size >= 2,
      envCount > 0,
      runtimeActionCount > 0,
      exportCount >= 3,
      lineCount >= t.linesPerScorePoint,
      routeCount > 0,
    ].filter(Boolean).length;
    if (score < t.minScore || evidenceAxes < 4) continue;

    const confidence = Math.min(0.92, 0.58 + score / 100 + targetRoles.size * 0.03);
    const finding = build({
      id: `server-handler-orchestration:${modId}`,
      category: 'god-module',
      title: 'Server handler concentrates orchestration responsibilities',
      impact: score >= t.minScore + 8 || targetRoles.size >= 3 ? 'high' : 'medium',
      confidence,
      nodes: [modId, ...targetIds.slice(0, 8)],
      evidence: [
        `Server handler: ${mod.relativeFilePath}`,
        `Surface score ${score}: ${exportCount} export(s), fan-out ${importEdges.length}, ${envCount} env var reference(s), ${runtimeActionCount} runtime action(s)`,
        `Orchestration target roles: ${[...targetRoles].sort().join(', ') || 'none'}`,
        routeCount > 0 ? `${routeCount} API route marker(s)` : 'No API route marker; matched backend/handler heuristics',
      ],
      suggestion: 'Split validation, authorization, persistence, and runtime adapter calls out of the handler when those responsibilities have stable ownership boundaries.',
    });
    if (options.annotationReasoning) {
      const annotationContext = buildAnnotationContext('type-only-or-barrel', [modId, ...targetIds], graph, modulesById, annotations);
      if (annotationContext) finding.annotationContext = annotationContext;
    }
    findings.push(finding);
  }
  return findings;
}

// ── god-domain + low-cohesion (share iteration over domains) ──

export function detectDomainShape(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  annotations: AnnotationStore,
  scope: RefactoringScope,
  enabled: { godDomain: boolean; lowCohesion: boolean },
  options: {
    annotationReasoning?: boolean;
    godDomainThresholds?: RefactoringThresholds['godDomain'];
    lowCohesionThresholds?: RefactoringThresholds['lowCohesion'];
  } = {},
): RefactoringFinding[] {
  const gd = options.godDomainThresholds ?? DEFAULT_THRESHOLDS.godDomain;
  const lc = options.lowCohesionThresholds ?? DEFAULT_THRESHOLDS.lowCohesion;
  const findings: RefactoringFinding[] = [];
  for (const domainId of scope.domainIds) {
    const domainNode = graph.nodes.get(domainId);
    if (domainNode?.type !== 'domain') continue;
    const taggedModuleIds = (graph.inEdges.get(domainId) ?? [])
      .filter(e => e.kind === 'tagged' && graph.nodes.get(e.from)?.type === 'module')
      .map(e => e.from);
    const moduleIds = taggedModuleIds.filter(id => scope.moduleIds.size === 0 || scope.moduleIds.has(id));
    const subdomainCount = domainNode.data?.subdomains?.length ?? 0;
    if (enabled.godDomain && (moduleIds.length >= gd.minModules || subdomainCount >= gd.minSubdomains)) {
      findings.push(build({
        id: `god-domain:${domainId}`,
        category: 'god-domain',
        title: 'Domain is large enough to deserve subdivision',
        impact: moduleIds.length >= 80 ? 'high' : 'medium',
        confidence: Math.min(0.9, 0.55 + moduleIds.length / 120 + subdomainCount * 0.04),
        nodes: [domainId, ...moduleIds.slice(0, 20)],
        evidence: [
          `${moduleIds.length} tagged module(s)`,
          `${subdomainCount} recorded subdomain(s)`,
          `Tier: ${domainNode.data?.tier ?? 'unknown'}`,
        ],
        suggestion: 'Look for stable subdomains by data ownership, workflow phase, or integration boundary before moving code.',
      }));
    }
    if (enabled.lowCohesion && moduleIds.length >= lc.minDomainSize) {
      // Classify against the FULL domain membership, not the scope-filtered slice — under a package
      // scope an import to a same-domain module in another package must count internal, not external.
      const moduleSet = new Set(taggedModuleIds);
      let internalImports = 0;
      let externalImports = 0;
      for (const modId of moduleIds) {
        for (const edge of graph.outEdges.get(modId) ?? []) {
          if (!isRuntimeImportEdge(edge)) continue;
          if (moduleSet.has(edge.to)) internalImports++;
          else externalImports++;
        }
      }
      if (internalImports < Math.max(2, moduleIds.length / 3) && externalImports > internalImports) {
        const finding = build({
          id: `low-cohesion:${domainId}`,
          category: 'low-cohesion',
          title: 'Domain has weak internal coupling compared with external dependencies',
          impact: moduleIds.length >= 20 ? 'high' : 'medium',
          confidence: Math.min(0.88, 0.55 + (externalImports - internalImports) / Math.max(10, moduleIds.length * 2)),
          nodes: [domainId, ...moduleIds.slice(0, 20)],
          evidence: [
            `${moduleIds.length} module(s) in domain`,
            `${internalImports} internal import(s), ${externalImports} external import(s)`,
            'A low internal-to-external ratio can mean the domain label is too broad or mostly technical.',
          ],
          suggestion: 'Review annotations for common invariants; if they are thin or unrelated, split the domain or retag modules more narrowly.',
        });
        if (options.annotationReasoning) {
          // Domain node has no useful annotation here — compare module annotations only.
          const annotationContext = buildAnnotationContext('shared-invariant', moduleIds, graph, modulesById, annotations);
          if (annotationContext) finding.annotationContext = annotationContext;
        }
        findings.push(finding);
      }
    }
  }
  return findings;
}

// ── client-business-logic ──

export function detectClientBusinessLogic(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  annotations: AnnotationStore,
  scope: RefactoringScope,
  options: { annotationReasoning?: boolean } = {},
): RefactoringFinding[] {
  const findings: RefactoringFinding[] = [];
  for (const modId of scope.moduleIds) {
    const mod = modulesById.get(modId);
    if (!mod) continue;
    const rel = mod.relativeFilePath.replace(/\\/g, '/').toLowerCase();
    if (isBuildOrToolingModule(rel)) continue;
    if (!isFrontendSurfaceModule(mod)) continue;
    // An author-declared `pure` side-effect set is an explicit assertion of zero
    // business effects — skip emission so it never reaches the agent as noise.
    // Missing/empty annotations are NOT pure (isPure → false), so un-annotated
    // modules still emit and get the `real-side-effect` question.
    if (isPure(annotations.get(modId)?.annotation.sideEffects)) continue;
    const businessExports = mod.exports.filter(e => e.kind !== 'component' && e.name !== 'default');
    const sideEffectHints = (mod.semanticHints?.envVars?.length ?? 0) + (mod.semanticHints?.runtimeActions?.length ?? 0);
    if (isDesignSystemPrimitive(mod) && sideEffectHints === 0) continue;
    if (businessExports.length < 5 && sideEffectHints === 0) continue;
    const finding = build({
      id: `client-business-logic:${modId}`,
      category: 'client-business-logic',
      title: 'Client-facing module may contain reusable business logic',
      impact: sideEffectHints > 0 || businessExports.length >= 10 ? 'high' : 'medium',
      confidence: Math.min(0.86, 0.5 + businessExports.length * 0.04 + sideEffectHints * 0.08),
      nodes: [modId],
      evidence: [
        `Client/UI path or marker: ${mod.relativeFilePath}`,
        `${businessExports.length} non-component export(s)`,
        sideEffectHints > 0 ? `${sideEffectHints} side-effect hint(s)` : 'No side-effect hints detected',
      ],
      suggestion: 'Consider moving pure rules, validation, mapping, or policy decisions into a framework-neutral module while leaving rendering and state wiring in the client layer.',
    });
    if (options.annotationReasoning) {
      const annotationContext = buildAnnotationContext('real-side-effect', [modId], graph, modulesById, annotations);
      if (annotationContext) finding.annotationContext = annotationContext;
    }
    findings.push(finding);
  }
  return findings;
}

// ── flow-convergence ──

export function detectFlowConvergence(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  annotations: AnnotationStore,
  scope: RefactoringScope,
  options: DetectorOptions & { thresholds?: RefactoringThresholds['flowConvergence'] },
): RefactoringFinding[] {
  const t = options.thresholds ?? DEFAULT_THRESHOLDS.flowConvergence;
  const findings: RefactoringFinding[] = [];
  const includeComponentEntrypoints = options.includeComponentEntrypoints === true;
  const entryIds = [...scope.moduleIds].filter(id => {
    const mod = modulesById.get(id);
    return mod ? isFrontendFlowEntryModule(mod, includeComponentEntrypoints) : false;
  });
  const entryPackages = new Set(entryIds.map(id => modulePackageId(graph, id)).filter((pkg): pkg is string => pkg != null));
  type TargetFlow = {
    groupKey: string;
    targetIds: Set<string>;
    entries: Map<string, string[]>;
    prepKeys: Map<string, string[]>;
    genericTargetIds: Set<string>;
  };
  const byTarget = new Map<string, TargetFlow>();
  for (const entryId of entryIds) {
    for (const flowPath of findFlowPaths(graph, modulesById, entryId, scope.moduleIds, t.maxBfsDepth)) {
      if (flowPath.targetId === entryId) continue;
      const targetMod = modulesById.get(flowPath.targetId);
      if (!targetMod || !isConvergenceTargetModule(targetMod, entryPackages)) continue;
      const groupKey = convergenceTargetGroupKey(targetMod);
      let entry = byTarget.get(groupKey);
      if (!entry) {
        entry = { groupKey, targetIds: new Set(), entries: new Map(), prepKeys: new Map(), genericTargetIds: new Set() };
        byTarget.set(groupKey, entry);
      }
      entry.targetIds.add(flowPath.targetId);
      if (isGenericConvergenceTarget(targetMod)) entry.genericTargetIds.add(flowPath.targetId);
      const existing = entry.entries.get(entryId);
      if (!existing || flowPath.path.length < existing.length) {
        entry.entries.set(entryId, flowPath.path);
        entry.prepKeys.set(entryId, flowPrepKeys(modulesById, flowPath.path, flowPath.targetId));
      }
    }
  }
  for (const flow of byTarget.values()) {
    if (flow.entries.size < 2) continue;
    const prepKeyCounts = new Map<string, number>();
    for (const keys of flow.prepKeys.values()) {
      for (const key of keys) prepKeyCounts.set(key, (prepKeyCounts.get(key) ?? 0) + 1);
    }
    const repeatedPrepKeys = [...prepKeyCounts.entries()]
      .filter(([, count]) => count >= 2)
      .map(([key]) => key)
      .slice(0, 8);
    const entryList = [...flow.entries.keys()];
    const targetList = [...flow.targetIds];
    const genericOnly = targetList.length > 0 && targetList.every(id => flow.genericTargetIds.has(id));
    if (genericOnly && repeatedPrepKeys.length === 0) continue;
    const targetLabel = targetList.length === 1
      ? graph.nodes.get(targetList[0])?.label ?? targetList[0]
      : `${flow.groupKey} (${targetList.length} sibling target(s))`;
    const confidence = Math.min(
      0.9,
      0.52 + flow.entries.size * 0.06 + repeatedPrepKeys.length * 0.05 + (targetList.length > 1 ? 0.05 : 0) - (genericOnly ? 0.08 : 0),
    );
    const finding = build({
      id: `flow-convergence:${flow.groupKey}`,
      category: 'flow-convergence',
      title: 'Multiple frontend flows converge on the same domain/shared target',
      impact: flow.entries.size >= 4 ? 'high' : 'medium',
      confidence,
      nodes: [...targetList, ...entryList],
      evidence: [
        `${flow.entries.size} frontend entrypoint(s) reach ${targetLabel}`,
        `Entrypoints: ${labelsOf(graph, entryList).join(', ')}`,
        targetList.length > 1 ? `Sibling targets grouped: ${labelsOf(graph, targetList).join(', ')}` : `Target: ${targetLabel}`,
        repeatedPrepKeys.length > 0
          ? `Repeated pre-target responsibility keys: ${repeatedPrepKeys.join(', ')}`
          : 'No repeated preparation responsibility keys detected before the target',
      ],
      suggestion: 'Compare the pre-target mapping/validation/policy logic across these flows; extract shared domain policy only when invariants and side effects match.',
    });
    if (options.annotationReasoning) {
      // Collect prep-stage module ids: middle of each path, excluding entries
      // (path[0]) and targets (already tracked in flow.targetIds).
      const prepIds = new Set<string>();
      const entrySet = new Set(entryList);
      for (const path of flow.entries.values()) {
        for (const id of path.slice(1, -1)) {
          if (flow.targetIds.has(id)) continue;
          if (entrySet.has(id)) continue;
          prepIds.add(id);
        }
      }
      if (prepIds.size >= 2) {
        const annotationContext = buildAnnotationContext('shared-prep-logic', [...prepIds], graph, modulesById, annotations);
        if (annotationContext) finding.annotationContext = annotationContext;
      }
    }
    findings.push(finding);
  }
  return findings;
}

// ── frontend effect/data-flow smells ──

export function detectEffectSpaghetti(
  modulesById: Map<string, ModuleInfo>,
  scope: RefactoringScope,
  options: { thresholds?: RefactoringThresholds['effectSpaghetti'] } = {},
): RefactoringFinding[] {
  const t = options.thresholds ?? DEFAULT_THRESHOLDS.effectSpaghetti;
  const findings: RefactoringFinding[] = [];
  for (const modId of scope.moduleIds) {
    const mod = modulesById.get(modId);
    if (!mod || !isFrontendSurfaceModule(mod)) continue;
    const effects = mod.semanticHints?.ui?.lifecycleEffects ?? [];
    if (effects.length === 0) continue;
    const dataAccessCount = mod.semanticHints?.ui?.dataAccess?.length ?? 0;
    const navigationCount = mod.semanticHints?.ui?.navigation?.length ?? 0;
    const timerCount = mod.semanticHints?.ui?.timers?.length ?? 0;
    const subscriptionCount = mod.semanticHints?.ui?.subscriptions?.length ?? 0;
    const nestedSideEffectCount = effects.reduce((sum, effect) =>
      sum
      + (effect.dataAccessCount ?? 0)
      + (effect.navigationCount ?? 0)
      + (effect.timerCount ?? 0)
      + (effect.subscriptionCount ?? 0), 0);
    const sideEffectKinds = [
      dataAccessCount > 0 ? 'data-fetching' : undefined,
      navigationCount > 0 ? 'navigation' : undefined,
      timerCount > 0 ? 'timers' : undefined,
      subscriptionCount > 0 ? 'subscriptions' : undefined,
    ].filter((kind): kind is string => kind != null);
    const hasLifecycleVolume = effects.length >= t.minEffects && sideEffectKinds.length > 0;
    const hasNestedSideEffects = nestedSideEffectCount >= t.minNestedSideEffects;
    const hasDiverseSideEffects = sideEffectKinds.length >= t.minSideEffectKinds && effects.length >= Math.max(2, t.minEffects - 1);
    const hasPureEffectVolume = effects.length >= t.minEffects + 2 && nestedSideEffectCount === 0 && sideEffectKinds.length === 0;
    if (!hasLifecycleVolume && !hasNestedSideEffects && !hasDiverseSideEffects && !hasPureEffectVolume) continue;
    const confidenceBase = hasPureEffectVolume ? 0.43 : 0.48;
    const confidence = Math.min(
      hasPureEffectVolume ? 0.62 : 0.9,
      confidenceBase
        + Math.min(effects.length, 8) * 0.04
        + nestedSideEffectCount * 0.05
        + sideEffectKinds.length * 0.07,
    );
    findings.push(build({
      id: `effect-spaghetti:${modId}`,
      category: 'effect-spaghetti',
      title: 'Frontend module has many lifecycle effects coordinating side effects',
      impact: !hasPureEffectVolume && (effects.length >= t.minEffects + 2 || nestedSideEffectCount >= t.minNestedSideEffects + 4) ? 'high' : 'medium',
      confidence,
      nodes: [modId],
      evidence: [
        `${effects.length} lifecycle/effect block(s) detected`,
        `${nestedSideEffectCount} side-effect operation(s) inside lifecycle blocks`,
        `Side-effect kinds: ${sideEffectKinds.join(', ') || 'unknown'}`,
        `Examples: ${effects.slice(0, 5).map(effect => `${effect.name}@${effect.lineRange?.start ?? '?'}`).join(', ')}`,
      ],
      suggestion: 'Look for one data/loading owner per flow; move fetch/mapping/navigation orchestration into a route loader, query layer, or feature controller when the effects encode workflow rather than view synchronization.',
    }));
  }
  return findings;
}

export function detectPropDrillingOrchestration(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  annotations: AnnotationStore,
  scope: RefactoringScope,
  options: { annotationReasoning?: boolean; thresholds?: RefactoringThresholds['propDrillingOrchestration'] } = {},
): RefactoringFinding[] {
  const t = options.thresholds ?? DEFAULT_THRESHOLDS.propDrillingOrchestration;
  const findings: RefactoringFinding[] = [];
  const tunnelDepthMemo = new Map<string, number>();
  for (const modId of scope.moduleIds) {
    const mod = modulesById.get(modId);
    if (!mod || !isFrontendSurfaceModule(mod) || isDesignSystemPrimitive(mod)) continue;
    const components = mod.semanticHints?.ui?.components ?? [];
    if (components.length === 0) continue;

    for (const [componentIndex, component] of components.entries()) {
      const propNames = component.props.map(prop => prop.name);
      const callbackProps = component.props
        .filter(prop => prop.kind === 'callback' || prop.kind === 'setter')
        .map(prop => prop.name);
      const forwardedProps = unique(component.childComponents.flatMap(child => child.forwardedProps));
      const forwardedCallbacks = forwardedProps.filter(prop => callbackProps.includes(prop));
      const childCount = component.childComponents.length;
      const forwardedRatio = propNames.length > 0 ? forwardedProps.length / propNames.length : 0;
      const spreadForwarding = component.childComponents.some(child => child.spreadProps.length > 0);
      const workflowKinds = workflowSignalKinds(component.localSignals);
      const maxTunnelDepth = forwardedProps.reduce((max, propName) =>
        Math.max(max, propTunnelDepth(
          modId,
          propName,
          modulesById,
          tunnelDepthMemo,
          new Set<string>(),
        )), 0);

      const structural =
        propNames.length >= t.minProps
        && childCount >= t.minChildComponents
        && forwardedProps.length >= t.minForwardedProps
        && forwardedRatio >= t.minForwardedRatio;
      const callbackHeavy =
        callbackProps.length >= t.minCallbackProps
        && forwardedCallbacks.length >= Math.max(1, Math.min(callbackProps.length, t.minCallbackProps - 1))
        && childCount >= Math.max(2, t.minChildComponents - 1);
      const tunnelSignal = maxTunnelDepth >= t.minTunnelDepth && forwardedCallbacks.length > 0;
      const spreadSignal = spreadForwarding && propNames.length >= t.minProps && childCount >= Math.max(2, t.minChildComponents - 1);
      const workflowEnough = workflowKinds.length >= t.minWorkflowSignals
        || (tunnelSignal && workflowKinds.length >= Math.max(1, t.minWorkflowSignals - 1));

      if (isLikelyLayoutOnlyComponent(component) && workflowKinds.length === 0 && forwardedCallbacks.length === 0) continue;
      if ((!structural && !callbackHeavy && !tunnelSignal && !spreadSignal) || !workflowEnough) continue;

      const childModuleIds = unique(component.childComponents.flatMap(child => resolveChildModuleIds(mod, child)));
      const confidence = Math.min(0.92,
        0.42
        + Math.min(propNames.length, 16) * 0.015
        + callbackProps.length * 0.035
        + forwardedProps.length * 0.02
        + Math.min(childCount, 8) * 0.025
        + Math.min(maxTunnelDepth, 4) * 0.06
        + workflowKinds.length * 0.045
        + (spreadForwarding ? 0.04 : 0),
      );
      const finding = build({
        // Disambiguate by line (or loop index fallback) so two same-named components in one module
        // get distinct ids — otherwise the second collides and selectBalancedFindings drops it.
        id: `prop-drilling-orchestration:${modId}:${component.name}#${component.lineRange?.start ?? componentIndex}`,
        category: 'prop-drilling-orchestration',
        title: 'Component appears to orchestrate workflow through forwarded props/callbacks',
        impact: maxTunnelDepth >= 3 || (propNames.length >= 12 && workflowKinds.length >= 3) ? 'high' : 'medium',
        confidence,
        nodes: [modId, ...childModuleIds],
        evidence: [
          `${component.name} accepts ${propNames.length} prop(s), including ${callbackProps.length} callback/setter prop(s)`,
          `Forwards ${forwardedProps.length} accepted prop(s) to ${childCount} child component(s) (ratio ${forwardedRatio.toFixed(2)})`,
          `Forwarded callbacks: ${forwardedCallbacks.slice(0, 8).join(', ') || 'none'}`,
          `Max repeated prop tunnel depth: ${maxTunnelDepth}`,
          `Workflow signals: ${workflowKinds.join(', ') || 'none'}`,
          spreadForwarding ? `Spread forwarding: ${component.childComponents.flatMap(child => child.spreadProps).slice(0, 8).join(', ')}` : 'Spread forwarding: none',
        ],
        suggestion: 'Check whether this component is a real feature controller. If it is only passing workflow state and callbacks through, lift orchestration into a route/controller/query layer or colocate state with the feature boundary while keeping leaf components presentational.',
      });
      if (options.annotationReasoning) {
        const annotationContext = buildAnnotationContext('workflow-orchestrator-or-layout', [modId], graph, modulesById, annotations);
        if (annotationContext) finding.annotationContext = annotationContext;
      }
      findings.push(finding);
    }
  }
  return findings;
}

export function detectUiDomainCoupling(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  scope: RefactoringScope,
  options: { thresholds?: RefactoringThresholds['uiDomainCoupling'] } = {},
): RefactoringFinding[] {
  const t = options.thresholds ?? DEFAULT_THRESHOLDS.uiDomainCoupling;
  const findings: RefactoringFinding[] = [];
  for (const modId of scope.moduleIds) {
    const mod = modulesById.get(modId);
    if (!mod || !isUiCouplingSourceModule(mod) || isDesignSystemPrimitive(mod)) continue;
    const targets: Array<{ id: string; role: string; importedNames: string[] }> = [];
    for (const imp of mod.imports) {
      if (imp.isTypeOnly || !imp.resolvedModuleId) continue;
      const target = modulesById.get(imp.resolvedModuleId);
      if (!target) continue;
      const role = uiCouplingTargetRole(target);
      if (!role) continue;
      targets.push({ id: target.id, role, importedNames: imp.importedNames });
    }
    if (targets.length < t.minCoupledImports) continue;
    const roles = [...new Set(targets.map(target => target.role))].sort();
    const highRisk = roles.some(role => role === 'api' || role === 'storage' || role === 'server');
    findings.push(build({
      id: `ui-domain-coupling:${modId}`,
      category: 'ui-domain-coupling',
      title: 'UI module imports domain/API/storage modules directly',
      impact: highRisk || targets.length >= 3 ? 'high' : 'medium',
      confidence: Math.min(0.9, 0.58 + targets.length * 0.07 + roles.length * 0.04 + (highRisk ? 0.08 : 0)),
      nodes: [modId, ...targets.map(target => target.id)],
      evidence: [
        `Frontend module: ${mod.relativeFilePath}`,
        `${targets.length} direct coupled import(s): ${targets.map(target => `${target.role}:${graph.nodes.get(target.id)?.label ?? target.id}`).slice(0, 8).join(', ')}`,
        `Imported symbols: ${targets.flatMap(target => target.importedNames).slice(0, 12).join(', ') || 'unknown'}`,
      ],
      suggestion: 'Route UI through a feature/domain boundary or a framework-neutral adapter; keep rendering components from depending directly on API, storage, repository, or server modules.',
    }));
  }
  return findings;
}

function propTunnelDepth(
  modId: string,
  propName: string,
  modulesById: Map<string, ModuleInfo>,
  memo: Map<string, number>,
  onStack: Set<string>,
): number {
  const key = `${modId}:${propName}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  if (onStack.has(key)) return 0;
  onStack.add(key);
  const mod = modulesById.get(modId);
  if (!mod) {
    onStack.delete(key);
    memo.set(key, 0);
    return 0;
  }
  let maxDepth = 0;
  for (const component of mod.semanticHints?.ui?.components ?? []) {
    for (const child of component.childComponents) {
      if (!child.forwardedProps.includes(propName)) continue;
      maxDepth = Math.max(maxDepth, 1);
      for (const childModId of resolveChildModuleIds(mod, child)) {
        maxDepth = Math.max(maxDepth, 1 + propTunnelDepth(childModId, propName, modulesById, memo, onStack));
      }
    }
  }
  onStack.delete(key);
  memo.set(key, maxDepth);
  return maxDepth;
}

function resolveChildModuleIds(mod: ModuleInfo, child: UiChildComponentHint): string[] {
  const ids = new Set<string>();
  for (const imp of mod.imports) {
    if (imp.isTypeOnly || !imp.resolvedModuleId) continue;
    if (imp.importedNames.includes(child.componentName)) ids.add(imp.resolvedModuleId);
  }
  return [...ids];
}

function isLikelyLayoutOnlyComponent(component: UiComponentHint): boolean {
  return /(Layout|Shell|Frame|Stack|Grid|Section|Wrapper)$/.test(component.name);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function detectDesignSystemLeakage(
  modulesById: Map<string, ModuleInfo>,
  scope: RefactoringScope,
): RefactoringFinding[] {
  const findings: RefactoringFinding[] = [];
  for (const modId of scope.moduleIds) {
    const mod = modulesById.get(modId);
    if (!mod || !isDesignSystemPrimitive(mod)) continue;
    const targets: Array<{ id: string; role: string; importedNames: string[] }> = [];
    for (const imp of mod.imports) {
      if (imp.isTypeOnly || !imp.resolvedModuleId) continue;
      const target = modulesById.get(imp.resolvedModuleId);
      if (!target) continue;
      const role = coupledTargetRole(target);
      if (!role) continue;
      targets.push({ id: target.id, role, importedNames: imp.importedNames });
    }
    const dataAccess = mod.semanticHints?.ui?.dataAccess ?? [];
    if (targets.length === 0 && dataAccess.length === 0) continue;
    const roles = [...new Set(targets.map(target => target.role))].sort();
    findings.push(build({
      id: `design-system-leakage:${modId}`,
      category: 'design-system-leakage',
      title: 'Design-system primitive depends on product/domain concerns',
      impact: targets.some(target => target.role === 'api' || target.role === 'storage' || target.role === 'server') || dataAccess.length > 0 ? 'high' : 'medium',
      confidence: Math.min(0.92, 0.62 + targets.length * 0.08 + dataAccess.length * 0.1),
      nodes: [modId, ...targets.map(target => target.id)],
      evidence: [
        `Design-system module: ${mod.relativeFilePath}`,
        targets.length > 0 ? `Leaked target roles: ${roles.join(', ')}` : 'No coupled imports, but data-access calls were detected',
        dataAccess.length > 0 ? `Data access calls: ${dataAccess.map(item => item.callee).slice(0, 6).join(', ')}` : `Imported symbols: ${targets.flatMap(target => target.importedNames).slice(0, 12).join(', ') || 'unknown'}`,
      ],
      suggestion: 'Keep primitives product-agnostic: pass domain data through props or wrap the primitive in a feature component instead of importing feature/domain/API state into the design system.',
    }));
  }
  return findings;
}

export function detectServiceWrapperExplosion(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  scope: RefactoringScope,
  options: { thresholds?: RefactoringThresholds['serviceWrapperExplosion'] } = {},
): RefactoringFinding[] {
  const t = options.thresholds ?? DEFAULT_THRESHOLDS.serviceWrapperExplosion;
  type Wrapper = { id: string; groupKey: string; role: string; fanIn: number; lineCount: number };
  const byGroup = new Map<string, Wrapper[]>();
  for (const modId of scope.moduleIds) {
    const mod = modulesById.get(modId);
    if (!mod || !isFrontendServiceWrapperCandidate(mod)) continue;
    const hint = mod.semanticHints?.ui?.serviceWrapper;
    if (!hint) continue;
    const fanIn = (graph.inEdges.get(modId) ?? []).filter(isRuntimeImportEdge).length;
    const lineCount = maxModuleLine(mod) || hint.lineCount;
    if (lineCount > t.maxLineCount) continue;
    const feature = frontendFeatureKey(mod);
    const groupKey = feature && !feature.startsWith('pkg:') ? feature : `pkg:${mod.packageName}`;
    const wrapper: Wrapper = {
      id: modId,
      groupKey,
      role: hint.role,
      fanIn,
      lineCount,
    };
    let group = byGroup.get(groupKey);
    if (!group) { group = []; byGroup.set(groupKey, group); }
    group.push(wrapper);
  }

  const findings: RefactoringFinding[] = [];
  for (const [groupKey, wrappers] of byGroup) {
    const lowFanIn = wrappers.filter(wrapper => wrapper.fanIn <= t.maxFanIn).length;
    const roles = [...new Set(wrappers.map(wrapper => wrapper.role))].sort();
    if (roles.every(role => role === 'provider')) continue;
    if (wrappers.length < t.minGroupSize && !(wrappers.length >= Math.max(2, t.minGroupSize - 1) && lowFanIn >= Math.max(2, t.minGroupSize - 2))) continue;
    const providerPenalty = roles.includes('provider') ? 0.04 : 0;
    const confidence = Math.min(0.88, 0.48 + wrappers.length * 0.05 + lowFanIn * 0.04 + roles.length * 0.03 - providerPenalty);
    findings.push(build({
      id: `service-wrapper-explosion:${groupKey}`,
      category: 'service-wrapper-explosion',
      title: 'Frontend package/feature contains many thin service/client wrappers',
      impact: wrappers.length >= 7 ? 'high' : 'medium',
      confidence,
      nodes: wrappers.map(wrapper => wrapper.id),
      evidence: [
        `${wrappers.length} thin wrapper candidate(s) in ${groupKey}`,
        `${lowFanIn} wrapper(s) have fan-in <= ${t.maxFanIn}`,
        `Wrapper roles: ${roles.join(', ')}`,
        `Examples: ${labelsOf(graph, wrappers.map(wrapper => wrapper.id)).join(', ')}`,
      ],
      suggestion: 'Check whether these wrappers express real ownership boundaries. If most only delegate to another client, collapse them into a single feature API or move ownership to the domain/service boundary.',
    }));
  }
  return findings;
}

export function detectRouteConvergence(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  scope: RefactoringScope,
  options: { thresholds?: RefactoringThresholds['routeConvergence'] } = {},
): RefactoringFinding[] {
  const t = options.thresholds ?? DEFAULT_THRESHOLDS.routeConvergence;
  type RouteTargetGroup = {
    key: string;
    entries: Map<string, string[]>;
    targetModules: Set<string>;
    accessKinds: Set<string>;
  };
  const byTarget = new Map<string, RouteTargetGroup>();
  const addTarget = (
    key: string,
    entryId: string,
    entryRoutes: string[],
    accessKind: string,
    targetModuleId?: string,
  ): void => {
    let group = byTarget.get(key);
    if (!group) {
      group = { key, entries: new Map(), targetModules: new Set(), accessKinds: new Set() };
      byTarget.set(key, group);
    }
    group.entries.set(entryId, entryRoutes);
    group.accessKinds.add(accessKind);
    if (targetModuleId) group.targetModules.add(targetModuleId);
  };

  for (const modId of scope.moduleIds) {
    const mod = modulesById.get(modId);
    if (!mod || !isRouteOrScreenEntryModule(mod)) continue;
    const routePaths = (mod.semanticHints?.routes ?? [])
      .filter(route => route.kind !== 'api')
      .map(route => route.path);
    const entryRoutes = routePaths.length > 0 ? routePaths : [mod.relativeFilePath];

    const queue: Array<{ id: string; depth: number }> = [{ id: modId, depth: 0 }];
    const seen = new Set<string>([modId]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentMod = modulesById.get(current.id);
      if (!currentMod) continue;

      for (const access of currentMod.semanticHints?.ui?.dataAccess ?? []) {
        if (access.kind === 'query' || access.kind === 'storage') continue;
        const key = frontendDataAccessTargetKey(access.target);
        if (!key) continue;
        addTarget(key, modId, entryRoutes, access.kind, current.id === modId ? undefined : current.id);
      }

      for (const imp of currentMod.imports) {
        if (imp.isTypeOnly || !imp.resolvedModuleId) continue;
        const target = modulesById.get(imp.resolvedModuleId);
        if (!target) continue;
        const role = coupledTargetRole(target);
        const targetRel = target.relativeFilePath.replace(/\\/g, '/').toLowerCase();
        if (role === 'api' || role === 'server' || /(mutation|action|client|service|api)/.test(targetRel)) {
          addTarget(`module:${target.id}`, modId, entryRoutes, role ?? 'module', target.id);
        }
        if (current.depth >= t.maxBfsDepth) continue;
        if (!scope.moduleIds.has(target.id) || seen.has(target.id)) continue;
        if (isBuildOrToolingModule(targetRel) || isDesignSystemPrimitive(target)) continue;
        seen.add(target.id);
        queue.push({ id: target.id, depth: current.depth + 1 });
      }
    }
  }

  const findings: RefactoringFinding[] = [];
  for (const group of byTarget.values()) {
    if (group.entries.size < t.minEntrypoints) continue;
    const entryIds = [...group.entries.keys()];
    const targetIds = [...group.targetModules];
    const confidence = Math.min(0.9, 0.55 + group.entries.size * 0.07 + group.accessKinds.size * 0.04 + (targetIds.length > 0 ? 0.04 : 0));
    findings.push(build({
      id: `route-convergence:${group.key}`,
      category: 'route-convergence',
      title: 'Multiple routes converge on the same mutation/API target',
      impact: group.entries.size >= 4 ? 'high' : 'medium',
      confidence,
      nodes: [...targetIds, ...entryIds],
      evidence: [
        `${group.entries.size} route/screen entrypoint(s) converge on ${group.key}`,
        `Routes: ${[...group.entries.values()].flat().slice(0, 10).join(', ')}`,
        `Access kinds: ${[...group.accessKinds].sort().join(', ')}`,
        targetIds.length > 0 ? `Target modules: ${labelsOf(graph, targetIds).join(', ')}` : 'Target observed from direct data-access call',
      ],
      suggestion: 'Compare route-specific data preparation before this target; shared validation/mapping belongs near the target when the routes implement the same invariant.',
    }));
  }
  return findings;
}

// ── state-fragmentation ──

export function detectStateFragmentation(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  annotations: AnnotationStore,
  scope: RefactoringScope,
  options: { annotationReasoning?: boolean } = {},
): RefactoringFinding[] {
  const findings: RefactoringFinding[] = [];
  type StateGroup = { feature: string; modules: string[]; kinds: Set<string> };
  const groups = new Map<string, StateGroup>();
  for (const modId of scope.moduleIds) {
    const mod = modulesById.get(modId);
    if (!mod || !isFrontendSurfaceModule(mod) || isBuildOrToolingModule(mod.relativeFilePath.replace(/\\/g, '/').toLowerCase())) continue;
    const feature = frontendFeatureKey(mod);
    const kind = stateModuleKind(mod);
    if (!feature || !kind) continue;
    let group = groups.get(feature);
    if (!group) {
      group = { feature, modules: [], kinds: new Set() };
      groups.set(feature, group);
    }
    group.modules.push(modId);
    group.kinds.add(kind);
  }
  for (const group of groups.values()) {
    if (group.modules.length < 3 || group.kinds.size < 2) continue;
    const moduleSet = new Set(group.modules);
    let internalImports = 0;
    for (const modId of group.modules) {
      for (const edge of graph.outEdges.get(modId) ?? []) {
        if (isRuntimeImportEdge(edge) && moduleSet.has(edge.to)) internalImports++;
      }
    }
    const confidence = Math.min(0.88, 0.5 + group.modules.length * 0.06 + group.kinds.size * 0.06 + (internalImports < group.modules.length - 1 ? 0.08 : 0));
    const finding = build({
      id: `state-fragmentation:${group.feature}`,
      category: 'state-fragmentation',
      title: 'Feature state appears split across multiple client state mechanisms',
      impact: group.modules.length >= 5 ? 'high' : 'medium',
      confidence,
      nodes: group.modules,
      evidence: [
        `${group.modules.length} state-related module(s) in ${group.feature}`,
        `State mechanisms: ${[...group.kinds].sort().join(', ')}`,
        `${internalImports} internal import(s) between these state modules`,
      ],
      suggestion: 'Review whether this feature has one clear state owner; consolidate orchestration state or document why hooks/stores/contexts are intentionally separate.',
    });
    if (options.annotationReasoning) {
      const annotationContext = buildAnnotationContext('shared-state-shape', group.modules, graph, modulesById, annotations);
      if (annotationContext) finding.annotationContext = annotationContext;
    }
    findings.push(finding);
  }
  return findings;
}

// ── duplicated-client-policy ──

export function detectDuplicatedClientPolicy(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  annotations: AnnotationStore,
  scope: RefactoringScope,
  options: { annotationReasoning?: boolean } = {},
): RefactoringFinding[] {
  const findings: RefactoringFinding[] = [];
  type PolicyGroup = { token: string; modules: string[]; features: Set<string>; exportNames: Set<string> };
  const groups = new Map<string, PolicyGroup>();
  for (const modId of scope.moduleIds) {
    const mod = modulesById.get(modId);
    if (!mod || !isFrontendSurfaceModule(mod) || isBuildOrToolingModule(mod.relativeFilePath.replace(/\\/g, '/').toLowerCase())) continue;
    if (isDesignSystemPrimitive(mod)) continue;
    const tokens = policyTokens(mod, annotations.get(modId));
    const feature = frontendFeatureKey(mod);
    if (tokens.length === 0 || !feature) continue;
    for (const token of tokens) {
      const groupKey = `${token}:${policySubjectKey(mod)}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = { token: groupKey, modules: [], features: new Set(), exportNames: new Set() };
        groups.set(groupKey, group);
      }
      group.modules.push(modId);
      group.features.add(feature);
      for (const exp of mod.exports) group.exportNames.add(exp.name);
    }
  }
  const seenModuleSets = new Set<string>();
  for (const group of groups.values()) {
    if (group.modules.length < 3 || group.features.size < 2) continue;
    const moduleSetKey = [...new Set(group.modules)].sort().join('|');
    if (seenModuleSets.has(moduleSetKey)) continue;
    seenModuleSets.add(moduleSetKey);
    const confidence = Math.min(0.88, 0.5 + group.modules.length * 0.04 + group.features.size * 0.07);
    const finding = build({
      id: `duplicated-client-policy:${group.token}`,
      category: 'duplicated-client-policy',
      title: 'Similar client-side policy/mapping logic appears across multiple features',
      impact: group.features.size >= 4 || group.modules.length >= 6 ? 'high' : 'medium',
      confidence,
      nodes: group.modules,
      evidence: [
        `${group.modules.length} module(s) share ${group.token} responsibility`,
        `${group.features.size} feature/flow group(s): ${[...group.features].sort().slice(0, 8).join(', ')}`,
        `Example exports: ${[...group.exportNames].slice(0, 12).join(', ') || 'unknown'}`,
      ],
      suggestion: 'Compare the rules across features; extract shared policy only when the same domain invariant is being reimplemented rather than merely adapted for UI.',
    });
    if (options.annotationReasoning) {
      const annotationContext = buildAnnotationContext('shared-invariant', group.modules, graph, modulesById, annotations);
      if (annotationContext) finding.annotationContext = annotationContext;
    }
    findings.push(finding);
  }
  return findings;
}

// ── event-driven-boundary ──

export function detectEventDrivenBoundary(
  graph: RepositoryGraph,
  scope: RefactoringScope,
): RefactoringFinding[] {
  const findings: RefactoringFinding[] = [];
  const serviceSet = new Set(scope.serviceIds);
  const resourceIds = new Set<string>();
  for (const svcId of serviceSet) {
    for (const edge of graph.outEdges.get(svcId) ?? []) if (edge.kind === 'publishes') resourceIds.add(edge.to);
    for (const edge of graph.inEdges.get(svcId) ?? []) if (edge.kind === 'consumes') resourceIds.add(edge.from);
  }
  for (const resourceId of resourceIds) {
    const producers = (graph.inEdges.get(resourceId) ?? []).filter(e => e.kind === 'publishes' && serviceSet.has(e.from)).map(e => e.from);
    const consumers = (graph.outEdges.get(resourceId) ?? []).filter(e => e.kind === 'consumes' && serviceSet.has(e.to)).map(e => e.to);
    if (producers.length === 0 || consumers.length === 0) continue;
    const resourceNode = graph.nodes.get(resourceId);
    findings.push(build({
      id: `event-driven-boundary:${resourceId}`,
      category: 'event-driven-boundary',
      title: 'Event resource connects producer and consumer services',
      impact: producers.length + consumers.length >= 4 ? 'high' : 'medium',
      confidence: Math.min(0.93, 0.68 + (producers.length + consumers.length) * 0.04),
      nodes: [resourceId, ...producers, ...consumers],
      evidence: [
        `${producers.length} producer service(s): ${labelsOf(graph, producers).join(', ')}`,
        `${consumers.length} consumer service(s): ${labelsOf(graph, consumers).join(', ')}`,
        `Resource: ${resourceNode?.label ?? resourceId}`,
      ],
      suggestion: 'Treat this as a candidate bounded context boundary: check event schema ownership, idempotency, retry behavior, and whether shared business logic should be extracted instead of imported across services.',
    }));
  }
  return findings;
}

// ── security-oriented refactoring candidates ──

export function detectSecretConfigBoundary(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  annotations: AnnotationStore,
  scope: RefactoringScope,
  options: { annotationReasoning?: boolean; thresholds?: RefactoringThresholds['secretConfigBoundary'] } = {},
): RefactoringFinding[] {
  const t = options.thresholds ?? DEFAULT_THRESHOLDS.secretConfigBoundary;
  const findings: RefactoringFinding[] = [];
  for (const modId of scope.moduleIds) {
    const mod = modulesById.get(modId);
    if (!mod) continue;
    const secretEnv = securitySignals(mod, 'secret-env');
    const publicSecretEnv = securitySignals(mod, 'public-env')
      .filter(signal => signal.name && isSecretishName(signal.name, t.flagGenericPublicAuthEnv));
    if (secretEnv.length === 0 && publicSecretEnv.length === 0) continue;
    const clientImporters = clientImportersOf(graph, modulesById, modId, scope.moduleIds);
    const clientSurface = isFrontendSurfaceModule(mod) || mod.semanticHints?.ssr?.useClient === true;
    if (!clientSurface && clientImporters.length === 0 && publicSecretEnv.length === 0) continue;
    const evidenceScore = secretEnv.length * 2
      + publicSecretEnv.length * 2
      + (clientSurface ? 1 : 0)
      + Math.min(clientImporters.length, 2);
    if (evidenceScore < t.minEvidenceScore) continue;
    const envNames = [...new Set([...secretEnv, ...publicSecretEnv].map(signal => signal.name).filter((name): name is string => !!name))];
    const confidence = Math.min(0.94,
      0.62
      + envNames.length * 0.05
      + (clientSurface ? 0.12 : 0)
      + clientImporters.length * 0.06
      + publicSecretEnv.length * 0.08,
    );
    const finding = build({
      id: `secret-config-boundary:${modId}`,
      category: 'secret-config-boundary',
      title: 'Secret-like configuration crosses a client/public boundary',
      impact: clientSurface || publicSecretEnv.length > 0 ? 'high' : 'medium',
      confidence,
      nodes: [modId, ...clientImporters],
      evidence: [
        `Module: ${mod.relativeFilePath}`,
        `Secret-like env name(s): ${envNames.slice(0, 8).join(', ')}`,
        clientSurface ? 'Module is client/frontend-facing' : `${clientImporters.length} client/frontend importer(s) reach this module`,
        publicSecretEnv.length > 0 ? `${publicSecretEnv.length} public env var(s) have secret-like names` : 'No public env var names with secret-like tokens detected',
      ],
      suggestion: 'Split public config from secret config. Keep credential-owning reads in a server/runtime adapter and expose only typed, non-secret settings to client modules.',
    });
    if (options.annotationReasoning) {
      const annotationContext = buildAnnotationContext('secret-config-boundary', [modId], graph, modulesById, annotations);
      if (annotationContext) finding.annotationContext = annotationContext;
    }
    findings.push(finding);
  }
  return findings;
}

export function detectAuthorizationPolicyDrift(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  annotations: AnnotationStore,
  scope: RefactoringScope,
  options: { annotationReasoning?: boolean; thresholds?: RefactoringThresholds['authorizationPolicyDrift'] } = {},
): RefactoringFinding[] {
  const t = options.thresholds ?? DEFAULT_THRESHOLDS.authorizationPolicyDrift;
  type PolicyModule = { id: string; feature: string; tokens: string[]; exports: string[]; hasAuthzSignal: boolean };
  const groups = new Map<string, PolicyModule[]>();
  for (const modId of scope.moduleIds) {
    const mod = modulesById.get(modId);
    if (!mod || isBuildOrToolingModule(mod.relativeFilePath.replace(/\\/g, '/').toLowerCase()) || isPureTypesModule(mod)) continue;
    const ann = annotations.get(modId);
    const tokens = new Set(policyTokens(mod, ann).filter(token => token === 'permissions' || token === 'policy-rules'));
    const hasAuthzSignal = securitySignals(mod, 'authz').length > 0;
    if (hasAuthzSignal || /(?:tenant|role|permission|authorize|ownership|access)/i.test(annotationText(ann))) {
      tokens.add('permissions');
    }
    if (tokens.size === 0) continue;
    const feature = frontendFeatureKey(mod) ?? modulePackageId(graph, modId) ?? rootDomainOf(graph, modId) ?? 'unknown';
    for (const token of tokens) {
      const key = `${token}:${policySubjectKey(mod)}`;
      let group = groups.get(key);
      if (!group) { group = []; groups.set(key, group); }
      group.push({ id: modId, feature, tokens: [...tokens], exports: mod.exports.map(exp => exp.name), hasAuthzSignal });
    }
  }

  const findings: RefactoringFinding[] = [];
  for (const [key, modules] of groups) {
    const uniqueIds = [...new Set(modules.map(item => item.id))];
    const features = new Set(modules.map(item => item.feature));
    if (uniqueIds.length < t.minModules || features.size < t.minFeatureGroups) continue;
    if (!t.allowGeneralSubject && key.endsWith(':general')) continue;
    if (t.requireAuthzSignal && !modules.some(item => item.hasAuthzSignal)) continue;
    const confidence = Math.min(0.9, 0.55 + uniqueIds.length * 0.06 + features.size * 0.06);
    const finding = build({
      id: `authorization-policy-drift:${key}`,
      category: 'authorization-policy-drift',
      title: 'Authorization or access policy appears duplicated across boundaries',
      impact: uniqueIds.length >= 4 || features.size >= 3 ? 'high' : 'medium',
      confidence,
      nodes: uniqueIds,
      evidence: [
        `${uniqueIds.length} module(s) share ${key} security-policy responsibility`,
        `${features.size} feature/package group(s): ${[...features].sort().slice(0, 8).join(', ')}`,
        `Example exports: ${[...new Set(modules.flatMap(item => item.exports))].slice(0, 12).join(', ') || 'unknown'}`,
      ],
      suggestion: 'Centralize shared authorization invariants in a server-side/domain policy module; keep client checks as UX hints, not enforcement.',
    });
    if (options.annotationReasoning) {
      const annotationContext = buildAnnotationContext('shared-security-invariant', uniqueIds, graph, modulesById, annotations);
      if (annotationContext) finding.annotationContext = annotationContext;
    }
    findings.push(finding);
  }
  return findings;
}

export function detectTrustBoundaryValidation(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  annotations: AnnotationStore,
  scope: RefactoringScope,
  options: { annotationReasoning?: boolean; thresholds?: RefactoringThresholds['trustBoundaryValidation'] } = {},
): RefactoringFinding[] {
  const t = options.thresholds ?? DEFAULT_THRESHOLDS.trustBoundaryValidation;
  const findings: RefactoringFinding[] = [];
  for (const modId of scope.moduleIds) {
    const mod = modulesById.get(modId);
    if (!mod || !isTrustBoundaryModule(mod)) continue;
    if (hasValidationCoverage(mod, modulesById)) continue;
    const routeCount = mod.semanticHints?.routes?.filter(route => route.kind === 'api').length ?? 0;
    const hasMutation = (mod.semanticHints?.ui?.dataAccess ?? []).some(access => access.kind === 'mutation' || access.kind === 'api-client');
    const hasSideEffects = (mod.semanticHints?.runtimeActions?.length ?? 0) > 0 || hasMutation;
    const hasAuthz = securitySignals(mod, 'authz').length > 0;
    const evidenceScore = routeCount * 2 + (hasSideEffects ? 2 : 0) + (hasAuthz ? 1 : 0) + (exportedNamesText(mod) ? 1 : 0);
    if (t.requireRouteOrSideEffect && routeCount === 0 && !hasSideEffects && !hasAuthz) continue;
    if (evidenceScore < t.minEvidenceScore) continue;
    const confidence = Math.min(0.88,
      0.58
      + routeCount * 0.08
      + (hasSideEffects ? 0.08 : 0)
      + (hasAuthz ? 0.04 : 0),
    );
    const finding = build({
      id: `trust-boundary-validation:${modId}`,
      category: 'trust-boundary-validation',
      title: 'Entrypoint/trust-boundary module lacks nearby validation signals',
      impact: hasSideEffects || routeCount > 0 ? 'high' : 'medium',
      confidence,
      nodes: [modId],
      evidence: [
        `Trust-boundary path or export: ${mod.relativeFilePath}`,
        routeCount > 0 ? `${routeCount} API route marker(s)` : `Exports: ${mod.exports.map(exp => exp.name).slice(0, 8).join(', ') || 'unknown'}`,
        'No direct schema/validator/guard import or validation call was detected',
        hasSideEffects ? 'Boundary also appears to perform mutation/runtime side effects' : 'No mutation/runtime side-effect hint detected',
      ],
      suggestion: 'Place runtime validation at the HTTP/webhook/queue/user-input boundary, or import a clearly named schema/guard module before orchestration begins.',
    });
    if (options.annotationReasoning) {
      const annotationContext = buildAnnotationContext('input-validation-boundary', [modId], graph, modulesById, annotations);
      if (annotationContext) finding.annotationContext = annotationContext;
    }
    findings.push(finding);
  }
  return findings;
}

export function detectPrivilegedClientSideEffect(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  annotations: AnnotationStore,
  scope: RefactoringScope,
  options: { annotationReasoning?: boolean; thresholds?: RefactoringThresholds['privilegedClientSideEffect'] } = {},
): RefactoringFinding[] {
  const t = options.thresholds ?? DEFAULT_THRESHOLDS.privilegedClientSideEffect;
  const findings: RefactoringFinding[] = [];
  for (const modId of scope.moduleIds) {
    const mod = modulesById.get(modId);
    if (!mod || !isFrontendSurfaceModule(mod) || isBuildOrToolingModule(mod.relativeFilePath.replace(/\\/g, '/').toLowerCase())) continue;
    const coupledTargets = privilegedClientTargets(mod, modulesById, t.allowGenericStorageName);
    const runtimeActions = mod.semanticHints?.runtimeActions ?? [];
    const secretSignals = securitySignals(mod, 'secret-env');
    const mutationAccess = (mod.semanticHints?.ui?.dataAccess ?? [])
      .filter(access => access.kind === 'mutation' || access.kind === 'api-client');
    const annotationPrivileged = hasPrivilegedAnnotationSideEffect(annotations.get(modId));
    if (coupledTargets.length === 0 && runtimeActions.length === 0 && secretSignals.length === 0 && mutationAccess.length === 0 && !annotationPrivileged) continue;
    const hasStrongEvidence = coupledTargets.length > 0 || runtimeActions.length > 0 || secretSignals.length > 0 || annotationPrivileged;
    if (!t.includeMutationOnly && !hasStrongEvidence) continue;
    const evidenceScore = coupledTargets.length * 2
      + runtimeActions.length * 2
      + secretSignals.length * 2
      + (mutationAccess.length > 0 ? 1 : 0)
      + (annotationPrivileged ? 1 : 0);
    if (evidenceScore < t.minEvidenceScore) continue;
    const confidence = Math.min(0.92,
      0.54
      + coupledTargets.length * 0.07
      + runtimeActions.length * 0.1
      + secretSignals.length * 0.08
      + mutationAccess.length * 0.04
      + (annotationPrivileged ? 0.08 : 0),
    );
    const finding = build({
      id: `privileged-client-side-effect:${modId}`,
      category: 'privileged-client-side-effect',
      title: 'Client/UI module appears to own privileged side effects',
      impact: runtimeActions.length > 0 || secretSignals.length > 0 || coupledTargets.some(target => target.role === 'server' || target.role === 'storage') ? 'high' : 'medium',
      confidence,
      nodes: [modId, ...coupledTargets.map(target => target.id)],
      evidence: [
        `Client/UI module: ${mod.relativeFilePath}`,
        coupledTargets.length > 0 ? `Privileged imports: ${coupledTargets.map(target => `${target.role}:${graph.nodes.get(target.id)?.label ?? target.id}`).slice(0, 8).join(', ')}` : 'No privileged imports detected',
        runtimeActions.length > 0 ? `${runtimeActions.length} runtime action hint(s)` : 'No runtime action hints',
        mutationAccess.length > 0 ? `${mutationAccess.length} mutation/API-client data access call(s)` : 'No mutation/API-client data access calls',
        secretSignals.length > 0 ? `${secretSignals.length} secret-like env reference(s)` : 'No secret-like env references',
      ],
      suggestion: 'Move credentialed writes, SDK calls, queues/lambdas, and storage access behind a server/API boundary. Leave the client with a narrow request contract and presentation state.',
    });
    if (options.annotationReasoning) {
      const annotationContext = buildAnnotationContext('privileged-client-side-effect', [modId], graph, modulesById, annotations);
      if (annotationContext) finding.annotationContext = annotationContext;
    }
    findings.push(finding);
  }
  return findings;
}

export function detectSensitiveBrowserStorage(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  annotations: AnnotationStore,
  scope: RefactoringScope,
  options: { annotationReasoning?: boolean; thresholds?: RefactoringThresholds['sensitiveBrowserStorage'] } = {},
): RefactoringFinding[] {
  const t = options.thresholds ?? DEFAULT_THRESHOLDS.sensitiveBrowserStorage;
  const findings: RefactoringFinding[] = [];
  for (const modId of scope.moduleIds) {
    const mod = modulesById.get(modId);
    if (!mod || !isFrontendSurfaceModule(mod)) continue;
    const ann = annotations.get(modId);
    const sensitiveSignals = securitySignals(mod, 'browser-storage-sensitive');
    const annotationStorageSignals = hasSensitiveAnnotationData(ann) ? securitySignals(mod, 'browser-storage') : [];
    const storageSignals = [
      ...sensitiveSignals,
      ...(annotationStorageSignals.length >= t.minAnnotationStorageSignals ? annotationStorageSignals : []),
    ];
    if (storageSignals.length === 0) continue;
    const targets = [...new Set(storageSignals.map(signal => signal.target).filter((target): target is string => !!target))];
    const hasSensitiveKey = targets.some(isSensitiveStorageKey) || sensitiveSignals.length > 0;
    if (t.requireSensitiveKey && !hasSensitiveKey) continue;
    const annotationSensitive = hasSensitiveAnnotationData(ann);
    const confidence = Math.min(0.9, 0.58 + storageSignals.length * 0.06 + (annotationSensitive ? 0.08 : 0));
    const finding = build({
      id: `sensitive-browser-storage:${modId}`,
      category: 'sensitive-browser-storage',
      title: 'Browser storage may hold sensitive state',
      impact: targets.some(isSensitiveStorageKey) || hasSensitiveAnnotationData(annotations.get(modId)) ? 'high' : 'medium',
      confidence,
      nodes: [modId],
      evidence: [
        `Frontend module: ${mod.relativeFilePath}`,
        `${storageSignals.length} browser-storage/cookie signal(s)`,
        targets.length > 0 ? `Storage key(s): ${targets.slice(0, 8).join(', ')}` : 'Storage key names were not statically resolved',
        annotationSensitive ? 'Annotation mentions sensitive state/data flow' : 'Sensitive key name detected syntactically',
      ],
      suggestion: 'Keep tokens, sessions, auth state, PII, tenant/user identity, and payment/customer data out of browser storage when possible; prefer server sessions, httpOnly cookies, or a narrow redacted cache.',
    });
    if (options.annotationReasoning) {
      const annotationContext = buildAnnotationContext('sensitive-browser-storage', [modId], graph, modulesById, annotations);
      if (annotationContext) finding.annotationContext = annotationContext;
    }
    findings.push(finding);
  }
  return findings;
}

export function detectServerClientBoundary(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  annotations: AnnotationStore,
  scope: RefactoringScope,
  options: { annotationReasoning?: boolean; thresholds?: RefactoringThresholds['serverClientBoundary'] } = {},
): RefactoringFinding[] {
  const t = options.thresholds ?? DEFAULT_THRESHOLDS.serverClientBoundary;
  const findings: RefactoringFinding[] = [];
  for (const modId of scope.moduleIds) {
    const mod = modulesById.get(modId);
    if (!mod || !isFrontendSurfaceModule(mod) || isBuildOrToolingModule(mod.relativeFilePath.replace(/\\/g, '/').toLowerCase())) continue;
    const leakedTargets = mod.imports
      .filter(imp => !imp.isTypeOnly && imp.resolvedModuleId)
      .map(imp => ({ imp, target: modulesById.get(imp.resolvedModuleId!) }))
      .filter((item): item is { imp: ModuleInfo['imports'][number]; target: ModuleInfo } =>
        !!item.target && isServerOnlyOrPrivilegedTarget(item.target, t.allowGenericStorageName));
    if (leakedTargets.length === 0) continue;
    const targetIds = [...new Set(leakedTargets.map(item => item.target.id))];
    if (targetIds.length < t.minTargets) continue;
    const confidence = Math.min(0.93, 0.64 + leakedTargets.length * 0.07 + (mod.semanticHints?.ssr?.useClient ? 0.06 : 0));
    const finding = build({
      id: `server-client-boundary:${modId}`,
      category: 'server-client-boundary',
      title: 'Client module imports server-only or privileged implementation',
      // Impact is derived from the SAME server-only/privileged signals that drove inclusion, so a
      // secret/ssr-server/.server-file leak (which coupledTargetRole does not classify as server) is
      // rated high, not medium. Medium is reserved for a leak admitted only via a generic storage name.
      impact: leakedTargets.some(item => {
        const targetRel = item.target.relativeFilePath.replace(/\\/g, '/').toLowerCase();
        return securityTargetRole(item.target, t.allowGenericStorageName) === 'server'
          || item.target.semanticHints?.ssr?.useServer === true
          || /(^|\/)secrets?(\/|$)/.test(targetRel)
          || /\.(server|backend)\.(tsx?|jsx?)$/.test(targetRel)
          || isStrongStorageTarget(item.target);
      }) ? 'high' : 'medium',
      confidence,
      nodes: [modId, ...targetIds],
      evidence: [
        `Client module: ${mod.relativeFilePath}`,
        `${targetIds.length} server/privileged target(s): ${targetIds.map(id => graph.nodes.get(id)?.label ?? id).slice(0, 8).join(', ')}`,
        `Imported symbols: ${leakedTargets.flatMap(item => item.imp.importedNames).slice(0, 12).join(', ') || 'unknown'}`,
      ],
      suggestion: 'Introduce a client-safe adapter or package export. Keep server-only/storage/credential-owning implementation behind server actions, API routes, or runtime-only packages.',
    });
    if (options.annotationReasoning) {
      const annotationContext = buildAnnotationContext('server-client-boundary', [modId, ...targetIds], graph, modulesById, annotations);
      if (annotationContext) finding.annotationContext = annotationContext;
    }
    findings.push(finding);
  }
  return findings;
}

export function detectSourceDisclosureSurface(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  annotations: AnnotationStore,
  scope: RefactoringScope,
  options: { annotationReasoning?: boolean; thresholds?: RefactoringThresholds['sourceDisclosureSurface'] } = {},
): RefactoringFinding[] {
  const t = options.thresholds ?? DEFAULT_THRESHOLDS.sourceDisclosureSurface;
  const findings: RefactoringFinding[] = [];
  for (const modId of scope.moduleIds) {
    const mod = modulesById.get(modId);
    if (!mod) continue;
    const signals = securitySignals(mod, 'source-disclosure');
    if (signals.length < t.minSignals) continue;
    const confidence = Math.min(0.9, 0.62 + signals.length * 0.08 + (mod.exports.length > 0 ? 0.04 : 0));
    const finding = build({
      id: `source-disclosure-surface:${modId}`,
      category: 'source-disclosure-surface',
      title: 'Tool/API surface can expose source bodies or private implementation details',
      impact: signals.some(signal => signal.name === 'source-body-surface') ? 'high' : 'medium',
      confidence,
      nodes: [modId],
      evidence: [
        `Module: ${mod.relativeFilePath}`,
        `${signals.length} source-disclosure signal(s)`,
        `Signal lines: ${signals.map(signal => signal.lineRange?.start).filter((line): line is number => line != null).slice(0, 8).join(', ') || 'unknown'}`,
        `Exports: ${mod.exports.map(exp => exp.name).slice(0, 8).join(', ') || 'unknown'}`,
      ],
      suggestion: 'Review root containment, path redaction, body/grep limits, regex safety, and secret-like line redaction before exposing source snippets to tool callers.',
    });
    if (options.annotationReasoning) {
      const annotationContext = buildAnnotationContext('source-disclosure-surface', [modId], graph, modulesById, annotations);
      if (annotationContext) finding.annotationContext = annotationContext;
    }
    findings.push(finding);
  }
  return findings;
}

export function detectAnnotationSecretHygiene(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  annotations: AnnotationStore,
  scope: RefactoringScope,
  options: { thresholds?: RefactoringThresholds['annotationSecretHygiene'] } = {},
): RefactoringFinding[] {
  const t = options.thresholds ?? DEFAULT_THRESHOLDS.annotationSecretHygiene;
  if (!t.enabled) return [];
  const findings: RefactoringFinding[] = [];
  for (const modId of scope.moduleIds) {
    const ann = annotations.get(modId);
    if (!ann) continue;
    const fieldPaths = annotationSecretFieldPaths(ann.annotation);
    if (fieldPaths.length === 0) continue;
    const mod = modulesById.get(modId);
    findings.push(build({
      id: `annotation-secret-hygiene:${modId}`,
      category: 'annotation-secret-hygiene',
      title: 'Semantic annotation may contain secret material',
      impact: 'high',
      confidence: 0.86,
      nodes: [modId],
      evidence: [
        `Node: ${graph.nodes.get(modId)?.label ?? mod?.relativeFilePath ?? modId}`,
        `${fieldPaths.length} annotation field(s) contain secret-like material`,
        `Field paths: ${fieldPaths.slice(0, 8).join(', ')}`,
        'Evidence intentionally omits the suspected value',
      ],
      suggestion: 'Remove secret values from annotations. Keep only env/config names and high-level risk descriptions, then rotate any credential that may have been committed.',
    }));
  }
  return findings;
}

function securitySignals(mod: ModuleInfo, kind: SecuritySignal['kind']): SecuritySignal[] {
  return (mod.semanticHints?.security ?? []).filter(signal => signal.kind === kind);
}

function clientImportersOf(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  targetId: string,
  scopedModuleIds: Set<string>,
): string[] {
  return (graph.inEdges.get(targetId) ?? [])
    .filter(edge => isRuntimeImportEdge(edge) && scopedModuleIds.has(edge.from))
    .map(edge => edge.from)
    .filter(id => {
      const importer = modulesById.get(id);
      return importer ? isFrontendSurfaceModule(importer) : false;
    });
}

function isSecretishName(name: string, flagGenericPublicAuthEnv: boolean): boolean {
  const strong = /(?:^|_)(SECRET|TOKEN|PASSWORD|PASS|PRIVATE|CREDENTIAL|API_KEY|ACCESS_KEY|CLIENT_SECRET|JWT)(?:_|$)/i.test(name)
    || /(API_KEY|ACCESS_KEY|CLIENT_SECRET)/i.test(name);
  if (strong) return true;
  return flagGenericPublicAuthEnv && /(?:^|_)(SESSION|AUTH)(?:_|$)/i.test(name);
}

function rootDomainOf(graph: RepositoryGraph, modId: string): string | undefined {
  const domain = (graph.outEdges.get(modId) ?? []).find(edge => edge.kind === 'tagged')?.to;
  return domain ? rootDomainId(graph, domain) : undefined;
}

function isTrustBoundaryModule(mod: ModuleInfo): boolean {
  const rel = mod.relativeFilePath.replace(/\\/g, '/').toLowerCase();
  if ((mod.semanticHints?.routes ?? []).some(route => route.kind === 'api')) return true;
  if (/(^|\/)(api|apis|routes|controllers?|handlers?|webhooks?|lambda|functions|server)(\/|$)/.test(rel)) return true;
  if (/(^|\/)(route|\+server)\.(tsx?|jsx?)$/.test(rel)) return true;
  const exported = exportedNamesText(mod);
  return /\b(handler|GET|POST|PUT|PATCH|DELETE|loader|action|webhook)\b/.test(exported);
}

function hasValidationCoverage(mod: ModuleInfo, modulesById: Map<string, ModuleInfo>): boolean {
  if (securitySignals(mod, 'validation').length > 0) return true;
  if (policyTokens(mod).includes('validation')) return true;
  for (const imp of mod.imports) {
    const spec = imp.moduleSpecifier.toLowerCase();
    if (/(zod|yup|joi|valibot|superstruct|schema|schemas|validator|validators|validation|guards?)/.test(spec)) return true;
    const target = imp.resolvedModuleId ? modulesById.get(imp.resolvedModuleId) : undefined;
    if (target && /(^|\/)(schemas?|validators?|validation|guards?)(\/|\.|$)/.test(target.relativeFilePath.replace(/\\/g, '/').toLowerCase())) return true;
  }
  return false;
}

function privilegedClientTargets(
  mod: ModuleInfo,
  modulesById: Map<string, ModuleInfo>,
  allowGenericStorageName: boolean,
): Array<{ id: string; role: string }> {
  const out: Array<{ id: string; role: string }> = [];
  for (const imp of mod.imports) {
    if (imp.isTypeOnly || !imp.resolvedModuleId) continue;
    const target = modulesById.get(imp.resolvedModuleId);
    if (!target) continue;
    const role = securityTargetRole(target, allowGenericStorageName);
    if (role === 'server' || role === 'storage') out.push({ id: target.id, role });
  }
  return out;
}

function securityTargetRole(target: ModuleInfo, allowGenericStorageName: boolean): string | undefined {
  const role = coupledTargetRole(target);
  if (role !== 'storage') return role;
  if (allowGenericStorageName || isStrongStorageTarget(target)) return role;
  return undefined;
}

function isStrongStorageTarget(target: ModuleInfo): boolean {
  const rel = target.relativeFilePath.replace(/\\/g, '/').toLowerCase();
  if (isFrontendSurfaceModule(target)) return false;
  return /(^|\/)(server|servers|backend|lambda|lambdas|functions|db|database|repositories?|repository|persistence)(\/|$)/.test(rel)
    || /(repository|repo|db|database)\.(tsx?|jsx?)$/.test(rel);
}

// Logging writes are not privileged; everything else under io-write is.
const NON_PRIVILEGED_IO_WRITE_SUBTYPES = new Set(['stdout', 'stderr']);

/**
 * Structured read of the annotation's sideEffects vocabulary — mirrors the
 * `privileged-client-side-effect` agent contract in annotation-context.ts.
 * Privileged kinds: io-write (any subtype except stdout/stderr), external
 * (opaque SDK/CLI/RPC/native), state-global, resource. io-read is deliberately
 * excluded (a narrow read against a public API is not a privileged action).
 */
function hasPrivilegedAnnotationSideEffect(ann: StoredAnnotation | undefined): boolean {
  const sideEffects = ann?.annotation.sideEffects;
  if (!sideEffects?.length) return false;
  return sideEffects.some(se => {
    switch (se.kind) {
      case 'io-write':
        return !NON_PRIVILEGED_IO_WRITE_SUBTYPES.has(se.subtype?.toLowerCase() ?? '');
      case 'external':
      case 'state-global':
      case 'resource':
        return true;
      default:
        return false;
    }
  });
}

function hasSensitiveAnnotationData(ann: StoredAnnotation | undefined): boolean {
  const text = annotationText(ann).toLowerCase();
  return /\b(token|session|jwt|auth state|credential|secret|password|pii|email|customer|payment|card|tenant|user id|refresh token|access token)\b/.test(text);
}

function isSensitiveStorageKey(key: string): boolean {
  return /(?:token|secret|password|session|jwt|auth|credential|api[_-]?key|refresh|access|tenant|user|email|customer|payment|card)/i.test(key);
}

function isServerOnlyOrPrivilegedTarget(target: ModuleInfo, allowGenericStorageName: boolean): boolean {
  const rel = target.relativeFilePath.replace(/\\/g, '/').toLowerCase();
  const role = securityTargetRole(target, allowGenericStorageName);
  // Storage-family dirs (db/database/repository/persistence) are intentionally NOT matched here:
  // they resolve to role 'storage', which securityTargetRole already gates on allowGenericStorageName
  // + isStrongStorageTarget. Re-admitting them via a raw regex bypassed that gate (a strict-mode
  // false positive on a frontend cache dir). Only genuinely server-only tokens stay in the regex.
  return role === 'server'
    || role === 'storage'
    || target.semanticHints?.ssr?.useServer === true
    || /(^|\/)(server|server-only|backend|lambda|functions|secrets?)(\/|$)/.test(rel)
    || /\.(server|backend)\.(tsx?|jsx?)$/.test(rel);
}

// ── annotation-risk ──

export function detectAnnotationRisk(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  annotations: AnnotationStore,
  scope: RefactoringScope,
  options: {
    thresholds?: RefactoringThresholds['annotationRisk'];
    /**
     * Set of module ids that are derived-stale (an upstream import changed within
     * `derivedStaleHopLimit` hops). Precomputed by the orchestrator. When omitted,
     * derived-stale evidence is not added.
     */
    derivedStaleSet?: ReadonlySet<string>;
  } = {},
): RefactoringFinding[] {
  const t = options.thresholds ?? DEFAULT_THRESHOLDS.annotationRisk;
  const derivedStaleSet = options.derivedStaleSet;
  const findings: RefactoringFinding[] = [];
  for (const modId of scope.moduleIds) {
    const mod = modulesById.get(modId);
    const fanIn = (graph.inEdges.get(modId) ?? []).filter(isRuntimeImportEdge).length;
    const fanOut = (graph.outEdges.get(modId) ?? []).filter(isRuntimeImportEdge).length;
    const exportCount = mod?.exports.length ?? 0;
    const importance = fanIn + fanOut + exportCount;
    if (importance < t.minImportance) continue;
    const ann = annotations.get(modId);
    const node = graph.nodes.get(modId);
    const moduleKind = mod ? inferModuleKind({ mod, node }) : undefined;
    const quality = ann && mod
      ? computeAnnotationQuality(ann.annotation, {
          exportCount,
          lineCount: maxModuleLine(mod),
          envVars: mod.semanticHints?.envVars,
          moduleKind,
        })
      : undefined;

    // Effective quality bar: the per-kind bar (minQualityScoreByKind[kind]) wins; the scalar
    // minQualityScore is only the fallback for a module whose kind has no per-kind entry (all six
    // common kinds are set in every built-in profile, so the scalar bites only custom configs or an
    // unknown kind). For a derived-stale module the bar is raised by `derivedStalePenalty`.
    //
    // The raised bar does NOT gate the skip: the guard below requires `!isDerivedStale`, so a
    // derived-stale module ALWAYS surfaces (an upstream change means its claims need re-confirming).
    // The bar only sets confidence — clearing the raised bar → low-confidence "may still hold" (0.6);
    // missing it → "annotate" (0.72). See the confidence/suggestion branches below.
    const baseBar = moduleKind && t.minQualityScoreByKind?.[moduleKind] != null
      ? t.minQualityScoreByKind[moduleKind]!
      : t.minQualityScore;
    const isDerivedStale = derivedStaleSet?.has(modId) ?? false;
    const effectiveBar = isDerivedStale ? baseBar + t.derivedStalePenalty : baseBar;

    const contentFresh = !mod || annotations.isFresh(modId, mod.contentHash);
    const qualityOk = ann && quality && quality.score >= effectiveBar;
    if (qualityOk && contentFresh && !isDerivedStale) continue;

    const isContentStale = mod && ann && !annotations.isFresh(modId, mod.contentHash);
    const title = !ann
      ? 'Important module has no annotation'
      : isContentStale
        ? 'Important module has stale annotation (own content changed)'
        : isDerivedStale
          ? 'Important module has annotation that may not reflect upstream changes'
          : 'Important module has weak annotation for its kind';

    const evidence: string[] = [
      `Dependency/export importance score: ${importance}`,
      ann
        ? `Annotation quality score: ${(quality?.score ?? 0).toFixed(1)}/10 (kind: ${moduleKind ?? 'unknown'}, bar: ${baseBar}${isDerivedStale ? ` + ${t.derivedStalePenalty} derived-stale penalty = ${effectiveBar}` : ''})`
        : 'No annotation found',
    ];
    if (isContentStale) {
      evidence.push('Annotation is stale for current content hash/schema');
    } else if (isDerivedStale) {
      evidence.push(`Upstream import changed within ${t.derivedStaleHopLimit} hop(s); summary/sideEffects/dataFlow may no longer hold`);
    } else if (ann) {
      evidence.push('Annotation freshness is acceptable');
    }
    if (ann && quality?.missingFields && quality.missingFields.length > 0) {
      evidence.push(`Missing fields for kind "${moduleKind}": ${quality.missingFields.slice(0, 5).join(', ')}`);
    }

    findings.push(build({
      id: `annotation-risk:${modId}`,
      category: 'annotation-risk',
      title,
      impact: importance >= 18 ? 'high' : 'medium',
      // Slightly lower confidence for derived-stale-only flags: the annotation
      // might still be accurate; the agent has to confirm by reading upstream.
      confidence: !ann ? 0.82 : (isContentStale ? 0.78 : (isDerivedStale && qualityOk ? 0.6 : 0.72)),
      nodes: [modId],
      evidence,
      suggestion: isDerivedStale && qualityOk
        ? 'Inspect the changed upstream import(s) and decide whether this annotation\'s summary/sideEffects/dataFlow still hold. If yes, a no-op merge re-confirms freshness; otherwise point-merge the affected fields.'
        : 'Annotate this node before refactoring; future architectural reports become much more useful when high-impact modules explain invariants, side effects, and risks.',
    }));
  }
  return findings;
}

// ── unclear-architecture ──

export function detectUnclearArchitecture(
  graph: RepositoryGraph,
  scope: RefactoringScope,
  options: { thresholds?: RefactoringThresholds['unclearArchitecture'] } = {},
): RefactoringFinding[] {
  const t = options.thresholds ?? DEFAULT_THRESHOLDS.unclearArchitecture;
  const findings: RefactoringFinding[] = [];
  for (const modId of scope.moduleIds) {
    const domains = (graph.outEdges.get(modId) ?? [])
      .filter(e => e.kind === 'tagged')
      .map(e => e.to);
    const rootDomains = [...new Set(domains.map(domainId => rootDomainId(graph, domainId)))];
    if (rootDomains.length < t.minDomainTags) continue;
    findings.push(build({
      id: `unclear-architecture:${modId}:domains`,
      category: 'unclear-architecture',
      title: 'Module belongs to many domains',
      impact: rootDomains.length >= 7 ? 'high' : 'medium',
      confidence: Math.min(0.9, 0.55 + rootDomains.length * 0.06),
      nodes: [modId, ...rootDomains],
      evidence: [
        `${domains.length} raw domain tag(s), ${rootDomains.length} root domain(s): ${rootDomains.map(d => graph.nodes.get(d)?.label ?? d).join(', ')}`,
        'Parent/subdomain tags are collapsed before counting so hierarchical domains do not inflate this signal.',
      ],
      suggestion: 'Check whether this should be tagged as a technical layer, split into domain-specific adapters, or excluded from broad pattern tags.',
    }));
  }
  for (const svcId of scope.serviceIds) {
    const node = graph.nodes.get(svcId);
    if (node?.type !== 'runtime-resource' || node.data?.kind !== 'lambda') continue;
    const handlerEdges = (graph.outEdges.get(svcId) ?? []).filter(e => e.kind === 'infra');
    if (handlerEdges.length > 0 || node.data.handler) continue;
    findings.push(build({
      id: `unclear-architecture:${svcId}:handler`,
      category: 'unclear-architecture',
      title: 'Runtime service has no resolved handler module',
      impact: 'medium',
      confidence: 0.78,
      nodes: [svcId],
      evidence: [
        `Service kind: ${node.data.kind}`,
        'No infra edge or handler metadata resolved to a source module',
      ],
      suggestion: 'Check handler root configuration and IaC parser coverage; unresolved handlers weaken impact analysis and runtime topology.',
    }));
  }
  return findings;
}

// Re-exported for detail.ts so it can be one of its inputs without re-importing
// from heuristics.ts directly (keeps detail.ts coupled to the public refactoring
// boundary).
export { exportedNamesText };
