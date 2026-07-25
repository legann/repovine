import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { applyPluginConfig } from '../../src/stage1/plugin-loader.js';

// An external source plugin, installed in the analyzed repo and listed in config.plugins.add, flows
// end-to-end through the WHOLE Stage-1 pipeline (loader → discovery → engine extraction boundary)
// and produces a real module fact — with the engine stamping mechanical metadata and forcing inline
// extraction because the plugin is not in worker isolates.
describe('external source plugin — full Stage-1 pipeline', () => {
  let repoRoot: string;

  // A working source plugin authored as plain ESM (exactly what a third-party would publish):
  // discover finds `*.foo` files at the repo root and reports drafts WITHOUT ids; extract emits one
  // semantic delta per file, keyed by the id the engine minted.
  const PLUGIN_JS = `import * as fs from 'node:fs';
import * as path from 'node:path';
export default {
  id: 'foo-lang',
  apiVersion: 1,
  fileMatch: { extensions: ['.foo'] },
  capabilities: {
    extensions: ['.foo'],
    // Ecosystem facts only; the engine mints \`mod:<pkg>/<path>\` from them.
    moduleIdNormalize: { stripSuffixes: ['.foo'] },
  },
  discover(repoRoot) {
    const pkg = { name: 'foo-pkg', path: '.', sourcePluginId: 'foo-lang' };
    const pendingByPath = new Map();
    for (const entry of fs.readdirSync(repoRoot)) {
      if (entry.endsWith('.foo')) {
        const filePath = path.join(repoRoot, entry);
        pendingByPath.set(filePath, {
          filePath, pkg, relPath: entry,
          sourcePluginId: 'foo-lang',
        });
      }
    }
    return { packages: [pkg], pendingByPath };
  },
  extract(input) {
    const deltas = input.pendingModules.map(pm => ({
      moduleId: pm.moduleId, imports: [], exports: [],
      semanticHints: { webFramework: 'fooframework' },
    }));
    return { deltas, reused: 0, rescanned: deltas.length };
  },
};`;

  afterEach(async () => {
    await applyPluginConfig({ repoRoot: process.cwd(), config: { defaults: true, add: [], disable: [] } });
    if (repoRoot) fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('loads, discovers, and extracts a module from an external plugin', async () => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-ext-e2e-'));
    const pkgDir = path.join(repoRoot, 'node_modules', 'repovine-plugin-foo');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'repovine-plugin-foo', type: 'module', main: 'index.js', repovine: { kind: 'source-plugin', apiVersion: '1', entry: 'index.js' } }),
    );
    fs.writeFileSync(path.join(pkgDir, 'index.js'), PLUGIN_JS);
    fs.writeFileSync(path.join(repoRoot, 'app.foo'), 'unit foo app\n');

    const origLog = console.log;
    console.log = () => {};
    try {
      const snapshot = await collectRepositoryFactsAsync(repoRoot, {
        plugins: { defaults: true, add: ['repovine-plugin-foo'], disable: [] },
        maxPackageWorkers: 1,
      });
      const fooMod = snapshot.modules.find(m => m.id === 'mod:foo-pkg/app');
      expect(fooMod).toBeDefined();
      // Engine-stamped mechanics the plugin never set.
      expect(fooMod!.sourcePluginId).toBe('foo-lang');
      expect(fooMod!.contentHash).toMatch(/^[0-9a-f]{16}$/);
      expect(path.isAbsolute(fooMod!.filePath)).toBe(true);
      // Plugin-emitted semantic fact survived end to end.
      expect(fooMod!.semanticHints?.webFramework).toBe('fooframework');
    } finally {
      console.log = origLog;
    }
  });
});
