/**
 * `@repovine/plugin-source-python` — the Python source plugin.
 *
 * The package owns the whole ecosystem vertical: `pyproject.toml`/`setup.py` package discovery, the
 * stdlib `ast` subprocess pass, the Python import resolver, and the web-framework route hints a
 * Python module yields. It compiles against `@repovine/plugin-sdk` alone.
 */
import { PLUGIN_API_VERSION } from '@repovine/plugin-sdk';
import pythonSourcePlugin from './plugin.js';

export { PYTHON_EXTENSIONS } from './extensions.js';
export { pythonSourcePlugin };

export const builtinPluginPackage = Object.freeze({
  packageName: '@repovine/plugin-source-python',
  pluginId: 'python',
  capability: 'source',
  apiVersion: PLUGIN_API_VERSION,
  activation: 'source-plugin',
  sourcePlugin: pythonSourcePlugin,
} as const);

export default builtinPluginPackage;
