import { jest } from '@jest/globals';
import * as actualFs from 'node:fs';

/**
 * Graph node order follows discovery order, so an unsorted `readdirSync` makes the projection a
 * property of the host filesystem. NTFS collates `[`, `(` and `+` after letters; a code-unit
 * comparison puts them before. The sveltekit fixture carries all three shapes, so the same
 * repository projected differently on Windows and Linux until discovery sorted explicitly.
 *
 * Asserting sorted output alone would not catch a regression here: this filesystem already hands
 * back sorted entries, so the assertion passes with or without the fix. The guard therefore forces
 * the hostile order — every directory read in reverse — and requires discovery to correct it.
 */
describe('law: discovery order does not depend on filesystem enumeration order', () => {
  it('yields the same module order when the host enumerates directories in reverse', async () => {
    jest.resetModules();
    jest.unstable_mockModule('node:fs', () => ({
      ...actualFs,
      default: actualFs,
      readdirSync: ((dir: string, options?: unknown) => {
        const entries = (actualFs.readdirSync as (d: string, o?: unknown) => unknown[])(dir, options);
        return [...entries].reverse();
      }),
    }));

    const { readDirSorted } = await import('../../src/fs/read-dir-sorted.js');
    const names = readDirSorted('test/fixtures/sveltekit/src/routes').map(e => e.name);

    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    // The bracketed and parenthesised route segments are the ones NTFS orders differently; pin them
    // so a future comparator swap (e.g. localeCompare) is caught rather than silently accepted.
    expect(names.indexOf('(marketing)')).toBeLessThan(names.indexOf('api'));
    expect(names.indexOf('[[lang]]')).toBeLessThan(names.indexOf('api'));
    expect(names.indexOf('+page.svelte')).toBeLessThan(names.indexOf('[[lang]]'));
  });
});
