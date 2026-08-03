import type { ToolHandler } from '../types.js';
import { resolveScope } from '../scope/resolve.js';
import { scopeNavigation } from '../scope/navigation.js';
import { envelope, nav } from '../response/envelope.js';
import { limitFrom, offsetFrom, DEFAULT_LIST_LIMIT } from '../response/pagination.js';
import { pageTruncation, truncationMap } from '../../response/truncation.js';
import { emptyOutcome, traceFlowEmptyDiagnostic } from '../response/empty-diagnostics.js';
import { projectRuntimeTopology } from '../lib/topology.js';
import { collectEntrypoints } from '../lib/entrypoints.js';
import { computeRuntimeHandoff } from '../lib/runtime-handoff.js';

const RUNTIME_HANDOFF_TRUNCATED_GAP =
  'Runtime handoff list truncated - inspect listed handler modules first; paginate trace_flow or inspect remaining resources individually.';

const UNRESOLVED_REF_REASON_TEXT: Record<string, string> = {
  ambiguous: 'several resources carry that logical id and the declaring document does not single one out',
  'out-of-scope': 'the matching resources sit outside the reference\'s own namespace',
};

/**
 * Disclose where a data-flow listing is a producer×consumer product rather than a list of routes.
 * A resource with several producers and several consumers yields every pairing; without saying so,
 * the count reads as evidence of that many distinct flows.
 */
function dataFlowProductGaps(dataFlows: Array<Record<string, unknown>>): string[] {
  const byResource = new Map<string, { from: Set<string>; to: Set<string> }>();
  for (const flow of dataFlows) {
    const through = typeof flow.through === 'string' ? flow.through : undefined;
    if (!through) continue;
    let entry = byResource.get(through);
    if (!entry) { entry = { from: new Set(), to: new Set() }; byResource.set(through, entry); }
    if (typeof flow.from === 'string') entry.from.add(flow.from);
    if (typeof flow.to === 'string') entry.to.add(flow.to);
  }

  const out: string[] = [];
  for (const [through, { from, to }] of byResource) {
    if (from.size < 2 || to.size < 2) continue;
    out.push(
      `Data flows through ${through} are the ${from.size}x${to.size} producer-consumer product, not ${from.size * to.size} observed routes:`
      + ' each pair is a static possibility through a shared resource. Read publishes/consumes on the participants for what is proven.',
    );
  }
  return out;
}

/**
 * One gap line per reference the graph refused to bind. A missing edge is otherwise
 * indistinguishable from an absent reference, which is what makes an unbound id look resolved.
 */
function unresolvedRefGaps(services: Array<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const service of services) {
    const refs = service.unresolvedRefs;
    if (!Array.isArray(refs)) continue;
    for (const ref of refs as Array<{ logicalId?: string; reason?: string; candidates?: string[] }>) {
      const reason = UNRESOLVED_REF_REASON_TEXT[ref.reason ?? ''] ?? 'the reference could not be scoped';
      out.push(
        `${service.label ?? service.id} references "${ref.logicalId}" but no edge was emitted: ${reason}`
        + ` (candidates: ${(ref.candidates ?? []).join(', ') || 'none'}).`,
      );
    }
  }
  return out;
}

