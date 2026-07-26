import type { RepositoryGraph } from '../../types.js';
import { buildNodeView, pathFromRoot } from '../../graph/index.js';
import { resolveDomainToCanonical } from '../../stage2/domains.js';
import { resolveDomainContentHash } from '../../annotations/store.js';
import { DEFAULT_PROPAGATION_CONFIG } from '../../config.js';
import {
  flattenByPackage,
  paginateDomainModules,
  parseDomainPaginationArgs,
  regroupByPackage,
  type DomainModuleRow,
} from '../domain-pagination.js';
import { resolveNodeId, type McpToolRuntime } from '../types.js';

/** Prefixes that indicate a node id rather than a domain name. */
export const NODE_ID_PREFIXES = /^(mod|export|pkg|resource|infra):/;

export function moduleLinkCount(graph: RepositoryGraph, moduleId: string): number {
  const view = buildNodeView(graph, moduleId);
  return view?.linksPagination?.total ?? view?.links?.length ?? 0;
}

export function resolveModulePackageId(graph: RepositoryGraph, moduleId: string): string {
  const pkgEdge = (graph.inEdges.get(moduleId) ?? []).find(
    e => e.kind === 'contains' && e.from.startsWith('pkg:'),
  );
  return pkgEdge?.from ?? 'unknown';
}

