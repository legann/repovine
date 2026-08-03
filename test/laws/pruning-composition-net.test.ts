import { asRepoRelPath } from '@repovine/plugin-sdk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from '@jest/globals';
import { currentDirLayoutTable } from '../../packages/plugin-sdk/src/source-plugin/dir-layout.js';
import { collectRepositoryFactsAsync, type SnapshotOptions } from '../../src/stage1/index.js';
import { defaultPluginsConfig, loadPluginSet } from '../../src/plugin-host/load.js';
import { shouldWalkDiscoveryDir } from '../../src/scan-filters.js';

// Law: the set of directory names discovery prunes is held by a fixture that contains one of each.
//
// Pruning decides which modules exist, so it is a graph invariant — and nothing measured it. The
// goldens and the parity corpus cannot: across all fixtures under `test/fixtures` there is not one
// directory whose name the engine prunes, so no build there ever executes the decision. Two checks
// covered part of the set by naming paths by hand, and the names they did not list could be dropped
// from the engine without a single test going red.
//
// The fixture is pinned independently from the engine set. A newly-pruned name fails the explicit
// inclusion check until the fixture grows; a removed name stays on disk and leaks into the snapshot.

/**
 * The fixture's directory names, pinned here and NOT derived from the engine set.
 *
 * A fixture generated from the set under test cannot see a name leaving it: drop `env` from the
 * engine and the generated tree simply stops containing an `env/` directory, so nothing appears and
 * the assertion holds. That is the direction that matters — a name leaving the set is what makes
 * modules appear. Pinning the tree and checking the engine set against it catches both directions:
 * a name added to the engine fails the inclusion check until the fixture grows, and a name removed
 * from the engine turns up as a module out of a directory that used to be invisible.
 */
const NET_FIXTURE_DIRS: readonly string[] = [
  '.aws-sam', '.cache', '.eggs', '.env', '.git', '.mypy_cache', '.next', '.nox', '.nuxt', '.nx',
  '.pnpm-store', '.pytest_cache', '.repovine', '.ruff_cache', '.serverless', '.svelte-kit',
  '.terraform', '.tox', '.turbo', '.venv', '.yarn', '__e2e__', '__mocks__', '__pycache__',
  '__snapshots__', '__tests__', 'bower_components', 'build', 'cdk.out', 'coverage', 'cypress',
  'dist', 'dist-bundled', 'e2e', 'env', 'htmlcov', 'node_modules', 'out', 'playwright',
  'site-packages', 'target', 'test', 'tests', 'vendor', 'venv',
];

const ENGINE_PRUNED: string[] = [...new Set(
  [...currentDirLayoutTable().pruned, ...currentDirLayoutTable().testLayout]
    .map(name => name.replace(/\/+$/, ''))
    .filter(Boolean),
)].sort();

const PRUNED = NET_FIXTURE_DIRS;

/** The one module that must survive: without it the law would pass on a build that found nothing. */
const KEPT = 'mod:netfx/src/kept';

