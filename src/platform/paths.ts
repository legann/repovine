import { toPosixPath, hostPathKey, repoRelativePosix, normalizeRelPath, lastPathSegment } from '@repovine/plugin-sdk';

/**
 * The path vocabulary, read from one module.
 *
 * Five of these are declared in the SDK: a producer reports paths the engine compares as bytes and
 * reads maps the engine keyed, so both sides need the same spelling, and only the SDK is reachable
 * from an installed plugin. They are re-exported here so engine callers still read the whole
 * vocabulary from one place. Callers holding a value that is already POSIX still route through
 * `toPosixPath`: the call is what says "this string is about to become identity".
 *
 * `hostPathKey` is resolver/map identity only. Security-sensitive containment (harness attach
 * path-overlap) keeps its own strict case-sensitive comparison and must not adopt that relaxed
 * form. A path outside the root answers `repoRelativePosix` with the `..` segments `path.relative`
 * produces; containment is the caller's question, and `src/fs/containment.ts` is where it is asked.
 */
export { toPosixPath, hostPathKey, repoRelativePosix, normalizeRelPath, lastPathSegment };

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

/**
 * Canonical-keyed view of an absolute-path→id map. Declared in the SDK beside the resolve ladder
 * that reads through it: the map reaches a producer keyed however its own producer spelled paths,
 * so the fold has to be the same function on both sides — and one memo, not two, or a resolver and
 * the engine would each pay the O(n) pass.
 */
export { hostKeyedView } from '@repovine/plugin-sdk';
