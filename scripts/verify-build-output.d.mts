/**
 * Types for the build's own output check.
 *
 * The build scripts are plain `.mjs` — they run before anything is compiled, so they cannot be
 * TypeScript — and this states their surface for the one TypeScript reader they have, the law that
 * keeps the check from going vacuous.
 */

/** One workspace that compiles TypeScript, with the two directories the check compares. */
export interface CompiledProject {
  name: string;
  srcDir: string;
  outDir: string;
}

export function compiledProjects(root?: string): CompiledProject[];

/** Source modules with no emitted JavaScript beside them, as `"<project>: <relative path>"`. */
export function missingBuildOutput(root?: string): string[];

/** Throws with every missing artifact named. `context` says which command made the promise. */
export function assertBuildOutput(context: string, root?: string): void;
