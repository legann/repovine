import type {
  SourceDiscoveryOptions,
  SourceDiscoveryResult,
  SourceExtractInput,
  SourceExtractResult,
  PluginAvailability,
} from '@repovine/plugin-sdk';
import { defineSourcePlugin, resolveDottedPathHandlerToModule } from '@repovine/plugin-sdk';
import { detectPython, discoverPython, PYTHON_EXTENSIONS, PYTHON_PACKAGE_MARKERS } from './discover.js';
import { extractPython, terminateLivePythonChildren } from './extract.js';

/**
 * Built-in source plugin: Python (MVP).
 *
 * Discovery finds `pyproject.toml` / `setup.py` packages and their `.py` files; extraction
 * parses them with the stdlib `ast` module via a `python -c` subprocess. Degrades gracefully:
 * `requires`/`available()` declare the interpreter prerequisite, so the engine skips this plugin
 * with one warning when neither python3 nor python is on PATH — it never throws.
 *
 * Web framework routes (FastAPI decorators, Django urlpatterns) are extracted when ast-provable.
 * TS-only frontend detectors (JSX routes, React architecture) stay empty for Python modules.
 */
const pythonSourcePlugin = defineSourcePlugin({
  id: 'python',
  // Declarative prerequisite: an interpreter that can `import ast`. `available()` is the real probe.
  requires: { runtime: 'python3' },
  available(): PluginAvailability {
    return detectPython()
      ? { ok: true }
      : { ok: false, reason: 'Python interpreter (python3/python) not found on PATH' };
  },
  packageMarkers: PYTHON_PACKAGE_MARKERS,
  fileMatch: { extensions: PYTHON_EXTENSIONS },
  // Owns `.py`; no frontend surfaces (TS-only frontend detectors stay empty by construction).
  // PEP 503: `-` `_` `.` are interchangeable in dist names → looseNameSeparators.
  capabilities: {
    extensions: PYTHON_EXTENSIONS,
    uiSurfaces: false,
    looseNameSeparators: true,
    resolveHandlerToModule: resolveDottedPathHandlerToModule,
  },

  discover(repoRoot: string, options: SourceDiscoveryOptions): SourceDiscoveryResult {
    return discoverPython(repoRoot, options);
  },

  extract(input: SourceExtractInput): Promise<SourceExtractResult> {
    return extractPython(input);
  },

  // The `python -c` AST subprocess is a child of the node process, not the worker thread. On
  // shutdown / build cancel the engine calls this before Worker.terminate() so it is killed and
  // reaped rather than orphaned.
  terminateInFlight(): Promise<void> {
    return terminateLivePythonChildren();
  },
});

/** Python source plugin (built-in, MVP). */
export default pythonSourcePlugin;
