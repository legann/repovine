import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import ts from 'typescript';
import { repoRoot } from './graph-law-helpers.js';

/**
 * Law: every plugin written as a third party imports only the public SDK.
 *
 * `plugin-workspace-boundary` holds this for the nine first-party packages under
 * `packages/plugins/**`. The trees below are the other half of the same property, and until now no
 * law read them: that both canaries compile against the packed SDK alone was proved by the smoke
 * gate, which is a compile inside a gate rather than a statement about the tree. A canary that
 * reached a workspace path would still compile here, in this repository, where that path resolves —
 * and fail for the author who copies it.
 *
 * These trees are the authoring surface a reader is pointed at, so the guarantee they carry is
 * documentation as much as enforcement: what they import is what the docs claim is available.
 */

/** An author tree, and how far a relative import may reach inside it. */
interface AuthorTree {
  readonly label: string;
  readonly dir: string;
  /** True when the tree is a package of its own, so a relative escape leaves it. */
  readonly selfContained: boolean;
}

const SOURCE_EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

/**
 * Every external author tree, discovered rather than listed.
 *
 * Two roots, both read from the filesystem: the canary fixtures and the published examples. A
 * fixture added by a later stage is guarded the day it lands, which is the point — the four
 * scenarios of §2 arrive as new trees here.
 */
function authorTrees(root: string): AuthorTree[] {
  const trees: AuthorTree[] = [];
  const canaryRoot = path.join(root, 'test', 'fixtures', 'canary-plugins');
  if (fs.existsSync(canaryRoot)) {
    for (const entry of fs.readdirSync(canaryRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      trees.push({
        label: `canary-plugins/${entry.name}`,
        dir: path.join(canaryRoot, entry.name),
        selfContained: true,
      });
    }
  }
  const examplesRoot = path.join(root, 'examples');
  if (fs.existsSync(examplesRoot)) {
    for (const entry of fs.readdirSync(examplesRoot, { withFileTypes: true })) {
      // Only the plugin examples: `agent-harness-demo` is a consumer of the engine, not a plugin
      // author, and it is entitled to import the engine it demonstrates.
      if (!entry.isDirectory() || !entry.name.startsWith('repovine-plugin-')) continue;
      trees.push({
        label: `examples/${entry.name}`,
        dir: path.join(examplesRoot, entry.name),
        selfContained: true,
      });
    }
  }
  return trees.sort((a, b) => a.label.localeCompare(b.label));
}

function* treeSources(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // `node_modules` and build output belong to whoever installed or produced them.
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* treeSources(full);
    else if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name)) yield full;
  }
}

function moduleSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specs.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node)
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0]!)
      && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      )
    ) {
      specs.push(node.arguments[0]!.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specs;
}

const PUBLIC_SDK = '@repovine/plugin-sdk';

function classify(tree: AuthorTree, file: string, spec: string): string | undefined {
  if (path.isAbsolute(spec) || path.win32.isAbsolute(spec)) return 'absolute import';
  if (spec.startsWith('node:')) return undefined;
  if (spec.startsWith('.')) {
    if (!tree.selfContained) return undefined;
    const target = path.resolve(path.dirname(file), spec);
    const rel = path.relative(tree.dir, target);
    const escapes = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
    return escapes ? 'relative import escapes the package' : undefined;
  }
  // A private path inside the SDK is not the SDK: `dist` and `src` are its implementation.
  if (spec === `${PUBLIC_SDK}/src` || spec.startsWith(`${PUBLIC_SDK}/src/`)) return 'private SDK path';
  if (spec === `${PUBLIC_SDK}/dist` || spec.startsWith(`${PUBLIC_SDK}/dist/`)) return 'private SDK path';
  // `./internal` resolves — the engine needs it — and carries no compatibility promise. An author
  // reaching it would compile today and break on a patch release, so it is refused here by name.
  if (spec === `${PUBLIC_SDK}/internal` || spec.startsWith(`${PUBLIC_SDK}/internal/`)) {
    return 'engine-internal SDK subpath';
  }
  if (spec === PUBLIC_SDK || spec.startsWith(`${PUBLIC_SDK}/`)) return undefined;
  if (spec === 'repovine' || spec.startsWith('repovine/')) return 'imports the engine';
  if (spec.startsWith('@repovine/')) return 'imports a first-party package other than the SDK';
  // Anything else is an ordinary third-party dependency, which an author is free to have.
  return undefined;
}

function scanAuthorTrees(root: string, trees: readonly AuthorTree[]): string[] {
  const violations: string[] = [];
  for (const tree of trees) {
    if (!fs.existsSync(tree.dir)) continue;
    for (const file of treeSources(tree.dir)) {
      const where = path.relative(root, file).split(path.sep).join('/');
      for (const spec of moduleSpecifiers(file)) {
        const problem = classify(tree, file, spec);
        if (problem) violations.push(`${where} -> ${spec}: ${problem}`);
      }
    }
  }
  return violations.sort();
}

/**
 * The SDK entry points an author is allowed to name.
 *
 * Read from the written contract register rather than from the `exports` map: the map is what
 * RESOLVES, and one of the subpaths it resolves is host machinery outside semver. What an author may
 * name is the authoring half, and that half is decided in writing.
 */
function authoringSdkSubpaths(root: string): string[] {
  const register = JSON.parse(
    fs.readFileSync(path.join(root, 'docs', 'plugin-api-contract.json'), 'utf8'),
  ) as { contractSubpaths: string[] };
  return [...register.contractSubpaths].sort();
}

describe('core-laws external plugin authors import only the public SDK', () => {
  it('finds the author trees and every one of them carries source', () => {
    const trees = authorTrees(repoRoot());

    // Positive control: this law is a sweep, and a sweep over nothing is green by default. Both
    // roots must contribute, and every tree found must actually have files to read.
    expect(trees.map(tree => tree.label)).toEqual(expect.arrayContaining([
      'canary-plugins/go-source',
      'canary-plugins/orbit-iac',
      'examples/repovine-plugin-go',
      'examples/repovine-plugin-iac',
    ]));
    for (const tree of trees) {
      expect({ tree: tree.label, files: [...treeSources(tree.dir)].length > 0 })
        .toEqual({ tree: tree.label, files: true });
    }
  });

  it('reaches nothing but the public SDK, node builtins and its own files', () => {
    expect(scanAuthorTrees(repoRoot(), authorTrees(repoRoot()))).toEqual([]);
  });

  it('names only SDK subpaths the contract register lists for authors', () => {
    const exported = new Set(authoringSdkSubpaths(repoRoot()));
    expect(exported.has('.')).toBe(true);
    // The engine-internal subpath resolves but is not for authors; if it were in this set, the
    // sweep below would wave it through.
    expect(exported.has('./internal')).toBe(false);

    const unknown: string[] = [];
    for (const tree of authorTrees(repoRoot())) {
      for (const file of treeSources(tree.dir)) {
        for (const spec of moduleSpecifiers(file)) {
          if (spec !== PUBLIC_SDK && !spec.startsWith(`${PUBLIC_SDK}/`)) continue;
          const subpath = spec === PUBLIC_SDK ? '.' : `.${spec.slice(PUBLIC_SDK.length)}`;
          if (!exported.has(subpath)) {
            unknown.push(`${path.relative(repoRoot(), file).split(path.sep).join('/')} -> ${spec}`);
          }
        }
      }
    }
    expect(unknown.sort()).toEqual([]);
  });

  it('turns red on each way out of the public surface (kill mutation)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine author-surface ünï-'));
    try {
      const treeDir = path.join(tmpRoot, 'test', 'fixtures', 'canary-plugins', 'probe');
      fs.mkdirSync(path.join(treeDir, 'src'), { recursive: true });
      const cases: Array<[string, string, string]> = [
        ['engine.ts', 'repovine', 'imports the engine'],
        ['engine-deep.ts', 'repovine/dist/graph/index.js', 'imports the engine'],
        ['sdk-private.ts', '@repovine/plugin-sdk/src/plugin/index.js', 'private SDK path'],
        ['sdk-dist.ts', '@repovine/plugin-sdk/dist/index.js', 'private SDK path'],
        ['sdk-internal.ts', '@repovine/plugin-sdk/internal', 'engine-internal SDK subpath'],
        ['sibling.ts', '@repovine/plugin-iac-sam', 'imports a first-party package other than the SDK'],
        ['escape.ts', '../../../../../src/graph/model.js', 'relative import escapes the package'],
      ];
      for (const [name, spec] of cases) {
        fs.writeFileSync(path.join(treeDir, 'src', name), `import '${spec}';\n`);
      }

      const trees = authorTrees(tmpRoot);
      expect(trees.map(tree => tree.label)).toEqual(['canary-plugins/probe']);
      const violations = scanAuthorTrees(tmpRoot, trees);

      // Every form is named, and each is asserted by its own reason: a single count would go green
      // if one form started reporting another's verdict.
      expect(violations).toEqual(cases
        .map(([name, spec, reason]) =>
          `test/fixtures/canary-plugins/probe/src/${name} -> ${spec}: ${reason}`)
        .sort());
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('lets an ordinary third-party dependency and a node builtin through (negative control)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine author-allowed ünï-'));
    try {
      const treeDir = path.join(tmpRoot, 'examples', 'repovine-plugin-probe');
      fs.mkdirSync(path.join(treeDir, 'lib'), { recursive: true });
      fs.writeFileSync(path.join(treeDir, 'index.js'), [
        "import * as path from 'node:path';",
        "import yaml from 'yaml';",
        "import { definePlugin } from '@repovine/plugin-sdk';",
        "import { helper } from './lib/helper.js';",
        'export default definePlugin({ path, yaml, helper });',
      ].join('\n'));
      fs.writeFileSync(path.join(treeDir, 'lib', 'helper.js'), 'export const helper = 1;\n');

      // Without this the law above could be passing because it flags everything and these trees
      // happen to be empty of the allowed forms.
      expect(scanAuthorTrees(tmpRoot, authorTrees(tmpRoot))).toEqual([]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
