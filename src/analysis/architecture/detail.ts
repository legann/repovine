/**
 * Opportunity detail expansion: given a single finding, return node summaries,
 * relationship edges, category-specific facts, and recommended next MCP calls.
 */

import type { RepositoryGraph, ModuleInfo } from '../../types.js';
import type { AnnotationStore } from '../../annotations/store.js';
import { computeAnnotationQuality } from '../../annotations/quality.js';
import { annotationFreshnessMeta, type NodeFreshnessLookup } from '../../annotations/freshness.js';
import { inferModuleKind } from '../../annotations/module-kind.js';
import { annotationSecretFieldPaths } from './annotation-secret.js';
import { annotationExcerpt } from './annotation-context.js';
import { workflowSignalKinds } from './component-signals.js';
import { isNodeType, modulePackageId, nodeLabel, packageModuleIds, taggedDomains } from '../../graph/index.js';
import type { RefactoringFinding } from './types.js';
import { coupledTargetRole, frontendDataAccessTargetKey, frontendFeatureKey, isFrontendFlowEntryModule, isRuntimeImportEdge, maxModuleLine, policyTokens, runtimeFanIn, runtimeFanOut, stateModuleKind, uiCouplingTargetRole } from './heuristics.js';
import { isBarrelModule } from '../../graph/module-files.js';

function nodeDomains(graph: RepositoryGraph, nodeId: string): string[] {
  return taggedDomains(graph, nodeId).ids;
}

export function refactoringNodeSummary(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  annotations: AnnotationStore,
  nodeId: string,
  freshnessOf: NodeFreshnessLookup,
): Record<string, unknown> {
  const node = graph.nodes.get(nodeId);
  const mod = modulesById.get(nodeId);
  const ann = annotations.get(nodeId);
  const fanIn = runtimeFanIn(graph, nodeId);
  const fanOut = runtimeFanOut(graph, nodeId);
  const summary: Record<string, unknown> = {
    id: nodeId,
    label: nodeLabel(graph, nodeId),
    type: node?.type ?? 'unknown',
  };
  if (mod) {
    const moduleKind = inferModuleKind({ mod, node });
    const quality = ann
      ? computeAnnotationQuality(ann.annotation, {
          exportCount: mod.exports.length,
          lineCount: maxModuleLine(mod),
          envVars: mod.semanticHints?.envVars,
          moduleKind,
        })
      : undefined;
    summary.packageId = modulePackageId(graph, nodeId);
    summary.relativeFilePath = mod.relativeFilePath;
    summary.exports = mod.exports.slice(0, 12).map(exp => ({ name: exp.name, kind: exp.kind, lineRange: exp.lineRange }));
    summary.exportCount = mod.exports.length;
    summary.fanIn = fanIn;
    summary.fanOut = fanOut;
    summary.envVars = mod.semanticHints?.envVars ?? [];
    summary.domains = nodeDomains(graph, nodeId);
    summary.moduleKind = moduleKind;
    if (ann) {
      const verdict = freshnessOf(nodeId);
      summary.annotation = {
        ...annotationExcerpt(ann.annotation),
        ...(verdict ? annotationFreshnessMeta(verdict) : {}),
        quality,
      };
    }
  } else if (ann) {
    summary.annotation = annotationExcerpt(ann.annotation);
  }
  if (node?.type === 'runtime-resource') summary.runtimeResource = node.data;
  if (node?.type === 'domain') summary.domain = node.data;
  return summary;
}

export function affectedNodeEdges(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  nodeIds: string[],
): Array<Record<string, unknown>> {
  const nodeSet = new Set(nodeIds);
  const edges: Array<Record<string, unknown>> = [];
  for (const edge of graph.edges) {
    if (!nodeSet.has(edge.from) || !nodeSet.has(edge.to)) continue;
    const entry: Record<string, unknown> = {
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      fromLabel: nodeLabel(graph, edge.from),
      toLabel: nodeLabel(graph, edge.to),
    };
    if (edge.kind === 'imports') {
      const fromMod = modulesById.get(edge.from);
      const importedNames = new Set<string>();
      for (const imp of fromMod?.imports.filter(imp => imp.resolvedModuleId === edge.to) ?? []) {
        for (const name of imp.importedNames) importedNames.add(name);
      }
      entry.importedNames = [...importedNames];
    }
    edges.push(entry);
    if (edges.length >= 100) break;
  }
  return edges;
}

