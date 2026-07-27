import type { RepositoryGraph } from '../../types.js';
import { buildNodeView, domainMembers, isNodeType, isPatternTag, isPrimaryTag, isTaggedEdge, modulePackageId, nodeLabel } from '../../graph/index.js';
import { domainNodeId } from '../../graph/node-ids.js';
import { resolveDomainToCanonical } from '../../stage2/domains.js';
import { resolveNodeContentHash } from '../../annotations/content-hash.js';
import { DEFAULT_PROPAGATION_CONFIG } from '../../config.js';
import {
  flattenByPackage,
  type PackageGrouping,
  paginateDomainModules,
  parseDomainPaginationArgs,
  regroupByPackage,
  type DomainModuleRow,
} from '../domain-pagination.js';
import type { McpToolRuntime } from '../types.js';
import { argTruncation, truncationMap } from '../../response/truncation.js';
import { annotationFreshness, annotationFreshnessMeta } from '../../annotations/freshness.js';

export function moduleLinkCount(graph: RepositoryGraph, moduleId: string): number {
  const view = buildNodeView(graph, moduleId);
  return view?.truncation?.links?.total ?? view?.links?.length ?? 0;
}

/** The domain view for a domain name. A scope naming a node is answered by the map tool's own path branch. */
export function buildDomainContext(ctx: McpToolRuntime, args: Record<string, unknown>): unknown {
  const { graph, annotations, domainsConfig } = ctx.getState();
  const q = args.domain as string | undefined;
  if (!q) return { error: 'Missing required argument: domain' };
  let paginationInput;
  try {
    paginationInput = parseDomainPaginationArgs(args);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  const domainLabel = resolveDomainToCanonical(q, domainsConfig);
  const domainId = domainNodeId(domainLabel);
  if (graph.nodes.has(domainId)) {
    const domainNode = graph.nodes.get(domainId);
    if (!domainNode) return { error: `Not found: ${q}` };
    // `moduleCount` must mean the same thing here as it does per subdomain below, which counts
    // module-typed sources only. Infra propagation tags runtime resources into domains too, so an
    // unfiltered count reported more "modules" than the subdomain rows could ever add up to.
    const members = domainMembers(graph, domainId);
    const taggedModuleIds = members.modules;
    const taggedNonModuleCount = members.all.length - members.modules.length;
    const moduleRows: DomainModuleRow[] = [];
    for (const id of taggedModuleIds) {
      const view = buildNodeView(graph, id);
      if (!view) continue;
      moduleRows.push({
        id: view.id,
        label: view.label,
        exports: view.drillDown.length,
        links: view.truncation?.links?.total ?? view.links?.length ?? 0,
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
      summaryOnly: pagination.summaryOnly,
      ...(pagination.truncation ? { truncation: { modules: pagination.truncation } } : {}),
    };
    if (pagination.summaryOnly) {
      if (topModules?.length) result.topModules = topModules;
    } else {
      result.modules = pagedModules;
    }
    if (subdomainIds?.length) {
      result.subdomains = subdomainIds.map(sid => {
        return { id: sid, label: nodeLabel(graph, sid), moduleCount: domainMembers(graph, sid).modules.length };
      });
    }
    const domainAnn = annotations.get(domainId);
    if (domainAnn) {
      const { snapshot } = ctx.getState();
      const propagation = ctx.getConfig().annotations.propagation ?? DEFAULT_PROPAGATION_CONFIG;
      const currentHash = resolveNodeContentHash(domainId, { graph, snapshot, propagation });
      result.annotation = domainAnn.annotation;
      result.annotationMeta = {
        pass: domainAnn.pass,
        updatedAt: domainAnn.updatedAt,
        ...annotationFreshnessMeta(annotationFreshness({ annotation: domainAnn, currentHash })),
      };
    }
    return result;
  }
  return { error: `Domain not found: ${q}` };
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
  const domainId = domainNodeId(domainLabel);
  if (!graph.nodes.has(domainId)) return { error: `Domain not found: ${tag}` };

  const incoming = graph.inEdges.get(domainId) ?? [];
  const taggedEdges = incoming.filter(e => includeSecondary ? isTaggedEdge(e) : isPrimaryTag(e));
  // Named for what it holds. An unfiltered set reported runtime resources and subdomain nodes under
  // `taggedModules`, and the `byPackage` listing below — which does filter — then contradicted it in
  // the same response.
  const taggedModuleIds = new Set(taggedEdges.map(e => e.from).filter(id => isNodeType(graph, id, 'module')));
  const taggedNonModuleCount = taggedEdges.length - taggedModuleIds.size;
  const secondaryMatchCount = incoming.filter(isPatternTag).length;
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
  const groupByPackage = (ids: Iterable<string>): PackageGrouping => regroupByPackage(
    [...ids].filter(id => isNodeType(graph, id, 'module')).map(id => ({ id, label: nodeLabel(graph, id) })),
    id => modulePackageId(graph, id),
  );
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
        id => modulePackageId(graph, id),
      );
  const result: Record<string, unknown> = {
    domain: tag,
    ...(tier ? { tier } : {}),
    taggedModules: taggedModuleIds.size,
    // Tagged nodes that are not modules (infra propagation attaches runtime resources, subdomains
    // carry a domain tag of their own) are counted rather than dropped in silence.
    ...(taggedNonModuleCount > 0 ? { taggedNonModuleCount } : {}),
    totalWithDeps: allIds.size,
    summaryOnly: pagination.summaryOnly,
  };
  // Pattern-only matches are filtered out by default rather than paged away, so the bound they
  // report is the flag that returns them, not an offset.
  const secondary = !includeSecondary && secondaryMatchCount > 0
    ? argTruncation({
      shown: 0,
      total: secondaryMatchCount,
      arg: 'includeSecondaryMatches',
      value: true,
      hint: 'Modules matched by regex pattern only, not by directory or import cluster.',
    })
    : undefined;
  const truncation = truncationMap({ modules: pagination.truncation, secondaryMatches: secondary });
  if (truncation) result.truncation = truncation;
  if (pagination.summaryOnly) {
    if (topModules?.length) result.topModules = topModules;
  } else if (pagedByPackage) {
    result.byPackage = pagedByPackage.byPackage;
    if (pagedByPackage.withoutPackage.length > 0) result.withoutPackage = pagedByPackage.withoutPackage;
  }
  if (includeConsumers && consumerIds.size > 0) {
    const consumerGrouping = groupByPackage(consumerIds);
    result.consumers = {
      count: consumerIds.size,
      byPackage: consumerGrouping.byPackage,
      ...(consumerGrouping.withoutPackage.length > 0 ? { withoutPackage: consumerGrouping.withoutPackage } : {}),
    };
  }
  const domainAnn = annotations.get(domainId);
  if (domainAnn) {
    const { snapshot } = ctx.getState();
    const propagation = ctx.getConfig().annotations.propagation ?? DEFAULT_PROPAGATION_CONFIG;
    const currentHash = resolveNodeContentHash(domainId, { graph, snapshot, propagation });
    result.annotation = domainAnn.annotation;
    result.annotationMeta = {
      pass: domainAnn.pass,
      updatedAt: domainAnn.updatedAt,
      ...annotationFreshnessMeta(annotationFreshness({ annotation: domainAnn, currentHash })),
    };
  }
  return result;
}
