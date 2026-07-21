import { computeDomainsSuggestion } from '../../stage2/domains-advisor.js';
import { mergeDeclinedDomainsSuggestions, writeOnboardingState } from '../onboarding-state.js';
import { computeCarrierLinkGaps } from '../../annotations/carrier-links.js';
import {
  carrierTargetRiskHash,
  mergeCarrierReviewEntries,
  readValidSuppressedTargets,
  type CarrierReviewEntry,
} from '../../annotations/carrier-review.js';
import { emptyNavigation, envelope, envelopeError, nav } from '../response/envelope.js';
import type { McpToolRuntime, ToolHandler } from '../types.js';

export const DECLINE_ADVISORY_KINDS = ['domains-config', 'carrier-link-gaps'] as const;
export type DeclineAdvisoryKind = typeof DECLINE_ADVISORY_KINDS[number];

function requestedIds(args: Record<string, unknown>, visibleIds: Set<string>): string[] {
  return args.all === true
    ? [...visibleIds]
    : Array.isArray(args.ids)
      ? args.ids.filter((id): id is string => typeof id === 'string')
      : [];
}

function declineDomainsConfig(ctx: McpToolRuntime, args: Record<string, unknown>): unknown {
  const state = ctx.getState();
  const visibleIds = new Set(state.domainsSuggestions.additions.map(addition => addition.id));
  const requested = requestedIds(args, visibleIds);
  const declinedIds = [...new Set(requested)].filter(id => visibleIds.has(id));
  const ignoredIds = [...new Set(requested)].filter(id => !visibleIds.has(id));

  const navigation = emptyNavigation();
  navigation.sideways.push(nav('suggest_domains_config', {}, 'Review remaining domains config suggestions.'));

  if (declinedIds.length === 0) {
    return envelope('all', 'No visible domains config suggestions were declined.', {
      declined: [],
      ignored: ignoredIds,
      domainsSuggestions: {
        count: state.domainsSuggestions.count,
        axes: state.domainsSuggestions.axes,
        declinedHidden: state.domainsSuggestions.declinedHidden,
      },
    }, {
      confidence: 'medium',
      gaps: requested.length === 0
        ? ['Pass ids from suggest_domains_config, or pass all: true to decline all visible suggestions.']
        : ['Requested ids did not match current visible domains suggestions.'],
      navigation,
    });
  }

  const declined = mergeDeclinedDomainsSuggestions(ctx.repoRoot, declinedIds);
  state.domainsSuggestions = computeDomainsSuggestion(state.snapshot, state.graph, undefined, declined);
  writeOnboardingState(ctx.repoRoot, state, { declined });

  return envelope('all', `Declined ${declinedIds.length} domains config suggestion(s).`, {
    declined: declinedIds,
    ignored: ignoredIds,
    declinedTotal: declined.declined.length,
    domainsSuggestions: {
      count: state.domainsSuggestions.count,
      axes: state.domainsSuggestions.axes,
      declinedHidden: state.domainsSuggestions.declinedHidden,
    },
  }, {
    confidence: 'high',
    gaps: ignoredIds.length > 0 ? [`Ignored ${ignoredIds.length} id(s) that are not currently visible.`] : [],
    navigation,
  });
}

function declineCarrierLinkGaps(ctx: McpToolRuntime, args: Record<string, unknown>): unknown {
  const { graph, annotations } = ctx.getState();
  const allAnnotations = annotations.getAll();
  const suppressed = readValidSuppressedTargets(ctx.repoRoot, allAnnotations);
  const gaps = computeCarrierLinkGaps({
    graph,
    annotations: allAnnotations,
    sampleLimit: Infinity,
    suppressedTargetIds: suppressed,
  });
  const visibleTargetIds = new Set(
    gaps.sample.filter((s) => s.kind === 'missing-carrier-link').map((s) => s.targetId),
  );
  const requested = requestedIds(args, visibleTargetIds);
  const declinedIds = [...new Set(requested)].filter((id) => visibleTargetIds.has(id));
  const ignoredIds = [...new Set(requested)].filter((id) => !visibleTargetIds.has(id));
  const reason = typeof args.reason === 'string' && args.reason.trim().length > 0
    ? args.reason.trim()
    : undefined;

  const navigation = emptyNavigation();
  navigation.sideways.push(nav('get_annotation_status', { view: 'carrier-gaps' }, 'Review remaining carrier-link gap targets and suppression state.'));
  navigation.validate.push(nav('validate_annotations', {}, 'Re-check carrier advisory counts after declining.'));

  if (declinedIds.length === 0) {
    return envelope('all', 'No visible carrier-link gap targets were declined.', {
      declined: [],
      ignored: ignoredIds,
      carrierLinkGaps: {
        missingCarrierLinks: gaps.missingCarrierLinks,
        suppressedTargets: gaps.suppressedTargets,
      },
    }, {
      confidence: 'medium',
      gaps: requested.length === 0
        ? ['Pass ids from get_annotation_status({ "view": "carrier-gaps" }), or all: true to decline every currently flagged target.']
        : ['Requested ids did not match current missing-carrier-link gap targets.'],
      navigation,
    });
  }

  const decidedAt = new Date().toISOString();
  const entries: Record<string, CarrierReviewEntry> = {};
  for (const targetId of declinedIds) {
    entries[targetId] = {
      riskHash: carrierTargetRiskHash(allAnnotations[targetId]?.annotation),
      decidedAt,
      ...(reason ? { reason } : {}),
    };
  }
  const merged = mergeCarrierReviewEntries(ctx.repoRoot, entries);

  const after = computeCarrierLinkGaps({
    graph,
    annotations: allAnnotations,
    suppressedTargetIds: readValidSuppressedTargets(ctx.repoRoot, allAnnotations),
  });

  return envelope('all', `Declined ${declinedIds.length} carrier-link gap target(s).`, {
    declined: declinedIds,
    ignored: ignoredIds,
    reviewedTotal: Object.keys(merged.reviewedTargets).length,
    carrierLinkGaps: {
      missingCarrierLinks: after.missingCarrierLinks,
      suppressedTargets: after.suppressedTargets,
    },
  }, {
    confidence: 'high',
    gaps: ignoredIds.length > 0 ? [`Ignored ${ignoredIds.length} id(s) that are not currently flagged gap targets.`] : [],
    navigation,
  });
}

/** One decline surface for every accept/reject advisory; the advisory producers stay read-only.
 *  State stays per-kind: domains declines in `.repovine/onboarding-state.json`, carrier reviews in
 *  `.repovine/carrier-review.json`. */
export const handleDeclineAdvisory: ToolHandler = (ctx, args) => {
  const kind = args.kind;
  if (kind === 'domains-config') return declineDomainsConfig(ctx, args);
  if (kind === 'carrier-link-gaps') return declineCarrierLinkGaps(ctx, args);
  return envelopeError('all', `decline_advisory requires kind: one of ${DECLINE_ADVISORY_KINDS.join(', ')}.`);
};
