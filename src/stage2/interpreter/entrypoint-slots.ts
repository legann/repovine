import type { EntrypointFragment } from '../../interpreter/types.js';

/**
 * Neutral home for the hidden slot marker carried by layer-produced entrypoints. The MCP shell
 * (mcp/lib/entrypoints.ts) replays layer entrypoints in the legacy global order by looking them up
 * per slot, then strips the marker before public output. Kept out of any single layer so
 * frontend-routes / infra-link / backend-routes can all tag entries without importing each other
 * (handoff T5).
 */
export const LAYER_ENTRYPOINT_SLOT_KEY = '__repovineSlot';

export type EntrypointSlot =
  | 'python-api'
  | 'file-api'
  | 'jsx-route'
  | 'tanstack-route'
  | 'angular-route'
  | 'conditional'
  | 'file-page'
  | 'service-trigger';

export interface SlottedEntrypointFragment extends EntrypointFragment {
  [LAYER_ENTRYPOINT_SLOT_KEY]: EntrypointSlot;
}

/** Remove the hidden slot marker so the entry is byte-identical to the legacy inline shape. */
export function stripEntrypointFragmentInternals(entry: EntrypointFragment): Record<string, unknown> {
  const visible: Record<string, unknown> = { ...entry };
  delete visible[LAYER_ENTRYPOINT_SLOT_KEY];
  return visible;
}
