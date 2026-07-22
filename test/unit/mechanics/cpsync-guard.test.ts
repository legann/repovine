/**
 * fs.cpSync tripwire: `cpSync` with `recursive: true` fast-fails the whole
 * Node process on windows-latest (STATUS_STACK_BUFFER_OVERRUN, no output)
 * when the tree lives under a path with spaces and non-ASCII segments.
 * test/helpers/client-projections.mjs carries `copyDirSync`
 * (readdir + copyFileSync) as the safe replacement. New call sites fail this
 * test with file:line; the allowlist covers ASCII-only fixture copies that
 * are green on Windows CI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCAN_DIRS = ['src', 'packages', 'scripts', 'test'];
const EXTENSIONS = new Set(['.ts', '.mjs', '.cjs', '.js']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'fixtures']);

/** ASCII-only fixture copies (repo-relative, POSIX separators). */
const ALLOWLIST = new Set([
  'test/unit/stage2/worker-parity.test.ts',
  'test/integration/pooled-python-abort.test.ts',
  'test/unit/stage1/worker-pool.test.ts',
]);
const SELF = 'test/unit/mechanics/cpsync-guard.test.ts';

// Matches `fs.cpSync(` and a bare imported `cpSync(`; `copyDirSync(` carries
// no `cpSync` substring and never matches.
const CPSYNC_RE = /\bcpSync\s*\(/g;

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
      continue;
    }
    if (EXTENSIONS.has(path.extname(entry.name))) yield path.join(dir, entry.name);
  }
}

const lineOf = (content: string, index: number): number => content.slice(0, index).split('\n').length;

test('no fs.cpSync outside the ASCII-fixture allowlist', () => {
  const violations: string[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (ALLOWLIST.has(rel) || rel === SELF) continue;
      const content = fs.readFileSync(file, 'utf-8');
      CPSYNC_RE.lastIndex = 0;
      for (let m = CPSYNC_RE.exec(content); m !== null; m = CPSYNC_RE.exec(content)) {
        violations.push(`${rel}:${lineOf(content, m.index)} — use copyDirSync (test/helpers/client-projections.mjs)`);
      }
    }
  }
  expect(violations).toEqual([]);
});
