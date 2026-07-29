import { describe, it, expect } from '@jest/globals';
import * as path from 'node:path';
import { resolvePythonImport } from '../../../../packages/plugins/source-python/src/resolve-import.js';
import type { PackageInfo } from '../../../../src/types.js';

const REPO = '/repo';

function pyPkg(name: string, relPath: string): PackageInfo {
  return { name, path: relPath, sourcePluginId: 'python' };
}

function map(entries: Array<[string, string]>): Map<string, string> {
  return new Map(entries);
}

describe('resolvePythonImport', () => {
  const basicPython = pyPkg('basic-python', 'packages/basic-python');
  const otherPkg = pyPkg('otherpkg', 'packages/other');

  const absPathToId = map([
    [path.join(REPO, 'packages/basic-python/app.py'), 'mod:basic-python/app'],
    [path.join(REPO, 'packages/basic-python/models.py'), 'mod:basic-python/models'],
    [path.join(REPO, 'packages/basic-python/utils/__init__.py'), 'mod:basic-python/utils'],
    [path.join(REPO, 'packages/other/otherpkg/util.py'), 'mod:otherpkg/otherpkg/util'],
    [path.join(REPO, 'packages/other/otherpkg/__init__.py'), 'mod:otherpkg/otherpkg'],
  ]);

  it('resolves relative from .sibling', () => {
    const r = resolvePythonImport({
      importingFilePath: path.join(REPO, 'packages/basic-python/app.py'),
      level: 1,
      moduleDotted: 'models',
      kind: 'from',
      absPathToId,
      packages: [basicPython],
      repoRoot: REPO,
      importingPackage: basicPython,
    });
    expect(r).toEqual({ resolvedModuleId: 'mod:basic-python/models', isExternal: false });
  });

  it('resolves relative package via __init__.py', () => {
    const r = resolvePythonImport({
      importingFilePath: path.join(REPO, 'packages/basic-python/app.py'),
      level: 1,
      moduleDotted: 'utils',
      kind: 'from',
      absPathToId,
      packages: [basicPython],
      repoRoot: REPO,
      importingPackage: basicPython,
    });
    expect(r.resolvedModuleId).toBe('mod:basic-python/utils');
    expect(r.isExternal).toBe(false);
  });

  it('marks unresolved relative imports as non-external', () => {
    const r = resolvePythonImport({
      importingFilePath: path.join(REPO, 'packages/basic-python/app.py'),
      level: 1,
      moduleDotted: 'missing',
      kind: 'from',
      absPathToId,
      packages: [basicPython],
      repoRoot: REPO,
      importingPackage: basicPython,
    });
    expect(r).toEqual({ resolvedModuleId: undefined, isExternal: false });
  });

  it('resolves absolute intra-package import (from models import x)', () => {
    const r = resolvePythonImport({
      importingFilePath: path.join(REPO, 'packages/basic-python/services.py'),
      level: 0,
      moduleDotted: 'models',
      kind: 'from',
      absPathToId,
      packages: [basicPython],
      repoRoot: REPO,
      importingPackage: basicPython,
    });
    expect(r).toEqual({ resolvedModuleId: 'mod:basic-python/models', isExternal: false });
  });

  it('resolves absolute cross-package import by package name', () => {
    const importer = path.join(REPO, 'packages/basic-python/app.py');
    const r = resolvePythonImport({
      importingFilePath: importer,
      level: 0,
      moduleDotted: 'otherpkg.util',
      kind: 'from',
      absPathToId,
      packages: [basicPython, otherPkg],
      repoRoot: REPO,
      importingPackage: basicPython,
    });
    expect(r).toEqual({ resolvedModuleId: 'mod:otherpkg/otherpkg/util', isExternal: false });
  });

  it('marks third-party/stdlib imports external', () => {
    const r = resolvePythonImport({
      importingFilePath: path.join(REPO, 'packages/basic-python/app.py'),
      level: 0,
      moduleDotted: 'boto3',
      kind: 'import',
      absPathToId,
      packages: [basicPython],
      repoRoot: REPO,
      importingPackage: basicPython,
    });
    expect(r).toEqual({ resolvedModuleId: undefined, isExternal: true });
  });

  it('resolves relative from ..parent (level 2 walks up one directory)', () => {
    const r = resolvePythonImport({
      importingFilePath: path.join(REPO, 'packages/basic-python/sub/app.py'),
      level: 2,
      moduleDotted: 'models',
      kind: 'from',
      absPathToId,
      packages: [basicPython],
      repoRoot: REPO,
      importingPackage: basicPython,
    });
    // level 2 must walk from packages/basic-python/sub up to packages/basic-python.
    expect(r).toEqual({ resolvedModuleId: 'mod:basic-python/models', isExternal: false });
  });

  it('resolves relative from ...grandparent (level 3 walks up two directories)', () => {
    const r = resolvePythonImport({
      importingFilePath: path.join(REPO, 'packages/basic-python/a/b/app.py'),
      level: 3,
      moduleDotted: 'models',
      kind: 'from',
      absPathToId,
      packages: [basicPython],
      repoRoot: REPO,
      importingPackage: basicPython,
    });
    // level 3 must walk from .../a/b up two levels to packages/basic-python.
    expect(r).toEqual({ resolvedModuleId: 'mod:basic-python/models', isExternal: false });
  });

  it('resolves cross-package import whose distribution name differs by dash/underscore (PEP-503)', () => {
    // Distribution name uses a dash; the import top-level uses an underscore.
    const dashPkg = pyPkg('my-pkg', 'packages/my-pkg');
    const dashMap = map([
      [path.join(REPO, 'packages/my-pkg/my_pkg/util.py'), 'mod:my-pkg/my_pkg/util'],
    ]);
    const r = resolvePythonImport({
      importingFilePath: path.join(REPO, 'packages/basic-python/app.py'),
      level: 0,
      moduleDotted: 'my_pkg.util',
      kind: 'from',
      absPathToId: dashMap,
      packages: [basicPython, dashPkg],
      repoRoot: REPO,
      importingPackage: basicPython,
    });
    // Normalization (dash<->underscore) must match 'my-pkg' distribution to 'my_pkg' import.
    expect(r).toEqual({ resolvedModuleId: 'mod:my-pkg/my_pkg/util', isExternal: false });
  });

  it('resolves cross-package import against a FLAT layout (module directly under package root)', () => {
    // Flat layout: no nested top-level dir; helper.py lives directly under the package root.
    const flatPkg = pyPkg('flatpkg', 'packages/flat');
    const flatMap = map([
      [path.join(REPO, 'packages/flat/helper.py'), 'mod:flatpkg/helper'],
    ]);
    const r = resolvePythonImport({
      importingFilePath: path.join(REPO, 'packages/basic-python/app.py'),
      level: 0,
      moduleDotted: 'flatpkg.helper',
      kind: 'from',
      absPathToId: flatMap,
      packages: [basicPython, flatPkg],
      repoRoot: REPO,
      importingPackage: basicPython,
    });
    // The nested candidate (packages/flat/flatpkg/helper.py) is absent; only the flat fallback resolves.
    expect(r).toEqual({ resolvedModuleId: 'mod:flatpkg/helper', isExternal: false });
  });

  it('resolves import pkg (module form) to package __init__', () => {
    const r = resolvePythonImport({
      importingFilePath: path.join(REPO, 'packages/basic-python/app.py'),
      level: 0,
      moduleDotted: 'otherpkg',
      kind: 'import',
      absPathToId,
      packages: [basicPython, otherPkg],
      repoRoot: REPO,
      importingPackage: basicPython,
    });
    expect(r.resolvedModuleId).toBe('mod:otherpkg/otherpkg');
    expect(r.isExternal).toBe(false);
  });
});
