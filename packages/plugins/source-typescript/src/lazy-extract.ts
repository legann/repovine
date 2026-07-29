/**
 * Lazy loader for the TypeScript extract chunk (ts-morph and heavy AST helpers).
 *
 * `typescript/index.ts` must not statically import `./extract.js` so Python-only scans
 * never load ts-morph at runtime. The first TS shard calls `loadExtractModule()` once;
 * subsequent shards reuse the cached promise/module.
 */

type ExtractModule = typeof import('./extract.js');

let extractModulePromise: Promise<ExtractModule> | undefined;
let extractModule: ExtractModule | undefined;

/** Dynamic-import the extract module (cached per process). */
export function loadExtractModule(): Promise<ExtractModule> {
  if (extractModule) return Promise.resolve(extractModule);
  if (!extractModulePromise) {
    extractModulePromise = import('./extract.js').then(mod => {
      extractModule = mod;
      return mod;
    });
  }
  return extractModulePromise;
}

/** True after the extract chunk has been requested (tests / diagnostics). */
export function isExtractModuleLoaded(): boolean {
  return extractModulePromise !== undefined;
}

/** Reset loader state between isolated tests. */
export function resetExtractModuleCache(): void {
  extractModule = undefined;
  extractModulePromise = undefined;
}
