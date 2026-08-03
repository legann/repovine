import type { ToolHandler } from '../types.js';
import { DOMAINS_CONFIG_MERGE_STRATEGY } from '../../stage2/domains.js';
import { emptyNavigation, envelope, nav } from '../response/envelope.js';

export const handleSuggestDomainsConfig: ToolHandler = (ctx) => {
  const { domainsSuggestions } = ctx.getState();
  const navigation = emptyNavigation();
  navigation.validate.push(nav('refresh_context', {}, 'Refresh after writing repovine.domains.json (accept or keep).'));

  // `keepConfig` is the symmetric alternative to `mergedConfig`: instead of excluding the inert
  // infra-noise suggestions, write them as committed `infra.keep` markers (resource stays visible,
  // advisor stops suggesting it). Only surfaced when at least one suggestion is keepable.
  const hasKeepable = domainsSuggestions.additions.some(
    a => a.axis === 'infra.excludeSuffixes' || a.axis === 'infra.excludePatterns',
  );

  return envelope('all', domainsSuggestions.count > 0
    ? `Found ${domainsSuggestions.count} additive domains config suggestion(s).`
    : 'No domains config suggestions remain.',
  {
    domainsSuggestions: {
      count: domainsSuggestions.count,
      axes: domainsSuggestions.axes,
      declinedHidden: domainsSuggestions.declinedHidden,
      additions: domainsSuggestions.additions,
      mergedConfig: domainsSuggestions.mergedConfig,
      ...(hasKeepable ? { keepConfig: domainsSuggestions.keepConfig } : {}),
      mergeStrategy: DOMAINS_CONFIG_MERGE_STRATEGY,
    },
  }, {
    confidence: 'high',
    navigation,
  });
};
