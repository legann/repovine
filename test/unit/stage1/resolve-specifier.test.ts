import { asHostPath } from '@repovine/plugin-sdk';
import { asRepoRelPath } from '@repovine/plugin-sdk';
import ts from 'typescript';
import * as path from 'node:path';
import { resolveSpecifierFromMap, isNodeModulesPath } from '../../../packages/plugins/source-typescript/src/resolve-specifier.js';
import type { PackageInfo } from '../../../src/types.js';

const REPO = '/repo';

function pkg(name: string, relPath: string): PackageInfo {
  return { name, repoRelDir: asRepoRelPath(relPath)};
}

function map(entries: Array<[string, string]>): Map<string, string> {
  return new Map(entries);
}

describe('resolveSpecifierFromMap — relative specifiers', () => {
  const packages: PackageInfo[] = [pkg('@app/web', 'packages/web')];

  it('resolves ./foo when foo.ts exists', () => {
    const m = map([['/repo/packages/web/src/foo.ts', 'mod:@app/web/src/foo']]);
    const r = resolveSpecifierFromMap('./foo', asHostPath('/repo/packages/web/src/bar.ts'), m, packages, asHostPath(REPO));
    expect(r).toEqual({ resolvedModuleId: 'mod:@app/web/src/foo', isExternal: false });
  });

  it('resolves ./foo when only foo/index.ts exists (directory form)', () => {
    const m = map([['/repo/packages/web/src/foo/index.ts', 'mod:@app/web/src/foo']]);
    const r = resolveSpecifierFromMap('./foo', asHostPath('/repo/packages/web/src/bar.ts'), m, packages, asHostPath(REPO));
    expect(r?.resolvedModuleId).toBe('mod:@app/web/src/foo');
  });

  it('prefers file form over index form when both exist (TS resolver order)', () => {
    const m = map([
      ['/repo/packages/web/src/foo.ts', 'mod:@app/web/src/foo'],
      ['/repo/packages/web/src/foo/index.ts', 'mod:@app/web/src/foo-dir'],
    ]);
    const r = resolveSpecifierFromMap('./foo', asHostPath('/repo/packages/web/src/bar.ts'), m, packages, asHostPath(REPO));
    expect(r?.resolvedModuleId).toBe('mod:@app/web/src/foo');
  });

  it('strips NodeNext .js extension to match .ts source', () => {
    const m = map([['/repo/packages/web/src/foo.ts', 'mod:@app/web/src/foo']]);
    const r = resolveSpecifierFromMap('./foo.js', asHostPath('/repo/packages/web/src/bar.ts'), m, packages, asHostPath(REPO));
    expect(r?.resolvedModuleId).toBe('mod:@app/web/src/foo');
  });

  it('strips .jsx for .tsx source', () => {
    const m = map([['/repo/packages/web/src/Button.tsx', 'mod:@app/web/src/Button']]);
    const r = resolveSpecifierFromMap('./Button.jsx', asHostPath('/repo/packages/web/src/bar.ts'), m, packages, asHostPath(REPO));
    expect(r?.resolvedModuleId).toBe('mod:@app/web/src/Button');
  });

  it('returns undefined when a relative specifier does not resolve via the map', () => {
    const m = map([['/repo/packages/web/src/foo.ts', 'mod:@app/web/src/foo']]);
    const r = resolveSpecifierFromMap('./nope', asHostPath('/repo/packages/web/src/bar.ts'), m, packages, asHostPath(REPO));
    expect(r).toBeUndefined();
  });

  it('walks up directories with ../', () => {
    const m = map([['/repo/packages/web/src/shared.ts', 'mod:@app/web/src/shared']]);
    const r = resolveSpecifierFromMap('../shared', asHostPath('/repo/packages/web/src/nested/inner.ts'), m, packages, asHostPath(REPO));
    expect(r?.resolvedModuleId).toBe('mod:@app/web/src/shared');
  });
});

