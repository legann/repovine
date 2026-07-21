import { zSemanticHints, type ModuleInfo, type SemanticHints } from '@repovine/plugin-sdk';

/**
 * Single source of truth for honest-empty (L3) checks: the frontend-only `semanticHints` slots a
 * source plugin WITHOUT UI capability (e.g. Python) must never emit. Shared so the list lives in one
 * place instead of being hand-copied per test — a prior copy drifted onto a phantom `frontend` key
 * (vacuously always-undefined) while missing the real `ui` slot.
 *
 * `routes`/`hasRoutes` are intentionally absent: backends legitimately emit backend routes; the law
 * is *frontend* Tier-3 absence. The `satisfies` is IDE-only (test files are not type-checked in CI —
 * tsconfig excludes test/ and ts-jest runs isolatedModules), so the load-bearing phantom guard is the
 * runtime `phantomFrontendHints()` check below, pinned against the versioned hints schema.
 */
export const FRONTEND_ONLY_HINTS = ['ui', 'conditionalRenders', 'ssr'] as const satisfies readonly (keyof SemanticHints)[];

/** Names in FRONTEND_ONLY_HINTS that are NOT real slots of the versioned hints schema. Must be empty;
 * a non-empty result means the list has drifted onto a phantom field. */
export function phantomFrontendHints(): string[] {
  return FRONTEND_ONLY_HINTS.filter(field => !(field in zSemanticHints.shape));
}

/** Descriptive `moduleId.field=value` entries for any frontend-only hint that leaked onto a module.
 * Empty = clean. Pair with a non-vacuity check that some module actually carries semanticHints. */
export function frontendHintLeaks(modules: ModuleInfo[]): string[] {
  return hintLeaks(modules, FRONTEND_ONLY_HINTS);
}

/**
 * AST-provable hint slots: facts a source plugin can emit without any semantic/framework inference
 * (literal env var access, unambiguous effect imports). A pure-library module from a non-inferring
 * plugin may carry these and nothing else.
 */
export const FACT_HINT_SLOTS = ['envVars', 'effectImports'] as const satisfies readonly (keyof SemanticHints)[];

/** Inferred (non-fact) hint slots — every schema slot that is NOT ast-provable. Derived from the
 * versioned schema, so adding a hint slot automatically extends the forbidden set (no hand-list to
 * drift, no phantom possible). A pure-library module from such a plugin must carry none of these. */
export function inferredHintSlots(): string[] {
  const fact = FACT_HINT_SLOTS as readonly string[];
  return Object.keys(zSemanticHints.shape).filter(slot => !fact.includes(slot));
}

/** `moduleId.slot=value` for any inferred (non-fact) hint present on a module. Empty = only
 * ast-provable fact-hints are present. */
export function inferredHintLeaks(modules: ModuleInfo[]): string[] {
  return hintLeaks(modules, inferredHintSlots());
}

function hintLeaks(modules: ModuleInfo[], slots: readonly string[]): string[] {
  const leaks: string[] = [];
  for (const mod of modules) {
    const hints = mod.semanticHints as Record<string, unknown> | undefined;
    if (!hints) continue;
    for (const slot of slots) {
      if (hints[slot] !== undefined) leaks.push(`${mod.id}.${slot}=${JSON.stringify(hints[slot])}`);
    }
  }
  return leaks;
}
