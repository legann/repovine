import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { HASH_WIDTH, mintModuleId, sha256Hex } from '@repovine/plugin-sdk';
import {
  normalizeRelPath,
  pathMatchKey,
  repoRelativePosix,
  resolveRelPath,
  toPosixPath,
} from '../../src/platform/paths.js';
import { domainLabelSlug, domainSlug } from '../../src/stage2/domain-slug.js';
import { getPathBasedDomains, packageShortName } from '../../src/stage2/domains.js';
import { shortModuleLabel } from '../../src/stage2/module-label.js';
import { NODE_ID_PREFIXES, exportSymbolId, owningModuleId, packageNameFromId, packageNodeId } from '../../src/graph/node-ids.js';
import { isBarrelRelPath } from '../../src/graph/module-files.js';
import '../../src/stage1/source/bootstrap.js';
import { getKnownExtensions, getModuleIdStripSuffixes, getSourceIndexBasenames } from '../../src/stage1/source/registry.js';
import { shouldWalkDiscoveryDir } from '../../src/scan-filters.js';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../src/stage2/index.js';
import { analyzePackageBoundaries } from '../../src/mcp/lib/dependencies/package-boundaries.js';
import { packageScopeOf } from '../../src/cli/orient.js';
import { codeFiles, codeLines } from './graph-law-helpers.js';
import type { ModuleInfo, RepositoryFactsSnapshot, RepositoryGraph } from '../../src/types.js';
import type { McpToolRuntime } from '../../src/mcp/types.js';

// A path, a label and a node id are three different strings about one file, and each one used to be
// derived in a dozen places. What this law holds:
//
//   - the alphabet a domain label is written in is one function, and an empty result is a refusal
//     everywhere (a directory named `___` used to become the node `domain:___`);
//   - a repo-relative POSIX path comes from one function, so nothing persists a native separator;
//   - the content-hash recipe is one function, and its width is a named contract;
//   - the family of source extensions is declared by the plugins that own it, so a label never
//     names a file that is not there (`global.d.ts` used to label as `…/types/global.d`);
//   - a node id is minted and un-minted by one pair per kind;
//   - discovery walkers prune the same directories, so a package cannot exist through one producer
//     and be absent through another;
//   - an analysis asks the graph, not the display label. `analyze_dependencies` used to give two
//     answers for two repositories differing only in whether the barrel was `index.ts` or
//     `index.mjs`, because the barrel test read the label and the label kept `.mjs`.
//
// Text guards below read source, not the graph: they catch a second declaration of a form that was
// just removed. Behavioural guards catch a second declaration written in a shape the text does not
// know. Neither alone is enough — stage 7 learned that from a hand-written copy no text guard saw.

