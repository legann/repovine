const fs = require('node:fs');
const path = require('node:path');
const { runNpm } = require('../scripts/lib/spawn.cjs');

/**
 * The artifacts every test process assumes exist before the first test file loads.
 *
 * `npm run build` starts by deleting them, so a build that reports success without re-emitting
 * leaves the suite reading a tree that is not there. That failure surfaced twice as an `ENOENT` from
 * inside a setup file — a crash with no build in the stack and no output, because the build's own
 * stdout is captured and discarded on success. Naming the artifacts here turns it into one
 * pre-flight error that says which one is missing.
 *
 * `jest.setup.ts` loads the bundled preset, so every plugin package's entry belongs on the list, not
 * just the engine's own output.
 */
function requiredArtifacts(root) {
  const pluginsRoot = path.join(root, 'packages', 'plugins');
  const pluginEntries = fs
    .readdirSync(pluginsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(pluginsRoot, entry.name, 'src')))
    .map(entry => path.join('packages', 'plugins', entry.name, 'dist', 'index.js'));
  return [
    path.join('dist', 'mcp', 'index.js'),
    path.join('dist', 'stage1', 'worker.js'),
    path.join('dist', 'stage2', 'worker.js'),
    path.join('packages', 'plugin-sdk', 'dist', 'index.js'),
    ...pluginEntries,
  ];
}

module.exports = async () => {
  const root = process.cwd();
  const build = runNpm(['run', 'build'], {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (build.status !== 0) {
    throw new Error(`npm run build failed before Jest tests\nSTDOUT:\n${build.stdout}\nSTDERR:\n${build.stderr}`);
  }

  const missing = requiredArtifacts(root).filter(rel => !fs.existsSync(path.join(root, rel)));
  if (missing.length > 0) {
    throw new Error(
      'npm run build reported success but did not emit:\n'
      + missing.map(rel => `  ${rel}`).join('\n')
      + `\nSTDOUT:\n${build.stdout}\nSTDERR:\n${build.stderr}`,
    );
  }
};
