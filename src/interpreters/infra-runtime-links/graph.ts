import type {
  InfraModuleInfo,
  InfraResource,
  ModuleInfo,
  RepositoryGraph,
  RuntimeAction,
  RepositoryFactsSnapshot,
  UnresolvedInfraRef,
} from '../../types.js';
import type { HandlerResolveContext } from '@repovine/plugin-sdk';
import { addNode, addEdge } from '../../graph/index.js';
import { makeRuntimeResourceId } from '../../graph/make-runtime-resource-id.js';
import { resolveInfraRef, type InfraRefScope } from '../../graph/resolve-infra-ref.js';
import { matchesInfraResourceExclude, type DomainsConfig } from '../../stage2/domains.js';
import {
  linkContainerRuntimeTargets,
  linkK8sIngressRoutes,
  resolveArtifactRoot,
  runtimeEntrySearchRoots,
} from '../../stage2/runtime-links.js';
import { shortModuleLabel } from '../../stage2/module-label.js';
// Side-effect imports: ensure built-in IaC + source plugin registries are populated before this
// layer reads infra kind/resource/trigger metadata and known source extensions. Same rationale as
// the imports stage2/index.ts used to carry for the inline passes.
import '../../stage1/iac/bootstrap.js';
import '../../stage1/source/bootstrap.js';
import {
  getInfraKindDomain,
  getResourceKindMeta,
  getTriggerTypeMeta,
} from '../../stage1/iac/registry.js';
import { getKnownExtensions, getSourcePlugins } from '../../stage1/source/registry.js';

type RuntimeActionName = RuntimeAction['action'];

/**
 * Infra-link graph contribution: infra modules + runtime-resource nodes + handler/runtime/container/k8s
 * edges + infra-kind domain tags. Lifted verbatim from stage2 pass2Infra + runtime-links wiring.
 * Mutates ctx.graph directly (the linking passes read back their own runtime-resource nodes) and returns an
 * empty delta, preserving legacy insertion order. Resource excludes come from the already-loaded
 * domains config threaded via the layer context (T2) — never reloaded from disk here.
 */
export function contributeInfraLink(
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  modulesById: Map<string, ModuleInfo>,
  config: DomainsConfig | null,
): void {
  pass2Infra(graph, snapshot, modulesById, config);
}

/** Resolve a Lambda Handler string (e.g. "src/users.handler") to a source module id. */
function resolveHandlerToModuleId(
  handler: string,
  snapshot: RepositoryFactsSnapshot,
  modulesById: Map<string, ModuleInfo>,
  attributes?: Record<string, string>,
  infraRelPath?: string,
): string | undefined {
  const artifactRoot = resolveArtifactRoot(attributes, infraRelPath);
  const roots = runtimeEntrySearchRoots(snapshot, attributes, infraRelPath);

  for (const plugin of getSourcePlugins()) {
    const resolver = plugin.capabilities?.resolveHandlerToModule;
    if (!resolver) continue;
    const ctx = buildHandlerResolveContext(
      plugin.id,
      snapshot,
      modulesById,
      roots,
      artifactRoot,
      attributes,
      infraRelPath,
    );
    try {
      const modId = resolver(handler, ctx);
      if (modId && ctx.modulesById.has(modId)) return modId;
    } catch {
      continue;
    }
  }

  return undefined;
}

function buildHandlerResolveContext(
  sourcePluginId: string,
  snapshot: RepositoryFactsSnapshot,
  modulesById: Map<string, ModuleInfo>,
  searchRoots: readonly string[],
  artifactRoot?: string,
  attributes?: Record<string, string>,
  infraRelPath?: string,
): HandlerResolveContext {
  const pluginModulesById = new Map(
    [...modulesById].filter(([, mod]) => moduleBelongsToSourcePlugin(mod, sourcePluginId)),
  );
  const moduleIdsByRepoPath = buildModuleRepoPathIndex(snapshot, pluginModulesById);

  return {
    packages: snapshot.packages.filter(pkg => packageBelongsToSourcePlugin(pkg.sourcePluginId, sourcePluginId)),
    modulesById: pluginModulesById,
    searchRoots,
    artifactRoot,
    attributes,
    infraRelPath,
    handlerPathMap: snapshot.bundleOutputHandlerMap ?? {},
    resolveModuleByRepoPath(candidate: string): string | undefined {
      return lookupModuleByRepoPath(moduleIdsByRepoPath, candidate);
    },
    normalizeRelPath,
  };
}

