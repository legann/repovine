import type { DeclarationCatalog } from '../../plugin-host/declaration-catalog.js';
import { catalogTriggerTypeMeta } from '../../plugin-host/declaration-catalog.js';

/**
 * Neutral mapping from an IaC trigger to its entrypoint kind. Lives outside the MCP shell so the
 * infra-link layer can own service-trigger entrypoints without importing MCP internals.
 *
 * The catalog is the build's own declarations, and the trigger is looked up under the identity of
 * the resource carrying it: a type means what its ecosystem declared it means, and two ecosystems
 * spelling one type differently do not answer for each other.
 */
export function triggerEntryKind(
  trigger: { type?: string; path?: string },
  catalog?: DeclarationCatalog,
  carrier?: { namespace?: string; provider?: string },
): string {
  const meta = trigger.type && catalog
    ? catalogTriggerTypeMeta(catalog, {
      type: trigger.type,
      ...(carrier?.namespace === undefined ? {} : { namespace: carrier.namespace }),
      ...(carrier?.provider === undefined ? {} : { provider: carrier.provider }),
    })
    : undefined;
  const kind = meta?.entrypointKind;
  if (kind === 'api') {
    const path = trigger.path?.toLowerCase() ?? '';
    return path.includes('webhook') ? 'webhook' : 'api';
  }
  return kind ?? 'unknown';
}
