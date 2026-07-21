import { computeExtractionConfigFingerprint } from '../../../src/stage1/extraction-config-fingerprint.js';
import type { SourcePlugin } from '@repovine/plugin-sdk';

function plugin(id: string): SourcePlugin {
  return {
    id,
    apiVersion: 1,
    packageMarkers: ['tsconfig.json'],
    fileMatch: { extensions: ['.ts'] },
    capabilities: { extensions: ['.ts'], uiSurfaces: true },
  } as unknown as SourcePlugin;
}

function fingerprint(overrides: Partial<Parameters<typeof computeExtractionConfigFingerprint>[0]> = {}): string {
  return computeExtractionConfigFingerprint({
    repoRoot: '/repo',
    scanInclude: ['src/**'],
    scanExclude: ['dist/**'],
    sourcePlugins: [plugin('typescript')],
    iacPluginIds: ['terraform'],
    extractContextByPlugin: new Map([
      ['typescript', new Map([['app', { baseUrl: '/repo', paths: { '@/*': ['src/*'] } }]])],
    ]),
    ...overrides,
  });
}

describe('extraction config fingerprint', () => {
  it('changes with compiler options, scan patterns, and active plugin identities', () => {
    const base = fingerprint();
    expect(fingerprint({
      extractContextByPlugin: new Map([
        ['typescript', new Map([['app', { baseUrl: '/repo', paths: { '#/*': ['lib/*'] } }]])],
      ]),
    })).not.toBe(base);
    expect(fingerprint({ scanInclude: ['lib/**'] })).not.toBe(base);
    expect(fingerprint({ sourcePlugins: [plugin('python')] })).not.toBe(base);
    expect(fingerprint({ iacPluginIds: ['kubernetes'] })).not.toBe(base);
  });

  it('normalizes repo-root paths embedded in compiler options', () => {
    const first = fingerprint();
    const moved = computeExtractionConfigFingerprint({
      repoRoot: '/worktree',
      scanInclude: ['src/**'],
      scanExclude: ['dist/**'],
      sourcePlugins: [plugin('typescript')],
      iacPluginIds: ['terraform'],
      extractContextByPlugin: new Map([
        ['typescript', new Map([['app', { baseUrl: '/worktree', paths: { '@/*': ['src/*'] } }]])],
      ]),
    });
    expect(moved).toBe(first);
  });
});
