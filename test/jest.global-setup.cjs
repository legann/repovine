const { runNpm } = require('../scripts/lib/spawn.cjs');

/**
 * The build every test process runs against.
 *
 * Tests execute TypeScript from `src/` through ts-jest, but the plugin set, both worker scripts and
 * the packed-artifact checks read `dist/`. So the suite builds first, and it builds unconditionally
 * by default: a green run against yesterday's `dist` is the one outcome a test suite must not be
 * able to produce.
 *
 * `REPOVINE_SKIP_BUILD=1` skips the build for a caller who just built — a focused re-run, or a
 * mutation harness driving many test invocations over one tree. It is an explicit statement by the
 * caller, never a heuristic: deciding by timestamps would silently certify stale code the one time
 * the clock, a checkout or an editor disagreed. Nothing in CI sets it.
 *
 * The artifact check runs either way. `npm run build` makes the same check itself — one
 * implementation, in `scripts/verify-build-output.mjs` — so a skip against a tree that was never
 * built fails here by name instead of as an `ENOENT` from the middle of a run.
 */
module.exports = async () => {
  const root = process.cwd();
  const skipBuild = process.env.REPOVINE_SKIP_BUILD === '1';

  let build;
  if (!skipBuild) {
    build = runNpm(['run', 'build'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
    if (build.status !== 0) {
      throw new Error(`npm run build failed before Jest tests\nSTDOUT:\n${build.stdout}\nSTDERR:\n${build.stderr}`);
    }
  }

  const { assertBuildOutput } = await import('../scripts/verify-build-output.mjs');
  try {
    assertBuildOutput(skipBuild ? 'REPOVINE_SKIP_BUILD=1 was set and the existing tree' : 'npm run build', root);
  } catch (error) {
    throw new Error(
      skipBuild
        ? `${error.message}\nThe build was skipped by REPOVINE_SKIP_BUILD=1; unset it to build here.`
        : `${error.message}\nSTDOUT:\n${build.stdout}\nSTDERR:\n${build.stderr}`,
    );
  }
};