function fixture(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-pathid-')));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

async function buildFixture(root: string): Promise<{ graph: RepositoryGraph; snapshot: RepositoryFactsSnapshot }> {
  const origLog = console.log;
  console.log = () => {};
  try {
    const snapshot = await collectRepositoryFactsAsync(root);
    return { graph: composeRepositoryGraph(snapshot), snapshot };
  } finally {
    console.log = origLog;
  }
}

function runtimeFor(graph: RepositoryGraph, snapshot: RepositoryFactsSnapshot): McpToolRuntime {
  const modulesById = new Map<string, ModuleInfo>(snapshot.modules.map(m => [m.id, m]));
  return {
    getState: () => ({ graph, snapshot, modulesById }),
    repoRoot: snapshot.repoRoot,
  } as unknown as McpToolRuntime;
}

describe('core-laws paths, labels and id minting', () => {
  const tempRoots: string[] = [];
  const keep = (root: string): string => { tempRoots.push(root); return root; };
  afterAll(() => {
    for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── the label alphabet ───────────────────────────────────────────────────────────────────────

  it('writes the kebab chain once', () => {
    // The chain as it was copied: a character-class scrub into dashes.
    const chain = /replace\(\s*\/\[\^a-z0-9-\]\/g\s*,\s*'-'\s*\)/;
    const offenders = codeFiles(['stage2/domain-slug.ts'])
      .filter(file => chain.test(file.text))
      .map(file => file.where);
    expect(offenders).toEqual([]);
  });

  it('answers an unwritable segment with a refusal, in every producer of a domain label', () => {
    // `___` carries no character the alphabet admits. Each of these used to answer differently:
    // `getPathBasedDomains` passed the raw segment through, the rest returned the empty string.
    expect(domainSlug('___')).toBe('');
    expect(domainLabelSlug('___/___')).toBe('');
    expect(packageShortName('___')).toBe('');
    expect(getPathBasedDomains('src/___/x.ts')).toEqual([]);
  });

  it('mints no domain node whose label the alphabet rejects', async () => {
    const root = keep(fixture({
      'package.json': '{ "name": "slugfx", "version": "1.0.0" }\n',
      'tsconfig.json': '{ "compilerOptions": { "target": "ES2022", "module": "ESNext" }, "include": ["src"] }\n',
      'src/___/x.ts': 'export const x = 1;\n',
      'src/___/y.ts': "import { x } from './x.js';\nexport const y = x + 1;\n",
    }));
    const { graph } = await buildFixture(root);
    const domainLabels = [...graph.nodes.values()].filter(n => n.type === 'domain').map(n => n.label);
    expect(domainLabels).not.toContain('___');
    // Stated as a property, not as one input: every label the graph carries survives its own alphabet.
    expect(domainLabels.filter(label => domainLabelSlug(label) !== label)).toEqual([]);
  });

  it('slugs idempotently, so a label that reached a node id is stable under a second pass', () => {
    for (const input of ['Foo Bar', 'api/v1', '@scope/pkg', 'ünï', 'a--b', '--', 'UPPER', '___', '']) {
      expect(domainLabelSlug(domainLabelSlug(input))).toBe(domainLabelSlug(input));
    }
  });

  // ── repo-relative POSIX ──────────────────────────────────────────────────────────────────────

  it('derives a repo-relative POSIX path in one place', () => {
    // Both spellings the removed copies used: splitting on the host separator, and rewriting the
    // backslash directly. The first cut of this guard read only the first spelling, and sixteen
    // copies of the second walked past it — twelve of them in files this very change edited.
    // Written as a raw string rather than a regexp: a pattern that has to escape a backslash to
    // look for a backslash is a pattern that silently matches nothing, which is how the first cut
    // of this guard passed its own rollback.
    const backslashRewrite = String.raw`replace(/\\/g,'/')`;
    const offenders = codeFiles(['platform/paths.ts', 'plugin-sdk/src/source-plugin/module-id.ts'])
      .filter(file => /split\(path\.sep\)|split\(sep\)/.test(file.text)
        || file.text.replace(/\s+/g, '').includes(backslashRewrite))
      .map(file => file.where);
    expect(offenders).toEqual([]);
  });

  it('names its answer at the root rather than leaving two spellings of it', () => {
    // The pair the earlier spec cited as three behaviours is two, and this is the input that
    // separates them: `path.normalize('')` is `'.'`, `path.relative(root, root)` is `''`.
    expect(repoRelativePosix('/repo', '/repo')).toBe('');
    expect(repoRelativePosix('/repo', '/repo/src/a.ts')).toBe('src/a.ts');
  });

  it('keeps the three path questions apart', () => {
    // Same input, three answers, and each caller picks by name rather than by rewriting a chain.
    expect(toPosixPath('a\\..\\B.ts')).toBe('a/../B.ts');
    expect(normalizeRelPath('/a//../B.ts')).toBe('a/../B.ts');
    expect(resolveRelPath('/a//../B.ts')).toBe('B.ts');
    expect(pathMatchKey('a\\..\\B.ts')).toBe('a/../b.ts');
  });

  // ── the hash recipe ──────────────────────────────────────────────────────────────────────────

  it('writes the sha256 recipe once', () => {
    // A one-expression digest is the form every removed copy took. The streaming sites keep an
    // intermediate hash object and are a different shape on purpose — each says why in place.
    const offenders = codeFiles(['plugin-sdk/src/content-hash.ts'])
      .filter(file => /createHash\(\s*'sha256'\s*\)(?:\s*\.update\([^;]*?\))*\s*\.digest\(/.test(file.text))
      .map(file => file.where);
    expect(offenders).toEqual([]);
  });

  it('keeps each hash width a named fact', () => {
    expect(sha256Hex('x', HASH_WIDTH.content)).toHaveLength(16);
    expect(sha256Hex('x', HASH_WIDTH.config)).toHaveLength(24);
    expect(sha256Hex('x', HASH_WIDTH.full)).toHaveLength(64);
    // Truncation is a prefix, so the three widths are the same fact read to three depths.
    expect(sha256Hex('x', HASH_WIDTH.full).startsWith(sha256Hex('x', HASH_WIDTH.content))).toBe(true);
  });

  // ── the extension family ─────────────────────────────────────────────────────────────────────

  it('declares the source-extension family where the owning plugin declares it', () => {
    // An alternation of two or more source extensions is how each removed copy was written; the
    // `tsx?`/`jsx?` shorthands are the same set spelled shorter.
    // `d\\.ts` is on the list because a copy that OPENS with it is the shape that walked past the
    // first cut of this guard — `/(\\/index)?\\.(d\\.ts|tsx?|jsx?|mjs|cjs)$/` in stage1/utils.ts, which had
    // already drifted off `.mts`/`.cts` by the time the guard was written.
    const alt = [...getKnownExtensions().map(ext => ext.slice(1)), 'tsx\\?', 'jsx\\?', 'd\\\\?\\.ts'].join('|');
    const twoOrMore = new RegExp(`\\\\\\.\\(\\??:?(?:${alt})(?:\\|(?:${alt}))+\\)`);
    // An array literal of two or more extensions is the same declaration spelled as data.
    const known = getKnownExtensions();
    const asArray = new RegExp(
      `(['"\`])\\.(?:${known.map(e => e.slice(1)).join('|')})\\1\\s*,\\s*(['"\`])\\.(?:${known.map(e => e.slice(1)).join('|')})\\2`,
    );
    const offenders = codeLines([
      // The three modules that declare a family, and the one frozen surface.
      'source-plugins/typescript/extensions.ts',
      'source-plugins/typescript/sfc-extractor.ts',
      'source-plugins/python/discover.ts',
      'annotations/module-kind.ts',
      // `search-graph.ts` normalizes a raw QUERY, and the order of `topResults` is recorded in the
      // published benchmark corpus. Widening the set it forgives would change which nodes match and
      // in what order, so it stays until the corpus is re-run on the current engine.
      'mcp/lib/search-graph.ts',
    ]).filter(line => twoOrMore.test(line.text) || asArray.test(line.text)).map(line => line.where);
    expect(offenders).toEqual([]);
  });

  it('labels a module by the same suffix rule the id drops', () => {
    // `.d.ts` used to leave a `.d` tail on the label while the id lost the whole suffix, and the
    // comment that promised otherwise was true about the id only.
    expect(shortModuleLabel('src/types/global.d.ts')).toBe('…/types/global');
    expect(shortModuleLabel('src/lib/index.mjs')).toBe('…/lib/index');
    expect(shortModuleLabel('app/main.py')).toBe('app/main');
    // An SFC keeps its extension in both, because `+page.svelte` and `+page.ts` are two modules.
    expect(shortModuleLabel('src/routes/+page.svelte')).toBe('…/routes/+page.svelte');
    // The loop is driven by the same list the implementation reads, so an empty list would make it
    // pass by not running. Pin what the built-in plugins declare first.
    const idSuffixes = getModuleIdStripSuffixes();
    expect(idSuffixes).toEqual(expect.arrayContaining(['.d.ts', '.ts', '.tsx', '.mts', '.cts', '.py']));
    for (const suffix of idSuffixes) {
      expect(shortModuleLabel(`a/b${suffix}`).endsWith(suffix)).toBe(false);
    }
  });

  it('recognizes a barrel by what its ecosystem declared, not by the word index', () => {
    const indexBasenames = getSourceIndexBasenames();
    expect(indexBasenames).toEqual(expect.arrayContaining(['index', '__init__']));
    for (const basename of indexBasenames) {
      expect(isBarrelRelPath(`pkg/sub/${basename}.ts`) || isBarrelRelPath(`pkg/sub/${basename}.py`)).toBe(true);
    }
    // Case-sensitive, like the mint: `Index.ts` is a module of its own.
    expect(isBarrelRelPath('src/lib/Index.ts')).toBe(false);
    expect(isBarrelRelPath('src/lib/index.mjs')).toBe(true);
    expect(isBarrelRelPath('pkg/sub/__init__.py')).toBe(true);
    expect(isBarrelRelPath('src/lib/thing.ts')).toBe(false);
  });

  // ── minting and un-minting ───────────────────────────────────────────────────────────────────

  it('pairs every id mint with its inverse', () => {
    for (const pkg of ['app', '@scope/pkg', 'repovine-agent-harness-demo']) {
      expect(packageNameFromId(packageNodeId(pkg))).toBe(pkg);
      const moduleId = mintModuleId(pkg, 'src/lib/thing.ts', { stripSuffixes: ['.ts'] });
      expect(owningModuleId(exportSymbolId(moduleId, 'handle'))).toBe(moduleId);
    }
  });

  it('mints a node id prefix through its own minter', () => {
    // A template literal opening with a node-id prefix and an interpolation. The first cut of this
    // guard required the literal to END right after the interpolation, and its own rollback walked
    // straight past it — `export:${mod.id.slice(4)}/${exp.name}` has a path tail. The prefix list
    // comes from the canonical vocabulary, so a prefix added there widens this with it.
    const mint = new RegExp('`(?:' + NODE_ID_PREFIXES.join('|') + '):\\$\\{');
    const offenders = codeFiles([
      'graph/node-ids.ts',
      // The runtime-resource minter: one function, one id shape per provider.
      'graph/make-runtime-resource-id.ts',
      // The SDK declares the `mod:`/`pkg:` shapes a producer must write.
      'plugin-sdk/src/source-plugin/module-id.ts',
    ]).filter(file => mint.test(file.text)).map(file => file.where);
    expect(offenders).toEqual([]);
  });

  // ── discovery pruning ────────────────────────────────────────────────────────────────────────

  it('prunes the same directories in every discovery walker', async () => {
    const root = keep(fixture({
      'package.json': '{ "name": "skipfx", "version": "1.0.0" }\n',
      'tsconfig.json': '{ "compilerOptions": { "target": "ES2022", "module": "ESNext" }, "include": ["src"] }\n',
      'pyproject.toml': '[project]\nname = "skipfx-py"\n',
      'src/a.ts': 'export const a = 1;\n',
      'pysrc/mod.py': 'X = 1\n',
      // Each of these used to mint a package, a module or a template that no other producer saw.
      '.venv/tspkg/tsconfig.json': '{ "include": ["src"] }\n',
      '.venv/tspkg/src/q.ts': 'export const q = 1;\n',
      '.repovine/sub/tsconfig.json': '{ "include": ["src"] }\n',
      '.repovine/sub/src/q.ts': 'export const q = 1;\n',
      '.aws-sam/tspkg/tsconfig.json': '{ "include": ["src"] }\n',
      '.aws-sam/tspkg/src/q.ts': 'export const q = 1;\n',
      'coverage/pypkg/pyproject.toml': '[project]\nname = "py-in-coverage"\n',
      'coverage/pypkg/z.py': 'Y = 2\n',
      'tests/templates/leaked.j2': '{% extends "base.html" %}\n',
      // One artifact per walker, so removing the shared predicate from any single one turns this red.
      'tests/infra/Dockerfile': 'FROM node:22\n',
      'coverage/infra/Dockerfile': 'FROM node:22\n',
      'infra/Dockerfile': 'FROM node:22\n',
    }));
    const { snapshot } = await buildFixture(root);

    expect(snapshot.packages.map(p => p.path).sort()).toEqual(['.', '.']);
    expect(snapshot.modules.map(m => m.id).sort()).toEqual(['mod:skipfx-py/pysrc/mod', 'mod:skipfx/src/a']);
    expect(snapshot.templates ?? []).toEqual([]);
    // The infra walker prunes the same trees — and still finds the one Dockerfile that is not in one.
    expect((snapshot.infraModules ?? []).map(m => m.relativeFilePath).sort()).toEqual(['infra/Dockerfile']);
    // Stated as a property too: nothing the snapshot holds sits under a pruned directory.
    for (const mod of snapshot.modules) {
      expect(shouldWalkDiscoveryDir(mod.relativeFilePath)).toBe(true);
    }
  });

  // ── an analysis asks the graph, not the label ────────────────────────────────────────────────

  describe('two repositories differing only in the barrel filename', () => {
    const files = (barrel: string): Record<string, string> => ({
      'package.json': '{ "name": "twin-root", "private": true, "workspaces": ["packages/*"] }\n',
      'tsconfig.json': '{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "allowJs": true } }\n',
      'packages/lib/package.json': '{ "name": "@twin/lib", "version": "1.0.0", "type": "module" }\n',
      'packages/lib/tsconfig.json': '{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "allowJs": true }, "include": ["src"] }\n',
      'packages/lib/src/thing.ts': 'export const thing = 42;\n',
      [`packages/lib/src/${barrel}`]: "export { thing } from './thing.js';\n",
      'packages/app/package.json': '{ "name": "@twin/app", "version": "1.0.0", "type": "module" }\n',
      'packages/app/tsconfig.json': '{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "allowJs": true }, "include": ["src"] }\n',
      'packages/app/src/main.ts': "import { thing } from '../../lib/src/thing.js';\nexport const main = thing;\n",
    });

    type Violation = { targetModule: string; importerCount: number; suggestedFix?: { exportLocation: string; exportStatement: string } };
    let ts: { ids: string[]; violations: Violation[] };
    let mjs: { ids: string[]; violations: Violation[] };

    const analyse = async (barrel: string): Promise<{ ids: string[]; violations: Violation[] }> => {
      const { graph, snapshot } = await buildFixture(keep(fixture(files(barrel))));
      const out = analyzePackageBoundaries(runtimeFor(graph, snapshot), {}) as { boundaryViolations?: Violation[] };
      return {
        ids: [...graph.nodes.keys()].filter(id => id.startsWith('mod:')).sort(),
        violations: (out.boundaryViolations ?? []).map(v => ({
          targetModule: v.targetModule,
          importerCount: v.importerCount,
          suggestedFix: v.suggestedFix,
        })),
      };
    };

    beforeAll(async () => {
      ts = await analyse('index.ts');
      mjs = await analyse('index.mjs');
    }, 120_000);

    it('mints the same module ids', () => {
      expect(mjs.ids).toEqual(ts.ids);
    });

    it('reports the same boundary violation', () => {
      // The finding used to disappear for the `.mjs` twin: the analyser tested the display label
      // for a `/index` tail, and the label kept `.mjs` while the id did not.
      expect(ts.violations).toEqual([{
        targetModule: 'src/thing',
        importerCount: 1,
        suggestedFix: {
          exportLocation: 'packages/lib/src/index.ts',
          exportStatement: "export { thing } from './thing';",
          fixesViolations: 1,
        },
      }]);
      // Everything but the entry file's own name: the `.mjs` twin publishes the same symbol from
      // the same place, so only the filename it is written in may differ.
      expect(mjs.violations.map(v => ({ ...v, suggestedFix: { ...v.suggestedFix, exportLocation: '' } })))
        .toEqual(ts.violations.map(v => ({ ...v, suggestedFix: { ...v.suggestedFix, exportLocation: '' } })));
      expect(mjs.violations[0].suggestedFix?.exportLocation).toBe('packages/lib/src/index.mjs');
    });
  });

  it('suggests an export path the repository actually contains', async () => {
    const root = keep(fixture({
      'package.json': '{ "name": "deep-root", "private": true, "workspaces": ["packages/*"] }\n',
      'tsconfig.json': '{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler" } }\n',
      'packages/lib/package.json': '{ "name": "@deep/lib", "version": "1.0.0", "type": "module" }\n',
      'packages/lib/tsconfig.json': '{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler" }, "include": ["src"] }\n',
      'packages/lib/src/index.ts': "export { thing } from './deep/nested/thing.js';\n",
      'packages/lib/src/deep/nested/index.ts': "export { thing } from './thing.js';\n",
      'packages/lib/src/deep/nested/thing.ts': 'export const thing = 42;\n',
      'packages/app/package.json': '{ "name": "@deep/app", "version": "1.0.0", "type": "module" }\n',
      'packages/app/tsconfig.json': '{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler" }, "include": ["src"] }\n',
      'packages/app/src/main.ts': "import { thing } from '../../lib/src/deep/nested/thing.js';\nexport const main = thing;\n",
    }));
    const { graph, snapshot } = await buildFixture(root);
    const out = analyzePackageBoundaries(runtimeFor(graph, snapshot), {}) as {
      boundaryViolations?: Array<{ suggestedFix?: { exportLocation: string; exportStatement: string } }>;
    };
    const fix = out.boundaryViolations?.[0]?.suggestedFix;
    expect(fix).toBeDefined();
    // The specifier used to be rebuilt from the display label, which keeps two segments behind `…/`,
    // so it named `./nested/thing` — a module the package does not have.
    expect(fix?.exportStatement).toBe("export { thing } from './deep/nested/thing';");
    const specifier = /from '\.\/(.+)'/.exec(fix!.exportStatement)?.[1];
    const entryDir = path.dirname(path.join(root, fix!.exportLocation));
    expect(fs.existsSync(path.join(entryDir, `${specifier}.ts`))).toBe(true);
  }, 120_000);

  it('refuses to name a package entry when two barrels tie for shallowest', async () => {
    const root = keep(fixture({
      'package.json': '{ "name": "tie-root", "private": true, "workspaces": ["packages/*"] }\n',
      'tsconfig.json': '{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler" } }\n',
      'packages/lib/package.json': '{ "name": "@tie/lib", "version": "1.0.0", "type": "module" }\n',
      'packages/lib/tsconfig.json': '{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler" }, "include": ["src", "bin"] }\n',
      // Two barrels one level down: nothing in the graph says which one the package publishes.
      'packages/lib/src/index.ts': "export { thing } from './thing.js';\n",
      'packages/lib/src/thing.ts': 'export const thing = 42;\n',
      'packages/lib/bin/index.ts': "export const cli = 1;\n",
      'packages/app/package.json': '{ "name": "@tie/app", "version": "1.0.0", "type": "module" }\n',
      'packages/app/tsconfig.json': '{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler" }, "include": ["src"] }\n',
      'packages/app/src/main.ts': "import { thing } from '../../lib/src/thing.js';\nexport const main = thing;\n",
    }));
    const { graph, snapshot } = await buildFixture(root);
    const out = analyzePackageBoundaries(runtimeFor(graph, snapshot), {}) as {
      boundaryViolations?: Array<{ suggestedFix?: unknown }>;
    };
    // The violation still stands — only the ready-to-paste fix is withheld, because a fix aimed at
    // `bin/index.ts` would name a file the package does not publish.
    expect(out.boundaryViolations?.length).toBe(1);
    expect(out.boundaryViolations?.[0].suggestedFix).toBeUndefined();
  }, 120_000);

  it('does not read a node label as a path', () => {
    // A label is a display form: it elides to two segments behind `…/`. Turning one back into a
    // path is what produced an export suggestion for a file that is not there.
    const parsesLabel = /\.label\s*\.(?:endsWith|startsWith|split|replace|slice)\(|nodeLabel\([^)]*\)\s*\.(?:endsWith|startsWith|split|replace|slice)\(/;
    // The same question asked of a parameter named `label` rather than of `.label` — the shape a
    // verbatim rollback of the removed helper takes, and the one the dotted pattern above cannot
    // see. The index basenames come from the registry, so a new ecosystem widens this with them.
    const barrelBySuffix = new RegExp(
      `endsWith\\((['"\`])/(?:${getSourceIndexBasenames().join('|')})\\1\\)`,
    );
    const offenders = codeLines(['graph/module-files.ts'])
      .filter(line => parsesLabel.test(line.text) || barrelBySuffix.test(line.text))
      .map(line => line.where);
    expect(offenders).toEqual([]);
  });

  it('resolves a scoped package name out of a module id', () => {
    // Cutting the id at its FIRST slash loses half of `@scope/name`, and the resolver's
    // `@`-forgiving lookup then answers with a different, real package: `@repovine` resolved to
    // `pkg:repovine` (248 modules) for a hit inside `pkg:@repovine/plugin-sdk` (12).
    const scoped = mintModuleId('@repovine/plugin-sdk', 'src/conformance.ts', { stripSuffixes: ['.ts'] });
    expect(scoped).toBe('mod:@repovine/plugin-sdk/src/conformance');
    expect(packageScopeOf(scoped)).toBe('@repovine/plugin-sdk');
    expect(packageScopeOf('pkg:@repovine/plugin-sdk')).toBe('@repovine/plugin-sdk');
    expect(packageScopeOf(mintModuleId('plain', 'src/x.ts', { stripSuffixes: ['.ts'] }))).toBe('plain');
    expect(packageScopeOf('pkg:repovine-agent-harness-demo')).toBe('repovine-agent-harness-demo');
    expect(packageScopeOf('domain:orders')).toBeUndefined();
  });
});
