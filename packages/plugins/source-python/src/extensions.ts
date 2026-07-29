/**
 * The file extensions and layout names the Python source plugin owns, declared once.
 *
 * A leaf module on purpose: discovery, import resolution, and the plugin descriptor all read these,
 * and a constant living beside discovery would make every reader import the subprocess machinery
 * discovery needs.
 */

/** Source form. */
export const PYTHON_EXTENSIONS = ['.py'];

/** Files whose presence makes a directory a package root. */
export const PYTHON_PACKAGE_MARKERS = ['pyproject.toml', 'setup.py'];

/** Basenames that stand for their own directory, for the id mint and the resolve ladder alike. */
export const PYTHON_INDEX_BASENAMES = ['__init__'];
