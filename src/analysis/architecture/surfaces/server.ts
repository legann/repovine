import type { ModuleInfo } from '../../../types.js';
import { hasHttpHandlerSignals, isBackendContext } from '../heuristics.js';

export const serverSurfaceApplies = (mod: ModuleInfo): boolean =>
  isBackendContext(mod) || hasHttpHandlerSignals(mod);