describe('resolveSpecifierFromMap — workspace specifiers', () => {
  const packages: PackageInfo[] = [
    pkg('@app/web', 'packages/web'),
    pkg('@app/shared', 'packages/shared'),
  ];

  it('returns pkg id for bare workspace specifier', () => {
    const m = map([]);
    const r = resolveSpecifierFromMap('@app/shared', asHostPath('/repo/packages/web/src/bar.ts'), m, packages, asHostPath(REPO));
    expect(r).toEqual({ resolvedModuleId: 'pkg:@app/shared', isExternal: false });
  });

  it('resolves a bare workspace specifier to the package root index entry when present', () => {
    const m = map([['/repo/packages/shared/index.ts', 'mod:@app/shared/index']]);
    const r = resolveSpecifierFromMap('@app/shared', asHostPath('/repo/packages/web/src/bar.ts'), m, packages, asHostPath(REPO));
    expect(r).toEqual({ resolvedModuleId: 'mod:@app/shared/index', isExternal: false });
  });

  it('resolves a bare workspace specifier to the src/index entry when there is no root index', () => {
    const m = map([['/repo/packages/shared/src/index.ts', 'mod:@app/shared/src']]);
    const r = resolveSpecifierFromMap('@app/shared', asHostPath('/repo/packages/web/src/bar.ts'), m, packages, asHostPath(REPO));
    expect(r?.resolvedModuleId).toBe('mod:@app/shared/src');
  });

  it('resolves workspace sub-path to specific module when present in map', () => {
    const m = map([['/repo/packages/shared/src/utils.ts', 'mod:@app/shared/src/utils']]);
    const r = resolveSpecifierFromMap('@app/shared/src/utils', asHostPath('/repo/packages/web/src/bar.ts'), m, packages, asHostPath(REPO));
    expect(r?.resolvedModuleId).toBe('mod:@app/shared/src/utils');
  });

  it('falls back to pkg id when workspace sub-path is not in map', () => {
    const m = map([]);
    const r = resolveSpecifierFromMap('@app/shared/src/unknown', asHostPath('/repo/packages/web/src/bar.ts'), m, packages, asHostPath(REPO));
    expect(r).toEqual({ resolvedModuleId: 'pkg:@app/shared', isExternal: false });
  });

  it('strips .js suffix on workspace sub-path', () => {
    const m = map([['/repo/packages/shared/src/utils.ts', 'mod:@app/shared/src/utils']]);
    const r = resolveSpecifierFromMap('@app/shared/src/utils.js', asHostPath('/repo/packages/web/src/bar.ts'), m, packages, asHostPath(REPO));
    expect(r?.resolvedModuleId).toBe('mod:@app/shared/src/utils');
  });

  it('recognizes single-segment package names', () => {
    const ps = [pkg('react-dom', 'packages/react-dom')];
    const r = resolveSpecifierFromMap('react-dom', asHostPath('/repo/packages/web/src/bar.ts'), map([]), ps, asHostPath(REPO));
    expect(r).toEqual({ resolvedModuleId: 'pkg:react-dom', isExternal: false });
  });
});

describe('resolveSpecifierFromMap — external specifiers', () => {
  const packages: PackageInfo[] = [pkg('@app/web', 'packages/web')];

  it('marks unknown scoped packages as external', () => {
    const r = resolveSpecifierFromMap('@vendor/lib', asHostPath('/repo/packages/web/src/bar.ts'), map([]), packages, asHostPath(REPO));
    expect(r).toEqual({ resolvedModuleId: undefined, isExternal: true });
  });

  it('marks unknown bare packages as external', () => {
    const r = resolveSpecifierFromMap('lodash', asHostPath('/repo/packages/web/src/bar.ts'), map([]), packages, asHostPath(REPO));
    expect(r).toEqual({ resolvedModuleId: undefined, isExternal: true });
  });

  it('marks unknown packages with sub-paths as external', () => {
    const r = resolveSpecifierFromMap('lodash/fp', asHostPath('/repo/packages/web/src/bar.ts'), map([]), packages, asHostPath(REPO));
    expect(r).toEqual({ resolvedModuleId: undefined, isExternal: true });
  });
});