const tempRoots: string[] = [];
afterAll(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function buildFixtureTree(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-prune-net-')));
  tempRoots.push(root);
  const write = (rel: string, content: string): void => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  write('package.json', '{ "name": "netfx", "version": "1.0.0" }\n');
  write('tsconfig.json', '{ "compilerOptions": { "target": "ES2022", "module": "ESNext" }, "include": ["src"] }\n');
  write('src/kept.ts', 'export const kept = 1;\n');

  // One self-contained package per pruned name. Each would mint a module of its own if the walk
  // descended into it, and none of them may reach the snapshot.
  for (const name of PRUNED) {
    write(`${name}/pkg/tsconfig.json`, '{ "compilerOptions": { "target": "ES2022" }, "include": ["src"] }\n');
    write(`${name}/pkg/src/hidden.ts`, 'export const hidden = 1;\n');
    // One candidate per producer, so the template and infra assertions below are answers rather than
    // empty sets that hold whatever the walk does. The template candidate sits under a `templates/`
    // directory because that name is the built-in template producer's anchor: spelled any other way
    // the file is not a candidate at all, and the template assertion below is empty for a reason
    // that has nothing to do with pruning.
    write(`${name}/templates/hidden.j2`, '{% extends "base.html" %}\n');
    write(`${name}/infra/Dockerfile`, 'FROM node:22\n');
  }
  // `env` is claimed on evidence, not on the name: the Python plugin prunes it only inside a
  // virtualenv. The fixture supplies the evidence so this tree stays the "everything prunes" case;
  // the other direction has its own case below.
  write('env/pyvenv.cfg', 'home = /usr/bin\n');
  return root;
}

/** A tree with one package under a conditionally-claimed name, with or without the marker beside it. */
function buildConditionalTree(withMarker: boolean): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-prune-cond-')));
  tempRoots.push(root);
  const write = (rel: string, content: string): void => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  write('package.json', '{ "name": "condfx", "version": "1.0.0" }\n');
  write('tsconfig.json', '{ "compilerOptions": { "target": "ES2022", "module": "ESNext" }, "include": ["src"] }\n');
  write('src/kept.ts', 'export const kept = 1;\n');
  write('env/package.json', '{ "name": "@scope/react-env", "version": "1.0.0" }\n');
  write('env/tsconfig.json', '{ "compilerOptions": { "target": "ES2022" }, "include": ["src"] }\n');
  write('env/src/index.ts', 'export const env = 1;\n');
  if (withMarker) write('env/pyvenv.cfg', 'home = /usr/bin\n');
  return root;
}

async function snapshotOf(root: string, options?: SnapshotOptions) {
  const origLog = console.log;
  console.log = () => {};
  try {
    return await collectRepositoryFactsAsync(root, options);
  } finally {
    console.log = origLog;
    // Every build installs its own plugin set and its own layout table into this isolate. A case
    // that built under a retraction would leave the next one walking by a table it did not ask for.
    await loadPluginSet({ repoRoot: process.cwd(), config: defaultPluginsConfig() });
  }
}

