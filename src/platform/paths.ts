import * as path from 'node:path';
import { toPosixPath } from '@repovine/plugin-sdk';

/**
 * Host-path key contract.
 *
 * Persisted repo-relative identity is POSIX-normalized at its producers. In-memory
 * maps keyed by ABSOLUTE host paths canonicalize through `hostPathKey`: producers
 * legitimately disagree on form — tsconfig enumeration (`ts.parseJsonConfigFileContent`),
 * ts-morph `sf.fileName`, and `ts.resolveModuleName` emit forward-slash absolutes while
 * filesystem walkers emit native ones — and on win32 NTFS lookups are case-insensitive.
 * `path.resolve` unifies separators and drive-qualifies; win32 additionally case-folds.
 *
 * Scope: resolver/map identity only. Security-sensitive containment (harness attach
 * path-overlap) keeps its own strict case-sensitive comparison and must not adopt this
 * relaxed form.
 */
export function hostPathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Separator normalization, and nothing else. Declared in the SDK beside the module-id mint, which
 * is the first thing that needs it, and re-exported here so engine callers read the whole path
 * vocabulary from one module. Callers holding a value that is already POSIX still route through it:
 * the call is what says "this string is about to become identity".
 */
export { toPosixPath } from '@repovine/plugin-sdk';

/**
 * Repo-relative POSIX path of an absolute path.
 *
 * `absPath === root` answers `''` — the empty relative path. `path.relative` already returns
 * normalized output, so no second normalization pass is needed; `path.normalize('')` would turn
 * that empty answer into `'.'`, which is why the pass is absent rather than merely unnecessary.
 * A path outside the root answers with the `..` segments `path.relative` produces; containment is
 * the caller's question, and `src/fs/containment.ts` is where it is asked.
 */
export function repoRelativePosix(root: string, absPath: string): string {
  return toPosixPath(path.relative(root, absPath));
}

/**
 * Case-folded POSIX form, for matching a path against a vocabulary of names.
 *
 * A match key, never an identity: `pathMatchKey` folds case on every platform, so two files that
 * differ only by case answer the same key and neither key names either file. Heuristics that ask
 * "does this path look like a test / a controller / build output" compare against lowercase
 * vocabularies and want that. Anything that ends up in a node id, an annotation key, or a hash
 * takes {@link repoRelativePosix} instead. {@link hostPathKey} is the third neighbour: it folds
 * case only on win32, because there the filesystem does.
 */
export function pathMatchKey(value: string): string {
  return toPosixPath(value).toLowerCase();
}

/**
 * A repo-relative path reduced to the form glob matching and map keys compare: POSIX separators,
 * runs of `/` collapsed, no leading `/`. Dot segments are left alone — see {@link resolveRelPath}.
 */
export function normalizeRelPath(value: string): string {
  return toPosixPath(value).replace(/\/+/g, '/').replace(/^\//, '');
}

/**
 * {@link normalizeRelPath} with `.` dropped and `..` resolved against the segments before it.
 *
 * The separate name is the point: a path resolved this way answers "which file is this", while the
 * unresolved form answers "does this string match the pattern the user wrote". A config glob is
 * matched against what the user typed, so `a/../b` stays `a/../b` there and becomes `b` here.
 * `..` beyond the first segment is dropped, so the result never escapes the root it is relative to.
 */
export function resolveRelPath(value: string): string {
  const out: string[] = [];
  for (const segment of normalizeRelPath(value).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

const hostKeyedViews = new WeakMap<Map<string, string>, Map<string, string>>();
const hostKeyedViewSizes = new WeakMap<Map<string, string>, number>();

/**
 * Canonical-keyed view of an absolute-path→id map. Built once per source Map
 * instance (WeakMap memo, invalidated when the source size changes): one O(n)
 * pass per stage-1 worker, not per import. The source map is expected to be
 * construction-frozen; the size guard catches append-after-build drift.
 *
 * A fold collision between DIFFERENT module ids (two committed paths differing
 * only by case/separators) keeps the first entry and warns: that repo builds
 * different graphs on case-sensitive vs case-insensitive filesystems, and the
 * scanner-level case-collision diagnostic is the durable answer.
 */
export function hostKeyedView(m: Map<string, string>): Map<string, string> {
  let view = hostKeyedViews.get(m);
  if (!view || hostKeyedViewSizes.get(m) !== m.size) {
    view = new Map<string, string>();
    for (const [k, v] of m) {
      const key = hostPathKey(k);
      const existing = view.get(key);
      if (existing === undefined) {
        view.set(key, v);
      } else if (existing !== v) {
        console.warn(
          `repovine: path identity collision after case/separator folding: "${k}" maps to ${v} but an earlier entry claimed ${existing}; keeping the first. ` +
            'Two committed paths differing only by case build different graphs on case-sensitive vs case-insensitive filesystems.',
        );
      }
    }
    hostKeyedViews.set(m, view);
    hostKeyedViewSizes.set(m, m.size);
  }
  return view;
}