describe('resolveSpecifierFromMap — tsconfig paths', () => {
  const packages: PackageInfo[] = [pkg('@app/web', 'packages/web')];
  const pkgAbsPath = path.join(REPO, 'packages/web');
  const pathsContext = {
    compilerOptions: ts.parseJsonConfigFileContent(
      {
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@/*': ['./src/*'],
            '@app-alias': ['./src/alias-target.ts'],
          },
        },
      },
      ts.sys,
      pkgAbsPath,
    ).options,
  };

  it('resolves @/* path alias to a concrete module', () => {
    const m = map([
      ['/repo/packages/web/src/components/error-fallback.tsx', 'mod:@app/web/src/components/error-fallback'],
    ]);
    const importer = '/repo/packages/web/src/app/page.tsx';
    const r = resolveSpecifierFromMap(
      '@/components/error-fallback',
      asHostPath(importer),
      m,
      packages,
      asHostPath(REPO),
      pathsContext,
    );
    expect(r).toEqual({
      resolvedModuleId: 'mod:@app/web/src/components/error-fallback',
      isExternal: false,
    });
  });

  it('resolves @/* path alias to directory index module', () => {
    const m = map([
      ['/repo/packages/web/src/lib/utils/index.ts', 'mod:@app/web/src/lib/utils'],
    ]);
    const r = resolveSpecifierFromMap(
      '@/lib/utils',
      asHostPath('/repo/packages/web/src/app/page.tsx'),
      m,
      packages,
      asHostPath(REPO),
      pathsContext,
    );
    expect(r?.resolvedModuleId).toBe('mod:@app/web/src/lib/utils');
  });

  it('resolves exact path alias key without wildcard', () => {
    const m = map([
      ['/repo/packages/web/src/alias-target.ts', 'mod:@app/web/src/alias-target'],
    ]);
    const r = resolveSpecifierFromMap(
      '@app-alias',
      asHostPath('/repo/packages/web/src/app/page.tsx'),
      m,
      packages,
      asHostPath(REPO),
      pathsContext,
    );
    expect(r?.resolvedModuleId).toBe('mod:@app/web/src/alias-target');
  });

  it('falls through to workspace resolution when path alias does not match', () => {
    const m = map([['/repo/packages/shared/src/utils.ts', 'mod:@app/shared/src/utils']]);
    const sharedPackages = [
      pkg('@app/web', 'packages/web'),
      pkg('@app/shared', 'packages/shared'),
    ];
    const r = resolveSpecifierFromMap(
      '@app/shared/src/utils',
      asHostPath('/repo/packages/web/src/app/page.tsx'),
      m,
      sharedPackages,
      asHostPath(REPO),
      pathsContext,
    );
    expect(r?.resolvedModuleId).toBe('mod:@app/shared/src/utils');
  });

  it('without pathsContext treats @/ specifiers as external', () => {
    const m = map([
      ['/repo/packages/web/src/components/button.tsx', 'mod:@app/web/src/components/button'],
    ]);
    const r = resolveSpecifierFromMap(
      '@/components/button',
      asHostPath('/repo/packages/web/src/app/page.tsx'),
      m,
      packages,
      asHostPath(REPO),
    );
    expect(r).toEqual({ resolvedModuleId: undefined, isExternal: true });
  });
});

describe('isNodeModulesPath — module-resolution guard against node_modules descent', () => {
  it('is true for paths under a node_modules segment', () => {
    expect(isNodeModulesPath('/repo/node_modules/lodash/index.js')).toBe(true);
    expect(isNodeModulesPath('/repo/packages/web/node_modules/@scope/dep/index.d.ts')).toBe(true);
    expect(isNodeModulesPath('/repo/node_modules')).toBe(true); // the bare dir too (fast-fail before descent)
    expect(isNodeModulesPath('C:\\repo\\node_modules\\dep\\index.js')).toBe(true);
  });

  it('is false for ordinary source paths and lookalike segment names', () => {
    expect(isNodeModulesPath('/repo/packages/web/src/foo.ts')).toBe(false);
    expect(isNodeModulesPath('/repo/src/my_node_modules_helper.ts')).toBe(false); // not a bounded segment
    expect(isNodeModulesPath('/repo/src/node_modules_doc.md')).toBe(false);
  });
});
