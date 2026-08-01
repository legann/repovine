import { execFileSync } from 'node:child_process';

const GIT_DIFF_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Files changed between two git revisions (commits or tree oids), repository-relative POSIX.
 *
 * `null` means the change-set is UNAVAILABLE — no base ref, a non-git repo, or a git failure.
 * Callers must not fail evidence on `null`: absence leaves the delta unknown, not empty. An empty
 * `Set` is a real answer (nothing changed between the two revisions).
 *
 * The change-set is the base for revision-linked evidence: a change inside an existing module lands
 * its file here, while an untouched module's file does not — which distinguishes "the fix is at this
 * node" from "this node merely exists". Files map back to graph nodes via the compliance layer's
 * file→module resolver, so this returns raw repo-relative paths.
 */
export function computeChangedPaths(
  repoRoot: string | undefined,
  baseRef: string | undefined,
  headRef?: string,
): Set<string> | null {
  if (!repoRoot || !baseRef) return null;
  try {
    const out = execFileSync(
      'git',
      ['-C', repoRoot, 'diff', '--name-only', '--no-ext-diff', '-z', baseRef, ...(headRef ? [headRef] : [])],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: GIT_DIFF_MAX_BUFFER },
    );
    const set = new Set<string>();
    for (const raw of out.split('\0')) {
      const p = raw.trim();
      if (p) set.add(p);
    }
    return set;
  } catch {
    return null;
  }
}
