import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPluginSet, getActivePluginIds } from '../../src/plugins/load.js';
import { getSourcePlugin } from '../../src/plugins/source-set.js';
import { getParsers } from '../../src/plugins/iac-set.js';
import { catalogTriggerTypeMeta } from '../../src/plugins/declaration-catalog.js';
import type { SourceExtractInput } from '@repovine/plugin-sdk';

// The plugin loader resolves plugins from the ANALYZED repo, validates `package.json#repovine`
// against the SDK manifest schema, checks that the descriptor claims the same id, stamps ownership
// onto declarations, and applies config.plugins.{defaults,add,disable}. These tests exercise the
// registry effects directly.
describe('plugin-loader', () => {
  const tmpRoots: string[] = [];

  function makeRepoWithPlugin(opts: {
    name: string;
    /** The `package.json#repovine` payload, written verbatim. */
    manifest: unknown;
    /** Body of index.js (must `export default` a descriptor). */
    indexJs: string;
    /** Extra files written into the package directory, keyed by relative POSIX path. */
    extraFiles?: Record<string, string>;
  }): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-plugin-test-'));
    tmpRoots.push(repoRoot);
    const pkgDir = path.join(repoRoot, 'node_modules', opts.name);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: opts.name,
        version: '2.3.4',
        type: 'module',
        main: 'index.js',
        repovine: opts.manifest,
      }),
    );
    fs.writeFileSync(path.join(pkgDir, 'index.js'), opts.indexJs);
    for (const [rel, body] of Object.entries(opts.extraFiles ?? {})) {
      const abs = path.join(pkgDir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    return repoRoot;
  }

  const sourceManifest = (id: string, apiVersion: string | number = 1): unknown => ({
    kind: 'plugin',
    id,
    apiVersion,
    entry: 'index.js',
  });

  const SOURCE_PLUGIN_JS = `export default {
    id: 'foo-lang',
    capabilities: {
      source: {
        fileMatch: { extensions: ['.foo'] },
        capabilities: { extensions: ['.foo'] },
        discover() { return { packages: [], pendingByPath: new Map() }; },
        extract() { return { deltas: [], reused: 0, rescanned: 0 }; },
      },
    },
  };`;

  const IAC_PLUGIN_JS = `export default {
    id: 'foo-iac',
    capabilities: {
      iac: { parsers: [{ kind: 'foo-infra', supports() { return false; }, parse() { return null; } }] },
    },
  };`;

  // extract() emits one well-formed delta and one structurally-broken delta (moduleId is a number,
  // imports is a string) — the wrap must drop the broken one and keep the valid one.
  const MIXED_DELTA_SOURCE_JS = `export default {
    id: 'mixed-lang',
    capabilities: {
      source: {
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
      },
    },
  };`;

  // parse() returns a non-null but structurally-broken infra delta (resources is a string, not an
  // array) — the wrap must coerce it to null ("no match").
  const BROKEN_PARSER_IAC_JS = `export default {
    id: 'broken-iac',
    capabilities: {
      iac: {
        parsers: [{
          kind: 'broken-infra',
          supports() { return true; },
          parse() { return { kind: 'broken-infra', resources: 'not-an-array' }; },
        }],
      },
    },
  };`;

  afterEach(async () => {
    // Restore the built-in baseline so later suites see an un-polluted registry.
    await loadPluginSet({ repoRoot: process.cwd(), config: { defaults: true, add: [], disable: [] } });
    for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolves + registers a source capability from the analyzed repo', async () => {
    const repoRoot = makeRepoWithPlugin({ name: 'repovine-plugin-foo', manifest: sourceManifest('foo-lang'), indexJs: SOURCE_PLUGIN_JS });
    const report = await loadPluginSet({ repoRoot, config: { defaults: true, add: ['repovine-plugin-foo'], disable: [] } });

    expect(report.refused).toEqual([]);
    // The report lists every plugin this build loaded, bundled and installed alike; the assertion
    // is about the one the config added.
    const external = report.loaded.filter(entry => entry.name === 'repovine-plugin-foo');
    expect(external).toHaveLength(1);
    expect(external[0]).toMatchObject({
      name: 'repovine-plugin-foo',
      version: '2.3.4',
      id: 'foo-lang',
      capabilities: ['source'],
    });
    expect(getActivePluginIds().source).toContain('foo-lang');
    // Bundled preset is still present alongside the external plugin.
    expect(getActivePluginIds().source).toContain('typescript');
  });

  it('registers an IaC capability', async () => {
    const repoRoot = makeRepoWithPlugin({ name: 'repovine-plugin-iac', manifest: sourceManifest('foo-iac'), indexJs: IAC_PLUGIN_JS });
    const report = await loadPluginSet({ repoRoot, config: { defaults: true, add: ['repovine-plugin-iac'], disable: [] } });

    const external = report.loaded.filter(entry => entry.name === 'repovine-plugin-iac');
    expect(external.map(l => l.id)).toEqual(['foo-iac']);
    expect(external[0]!.capabilities).toEqual(['iac']);
    expect(getActivePluginIds().iac).toContain('foo-iac');
    expect(getActivePluginIds().source).not.toContain('foo-iac');
  });

  it('reports every capability one descriptor declares', async () => {
    const repoRoot = makeRepoWithPlugin({
      name: 'repovine-plugin-wide',
      manifest: sourceManifest('wide'),
      indexJs: `export default {
        id: 'wide',
        capabilities: {
          source: {
            discover() { return { packages: [], pendingByPath: new Map() }; },
            extract() { return { deltas: [], reused: 0, rescanned: 0 }; },
          },
          iac: { parsers: [{ kind: 'wide-infra', supports() { return false; }, parse() { return null; } }] },
          loaders: [{ id: 'wide-json', load() { return []; } }],
          projectors: [{ id: 'wide-projector', project() { return []; } }],
        },
      };`,
    });
    const report = await loadPluginSet({ repoRoot, config: { defaults: false, add: ['repovine-plugin-wide'], disable: [] } });

    expect(report.refused).toEqual([]);
    expect(report.loaded[0]!.capabilities).toEqual(['source', 'iac', 'loaders', 'projectors']);
  });

  it('stamps package ownership onto the declarations it accepts', async () => {
    const repoRoot = makeRepoWithPlugin({
      name: 'repovine-plugin-declaring',
      manifest: {
        kind: 'plugin',
        id: 'declaring',
        apiVersion: 1,
        entry: 'index.js',
        declarations: {
          ecosystem: 'edge',
          dirs: [{ name: '.edge-out', role: 'tool-output', because: 'edge build artifacts' }],
          triggerTypes: [{ type: 'edge-http', namespace: 'edge', provider: 'edge', entrypointKind: 'api' }],
        },
      },
      indexJs: IAC_PLUGIN_JS.replace("'foo-iac'", "'declaring'").replace('foo-infra', 'edge-infra'),
    });
    const report = await loadPluginSet({ repoRoot, config: { defaults: false, add: ['repovine-plugin-declaring'], disable: [] } });

    expect(report.refused).toEqual([]);
    const declarations = report.loaded[0]!.declarations;
    expect(declarations.ecosystem).toBe('edge');
    expect(declarations.dirs[0]).toMatchObject({
      name: '.edge-out',
      role: 'tool-output',
      declaredBy: { pluginId: 'declaring', packageName: 'repovine-plugin-declaring', packageVersion: '2.3.4' },
    });
    // Declared trigger metadata reaches the per-run catalog that projects entrypoints. There is no
    // process-global metadata registry for it to leak into: the catalog is the only reader.
    expect(catalogTriggerTypeMeta(report.runtime.catalog, { type: 'edge-http', namespace: 'edge', provider: 'edge' }))
      .toEqual({ entrypointKind: 'api' });
  });

  it('refuses a manifest whose declaration claims its own owner', async () => {
    const repoRoot = makeRepoWithPlugin({
      name: 'repovine-plugin-forger',
      manifest: {
        kind: 'plugin',
        id: 'forger',
        apiVersion: 1,
        entry: 'index.js',
        declarations: {
          dirs: [{
            name: '.forged',
            role: 'tool-output',
            because: 'claims another owner',
            declaredBy: { pluginId: 'typescript', packageName: 'x', packageVersion: '1' },
          }],
        },
      },
      indexJs: SOURCE_PLUGIN_JS.replace("'foo-lang'", "'forger'"),
    });
    const report = await loadPluginSet({ repoRoot, config: { defaults: false, add: ['repovine-plugin-forger'], disable: [] } });

    expect(report.loaded).toEqual([]);
    expect(report.refused[0]!.reason).toMatch(/declaredBy/);
  });

  it('refuses a plugin whose apiVersion is incompatible with the SDK major', async () => {
    const repoRoot = makeRepoWithPlugin({ name: 'repovine-plugin-future', manifest: sourceManifest('foo-lang', '2'), indexJs: SOURCE_PLUGIN_JS });
    const report = await loadPluginSet({ repoRoot, config: { defaults: false, add: ['repovine-plugin-future'], disable: [] } });

    expect(report.loaded).toEqual([]);
    expect(report.refused).toHaveLength(1);
    expect(report.refused[0]!.reason).toMatch(/apiVersion/);
    expect(getActivePluginIds().source).not.toContain('foo-lang');
  });

  it('refuses a manifest that is not the single plugin transport kind', async () => {
    const repoRoot = makeRepoWithPlugin({
      name: 'repovine-plugin-oldkind',
      manifest: { kind: 'source-plugin', id: 'foo-lang', apiVersion: 1, entry: 'index.js' },
      indexJs: SOURCE_PLUGIN_JS,
    });
    const report = await loadPluginSet({ repoRoot, config: { defaults: false, add: ['repovine-plugin-oldkind'], disable: [] } });

    expect(report.loaded).toEqual([]);
    expect(report.refused[0]!.reason).toMatch(/kind/);
  });

  it('refuses a descriptor that claims a different id than the manifest', async () => {
    const repoRoot = makeRepoWithPlugin({
      name: 'repovine-plugin-liar',
      manifest: sourceManifest('declared-id'),
      indexJs: SOURCE_PLUGIN_JS,
    });
    const report = await loadPluginSet({ repoRoot, config: { defaults: false, add: ['repovine-plugin-liar'], disable: [] } });

    expect(report.loaded).toEqual([]);
    expect(report.refused[0]!.reason).toMatch(/does not match manifest id/);
    expect(getActivePluginIds().source).not.toContain('foo-lang');
  });

  it('refuses an entry that escapes the plugin package directory', async () => {
    const repoRoot = makeRepoWithPlugin({
      name: 'repovine-plugin-escape',
      manifest: { kind: 'plugin', id: 'escape', apiVersion: 1, entry: '../outside/index.js' },
      indexJs: SOURCE_PLUGIN_JS,
    });
    fs.mkdirSync(path.join(repoRoot, 'node_modules', 'outside'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'node_modules', 'outside', 'index.js'), SOURCE_PLUGIN_JS);

    const report = await loadPluginSet({ repoRoot, config: { defaults: false, add: ['repovine-plugin-escape'], disable: [] } });
    expect(report.loaded).toEqual([]);
    expect(report.refused[0]!.reason).toMatch(/".." segment/);
  });

  it('refuses a package whose main escapes the package directory', async () => {
    // `main` is npm's field and keeps npm's spelling rules, so the manifest parser never sees it.
    // Containment is checked on the resolved path, which is what makes that safe.
    const repoRoot = makeRepoWithPlugin({
      name: 'repovine-plugin-main-escape',
      manifest: { kind: 'plugin', id: 'main-escape', apiVersion: 1 },
      indexJs: SOURCE_PLUGIN_JS,
    });
    const pkgJson = path.join(repoRoot, 'node_modules', 'repovine-plugin-main-escape', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf-8')) as Record<string, unknown>;
    fs.writeFileSync(pkgJson, JSON.stringify({ ...pkg, main: '../outside/index.js' }));
    fs.mkdirSync(path.join(repoRoot, 'node_modules', 'outside'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'node_modules', 'outside', 'index.js'), SOURCE_PLUGIN_JS);

    const report = await loadPluginSet({ repoRoot, config: { defaults: false, add: ['repovine-plugin-main-escape'], disable: [] } });
    expect(report.loaded).toEqual([]);
    expect(report.refused[0]!.reason).toMatch(/outside the plugin package directory/);
  });

  it('refuses an entry spelled with a Windows separator', async () => {
    const repoRoot = makeRepoWithPlugin({
      name: 'repovine-plugin-winpath',
      manifest: { kind: 'plugin', id: 'winpath', apiVersion: 1, entry: 'lib\\index.js' },
      indexJs: SOURCE_PLUGIN_JS,
      extraFiles: { 'lib/index.js': SOURCE_PLUGIN_JS },
    });
    const report = await loadPluginSet({ repoRoot, config: { defaults: false, add: ['repovine-plugin-winpath'], disable: [] } });
    expect(report.loaded).toEqual([]);
    expect(report.refused[0]!.reason).toMatch(/POSIX path/);
  });

  it('refuses a descriptor that declares no capability', async () => {
    const repoRoot = makeRepoWithPlugin({
      name: 'repovine-plugin-empty',
      manifest: sourceManifest('empty'),
      indexJs: `export default { id: 'empty', capabilities: {} };`,
    });
    const report = await loadPluginSet({ repoRoot, config: { defaults: false, add: ['repovine-plugin-empty'], disable: [] } });
    expect(report.loaded).toEqual([]);
    expect(report.refused[0]!.reason).toMatch(/no capability/);
  });

  it('records a refusal (not a throw) when the named package is not installed', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-plugin-test-'));
    tmpRoots.push(repoRoot);
    const report = await loadPluginSet({ repoRoot, config: { defaults: false, add: ['repovine-plugin-missing'], disable: [] } });
    expect(report.loaded).toEqual([]);
    expect(report.refused).toHaveLength(1);
  });

  it('disable removes a bundled plugin by id', async () => {
    const report = await loadPluginSet({ repoRoot: process.cwd(), config: { defaults: true, add: [], disable: ['python'] } });
    expect(report.disabled).toContain('python');
    expect(getActivePluginIds().source).not.toContain('python');
    expect(getActivePluginIds().source).toContain('typescript');
  });

  it('defaults:false drops the entire bundled preset, leaving only added externals', async () => {
    const repoRoot = makeRepoWithPlugin({ name: 'repovine-plugin-foo', manifest: sourceManifest('foo-lang'), indexJs: SOURCE_PLUGIN_JS });
    const report = await loadPluginSet({ repoRoot, config: { defaults: false, add: ['repovine-plugin-foo'], disable: [] } });

    expect(report.defaultsOff).toBe(true);
    expect(getActivePluginIds().source).toEqual(['foo-lang']);
    expect(getActivePluginIds().iac).toEqual([]);
  });

  it('drops a structurally-broken module delta emitted by an untrusted source capability', async () => {
    const repoRoot = makeRepoWithPlugin({ name: 'repovine-plugin-mixed', manifest: sourceManifest('mixed-lang'), indexJs: MIXED_DELTA_SOURCE_JS });
    const report = await loadPluginSet({ repoRoot, config: { defaults: false, add: ['repovine-plugin-mixed'], disable: [] } });
    expect(report.loaded.map(l => l.id)).toEqual(['mixed-lang']);

    // The registered plugin is the Zod-wrapped one. Run its extract and confirm only the valid
    // delta survives — the broken one (moduleId:42, imports:'nope') never reaches the assembled facts.
    const plugin = getSourcePlugin('mixed-lang');
    expect(plugin).toBeDefined();
    const result = await plugin!.extract({} as unknown as SourceExtractInput);
    expect(result.deltas.map(d => d.moduleId)).toEqual(['mix:good']);
  });

  it('drops (→ null) a structurally-broken infra delta emitted by an untrusted IaC parser', async () => {
    const repoRoot = makeRepoWithPlugin({ name: 'repovine-plugin-broken-iac', manifest: sourceManifest('broken-iac'), indexJs: BROKEN_PARSER_IAC_JS });
    const report = await loadPluginSet({ repoRoot, config: { defaults: false, add: ['repovine-plugin-broken-iac'], disable: [] } });
    expect(report.loaded.map(l => l.id)).toEqual(['broken-iac']);

    // The registered parser is the Zod-wrapped one. Its parse returns a non-null broken delta; the
    // wrap must coerce that to null so no malformed infra facts enter the graph.
    const parser = getParsers().find(p => p.kind === 'broken-infra');
    expect(parser).toBeDefined();
    const out = parser!.parse('/repo/infra.yml', 'infra.yml', {});
    expect(out).toBeNull();
  });

  it('is idempotent — applying the same config twice does not double-register', async () => {
    const repoRoot = makeRepoWithPlugin({ name: 'repovine-plugin-foo', manifest: sourceManifest('foo-lang'), indexJs: SOURCE_PLUGIN_JS });
    const cfg = { defaults: true, add: ['repovine-plugin-foo'], disable: [] };
    await loadPluginSet({ repoRoot, config: cfg });
    await loadPluginSet({ repoRoot, config: cfg });
    const fooCount = getActivePluginIds().source.filter(id => id === 'foo-lang').length;
    expect(fooCount).toBe(1);
  });
});
