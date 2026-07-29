import type { ModuleInfo } from '../../../types.js';
import { pluginHasUiSurfaces } from '../../../plugin-host/source-set.js';

/**
 * Shared frontend-class applicability predicate.
 * `undefined` sourcePluginId maps to the TypeScript-default frontend surface.
 */
export const uiSurfaceApplies = (mod: ModuleInfo): boolean =>
  pluginHasUiSurfaces(mod.sourcePluginId);
