import { describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import typescriptPlugin from '../../packages/plugins/source-typescript/src/plugin.js';
import pythonPlugin from '../../packages/plugins/source-python/src/plugin.js';
import { codeFiles, repoRoot } from './graph-law-helpers.js';

/**
 * What a plugin author must not have to write, and what the SDK must not ship unused.
 *
 * `discover()` is a filesystem traversal and `extract()` resolves specifiers against a map the
 * engine keyed. Both are mechanical, both encode the engine's rules rather than the ecosystem's, and
 * both were written once per plugin before the SDK carried them. This law holds the consequences:
 * no producer keeps its own copy of the prune rule, the walk stays ordered under a hostile
 * filesystem, no resolver spells a fact its descriptor already declares, and nothing sits on the
 * published surface with no demonstrated use.
 */
describe('core-laws plugin author surface (the SDK carries the mechanics)', () => {
  const PLUGIN_ROOTS = ['packages/plugins/', 'src/iac-plugins/'];

  it('no producer walks the filesystem without the canonical prune rule', () => {
    const files = codeFiles([]).filter(f => PLUGIN_ROOTS.some(root => f.where.startsWith(root)));
    // The example plugins are held to the same rule: they are what a third party copies, and a
    // hand-rolled walk there teaches the skip list this stage exists to stop being written.
    for (const rel of ['examples/repovine-plugin-go/index.js', 'examples/repovine-plugin-iac/index.js']) {
      const abs = path.join(repoRoot(), rel);
      expect({ example: rel, present: fs.existsSync(abs) }).toEqual({ example: rel, present: true });
      files.push({ where: rel, text: fs.readFileSync(abs, 'utf8').replace(/^\s*\/\/.*$/gm, '') });
    }
    // The list this totality runs over is asserted non-empty: a renamed plugin root would otherwise
    // leave the check below passing over nothing.
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const { where, text } of files) {
      // A raw directory read skips both the prune rule and the sort. The sanctioned readers are
      // `walkRepository` (prunes and sorts) and `readDirSorted` (sorts, for a walker that asks about
      // directories rather than files and therefore prunes on its own).
      if (/\breaddirSync\b|\bopendirSync\b/.test(text)) offenders.push(`${where}: raw directory read`);
      if (/\breadDirSorted\s*\(/.test(text) && !/\bshouldWalkDiscoveryDir\s*\(/.test(text)) {
        offenders.push(`${where}: enumerates directories without shouldWalkDiscoveryDir`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the walk keeps discovery order off the filesystem, under a hostile enumeration', async () => {
    // `readDirSorted` sorting its own output proves nothing about a walk that never calls it. Force
    // the filesystem to answer in the worst order there is — exactly reversed — and require the walk
    // to hand files back in code-unit order anyway. The bracket name is the case where a locale
    // collation and a code-unit comparison disagree.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hostile-readdir-'));
    try {
      // Names differ by more than case: on a case-insensitive filesystem `A.ts` and `a.ts` are one
      // file, and the expected list would be short for a reason that has nothing to do with order.
      for (const name of ['mid.ts', '[bracket].ts', 'zeta.ts', 'Cap.ts']) {
        fs.writeFileSync(path.join(tmpRoot, name), '\n');
      }
      // One directory sorting BEFORE some files and one AFTER: a walk that emitted every file first
      // and recursed afterwards would pass with a single trailing directory, and that reordering is
      // exactly what moves node insertion order.
      for (const dir of ['Adir', 'ndir']) {
        fs.mkdirSync(path.join(tmpRoot, dir));
        fs.writeFileSync(path.join(tmpRoot, dir, 'inner.ts'), '\n');
      }

      jest.resetModules();
      const realFs = await import('node:fs');
      jest.unstable_mockModule('node:fs', () => ({
        ...realFs,
        default: realFs,
        readdirSync: (dir: fs.PathLike, opts: unknown) =>
          (realFs.readdirSync as unknown as (d: fs.PathLike, o: unknown) => unknown[])(dir, opts)
            .slice()
            .reverse(),
      }));
      // Imported after the mock, so the walk closes over the hostile reader.
      const { walkRepository } = await import('@repovine/plugin-sdk');

      const seen: string[] = [];
      walkRepository(tmpRoot, { onFile: file => seen.push(file.relFromRoot) });

      // The order a code-unit comparison gives, with directories descended in place — which is the
      // order the graph is built in.
      expect(seen).toEqual([
        'Adir/inner.ts',
        'Cap.ts',
        '[bracket].ts',
        'mid.ts',
        'ndir/inner.ts',
        'zeta.ts',
      ]);
    } finally {
      jest.resetModules();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('a resolver spells no suffix or index basename its descriptor already declares', () => {
    const RESOLVERS = [
      { plugin: typescriptPlugin, where: 'packages/plugins/source-typescript/src/resolve-specifier.ts' },
      { plugin: pythonPlugin, where: 'packages/plugins/source-python/src/resolve-import.ts' },
    ];
    // Every built-in source plugin is covered. Asked of the tree rather than of the list above:
    // comparing the list to a literal spelling of itself would pass whatever the tree contains.
    const pluginDirs = fs
      .readdirSync(path.join(repoRoot(), 'packages', 'plugins'), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('source-'))
      .map(entry => entry.name.slice('source-'.length))
      .sort();
    expect(RESOLVERS.map(r => r.plugin.id).sort()).toEqual(pluginDirs);

    // Read line by line, not as one joined string: a literal never spans lines, and a joined file
    // lets one quote character pair with another thousands of characters away. Module specifiers are
    // dropped first — `'../../platform/paths.js'` carries `.js`, and that is an import, not a
    // restated fact.
    function literalsIn(where: string): string[] {
      const out: string[] = [];
      for (const raw of fs.readFileSync(path.join(repoRoot(), where), 'utf8').split('\n')) {
        const line = raw
          // `\r` first: a CRLF checkout would leave it at the end, and `.` never matches a line
          // terminator, so the comment strip below would find no `$` to anchor to.
          .replace(/\r$/, '')
          .replace(/\/\/.*$/, '')
          // Any module specifier, including the `} from '…'` tail of a multi-line import.
          .replace(/\bfrom\s*['"][^'"]*['"]/g, '')
          .replace(/^\s*import\s*['"][^'"]*['"]/, '')
          .trim();
        if (!line || line.startsWith('*') || line.startsWith('/*')) continue;
        for (const m of line.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)) out.push(m[1] ?? m[2] ?? m[3]!);
        for (const m of line.matchAll(/(?:^|[=(,[\s])\/((?:[^/\\\n]|\\.)+)\/[gimsuy]*/g)) out.push(m[1]!);
      }
      // A regex spells `.py` as `\.py`; comparing the unescaped body is what makes both forms one.
      return out.map(lit => lit.replace(/\\(?=[.$^*+?()[\]{}|/])/g, ''));
    }

    const offenders: string[] = [];
    for (const { plugin, where } of RESOLVERS) {
      const normalize = plugin.capabilities?.moduleIdNormalize;
      const declared = [...(normalize?.stripSuffixes ?? []), ...(normalize?.indexBasenames ?? [])];
      // A descriptor that declared nothing could not be restated, and would pass by vacuity.
      expect({ plugin: plugin.id, declares: declared.length > 0 }).toEqual({ plugin: plugin.id, declares: true });

      const literals = literalsIn(where);
      // A resolver with no literals at all would also pass by vacuity; it has module doc and code.
      expect({ where, hasLiterals: literals.length > 0 }).toEqual({ where, hasLiterals: true });

      for (const fact of declared) {
        if (literals.some(lit => lit.includes(fact))) {
          offenders.push(`${where}: restates ${JSON.stringify(fact)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the resource hash is a fact about the resource, not about key order', async () => {
    // `InfraResource.contentHash` is the one hash a PRODUCER mints, and it drives runtime-resource
    // freshness. Two properties, asserted separately because they fail separately: a reordered
    // manifest is the same resource, and a changed value is a different one.
    const { hashResourcePayload } = await import('@repovine/plugin-sdk');

    const straight = { kind: 'queue', name: 'orders', attributes: { retries: 3, dlq: 'orders-dlq' } };
    const permuted = { attributes: { dlq: 'orders-dlq', retries: 3 }, name: 'orders', kind: 'queue' };
    expect(hashResourcePayload(permuted)).toBe(hashResourcePayload(straight));

    const changed = { ...straight, attributes: { retries: 4, dlq: 'orders-dlq' } };
    expect(hashResourcePayload(changed)).not.toBe(hashResourcePayload(straight));

    // A key set to `undefined` is the same fact as an absent key — the rule `JSON.stringify` has,
    // kept so a parser that spells an optional field explicitly does not fork the identity.
    expect(hashResourcePayload({ ...straight, provider: undefined })).toBe(hashResourcePayload(straight));
    // Array order is not key order: in a manifest, a list is ordered.
    expect(hashResourcePayload({ ports: [1, 2] })).not.toBe(hashResourcePayload({ ports: [2, 1] }));

    // A collection is refused rather than folded to `{}`: `Object.keys` cannot see its entries, so
    // every instance would hash alike and two different resources would collide silently.
    expect(() => hashResourcePayload({ tags: new Map([['a', 1]]) })).toThrow(/carries no enumerable own keys/);
    expect(() => hashResourcePayload({ tags: new Set([1]) })).toThrow(/carries no enumerable own keys/);

    // A value that serializes itself is asked, not walked. YAML parsers hand back `Date` for an
    // unquoted timestamp, and a walked `Date` has no own fields — every date would hash alike.
    const early = hashResourcePayload({ createdAt: new Date('2020-01-01T00:00:00Z') });
    const late = hashResourcePayload({ createdAt: new Date('2026-07-28T00:00:00Z') });
    expect(early).not.toBe(late);
  });

  it('canonical bytes for a structure are computed in one place', () => {
    // Three spellings of the same recursive key-sort lived in the tree at once — the graph's edge
    // dedup key, the annotation merge comparison, and the resource hash — and each carried its own
    // blind spots. A fourth is written the same way: sort `Object.keys`, recurse, stringify.
    const HOME = 'packages/plugin-sdk/src/canonical-json.ts';
    const recursiveSortedKeys = (text: string): boolean =>
      /Object\.keys\([^)]*\)\s*\.?\s*sort\(/.test(text) && /JSON\.stringify\(/.test(text);

    // Each exemption answers a DIFFERENT question, and says which. None may be dropped without
    // losing an answer the tree needs; none is here because the form was inconvenient to move.
    const ASKS_SOMETHING_ELSE: Record<string, string> = {
      // Layout of bytes on disk for one named document, not the identity of a structure.
      'src/fs/keyed-json.ts': 'writes the annotations file with a stable line layout',
      'src/annotations/format.ts': 'orders keys of one record before it is written',
      // Identity of a RUNTIME CONFIG: functions, symbols, RegExp, circular references, Map and Set,
      // plus `<repo>` substitution so the fingerprint survives a move between machines. It handles
      // exactly the value kinds `canonicalJson` refuses, and refusing them there is the point.
      'src/stage1/extraction-config-fingerprint.ts': 'fingerprints non-JSON runtime config, portably',
    };
    const offenders = codeFiles([])
      .filter(f => f.where !== HOME && ASKS_SOMETHING_ELSE[f.where] === undefined)
      .filter(f => recursiveSortedKeys(f.text) && /\brecurs|\bstable|canonical/i.test(f.text))
      .map(f => f.where);
    expect(offenders).toEqual([]);

    // Every exemption still names a real file: a renamed one would silently stop exempting anything
    // and start hiding nothing, which reads the same as a clean list.
    const seen = new Set(codeFiles([]).map(f => f.where));
    expect(Object.keys(ASKS_SOMETHING_ELSE).filter(where => !seen.has(where))).toEqual([]);

    // The home is real and holds the form: an empty or renamed home would make the check above pass
    // over nothing.
    const home = codeFiles([]).find(f => f.where === HOME);
    expect({ home: HOME, holdsTheForm: home !== undefined && recursiveSortedKeys(home.text) })
      .toEqual({ home: HOME, holdsTheForm: true });
  });

  it('an example composes no primitive the SDK publishes', () => {
    // A guard for a class the consumer census cannot see: the export HAS a consumer, and the sample
    // an author copies re-implements it beside — under the engine's own name, with another body.
    const owned = ['hashResourcePayload', 'sha256Hex', 'mintModuleId', 'packageNodeId', 'toPosixPath', 'walkRepository', 'lastPathSegment'];
    const offenders: string[] = [];
    for (const rel of ['examples/repovine-plugin-go/index.js', 'examples/repovine-plugin-iac/index.js']) {
      const text = fs.readFileSync(path.join(repoRoot(), rel), 'utf8').replace(/^\s*\/\/.*$/gm, '');
      for (const name of owned) {
        if (new RegExp(`(?:function|const|let)\\s+${name}\\b`).test(text)) {
          offenders.push(`${rel}: declares its own ${name}`);
        }
      }
      // Composing a digest by hand is the same class one level down: the width and the recipe are
      // published so nobody re-derives them from a sample.
      if (/\bcreateHash\s*\(/.test(text)) offenders.push(`${rel}: composes a digest instead of using the published one`);
    }
    expect(offenders).toEqual([]);
  });

  it('every published value export has a consumer', () => {
    // Every barrel the package publishes, not just the root: `package.json` exports three subpaths,
    // and an export reachable through one of them is as published as one on the root.
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot(), 'packages', 'plugin-sdk', 'package.json'), 'utf8'),
    ) as { exports: Record<string, unknown> };
    const barrelFiles = Object.keys(pkg.exports)
      .map(subpath => (subpath === '.' ? 'index.ts' : `${subpath.replace(/^\.\//, '')}/index.ts`))
      .map(rel => `packages/plugin-sdk/src/${rel}`);
    expect(barrelFiles.length).toBeGreaterThan(1);

    const barrels = codeFiles([]).filter(f => barrelFiles.includes(f.where));
    expect(barrels.map(b => b.where).sort()).toEqual([...barrelFiles].sort());

    const values: string[] = [];
    for (const m of barrels.map(b => b.text).join('\n').matchAll(/export\s+(type\s+)?\{([^}]*)\}\s*from/g)) {
      if (m[1]) continue; // `export type { … }` — a shape, consumed by declaring a signature
      for (const raw of m[2]!.split(',')) {
        const entry = raw.trim();
        if (!entry || entry.startsWith('type ')) continue;
        // `X as Y` publishes Y; a consumer names the published spelling, never the local one.
        const name = entry.includes(' as ') ? entry.split(' as ').pop()!.trim() : entry;
        if (name) values.push(name);
      }
    }
    expect(values.length).toBeGreaterThan(20);

    // Everything that could stand in for a consumer: the engine that dogfoods the same surface, the
    // kit a plugin runs, the tests, and the examples an author copies. The SDK's own modules are NOT
    // consumers — a name appears there because it is DECLARED there, and counting the declaration
    // would let anything re-exported from the facade vouch for itself.
    const outsideBarrel = codeFiles([])
      .filter(f => f.where.startsWith('src/') || f.where.endsWith('plugin-sdk/src/conformance.ts'))
      .map(f => f.text);
    // A barrel re-exporting another barrel's name is not a consumer of it.
    void barrels;
    // Read by extension, not just `.ts`: an example plugin is JavaScript, and a reader that only
    // knew TypeScript would call every export the examples use unconsumed.
    const CODE_EXT = /\.(?:ts|tsx|js|mjs|cjs)$/;
    const readTree = (dir: string): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name === 'node_modules') continue;
        // This law names exports in its own prose; counting itself would let an export vouch for
        // itself through the very check meant to condemn it.
        if (entry.name === 'plugin-author-surface.test.ts') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) readTree(full);
        else if (entry.isFile() && CODE_EXT.test(entry.name)) outsideBarrel.push(fs.readFileSync(full, 'utf8'));
      }
    };
    // The built-in plugin packages are the dogfood this surface exists for: each is authored against
    // the published barrel exactly as a third party would be, so a name only they reach is used, not
    // orphaned. They are not part of the SDK, so counting them is not an export vouching for itself.
    for (const dir of ['test', 'examples', path.join('packages', 'plugins')]) {
      readTree(path.join(repoRoot(), dir));
    }
    const consumerText = outsideBarrel.join('\n');

    // A surface with no reader is a surface added and forgotten; at the tag it freezes with the
    // rest. Either something uses it, or it does not belong on the facade.
    const unused = values.filter(name => !new RegExp(`\\b${name}\\b`).test(consumerText));
    expect(unused).toEqual([]);
  });

  it('every semanticHints slot is documented with its reach', async () => {
    // The slot list comes from the schema, so a slot added there and not written down makes this
    // red — an author reading the table would otherwise see a contract with a hole in it.
    const { zSemanticHints } = await import('@repovine/plugin-sdk');
    const slots = Object.keys(zSemanticHints.shape);
    expect(slots.length).toBeGreaterThan(5);

    const doc = fs.readFileSync(path.join(repoRoot(), 'docs', 'plugin-authoring.md'), 'utf8');
    // Only the table: a slot named in running prose is mentioned, not documented. Table rows start
    // with a backticked slot name in the first cell.
    const documented = new Set(
      [...doc.matchAll(/^\|\s*`([A-Za-z][\w.]*)`\s*\|/gm)].map(m => m[1]!),
    );
    const missing = slots.filter(slot => !documented.has(slot));
    expect(missing).toEqual([]);
  });

  it('the conformance kit has a consumer outside the engine', () => {
    // The kit is what an out-of-tree author runs, so the claim that it works is made from outside:
    // each example wires its plugin the way an install does and runs the kit against it.
    const runners = ['examples/repovine-plugin-go/run.mjs', 'examples/repovine-plugin-iac/run.mjs'];
    const exampleText = runners
      .map(rel => {
        const abs = path.join(repoRoot(), rel);
        expect({ runner: rel, present: fs.existsSync(abs) }).toEqual({ runner: rel, present: true });
        return fs.readFileSync(abs, 'utf8');
      })
      .join('\n');

    for (const entry of ['checkSourcePluginConformance', 'checkIaCPluginConformance']) {
      expect({ entry, runByAnExample: new RegExp(`\\b${entry}\\b`).test(exampleText) })
        .toEqual({ entry, runByAnExample: true });
    }
  });
});
