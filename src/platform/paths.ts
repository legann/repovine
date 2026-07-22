import * as path from 'node:path';

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