describe('core-laws the pruned set is held by a fixture that contains one of each', () => {
  it('names something to prune', () => {
    // A tree that went empty would make every assertion below pass without asking anything.
    expect(PRUNED.length).toBeGreaterThan(0);
    expect(PRUNED.every(name => !name.includes('/'))).toBe(true);
    expect(new Set(PRUNED).size).toBe(PRUNED.length);
  });

  it('holds a directory for every name the engine prunes', () => {
    // The other direction: a name added to the engine is unguarded until the fixture carries it.
    const uncovered = ENGINE_PRUNED.filter(name => !NET_FIXTURE_DIRS.includes(name));
    expect(uncovered).toEqual([]);
  });

  it('puts a real directory on disk for every name in the set', () => {
    const root = buildFixtureTree();

    for (const name of PRUNED) {
      expect(fs.existsSync(path.join(root, name, 'pkg', 'src', 'hidden.ts'))).toBe(true);
    }
  });

  it('admits exactly the module outside every pruned directory', async () => {
    const root = buildFixtureTree();

    const snapshot = await snapshotOf(root);

    // All three producers in one comparison: a run that leaks reports every leak it has, instead of
    // stopping at the first producer and hiding what the other two did.
    expect({
      modules: snapshot.modules.map(mod => mod.id).sort(),
      templates: (snapshot.templates ?? []).map(tpl => tpl.relPath),
      infra: (snapshot.infraModules ?? []).map(mod => mod.repoRelPath),
    }).toEqual({ modules: [KEPT], templates: [], infra: [] });
  }, 180_000);

  it('states the same thing as a property of every admitted path', async () => {
    const root = buildFixtureTree();

    const snapshot = await snapshotOf(root);

    // Repo-root-relative, derived from the absolute path. `ModuleInfo.pkgRelPath` is relative
    // to the module's PACKAGE, so a module minted inside a pruned directory spells itself
    // `src/hidden.ts` there and carries no trace of the directory that should have hidden it.
    const admittedModules = snapshot.modules.map(mod => path.relative(root, mod.absPath));

    // Measured against the pinned names, not against the predicate that did the pruning: asking the
    // walk's own predicate about a path the walk admitted answers yes by construction, whatever the
    // set holds. Split on both separators because `path.relative` spells the host's.
    const pinned = new Set(PRUNED);
    const throughPruned = admittedModules.filter(
      rel => rel.split(/[/\\]/).some(segment => pinned.has(segment)),
    );
    expect(throughPruned).toEqual([]);

    // Module-producer agreement: every admitted module path is one the shared walk predicate admits.
    // Template/infra agreement is measured by the combined snapshot case above, not claimed here.
    // Compared as text so a disagreement names the path instead of reporting a bare boolean.
    for (const rel of admittedModules) {
      expect(`${rel} walkable=${shouldWalkDiscoveryDir(asRepoRelPath(rel))}`).toBe(`${rel} walkable=true`);
    }
  }, 180_000);

  // ── the catalog path: the net measures the channel the names arrive through, not only the table ──

  it('reports every name that pruned, with the plugin that declared it', async () => {
    const root = buildFixtureTree();

    const snapshot = await snapshotOf(root);

    // A pruned tree and an absent tree look identical everywhere else, so the build says which
    // entries decided. Every fixture name has a directory on disk, so every one of them must
    // appear: a name that pruned silently is the failure this case exists for.
    const reported = new Set((snapshot.layoutSkipped ?? []).map(skip => skip.name));
    expect(PRUNED.filter(name => !reported.has(name))).toEqual([]);
    expect((snapshot.layoutSkipped ?? []).every(skip => skip.stops > 0)).toBe(true);

    // Ownership is joined from the declaration catalog, so the report names the plugin a reader
    // would have to disable — not just the name.
    const bySamPlugin = (snapshot.layoutSkipped ?? []).find(skip => skip.name === '.aws-sam');
    expect(bySamPlugin?.declaredBy).toEqual(['sam']);
  }, 180_000);

  it('claims a conditional name only where the marker is, and keeps the package where it is not', async () => {
    // `env` is a virtualenv in one repository and a published package in the next. Claiming the name
    // outright deletes the second from the graph, which is what this case measures on both trees.
    const withoutMarker = await snapshotOf(buildConditionalTree(false));
    const withMarker = await snapshotOf(buildConditionalTree(true));

    expect(withoutMarker.packages.map(pkg => pkg.name).sort())
      .toEqual(['@scope/react-env', 'condfx']);
    expect(withoutMarker.modules.map(mod => mod.id).sort())
      .toEqual(['mod:@scope/react-env/src', 'mod:condfx/src/kept']);
    expect((withoutMarker.layoutSkipped ?? []).some(skip => skip.name === 'env')).toBe(false);

    expect(withMarker.packages.map(pkg => pkg.name)).toEqual(['condfx']);
    expect(withMarker.modules.map(mod => mod.id)).toEqual(['mod:condfx/src/kept']);
    expect((withMarker.layoutSkipped ?? []).find(skip => skip.name === 'env')?.declaredBy)
      .toEqual(['python']);
  }, 180_000);

  it('stops pruning a name the config retracts', async () => {
    const root = buildFixtureTree();

    // The catalog is the live authority, not a snapshot of it taken at import time: retracting the
    // declaration has to put the tree back. `.aws-sam` is declared by a plugin rather than by the
    // base table, so this exercises the whole channel — package.json declaration, merged catalog,
    // installed table, walk.
    const withRetraction = await snapshotOf(root, {
      plugins: { ...defaultPluginsConfig(), retract: ['dir:.aws-sam'] },
    });

    const admitted = withRetraction.modules.map(mod => path.relative(root, mod.absPath));
    const throughRetracted = admitted.filter(rel => rel.split(/[/\\]/).includes('.aws-sam'));
    expect(throughRetracted.length).toBeGreaterThan(0);
    expect((withRetraction.layoutSkipped ?? []).some(skip => skip.name === '.aws-sam')).toBe(false);

    // Everything else stayed pruned: a retraction names one key, and a build that dropped the whole
    // table would pass the assertion above for the wrong reason.
    const otherPruned = admitted.filter(
      rel => rel.split(/[/\\]/).some(segment => segment !== '.aws-sam' && new Set(PRUNED).has(segment)),
    );
    expect(otherPruned).toEqual([]);
  }, 180_000);
});
