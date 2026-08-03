import { asHostPath } from '@repovine/plugin-sdk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';
import { currentDirLayoutTable } from '../../src/paths.js';
import { getSourcePlugins, setSourcePluginsForTest } from '../../src/plugin-host/source-set.js';
import { defaultPluginsConfig, loadPluginSet } from '../../src/plugin-host/load.js';
import { inspectWorkspaceSupport } from '../../src/cli/init.js';
import { compileScanPatterns } from '../../src/scan-filters.js';
import type { SourcePlugin } from '@repovine/plugin-sdk';

/**
 * Law: what marks a package root is declared once, and discovery reads that declaration.
 *
 * A plugin declares `packageMarkers`, the host resolves them into the per-run layout table, and the
 * producer discovers by what it is handed. Held apart, the declaration is decoration: it can travel
 * into the reuse fingerprint and the preflight report while the producer walks by a private copy,
 * and the two disagree silently — the report predicts packages the build does not find, and a
 * retracted or changed marker changes the hash without changing the graph.
 *
 * Every case below moves the marker away from the spelling the built-in producers were written with,
 * so a producer holding its own copy answers the old question and fails.
 */

function tempTree(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-markers-')));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const tmpRoots: string[] = [];
const restores: Array<() => void> = [];

afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  for (const dir of tmpRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  // A pinned set makes the installed table describe producers this isolate is no longer running.
  await loadPluginSet({ repoRoot: process.cwd(), config: defaultPluginsConfig() });
});

describe('core-laws discovery finds packages by the markers their plugin declared', () => {
  it('hands each loaded plugin its own declared markers, and no other plugin its', () => {
    const table = currentDirLayoutTable();

    // Descriptor and table, compared entry by entry: the table is a resolved copy of the
    // declarations, so an entry that drifted is an entry discovery would act on.
    const fromDescriptors = new Map(
      getSourcePlugins()
        .filter(plugin => (plugin.packageMarkers ?? []).length > 0)
        .map(plugin => [plugin.id, [...(plugin.packageMarkers ?? [])].sort()] as const),
    );
    const fromTable = new Map(
      [...table.packageMarkers].map(([id, markers]) => [id, [...markers].sort()] as const),
    );

    expect(fromTable).toEqual(fromDescriptors);
    // Not vacuous: the bundled set declares markers, so an empty table would be the defect.
    expect(fromTable.size).toBeGreaterThan(0);
  });

  it('discovers a package at the marker the host hands over, not at the one the producer knows', () => {
    // `jsconfig.json` is not a marker any bundled plugin declares, so a producer reading its own copy
    // finds nothing here.
    const root = tempTree({
      'jsconfig.json': '{ "compilerOptions": { "target": "ES2022" }, "include": ["src"] }\n',
      'package.json': '{ "name": "marker-fixture", "version": "1.0.0" }\n',
      'src/index.ts': 'export const ok = 1;\n',
    });
    tmpRoots.push(root);

    const typescript = getSourcePlugins().find(plugin => plugin.id === 'typescript');
    expect(typescript).toBeDefined();

    const discovered = typescript!.discover(asHostPath(root), {
      packageMarkers: ['jsconfig.json'],
      scanPatterns: compileScanPatterns([], []),
    });

    expect(discovered.packages.map(pkg => pkg.name)).toEqual(['marker-fixture']);
  });

  it('finds nothing when the host hands over no marker at all', () => {
    // The reason the option is required rather than defaulted: a producer that fell back to its own
    // list would answer this case as though the host had asked for its list.
    const root = tempTree({
      'tsconfig.json': '{ "compilerOptions": { "target": "ES2022" }, "include": ["src"] }\n',
      'package.json': '{ "name": "no-marker-fixture", "version": "1.0.0" }\n',
      'src/index.ts': 'export const ok = 1;\n',
    });
    tmpRoots.push(root);

    const typescript = getSourcePlugins().find(plugin => plugin.id === 'typescript');
    const discovered = typescript!.discover(asHostPath(root), {
      packageMarkers: [],
      scanPatterns: compileScanPatterns([], []),
    });

    expect(discovered.packages).toEqual([]);
  });

  it('counts the preflight by the same table, for an ecosystem the engine has no name for', async () => {
    const brick: SourcePlugin = {
      id: 'brick',
      apiVersion: 1,
      packageMarkers: ['brick.json'],
      fileMatch: { extensions: ['.brick'] },
      discover: () => ({ packages: [], pendingByAbsPath: new Map() }),
      extract: () => ({ deltas: [], reused: 0, rescanned: 0 }),
    };
    restores.push(setSourcePluginsForTest([brick]));
    // The table is built from the installed set, so the pin has to reach it the way a real load does.
    await loadPluginSet({ repoRoot: process.cwd(), config: defaultPluginsConfig() });

    const root = tempTree({
      'brick.json': '{}\n',
      'lib/brick.json': '{}\n',
    });
    tmpRoots.push(root);

    const inspection = inspectWorkspaceSupport(root);

    expect(inspection.packagesByPlugin).toEqual({ brick: 2 });
  });
});
