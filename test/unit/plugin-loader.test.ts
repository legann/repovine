import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyPluginConfig, getActivePluginIds } from '../../src/stage1/plugin-loader.js';
import { getSourcePlugin } from '../../src/stage1/source/registry.js';
import { getParsers } from '../../src/stage1/iac/registry.js';
import type { SourceExtractInput } from '@repovine/plugin-sdk';
import '../../src/stage1/source/bootstrap.js';
import '../../src/stage1/iac/bootstrap.js';

// The external-plugin loader resolves third-party plugins from the ANALYZED repo, gates on
// apiVersion, validates untrusted output, and applies config.plugins.{defaults,add,disable}. These
// tests exercise the registry effects directly.
describe('plugin-loader (external plugin loading)', () => {
  const tmpRoots: string[] = [];

  function makeRepoWithPlugin(opts: {
    name: string;
    kind: 'source-plugin' | 'iac-plugin';
    apiVersion: string;
    /** Body of index.js (must `export default` a plugin/descriptor). */
    indexJs: string;
  }): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-plugin-test-'));
    tmpRoots.push(repoRoot);
    const pkgDir = path.join(repoRoot, 'node_modules', opts.name);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: opts.name,
        type: 'module',
        main: 'index.js',
        repovine: { kind: opts.kind, apiVersion: opts.apiVersion, entry: 'index.js' },
      }),
    );
    fs.writeFileSync(path.join(pkgDir, 'index.js'), opts.indexJs);
    return repoRoot;
  }

  const SOURCE_PLUGIN_JS = `export default {
    id: 'foo-lang',
    apiVersion: 1,
    fileMatch: { extensions: ['.foo'] },
    capabilities: { extensions: ['.foo'] },
    discover() { return { packages: [], pendingByPath: new Map() }; },
    extract() { return { deltas: [], reused: 0, rescanned: 0 }; },
  };`;

  const IAC_PLUGIN_JS = `export default {
    id: 'foo-iac',
    apiVersion: 1,
    parsers: [{ kind: 'foo-infra', supports() { return false; }, parse() { return null; } }],
    kindDomains: [{ kind: 'foo-infra', meta: { domainId: 'domain:infra-foo', label: 'infra-foo', description: 'foo' } }],
  };`;

  // extract() emits one well-formed delta and one structurally-broken delta (moduleId is a number,
  // imports is a string) — the wrap must drop the broken one and keep the valid one.
  const MIXED_DELTA_SOURCE_JS = `export default {
    id: 'mixed-lang',
    apiVersion: 1,
    fileMatch: { extensions: ['.mix'] },
    capabilities: { extensions: ['.mix'] },
    discover() { return { packages: [], pendingByPath: new Map() }; },
    extract() {
      return {
        deltas: [
          { moduleId: 'mix:good', imports: [], exports: [] },
          { moduleId: 42, imports: 'nope' },
        ],
        reused: 0,
        rescanned: 0,
      };
    },
  };`;

  // parse() returns a non-null but structurally-broken infra delta (resources is a string, not an
  // array) — the wrap must coerce it to null ("no match").
  const BROKEN_PARSER_IAC_JS = `export default {
    id: 'broken-iac',
    apiVersion: 1,
    parsers: [{ kind: 'broken-infra', supports() { return true; }, parse() { return { kind: 'broken-infra', resources: 'not-an-array' }; } }],
    kindDomains: [{ kind: 'broken-infra', meta: { domainId: 'domain:infra-broken', label: 'infra-broken', description: 'broken' } }],
  };`;

  afterEach(async () => {
    // Restore the built-in baseline so later suites see an un-polluted registry.
    await applyPluginConfig({ repoRoot: process.cwd(), config: { defaults: true, add: [], disable: [] } });
    for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolves + registers an external source plugin from the analyzed repo', async () => {
    const repoRoot = makeRepoWithPlugin({ name: 'repovine-plugin-foo', kind: 'source-plugin', apiVersion: '1', indexJs: SOURCE_PLUGIN_JS });
    const report = await applyPluginConfig({ repoRoot, config: { defaults: true, add: ['repovine-plugin-foo'], disable: [] } });

    expect(report.loaded).toEqual([{ name: 'repovine-plugin-foo', id: 'foo-lang', kind: 'source-plugin' }]);
    expect(report.refused).toEqual([]);
    expect(report.externalSourceIds.has('foo-lang')).toBe(true);
    expect(getActivePluginIds().source).toContain('foo-lang');
    // Bundled preset is still present alongside the external plugin.
    expect(getActivePluginIds().source).toContain('typescript');
  });

  it('registers an external IaC plugin descriptor', async () => {
    const repoRoot = makeRepoWithPlugin({ name: 'repovine-plugin-iac', kind: 'iac-plugin', apiVersion: '1', indexJs: IAC_PLUGIN_JS });
    const report = await applyPluginConfig({ repoRoot, config: { defaults: true, add: ['repovine-plugin-iac'], disable: [] } });

    expect(report.loaded.map(l => l.id)).toEqual(['foo-iac']);
    expect(getActivePluginIds().iac).toContain('foo-iac');
    // External IaC plugin is not a source plugin → does not force inline extraction.
    expect(report.externalSourceIds.size).toBe(0);
  });

  it('refuses a plugin whose apiVersion is incompatible with the SDK major', async () => {
    const repoRoot = makeRepoWithPlugin({ name: 'repovine-plugin-future', kind: 'source-plugin', apiVersion: '2', indexJs: SOURCE_PLUGIN_JS });
    const report = await applyPluginConfig({ repoRoot, config: { defaults: true, add: ['repovine-plugin-future'], disable: [] } });

    expect(report.loaded).toEqual([]);
    expect(report.refused).toHaveLength(1);
    expect(report.refused[0]!.reason).toMatch(/apiVersion/);
    expect(getActivePluginIds().source).not.toContain('foo-lang');
  });

  it('records a refusal (not a throw) when the named package is not installed', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-plugin-test-'));
    tmpRoots.push(repoRoot);
    const report = await applyPluginConfig({ repoRoot, config: { defaults: true, add: ['repovine-plugin-missing'], disable: [] } });
    expect(report.loaded).toEqual([]);
    expect(report.refused).toHaveLength(1);
  });

  it('disable removes a bundled plugin by id', async () => {
    const report = await applyPluginConfig({ repoRoot: process.cwd(), config: { defaults: true, add: [], disable: ['python'] } });
    expect(report.disabled).toContain('python');
    expect(getActivePluginIds().source).not.toContain('python');
    expect(getActivePluginIds().source).toContain('typescript');
  });

  it('defaults:false drops the entire bundled preset, leaving only added externals', async () => {
    const repoRoot = makeRepoWithPlugin({ name: 'repovine-plugin-foo', kind: 'source-plugin', apiVersion: '1', indexJs: SOURCE_PLUGIN_JS });
    const report = await applyPluginConfig({ repoRoot, config: { defaults: false, add: ['repovine-plugin-foo'], disable: [] } });

    expect(report.defaultsOff).toBe(true);
    expect(getActivePluginIds().source).toEqual(['foo-lang']);
    expect(getActivePluginIds().iac).toEqual([]);
  });

  it('drops a structurally-broken module delta emitted by an untrusted source plugin', async () => {
    const repoRoot = makeRepoWithPlugin({ name: 'repovine-plugin-mixed', kind: 'source-plugin', apiVersion: '1', indexJs: MIXED_DELTA_SOURCE_JS });
    const report = await applyPluginConfig({ repoRoot, config: { defaults: true, add: ['repovine-plugin-mixed'], disable: [] } });
    expect(report.loaded.map(l => l.id)).toEqual(['mixed-lang']);

    // The registered plugin is the Zod-wrapped one. Run its extract and confirm only the valid
    // delta survives — the broken one (moduleId:42, imports:'nope') never reaches the assembled facts.
    const plugin = getSourcePlugin('mixed-lang');
    expect(plugin).toBeDefined();
    const result = await plugin!.extract({} as unknown as SourceExtractInput);
    expect(result.deltas.map(d => d.moduleId)).toEqual(['mix:good']);
  });

  it('drops (→ null) a structurally-broken infra delta emitted by an untrusted IaC parser', async () => {
    const repoRoot = makeRepoWithPlugin({ name: 'repovine-plugin-broken-iac', kind: 'iac-plugin', apiVersion: '1', indexJs: BROKEN_PARSER_IAC_JS });
    const report = await applyPluginConfig({ repoRoot, config: { defaults: true, add: ['repovine-plugin-broken-iac'], disable: [] } });
    expect(report.loaded.map(l => l.id)).toEqual(['broken-iac']);

    // The registered parser is the Zod-wrapped one. Its parse returns a non-null broken delta; the
    // wrap must coerce that to null so no malformed infra facts enter the graph.
    const parser = getParsers().find(p => p.kind === 'broken-infra');
    expect(parser).toBeDefined();
    const out = parser!.parse('/repo/infra.yml', 'infra.yml', {});
    expect(out).toBeNull();
  });

  it('is idempotent — applying the same config twice does not double-register', async () => {
    const repoRoot = makeRepoWithPlugin({ name: 'repovine-plugin-foo', kind: 'source-plugin', apiVersion: '1', indexJs: SOURCE_PLUGIN_JS });
    const cfg = { defaults: true, add: ['repovine-plugin-foo'], disable: [] };
    await applyPluginConfig({ repoRoot, config: cfg });
    await applyPluginConfig({ repoRoot, config: cfg });
    const fooCount = getActivePluginIds().source.filter(id => id === 'foo-lang').length;
    expect(fooCount).toBe(1);
  });
});
