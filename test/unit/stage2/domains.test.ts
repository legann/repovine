/**
 * Tests for loadDomainsConfig — file loading and alias resolution.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { jest } from '@jest/globals';
import { loadDomainsConfig, resolveDomainToCanonical, getPathBasedDomains, evaluateBasenameCandidate, matchFileAsDomain, globToRegex, splitBasename, collectAllDomainTags, packageShortName, matchesInfraResourceExclude } from '../../../src/stage2/domains.js';
import { createEmptyGraph, addNode, addEdge } from '../../../src/graph/index.js';
import type { RepositoryFactsSnapshot, ModuleInfo } from '../../../src/types.js';

describe('loadDomainsConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'domains-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when repovine.domains.json is absent', () => {
    const result = loadDomainsConfig(tmpDir);
    expect(result).toBeNull();
  });

  it('parses valid domains config', () => {
    const config = {
      domains: { auth: { paths: ['src/auth/.*'] } },
    };
    fs.writeFileSync(path.join(tmpDir, 'repovine.domains.json'), JSON.stringify(config));
    const result = loadDomainsConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.domains?.auth?.paths).toEqual(['src/auth/.*']);
  });

  it('builds alias map from domains aliases', () => {
    const config = {
      domains: {
        'infra-k8s': { aliases: ['kubernetes', 'k8s'] },
        auth: { aliases: ['authentication'] },
      },
    };
    fs.writeFileSync(path.join(tmpDir, 'repovine.domains.json'), JSON.stringify(config));
    const result = loadDomainsConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!._aliasToCanonical?.['kubernetes']).toBe('infra-k8s');
    expect(result!._aliasToCanonical?.['k8s']).toBe('infra-k8s');
    expect(result!._aliasToCanonical?.['authentication']).toBe('auth');
  });

  it('returns null for invalid JSON', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    fs.writeFileSync(path.join(tmpDir, 'repovine.domains.json'), '{broken json');
    const result = loadDomainsConfig(tmpDir);
    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('failed to parse'));
    errorSpy.mockRestore();
  });

  it('warns and returns null for invalid domains schema', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    fs.writeFileSync(path.join(tmpDir, 'repovine.domains.json'), JSON.stringify({ patterns: [] }));

    const result = loadDomainsConfig(tmpDir);

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('validation errors'));
    errorSpy.mockRestore();
  });
});

describe('resolveDomainToCanonical', () => {
  it('returns input as-is when config is null', () => {
    expect(resolveDomainToCanonical('auth', null)).toBe('auth');
  });

  it('resolves alias to canonical name', () => {
    const config = {
      _aliasToCanonical: { kubernetes: 'infra-k8s', k8s: 'infra-k8s' },
    } as ReturnType<typeof loadDomainsConfig>;
    expect(resolveDomainToCanonical('kubernetes', config)).toBe('infra-k8s');
    expect(resolveDomainToCanonical('k8s', config)).toBe('infra-k8s');
  });

  it('strips domain: prefix before resolving', () => {
    const config = {
      _aliasToCanonical: { auth: 'auth' },
    } as ReturnType<typeof loadDomainsConfig>;
    expect(resolveDomainToCanonical('domain:auth', config)).toBe('auth');
  });

  it('returns input when no alias matches', () => {
    const config = {
      _aliasToCanonical: { k8s: 'infra-k8s' },
    } as ReturnType<typeof loadDomainsConfig>;
    expect(resolveDomainToCanonical('unknown-domain', config)).toBe('unknown-domain');
  });
});

describe('getPathBasedDomains', () => {
  it('returns first non-structural directory segment', () => {
    expect(getPathBasedDomains('src/auth/session-manager.ts')).toEqual(['auth']);
  });

  it('skips structural directories like src, shared, lib', () => {
    expect(getPathBasedDomains('shared/oauth/client.ts')).toEqual(['oauth']);
    expect(getPathBasedDomains('lib/auth/middleware.ts')).toEqual(['auth']);
  });

  it('ignores file basename — component file does not become its own domain', () => {
    // Previously: ['landing', 'landingaccentstyles']. Now only the directory.
    expect(getPathBasedDomains('src/landing/LandingAccentStyles.tsx')).toEqual(['landing']);
    expect(getPathBasedDomains('src/hooks/useLandingFlow.ts')).toEqual([]);
  });

  it('skips PascalCase directory segments (component groupings, not domain folders)', () => {
    // PascalCase directory like BillingWidget/ is a component grouping
    expect(getPathBasedDomains('platform/billing/BillingWidget/index.ts')).toEqual(['platform', 'billing']);
    expect(getPathBasedDomains('src/BillingWidget/sub-thing.ts')).toEqual([]);
  });

  it('keeps multiple nested directory segments', () => {
    expect(getPathBasedDomains('src/platforms/payments/oauth.ts')).toEqual(['platforms', 'payments']);
  });

  it('returns empty when file lives only in structural dirs', () => {
    expect(getPathBasedDomains('src/utils/format.ts')).toEqual([]);
    expect(getPathBasedDomains('src/index.ts')).toEqual([]);
  });

  it('strips the file extension before considering segments', () => {
    expect(getPathBasedDomains('src/auth/index.tsx')).toEqual(['auth']);
  });

  it('respects extra structural directories from config', () => {
    // Rails-style `app/` should not become a domain
    expect(getPathBasedDomains('app/controllers/users.rb.ts', new Set(['app', 'controllers']))).toEqual([]);
  });
});

describe('splitBasename', () => {
  it('returns stem and suffix when basename has a dot', () => {
    expect(splitBasename('users.controller')).toEqual({ stem: 'users', suffix: 'controller' });
    expect(splitBasename('auth.test')).toEqual({ stem: 'auth', suffix: 'test' });
  });
  it('returns stem only when no dot', () => {
    expect(splitBasename('webhook-handler')).toEqual({ stem: 'webhook-handler' });
  });
  it('rejects leading dot (hidden file with no suffix)', () => {
    expect(splitBasename('.eslintrc')).toEqual({ stem: '.eslintrc' });
  });
});

describe('globToRegex', () => {
  it('matches simple file glob', () => {
    expect(globToRegex('*.ts').test('a.ts')).toBe(true);
    expect(globToRegex('*.ts').test('dir/a.ts')).toBe(false); // * doesn't cross /
  });
  it('matches recursive glob with **', () => {
    expect(globToRegex('**/*.controller.ts').test('src/users/users.controller.ts')).toBe(true);
    expect(globToRegex('**/functions/src/*.ts').test('services/functions/src/webhook-handler.ts')).toBe(true);
  });
  it('escapes regex metacharacters in literal segments', () => {
    expect(globToRegex('a.b.ts').test('a.b.ts')).toBe(true);
    expect(globToRegex('a.b.ts').test('aXb.ts')).toBe(false);
  });
});

