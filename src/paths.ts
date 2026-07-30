import * as fs from 'node:fs';
import * as path from 'node:path';
import { packageMarkersFor } from '@repovine/plugin-sdk';
import { BASE_DIR_LAYOUT, currentDirLayoutTable } from '@repovine/plugin-sdk/internal';

function readPackageName(packageJsonPath: string): string | undefined {
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')).name;
  } catch {
    return undefined;
  }
}

export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

function findPackageRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const packageJsonPath = path.join(dir, 'package.json');
    if (readPackageName(packageJsonPath) === 'repovine') return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function resolvePackageRoot(cwd = process.cwd(), entrypoint = process.argv[1]): string {
  const candidates = [
    entrypoint ? path.dirname(fs.existsSync(entrypoint) ? fs.realpathSync(entrypoint) : path.resolve(entrypoint)) : undefined,
    cwd,
    path.join(cwd, 'repovine'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const root = findPackageRoot(candidate);
    if (root) return root;
  }
  return cwd;
}

/** Workspace config filename (mirrors CONFIG_FILENAME in config.ts; local literal avoids an import cycle). */
const WORKSPACE_CONFIG_FILENAME = 'repovine.config.json';

/**
 * First directory from `startDir` upward (inclusive) carrying a workspace
 * config, bounded by the enclosing git repo: the repo top is checked, nothing
 * above it. Returns undefined when no configured directory exists within the
 * boundary.
 */
export function findWorkspaceRootWithin(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, WORKSPACE_CONFIG_FILENAME))) return dir;
    if (fs.existsSync(path.join(dir, '.git'))) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Workspace root resolution order:
 * 1. REPOVINE_ROOT env var (explicit override; a relative value resolves against cwd)
 * 2. Otherwise the nearest ancestor of cwd holding .git
 * 3. cwd, when no ancestor holds .git
 *
 * A resolved root that carries no repovine.config.json is then subject to
 * upward workspace discovery bounded by the enclosing git repo: a configured
 * ancestor wins over silently onboarding a nested directory inside an already
 * onboarded workspace (the session-cwd foot-gun — e.g. REPOVINE_ROOT="." with
 * the process started in a subdirectory). The re-root is reported on stderr.
 */
export function resolveWorkspaceRoot(
  envRoot = process.env.REPOVINE_ROOT,
  cwd = process.cwd(),
): string {
  const requested = envRoot ? path.resolve(cwd, envRoot) : findRepoRoot(cwd);
  const discovered = findWorkspaceRootWithin(requested);
  if (discovered !== undefined && discovered !== requested) {
    console.error(
      `repovine: ${requested} carries no ${WORKSPACE_CONFIG_FILENAME}; rooting at the configured ancestor ${discovered} `
      + 'instead of onboarding a nested workspace. Point REPOVINE_ROOT at an onboarded root to pin explicitly.',
    );
    return discovered;
  }
  return requested;
}

export const repoRoot = resolveWorkspaceRoot();

export const packageRoot = resolvePackageRoot();

/** Workspace artifacts directory name (under repo root). */
export const ARTIFACTS_DIR_NAME = '.repovine';

/** Domain inference and grouping config filename at workspace root. */
export const DOMAINS_CONFIG_FILENAME = 'repovine.domains.json';

/** Shared semantic annotations at workspace root (commit with the repo). */
export const ANNOTATIONS_FILENAME = 'repovine.annots.json';

/**
 * Where this build's walk stops, and what it stops at. Declared in the SDK beside the discovery walk
 * that applies it: a producer prunes by the same table the engine does, and re-exported here so
 * engine callers read the scan vocabulary from one module. `BASE_DIR_LAYOUT` is what every build
 * shares; the installed table adds what this build's plugins declared, including the package markers
 * each source plugin discovers by.
 */
export { BASE_DIR_LAYOUT, currentDirLayoutTable, packageMarkersFor };

export function domainsConfigFilePath(repoRoot: string): string {
  return path.join(repoRoot, DOMAINS_CONFIG_FILENAME);
}

/**
 * Resolve the on-disk annotations file from a repo-root-relative path.
 * Rejects absolute paths and paths that escape the workspace root.
 */
export function resolveAnnotationsFilePath(repoRoot: string, relativePath: string): string {
  const trimmed = relativePath.trim();
  if (!trimmed) {
    throw new Error('workspace.annotationsFile must be a non-empty repo-root-relative path');
  }
  if (path.isAbsolute(trimmed)) {
    throw new Error('workspace.annotationsFile must be repo-root-relative, not absolute');
  }
  const normalized = path.normalize(trimmed);
  const absolute = path.resolve(repoRoot, normalized);
  const rel = path.relative(repoRoot, absolute);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('workspace.annotationsFile must stay within the repository root');
  }
  return absolute;
}

/** All engine artifacts live under {workspaceRoot}/.repovine/ */
export const artifactsDir = path.join(repoRoot, ARTIFACTS_DIR_NAME);

/**
 * Cache dir for a SPECIFIC artifacts dir (per-repoRoot). Use this — not the process-global
 * `cacheDir` const — whenever a component may operate on a repo other than the workspace root
 * (e.g. a ProjectContext built for a fixture/sub-repo). The const resolves against the process
 * workspace, so using it for a different repoRoot writes the snapshot cache to the wrong place.
 */
export function cacheDirFor(artifactsDir: string): string {
  return path.join(artifactsDir, '.cache');
}

/** Cache dir for snapshot and graph dumps (process workspace root). */
export const cacheDir = cacheDirFor(artifactsDir);
