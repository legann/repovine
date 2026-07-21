import type { UiComponentLocalSignals } from '../../types.js';

/**
 * Map a UI component's local signal counts to the workflow-signal kind labels used by
 * both the god-module/server-handler detectors and the architecture detail view.
 * Single source of truth so the two never drift.
 */
export function workflowSignalKinds(s: UiComponentLocalSignals): string[] {
  return [
    s.localState > 0 ? 'local-state' : undefined,
    s.effects > 0 ? 'effects' : undefined,
    s.dataAccess > 0 ? 'data-access' : undefined,
    s.navigation > 0 ? 'navigation' : undefined,
    s.timers > 0 ? 'timers' : undefined,
    s.subscriptions > 0 ? 'subscriptions' : undefined,
    s.serviceImports > 0 ? 'service-imports' : undefined,
    s.validationOrMapping > 0 ? 'validation/mapping' : undefined,
  ].filter((kind): kind is string => kind != null);
}
