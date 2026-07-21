/**
 * Plugin-SDK runtime primitives: the contract version and the graceful-degradation shape.
 *
 * This is a LEAF module — it imports nothing from the engine. Both the contract types
 * (`source-plugin/types.ts`, the IaC descriptor) and the engine orchestrator depend on it, so it
 * must not pull in `src/types` or any other core module (that would create an import cycle through
 * the SDK barrel). Keep it dependency-free.
 */

/**
 * Major version of the plugin contract (fact types + factories + the semanticHints schema).
 * Stamped onto plugins by the `define*` factories. The loader (restored in a later phase) refuses
 * a plugin whose declared major differs from this — the single runtime compatibility gate.
 */
export const PLUGIN_API_VERSION = 1 as const;
export type PluginApiVersion = typeof PLUGIN_API_VERSION;

/**
 * Declarative prerequisites a plugin needs before it can do real work. Absent ⇒ no external
 * prerequisite (the plugin is always applicable). The engine reads this to produce ONE actionable
 * message when a prerequisite is missing instead of N per-file failures — the Python-interpreter
 * lesson generalized.
 */
export interface PluginRequirements {
  /**
   * External runtime/tool the plugin shells out to, e.g. 'python3', 'go'. Informational/diagnostic:
   * the authoritative answer is `available()`, which may probe the real environment.
   */
  runtime?: string;
}

/**
 * Result of a plugin self-probe: whether THIS environment satisfies the plugin's prerequisites.
 * Distinguishes "applicable here, but the toolchain is missing" (`ok:false`, the engine skips the
 * plugin with one warning) from "no matching files" (just an empty contribution, never a warning).
 * This is the formalization of graceful degradation.
 */
export interface PluginAvailability {
  ok: boolean;
  /** Human-readable reason when `ok` is false, e.g. 'python3 not found on PATH'. */
  reason?: string;
}
