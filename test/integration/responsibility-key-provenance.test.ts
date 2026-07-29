/**
 * Invariant: a responsibility key never carries a file extension or an ecosystem's package marker.
 *
 * The key reaches the agent inside a finding id and title — `duplicate-like:init-py`, "Several
 * modules appear to own similar \"init-py\" responsibility". Unlike a domain label, the key is
 * deliberately a stub: `users.controller.ts` reduces to `users` after the suffix vocabulary is
 * stripped, so "appears somewhere in the tree" is the wrong test for it. What did break is
 * narrower and checkable: the extension leaking through, and a package marker (`index`,
 * `__init__`) being treated as a responsibility of its own.
 *
 * Runs over every module of every fixture, Python included.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { normalizeResponsibilityKey } from '../../src/analysis/architecture/heuristics.js';
import { getSourceIndexBasenames, getSourceStripSuffixes, stripSourceExtension } from '../../src/plugin-host/source-set.js';

const FIXTURES_ROOT = [
  path.resolve(process.cwd(), 'test', 'fixtures'),
  path.resolve(process.cwd(), 'repovine', 'test', 'fixtures'),
].find(candidate => fs.existsSync(candidate));

function listFixtures(): string[] {
  if (!FIXTURES_ROOT) throw new Error('Could not find test fixtures root.');
  return fs
    .readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
}

describe('responsibility keys carry no extension and no package marker', () => {
  const markers = new Set(getSourceIndexBasenames());

  it('reads a non-empty vocabulary from the source-plugin registry', () => {
    expect(getSourceStripSuffixes()).toContain('.py');
    expect(markers.has('__init__')).toBe(true);
    expect(markers.has('index')).toBe(true);
  });

  // A tail check cannot tell a leaked extension from a name that ends that way on its own
  // (`auth-vue.ts` is legitimately `auth-vue`). The differential can: the key must not move when
  // the extension is removed first.
  it.each([
    ['main.py', 'main'],
    ['main.ts', 'main'],
    ['users.controller.py', 'users.controller'],
    ['pkg/__init__.py', 'pkg/__init__'],
    ['pkg/index.ts', 'pkg/index'],
    ['lib/agents.mjs', 'lib/agents'],
    ['src/auth/auth-vue.ts', 'src/auth/auth-vue'],
  ])('keys %s the same with and without its extension', (withExt, withoutExt) => {
    expect(normalizeResponsibilityKey(withExt)).toBe(normalizeResponsibilityKey(withoutExt));
  });

  it('reduces the same stem to the same key across languages', () => {
    expect(normalizeResponsibilityKey('billing.py')).toBe(normalizeResponsibilityKey('billing.ts'));
    expect(normalizeResponsibilityKey('pkg/__init__.py')).toBe(normalizeResponsibilityKey('pkg/index.ts'));
  });

  describe.each(listFixtures())('%s', (fixtureName) => {
    const fixtureRoot = path.join(FIXTURES_ROOT!, fixtureName);
    let keysByPath: Array<{ relPath: string; key: string }>;

    beforeAll(async () => {
      const origLog = console.log;
      console.log = () => {};
      try {
        const snapshot = await collectRepositoryFactsAsync(fixtureRoot);
        keysByPath = snapshot.modules.map(mod => ({
          relPath: mod.relativeFilePath,
          key: normalizeResponsibilityKey(mod.relativeFilePath),
        }));
      } finally {
        console.log = origLog;
      }
    });

    it('emits a key that does not move when the extension is stripped first', () => {
      const leaked = keysByPath.filter(({ relPath, key }) =>
        key !== normalizeResponsibilityKey(stripSourceExtension(relPath)));
      expect(leaked).toEqual([]);
    });

    it('emits no key equal to a declared package marker', () => {
      const markerKeys = keysByPath.filter(({ key }) => markers.has(key));
      expect(markerKeys).toEqual([]);
    });
  });
});