describe('evaluateBasenameCandidate — universal JS/TS heuristic', () => {
  function emptyGraph() { return createEmptyGraph(); }

  it('emits PascalCase basenames as low-confidence candidates (downstream → lightweight)', () => {
    // PascalCase no longer hard-rejected: keeps annotations alive but the domain is classified
    // 'lightweight' by collectAllDomainTags because such files almost always have 1-2 modules
    // sharing the slug.
    const g = emptyGraph();
    expect(evaluateBasenameCandidate('src/landing/SiteHeader.tsx', 'mod:x', g)).toMatchObject({ domain: 'siteheader', rejected: false, highConfidence: false });
    expect(evaluateBasenameCandidate('src/BillingWidget.tsx', 'mod:x', g)).toMatchObject({ domain: 'billingwidget', rejected: false, highConfidence: false });
  });

  it('rejects PascalCase basenames when pascalCaseBasename is "reject"', () => {
    const g = emptyGraph();
    const opts = { pascalCaseBasename: 'reject' as const };
    expect(evaluateBasenameCandidate('src/landing/SiteHeader.tsx', 'mod:x', g, undefined, opts))
      .toMatchObject({ rejected: true, highConfidence: false });
    expect(evaluateBasenameCandidate('src/BillingWidget.tsx', 'mod:x', g, undefined, opts))
      .toMatchObject({ rejected: true });
    // Default ('lightweight') still emits the slug, so the opt-in must not leak globally.
    expect(evaluateBasenameCandidate('src/BillingWidget.tsx', 'mod:x', g))
      .toMatchObject({ domain: 'billingwidget', rejected: false });
  });

  it('rejects reserved basenames (index, main, app, _app, ...)', () => {
    const g = emptyGraph();
    expect(evaluateBasenameCandidate('src/index.ts', 'mod:x', g)).toMatchObject({ rejected: true });
    expect(evaluateBasenameCandidate('src/main.tsx', 'mod:x', g)).toMatchObject({ rejected: true });
    expect(evaluateBasenameCandidate('pages/_app.tsx', 'mod:x', g)).toMatchObject({ rejected: true });
    expect(evaluateBasenameCandidate('src/bootstrap.ts', 'mod:x', g)).toMatchObject({ rejected: true });
  });

  it('rejects non-domain suffixes (.test, .spec, .types, .config, .stories)', () => {
    const g = emptyGraph();
    expect(evaluateBasenameCandidate('src/auth.test.ts', 'mod:x', g)).toMatchObject({ rejected: true, highConfidence: true });
    expect(evaluateBasenameCandidate('src/auth.spec.ts', 'mod:x', g)).toMatchObject({ rejected: true });
    expect(evaluateBasenameCandidate('src/auth.types.ts', 'mod:x', g)).toMatchObject({ rejected: true });
    expect(evaluateBasenameCandidate('vite.config.ts', 'mod:x', g)).toMatchObject({ rejected: true });
    expect(evaluateBasenameCandidate('src/Button.stories.tsx', 'mod:x', g)).toMatchObject({ rejected: true });
  });

  it('promotes domain suffixes (.controller, .service, .repository, ...)', () => {
    const g = emptyGraph();
    expect(evaluateBasenameCandidate('src/users/users.controller.ts', 'mod:x', g))
      .toMatchObject({ domain: 'users', rejected: false, highConfidence: true });
    expect(evaluateBasenameCandidate('src/auth.service.ts', 'mod:x', g))
      .toMatchObject({ domain: 'auth', highConfidence: true });
    expect(evaluateBasenameCandidate('src/user.repository.ts', 'mod:x', g))
      .toMatchObject({ domain: 'user', highConfidence: true });
  });

  it('promotes kebab-case basenames flat under structural directories (serverless handler, Next.js api route)', () => {
    const g = emptyGraph();
    addNode(g, { id: 'mod:@acme/api/src/webhook-handler', type: 'module', label: 'webhook-handler', description: '' });
    expect(evaluateBasenameCandidate('apps/api/src/webhook-handler.ts', 'mod:@acme/api/src/webhook-handler', g, '@acme/api'))
      .toMatchObject({ domain: 'webhook-handler', rejected: false });
    expect(evaluateBasenameCandidate('pages/api/users.ts', 'mod:next/users', g))
      .toMatchObject({ domain: 'users', rejected: false });
  });

  it('promotes basename when module is a runtime-resource handler (resource: node -> mod via infra edge)', () => {
    const g = emptyGraph();
    addNode(g, { id: 'mod:x/deep/nested/oauth-callback', type: 'module', label: 'oauth-callback', description: '' });
    addNode(g, { id: 'resource:aws-lambda:OAuthCallbackFunction', type: 'runtime-resource', label: 'OAuthCallback', description: '' });
    addEdge(g, 'resource:aws-lambda:OAuthCallbackFunction', 'mod:x/deep/nested/oauth-callback', 'infra');
    expect(evaluateBasenameCandidate('packages/x/src/deep/nested/oauth-callback.ts', 'mod:x/deep/nested/oauth-callback', g))
      .toMatchObject({ domain: 'oauth-callback', highConfidence: true });
  });

  it('promotes basename when module has >=3 incoming imports', () => {
    const g = emptyGraph();
    const modId = 'mod:x/services/notifier';
    addNode(g, { id: modId, type: 'module', label: 'notifier', description: '' });
    for (let i = 0; i < 3; i++) {
      const importerId = `mod:x/importers/${i}`;
      addNode(g, { id: importerId, type: 'module', label: `i${i}`, description: '' });
      addEdge(g, importerId, modId, 'imports');
    }
    expect(evaluateBasenameCandidate('src/services/notifier.ts', modId, g))
      .toMatchObject({ domain: 'notifier', rejected: false });
  });

  it('rejects deeply-nested kebab-case basename with low connectivity (utility file)', () => {
    const g = emptyGraph();
    const modId = 'mod:x/utils/format-date';
    addNode(g, { id: modId, type: 'module', label: 'format-date', description: '' });
    expect(evaluateBasenameCandidate('src/utils/helpers/format-date.ts', modId, g))
      .toMatchObject({ rejected: true });
  });
});

