import { describe, it, expect } from '@jest/globals';
import { shouldSkipRepoRelativePath } from '../../../../packages/plugins/source-typescript/src/discover.js';

describe('shouldSkipRepoRelativePath — build-output / dependency subtrees are skipped', () => {
  it('skips dependency and build-output dirs (incl. target/build/out/coverage)', () => {
    for (const p of [
      'node_modules/lodash/index.ts',
      'vendor/github.com/pkg/errors/errors.go',
      'services/api/vendor/dep/dep.ts',
      'dist/main.js',
      'dist-bundled/x.js',
      'target/types/case.d.ts',
      'packages/web/target/x.ts',
      'build/index.js',
      'out/app.js',
      'coverage/lcov.ts',
      '.next/server/app.js',
      '.cache/ts/file.ts',
      'src/__tests__/helper.ts',
      'src/__mocks__/service.ts',
      'e2e/login.ts',
      'playwright/setup.ts',
    ]) {
      expect(shouldSkipRepoRelativePath(p)).toBe(true);
    }
  });

  // One isolating path per name in the map below: each path is skipped ONLY because of the name it
  // is keyed by, so a red case names the name that stopped being pruned.
  //
  // The map is a hand-written subset of the pruned set. Coverage of the whole set — the engine
  // ignore list plus the test-layout directories — is a build-level law in
  // test/laws/pruning-composition-net.test.ts, which puts a directory on disk for every name and
  // asserts none of them mints a module.
  it('skips a path under each directory name listed here', () => {
    const perAlternative: Record<string, string> = {
      dist: 'dist/main.js',
      'dist-bundled': 'dist-bundled/x.js',
      target: 'target/types/case.d.ts',
      build: 'build/index.js',
      out: 'out/app.js',
      coverage: 'coverage/lcov.ts',
      node_modules: 'node_modules/lodash/index.ts',
      '.next': '.next/server/app.js',
      '.repovine': '.repovine/graph-dump.ts',
      __tests__: 'src/__tests__/helper.ts',
      __mocks__: 'src/__mocks__/service.ts',
      __snapshots__: 'src/__snapshots__/foo.snap.ts',
      '.cache': '.cache/ts/file.ts',
      test: 'src/test/helper.ts',
      tests: 'src/tests/helper.ts',
      e2e: 'e2e/login.ts',
      cypress: 'cypress/integration/spec.ts',
      playwright: 'playwright/setup.ts',
      __e2e__: 'src/__e2e__/flow.ts',
    };
    for (const [alt, p] of Object.entries(perAlternative)) {
      expect([alt, shouldSkipRepoRelativePath(p)]).toEqual([alt, true]);
    }
  });

  it('does not skip ordinary source or lookalike segment names', () => {
    for (const p of [
      'src/app/page.tsx',
      'packages/web/src/foo.ts',
      'src/output/builder.ts', // 'output' is not the 'out' segment
      'src/buildbot/runner.ts', // 'buildbot' is not 'build'
      'src/targeting/aim.ts', // 'targeting' is not 'target'
      'src/contest/winner.ts', // 'contest' is not 'test'
      'src/latest/client.ts', // 'latest' is not 'test'
      'src/playwrighting/tool.ts', // 'playwrighting' is not 'playwright'
    ]) {
      expect(shouldSkipRepoRelativePath(p)).toBe(false);
    }
  });
});
