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
import { addEdge, addNode, hasEdge, infraTargetIds } from '../../graph/index.js';
import { makeRuntimeResourceId } from '../../graph/make-runtime-resource-id.js';
import { parseResourceId } from '@repovine/plugin-sdk';
import { resolveInfraRef, type InfraRefScope } from '../../graph/resolve-infra-ref.js';
import type { DeclarationCatalog } from '../../plugin-host/declaration-catalog.js';
import {
  catalogResourceKindMeta,
  catalogRuntimeActionNamespace,
  catalogTriggerTypeMeta,
} from '../../plugin-host/declaration-catalog.js';
import { matchesInfraResourceExclude, type DomainsConfig } from '../../stage2/domains.js';
import {
  linkContainerRuntimeTargets,
  resolveArtifactRoot,
  runtimeEntrySearchRoots,
} from '../../stage2/runtime-links.js';
import { shortModuleLabel } from '../../stage2/module-label.js';
// Side-effect imports: ensure built-in IaC + source plugin registries are populated before this
// layer reads infra kind/resource/trigger metadata and known source extensions. Same rationale as
import {
  getInfraKindDomain,
} from '../../plugin-host/iac-set.js';
import { getKnownExtensions, getSourcePlugins } from '../../plugin-host/source-set.js';
import { resolveRelPath, toPosixPath } from '../../platform/paths.js';
import { stripIndexBasename } from '../../plugin-host/source-set.js';
import { infraNodeId } from '../../graph/node-ids.js';

type RuntimeActionName = RuntimeAction['action'];

/** What this build's plugins declared about the kind of one resource. */
function declaredResourceMeta(
  res: InfraResource,
  declarations: DeclarationCatalog | undefined,
): { service?: string; hasCodeHandler?: boolean } | undefined {
  if (!declarations) return undefined;
  return catalogResourceKindMeta(declarations, {
    namespace: res.identity.namespace,
    provider: res.provider,
    kind: res.kind,
  });
}

/**
 * True when the resource's kind was declared to carry code.
 *
 * Three passes need it: the handler edge, the env bindings a handler module inherits, and the
 * publish edges its calls imply. All three ask the same question, and none of them names an
 * ecosystem's kind to answer it.
 */
function hasCodeHandler(res: InfraResource, declarations: DeclarationCatalog | undefined): boolean {
  return declaredResourceMeta(res, declarations)?.hasCodeHandler === true;
}

/** Trigger metadata under the identity of the resource carrying the trigger. */
function declaredTriggerMeta(
  res: InfraResource,
  type: string | undefined,
  declarations: DeclarationCatalog | undefined,
): { isStreamLike?: boolean } | undefined {
  if (!declarations || type === undefined) return undefined;
  return catalogTriggerTypeMeta(declarations, {
    type,
    namespace: res.identity.namespace,
    provider: res.provider,
  });
}

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
    normalizeRelPath: resolveRelPath,
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
    const keys = uniqueStrings([repoPath, stripIndexBasename(repoPath)]);
    for (const key of keys) {
      let ids = out.get(key);
      if (!ids) { ids = []; out.set(key, ids); }
      ids.push(mod.id);
    }
  }
  return out;
}

function lookupModuleByRepoPath(index: Map<string, string[]>, candidate: string): string | undefined {
  const normalized = stripKnownExtension(resolveRelPath(candidate));
  return index.get(normalized)?.[0] ?? index.get(stripIndexBasename(normalized))?.[0];
}

function joinRelPath(...parts: Array<string | undefined>): string {
  return resolveRelPath(parts.filter((p): p is string => Boolean(p)).join('/'));
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

/**
 * IaC resources can reference env/config targets declared in later files (e.g. SAM compute.yaml
 * references data.yaml, K8s workloads reference Secret manifests in sibling files).
 * During the first infra pass those targets may not exist yet, so uses_env / consumes are missing.
 * Link them after all IaC resources are nodes in the graph.
 */
function linkDeferredInfraEdges(
  graph: RepositoryGraph,
  infraModules: InfraModuleInfo[],
  declarations: DeclarationCatalog | undefined,
): void {
  for (const infraMod of infraModules) {
    for (const res of infraMod.resources) {
      const serviceId = makeRuntimeResourceId(res);
      if (!graph.nodes.has(serviceId)) continue;

      const scope = refScopeFor(infraMod, res);

      if (res.triggers) {
        for (const trigger of res.triggers) {
          // A stream-like trigger names the source that drives this resource: a queue, a change
          // stream, an event bus. Which types those are is declared, not recognised here.
          const isStreamLike = declaredTriggerMeta(res, trigger.type, declarations)?.isStreamLike === true;
          if (!isStreamLike || !trigger.queueRef) continue;
          const queueServiceId = findServiceIdByLogicalId(graph, trigger.queueRef, serviceId, scope);
          if (queueServiceId && graph.nodes.has(queueServiceId) && !hasEdge(graph, queueServiceId, 'consumes', serviceId)) {
            addEdge(graph, queueServiceId, serviceId, 'consumes');
          }
        }
      }

      if (res.envRefs) {
        for (const envRef of res.envRefs) {
          if (!envRef.targetLogicalId) continue;
          const targetServiceId = findServiceIdByLogicalId(graph, envRef.targetLogicalId, serviceId, scope, envRef.varName);
          if (!targetServiceId || !graph.nodes.has(targetServiceId)) continue;
          if (!hasEdge(graph, serviceId, 'uses_env', targetServiceId)) {
            addEdge(graph, serviceId, targetServiceId, 'uses_env');
          }
        }
      }
    }
  }
}

/**
 * Handler TS modules inherit Lambda env bindings: module → service (binds_to) for each resolved envRef target.
 * Lets domain slices reach DynamoDB/SQS/etc. via code modules, not only via Lambda in the slice.
 */
function linkHandlerModuleEnvBindings(
  graph: RepositoryGraph,
  infraModules: InfraModuleInfo[],
  declarations: DeclarationCatalog | undefined,
): void {
  for (const infraMod of infraModules) {
    for (const res of infraMod.resources) {
      if (!hasCodeHandler(res, declarations) || !res.envRefs?.length) continue;
      const serviceId = makeRuntimeResourceId(res);
      if (!graph.nodes.has(serviceId)) continue;

      const [handlerModId] = infraTargetIds(graph, serviceId);
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
        if (hasEdge(graph, handlerModId, 'binds_to', targetServiceId)) continue;
        addEdge(graph, handlerModId, targetServiceId, 'binds_to');
      }
    }
  }
}

