import { computeExtractionConfigFingerprint } from '../../../src/stage1/extraction-config-fingerprint.js';
import { currentDirLayoutTable } from '../../../src/paths.js';
import { installDirLayoutTable } from '@repovine/plugin-sdk/internal';
import type { DirLayoutTable, SourcePlugin } from '@repovine/plugin-sdk';

function plugin(id: string): SourcePlugin {
  return {
    id,
    apiVersion: 1,
    fileMatch: { extensions: ['.ts'] },
    capabilities: { extensions: ['.ts'], uiSurfaces: true },
  } as unknown as SourcePlugin;
}

/** Run one fingerprint under a layout table, then put the isolate's own table back. */
function underLayout(table: DirLayoutTable, run: () => string): string {
  const previous = currentDirLayoutTable();
  installDirLayoutTable(table);
  try {
    return run();
  } finally {
    installDirLayoutTable(previous);
  }
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

  it('changes with the layout table the build walked by', () => {
    // Where the walk stopped and what marked a package root both decide which modules exist, so a
    // snapshot taken under one table must not be reused under another. The fingerprint reads the
    // INSTALLED table rather than the plugin object, which is what discovery read too.
    const base = currentDirLayoutTable();
    const withExtraPrune: DirLayoutTable = { ...base, pruned: new Set([...base.pruned, 'generated']) };
    const withOtherMarker: DirLayoutTable = {
      ...base,
      packageMarkers: new Map([...base.packageMarkers, ['typescript', ['jsconfig.json']]]),
    };
    const withCondition: DirLayoutTable = {
      ...base,
      prunedWhenContains: new Map([...base.prunedWhenContains, ['dist', ['.keep']]]),
    };

    const plain = fingerprint();
    expect(underLayout(withExtraPrune, () => fingerprint())).not.toBe(plain);
    expect(underLayout(withOtherMarker, () => fingerprint())).not.toBe(plain);
    expect(underLayout(withCondition, () => fingerprint())).not.toBe(plain);
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
