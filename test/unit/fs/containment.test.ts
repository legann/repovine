import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { isLexicallyInsideRepo, isPathInsideRepo } from '../../../src/fs/containment.js';

const tempRoots: string[] = [];

// realpathSync the fixture root: on macOS os.tmpdir() is itself a symlink (/var -> /private/var),
// which would make every containment assertion measure the tmpdir link instead of the fixture.
function tempDir(label: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `repovine-${label}-`)));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

// fs.symlinkSync needs SeCreateSymbolicLinkPrivilege on Windows, where a committed symlink is also
// only materialised as a link under git core.symlinks=true. Gate the fixture, keep the rest running.
const itSymlink = process.platform === 'win32' ? it.skip : it;

describe('isPathInsideRepo', () => {
  it('accepts a real file inside the repo', () => {
    const root = tempDir('containment');
    const file = path.join(root, 'src', 'index.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export const a = 1;\n');
    expect(isPathInsideRepo(root, file)).toBe(true);
  });

  it('accepts the repo root itself', () => {
    const root = tempDir('containment');
    expect(isPathInsideRepo(root, root)).toBe(true);
  });

  it('rejects an absolute path outside the repo', () => {
    const root = tempDir('containment');
    const outside = tempDir('outside');
    expect(isPathInsideRepo(root, path.join(outside, 'secret.txt'))).toBe(false);
  });

  it('rejects a traversal that climbs out of the repo', () => {
    const root = tempDir('containment');
    expect(isPathInsideRepo(root, path.join(root, '..', 'secret.txt'))).toBe(false);
  });

  it('accepts a sibling whose name merely starts with dots', () => {
    const root = tempDir('containment');
    expect(isPathInsideRepo(root, path.join(root, '..config.ts'))).toBe(true);
  });

  it('accepts a path under the repo that does not exist', () => {
    // Nothing to read, so the caller's own read reports ENOENT. Refusing here would report a
    // stale graph entry as an escape.
    const root = tempDir('containment');
    expect(isPathInsideRepo(root, path.join(root, 'src', 'gone.ts'))).toBe(true);
  });

  itSymlink('rejects a symlink inside the repo that resolves outside it', () => {
    // The escape this guard exists for: a committed link names an in-repo path while readFile
    // serves the target.
    const root = tempDir('containment');
    const outside = tempDir('outside');
    const secret = path.join(outside, 'id_rsa');
    fs.writeFileSync(secret, 'PRIVATE KEY\n');
    const link = path.join(root, 'src', 'leak.ts');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(secret, link);

    expect(isLexicallyInsideRepo(root, link)).toBe(true);
    expect(isPathInsideRepo(root, link)).toBe(false);
  });

  itSymlink('accepts a symlink inside the repo that resolves inside it', () => {
    const root = tempDir('containment');
    const real = path.join(root, 'src', 'real.ts');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, 'export const a = 1;\n');
    const link = path.join(root, 'src', 'alias.ts');
    fs.symlinkSync(real, link);
    expect(isPathInsideRepo(root, link)).toBe(true);
  });

  itSymlink('accepts repo contents when the repo root is reached through a symlink', () => {
    const parent = tempDir('containment');
    const real = path.join(parent, 'real-repo');
    fs.mkdirSync(path.join(real, 'src'), { recursive: true });
    fs.writeFileSync(path.join(real, 'src', 'index.ts'), 'export const a = 1;\n');
    const linkedRoot = path.join(parent, 'linked-repo');
    fs.symlinkSync(real, linkedRoot);
    expect(isPathInsideRepo(linkedRoot, path.join(linkedRoot, 'src', 'index.ts'))).toBe(true);
  });

  itSymlink('accepts a dangling symlink inside the repo', () => {
    // An unresolvable target serves no bytes; the read reports ENOENT rather than an escape.
    const root = tempDir('containment');
    const link = path.join(root, 'dangling.ts');
    fs.symlinkSync(path.join(root, 'never-created.ts'), link);
    expect(isPathInsideRepo(root, link)).toBe(true);
  });

  itSymlink('rejects a directory symlink used to reach outside the repo', () => {
    const root = tempDir('containment');
    const outside = tempDir('outside');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET\n');
    fs.symlinkSync(outside, path.join(root, 'vendor'));
    expect(isPathInsideRepo(root, path.join(root, 'vendor', 'secret.txt'))).toBe(false);
  });

  it('resolves a relative path against the repo root, not the process cwd', () => {
    const root = tempDir('containment');
    expect(isPathInsideRepo(root, 'src/index.ts')).toBe(true);
    expect(isPathInsideRepo(root, '../secret.txt')).toBe(false);
  });
});

describe('isLexicallyInsideRepo', () => {
  it('judges names without touching the filesystem', () => {
    const root = path.join(os.tmpdir(), 'repovine-nonexistent-root');
    expect(isLexicallyInsideRepo(root, path.join(root, 'src', 'index.ts'))).toBe(true);
    expect(isLexicallyInsideRepo(root, root)).toBe(true);
    expect(isLexicallyInsideRepo(root, path.join(root, '..', 'outside.ts'))).toBe(false);
  });
});
