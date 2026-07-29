import * as path from 'node:path';
import { toPosixPath } from './source-plugin/module-id.js';

/**
 * The path vocabulary a producer shares with the engine.
 *
 * A plugin reports paths the engine compares as bytes, and looks paths up in maps the engine built,
 * so the spelling has to be one function on both sides. {@link toPosixPath} already ships beside the
 * module-id mint; these six are its neighbours — the repo-relative form that becomes identity, the
 * normalized form patterns match against, the last segment of a POSIX path, the folded form a name
 * vocabulary is matched by, the key an absolute-path map is read by, and the folded view of such a
 * map.
 */

/**
 * Repo-relative POSIX path of an absolute path.
 *
 * `absPath === root` answers `''` — the empty relative path. `path.relative` already returns
 * normalized output, so no second normalization pass is needed; `path.normalize('')` would turn
 * that empty answer into `'.'`, which is why the pass is absent rather than merely unnecessary.
 * A path outside the root answers with the `..` segments `path.relative` produces; containment is
 * the caller's question.
 */
export function repoRelativePosix(root: string, absPath: string): string {
  return toPosixPath(path.relative(root, absPath));
}

/**
 * A repo-relative path reduced to the form glob matching and map keys compare: POSIX separators,
 * runs of `/` collapsed, no leading `/`. Dot segments are left alone: a config glob is matched
 * against what the user typed, so `a/../b` stays `a/../b`.
 */
export function normalizeRelPath(value: string): string {
  return toPosixPath(value).replace(/\/+/g, '/').replace(/^\//, '');
}

/**
 * The last segment of a repo-relative POSIX path.
 *
 * A POSIX question, so `path.basename` is not it: on win32 that function also treats `\` as a
 * separator, and a repo-relative path is already POSIX-normalized at its producers — a backslash
 * surviving into one is a character in a filename, not a boundary. `path.basename` stays where the
 * argument is an absolute host path, which is the form the filesystem hands out.
 *
 * A path ending in `/` answers `''`, and so does the empty path: the segment after the last
 * separator is what was asked for, and there it is empty.
 */
export function lastPathSegment(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf('/') + 1);
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
 * Host-path key contract.
 *
 * Maps keyed by ABSOLUTE host paths canonicalize through this function, and `absPathToId` — the map
 * a producer receives in `extract()` — is one of them. Producers legitimately disagree on form:
 * tsconfig enumeration and TypeScript's own resolver emit forward-slash absolutes while filesystem
 * walkers emit native ones, and on win32 NTFS lookups are case-insensitive. `path.resolve` unifies
 * separators and drive-qualifies; win32 additionally case-folds. A producer that probed the map with
 * a raw `path.join` result would miss whichever form it did not happen to build. The same key belongs
 * on the WRITE side: a producer keying its own `pendingByPath` raw hands the engine two entries for
 * one file on a host whose spelling differs from its own.
 *
 * Scope: resolver/map identity only. Security-sensitive containment keeps its own strict
 * case-sensitive comparison and must not adopt this relaxed form.
 */
export function hostPathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

const hostKeyedViews = new WeakMap<ReadonlyMap<string, string>, Map<string, string>>();
const hostKeyedViewSizes = new WeakMap<ReadonlyMap<string, string>, number>();
const producedViews = new WeakSet<ReadonlyMap<string, string>>();

/**
 * Canonical-keyed view of an absolute-path→id map. Built once per source Map instance (WeakMap memo,
 * invalidated when the source size changes): one O(n) pass per stage-1 worker, not per import. The
 * source map is expected to be construction-frozen; the size guard catches append-after-build drift.
 *
 * `absPathToId` reaches a producer keyed however its own producer spelled paths, so a lookup that
 * did not fold first answers on the spelling rather than on the file.
 *
 * A fold collision between DIFFERENT module ids (two committed paths differing only by
 * case/separators) keeps the first entry and warns: that repo builds different graphs on
 * case-sensitive vs case-insensitive filesystems, and the scanner-level case-collision diagnostic is
 * the durable answer.
 */
export function hostKeyedView(m: ReadonlyMap<string, string>): Map<string, string> {
  // A view is already folded, and folding it again would answer the same but cost a second pass and
  // a second copy of the map. Callers legitimately fold at their entry AND hand the result to a
  // helper that folds defensively — that is what makes the helper safe for a producer that did not.
  if (producedViews.has(m)) return m as Map<string, string>;
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
    producedViews.add(view);
  }
  return view;
}
