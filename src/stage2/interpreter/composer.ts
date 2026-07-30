import { applyValidated, emptyGraphDelta } from '../../graph/index.js';
import {
  INTERPRETER_PHASES,
  type Interpreter,
  type EntrypointFragment,
  type InterpreterEntrypointContext,
  type InterpreterGraphContext,
  type InterpreterLogLevel,
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

  const skippedInterpreterIds: string[] = [];
  const enabled = interpreters.filter(interpreter => {
    // Gated on the facts a repository carries, never on who produced them: a normalized route hint
    // enables the same interpreter whether TypeScript, Python or a third-party plugin published it.
    if (!hasAnyRequiredHint(interpreter, options.snapshot)) {
      skippedInterpreterIds.push(interpreter.id);
      return false;
    }
    if (!hasRequiredSnapshotFacts(interpreter, options.snapshot)) {
      skippedInterpreterIds.push(interpreter.id);
      return false;
    }
    return true;
  });
  const log = options.logger ?? defaultLogger;
  const ordered = orderByPhase(enabled);
  const baseContext = {
    graph: options.graph,
    snapshot: options.snapshot,
    modulesById: options.modulesById,
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

function hasAnyRequiredHint(interpreter: Interpreter, snapshot: RepositoryFactsSnapshot): boolean {
  if (!interpreter.requiresSemanticHints || interpreter.requiresSemanticHints.length === 0) return true;
  return snapshot.modules.some(mod =>
    interpreter.requiresSemanticHints!.some(key => hasHintKey(mod.semanticHints, key)),
  );
}

function hasRequiredSnapshotFacts(interpreter: Interpreter, snapshot: RepositoryFactsSnapshot): boolean {
  const slots = interpreter.requiresSnapshotFacts;
  if (!slots || slots.length === 0) return true;
  return slots.every(slot => (snapshot[slot]?.length ?? 0) > 0);
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
 * Interpreters in composition-phase order, stable within a phase.
 *
 * The phase is declared, so nothing here reads one interpreter's output to decide when another
 * runs. Within a phase the input order is preserved and carries no meaning: two `links`
 * contributions read the same node set whichever of them the composer reaches first.
 */
function orderByPhase(interpreters: readonly Interpreter[]): Interpreter[] {
  const byId = new Set<string>();
  for (const interpreter of interpreters) {
    if (byId.has(interpreter.id)) throw new Error(`Duplicate interpreter id "${interpreter.id}"`);
    byId.add(interpreter.id);
  }
  return INTERPRETER_PHASES.flatMap(phase => interpreters.filter(entry => entry.phase === phase));
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
