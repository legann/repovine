import { describe, it, expect, afterEach } from '@jest/globals';
import {
  getKnownExtensions,
  pluginHasUiSurfaces,
  pluginUsesLooseNameSeparators,
  setSourcePluginsForTest,
} from '../../../src/plugin-host/source-set.js';
import type { SourcePlugin } from '@repovine/plugin-sdk';

/** Minimal SourcePlugin stub — the capability helpers only read `id` and `capabilities`. */
function stubPlugin(id: string, capabilities?: SourcePlugin['capabilities']): SourcePlugin {
  return {
    id,
    capabilities,
    discover: () => ({ packages: [], pendingByAbsPath: new Map() }),
    extract: () => ({ deltas: [], reused: 0, rescanned: 0 }),
  };
}

describe('capability helpers — built-in plugins', () => {
  it('getKnownExtensions returns the built-in source extension union', () => {
    // `.vue`/`.svelte` are TypeScript-plugin-owned: discovery reaches them through the SFC walk.
    expect(new Set(getKnownExtensions())).toEqual(
      new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.py']),
    );
  });

  it('pluginHasUiSurfaces: typescript=true, python=false', () => {
    expect(pluginHasUiSurfaces('typescript')).toBe(true);
    expect(pluginHasUiSurfaces('python')).toBe(false);
  });

  it('pluginUsesLooseNameSeparators: python=true, typescript=false', () => {
    expect(pluginUsesLooseNameSeparators('python')).toBe(true);
    expect(pluginUsesLooseNameSeparators('typescript')).toBe(false);
  });
});

describe('capability helpers — logic & defaults', () => {
  // setSourcePluginsForTest returns a restore callback; each test installs+restores its own set.
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it('pluginHasUiSurfaces defaults undefined id to true (legacy TS-default)', () => {
    restore = setSourcePluginsForTest([stubPlugin('py', { extensions: ['.py'] })]);
    expect(pluginHasUiSurfaces(undefined)).toBe(true);
    // unknown / unregistered id → false (capability absent)
    expect(pluginHasUiSurfaces('nope')).toBe(false);
    expect(pluginHasUiSurfaces('py')).toBe(false);
  });

  it('pluginUsesLooseNameSeparators defaults undefined id to false (matches old === python)', () => {
    restore = setSourcePluginsForTest([
      stubPlugin('py', { extensions: ['.py'], looseNameSeparators: true }),
    ]);
    expect(pluginUsesLooseNameSeparators(undefined)).toBe(false);
    expect(pluginUsesLooseNameSeparators('nope')).toBe(false);
    expect(pluginUsesLooseNameSeparators('py')).toBe(true);
  });

  it('getKnownExtensions ignores plugins without capabilities and dedups overlaps', () => {
    restore = setSourcePluginsForTest([
      stubPlugin('a', { extensions: ['.ts', '.tsx'] }),
      stubPlugin('b', { extensions: ['.tsx', '.py'] }), // .tsx overlaps a
      stubPlugin('c'), // no capabilities → contributes nothing (e.g. external fileMatch-only plugin)
    ]);
    expect(new Set(getKnownExtensions())).toEqual(new Set(['.ts', '.tsx', '.py']));
  });
});
