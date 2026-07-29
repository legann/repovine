import { describe, it, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getSourcePlugins } from '../../../../src/stage1/source/registry.js';
import { isExtractModuleLoaded } from '../../../../packages/plugins/source-typescript/src/lazy-extract.js';
import { detectPython } from '../../../../packages/plugins/source-python/src/discover.js';
import '../../../../src/stage1/source/bootstrap.js';

function findFixture(): string {
  const candidates = [
    path.resolve(process.cwd(), 'test', 'fixtures', 'basic-python'),
    path.resolve(process.cwd(), 'repovine', 'test', 'fixtures', 'basic-python'),
  ];
  const root = candidates.find(c => fs.existsSync(c));
  if (!root) throw new Error(`Could not find basic-python fixture. Tried: ${candidates.join(', ')}`);
  return root;
}

const PYTHON_AVAILABLE = detectPython() !== null;
const d = PYTHON_AVAILABLE ? describe : describe.skip;

d('python-only discovery does not load the TypeScript extract chunk', () => {
  it('discovers only python pending modules and leaves lazy extract unloaded in this process', () => {
    const repoRoot = findFixture();
    const packages = [];
    const pendingByPath = new Map<string, import('../../../../src/types.js').PendingModuleDraft>();

    for (const plugin of getSourcePlugins()) {
      const { packages: found, pendingByPath: pending } = plugin.discover(repoRoot, {});
      packages.push(...found);
      for (const [fp, pm] of pending) pendingByPath.set(fp, pm);
    }

    // Guard against vacuous .every() passes on empty discovery: the fixture must
    // yield at least one python package and one pending module.
    expect(packages.length).toBeGreaterThan(0);
    expect(pendingByPath.size).toBeGreaterThan(0);

    expect(packages.every(p => p.sourcePluginId === 'python')).toBe(true);
    expect([...pendingByPath.values()].every(pm => pm.sourcePluginId === 'python')).toBe(true);
    expect(isExtractModuleLoaded()).toBe(false);
  });
});
