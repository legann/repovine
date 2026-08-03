import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * True when a `path.relative` result stays at or below its base. `''` is the base itself.
 * A sibling whose name merely starts with dots (`..foo`) stays inside; only a `..` segment
 * or an absolute result (a different Windows drive) leaves.
 */
function staysWithinBase(rel: string): boolean {
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Lexical containment: where the path NAMES a location inside `repoRoot`, ignoring symlinks.
 * This answers "how do I label this path", so it suits messages and cheap pre-filters. Reads
 * are guarded by `isPathInsideRepo`, which resolves symlinks.
 */
export function isLexicallyInsideRepo(repoRoot: string, filePath: string): boolean {
  const root = path.resolve(repoRoot);
  return staysWithinBase(path.relative(root, path.resolve(root, filePath)));
}

/**
 * Containment guard for reads: the bytes `filePath` yields must live inside `repoRoot`.
 *
 * `readFile` follows symlinks, so lexical containment alone admits a committed
 * `src/leak.ts -> /etc/passwd`: it names an in-repo path while serving an out-of-repo file.
 * A path that clears the lexical test is therefore resolved through `realpathSync` and
 * re-tested against the resolved root, which also keeps a root reached through a symlink
 * (macOS `/var -> /private/var`) comparable to its own contents.
 *
 * A relative `filePath` resolves against `repoRoot`.
 *
 * A target that cannot be resolved yields no bytes, so it keeps the lexical verdict and the
 * caller's own read reports the errno — a missing file stays "cannot read", not "outside repo".
 */
export function isPathInsideRepo(repoRoot: string, filePath: string): boolean {
  const root = path.resolve(repoRoot);
  const target = path.resolve(root, filePath);
  if (!staysWithinBase(path.relative(root, target))) return false;

  let realTarget: string;
  try {
    realTarget = fs.realpathSync(target);
  } catch {
    return true;
  }
  try {
    return staysWithinBase(path.relative(fs.realpathSync(root), realTarget));
  } catch {
    return false;
  }
}