export function refactoringCategoryDetail(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  annotations: AnnotationStore,
  finding: RefactoringFinding,
  freshnessOf: NodeFreshnessLookup,
): Record<string, unknown> {
  const nodeSet = new Set(finding.nodes);
  switch (finding.category) {
    case 'boundary': {
      const targetId = finding.nodes[0];
      const importers = finding.nodes.slice(1).filter(id => isNodeType(graph, id, 'module'));
      const symbols = new Set<string>();
      for (const importerId of importers) {
        const mod = modulesById.get(importerId);
        for (const imp of mod?.imports.filter(imp => imp.resolvedModuleId === targetId) ?? []) {
          for (const name of imp.importedNames) symbols.add(name);
        }
      }
      const targetPackageId = modulePackageId(graph, targetId);
      const packageIndexModules = targetPackageId
        ? packageModuleIds(graph, targetPackageId).filter(id => isBarrelModule(graph, id))
        : [];
      return { targetId, targetPackageId, importers, importedSymbols: [...symbols].slice(0, 30), packageIndexModules };
    }
    case 'god-module': {
      const modId = finding.nodes[0];
      const mod = modulesById.get(modId);
      return {
        moduleId: modId,
        exportCount: mod?.exports.length ?? 0,
        fanIn: runtimeFanIn(graph, modId),
        fanOut: runtimeFanOut(graph, modId),
        envVars: mod?.semanticHints?.envVars ?? [],
        lineEstimate: maxModuleLine(mod),
      };
    }
    case 'god-domain':
    case 'low-cohesion': {
      const domainId = finding.nodes[0];
      const modules = finding.nodes.slice(1).filter(id => isNodeType(graph, id, 'module'));
      let internalImports = 0;
      let externalImports = 0;
      for (const modId of modules) {
        for (const edge of graph.outEdges.get(modId) ?? []) {
          if (!isRuntimeImportEdge(edge)) continue;
          if (nodeSet.has(edge.to)) internalImports++;
          else externalImports++;
        }
      }
      const domainNode = graph.nodes.get(domainId);
      return {
        domainId,
        tier: domainNode?.type === 'domain' ? domainNode.data?.tier : undefined,
        subdomains: domainNode?.type === 'domain' ? domainNode.data?.subdomains ?? [] : [],
        sampledModules: modules,
        internalImports,
        externalImports,
      };
    }
    case 'client-business-logic': {
      const modId = finding.nodes[0];
      const mod = modulesById.get(modId);
      const businessExports = mod?.exports.filter(exp => exp.kind !== 'component' && exp.name !== 'default') ?? [];
      return {
        moduleId: modId,
        frontendFeature: mod ? frontendFeatureKey(mod) : undefined,
        businessExports: businessExports.slice(0, 30).map(exp => ({ name: exp.name, kind: exp.kind, lineRange: exp.lineRange })),
        sideEffectHints: {
          envVars: mod?.semanticHints?.envVars ?? [],
          runtimeActions: mod?.semanticHints?.runtimeActions ?? [],
        },
      };
    }
    case 'flow-convergence': {
      const entrypoints = finding.nodes.filter(id => {
        const mod = modulesById.get(id);
        return mod ? isFrontendFlowEntryModule(mod, true) : false;
      });
      const entrySet = new Set(entrypoints);
      const targets = finding.nodes.filter(id => modulesById.has(id) && !entrySet.has(id));
      return { targets, entrypoints, targetOrGroupKey: finding.id.replace(/^flow-convergence:/, '') };
    }
    case 'state-fragmentation': {
      const modules = finding.nodes.filter(id => isNodeType(graph, id, 'module'));
      return {
        feature: finding.id.replace(/^state-fragmentation:/, ''),
        stateModules: modules.map(id => ({ id, kind: modulesById.get(id) ? stateModuleKind(modulesById.get(id)!) : undefined })),
      };
    }
    case 'effect-spaghetti': {
      const modId = finding.nodes[0];
      const mod = modulesById.get(modId);
      return {
        moduleId: modId,
        framework: mod?.semanticHints?.ui?.framework,
        lifecycleEffects: mod?.semanticHints?.ui?.lifecycleEffects ?? [],
        dataAccess: mod?.semanticHints?.ui?.dataAccess ?? [],
        navigation: mod?.semanticHints?.ui?.navigation ?? [],
        timers: mod?.semanticHints?.ui?.timers ?? [],
        subscriptions: mod?.semanticHints?.ui?.subscriptions ?? [],
      };
    }
    case 'prop-drilling-orchestration': {
      const modId = finding.nodes[0];
      const mod = modulesById.get(modId);
      const component = mod?.semanticHints?.ui?.components
        ?.find((item, idx) => finding.id === `prop-drilling-orchestration:${modId}:${item.name}#${item.lineRange?.start ?? idx}`);
      const propNames = component?.props.map(prop => prop.name) ?? [];
      const callbackProps = component?.props
        .filter(prop => prop.kind === 'callback' || prop.kind === 'setter')
        .map(prop => prop.name) ?? [];
      const forwardedProps = [...new Set(component?.childComponents.flatMap(child => child.forwardedProps) ?? [])];
      return {
        moduleId: modId,
        componentName: component?.name ?? finding.id.replace(/^prop-drilling-orchestration:.*:/, '').replace(/#\d+$/, ''),
        propCount: propNames.length,
        callbackPropCount: callbackProps.length,
        forwardedPropCount: forwardedProps.length,
        forwardedRatio: propNames.length > 0 ? forwardedProps.length / propNames.length : 0,
        workflowSignals: component ? workflowSignalKinds(component.localSignals) : [],
        props: component?.props ?? [],
        childComponents: component?.childComponents ?? [],
      };
    }
    case 'service-wrapper-explosion': {
      return {
        group: finding.id.replace(/^service-wrapper-explosion:/, ''),
        wrappers: finding.nodes.map(id => {
          const mod = modulesById.get(id);
          return {
            id,
            role: mod?.semanticHints?.ui?.serviceWrapper?.role,
            lineCount: mod?.semanticHints?.ui?.serviceWrapper?.lineCount,
            delegateCallCount: mod?.semanticHints?.ui?.serviceWrapper?.delegateCallCount,
            fanIn: runtimeFanIn(graph, id),
            fanOut: runtimeFanOut(graph, id),
          };
        }),
      };
    }
    case 'ui-domain-coupling': {
      const modId = finding.nodes[0];
      const mod = modulesById.get(modId);
      return {
        moduleId: modId,
        frontendFeature: mod ? frontendFeatureKey(mod) : undefined,
        coupledImports: mod?.imports
          .filter(imp => !imp.isTypeOnly && imp.resolvedModuleId && modulesById.get(imp.resolvedModuleId) && uiCouplingTargetRole(modulesById.get(imp.resolvedModuleId)!))
          .map(imp => ({
            targetId: imp.resolvedModuleId,
            role: imp.resolvedModuleId ? uiCouplingTargetRole(modulesById.get(imp.resolvedModuleId)!) : undefined,
            importedNames: imp.importedNames,
          })) ?? [],
      };
    }
    case 'route-convergence': {
      return {
        target: finding.id.replace(/^route-convergence:/, ''),
        entries: finding.nodes
          .filter(id => modulesById.has(id))
          .map(id => {
            const mod = modulesById.get(id);
            return {
              id,
              routes: mod?.semanticHints?.routes ?? [],
              dataAccessTargets: mod?.semanticHints?.ui?.dataAccess
                ?.map(access => ({ kind: access.kind, target: access.target, key: frontendDataAccessTargetKey(access.target) })) ?? [],
            };
          }),
      };
    }
    case 'duplicated-client-policy': {
      return {
        policyGroup: finding.id.replace(/^duplicated-client-policy:/, ''),
        modules: finding.nodes.map(id => {
          const mod = modulesById.get(id);
          return {
            id,
            feature: mod ? frontendFeatureKey(mod) : undefined,
            tokens: mod ? policyTokens(mod, annotations.get(id)) : [],
            exports: mod?.exports.slice(0, 12).map(exp => exp.name) ?? [],
          };
        }),
      };
    }
    case 'design-system-leakage': {
      const modId = finding.nodes[0];
      const mod = modulesById.get(modId);
      return {
        moduleId: modId,
        leakedImports: mod?.imports
          .filter(imp => !imp.isTypeOnly && imp.resolvedModuleId && modulesById.get(imp.resolvedModuleId) && coupledTargetRole(modulesById.get(imp.resolvedModuleId)!))
          .map(imp => ({
            targetId: imp.resolvedModuleId,
            role: imp.resolvedModuleId ? coupledTargetRole(modulesById.get(imp.resolvedModuleId)!) : undefined,
            importedNames: imp.importedNames,
          })) ?? [],
        dataAccess: mod?.semanticHints?.ui?.dataAccess ?? [],
      };
    }
    case 'event-driven-boundary': {
      const resourceId = finding.nodes[0];
      const producers = (graph.inEdges.get(resourceId) ?? []).filter(edge => edge.kind === 'publishes').map(edge => edge.from).filter(id => nodeSet.has(id));
      const consumers = (graph.outEdges.get(resourceId) ?? []).filter(edge => edge.kind === 'consumes').map(edge => edge.to).filter(id => nodeSet.has(id));
      return { resourceId, producers, consumers, resource: graph.nodes.get(resourceId)?.data };
    }
    case 'secret-config-boundary': {
      const modId = finding.nodes[0];
      const mod = modulesById.get(modId);
      return {
        moduleId: modId,
        envVars: mod?.semanticHints?.envVars ?? [],
        securitySignals: mod?.semanticHints?.security?.filter(signal => signal.kind === 'secret-env' || signal.kind === 'public-env') ?? [],
        clientImporters: finding.nodes.slice(1),
      };
    }
    case 'authorization-policy-drift': {
      return {
        policyGroup: finding.id.replace(/^authorization-policy-drift:/, ''),
        modules: finding.nodes.map(id => {
          const mod = modulesById.get(id);
          return {
            id,
            feature: mod ? frontendFeatureKey(mod) ?? modulePackageId(graph, id) : undefined,
            tokens: mod ? policyTokens(mod, annotations.get(id)) : [],
            authzSignals: mod?.semanticHints?.security?.filter(signal => signal.kind === 'authz') ?? [],
            exports: mod?.exports.slice(0, 12).map(exp => exp.name) ?? [],
          };
        }),
      };
    }
    case 'trust-boundary-validation': {
      const modId = finding.nodes[0];
      const mod = modulesById.get(modId);
      return {
        moduleId: modId,
        routes: mod?.semanticHints?.routes ?? [],
        ssr: mod?.semanticHints?.ssr,
        validationSignals: mod?.semanticHints?.security?.filter(signal => signal.kind === 'validation') ?? [],
        authzSignals: mod?.semanticHints?.security?.filter(signal => signal.kind === 'authz') ?? [],
        imports: mod?.imports.slice(0, 20).map(imp => ({ specifier: imp.moduleSpecifier, importedNames: imp.importedNames })) ?? [],
      };
    }
    case 'privileged-client-side-effect': {
      const modId = finding.nodes[0];
      const mod = modulesById.get(modId);
      return {
        moduleId: modId,
        runtimeActions: mod?.semanticHints?.runtimeActions ?? [],
        securitySignals: mod?.semanticHints?.security ?? [],
        dataAccess: mod?.semanticHints?.ui?.dataAccess ?? [],
        privilegedTargets: finding.nodes.slice(1).map(id => ({
          id,
          role: modulesById.get(id) ? coupledTargetRole(modulesById.get(id)!) : undefined,
        })),
      };
    }
    case 'sensitive-browser-storage': {
      const modId = finding.nodes[0];
      const mod = modulesById.get(modId);
      const stored = annotations.get(modId)?.annotation;
      return {
        moduleId: modId,
        storageSignals: mod?.semanticHints?.security?.filter(signal => signal.kind === 'browser-storage' || signal.kind === 'browser-storage-sensitive' || signal.kind === 'cookie-access') ?? [],
        annotation: stored
          ? {
              stateShape: stored.stateShape,
              dataFlow: stored.dataFlow,
              risks: annotationExcerpt(stored).risks,
            }
          : undefined,
      };
    }
    case 'server-client-boundary': {
      const modId = finding.nodes[0];
      const mod = modulesById.get(modId);
      return {
        moduleId: modId,
        clientSsr: mod?.semanticHints?.ssr,
        leakedImports: mod?.imports
          .filter(imp => !imp.isTypeOnly && imp.resolvedModuleId && finding.nodes.includes(imp.resolvedModuleId))
          .map(imp => ({
            targetId: imp.resolvedModuleId,
            targetPath: imp.resolvedModuleId ? modulesById.get(imp.resolvedModuleId)?.relativeFilePath : undefined,
            importedNames: imp.importedNames,
          })) ?? [],
      };
    }
    case 'source-disclosure-surface': {
      const modId = finding.nodes[0];
      const mod = modulesById.get(modId);
      return {
        moduleId: modId,
        sourceDisclosureSignals: mod?.semanticHints?.security?.filter(signal => signal.kind === 'source-disclosure') ?? [],
        exports: mod?.exports.slice(0, 20).map(exp => ({ name: exp.name, kind: exp.kind, lineRange: exp.lineRange })) ?? [],
      };
    }
    case 'annotation-secret-hygiene': {
      const modId = finding.nodes[0];
      const ann = annotations.get(modId);
      return {
        moduleId: modId,
        fieldPaths: ann ? annotationSecretFieldPaths(ann.annotation) : [],
        note: 'Suspected secret values are intentionally not returned in detail output.',
      };
    }
    case 'annotation-risk': {
      const modId = finding.nodes[0];
      const mod = modulesById.get(modId);
      const ann = annotations.get(modId);
      const node = graph.nodes.get(modId);
      const moduleKind = mod ? inferModuleKind({ mod, node }) : undefined;
      const verdict = freshnessOf(modId);
      return {
        moduleId: modId,
        hasAnnotation: ann != null,
        ...(verdict ? annotationFreshnessMeta(verdict) : {}),
        moduleKind,
        quality: ann && mod
          ? computeAnnotationQuality(ann.annotation, {
              exportCount: mod.exports.length,
              lineCount: maxModuleLine(mod),
              envVars: mod.semanticHints?.envVars,
              moduleKind,
            })
          : undefined,
      };
    }
    case 'duplicate-like':
      return {
        responsibilityKey: finding.id.replace(/^duplicate-like:/, ''),
        packages: [...new Set(finding.nodes.map(id => modulePackageId(graph, id)).filter(Boolean))],
      };
    case 'unclear-architecture':
      return {
        affectedNode: finding.nodes[0],
        domains: finding.nodes.slice(1).filter(id => isNodeType(graph, id, 'domain')),
        runtimeResource: isNodeType(graph, finding.nodes[0], 'runtime-resource') ? graph.nodes.get(finding.nodes[0])?.data : undefined,
      };
  }
}

export function refactoringNextCalls(graph: RepositoryGraph, finding: RefactoringFinding): string[] {
  const primaryNode = finding.nodes[0];
  const calls = [
    `inspect_node({ "nodeId": "${primaryNode}" })`,
    `analyze_dependencies({ "scope": "${primaryNode}", "mode": "impact", "depth": 3 })`,
  ];
  if (finding.category === 'boundary') {
    const pkgId = modulePackageId(graph, primaryNode);
    calls.push(pkgId
      ? `analyze_dependencies({ "scope": "${pkgId}", "mode": "package-boundaries" })`
      : 'analyze_dependencies({ "mode": "package-boundaries" })');
  }
  if (finding.category === 'event-driven-boundary') calls.push('trace_flow({ "include": ["entrypoints", "services", "resources", "flows"] })');
  if (
    finding.category === 'secret-config-boundary'
    || finding.category === 'privileged-client-side-effect'
    || finding.category === 'server-client-boundary'
  ) {
    calls.push(`get_config_surface({ "scope": "${primaryNode}", "kinds": ["env", "secret", "resource-binding"] })`);
  }
  if (finding.category === 'trust-boundary-validation') {
    calls.push(`inspect_node({ "nodeId": "${primaryNode}", "grepBody": "schema|validate|safeParse|parse|guard|assert" })`);
  }
  if (finding.category === 'source-disclosure-surface') {
    calls.push(`inspect_node({ "nodeId": "${primaryNode}", "grepBody": "includeBody|grepBody|privateMembers|readFile" })`);
  }
  if (finding.category === 'annotation-risk') calls.push(`write_annotation({ "nodeId": "${primaryNode}", "annotation": { "summary": "..." } })`);
  if (finding.category === 'annotation-secret-hygiene') calls.push(`write_annotation({ "nodeId": "${primaryNode}", "annotation": { "summary": "redacted summary without secret values" } })`);

  // If the finding carries a annotationContext, the FIRST step is to read those
  // excerpts and answer the question — drilling into source is wasteful until
  // the annotation-based verdict is made.
  if (finding.annotationContext) {
    const fields = finding.annotationContext.relevantFields.join(', ');
    calls.unshift(
      `READ finding.annotationContext.nodes[].annotation.{${fields}} `
      + `and answer "${finding.annotationContext.question}". `
      + 'If annotations are stale or missing, call inspect_node on the listed nodes. '
      + 'Then suppress, confirm, or boost this finding when reporting to the user.',
    );
  }
  return calls;
}
