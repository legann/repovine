import { describe, expect, it } from '@jest/globals';
import * as path from 'node:path';
import { collectRepositoryFactsAsync, mergeResults, packageJobKey } from '../../src/stage1/index.js';
import type { PackageJobResult } from '../../src/stage1/worker-pool.js';
import type { ModuleInfo, PackageInfo } from '../../src/types.js';
import { findFixturesRoot } from './graph-law-helpers.js';

// Boundary invariant behind infra-runtime-links handler resolution: every package and module in
// the snapshot carries a source-plugin id, so ownership is decided by id equality alone and the
// core needs no language-identity fallback (no `=== 'typescript'`). Paired with honest-empty.test.ts
// (Python), this covers both built-in plugins.
describe('core-laws source-plugin stamping (capability-first boundary)', () => {
  it('stamps every package and module with a source-plugin id (basic-typescript)', async () => {
    const fixtureRoot = path.join(findFixturesRoot(), 'basic-typescript');
    const origLog = console.log;
    console.log = () => {};
    try {
      const snapshot = await collectRepositoryFactsAsync(fixtureRoot);

      expect(snapshot.packages.length).toBeGreaterThan(0);
      expect(snapshot.modules.length).toBeGreaterThan(0);
      // Load-bearing invariant: no undefined owner reaches the snapshot.
      expect(snapshot.packages.every(pkg => pkg.sourcePluginId !== undefined)).toBe(true);
      expect(snapshot.modules.every(mod => mod.sourcePluginId !== undefined)).toBe(true);
      // Fixture-specific: this TS fixture resolves entirely to the typescript plugin.
      expect(snapshot.packages.every(pkg => pkg.sourcePluginId === 'typescript')).toBe(true);
      expect(snapshot.modules.every(mod => mod.sourcePluginId === 'typescript')).toBe(true);
    } finally {
      console.log = origLog;
    }
  });

  it('boundary stamps a module whose source plugin did not self-stamp (mergeResults)', () => {
    // The e2e case above passes because the built-in plugins self-stamp; this isolates the
    // boundary backstop. A forgetful/hypothetical plugin returns a module with no sourcePluginId;
    // the owning package carries the id. mergeResults must stamp the module from the package, so
    // ownership is never undefined downstream — the invariant that lets the core drop its
    // language-identity fallback. Removing the stamp in mergeResults makes this case fail.
    const pkg: PackageInfo = { name: 'app', path: 'apps/app', sourcePluginId: 'fake-lang' };
    const unstamped: ModuleInfo = {
      id: 'mod:app/handler',
      packageName: 'app',
      filePath: '/repo/apps/app/handler.ts',
      relativeFilePath: 'handler.ts',
      contentHash: 'h1',
      imports: [],
      exports: [],
      // intentionally NO sourcePluginId — models a plugin that does not self-stamp
    };
    const result: PackageJobResult = {
      pkgName: 'app',
      jobKey: packageJobKey(pkg),
      shardIndex: 0,
      modules: [unstamped],
      reused: 0,
      rescanned: 0,
    };
    const allModules: ModuleInfo[] = [];

    mergeResults(new Map([[result.jobKey, [result]]]), [pkg], allModules);

    expect(allModules).toHaveLength(1);
    expect(allModules[0].sourcePluginId).toBe('fake-lang');
  });
});