function moduleBelongsToSourcePlugin(mod: ModuleInfo, sourcePluginId: string): boolean {
  return packageBelongsToSourcePlugin(mod.sourcePluginId, sourcePluginId);
}

// Ownership is decided by source-plugin id equality alone. Stage 1 stamps every package and
// module with its owning plugin id (see mergeResults in stage1/index.ts), so the core needs no
// language-identity fallback — an unstamped value simply belongs to no plugin's resolution pass.
function packageBelongsToSourcePlugin(value: string | undefined, sourcePluginId: string): boolean {
  return value === sourcePluginId;
}

function buildModuleRepoPathIndex(
  snapshot: RepositoryFactsSnapshot,
  modulesById: Map<string, ModuleInfo>,
): Map<string, string[]> {
  const packagesByName = new Map(snapshot.packages.map(pkg => [pkg.name, pkg]));
  const out = new Map<string, string[]>();
  for (const mod of modulesById.values()) {
    const pkg = packagesByName.get(mod.packageName);
    if (!pkg) continue;
    const repoPath = stripKnownExtension(joinRelPath(pkg.path, mod.relativeFilePath));
    const keys = uniqueStrings([repoPath, repoPath.replace(/\/index$/, '')]);
    for (const key of keys) {
      let ids = out.get(key);
      if (!ids) { ids = []; out.set(key, ids); }
      ids.push(mod.id);
    }
  }
  return out;
}

function lookupModuleByRepoPath(index: Map<string, string[]>, candidate: string): string | undefined {
  const normalized = stripKnownExtension(normalizeRelPath(candidate));
  return index.get(normalized)?.[0] ?? index.get(normalized.replace(/\/index$/, ''))?.[0];
}

function joinRelPath(...parts: Array<string | undefined>): string {
  return normalizeRelPath(parts.filter((p): p is string => Boolean(p)).join('/'));
}