function linkRuntimePublishes(
  graph: RepositoryGraph,
  infraModules: InfraModuleInfo[],
  modulesById: Map<string, ModuleInfo>,
  declarations: DeclarationCatalog | undefined,
): void {
  for (const infraMod of infraModules) {
    for (const res of infraMod.resources) {
      if (!hasCodeHandler(res, declarations)) continue;
      const serviceId = makeRuntimeResourceId(res);
      if (!graph.nodes.has(serviceId)) continue;

      const [handlerModId] = infraTargetIds(graph, serviceId);
      if (!handlerModId) continue;
      const actions = collectRuntimeActionsForModule(handlerModId, modulesById);
      if (actions.length === 0) continue;

      const scope = refScopeFor(infraMod, res);
      for (const action of actions) {
        const targetServiceId = findPublishTargetForAction(graph, serviceId, scope, res.envRefs ?? [], action.action, declarations, action.envVar);
        if (!targetServiceId || hasEdge(graph, serviceId, 'publishes', targetServiceId)) continue;
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
  declarations: DeclarationCatalog | undefined,
  envVar?: string,
): string | undefined {
  const refs = envVar ? envRefs.filter(ref => ref.varName === envVar) : envRefs;
  for (const ref of refs) {
    if (!ref.targetLogicalId) continue;
    const targetServiceId = findServiceIdByLogicalId(graph, ref.targetLogicalId, fromServiceId, scope, ref.varName);
    if (targetServiceId && serviceMatchesRuntimeAction(targetServiceId, action, declarations)) return targetServiceId;
  }
  return undefined;
}

/**
 * True when the resource this id names is where the action writes.
 *
 * Both sides are declared: the producer names the call, its namespace owner declares which identity
 * namespace that call targets, and the namespace of a candidate is read back out of its id. No
 * ecosystem's id spelling is recognised here, so a plugin adds a service by declaring one.
 */
function serviceMatchesRuntimeAction(
  serviceId: string,
  action: RuntimeActionName,
  declarations: DeclarationCatalog | undefined,
): boolean {
  if (!declarations) return false;
  const declared = catalogRuntimeActionNamespace(declarations, action);
  if (declared === undefined) return false;
  return parseResourceId(serviceId)?.namespace === declared;
}

function pass2Infra(
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  modulesById: Map<string, ModuleInfo>,
  config: DomainsConfig | null,
): void {
  const infraModules = snapshot.infraModules ?? [];
  if (infraModules.length === 0) return;
  // This build's own declarations, carried on the snapshot so they reach composition inside the
  // Stage 2 worker isolate. Absent when no plugin declared anything.
  const declarations = snapshot.declarations;
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
      // Read once here and carried on the node: a query layer holds a node, not the declaration
      // catalog that built it, and re-deriving `service` from an id spelling is how ecosystem
      // knowledge gets back into the MCP shell.
      const declaredMeta = declaredResourceMeta(res, declarations);
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
          refScope: res.refScope,
          provider: res.provider,
          service: declaredMeta?.service,
          hasCodeHandler: declaredMeta?.hasCodeHandler,
          declaredIn: uniqueStrings([...previouslyDeclaredIn, infraMod.relativeFilePath]),
          namespace: res.attributes.namespace,
        },
      });
      addEdge(graph, infraModuleId, serviceId, 'contains');
      addEdge(graph, serviceId, domainId, 'tagged');

      if (declaredMeta?.hasCodeHandler && res.attributes.handler) {
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
      // A resource that names a Dockerfile of this repository is linked to it, so domains propagate
      // through the shared build artifact. Naming one is the evidence; which ecosystem named it is
      // not read.
      if (res.attributes.dockerfile) {
        const dockerfileModuleId = infraNodeId('dockerfile', toPosixPath(res.attributes.dockerfile));
        deferredComposeDockerfileInfraEdges.push({ fromServiceId: serviceId, toDockerfileModuleId: dockerfileModuleId });
      }

      const scope = refScopeFor(infraMod, res);

      if (res.triggers) {
        for (const trigger of res.triggers) {
          const isStreamLike = declaredTriggerMeta(res, trigger.type, declarations)?.isStreamLike === true;
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

  linkDeferredInfraEdges(graph, infraModules, declarations);
  linkHandlerModuleEnvBindings(graph, infraModules, declarations);
  linkRuntimePublishes(graph, infraModules, modulesById, declarations);
  linkContainerRuntimeTargets(graph, snapshot);
}

/** The document a resource's own references are made from, and the scope its plugin confined them to. */
function refScopeFor(infraMod: InfraModuleInfo, res: InfraResource): InfraRefScope {
  return {
    declaredIn: [infraMod.relativeFilePath],
    ...(res.refScope === undefined ? {} : { refScope: res.refScope }),
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
