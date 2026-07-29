import { Project, ScriptTarget } from 'ts-morph';
import ts from 'typescript';
import { collectImports } from '../../../packages/plugins/source-typescript/src/imports.js';
import { importDeclarationSpecifier, staticModuleSpecifierText } from '../../../packages/plugins/source-typescript/src/module-specifier.js';

describe('staticModuleSpecifierText', () => {
  it('reads string literals and no-substitution template literals', () => {
    const source = `import a from './a';\nimport b from \`./b\`;`;
    const sf = ts.createSourceFile('t.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const imports = sf.statements.filter(ts.isImportDeclaration);
    expect(staticModuleSpecifierText(imports[0]!.moduleSpecifier)).toBe('./a');
    expect(staticModuleSpecifierText(imports[1]!.moduleSpecifier)).toBe('./b');
  });

  it('returns undefined for computed specifiers', () => {
    const source = `import a from getPath();`;
    const sf = ts.createSourceFile('t.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const imp = sf.statements.find(ts.isImportDeclaration);
    expect(imp).toBeDefined();
    expect(staticModuleSpecifierText(imp!.moduleSpecifier)).toBeUndefined();
  });
});

describe('importDeclarationSpecifier', () => {
  it('matches collectImports for static specifiers', () => {
    const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { target: ScriptTarget.ES2022 } });
    const sf = project.createSourceFile('/virtual/t.ts', `import { z } from \`zod\`;`);
    const imp = sf.getImportDeclarations()[0]!;
    expect(importDeclarationSpecifier(imp)).toBe('zod');
    expect(collectImports(sf.compilerNode, new Map(), [], '/virtual')).toEqual([
      expect.objectContaining({ moduleSpecifier: 'zod', importedNames: ['z'] }),
    ]);
  });
});