function normalizeRelPath(value: string): string {
  const out: string[] = [];
  for (const segment of value.replace(/\\/g, '/').replace(/\/+/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

function stripKnownExtension(value: string): string {
  // Extensions come from registered source plugins' capabilities (e.g. `.py` from the Python
  // plugin) so IaC Lambda handlers (`app.handler` → module `app`) resolve across languages the
  // same way each owning plugin normalizes its module ids. Extensions never nest at the dot
  // boundary (`.ts` is not a suffix of `.tsx`), so first-match strip is order-independent.
  for (const ext of getKnownExtensions()) {
    if (value.endsWith(ext)) return value.slice(0, -ext.length);
  }
  return value;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(v => v !== undefined))];
}

function hasUsesEnvEdge(graph: RepositoryGraph, from: string, to: string): boolean {
  return (graph.outEdges.get(from) ?? []).some(e => e.kind === 'uses_env' && e.to === to);
}

function hasConsumesEdge(graph: RepositoryGraph, queueId: string, lambdaId: string): boolean {
  return (graph.outEdges.get(queueId) ?? []).some(e => e.kind === 'consumes' && e.to === lambdaId);
}

/**
 * IaC resources can reference env/config targets declared in later files (e.g. SAM compute.yaml
 * references data.yaml, K8s workloads reference Secret manifests in sibling files).
 * During the first infra pass those targets may not exist yet, so uses_env / consumes are missing.
 * Link them after all IaC resources are nodes in the graph.
 */
function linkDeferredInfraEdges(graph: RepositoryGraph, infraModules: InfraModuleInfo[]): void {
  for (const infraMod of infraModules) {
    for (const res of infraMod.resources) {
      const serviceId = makeRuntimeResourceId(res);
      if (!graph.nodes.has(serviceId)) continue;

      const scope = refScopeFor(infraMod, res);

      if (res.kind === 'lambda' && res.triggers) {
        for (const trigger of res.triggers) {
          // Sources that drive a consumer Lambda: SQS queue, DynamoDB stream, Kinesis stream.
          const isStreamLike = !!getTriggerTypeMeta(trigger.type)?.isStreamLike;
          if (!isStreamLike || !trigger.queueRef) continue;
          const queueServiceId = findServiceIdByLogicalId(graph, trigger.queueRef, serviceId, scope);
          if (queueServiceId && graph.nodes.has(queueServiceId) && !hasConsumesEdge(graph, queueServiceId, serviceId)) {
            addEdge(graph, queueServiceId, serviceId, 'consumes');
          }
        }
      }

      if (res.envRefs) {
        for (const envRef of res.envRefs) {
          if (!envRef.targetLogicalId) continue;
          const targetServiceId = findServiceIdByLogicalId(graph, envRef.targetLogicalId, serviceId, scope, envRef.varName);
          if (!targetServiceId || !graph.nodes.has(targetServiceId)) continue;
          if (!hasUsesEnvEdge(graph, serviceId, targetServiceId)) {
            addEdge(graph, serviceId, targetServiceId, 'uses_env');
          }
        }
      }
    }
  }
}

function hasBindsToEdge(graph: RepositoryGraph, fromModuleId: string, toServiceId: string): boolean {
  return (graph.outEdges.get(fromModuleId) ?? []).some(e => e.kind === 'binds_to' && e.to === toServiceId);
}

/**
 * Handler TS modules inherit Lambda env bindings: module → service (binds_to) for each resolved envRef target.
 * Lets domain slices reach DynamoDB/SQS/etc. via code modules, not only via Lambda in the slice.
 */
function linkHandlerModuleEnvBindings(graph: RepositoryGraph, infraModules: InfraModuleInfo[]): void {
  for (const infraMod of infraModules) {
    for (const res of infraMod.resources) {
      if (res.kind !== 'lambda' || !res.envRefs?.length) continue;
      const serviceId = makeRuntimeResourceId(res);
      if (!graph.nodes.has(serviceId)) continue;

      const handlerModId = (graph.outEdges.get(serviceId) ?? []).find(e => e.kind === 'infra')?.to;
      if (!handlerModId || !handlerModId.startsWith('mod:')) continue;
      const handlerNode = graph.nodes.get(handlerModId);
      if (!handlerNode || handlerNode.type !== 'module') continue;

      const scope = refScopeFor(infraMod, res);
      for (const envRef of res.envRefs) {
        if (!envRef.targetLogicalId) continue;
        const targetServiceId = findServiceIdByLogicalId(graph, envRef.targetLogicalId, serviceId, scope, envRef.varName);
        if (!targetServiceId || !graph.nodes.has(targetServiceId)) continue;
        // Every env-ref target is a generic `binds_to` resource binding. Secret targets are not a
        // distinct edge — config-surface reports kind:'secret' by reading target.data.kind.
        if (hasBindsToEdge(graph, handlerModId, targetServiceId)) continue;
        addEdge(graph, handlerModId, targetServiceId, 'binds_to');
      }
    }
  }
}

function hasPublishesEdge(graph: RepositoryGraph, fromServiceId: string, toServiceId: string): boolean {
  return (graph.outEdges.get(fromServiceId) ?? []).some(e => e.kind === 'publishes' && e.to === toServiceId);
}

function linkRuntimePublishes(
  graph: RepositoryGraph,
  infraModules: InfraModuleInfo[],
  modulesById: Map<string, ModuleInfo>,
): void {
  for (const infraMod of infraModules) {
    for (const res of infraMod.resources) {
      if (res.kind !== 'lambda') continue;
      const serviceId = makeRuntimeResourceId(res);
      if (!graph.nodes.has(serviceId)) continue;

      const handlerModId = (graph.outEdges.get(serviceId) ?? []).find(e => e.kind === 'infra')?.to;
      if (!handlerModId) continue;
      const actions = collectRuntimeActionsForModule(handlerModId, modulesById);
      if (actions.length === 0) continue;

      const scope = refScopeFor(infraMod, res);
      for (const action of actions) {
        const targetServiceId = findPublishTargetForAction(graph, serviceId, scope, res.envRefs ?? [], action.action, action.envVar);
        if (!targetServiceId || hasPublishesEdge(graph, serviceId, targetServiceId)) continue;
        addEdge(graph, serviceId, targetServiceId, 'publishes');
      }
    }
  }
}

function collectRuntimeActionsForModule(
  moduleId: string,
  modulesById: Map<string, ModuleInfo>,
  maxDepth = 4,
  seen = new Set<string>(),
): RuntimeAction[] {
  if (seen.has(moduleId) || maxDepth < 0) return [];
  seen.add(moduleId);

  const mod = modulesById.get(moduleId);
  if (!mod) return [];

  const actions = [...(mod.semanticHints?.runtimeActions ?? [])];
  for (const imp of mod.imports) {
    if (!imp.resolvedModuleId?.startsWith('mod:')) continue;
    actions.push(...collectRuntimeActionsForModule(imp.resolvedModuleId, modulesById, maxDepth - 1, seen));
  }

  const seenAction = new Set<string>();
  return actions.filter(action => {
    const key = `${action.action}:${action.envVar ?? ''}:${action.lineRange?.start ?? 0}`;
    if (seenAction.has(key)) return false;
    seenAction.add(key);
    return true;
  });
}

function findPublishTargetForAction(
  graph: RepositoryGraph,
  fromServiceId: string,
  scope: InfraRefScope,
  envRefs: NonNullable<InfraModuleInfo['resources'][number]['envRefs']>,
  action: RuntimeActionName,
  envVar?: string,
): string | undefined {
  const refs = envVar ? envRefs.filter(ref => ref.varName === envVar) : envRefs;
  for (const ref of refs) {
    if (!ref.targetLogicalId) continue;
    const targetServiceId = findServiceIdByLogicalId(graph, ref.targetLogicalId, fromServiceId, scope, ref.varName);
    if (targetServiceId && serviceMatchesRuntimeAction(targetServiceId, action)) return targetServiceId;
  }
  return undefined;
}

function serviceMatchesRuntimeAction(serviceId: string, action: RuntimeActionName): boolean {
  switch (action) {
    case 'sqs.sendMessage': return serviceId.startsWith('resource:aws-sqs:');
    case 'sns.publish': return serviceId.startsWith('resource:aws-sns:');
    case 'lambda.invoke': return serviceId.startsWith('resource:aws-lambda:');
    case 'eventbridge.putEvents': return serviceId.startsWith('resource:aws-eventbridge:') || serviceId.startsWith('resource:aws-events:');
  }
  return false;
}

function pass2Infra(
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  modulesById: Map<string, ModuleInfo>,
  config: DomainsConfig | null,
): void {
  const infraModules = snapshot.infraModules ?? [];
  if (infraModules.length === 0) return;
  const deferredComposeDockerfileInfraEdges: Array<{ fromServiceId: string; toDockerfileModuleId: string }> = [];
  const deferredLogicalIdRefs: Array<{
    logicalId: string;
    serviceId: string;
    scope: InfraRefScope;
    kind: 'consumes' | 'uses_env';
    varName?: string;
  }> = [];

  // Resource filtering driven by repovine.domains.json. Whatever the user lists in
  // `infra.excludeSuffixes` / `excludePatterns` is dropped here — never becomes a
  // runtime-resource node, never appears in search, never propagates domain tags. No built-in
  // "monitoring" category — the user describes their convention.
  const excludeSuffixes = config?.infra?.excludeSuffixes;
  const excludePatterns = config?.infra?.excludePatterns;
  const hasExcludes = (excludeSuffixes && excludeSuffixes.length > 0) ||
                     (excludePatterns && excludePatterns.length > 0);
  const shouldExcludeResource = (label: string): boolean =>
    hasExcludes ? matchesInfraResourceExclude(label, excludeSuffixes, excludePatterns) : false;

  function ensureInfraDomain(kind: string): string {
    const { domainId, label, description } = getInfraKindDomain(kind);
    if (!graph.nodes.has(domainId)) {
      addNode(graph, { id: domainId, type: 'domain', label, description });
    }
    return domainId;
  }

  for (const infraMod of infraModules) {
    const infraModuleId = infraMod.id;
    const domainId = ensureInfraDomain(infraMod.kind);
    addNode(graph, {
      id: infraModuleId,
      type: 'module',
      label: shortModuleLabel(infraMod.relativeFilePath),
      description: `IaC ${infraMod.kind} module ${infraMod.relativeFilePath}`,
      data: {
        filePath: infraMod.filePath,
        relativeFilePath: infraMod.relativeFilePath,
      },
    });

    addEdge(graph, 'root', infraModuleId, 'contains');
    addEdge(graph, infraModuleId, domainId, 'tagged');

    for (const res of infraMod.resources) {
      // Honor user-configured excludes — observability/IAM noise stays out of the graph entirely.
      if (shouldExcludeResource(res.id)) continue;

      const serviceId = makeRuntimeResourceId(res);
      // Two documents declaring the same logical id collapse onto one node. Keep both paths so a
      // reference from either document still sees a target its own scope declares.
      const previous = graph.nodes.get(serviceId);
      const previouslyDeclaredIn = previous?.type === 'runtime-resource'
        ? previous.data?.declaredIn ?? []
        : [];
      addNode(graph, {
        id: serviceId,
        type: 'runtime-resource',
        label: res.id,
        description: `${res.kind} declared in ${infraMod.relativeFilePath}`,
        data: {
          handler: res.attributes.handler,
          envVars: res.envVars,
          triggers: res.triggers,
          envRefs: res.envRefs,
          contentHash: res.contentHash,
          kind: res.kind,
          k8sKind: res.provider === 'k8s' ? res.attributes.kind : undefined,
          provider: res.provider,
          declaredIn: uniqueStrings([...previouslyDeclaredIn, infraMod.relativeFilePath]),
          namespace: res.attributes.namespace,
        },
      });
      addEdge(graph, infraModuleId, serviceId, 'contains');
      addEdge(graph, serviceId, domainId, 'tagged');

      if (getResourceKindMeta(res.kind)?.hasCodeHandler && res.attributes.handler) {
        const modId = resolveHandlerToModuleId(
          res.attributes.handler,
          snapshot,
          modulesById,
          res.attributes,
          infraMod.relativeFilePath,
        );
        if (modId && graph.nodes.has(modId)) {
          addEdge(graph, serviceId, modId, 'infra');
        }
      }
      // Compose services can point at repo Dockerfiles via build.dockerfile.
      // Link them as infra edges so domains can propagate through shared build artifacts.
      if (res.provider === 'generic' && res.attributes.dockerfile) {
        const dockerfileModuleId = `infra:dockerfile:${res.attributes.dockerfile.replace(/\\/g, '/')}`;
        deferredComposeDockerfileInfraEdges.push({ fromServiceId: serviceId, toDockerfileModuleId: dockerfileModuleId });
      }

      const scope = refScopeFor(infraMod, res);

      if (res.triggers) {
        for (const trigger of res.triggers) {
          const isStreamLike = !!getTriggerTypeMeta(trigger.type)?.isStreamLike;
          if (isStreamLike && trigger.queueRef) {
            deferredLogicalIdRefs.push({ logicalId: trigger.queueRef, serviceId, scope, kind: 'consumes' });
          }
        }
      }

      if (res.envRefs) {
        for (const envRef of res.envRefs) {
          if (envRef.targetLogicalId) {
            deferredLogicalIdRefs.push({
              logicalId: envRef.targetLogicalId,
              serviceId,
              scope,
              kind: 'uses_env',
              varName: envRef.varName,
            });
          }
        }
      }
    }
  }

  // Resolve after every resource node exists. Resolving inside the loop above reads a half-built
  // graph: when the colliding declarations straddle the referencing document in scan order, only
  // one candidate is visible yet, the repo-wide-unique branch fires, and the same reference is both
  // bound by an edge and recorded as ambiguous — the scan-order coin toss this scoping removed.
  // Every ref resolves on its own so an unresolved one is recorded against its own env var, but a
  // relationship is emitted once: two variables naming the same target are one link, and `addEdge`
  // does not deduplicate.
  const emittedEdges = new Set<string>();
  for (const ref of deferredLogicalIdRefs) {
    const targetServiceId = findServiceIdByLogicalId(
      graph, ref.logicalId, ref.serviceId, ref.scope, ref.varName,
    );
    if (!targetServiceId) continue;
    const [from, to] = ref.kind === 'consumes'
      ? [targetServiceId, ref.serviceId]
      : [ref.serviceId, targetServiceId];
    const key = `${from}|${to}|${ref.kind}`;
    if (emittedEdges.has(key)) continue;
    emittedEdges.add(key);
    // Edge kinds stay literal at the call site: `edge-witness-producer` scans for them statically,
    // and a variable here would erase the kind from the producer vocabulary.
    if (ref.kind === 'consumes') addEdge(graph, from, to, 'consumes');
    else addEdge(graph, from, to, 'uses_env');
  }

  // Compose modules can appear before Dockerfile modules in scan order.
  // Link after all infra nodes are present to avoid order-sensitive misses.
  for (const edge of deferredComposeDockerfileInfraEdges) {
    if (graph.nodes.has(edge.fromServiceId) && graph.nodes.has(edge.toDockerfileModuleId)) {
      addEdge(graph, edge.fromServiceId, edge.toDockerfileModuleId, 'infra');
    }
  }

  linkDeferredInfraEdges(graph, infraModules);
  linkHandlerModuleEnvBindings(graph, infraModules);
  linkRuntimePublishes(graph, infraModules, modulesById);
  linkContainerRuntimeTargets(graph, snapshot);
  linkK8sIngressRoutes(graph, snapshot);
}

/** The document and namespace a resource's own references are made from. */
function refScopeFor(infraMod: InfraModuleInfo, res: InfraResource): InfraRefScope {
  return {
    declaredIn: [infraMod.relativeFilePath],
    namespace: res.attributes.namespace,
    provider: res.provider,
  };
}

/**
 * Resolve a logical id for a resource's own reference, recording the refusal on the referencing
 * node when scope leaves several candidates standing. `missing` stays silent: a reference to
 * something the repository never declares is an external id, not a resolution failure.
 */
function findServiceIdByLogicalId(
  graph: RepositoryGraph,
  logicalId: string,
  fromServiceId: string,
  scope: InfraRefScope,
  envVar?: string,
): string | undefined {
  const resolution = resolveInfraRef(graph, logicalId, scope);
  if (resolution.status === 'resolved') return resolution.serviceId;
  if (resolution.reason !== 'missing') {
    recordUnresolvedRef(graph, fromServiceId, {
      logicalId,
      ...(envVar ? { envVar } : {}),
      reason: resolution.reason,
      candidates: resolution.candidates,
    });
  }
  return undefined;
}

function recordUnresolvedRef(graph: RepositoryGraph, serviceId: string, entry: UnresolvedInfraRef): void {
  const node = graph.nodes.get(serviceId);
  if (node?.type !== 'runtime-resource') return;
  const data = node.data ?? (node.data = {});
  const existing = data.unresolvedRefs ?? (data.unresolvedRefs = []);
  if (existing.some(ref => ref.logicalId === entry.logicalId && ref.envVar === entry.envVar)) return;
  existing.push(entry);
}
