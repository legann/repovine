/**
 * Loader for the shipped client hook dispatcher.
 *
 * The dispatcher is a standalone ESM file (`repovine-client-dispatcher.mjs`)
 * copied verbatim into client hook directories by `setup` and into plugin
 * bundles by the renderer. The `.mjs` extension keeps it ESM in every consumer
 * repository regardless of the repository's `package.json` type. The URL-based
 * read resolves next to this module in both `src/` (tests) and `dist/`
 * (runtime); the build copies the `.mjs` into `dist/cli/dispatcher/`.
 */
import fs from 'node:fs';

/** File name of the dispatcher in every client hooks directory and plugin bundle. */
export const CLIENT_DISPATCHER_FILENAME = 'repovine-client-dispatcher.mjs';

/** Dispatcher source bytes (LF), read from the file shipped beside this module. */
export function readClientDispatcherSource(): string {
  return fs.readFileSync(new URL(`./${CLIENT_DISPATCHER_FILENAME}`, import.meta.url), 'utf-8');
}
