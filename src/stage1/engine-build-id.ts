import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Engine-build identity for the Stage-1 snapshot reuse gate.
 *
 * Defined only in development, so a rebuilt engine (or a `.repovine` copied from a different build)
 * is not silently reused. In an installed package it is `undefined` and the reuse gate stays
 * `analysisVersion`-only — an engine upgrade does not force a cold rebuild.
 *
 * Dev signal: `REPOVINE_DEV=1`, or the engine package is a git checkout (`.git` beside its
 * `package.json`; a `node_modules` install has none). In dev the value is a coarse fingerprint of
 * the built `dist/` (relative path + size + mtime), so any rebuild changes it and any unchanged
 * tree keeps it stable.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface EngineBuildIdDeps {
  env: NodeJS.ProcessEnv;
  /** Engine package root (dir holding the engine's package.json), or undefined if not resolvable. */
  packageRoot: string | undefined;
  isGitCheckout: (root: string) => boolean;
  fingerprint: (root: string) => string;
}

/** Pure decision core, injected with IO for testability. */
export function computeEngineBuildId(deps: EngineBuildIdDeps): string | undefined {
  if (!deps.packageRoot) return undefined;
  const isDev = deps.env.REPOVINE_DEV === '1' || deps.isGitCheckout(deps.packageRoot);
  return isDev ? deps.fingerprint(deps.packageRoot) : undefined;
}

/** Reuse-gate predicate: in release (`current` undefined) always match; in dev require equality. */
export function engineBuildMatches(stored: string | undefined, current: string | undefined): boolean {
  return current === undefined ? true : stored === current;
}

function findEnginePackageRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function fingerprintDist(root: string): string {
  const distDir = path.join(root, 'dist');
  const h = crypto.createHash('sha256');
  let count = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!e.name.endsWith('.js')) continue;
      try {
        const st = fs.statSync(full);
        h.update(path.relative(distDir, full));
        h.update('\0');
        h.update(String(st.size));
        h.update('\0');
        h.update(String(st.mtimeMs));
        h.update('\0');
        count++;
      } catch {
        /* skip unreadable entry */
      }
    }
  };
  walk(distDir);
  if (count === 0) return 'dev:no-dist';
  return h.digest('hex').slice(0, 16);
}

let memo: { value: string | undefined } | undefined;

/** Memoized engine-build id for this process. Undefined in an installed package. */
export function currentEngineBuildId(): string | undefined {
  if (memo) return memo.value;
  const value = computeEngineBuildId({
    env: process.env,
    packageRoot: findEnginePackageRoot(HERE),
    isGitCheckout: (root) => fs.existsSync(path.join(root, '.git')),
    fingerprint: fingerprintDist,
  });
  memo = { value };
  return value;
}

/** Test-only: clear the memoized id. */
export function __resetEngineBuildIdMemo(): void {
  memo = undefined;
}
