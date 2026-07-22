/**
 * Guards the cross-platform path fixture catalog (test/fixtures/platform-paths.ts).
 *
 * Well-formedness only: each fixture group must satisfy the structural
 * invariant its consumers assume. Runs identically on every host OS via
 * `path.win32` / `path.posix`. Semantic normalization/containment tests over
 * the same catalog land with `src/platform/`.
 */
import path from 'node:path';

import {
  CASE_COLLISIONS,
  LONG_REPO_RELATIVE,
  MIXED_SEPARATOR_INPUTS,
  POSIX_REPO_RELATIVE,
  SIBLING_PREFIX_PAIRS,
  WINDOWS_ABSOLUTE_ROOTS,
  WINDOWS_RESERVED_NAMES,
} from '../fixtures/platform-paths.js';

describe('platform path fixtures', () => {
  test('windows roots are win32-absolute and not posix-absolute', () => {
    for (const p of WINDOWS_ABSOLUTE_ROOTS) {
      expect(path.win32.isAbsolute(p)).toBe(true);
      expect(path.posix.isAbsolute(p)).toBe(false);
    }
  });

  test('posix repo-relative ids use forward slashes only and are relative', () => {
    for (const p of POSIX_REPO_RELATIVE) {
      expect(p).not.toContain('\\');
      expect(path.posix.isAbsolute(p)).toBe(false);
      expect(p.split('/').every((seg: string) => seg.length > 0)).toBe(true);
    }
  });

  test('mixed-separator inputs map to their declared posix form', () => {
    for (const { input, posix } of MIXED_SEPARATOR_INPUTS) {
      expect(input.split(/[\\/]/).join('/')).toBe(posix);
      expect(posix).not.toContain('\\');
    }
  });

  test('long repo-relative path exceeds the Windows default MAX_PATH', () => {
    expect(LONG_REPO_RELATIVE.length).toBeGreaterThan(260);
    expect(path.posix.isAbsolute(LONG_REPO_RELATIVE)).toBe(false);
  });

  test('case-collision pairs differ only by case', () => {
    for (const { a, b } of CASE_COLLISIONS) {
      expect(a).not.toBe(b);
      expect(a.toLowerCase()).toBe(b.toLowerCase());
    }
  });

  test('reserved names are unique uppercase basenames', () => {
    expect(new Set(WINDOWS_RESERVED_NAMES).size).toBe(WINDOWS_RESERVED_NAMES.length);
    for (const name of WINDOWS_RESERVED_NAMES) {
      expect(name).toBe(name.toUpperCase());
      expect(name).not.toMatch(/[\\/]/);
    }
  });

  test('sibling-prefix pairs share a string prefix without containment', () => {
    for (const { root, sibling } of SIBLING_PREFIX_PAIRS) {
      expect(sibling.startsWith(root)).toBe(true);
      const impl = root.includes('\\') ? path.win32 : path.posix;
      const rel = impl.relative(root, sibling);
      expect(rel.startsWith('..')).toBe(true);
    }
  });
});
