import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { computeChangedPaths } from '../../../src/agents/change-set.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

describe('computeChangedPaths', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'change-set-'));
    git(repoRoot, ['init', '-q']);
    git(repoRoot, ['config', 'user.email', 'test@example.com']);
    git(repoRoot, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repoRoot, 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repoRoot, 'b.ts'), 'export const b = 1;\n');
    git(repoRoot, ['add', '-A']);
    git(repoRoot, ['commit', '-qm', 'base']);
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  function head(): string {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  }

  it('returns only the files changed between two committed revisions', () => {
    const base = head();
    fs.writeFileSync(path.join(repoRoot, 'b.ts'), 'export const b = 2;\n');
    git(repoRoot, ['add', '-A']);
    git(repoRoot, ['commit', '-qm', 'change b']);
    const changed = computeChangedPaths(repoRoot, base, head());
    expect(changed).not.toBeNull();
    expect(changed!.has('b.ts')).toBe(true);
    expect(changed!.has('a.ts')).toBe(false);
  });

  it('diffs the base against the working tree when head is omitted', () => {
    const base = head();
    fs.writeFileSync(path.join(repoRoot, 'a.ts'), 'export const a = 99;\n'); // uncommitted
    const changed = computeChangedPaths(repoRoot, base);
    expect(changed!.has('a.ts')).toBe(true);
    expect(changed!.has('b.ts')).toBe(false);
  });

  it('returns an empty set when nothing changed between identical revisions', () => {
    const changed = computeChangedPaths(repoRoot, head(), head());
    expect(changed).not.toBeNull();
    expect(changed!.size).toBe(0);
  });

  it('returns null (delta unavailable) rather than empty when there is no base ref', () => {
    expect(computeChangedPaths(repoRoot, undefined)).toBeNull();
    expect(computeChangedPaths(undefined, 'HEAD')).toBeNull();
  });

  it('returns null on a non-git directory or a bad ref rather than throwing', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'not-git-'));
    try {
      expect(computeChangedPaths(plain, 'HEAD')).toBeNull();
      expect(computeChangedPaths(repoRoot, 'no-such-ref-xyz')).toBeNull();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});
