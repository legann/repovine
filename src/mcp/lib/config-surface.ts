import { resolveScope, nodeInScope } from '../scope/resolve.js';
import { compareCodeUnits } from '../../platform/ordering.js';
import { nodeLabel, nodesOfType } from '../../graph/index.js';
import { limitFrom, offsetFrom, DEFAULT_LIST_LIMIT } from '../response/pagination.js';
import type { McpToolRuntime } from '../types.js';
import { isUnsafeRegexPattern } from './node-body.js';
import { pageTruncation, truncationMap, type TruncationMap } from '../../response/truncation.js';

export interface ConfigSurfaceResult {
  items: Array<Record<string, unknown>>;
  total: number;
  truncation?: TruncationMap;
  error?: string;
}

function configSurfaceError(error: string): ConfigSurfaceResult {
  return { items: [], total: 0, error };
}

export function collectConfigSurface(ctx: McpToolRuntime, args: Record<string, unknown>): ConfigSurfaceResult {
  const { graph, snapshot } = ctx.getState();
  const scope = resolveScope(ctx, args.scope);
  const requestedKinds = Array.isArray(args.kinds)
    ? new Set(args.kinds.filter((k): k is string => typeof k === 'string'))
    : undefined;
  const kind = (args.kind as string | undefined) ?? 'all';
  const groupBy = (args.groupBy as string | undefined) ?? 'name';
  const limit = limitFrom(args, DEFAULT_LIST_LIMIT);
  const offset = offsetFrom(args);
  let pattern: RegExp | undefined;
  if (typeof args.namePattern === 'string' && args.namePattern.trim()) {
    if (isUnsafeRegexPattern(args.namePattern)) {
      return configSurfaceError('Unsafe namePattern: nested or repeated quantifiers are not allowed');
    }
    try {
      pattern = new RegExp(args.namePattern, 'i');
    } catch (error) {
      return configSurfaceError(`Invalid namePattern: ${(error as Error).message}`);
    }
  }

  const all: Array<Record<string, unknown>> = [];
  const nameMatches = (name: string): boolean => !pattern || pattern.test(name);
  const configKindMatches = (itemKind: string): boolean => {
    if (requestedKinds?.size) {
      if (requestedKinds.has('all')) return true;
      if (requestedKinds.has(itemKind)) return true;
      return itemKind === 'resource-binding' && requestedKinds.has('resource');
    }
    if (kind === 'all' || kind === itemKind) return true;
    return kind === 'resource' && itemKind === 'resource-binding';
  };
  const push = (item: Record<string, unknown>, moduleId?: string) => {
    if (moduleId && !nodeInScope(ctx, moduleId, scope)) return;
    if (!moduleId && scope.kind !== 'all' && scope.kind !== 'query') return;
    const itemKind = item.kind as string;
    if (!configKindMatches(itemKind)) return;
    const name = String(item.name ?? item.resourceId ?? '');
    if (name && !nameMatches(name)) return;
    all.push(item);
  };

  for (const mod of snapshot.modules) {
    const envKinds = new Map(
      (mod.semanticHints?.security ?? [])
        .filter(signal => signal.name && (signal.kind === 'secret-env' || signal.kind === 'public-env'))
        .map(signal => [
          signal.name!,
          signal.kind === 'secret-env' ? 'secret' : 'public-config',
        ]),
    );
    for (const envName of mod.semanticHints?.envVars ?? []) {
      push({
        kind: envKinds.get(envName) ?? 'env',
        name: envName,
        moduleId: mod.id,
        moduleLabel: graph.nodes.get(mod.id)?.label ?? mod.relativeFilePath,
        packageName: mod.packageName,
      }, mod.id);
    }

    for (const edge of graph.outEdges.get(mod.id) ?? []) {
      if (edge.kind === 'binds_to' || edge.kind === 'uses_env') {
        const target = graph.nodes.get(edge.to);
        // Secret-ness lives on the target node (InfraResourceKind 'secret'), not on a dedicated
        // edge kind: classify by the resolved resource kind, falling back to the edge family.
        const isSecret = target?.type === 'runtime-resource' && target.data?.kind === 'secret';
        const itemKind = isSecret
          ? 'secret'
          : edge.kind === 'uses_env' ? 'env' : 'resource-binding';
        push({
          kind: itemKind,
          name: nodeLabel(graph, edge.to),
          resourceId: edge.to,
          relation: edge.kind,
          moduleId: mod.id,
          moduleLabel: graph.nodes.get(mod.id)?.label ?? mod.relativeFilePath,
        }, mod.id);
      }
    }
  }

  // Resource→resource secrets. config-surface is otherwise module-centric (it reads binds_to /
  // uses_env from source modules), so secrets consumed by runtime resources WITHOUT a code handler
  // — k8s workloads, docker-compose services, Vercel project, Helm images — never surface. Those
  // consumers still declare uses_env edges to secret nodes, so walk them here. Skip secrets already
  // emitted via a module binding (SAM/Terraform Lambdas) to avoid listing the same secret twice.
  const emittedSecretIds = new Set(
    all.filter(item => item.kind === 'secret').map(item => item.resourceId as string),
  );
  for (const consumerId of nodesOfType(graph, 'runtime-resource')) {
    for (const edge of graph.outEdges.get(consumerId) ?? []) {
      if (edge.kind !== 'uses_env') continue;
      const target = graph.nodes.get(edge.to);
      if (target?.type !== 'runtime-resource' || target.data?.kind !== 'secret') continue;
      if (emittedSecretIds.has(edge.to)) continue;
      emittedSecretIds.add(edge.to);
      push({
        kind: 'secret',
        name: target.label ?? edge.to,
        resourceId: edge.to,
        relation: edge.kind,
        moduleId: consumerId,
        moduleLabel: nodeLabel(graph, consumerId),
      }, consumerId);
    }
  }

  const sorted = all.sort((a, b) =>
    compareCodeUnits(String(a[groupBy] ?? a.name ?? ''), String(b[groupBy] ?? b.name ?? '')),
  );
  const page = sorted.slice(offset, offset + limit);
  const truncation = truncationMap({
    items: pageTruncation({
      shown: page.length,
      total: sorted.length,
      offset,
      noun: 'config/resource item',
      hint: `${sorted.length} config/resource item(s). Pass offset ${offset + page.length} with the same limit for the next page.`,
    }),
  });
  return { items: page, total: sorted.length, ...(truncation ? { truncation } : {}) };
}
