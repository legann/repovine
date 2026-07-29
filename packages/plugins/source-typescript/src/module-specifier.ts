import ts from 'typescript';
import type { ImportDeclaration } from 'ts-morph';

/** Static import/export `from` targets only — skips dynamic or computed specifiers. */
export function staticModuleSpecifierText(specifier: ts.Expression): string | undefined {
  if (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier)) {
    return specifier.text;
  }
  return undefined;
}

/** Read an import specifier without ts-morph's string-literal-only getters (which throw). */
export function importDeclarationSpecifier(imp: ImportDeclaration): string | undefined {
  return staticModuleSpecifierText(imp.compilerNode.moduleSpecifier);
}