describe('matchFileAsDomain — config overrides', () => {
  it('returns undefined when config is null or has no compiled basename file overrides', () => {
    expect(matchFileAsDomain('src/x.ts', null)).toBeUndefined();
    expect(matchFileAsDomain('src/x.ts', {})).toBeUndefined();
  });

  it('returns "include" when path matches include globs', () => {
    const cfg = { _fileAsDomainInclude: [globToRegex('**/functions/src/*.ts')] };
    expect(matchFileAsDomain('services/functions/src/webhook-handler.ts', cfg)).toBe('include');
    expect(matchFileAsDomain('packages/other/src/x.ts', cfg)).toBeUndefined();
  });

  it('exclude beats include when both match', () => {
    const cfg = {
      _fileAsDomainInclude: [globToRegex('**/*.ts')],
      _fileAsDomainExclude: [globToRegex('**/*.test.ts')],
    };
    expect(matchFileAsDomain('src/x.test.ts', cfg)).toBe('exclude');
    expect(matchFileAsDomain('src/x.ts', cfg)).toBe('include');
  });
});

describe('collectAllDomainTags — lightweight classification', () => {
  function makeMod(id: string, relPath: string, packageName: string): ModuleInfo {
    return { id, packageName, filePath: `/repo/${relPath}`, relativeFilePath: relPath, contentHash: 'h', imports: [], exports: [] };
  }
  function makeSnapshot(modules: ModuleInfo[]): RepositoryFactsSnapshot {
    return { repoRoot: '/tmp/never-exists', timestamp: '2024-01-01', packages: [], modules };
  }

  it('classifies a 3+ module directory domain as heavy', () => {
    const mods = [
      makeMod('mod:p/src/auth/a', 'src/auth/a.ts', 'p'),
      makeMod('mod:p/src/auth/b', 'src/auth/b.ts', 'p'),
      makeMod('mod:p/src/auth/c', 'src/auth/c.ts', 'p'),
    ];
    const g = createEmptyGraph();
    for (const m of mods) addNode(g, { id: m.id, type: 'module', label: m.id, description: '' });
    const { classification } = collectAllDomainTags(makeSnapshot(mods), g, '/tmp/never-exists');
    expect(classification.get('auth')?.weight).toBe('heavy');
    expect(classification.get('auth')?.count).toBe(3);
  });

  it('classifies a 1-2 module domain as lightweight (not dropped)', () => {
    const mods = [
      makeMod('mod:p/src/billing/a', 'src/billing/a.ts', 'p'),
      makeMod('mod:p/src/billing/b', 'src/billing/b.ts', 'p'),
    ];
    const g = createEmptyGraph();
    for (const m of mods) addNode(g, { id: m.id, type: 'module', label: m.id, description: '' });
    const { classification, tagsByModule } = collectAllDomainTags(makeSnapshot(mods), g, '/tmp/never-exists');
    expect(classification.get('billing')?.weight).toBe('lightweight');
    expect(tagsByModule.get('mod:p/src/billing/a')?.some(t => t.domain === 'billing')).toBe(true);
  });

  it('forces heavy weight when domain is in config domains registry', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'domains-pattern-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'repovine.domains.json'), JSON.stringify({
        domains: { 'declared-tiny': { paths: ['src/tiny/.*\\.ts$'] } },
      }));
      const mods = [makeMod('mod:p/src/tiny/x', 'src/tiny/x.ts', 'p')];
      const g = createEmptyGraph();
      addNode(g, { id: mods[0].id, type: 'module', label: 'x', description: '' });

      const { classification, tagsByModule } = collectAllDomainTags(makeSnapshot(mods), g, tmpDir);

      expect(classification.get('declared-tiny')).toEqual({ count: 1, weight: 'heavy' });
      expect(tagsByModule.get(mods[0].id)).toEqual(
        expect.arrayContaining([{ domain: 'declared-tiny', source: 'pattern' }]),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('PascalCase basename becomes a lightweight domain rather than disappearing', () => {
    const mods = [makeMod('mod:p/src/landing/SiteHeader', 'src/landing/SiteHeader.tsx', 'p')];
    const g = createEmptyGraph();
    addNode(g, { id: mods[0].id, type: 'module', label: 'SiteHeader', description: '' });
    const { classification, tagsByModule } = collectAllDomainTags(makeSnapshot(mods), g, '/tmp/never-exists');
    expect(classification.get('siteheader')?.weight).toBe('lightweight');
    expect(tagsByModule.get(mods[0].id)?.some(t => t.domain === 'siteheader')).toBe(true);
  });
});