export const handleTraceFlow: ToolHandler = (ctx, args) => {
  const scope = resolveScope(ctx, args.scope ?? args.from ?? 'all');
  const include = Array.isArray(args.include) ? args.include as string[] : ['services', 'resources', 'flows'];
  const raw = projectRuntimeTopology(ctx, {
    scope,
    includeResources: include.includes('resources'),
    includeApiRoutes: include.includes('entrypoints'),
  }) as Record<string, unknown>;

  const limit = limitFrom(args, DEFAULT_LIST_LIMIT);
  const offset = offsetFrom(args);
  // The projection already decided membership for this scope kind; filtering again here was a second
  // answer to the same question, and it left `resources` and `dataFlows` unfiltered beside it.
  const servicesRaw = Array.isArray(raw.services) ? raw.services as Array<Record<string, unknown>> : [];
  const services = servicesRaw.slice(offset, offset + limit);
  const resourcesRaw = Array.isArray(raw.resources) ? raw.resources as Array<Record<string, unknown>> : [];
  const resources = resourcesRaw.slice(offset, offset + limit);
  const dataFlowsRaw = Array.isArray(raw.dataFlows) ? raw.dataFlows as Array<Record<string, unknown>> : [];
  const dataFlows = dataFlowsRaw.slice(offset, offset + limit);
  const handoff = computeRuntimeHandoff(ctx, {
    scope,
    serviceIds: services.map(s => s.id).filter((id): id is string => typeof id === 'string'),
  });
  // Paged with the same offset as the other three lists; without it every page repeated the first
  // `limit` entrypoints while services and flows advanced.
  const entrypointPage = include.includes('entrypoints')
    ? collectEntrypoints(ctx, { scope: scope.resolvedScope, limit, offset })
    : undefined;
  const entrypoints = entrypointPage?.items ?? [];
  const result: Record<string, unknown> = {
    scope: raw.scope,
    ...(include.includes('services') ? { services } : {}),
    ...(include.includes('resources') ? { resources } : {}),
    ...(include.includes('flows') ? { dataFlows } : {}),
    ...(include.includes('entrypoints') ? { entrypoints } : {}),
    runtimeHandoff: handoff,
  };
  // Three lists share one offset, so each reports its own bound rather than one flag standing for
  // whichever of them still has rows.
  const pageBound = (shown: number, total: number, noun: string) => pageTruncation({
    shown,
    total,
    offset,
    noun,
    hint: `${total} ${noun}(s) in scope. Pass offset ${offset + shown} with the same limit for the next page.`,
  });
  const truncation = truncationMap({
    services: include.includes('services') ? pageBound(services.length, servicesRaw.length, 'service') : undefined,
    resources: include.includes('resources') ? pageBound(resources.length, resourcesRaw.length, 'resource') : undefined,
    dataFlows: include.includes('flows') ? pageBound(dataFlows.length, dataFlowsRaw.length, 'data flow') : undefined,
    entrypoints: entrypointPage?.truncation?.items,
  });
  if (truncation) result.truncation = truncation;
  const navigation = scopeNavigation(scope);
  navigation.deeper.unshift(...handoff.items.map(item =>
    nav(
      'inspect_node',
      { nodeId: item.handlerModuleId },
      `Runtime handoff - handler module for ${item.resourceId}; inspect before editing code.`,
    ),
  ));
  const handoffResourceIds = new Set(handoff.items.map(item => item.resourceId));
  for (const s of services.slice(0, 6)) {
    const id = s.id as string | undefined;
    if (id && handoffResourceIds.has(id)) continue;
    if (id) navigation.deeper.push(nav('inspect_node', { nodeId: id }, 'Inspect a runtime service/resource participating in this flow.'));
  }
  // Emptiness is a fact about the scope, not about the page. Reading it off the paged slices made an
  // offset past the end report "no runtime topology matched" while `confidence` — read off the
  // unpaged lists two lines below — still said the scope had some. The page window is `truncation`'s
  // fact and it already carries a restart hint.
  const emptyTraceResult =
    (include.includes('services') ? servicesRaw.length === 0 : true)
    && (include.includes('resources') ? resourcesRaw.length === 0 : true)
    && (include.includes('flows') ? dataFlowsRaw.length === 0 : true)
    && (include.includes('entrypoints') ? (entrypointPage?.total ?? 0) === 0 : true);
  const emptyDiagnostic = emptyTraceResult
    ? traceFlowEmptyDiagnostic(ctx, scope, args, {
      services: servicesRaw.length,
      resources: resourcesRaw.length,
      dataFlows: dataFlowsRaw.length,
      entrypoints: entrypointPage?.total ?? 0,
    })
    : undefined;
  const outcome = emptyOutcome(emptyDiagnostic, 'medium');
  const gaps = [...outcome.gaps];
  // Not an emptiness statement: services and resources can be present while no producer-resource-
  // consumer path is proven between them, and that is a completeness fact about a non-empty answer.
  if (!emptyDiagnostic && dataFlowsRaw.length === 0) {
    gaps.push('No concrete producer-resource-consumer data flow was found in this scope.');
  }
  if (handoff.truncation) gaps.push(RUNTIME_HANDOFF_TRUNCATED_GAP);
  gaps.push(...unresolvedRefGaps(services));
  gaps.push(...dataFlowProductGaps(dataFlowsRaw));
  const payload = emptyDiagnostic ? { ...result, emptyDiagnostic } : result;
  return envelope(scope, `Traced runtime/system topology for ${scope.resolvedScope}.`, payload, {
    confidence: outcome.confidence,
    gaps,
    navigation,
  });
};
