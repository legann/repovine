import * as fs from 'node:fs';
import * as path from 'node:path';
import { compareCodeUnits } from '../ordering.js';
import { normalizeRelPath, repoRelativePosix } from '../paths.js';
import { toPosixPath } from './module-id.js';

/**
 * The discovery walk, and the two lists that decide where it stops.
 *
 * `discover()` is a full filesystem traversal, and the directories it must not enter are a property
 * of the engine, not of the ecosystem: a producer that pruned its own way puts files in the graph
 * that another producer leaves out, and the same repository then projects differently depending on
 * which plugin found a file first. Both lists and the walk ship here so a plugin declares its
 * language and nothing about repository layout.
 */

/**
 * Engine-owned scan ignores (always applied; not configurable).
 * Segment match on repo-relative paths: engine cache, dependency, build-output,
 * and local tooling artifact directories.
 */
export const REPOVINE_ENGINE_SCAN_IGNORE_PATTERNS = [
  '.repovine',
  '.repovine/',
  '.git',
  '.cache',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.nx',
  '.venv',
  'venv',
  '.env',
  'node_modules',
  'bower_components',
  // Go's vendored dependency tree, the third ecosystem's answer to `node_modules`.
  'vendor',
  '.yarn',
  '.pnpm-store',
  'dist',
  'env',
  'dist-bundled',
  'target',
  'build',
  'out',
  '.aws-sam',
  'coverage',
  'htmlcov',
  'site-packages',
  '__pycache__',
  '.tox',
  '.nox',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.eggs',
] as const;