describe('loadDomainsConfig — new fields', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'domains-test-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('compiles basename.files.include into regexes', () => {
    const cfg = { basename: { files: { include: ['**/functions/src/*.ts'] } } };
    fs.writeFileSync(path.join(tmpDir, 'repovine.domains.json'), JSON.stringify(cfg));
    const result = loadDomainsConfig(tmpDir);
    expect(result?._fileAsDomainInclude).toHaveLength(1);
    expect(result?._fileAsDomainInclude?.[0].test('services/functions/src/x.ts')).toBe(true);
  });

  it('compiles structuralDirs into a lowercase set', () => {
    const cfg = { structuralDirs: ['App', 'Concerns'] };
    fs.writeFileSync(path.join(tmpDir, 'repovine.domains.json'), JSON.stringify(cfg));
    const result = loadDomainsConfig(tmpDir);
    expect(result?._structuralDirs?.has('app')).toBe(true);
    expect(result?._structuralDirs?.has('concerns')).toBe(true);
  });

  it('preserves infra.excludeSuffixes and excludePatterns verbatim', () => {
    const cfg = {
      infra: {
        excludeSuffixes: ['Alarm', 'LogGroup'],
        excludePatterns: ['^Lambda.*Sg$'],
      },
    };
    fs.writeFileSync(path.join(tmpDir, 'repovine.domains.json'), JSON.stringify(cfg));
    const result = loadDomainsConfig(tmpDir);
    expect(result?.infra?.excludeSuffixes).toEqual(['Alarm', 'LogGroup']);
    expect(result?.infra?.excludePatterns).toEqual(['^Lambda.*Sg$']);
  });
});

