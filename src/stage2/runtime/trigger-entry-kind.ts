// Side-effect import ensures built-in trigger-type metadata is registered before lookup.
import '../../stage1/iac/bootstrap.js';
import type { DeclarationCatalog } from '../../plugins/declaration-catalog.js';
import { resolveTriggerTypeMeta } from './declared-meta.js';

/**
 * Neutral mapping from an IaC trigger to its entrypoint kind. Lives outside the MCP shell so the
 * infra-link layer can own service-trigger entrypoints without importing MCP internals (handoff T5).
 *
 * The catalog is the build's own declarations. Passing it is what lets a trigger type an external
 * plugin declared reach this mapping; without one only the built-in registry answers.
 */
export function triggerEntryKind(
  trigger: { type?: string; path?: string },
  catalog?: DeclarationCatalog,
): string {
  const meta = trigger.type ? resolveTriggerTypeMeta(catalog, trigger.type) : undefined;
  const kind = meta?.entrypointKind;
  if (kind === 'api') {
    const path = trigger.path?.toLowerCase() ?? '';
    return path.includes('webhook') ? 'webhook' : 'api';
  }
  return kind ?? 'unknown';
}
