import { compileScanPatterns, shouldScanInfraPath, shouldScanSourcePath } from '../../src/scan-filters.js';

describe('scan-filters', () => {
  it('include wins over exclude for source paths', () => {
    const patterns = compileScanPatterns(
      ['packages/generated/keep.ts'],
      ['packages/generated/**'],
    );
    expect(shouldScanSourcePath('packages/generated/keep.ts', patterns)).toBe(true);
    expect(shouldScanSourcePath('packages/generated/other.ts', patterns)).toBe(false);
  });

  it('includes explicit .d.ts paths', () => {
    const patterns = compileScanPatterns(['types/globals.d.ts'], []);
    expect(shouldScanSourcePath('types/globals.d.ts', patterns)).toBe(true);
    expect(shouldScanSourcePath('types/other.d.ts', patterns)).toBe(false);
  });

  it('honors infra-only exclude scope', () => {
    const patterns = compileScanPatterns(
      [],
      [{ path: 'infra/sam/template.yaml', scope: 'infra' }],
    );
    expect(shouldScanInfraPath('infra/sam/template.yaml', patterns)).toBe(false);
    expect(shouldScanSourcePath('infra/sam/template.yaml', patterns)).toBe(true);
  });

  it('always skips engine-owned dependency, build, and cache directories', () => {
    const patterns = compileScanPatterns([], []);
    const ignoredPaths = [
      '.repovine/graph.json',
      'node_modules/pkg/index.js',
      'packages/web/node_modules/pkg/index.js',
      'dist/index.js',
      'dist-bundled/server.js',
      'target/generated/app.js',
      'build/output.js',
      'out/server.js',
      'coverage/lcov.info',
      '.next/server/app.js',
      '.venv/lib/python/site-packages/pkg/module.py',
    ];

    for (const relPath of ignoredPaths) {
      expect(shouldScanSourcePath(relPath, patterns)).toBe(false);
      expect(shouldScanInfraPath(relPath, patterns)).toBe(false);
    }
  });

  it('does not let explicit include override engine-owned ignored directories', () => {
    const patterns = compileScanPatterns(
      [
        'node_modules/pkg/index.js',
        'dist/index.js',
        { path: 'target/generated/template.yaml', scope: 'infra' },
      ],
      [],
    );

    expect(shouldScanSourcePath('node_modules/pkg/index.js', patterns)).toBe(false);
    expect(shouldScanSourcePath('dist/index.js', patterns)).toBe(false);
    expect(shouldScanInfraPath('target/generated/template.yaml', patterns)).toBe(false);
  });

  it('matches engine ignores by path segment, not by substring', () => {
    const patterns = compileScanPatterns([], []);

    expect(shouldScanSourcePath('src/node_modulesish/index.ts', patterns)).toBe(true);
    expect(shouldScanSourcePath('src/distillery/index.ts', patterns)).toBe(true);
    expect(shouldScanSourcePath('src/targeted/index.ts', patterns)).toBe(true);
  });
});
