import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { repoRoot } from './graph-law-helpers.js';

/**
 * Law: a published type surface declares what it needs to type-check.
 *
 * The SDK's `.d.ts` are part of the package: a consumer compiles against them, and every module
 * they import has to be resolvable from what the package itself declares. Inside this workspace it
 * always is — npm hoists the root's dev dependencies to one `node_modules`, and `tsc` finds them by
 * walking up from any package — so a missing declaration is invisible here and fails only for the
 * person installing the package.
 *
 * The standalone gate does not answer this either: its fixture compiles with `skipLibCheck: true`,
 * which is what most consumers use and what stops the SDK's own `.d.ts` from ever being checked.
 * That is the hole this law fills, and it fills it by reading the declaration rather than by turning
 * `skipLibCheck` off: a gate that also type-checks third-party `.d.ts` goes red when someone else
 * ships a wart, and a gate that reddens for reasons that are not ours stops being read.
 */

/**
 * Packages whose published types this law reads.
 *
 * The SDK is the author-facing surface; the nine bundled plugins ship in the same tarball, and their
 * `.d.ts` are published by the same act of packing. The list is spelled out rather than globbed: a
 * new package under `packages/` is a decision about what the product publishes, and it should reach
 * this law by someone naming it.
 */
const PUBLISHED = [
  'packages/plugin-sdk',
  'packages/plugins/source-typescript',
  'packages/plugins/source-python',
  'packages/plugins/iac-sam',
  'packages/plugins/iac-kubernetes',
  'packages/plugins/iac-helm',
  'packages/plugins/iac-terraform',
  'packages/plugins/iac-vercel',
  'packages/plugins/iac-dockerfile',
  'packages/plugins/iac-docker-compose',
];

/** A builtin import needs the ambient Node types, which are an ordinary dependency. */
const NODE_TYPES_PACKAGE = '@types/node';

interface Manifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function declarationFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...declarationFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * Package names the given `.d.ts` import, with a relative import counting as nothing.
 *
 * Read with the compiler's own preprocessor rather than a regex over the text. Prose quotes module
 * syntax — a doc comment reading ``export … from '…'`` is not an import — and a declaration carries
 * string literal types that contain `/*` and `//`, so neither "match `from`" nor "strip comments
 * first" survives contact with a real surface. `preProcessFile` answers what the compiler resolves,
 * which is the question this law asks, and it sees the inline `import('…')` a declaration uses
 * inside a type as well as the statement form.
 *
 * A subpath import (`zod/v4`) is satisfied by the package that owns it, and a scoped name keeps two
 * segments, so the specifier is reduced to the name a manifest can declare.
 */
function importedPackages(text: string): string[] {
  const out = new Set<string>();
  for (const reference of ts.preProcessFile(text, true, true).importedFiles) {
    const specifier = reference.fileName;
    if (specifier.startsWith('.')) continue;
    if (specifier.startsWith('node:')) {
      out.add(NODE_TYPES_PACKAGE);
      continue;
    }
    const segments = specifier.split('/');
    out.add(specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]);
  }
  return [...out];
}

describe('core-laws a published type surface declares its own imports', () => {
  for (const pkgDir of PUBLISHED) {
    it(`${pkgDir} declares every package its .d.ts import`, () => {
      const abs = path.join(repoRoot(), pkgDir);
      const files = declarationFiles(path.join(abs, 'dist'));
      // Without this the law would pass on an unbuilt tree, which is the one state it must not
      // certify: nothing to read is not the same as nothing to declare.
      expect(files.length).toBeGreaterThan(0);

      const needed = new Set(files.flatMap(file => importedPackages(fs.readFileSync(file, 'utf8'))));
      const manifest = JSON.parse(fs.readFileSync(path.join(abs, 'package.json'), 'utf8')) as Manifest;
      const declared = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
      ]);

      expect([...needed].filter(name => !declared.has(name)).sort()).toEqual([]);
    });
  }

  it('covers every package the tarball publishes types for', () => {
    // The list is hand-written, so a package added to the bundle is unguarded until someone adds it
    // here. Compared against what is on disk, which is what npm packs.
    const onDisk = fs
      .readdirSync(path.join(repoRoot(), 'packages/plugins'), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && fs.existsSync(path.join(repoRoot(), 'packages/plugins', entry.name, 'src')))
      .map(entry => `packages/plugins/${entry.name}`)
      .filter(dir => !dir.endsWith('default-preset'));

    expect(onDisk.filter(dir => !PUBLISHED.includes(dir))).toEqual([]);
  });

  it('reads a surface that actually imports something, so an empty answer is not a pass', () => {
    const files = declarationFiles(path.join(repoRoot(), 'packages/plugin-sdk', 'dist'));
    const needed = new Set(files.flatMap(file => importedPackages(fs.readFileSync(file, 'utf8'))));
    // The two the surface carries today. A surface that stopped importing anything would make the
    // check above vacuous, so what it reads is pinned rather than derived.
    expect([...needed].sort()).toEqual([NODE_TYPES_PACKAGE, 'zod']);
  });
});