/** True when a repo-relative path names, or sits under, an engine-ignored directory. */
export function matchesEngineIgnorePath(relPath: string): boolean {
  const norm = normalizeRelPath(relPath);
  for (const fragment of REPOVINE_ENGINE_SCAN_IGNORE_PATTERNS) {
    const q = toPosixPath(fragment).replace(/^\//, '').replace(/\/$/, '');
    if (!q) continue;
    if (norm === q) return true;
    if (norm.startsWith(`${q}/`)) return true;
    if (norm.includes(`/${q}/`) || norm.endsWith(`/${q}`)) return true;
  }
  return false;
}

/**
 * Directory names that hold tests by convention.
 *
 * Membership is by directory name: a repository that marks a test by filename, under a directory no
 * member names, is walked like any other source. The same members are asked of every tree the walk
 * enters. {@link shouldWalkDiscoveryDir} takes a path and nothing else, so the answer does not depend
 * on which language a plugin declared.
 *
 * Separate from the engine ignore list because it answers a separate question: those directories are
 * not build output or dependency trees, they are first-class repository content that the graph
 * deliberately leaves out.
 *
 * Exported from this module and re-exported by no package entry point: the composition net needs the
 * same set the walker prunes by, and a net built from a second copy would miss a name newly added to
 * the walker's set. Removal is caught independently by the net's pinned fixture. A barrel export
 * would freeze this implementation set as plugin-author contract instead.
 */
export const TEST_LAYOUT_DIRS: ReadonlySet<string> = new Set([
  'test', 'tests', '__tests__', '__mocks__', '__snapshots__',
  'e2e', '__e2e__', 'cypress', 'playwright',
]);

/** True when any segment of the repo-relative path is a test-layout directory. */
function hasTestLayoutSegment(relPath: string): boolean {
  return normalizeRelPath(relPath).split('/').some(segment => TEST_LAYOUT_DIRS.has(segment));
}

/**
 * Whether a discovery walker should descend into this repo-relative directory at all: neither an
 * engine-ignored tree nor a test-layout one. Every walker that mints repository content — packages,
 * modules, templates, infra files — asks this, so first-party producers agree on where the walk stops.
 *
 * Agreement holds for the walk, not for acceptance. The post-discovery filter asks only the engine
 * ignore list, so a producer that reports a file under a test-layout directory without consulting this
 * predicate keeps it: the composition net holds the walkers to the same answer, and the acceptance
 * filter is where the two lists still part ways.
 *
 * The engine ignore list is the same one that rejects files, asked one level up: a directory the
 * list names holds nothing the graph wants, so pruning there and rejecting per file give the same
 * answer at a fraction of the readdir calls. Walkers that look for PACKAGE MARKERS rather than
 * source files need this specifically — a `tsconfig.json` under `.venv/` or a `pyproject.toml`
 * under `coverage/` mints a package node whose every module the file filter then rejects, so the
 * repository grows a package with no modules in it.
 *
 * User `scan.exclude` is deliberately not consulted: an exclude pattern narrows what is indexed,
 * and a walker that stopped descending on it could not honour a more specific `scan.include`
 * underneath.
 */
export function shouldWalkDiscoveryDir(relDirPath: string): boolean {
  return !matchesEngineIgnorePath(relDirPath) && !hasTestLayoutSegment(relDirPath);
}

/**
 * Directory entries in a platform-independent order.
 *
 * `fs.readdirSync` returns whatever the filesystem enumerates. ext4 hands back hash order for large
 * directories; NTFS hands back its own case-insensitive Unicode collation, which orders `[`, `(`
 * and `+` AFTER letters where a code-unit comparison puts them before. Graph node insertion follows
 * discovery, so an unsorted read makes node order a property of the host filesystem: the same
 * repository projects differently on Windows and Linux, and a frozen golden captures one host.
 *
 * The comparison is `compareCodeUnits`; callers that re-sort this output use the same comparator.
 */
export function readDirSorted(dir: string): fs.Dirent[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.sort((a, b) => compareCodeUnits(a.name, b.name));
}

/** A file {@link walkRepository} reached. */
export interface WalkedFile {
  /** Absolute host path, as the filesystem spelled it. */
  absPath: string;
  /** Path relative to `repoRoot`, POSIX-normalized — the form the graph compares. */
  relFromRoot: string;
  /** Base name, for an extension or filename test. */
  name: string;
}

export interface WalkRepositoryOptions {
  /**
   * The base the prune predicate measures against, and the base `relFromRoot` is relative to.
   * Defaults to the directory the walk starts at.
   *
   * The two are separate because a walk that starts inside a package still reports paths the graph
   * knows: `relFromRoot` is the form module ids, annotation keys and hashes compare, and only a
   * repo-relative one carries it.
   *
   * The prune rule is measured against the same base, and that has a consequence worth stating: a
   * walk whose `startDir` sits under a directory the ignore list names — `<repoRoot>/build/pkg` —
   * reports the files directly inside it and descends into none of its subdirectories, because
   * every child path still carries the ignored segment. Passing `repoRoot` equal to `startDir` is
   * what a caller wants when the subtree should be walked on its own terms.
   */
  repoRoot?: string;
  /**
   * Called for every file the walk reaches.
   *
   * Entries of one directory come in code-unit order, and a subdirectory is descended AT ITS
   * POSITION in that order rather than after the files beside it. Node insertion follows this
   * sequence, so emitting a directory's files first and recursing afterwards would reorder the
   * graph without changing which files are in it.
   */
  onFile: (file: WalkedFile) => void;
}

/**
 * Walk a directory tree, skipping what the graph never indexes, in an order that does not depend on
 * the host filesystem.
 *
 * A directory that cannot be read is skipped: the walk answers which files are present, and one it
 * cannot enumerate contributes none. Nothing records that it was skipped — a producer has no delivery
 * channel for it, and the engine's refusal vocabulary has no kind for an unreadable tree either, so an
 * absent subtree is indistinguishable from an empty one on every surface.
 */
export function walkRepository(startDir: string, options: WalkRepositoryOptions): void {
  const repoRoot = options.repoRoot ?? startDir;
  const { onFile } = options;

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = readDirSorted(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      const relFromRoot = repoRelativePosix(repoRoot, absPath);
      if (entry.isDirectory()) {
        if (!shouldWalkDiscoveryDir(relFromRoot)) continue;
        walk(absPath);
        continue;
      }
      if (!entry.isFile()) continue;
      onFile({ absPath, relFromRoot, name: entry.name });
    }
  };

  walk(startDir);
}
