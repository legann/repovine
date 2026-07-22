/**
 * Shell-spawn guard: production and maintainer code spawns children with argv
 * arrays, never through a shell. The two registered shell adapters are the
 * ComSpec fallback in scripts/lib/spawn.cjs and the win32 PowerShell probe in
 * test/helpers/process-probe.ts; everything else in src/, packages/, scripts/,
 * and test/ must stay shell-free. New violations fail this test with file:line.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCAN_DIRS = ['src', 'packages', 'scripts', 'test'];
const EXTENSIONS = new Set(['.ts', '.mjs', '.cjs', '.js']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'fixtures']);

/** Registered shell adapters (repo-relative, POSIX separators). */
const ALLOWLIST = new Set([
  'scripts/lib/spawn.cjs',
  'test/helpers/process-probe.ts',
  // Executes generated hook commands the way the clients themselves do:
  // Cursor/Codex hook commands are shell strings run through a shell
  // (/bin/sh -c on POSIX, ComSpec on win32) — faithful contract reproduction.
  'test/helpers/client-projections.mjs',
]);
const SELF = 'test/unit/mechanics/shell-spawn-guard.test.ts';

// Patterns run against whole-file content, so multi-line calls
// (`spawnSync(\n  'sh', ...)`) cannot evade them.
const PATTERNS: { name: string; re: RegExp }[] = [
  {
    name: 'shell executable spawn',
    re: /(?:spawnSync|spawn|execFileSync|execFile)\(\s*['"`](?:\/bin\/)?(?:sh|bash|zsh|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh)['"`]/g,
  },
  // `shell: true` or a string shell path — both switch spawn into shell mode.
  { name: 'shell option', re: /shell\s*:\s*(?:true|['"`])/g },
  // execSync always runs through a shell. \b keeps `reexecSync(` out while
  // catching both bare `execSync(` and namespaced `cp.execSync(`.
  { name: 'execSync (implicit shell)', re: /\bexecSync\s*\(/g },
  // Importing child_process `exec` (async, implicit shell). execFile/execFileSync
  // do not match (`\bexec\b` requires a non-word char after `exec`).
  {
    name: 'child_process exec import',
    re: /(?:import\s*\{[^}]*\bexec\b[^}]*\}\s*from\s*|(?:const|let|var)\s*\{[^}]*\bexec\b[^}]*\}\s*=\s*require\(\s*)['"](?:node:)?child_process['"]/g,
  },
];

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

test('no shell spawns outside the registered adapters', () => {
  const violations: string[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (ALLOWLIST.has(rel) || rel === SELF) continue;
      const content = fs.readFileSync(file, 'utf-8');
      for (const { name, re } of PATTERNS) {
        re.lastIndex = 0;
        for (let m = re.exec(content); m !== null; m = re.exec(content)) {
          violations.push(`${rel}:${lineOf(content, m.index)} [${name}] ${m[0].split('\n')[0].trim()}`);
        }
      }
    }
  }
  expect(violations).toEqual([]);
});
