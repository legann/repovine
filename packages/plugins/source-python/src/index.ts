/**
 * `@repovine/plugin-source-python` — the Python source plugin.
 *
 * The package owns the whole ecosystem vertical: `pyproject.toml`/`setup.py` package discovery, the
 * stdlib `ast` subprocess pass, the Python import resolver, and the web-framework route hints a
 * Python module yields. It compiles against `@repovine/plugin-sdk` alone.
 */
import { definePlugin } from '@repovine/plugin-sdk';
import pythonSourcePlugin from './plugin.js';

export { PYTHON_EXTENSIONS } from './extensions.js';
export { pythonSourcePlugin };

/**
 * The package's entry point, in the one shape the host loads.
 *
 * The interpreter prerequisite is lifted to the descriptor: `requires`/`available` are one lifecycle
 * for every capability the package activates, so a missing Python interpreter produces one
 * actionable message rather than a failure per file.
 */
const available = pythonSourcePlugin.available?.bind(pythonSourcePlugin);

export const plugin = definePlugin({
  id: pythonSourcePlugin.id,
  ...(pythonSourcePlugin.requires === undefined ? {} : { requires: pythonSourcePlugin.requires }),
  ...(available === undefined ? {} : { available }),
  capabilities: { source: pythonSourcePlugin },
});

export default plugin;
