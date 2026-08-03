import type { ModuleInfo } from '../../../types.js';

/** name → module ids whose forward calls include that exact call-string. */
export type CallersByName = Map<string, Set<string>>;

const cache = new WeakMap<Map<string, ModuleInfo>, CallersByName>();

function build(modulesById: Map<string, ModuleInfo>): CallersByName {
  const index: CallersByName = new Map();
  const add = (name: string, modId: string): void => {
    let set = index.get(name);
    if (!set) { set = new Set(); index.set(name, set); }
    set.add(modId);
  };
  for (const mod of modulesById.values()) {
    for (const exp of mod.exports) {
      if (!exp.calls) continue;
      for (const name of exp.calls) add(name, mod.id);
    }
    if (mod.calls) for (const name of mod.calls) add(name, mod.id);
  }
  return index;
}

/**
 * Reverse-calls-by-name index: union of every module's per-export calls (`ExportInfo.calls`) and
 * module-level calls (`ModuleInfo.calls`), inverted to `name → callers`. Grep-parity — matching by
 * call name needs no import resolution, so it surfaces callers across package barrels that the
 * resolved import edges miss.
 *
 * Built once per `modulesById` identity and memoized on a WeakMap: a state rebuild produces a fresh
 * map identity, so the next call rebuilds and the old index is garbage-collected. Derived, not
 * duplicated per node.
 */
export function getCallersByName(modulesById: Map<string, ModuleInfo>): CallersByName {
  let index = cache.get(modulesById);
  if (!index) { index = build(modulesById); cache.set(modulesById, index); }
  return index;
}

/** Module ids that call `name` (exact call-string match). Empty when none. */
export function callersOfName(modulesById: Map<string, ModuleInfo>, name: string): string[] {
  return [...(getCallersByName(modulesById).get(name) ?? [])];
}
