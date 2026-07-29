import { compareCodeUnits } from '../ordering.js';

/**
 * The directory-layout table one build walks by.
 *
 * Which directory names a walk refuses to enter, and which of them hold tests, is a property of the
 * ecosystems a build enabled. A repository with no Python plugin has no reason to know what a
 * virtualenv is called, and one that enabled an ecosystem the engine has never heard of must be able
 * to state its own names without an engine release.
 *
 * The table is installed into the isolate whole, the way the plugin set is: a build's layout is what
 * its plugin set declared, and an isolate that runs discovery loads it before the first walk. It is
 * replaced on install, never merged into — a name dropped from a build's plugin set stops pruning in
 * that build, which is the failure mode a process-global registry cannot express.
 *
 * An isolate that installs nothing walks by the base table below, which is why a caller outside a
 * build — `repovine init`, a test, a plugin author's own harness — behaves as it always has.
 */
export interface DirLayoutTable {
  /** Names a walk does not enter: vendored code, build output, tool state. */
  readonly pruned: ReadonlySet<string>;
  /** Names whose contents are tests of the package around them. */
  readonly testLayout: ReadonlySet<string>;
  /**
   * Names in {@link pruned} that only prune when the directory holds one of the listed paths.
   *
   * A name whose meaning is decided by what sits beside it — `env` is a virtualenv in one repository
   * and a package in the next. A conditional name is decided at the directory a walk reaches, where
   * the marker can be looked for; nothing outside a walk can answer it, so the file-acceptance filter
   * leaves conditional names alone rather than guessing from the path.
   */
  readonly prunedWhenContains: ReadonlyMap<string, readonly string[]>;
  /**
   * The filenames that mark a package root, by the id of the plugin that declared them.
   *
   * Where a walk stops and what it stops AT are the same question asked twice, so they are resolved
   * once and travel together: a build's package roots are what its plugin set declared, and the
   * producer reads the answer back from the host instead of holding a second copy of it.
   */
  readonly packageMarkers: ReadonlyMap<string, readonly string[]>;
}

/**
 * Directory names every build prunes, whatever it enabled.
 *
 * What stays here is what no ecosystem owns: the engine's own cache, version control, and the output
 * directory names several unrelated toolchains write. Everything an ecosystem names — `node_modules`,
 * `.venv`, `.aws-sam` — is declared by the plugin for that ecosystem.
 */
const BASE_PRUNED_DIRS: ReadonlySet<string> = new Set([
  '.repovine',
  '.git',
  '.cache',
  'build',
  'out',
  'target',
  'coverage',
  '.env',
  // Go's vendored dependency tree. The Go plugin lives outside this repository, so no bundled plugin
  // can claim the name; a build that enables one declares it and this entry becomes redundant rather
  // than wrong.
  'vendor',
  // Output of two toolchains no bundled plugin covers: the AWS CDK synthesizer and the Serverless
  // Framework. A base entry states that the name is pruned by every build and that its owner arrives
  // with the plugin for that ecosystem — giving it to the SAM plugin would claim a relationship that
  // does not exist.
  'cdk.out',
  '.serverless',
]);

/**
 * Directory names that hold tests in every language, so claimed by no single ecosystem.
 *
 * Membership is by directory name: a repository that marks a test by filename, under a directory no
 * member names, is walked like any other source.
 */
const BASE_TEST_LAYOUT_DIRS: ReadonlySet<string> = new Set([
  'test',
  'tests',
  'e2e',
  '__e2e__',
]);

function ordered(names: Iterable<string>): ReadonlySet<string> {
  return Object.freeze(new Set([...new Set(names)].sort(compareCodeUnits)));
}

/** A name → paths map, deduplicated and ordered on both axes so two equal tables read equal. */
function orderedMarkers(
  markers: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, readonly string[]> {
  const entries = [...markers.entries()]
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([id, names]) => [id, Object.freeze([...new Set(names)].sort(compareCodeUnits))] as const);
  return Object.freeze(new Map(entries));
}

/**
 * The layout every build shares, before its plugins add what their ecosystems name.
 *
 * No package markers: a marker names a package root of one ecosystem, and an engine that shipped one
 * would be discovering packages for a language it does not have a plugin for.
 */
export const BASE_DIR_LAYOUT: DirLayoutTable = Object.freeze({
  pruned: ordered(BASE_PRUNED_DIRS),
  testLayout: ordered(BASE_TEST_LAYOUT_DIRS),
  prunedWhenContains: orderedMarkers(new Map()),
  packageMarkers: orderedMarkers(new Map()),
});

let installed: DirLayoutTable = BASE_DIR_LAYOUT;

/**
 * Install this build's table into the isolate, replacing whatever was there.
 *
 * Replacement rather than merge: two builds in one process must not accumulate each other's
 * ecosystems, and a plugin dropped from the config has to stop pruning immediately.
 */
export function installDirLayoutTable(table: DirLayoutTable): void {
  installed = Object.freeze({
    pruned: ordered(table.pruned),
    testLayout: ordered(table.testLayout),
    prunedWhenContains: orderedMarkers(table.prunedWhenContains),
    packageMarkers: orderedMarkers(table.packageMarkers),
  });
}

/** The marker filenames one plugin's discovery looks for in this build. */
export function packageMarkersFor(pluginId: string): readonly string[] {
  return installed.packageMarkers.get(pluginId) ?? [];
}

/** The table this isolate walks by. */
export function currentDirLayoutTable(): DirLayoutTable {
  return installed;
}
