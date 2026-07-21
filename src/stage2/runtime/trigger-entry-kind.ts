// Side-effect import ensures built-in trigger-type metadata is registered before lookup.
import '../../stage1/iac/bootstrap.js';
import { getTriggerTypeMeta } from '../../stage1/iac/registry.js';

/**
 * Neutral mapping from an IaC trigger to its entrypoint kind. Lives outside the MCP shell so the
 * infra-link layer can own service-trigger entrypoints without importing MCP internals (handoff T5).
 */
export function triggerEntryKind(trigger: { type?: string; path?: string }): string {
  const meta = trigger.type ? getTriggerTypeMeta(trigger.type) : undefined;
  const kind = meta?.entrypointKind;
  if (kind === 'api') {
    const path = trigger.path?.toLowerCase() ?? '';
    return path.includes('webhook') ? 'webhook' : 'api';
  }
  return kind ?? 'unknown';
}
