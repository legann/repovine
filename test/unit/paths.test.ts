/**
 * Tests for workspace root resolution logic in paths.ts.
 * Tests the exported root-resolution helpers plus the module-level derived paths.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  ARTIFACTS_DIR_NAME,
  ANNOTATIONS_FILENAME,
  artifactsDir,
  cacheDir,
  currentDirLayoutTable,
  repoRoot,
  resolveAnnotationsFilePath,
  resolveWorkspaceRoot,
} from '../../src/paths.js';

describe('resolveWorkspaceRoot', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns REPOVINE_ROOT when env var is set', () => {
    const target = path.join(tmpDir, 'my-project');
    fs.mkdirSync(target);
    const result = resolveWorkspaceRoot(target, '/some/other/dir');
    expect(result).toBe(target);
  });

  it('resolves relative REPOVINE_ROOT against the provided cwd', () => {
    const result = resolveWorkspaceRoot('./relative/path', tmpDir);
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toBe(path.join(tmpDir, 'relative', 'path'));
  });

  it('returns cwd when it contains .git', () => {
    fs.mkdirSync(path.join(tmpDir, '.git'));
    const result = resolveWorkspaceRoot(undefined, tmpDir);
    expect(result).toBe(tmpDir);
  });

  it('walks up from cwd to find .git in parent', () => {
    fs.mkdirSync(path.join(tmpDir, '.git'));
    const nested = path.join(tmpDir, 'src', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    const result = resolveWorkspaceRoot(undefined, nested);
    expect(result).toBe(tmpDir);
  });

  it('falls back to cwd when .git not found anywhere', () => {
    const noGitDir = path.join(tmpDir, 'no-git-here');
    fs.mkdirSync(noGitDir);
    const result = resolveWorkspaceRoot(undefined, noGitDir);
    expect(result).toBe(noGitDir);
  });
});

// A root without repovine.config.json re-roots to a configured ancestor within
// the same git repo — REPOVINE_ROOT="." started in a subdirectory must not
// silently onboard a nested workspace inside an onboarded one.
describe('upward workspace discovery', () => {
  let tmpDir: string;

  const repo = (withConfig: boolean) => {
    const root = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
    fs.mkdirSync(path.join(root, '.git'));
    if (withConfig) fs.writeFileSync(path.join(root, 'repovine.config.json'), '{}\n');
    const nested = path.join(root, 'examples', 'demo');
    fs.mkdirSync(nested, { recursive: true });
    return { root, nested };
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-discovery-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('re-roots an explicit configless subdirectory to the configured repo top', () => {
    const { root, nested } = repo(true);
    expect(resolveWorkspaceRoot(nested, '/unused')).toBe(root);
  });

  it('re-roots REPOVINE_ROOT="." resolved against a subdirectory cwd', () => {
    const { root, nested } = repo(true);
    expect(resolveWorkspaceRoot('.', nested)).toBe(root);
  });

  it('keeps the requested root when it carries its own config', () => {
    const { nested } = repo(true);
    fs.writeFileSync(path.join(nested, 'repovine.config.json'), '{}\n');
    expect(resolveWorkspaceRoot(nested, '/unused')).toBe(nested);
  });

  it('keeps the requested root when no ancestor inside the repo has a config', () => {
    const { nested } = repo(false);
    expect(resolveWorkspaceRoot(nested, '/unused')).toBe(nested);
  });

  it('never crosses a nested git-repo boundary toward an outer workspace', () => {
    const { root } = repo(true);
    const inner = path.join(root, 'vendor', 'inner-repo');
    fs.mkdirSync(path.join(inner, '.git'), { recursive: true });
    const innerDir = path.join(inner, 'src');
    fs.mkdirSync(innerDir);
    expect(resolveWorkspaceRoot(innerDir, '/unused')).toBe(innerDir);
  });

  it('a linked worktree (.git FILE) is its own boundary — the sandbox fan-out shape', () => {
    const { root } = repo(true);
    const worktree = path.join(root, '.worktrees', 'backend');
    fs.mkdirSync(worktree, { recursive: true });
    // CRLF pointer content on purpose: Git for Windows checkouts can carry it,
    // and repo-root detection must not depend on the pointer's line ending.
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(root, '.git', 'worktrees', 'backend')}\r\n`);
    expect(resolveWorkspaceRoot(worktree, '/unused')).toBe(worktree);
  });
});

describe('derived paths', () => {
  it('artifactsDir is derived from the resolved repoRoot', () => {
    expect(artifactsDir).toBe(path.join(repoRoot, ARTIFACTS_DIR_NAME));
  });

  it('cacheDir is derived from artifactsDir', () => {
    expect(cacheDir).toBe(path.join(artifactsDir, '.cache'));
  });
});

describe('the installed directory-layout table', () => {
  it('names dependency, build-output and tooling trees, and never the workspace itself', () => {
    // The bundled preset is installed by the test setup, so this is the table a default build walks
    // by: the base every build shares plus what the bundled plugins declared.
    const pruned = [...currentDirLayoutTable().pruned];
    expect(pruned).not.toContain('repovine');
    expect(pruned).toEqual(expect.arrayContaining([
      'node_modules',
      // The third ecosystem's dependency tree, beside npm's and Python's.
      'vendor',
      'dist',
      'target',
      'build',
      'out',
      'coverage',
      '.next',
    ]));
  });
});

describe('resolveAnnotationsFilePath', () => {
  it('resolves repo-root-relative paths', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-annot-'));
    try {
      expect(resolveAnnotationsFilePath(tmpDir, 'docs/repovine/annots.json'))
        .toBe(path.join(tmpDir, 'docs/repovine/annots.json'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects absolute paths', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-annot-abs-'));
    try {
      expect(() => resolveAnnotationsFilePath(tmpDir, '/tmp/repovine.annots.json')).toThrow(/repo-root-relative/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects paths that escape the repo root', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-annot-escape-'));
    try {
      expect(() => resolveAnnotationsFilePath(tmpDir, '../../outside.json')).toThrow(/within the repository root/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('resolveAnnotationsFilePath default basename', () => {
  it('resolves under repo root', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-annot-'));
    try {
      expect(resolveAnnotationsFilePath(tmpDir, ANNOTATIONS_FILENAME))
        .toBe(path.join(tmpDir, 'repovine.annots.json'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
