import { describe, it, expect } from '@jest/globals';
// Importing bootstrap triggers the side-effect registration once (mirrors IaC bootstrap).
import { bootstrapInternalSourcePlugins } from '../../../src/stage1/source/bootstrap.js';
import { getSourcePlugins, getSourcePlugin } from '../../../src/stage1/source/registry.js';

describe('source plugin bootstrap', () => {
  it('registers the built-in typescript source plugin', () => {
    expect(getSourcePlugin('typescript')).toBeDefined();
    expect(getSourcePlugins().map(p => p.id)).toContain('typescript');
  });

  it('is idempotent — repeated bootstrap does not double-register', () => {
    const before = getSourcePlugins().length;
    bootstrapInternalSourcePlugins();
    bootstrapInternalSourcePlugins();
    expect(getSourcePlugins().length).toBe(before);
    expect(getSourcePlugins().filter(p => p.id === 'typescript')).toHaveLength(1);
  });

  it('typescript plugin declares its package marker and source extensions', () => {
    const p = getSourcePlugin('typescript')!;
    expect(p.packageMarkers).toContain('tsconfig.json');
    expect(p.fileMatch?.extensions).toEqual(
      expect.arrayContaining(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']),
    );
  });

  it('registers the built-in python source plugin', () => {
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
