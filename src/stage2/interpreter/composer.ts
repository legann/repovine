import { applyValidated, emptyGraphDelta } from '../../graph/index.js';
import type {
  Interpreter,
  EntrypointFragment,
  InterpreterEntrypointContext,
  InterpreterGraphContext,
  InterpreterLogLevel,
} from '../../interpreter/types.js';
import type { GraphDelta, ModuleInfo, RepositoryGraph, RepositoryFactsSnapshot } from '../../types.js';
import type { DomainsConfig } from '../domains.js';
import { getInterpreterRegistrations } from './registry.js';

export interface ComposeInterpretersOptions {
  graph: RepositoryGraph;
  snapshot: RepositoryFactsSnapshot;
  modulesById: Map<string, ModuleInfo>;
  /** Already-loaded domains config from the stage2 caller; threaded to layer contexts (T2). */
  domainsConfig?: DomainsConfig | null;
  interpreters?: readonly Interpreter[];
  logger?: (level: InterpreterLogLevel, message: string) => void;
}

export interface InterpreterCompositionResult {
  appliedInterpreterIds: string[];
  skippedInterpreterIds: string[];
  entrypoints: EntrypointFragment[];
}

export function composeInterpreters(options: ComposeInterpretersOptions): InterpreterCompositionResult {
  const interpreters = options.interpreters ?? getInterpreterRegistrations();
  if (interpreters.length === 0) {
    return { appliedInterpreterIds: [], skippedInterpreterIds: [], entrypoints: [] };
  }

  const sourcePluginIds = collectSourcePluginIds(options.snapshot);
  const skippedInterpreterIds: string[] = [];
  const enabled = interpreters.filter(interpreter => {
    if (!appliesToSourceAdapter(interpreter, sourcePluginIds)) {
      skippedInterpreterIds.push(interpreter.id);
      return false;
    }
    if (!hasAnyRequiredHint(interpreter, options.snapshot)) {
      skippedInterpreterIds.push(interpreter.id);
      return false;
    }
    return true;
  });
  const log = options.logger ?? defaultLogger;
  const ordered = topoSortInterpreters(enabled);
  const baseContext = {
    graph: options.graph,
    snapshot: options.snapshot,
    modulesById: options.modulesById,
    sourcePluginIds,
    domainsConfig: options.domainsConfig ?? null,
    log,
  };
  const entrypoints: EntrypointFragment[] = [];

  for (const interpreter of ordered) {
    if (interpreter.contributeGraph) {
      const delta = normalizeDelta(interpreter.contributeGraph(baseContext as InterpreterGraphContext), interpreter.id);
      applyValidated(options.graph, delta, { logger: log });
    }
    if (interpreter.collectEntrypoints) {
      entrypoints.push(...interpreter.collectEntrypoints(baseContext as InterpreterEntrypointContext));
    }
  }

  return {
    appliedInterpreterIds: ordered.map(interpreter => interpreter.id),
    skippedInterpreterIds,
    entrypoints,
  };
}

function collectSourcePluginIds(snapshot: RepositoryFactsSnapshot): readonly string[] {
  const ids = new Set<string>();
  for (const pkg of snapshot.packages) {
    if (pkg.sourcePluginId) ids.add(pkg.sourcePluginId);
  }
  for (const mod of snapshot.modules) {
    if (mod.sourcePluginId) ids.add(mod.sourcePluginId);
  }
  return [...ids].sort();
}

function appliesToSourceAdapter(interpreter: Interpreter, sourcePluginIds: readonly string[]): boolean {
  if (interpreter.sourceAdapterIds === '*') return true;
  return interpreter.sourceAdapterIds.some(id => sourcePluginIds.includes(id));
}

function hasAnyRequiredHint(interpreter: Interpreter, snapshot: RepositoryFactsSnapshot): boolean {
  if (!interpreter.requiresSemanticHints || interpreter.requiresSemanticHints.length === 0) return true;
  return snapshot.modules.some(mod =>
    interpreter.requiresSemanticHints!.some(key => hasHintKey(mod.semanticHints, key)),
  );
}

function hasHintKey(hints: unknown, key: string): boolean {
  if (!hints || typeof hints !== 'object') return false;
  let current: unknown = hints;
  for (const segment of key.split('.')) {
    if (!current || typeof current !== 'object' || !(segment in current)) return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return current !== undefined;
}

/**
 * Topo-sort interpreters by their `requiresInterpreters[]` edges within the deterministic base order. All
 * interpreters are first-party, so a duplicate id, a missing requirement, or a cycle is a
 * programmer error and throws.
 */
function topoSortInterpreters(interpreters: readonly Interpreter[]): Interpreter[] {
  const byId = new Map<string, Interpreter>();
  for (const interpreter of interpreters) {
    if (byId.has(interpreter.id)) throw new Error(`Duplicate interpreter id "${interpreter.id}"`);
    byId.set(interpreter.id, interpreter);
  }

  const out: Interpreter[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(interpreter: Interpreter, path: string[]): void {
    const { id } = interpreter;
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const cycleStart = path.indexOf(id);
      const cycle = [...path.slice(cycleStart), id].join(' -> ');
      throw new Error(`Interpreter requires cycle detected: ${cycle}`);
    }
    visiting.add(id);
    for (const requiredId of interpreter.requiresInterpreters ?? []) {
      const required = byId.get(requiredId);
      if (!required) {
        throw new Error(`Interpreter "${id}" requires missing interpreter "${requiredId}"`);
      }
      visit(required, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
    out.push(interpreter);
  }

  for (const interpreter of interpreters) visit(interpreter, []);
  return out;
}

function normalizeDelta(delta: GraphDelta | undefined, interpreterId: string): GraphDelta {
  if (delta === undefined) {
    throw new Error(`Interpreter "${interpreterId}" contributeGraph() returned undefined; return emptyGraphDelta() for no-op interpreters.`);
  }
  return delta ?? emptyGraphDelta();
}

function defaultLogger(level: InterpreterLogLevel, message: string): void {
  if (level === 'error') console.error(`[repovine:interpreter-composer] ${message}`);
  else if (level === 'warn') console.warn(`[repovine:interpreter-composer] ${message}`);
  else if (process.env.REPOVINE_VERBOSE) console.log(`[repovine:interpreter-composer] ${message}`);
}
