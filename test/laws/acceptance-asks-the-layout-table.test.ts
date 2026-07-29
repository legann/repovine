import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { setSourcePluginsForTest } from '../../src/plugin-host/source-set.js';
import { defaultPluginsConfig, loadPluginSet } from '../../src/plugin-host/load.js';
import { compileScanPatterns, shouldScanInfraPath, shouldScanSourcePath } from '../../src/scan-filters.js';
import type { PendingModuleDraft, SourcePlugin } from '@repovine/plugin-sdk';

/**
 * Law: the acceptance filter answers by the same table the walk stops at.
 *
 * The walk and the post-discovery filter used to ask different lists — the walk asked the pruned
 * names and the test-layout names, the filter asked the pruned names alone. A producer that reported
 * a path without walking to it therefore got files into the graph that every other producer left
 * out, and the same repository projected differently depending on which plugin found a file first.
 *
 * Measured with a producer that reports a path it never walked, because no bundled producer does:
 * all of them consult the walk predicate, so the gap is invisible from inside the default set and a
 * green build proves nothing about it.
 */

function tempTree(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-acceptance-')));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

/** A producer that reports two files by name, having consulted nothing. */
function reportingPlugin(relPaths: readonly string[]): SourcePlugin {
  return {
    id: 'reporter',
    apiVersion: 1,
    packageMarkers: ['reporter.json'],
    fileMatch: { extensions: ['.rp'] },
    capabilities: { extensions: ['.rp'] },
    discover(repoRoot: string) {
      const pkg = { name: 'reported', path: '.', sourcePluginId: 'reporter' };
      const pendingByPath = new Map<string, PendingModuleDraft>();
      for (const relPath of relPaths) {
        const filePath = path.join(repoRoot, relPath);
        pendingByPath.set(filePath, { filePath, pkg, relPath, sourcePluginId: 'reporter' });
      }
      return { packages: [pkg], pendingByPath };
    },
    // A delta per pending module: the engine assembles `ModuleInfo` from what extract returns, so a
    // producer that reported files and extracted nothing would leave the graph empty for a reason
    // that has nothing to do with the filter under test.
    extract: input => ({
      deltas: input.pendingModules.map(pending => ({ moduleId: pending.moduleId, imports: [], exports: [] })),
      reused: 0,
      rescanned: input.pendingModules.length,
    }),
  };
}

const tmpRoots: string[] = [];
const restores: Array<() => void> = [];

afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  for (const dir of tmpRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  await loadPluginSet({ repoRoot: process.cwd(), config: defaultPluginsConfig() });
});

describe('core-laws acceptance and the walk answer from one table', () => {
  it('refuses a reported path under a test-layout directory, and keeps the one beside it', async () => {
    const root = tempTree({
      'reporter.json': '{}\n',
      'src/kept.rp': 'kept\n',
      'tests/hidden.rp': 'hidden\n',
    });
    tmpRoots.push(root);

    restores.push(setSourcePluginsForTest([reportingPlugin(['src/kept.rp', 'tests/hidden.rp'])]));

    const origLog = console.log;
    console.log = () => {};
    let snapshot;
    try {
      snapshot = await collectRepositoryFactsAsync(root);
    } finally {
      console.log = origLog;
    }

    // The kept file proves the producer ran and its output reaches the graph, so the missing one is
    // a verdict rather than an empty pass.
    expect(snapshot.modules.map(mod => mod.relativeFilePath).sort()).toEqual(['src/kept.rp']);
  }, 120_000);

  it('states the same verdict for both scopes as a property of the path', () => {
    const patterns = compileScanPatterns([], []);

    expect(shouldScanSourcePath('src/app.ts', patterns)).toBe(true);
    expect(shouldScanSourcePath('tests/app.ts', patterns)).toBe(false);
    expect(shouldScanSourcePath('pkg/__tests__/app.ts', patterns)).toBe(false);

    // Infra reads the same table: an IaC file under a test-layout directory is a fixture, and one
    // scope accepting what the other refuses is the disagreement this law closes.
    expect(shouldScanInfraPath('infra/main.tf', patterns)).toBe(true);
    expect(shouldScanInfraPath('tests/main.tf', patterns)).toBe(false);
    expect(shouldScanInfraPath('pkg/e2e/template.yaml', patterns)).toBe(false);
  });

  it('does not let scan.include reopen what the layout table closed', () => {
    // An include pattern narrows what is indexed inside the walked tree; it cannot name a file the
    // walk never reached, and answering otherwise would make acceptance disagree with the walk again.
    const patterns = compileScanPatterns(['tests/**', 'node_modules/**'], []);

    expect(shouldScanSourcePath('tests/app.ts', patterns)).toBe(false);
    expect(shouldScanSourcePath('node_modules/pkg/index.ts', patterns)).toBe(false);
  });
});