describe('packageShortName', () => {
  it('strips npm scope and lowercases', () => {
    expect(packageShortName('@acme/api-functions')).toBe('api-functions');
    expect(packageShortName('@scope/platform-core')).toBe('platform-core');
    expect(packageShortName('@scope/Foo')).toBe('foo');
  });
  it('keeps unscoped names as-is', () => {
    expect(packageShortName('lmtify-public')).toBe('lmtify-public');
    expect(packageShortName('react')).toBe('react');
  });
  it('returns empty for empty input', () => {
    expect(packageShortName('')).toBe('');
  });
});

describe('collectAllDomainTags — package-as-domain', () => {
  function makeMod(id: string, relPath: string, packageName: string): ModuleInfo {
    return { id, packageName, filePath: `/repo/${relPath}`, relativeFilePath: relPath, contentHash: 'h', imports: [], exports: [] };
  }
  function makeSnapshotWithPkgs(modules: ModuleInfo[], packages: { name: string; path: string; version?: string}[]): RepositoryFactsSnapshot {
    return { repoRoot: '/tmp/never-exists', timestamp: '2024-01-01', packages, modules };
  }

  it('creates a heavy package domain when the package has 3+ modules', () => {
    const mods = [
      makeMod('mod:@acme/client-ui/src/a', 'src/a.ts', '@acme/client-ui'),
      makeMod('mod:@acme/client-ui/src/b', 'src/b.ts', '@acme/client-ui'),
      makeMod('mod:@acme/client-ui/src/c', 'src/c.ts', '@acme/client-ui'),
    ];
    const g = createEmptyGraph();
    for (const m of mods) addNode(g, { id: m.id, type: 'module', label: m.id, description: '' });
    const { classification, tagsByModule } = collectAllDomainTags(
      makeSnapshotWithPkgs(mods, [{ name: '@acme/client-ui', path: 'packages/client-ui'}]),
      g,
      '/tmp/never-exists',
    );
    expect(classification.get('client-ui')?.weight).toBe('heavy');
    expect(classification.get('client-ui')?.count).toBe(3);
    // Each module is tagged with the package domain.
    for (const m of mods) {
      expect(tagsByModule.get(m.id)?.some(t => t.domain === 'client-ui' && t.source === 'package')).toBe(true);
    }
  });

  it('classifies a 1-2 module package as lightweight', () => {
    const mods = [makeMod('mod:mcp-server/src/index', 'src/index.ts', '@acme/mcp-server')];
    const g = createEmptyGraph();
    addNode(g, { id: mods[0].id, type: 'module', label: 'x', description: '' });
    const { classification } = collectAllDomainTags(
      makeSnapshotWithPkgs(mods, [{ name: '@acme/mcp-server', path: 'tools/mcp-server'}]),
      g,
      '/tmp/never-exists',
    );
    expect(classification.get('mcp-server')?.weight).toBe('lightweight');
  });

  it('respects exclude in config', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-domain-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'repovine.domains.json'), JSON.stringify({
        packages: { exclude: ['legacy-pkg'] },
      }));
      const mods = [
        makeMod('mod:legacy-pkg/src/a', 'src/a.ts', 'legacy-pkg'),
        makeMod('mod:legacy-pkg/src/b', 'src/b.ts', 'legacy-pkg'),
        makeMod('mod:legacy-pkg/src/c', 'src/c.ts', 'legacy-pkg'),
      ];
      const g = createEmptyGraph();
      for (const m of mods) addNode(g, { id: m.id, type: 'module', label: m.id, description: '' });
      const { classification } = collectAllDomainTags(
        makeSnapshotWithPkgs(mods, [{ name: 'legacy-pkg', path: 'pkg-legacy'}]),
        g,
        tmpDir,
      );
      expect(classification.get('legacy-pkg')).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('applies rename to package short-name', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-domain-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'repovine.domains.json'), JSON.stringify({
        packages: { rename: { 'lmtify-public': 'marketing' } },
      }));
      const mods = [
        makeMod('mod:lmtify-public/src/a', 'src/a.ts', 'lmtify-public'),
        makeMod('mod:lmtify-public/src/b', 'src/b.ts', 'lmtify-public'),
        makeMod('mod:lmtify-public/src/c', 'src/c.ts', 'lmtify-public'),
      ];
      const g = createEmptyGraph();
      for (const m of mods) addNode(g, { id: m.id, type: 'module', label: m.id, description: '' });
      const { classification } = collectAllDomainTags(
        makeSnapshotWithPkgs(mods, [{ name: 'lmtify-public', path: 'lmtify-public'}]),
        g,
        tmpDir,
      );
      expect(classification.get('marketing')).toBeDefined();
      expect(classification.get('lmtify-public')).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('merges multiple packages under one label', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-domain-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'repovine.domains.json'), JSON.stringify({
        packages: { merge: { 'backend': ['api-functions', 'shared-runtime'] } },
      }));
      const mods = [
        makeMod('mod:@x/api-functions/src/a', 'src/a.ts', '@x/api-functions'),
        makeMod('mod:@x/shared-runtime/src/b', 'src/b.ts', '@x/shared-runtime'),
        makeMod('mod:@x/shared-runtime/src/c', 'src/c.ts', '@x/shared-runtime'),
      ];
      const g = createEmptyGraph();
      for (const m of mods) addNode(g, { id: m.id, type: 'module', label: m.id, description: '' });
      const { classification, tagsByModule } = collectAllDomainTags(
        makeSnapshotWithPkgs(mods, [
          { name: '@x/api-functions', path: 'packages/api-functions'},
          { name: '@x/shared-runtime', path: 'packages/shared-runtime'},
        ]),
        g,
        tmpDir,
      );
      // Merged: both packages → "backend" with 3 modules total → heavy
      expect(classification.get('backend')?.count).toBe(3);
      expect(classification.get('backend')?.weight).toBe('heavy');
      // Per-package domains should not exist standalone
      expect(classification.get('api-functions')).toBeUndefined();
      expect(classification.get('shared-runtime')).toBeUndefined();
      for (const m of mods) {
        expect(tagsByModule.get(m.id)?.some(t => t.domain === 'backend')).toBe(true);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips package-domain when enabled is false', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-domain-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'repovine.domains.json'), JSON.stringify({
        packages: { enabled: false },
      }));
      const mods = [
        makeMod('mod:foo/src/a', 'src/a.ts', 'foo'),
        makeMod('mod:foo/src/b', 'src/b.ts', 'foo'),
        makeMod('mod:foo/src/c', 'src/c.ts', 'foo'),
      ];
      const g = createEmptyGraph();
      for (const m of mods) addNode(g, { id: m.id, type: 'module', label: m.id, description: '' });
      const { classification } = collectAllDomainTags(
        makeSnapshotWithPkgs(mods, [{ name: 'foo', path: 'pkg-foo'}]),
        g,
        tmpDir,
      );
      // 'foo' is the package short-name; without package-domain it would not appear
      // (no directory called `foo` in the paths — they live under `pkg-foo` which is non-structural).
      expect(classification.get('foo')).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('matchesInfraResourceExclude — generic resource filter', () => {
  it('matches by suffix', () => {
    expect(matchesInfraResourceExclude('UsersFunctionErrorAlarm', ['Alarm'])).toBe(true);
    expect(matchesInfraResourceExclude('UsersFunctionLogGroup', ['LogGroup', 'Alarm'])).toBe(true);
    expect(matchesInfraResourceExclude('UsersFunction', ['Alarm', 'LogGroup'])).toBe(false);
  });

  it('matches by regex pattern', () => {
    expect(matchesInfraResourceExclude('LambdaPublicSubnet', undefined, ['^Lambda.*Subnet$'])).toBe(true);
    expect(matchesInfraResourceExclude('UsersFunction', undefined, ['^Lambda.*Subnet$'])).toBe(false);
  });

  it('returns false when both lists empty', () => {
    expect(matchesInfraResourceExclude('X', undefined, undefined)).toBe(false);
    expect(matchesInfraResourceExclude('X', [], [])).toBe(false);
  });

  it('tolerates invalid regex without throwing', () => {
    expect(matchesInfraResourceExclude('X', undefined, ['['])).toBe(false);
  });

  it('combines suffix and pattern lists', () => {
    expect(matchesInfraResourceExclude('FooAlarm', ['Alarm'], ['^Lambda.*'])).toBe(true);
    expect(matchesInfraResourceExclude('LambdaSomething', ['Alarm'], ['^Lambda.*'])).toBe(true);
    expect(matchesInfraResourceExclude('PlainBusinessService', ['Alarm'], ['^Lambda.*'])).toBe(false);
  });
});