export function buildDomainContext(ctx: McpToolRuntime, args: Record<string, unknown>): unknown {
  const { graph, annotations, domainsConfig } = ctx.getState();
  const q = args.domainOrNodeId as string | undefined;
  if (!q) return { error: 'Missing required argument: domainOrNodeId' };
  let paginationInput;
  try {
    paginationInput = parseDomainPaginationArgs(args);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (NODE_ID_PREFIXES.test(q)) {
    const resolvedId = resolveNodeId(graph, q);
    if (resolvedId) {
      const result = pathFromRoot(graph, resolvedId);
      if (result) return result;
    }
    return { error: `Not found: ${q}` };
  }
  const domainLabel = resolveDomainToCanonical(q, domainsConfig);
  const domainId = domainLabel.startsWith('domain:') ? domainLabel : `domain:${domainLabel}`;
  if (graph.nodes.has(domainId)) {
    const domainNode = graph.nodes.get(domainId);
    if (!domainNode) return { error: `Not found: ${q}` };
    const incoming = graph.inEdges.get(domainId) ?? [];
    // `moduleCount` must mean the same thing here as it does per subdomain below, which counts
    // module-typed sources only. Infra propagation tags runtime resources into domains too, so an
    // unfiltered count reported more "modules" than the subdomain rows could ever add up to.
    const allTagged = incoming.filter(e => e.kind === 'tagged');
    const taggedModuleIds = allTagged.filter(e => graph.nodes.get(e.from)?.type === 'module').map(e => e.from);
    const taggedNonModuleCount = allTagged.length - taggedModuleIds.length;
    const moduleRows: DomainModuleRow[] = [];
    for (const id of taggedModuleIds) {
      const view = buildNodeView(graph, id);
      if (!view) continue;
      moduleRows.push({
        id: view.id,
        label: view.label,
        exports: view.drill_down.length,
        links: view.linksPagination?.total ?? view.links?.length ?? 0,
      });
    }
    const { modules: pagedModules, topModules, pagination } = paginateDomainModules(moduleRows, paginationInput);
    const tier = domainNode.type === 'domain' ? domainNode.data?.tier : undefined;
    const subdomainIds = domainNode.type === 'domain' ? domainNode.data?.subdomains : undefined;
    const result: Record<string, unknown> = {
      domain: domainId,
      label: domainNode.label,
      ...(tier ? { tier } : {}),
      moduleCount: moduleRows.length,
      // Tagged nodes that are not modules (infra propagation attaches runtime resources) are
      // counted rather than dropped in silence; inspect the domain node to enumerate them.
      ...(taggedNonModuleCount > 0 ? { taggedNonModuleCount } : {}),
      pagination,
    };
    if (pagination.summaryOnly) {
      if (topModules?.length) result.topModules = topModules;
    } else {
      result.modules = pagedModules;
    }
    if (subdomainIds?.length) {
      result.subdomains = subdomainIds.map(sid => {
        const sNode = graph.nodes.get(sid);
        const sIncoming = graph.inEdges.get(sid) ?? [];
        const sModCount = sIncoming.filter(e => e.kind === 'tagged' && graph.nodes.get(e.from)?.type === 'module').length;
        return { id: sid, label: sNode?.label ?? sid, moduleCount: sModCount };
      });
    }
    const domainAnn = annotations.get(domainId);
    if (domainAnn) {
      const { snapshot } = ctx.getState();
      const propagation = ctx.getConfig().annotations.propagation ?? DEFAULT_PROPAGATION_CONFIG;
      const currentHash = resolveDomainContentHash(graph, snapshot, domainId, propagation);
      const fresh = currentHash !== undefined && domainAnn.contentHash === currentHash;
      result.annotation = domainAnn.annotation;
      result.annotationMeta = { pass: domainAnn.pass, updatedAt: domainAnn.updatedAt, fresh, freshnessSource: "content-hash" };
    }
    return result;
  }
  const resolvedId = resolveNodeId(graph, q);
  if (resolvedId) {
    const result = pathFromRoot(graph, resolvedId);
    if (result) return result;
  }
  return { error: `Not found: ${q}` };
}

export function buildDomainModulesSlice(ctx: McpToolRuntime, args: Record<string, unknown>): unknown {
  const { graph, annotations, domainsConfig } = ctx.getState();
  const tag = args.domainTag as string;
  let paginationInput;
  try {
    paginationInput = parseDomainPaginationArgs(args);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  const includeConsumers = args.includeConsumers === true;
  const includeSecondary = args.includeSecondaryMatches === true;
  const domainLabel = resolveDomainToCanonical(tag, domainsConfig);
  const domainId = domainLabel.startsWith('domain:') ? domainLabel : `domain:${domainLabel}`;
  if (!graph.nodes.has(domainId)) return { error: `Domain not found: ${tag}` };

  const incoming = graph.inEdges.get(domainId) ?? [];
  const isPrimaryTag = (e: { kind: string; metadata?: { tagSource?: string } }) =>
    e.kind === 'tagged' && (e.metadata?.tagSource !== 'pattern');
  const taggedEdges = incoming.filter(e => includeSecondary ? e.kind === 'tagged' : isPrimaryTag(e));
  const taggedModuleIds = new Set(taggedEdges.map(e => e.from));
  const secondaryMatchCount = incoming.filter(e => e.kind === 'tagged' && e.metadata?.tagSource === 'pattern').length;
  const allIds = new Set(taggedModuleIds);
  for (const modId of taggedModuleIds) {
    const outEdges = graph.outEdges.get(modId) ?? [];
    for (const edge of outEdges) {
      if (edge.kind === 'imports') allIds.add(edge.to);
    }
  }
  const consumerIds = new Set<string>();
  if (includeConsumers) {
    for (const modId of taggedModuleIds) {
      const inEdges = graph.inEdges.get(modId) ?? [];
      for (const edge of inEdges) {
        if (edge.kind === 'imports' && !taggedModuleIds.has(edge.from)) consumerIds.add(edge.from);
      }
    }
  }
  const nodeLabel = (id: string) => graph.nodes.get(id)?.label ?? id;
  const groupByPackage = (ids: Iterable<string>) => {
    const byPkg = new Map<string, string[]>();
    for (const id of ids) {
      const node = graph.nodes.get(id);
      if (!node || node.type !== 'module') continue;
      const pkgEdge = (graph.inEdges.get(id) ?? []).find(e => e.kind === 'contains' && e.from.startsWith('pkg:'));
      const pkg = pkgEdge?.from ?? 'unknown';
      let arr = byPkg.get(pkg);
      if (!arr) { arr = []; byPkg.set(pkg, arr); }
      arr.push(id);
    }
    return Object.fromEntries(
      [...byPkg.entries()].map(([pkg, mods]) => [pkg, mods.map(id => ({ id, label: nodeLabel(id) }))])
    );
  };
  const domainNode = graph.nodes.get(domainId);
  const tier = domainNode?.type === 'domain' ? domainNode.data?.tier : undefined;
  const fullByPackage = groupByPackage(allIds);
  const flatEntries = flattenByPackage(fullByPackage);
  const sliceRows: DomainModuleRow[] = flatEntries.map(e => ({
    id: e.id,
    label: e.label,
    links: moduleLinkCount(graph, e.id),
  }));
  const { modules: pagedRows, topModules, pagination } = paginateDomainModules(sliceRows, paginationInput);
  const pagedByPackage = pagination.summaryOnly
    ? undefined
    : regroupByPackage(
        pagedRows.map(m => ({ id: m.id, label: m.label })),
        id => resolveModulePackageId(graph, id),
      );
  const result: Record<string, unknown> = {
    domain: tag,
    ...(tier ? { tier } : {}),
    taggedModules: taggedModuleIds.size,
    totalWithDeps: allIds.size,
    pagination,
  };
  if (pagination.summaryOnly) {
    if (topModules?.length) result.topModules = topModules;
  } else if (pagedByPackage) {
    result.byPackage = pagedByPackage;
  }
  if (!includeSecondary && secondaryMatchCount > 0) {
    result.secondaryMatches = {
      count: secondaryMatchCount,
      note: 'Modules matched by regex pattern only (not directory/import-cluster). Pass includeSecondaryMatches: true to include.',
    };
  }
  if (includeConsumers && consumerIds.size > 0) {
    result.consumers = { count: consumerIds.size, byPackage: groupByPackage(consumerIds) };
  }
  const domainAnn = annotations.get(domainId);
  if (domainAnn) {
    const { snapshot } = ctx.getState();
    const propagation = ctx.getConfig().annotations.propagation ?? DEFAULT_PROPAGATION_CONFIG;
    const currentHash = resolveDomainContentHash(graph, snapshot, domainId, propagation);
    const fresh = currentHash !== undefined && domainAnn.contentHash === currentHash;
    result.annotation = domainAnn.annotation;
    result.annotationMeta = { pass: domainAnn.pass, updatedAt: domainAnn.updatedAt, fresh, freshnessSource: "content-hash" };
  }
  return result;
}
