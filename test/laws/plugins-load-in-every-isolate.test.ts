import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IaCParser } from '@repovine/plugin-sdk';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import {
  getActiveIaCPluginIds,
  getInfraKindDomain,
  getParsers,
  installIaCPlugins,
  type ActiveIaCPlugin,
} from '../../src/plugin-host/iac-set.js';
import { restoreBuiltinPlugins } from '../helpers/plugins.js';

/**
 * Law: a plugin set is loaded, never inherited.
 *
 * Every isolate that runs plugin code reconstructs the set from the serialisable spec — the control
 * plane from `config.plugins`, the Stage 1 pool from `workerData.pluginSpec`, the Stage 2 worker
 * from `snapshot.plugins`. The two downgrades this replaces were invisible: an external source
 * plugin silently ran on the main thread, and a build with projectors silently composed inline.
 * Both produced correct output, which is exactly why neither had a test — the cost was in where the
 * work ran, not in what it produced.
 *
 * This law makes the location observable: the extraction runs in a worker isolate, and the isolate
 * carries a plugin that only the analyzed repository knows about.
 */
describe('core-laws every isolate loads its own plugin set', () => {
  const tmpRoots: string[] = [];

  afterEach(async () => {
    for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    await restoreBuiltinPlugins();
  });

  /**
   * A repository with an installed source plugin and two packages written in its language.
   *
   * Two packages, because the pool never spins up more workers than there are jobs: a one-package
   * fixture would extract inline and the law would pass without ever crossing the boundary it is
   * about.
   */
  function repoWithInstalledSourcePlugin(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-isolate-law-'));
    tmpRoots.push(repoRoot);
    const pkgDir = path.join(repoRoot, 'node_modules', 'repovine-plugin-brick');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: 'repovine-plugin-brick',
      version: '1.0.0',
      type: 'module',
      main: 'index.js',
      repovine: { kind: 'plugin', id: 'brick', apiVersion: 1, entry: 'index.js' },
    }));
    // The producer walks the two package directories itself, so nothing about `.brick` is known to
    // the engine — the isolate that extracts has to be the one that loaded this package.
    fs.writeFileSync(path.join(pkgDir, 'index.js'), `
      import * as fs from 'node:fs';
      import * as path from 'node:path';

      // A package whose entry finishes after the pool has already dispatched. Loading is async and a
      // message can arrive first, so an isolate that took a job before its load settled would report
      // a missing extractor for a plugin the build has.
      await new Promise(resolve => setTimeout(resolve, 250));

      const PACKAGES = ['alpha', 'beta'];

      export default {
        id: 'brick',
        capabilities: {
          source: {
            packageMarkers: ['brick.json'],
            fileMatch: { extensions: ['.brick'] },
            capabilities: { extensions: ['.brick'], moduleIdNormalize: { stripSuffixes: ['.brick'] } },
            discover(repoRoot) {
              const packages = [];
              const pendingByAbsPath = new Map();
              for (const name of PACKAGES) {
                const dir = path.join(repoRoot, name);
                if (!fs.existsSync(dir)) continue;
                packages.push({ name, repoRelDir: name, sourcePluginId: 'brick' });
                for (const entry of fs.readdirSync(dir).sort()) {
                  if (!entry.endsWith('.brick')) continue;
                  const absPath = path.join(dir, entry);
                  pendingByAbsPath.set(absPath, {
                    absPath,
                    pkgRelPath: entry,
                    pkg: { name, repoRelDir: name, sourcePluginId: 'brick' },
                    sourcePluginId: 'brick',
                  });
                }
              }
              return { packages, pendingByAbsPath };
            },
            extract(input) {
              return {
                deltas: input.pendingModules.map(pending => ({
                  moduleId: pending.moduleId,
                  imports: [],
                  exports: [{
                    name: 'brick',
                    kind: 'const',
                    isDefault: false,
                    lineRange: { start: 1, end: 1 },
                  }],
                })),
                reused: 0,
                rescanned: input.pendingModules.length,
              };
            },
          },
        },
      };
    `);
    for (const name of ['alpha', 'beta']) {
      fs.mkdirSync(path.join(repoRoot, name), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, name, 'brick.json'), '{}\n');
      fs.writeFileSync(path.join(repoRoot, name, 'main.brick'), `brick ${name}\n`);
    }
    return repoRoot;
  }

  it('installs a set whole rather than merging it with the last one', async () => {
    // Resource identity dedupes within a file, so a parser that kept parsing after its plugin left
    // the config produces the same ids and stays invisible in the graph. What it changes is which
    // plugins answer, which is what this reads.
    const parserOf = (kind: string): IaCParser => ({
      kind,
      loaderId: 'yaml',
      supports: () => false,
      parse: () => null,
    });
    const first: ActiveIaCPlugin = {
      id: 'first',
      parsers: [parserOf('first-kind')],
      kindDomains: [{ kind: 'first-kind', meta: { domainId: 'domain:infra-first', label: 'infra-first', description: 'first' } }],
    };
    const second: ActiveIaCPlugin = { id: 'second', parsers: [parserOf('second-kind')] };

    installIaCPlugins([first]);
    installIaCPlugins([second]);

    expect(getActiveIaCPluginIds()).toEqual(['second']);
    expect(getParsers().map(parser => parser.kind)).toEqual(['second-kind']);
    // Kind domains go with the plugin that declared them: the derived fallback answers once the
    // declaring package is out of the set.
    expect(getInfraKindDomain('first-kind').domainId).toBe('domain:infra-first-kind');
  });

  it('extracts an installed source plugin inside the Stage 1 worker pool', async () => {
    const repoRoot = repoWithInstalledSourcePlugin();

    const snapshot = await collectRepositoryFactsAsync(repoRoot, {
      // Two workers against two package jobs: the pool is used, so the extractor has to exist in an
      // isolate that never imported it. Under the pre-boundary path this call extracted inline.
      maxPackageWorkers: 2,
      plugins: { defaults: false, add: ['repovine-plugin-brick'], disable: [] },
    });

    expect(snapshot.buildRefusals ?? []).toEqual([]);
    expect(snapshot.packages.map(pkg => pkg.name).sort()).toEqual(['alpha', 'beta']);
    expect(snapshot.modules.map(mod => mod.id).sort())
      .toEqual(['mod:alpha/main', 'mod:beta/main']);
    // The delta the producer emitted survived the isolate boundary, so the extractor really ran
    // there rather than the engine minting empty modules.
    expect(snapshot.modules.every(mod => mod.exports.some(exp => exp.name === 'brick'))).toBe(true);
    // The spec rides on the snapshot: it is what the Stage 2 worker reconstructs the set from.
    expect(snapshot.plugins).toEqual({ defaults: false, add: ['repovine-plugin-brick'], disable: [] });
  });
});
