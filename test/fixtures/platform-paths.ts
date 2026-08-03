/**
 * Cross-platform path fixture catalog.
 *
 * Data only — no platform branching. Pure normalization tests consume it on
 * every host OS via `path.win32` / `path.posix`; native integration tests
 * (Windows/macOS CI) consume it against the real filesystem. Semantic
 * assertions over these fixtures land with `src/platform/` (path contract);
 * until then `platform-fixtures.test.ts` guards catalog integrity so later
 * suites inherit well-formed inputs.
 */

/** Two repo-relative paths that differ only by character case. */
export interface CaseCollisionPair {
  a: string;
  b: string;
}

/** Native absolute roots a Windows checkout can live under. */
export const WINDOWS_ABSOLUTE_ROOTS: readonly string[] = [
  'C:\\repo',
  'C:\\Repo With Spaces\\项目',
  'D:\\a\\deeply\\nested\\workdir',
  '\\\\server\\share\\repo',
  '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
];

/** POSIX-normalized repo-relative paths (the persisted ID form): forward
 * slashes only, never absolute. Includes spaces and non-ASCII segments. */
export const POSIX_REPO_RELATIVE: readonly string[] = [
  'src/index.ts',
  'src/deep/nested/module/impl.ts',
  'docs/自述 文件.md',
  'a b/c d.spec.ts',
  'süß/emoji-📦/mod.ts',
];

/** Inputs mixing separators, as produced by naive string concatenation on
 * Windows. Normalization must map each to its POSIX form. */
export const MIXED_SEPARATOR_INPUTS: readonly { input: string; posix: string }[] = [
  { input: 'src\\cli\\init.ts', posix: 'src/cli/init.ts' },
  { input: 'src/cli\\templates.ts', posix: 'src/cli/templates.ts' },
  { input: 'a b\\项目\\mod.ts', posix: 'a b/项目/mod.ts' },
];

/** A repo-relative path whose joined native length exceeds the Windows
 * default MAX_PATH (260) even under a short root. */
export const LONG_REPO_RELATIVE: string = Array.from({ length: 5 }, (_, i) => `${'segment'.repeat(8)}-${i}`).join(
  '/',
);

/** Distinct committed paths that collide on a case-insensitive filesystem
 * (APFS default, NTFS). The scanner must diagnose these, never silently pick one. */
export const CASE_COLLISIONS: readonly CaseCollisionPair[] = [
  { a: 'src/App.ts', b: 'src/app.ts' },
  { a: 'lib/Utils/index.ts', b: 'lib/utils/index.ts' },
];

/** Windows reserved device names: invalid as file/dir basenames on win32. */
export const WINDOWS_RESERVED_NAMES: readonly string[] = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT1'];

/** Sibling-by-prefix pairs: the second is NOT contained in the first even
 * though it starts with the same characters. Containment must compare whole
 * segments, never raw string prefixes. */
export const SIBLING_PREFIX_PAIRS: readonly { root: string; sibling: string }[] = [
  { root: '/home/dev/repo', sibling: '/home/dev/repo-backup' },
  { root: 'C:\\work\\repo', sibling: 'C:\\work\\repovine' },
];
