import type { DomainsConfig } from '../stage2/domains.js';
import type { GraphDelta, ModuleInfo, RepositoryGraph, RepositoryFactsSnapshot } from '../types.js';

export type InterpreterId = string;

export interface EntrypointFragment {
  kind: string;
  id?: string;
  moduleId?: string;
  path?: string;
  label?: string;
  [key: string]: unknown;
}

export interface InterpreterGraphContext {
  graph: RepositoryGraph;
  snapshot: RepositoryFactsSnapshot;
  modulesById: Map<string, ModuleInfo>;
  sourcePluginIds: readonly string[];
  /**
   * Already-loaded domains config from the stage2 caller (resource excludes etc.). Interpreters must not
   * reload it from disk; the caller owns the single load. Null when unavailable.
   */
  domainsConfig: DomainsConfig | null;
  log(level: InterpreterLogLevel, message: string): void;
}

export interface InterpreterEntrypointContext {
  graph: RepositoryGraph;
  snapshot: RepositoryFactsSnapshot;
  modulesById: Map<string, ModuleInfo>;
  sourcePluginIds: readonly string[];
  log(level: InterpreterLogLevel, message: string): void;
}

export type InterpreterLogLevel = 'debug' | 'warn' | 'error';

/**
 * An interpreter enriches or links the repository graph: it contributes graph deltas and/or
 * collects entrypoints. It does NOT judge the map — architecture detectors live in detector packs
 * (see `DetectorPack` in `analysis/architecture/detector-types.ts`). This is the graph/entrypoint half of the
 * old `LayerPlugin`, with the detector-registration hook removed.
 */
export interface Interpreter {
  id: InterpreterId;
  sourceAdapterIds: string[] | '*';
  requiresInterpreters?: InterpreterId[];
  requiresSemanticHints?: string[];
  contributeGraph?(ctx: InterpreterGraphContext): GraphDelta;
  collectEntrypoints?(ctx: InterpreterEntrypointContext): EntrypointFragment[];
}
