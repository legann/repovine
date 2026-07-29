import { asHostPath, asPkgRelPath } from '@repovine/plugin-sdk';
import { describe, expect, it } from '@jest/globals';
import { computeEngineBuildId, engineBuildMatches, type EngineBuildIdDeps } from '../../../src/stage1/engine-build-id.js';
import { extractOutputFingerprint } from '../../../src/stage1/cache.js';
import type { ModuleInfo, RepositoryFactsSnapshot } from '../../../src/types.js';

describe('engineBuildMatches', () => {
  it('is true in release (current undefined) regardless of stored', () => {
    expect(engineBuildMatches(undefined, undefined)).toBe(true);
    expect(engineBuildMatches('abc', undefined)).toBe(true);
  });
  it('requires equality in dev (current defined)', () => {
    expect(engineBuildMatches('abc', 'abc')).toBe(true);
    expect(engineBuildMatches('old', 'new')).toBe(false);
    expect(engineBuildMatches(undefined, 'new')).toBe(false);
  });
});

describe('computeEngineBuildId', () => {
  const deps = (over: Partial<EngineBuildIdDeps>): EngineBuildIdDeps => ({
    env: {},
    packageRoot: '/engine',
    isGitCheckout: () => false,
    fingerprint: () => 'FP',
    ...over,
  });
  it('is undefined when the package root is unknown', () => {
    expect(computeEngineBuildId(deps({ packageRoot: undefined }))).toBeUndefined();
  });
  it('is undefined in an installed package (no git, no env)', () => {
    expect(computeEngineBuildId(deps({}))).toBeUndefined();
  });
  it('fingerprints when REPOVINE_DEV=1', () => {
    expect(computeEngineBuildId(deps({ env: { REPOVINE_DEV: '1' } }))).toBe('FP');
  });
  it('fingerprints when the engine is a git checkout', () => {
    expect(computeEngineBuildId(deps({ isGitCheckout: () => true }))).toBe('FP');
  });
});

function mod(id: string, contentHash: string): ModuleInfo {
  return {
    id,
    packageName: 'fixture',
    absPath: asHostPath(`/repo/${id}.ts`),
    pkgRelPath: asPkgRelPath(`${id}.ts`),
    contentHash,
    imports: [],
    exports: [],
    sourcePluginId: 'typescript',
  };
}

function snap(modules: ModuleInfo[], analysisVersion = 1): RepositoryFactsSnapshot {
  return { repoRoot: '/repo', timestamp: 'T', analysisVersion, packages: [], modules };
}

describe('extractOutputFingerprint', () => {
  it('is independent of member order', () => {
    const a = snap([mod('a', 'ha'), mod('b', 'hb')]);
    const b = snap([mod('b', 'hb'), mod('a', 'ha')]);
    expect(extractOutputFingerprint(a)).toBe(extractOutputFingerprint(b));
  });
  it('is independent of analysisVersion and engineBuildId', () => {
    const a = snap([mod('a', 'ha')], 1);
    const b: RepositoryFactsSnapshot = { ...snap([mod('a', 'ha')], 2), engineBuildId: 'x' };
    expect(extractOutputFingerprint(a)).toBe(extractOutputFingerprint(b));
  });
  it('changes when an extracted contentHash changes', () => {
    const a = snap([mod('a', 'ha')]);
    const b = snap([mod('a', 'ha2')]);
    expect(extractOutputFingerprint(a)).not.toBe(extractOutputFingerprint(b));
  });
});
