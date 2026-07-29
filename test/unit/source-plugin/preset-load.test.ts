import { describe, it, expect } from '@jest/globals';
import { getSourcePlugins, getSourcePlugin } from '../../../src/plugin-host/source-set.js';
import { restoreBuiltinPlugins } from '../../helpers/plugins.js';

/**
 * The bundled preset's source half, as the one loading path installs it.
 *
 * Nothing here imports a plugin package: the set under test is whatever loading the preset produced,
 * which is what a build reads.
 */
describe('bundled source plugins', () => {
  it('installs the built-in typescript source plugin', () => {
    expect(getSourcePlugin('typescript')).toBeDefined();
    expect(getSourcePlugins().map(p => p.id)).toContain('typescript');
  });

  it('is idempotent — loading the preset again installs the same set', async () => {
    const before = getSourcePlugins().map(p => p.id);
    await restoreBuiltinPlugins();
    await restoreBuiltinPlugins();
    expect(getSourcePlugins().map(p => p.id)).toEqual(before);
    expect(getSourcePlugins().filter(p => p.id === 'typescript')).toHaveLength(1);
  });

  it('typescript plugin declares its package marker and source extensions', () => {
    const p = getSourcePlugin('typescript')!;
    expect(p.packageMarkers).toContain('tsconfig.json');
    expect(p.fileMatch?.extensions).toEqual(
      expect.arrayContaining(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']),
    );
  });

  it('installs the built-in python source plugin', () => {
    expect(getSourcePlugin('python')).toBeDefined();
    expect(getSourcePlugins().map(p => p.id)).toContain('python');
  });

  it('python plugin declares its package markers and source extensions', () => {
    const p = getSourcePlugin('python')!;
    expect(p.packageMarkers).toEqual(expect.arrayContaining(['pyproject.toml', 'setup.py']));
    expect(p.fileMatch?.extensions).toEqual(expect.arrayContaining(['.py']));
    expect(p.capabilities?.uiSurfaces).toBe(false);
  });
});
