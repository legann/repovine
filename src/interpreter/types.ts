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

/**
 * The module a service-trigger entrypoint dispatches into, when the fragment names one.
 *
 * `handlerModule` reaches readers through the index signature above, so every reader had to narrow
 * `unknown` itself and they did it four different ways, including one that compared `unknown` to a
 * string. The read is one question, so it has one answer here.
 */
export function entrypointHandlerModuleId(fragment: EntrypointFragment): string | undefined {
  const value = fragment.handlerModule;
  return typeof value === 'string' ? value : undefined;
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
  /**
   * Which composition phase this interpreter's graph contribution belongs to.
   *
   * The two phases are the composer's, not a dependency between interpreters: node-bearing
   * contributions land before the ones that draw edges into them. An interpreter that named another
   * by id would make its output an input, and the plan forbids that channel — a contributor reads
   * facts, never another contributor. Within a phase the order is the registration order and carries
   * no meaning: every phase-`links` contribution reads the same finished node set.
   */
  phase: InterpreterPhase;
  /**
   * Dotted `semanticHints` keys. The interpreter runs when ANY module carries ANY of them, whoever
   * produced it. Absent ⇒ no hint prerequisite.
   */
  requiresSemanticHints?: string[];
  /**
   * Snapshot fact slots that must carry at least one entry. Keyed on the snapshot type, so a slot
   * that is renamed stops compiling here rather than silently gating on nothing.
   */
  requiresSnapshotFacts?: Array<SnapshotFactSlot>;
  contributeGraph?(ctx: InterpreterGraphContext): GraphDelta;
  collectEntrypoints?(ctx: InterpreterEntrypointContext): EntrypointFragment[];
}

/**
 * Composition phases, in the order the composer applies them.
 *
 * `nodes` builds the node set a repository has; `links` draws relations into it and reads it whole.
 * The order is a property of graph construction, not of who registered first.
 */
export const INTERPRETER_PHASES = ['nodes', 'links'] as const;
export type InterpreterPhase = (typeof INTERPRETER_PHASES)[number];

/** Snapshot slots an interpreter may declare a prerequisite on: the array-valued fact slots. */
export type SnapshotFactSlot = {
  [K in keyof RepositoryFactsSnapshot]-?: NonNullable<RepositoryFactsSnapshot[K]> extends readonly unknown[]
    ? K
    : never;
}[keyof RepositoryFactsSnapshot];
