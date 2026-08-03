import { describe, it, expect, beforeEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  isExtractModuleLoaded,
  loadExtractModule,
  resetExtractModuleCache,
} from '../../../../packages/plugins/source-typescript/src/lazy-extract.js';

const PLUGIN_ENTRY = path.join('packages', 'plugins', 'source-typescript', 'src', 'plugin.ts');

function resolveEngineRoot(): string {
  const candidates = [
    process.cwd(),
    path.resolve(process.cwd(), 'repovine'),
  ];
  const found = candidates.find((root) => fs.existsSync(path.join(root, PLUGIN_ENTRY)));
  if (!found) throw new Error('repovine engine root not found from test cwd');
  return found;
}

describe('typescript lazy-extract', () => {
  beforeEach(() => {
    resetExtractModuleCache();
  });

  it('reports not-loaded before loadExtractModule is called and loaded after', async () => {
    expect(isExtractModuleLoaded()).toBe(false);
    await loadExtractModule();
    expect(isExtractModuleLoaded()).toBe(true);
  });

  it('loads extract module once and caches it', async () => {
    const first = await loadExtractModule();
    expect(isExtractModuleLoaded()).toBe(true);
    expect(typeof first.extractPackage).toBe('function');

    const second = await loadExtractModule();
    expect(second).toBe(first);
  });
});

describe('typescript plugin entry — no static extract import', () => {
  it('plugin.ts does not statically import ./extract.js', async () => {
    const indexPath = path.join(resolveEngineRoot(), PLUGIN_ENTRY);
    const source = await fs.promises.readFile(indexPath, 'utf-8');
    expect(source).not.toMatch(/from\s+['"]\.\/extract\.js['"]/);
    expect(source).toMatch(/loadExtractModule/);
  });
});
