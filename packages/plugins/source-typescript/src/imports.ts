import ts from 'typescript';
import type { ImportInfo, PackageInfo, ReExportInfo } from '@repovine/plugin-sdk';
import { staticModuleSpecifierText } from './module-specifier.js';
import { resolveSpecifierFromMap, type PathsContext } from './resolve-specifier.js';

/**
 * Walk a SourceFile's top-level statements and extract every static `import` declaration.
 * Uses the raw TypeScript AST (`ts.SourceFile` + `ts.forEachChild` / `ts.is*` predicates)
 * to bypass the ts-morph wrapper. Module specifier resolution goes through the string-based
 * shortcut only — no ts-morph resolver, no transitive Project loads.
 */
export function collectImports(
  sf: ts.SourceFile,
  absPathToId: Map<string, string>,
  packages: PackageInfo[],
  repoRoot: string,
  pathsContext?: PathsContext,
): ImportInfo[] {
  const result: ImportInfo[] = [];
  const importingFilePath = sf.fileName;

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const specifier = staticModuleSpecifierText(stmt.moduleSpecifier);
    if (specifier === undefined) continue;
    const importClause = stmt.importClause;
    const isTypeOnly = importClause?.isTypeOnly ?? false;

    const defaultImport = importClause?.name?.text;
    let namespaceImport: string | undefined;
    const namedImports: string[] = [];

    const bindings = importClause?.namedBindings;
    if (bindings) {
      if (ts.isNamespaceImport(bindings)) {
        namespaceImport = bindings.name.text;
      } else if (ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          namedImports.push(el.name.text);
        }
      }
    }

    const importedNames = [
      ...(defaultImport ? [defaultImport] : []),
      ...(namespaceImport ? [`* as ${namespaceImport}`] : []),
      ...namedImports,
    ];

    let resolvedModuleId: string | undefined;
    let isExternal = false;
    const shortcut = resolveSpecifierFromMap(
      specifier,
      importingFilePath,
      absPathToId,
      packages,
      repoRoot,
      pathsContext,
    );
    if (shortcut) {
      resolvedModuleId = shortcut.resolvedModuleId;
      isExternal = shortcut.isExternal;
    }

    result.push({
      moduleSpecifier: specifier,
      resolvedModuleId,
      importedNames,
      isTypeOnly,
      isExternal,
    });
  }

  return result;
}

/**
 * Walk a SourceFile's top-level `export … from '…'` declarations — barrel re-exports. `export * from`
 * is a star re-export (whole surface); `export { a, b } from` re-exports named symbols (the
 * re-exported name, not the source name for aliases). `export * as ns from` re-exports the module
 * under one name. Module specifier resolution reuses the import shortcut. Plain `export { a }`
 * (no `from`) is a local export, not a re-export, and is skipped.
 */
export function collectReExports(
  sf: ts.SourceFile,
  absPathToId: Map<string, string>,
  packages: PackageInfo[],
  repoRoot: string,
  pathsContext?: PathsContext,
): ReExportInfo[] {
  const result: ReExportInfo[] = [];
  const importingFilePath = sf.fileName;

  for (const stmt of sf.statements) {
    if (!ts.isExportDeclaration(stmt)) continue;
    if (!stmt.moduleSpecifier) continue; // local `export { a }` — not a re-export.
    const specifier = staticModuleSpecifierText(stmt.moduleSpecifier);
    if (specifier === undefined) continue;

    let isStar = false;
    let names: string[] | undefined;
    const clause = stmt.exportClause;
    if (!clause) {
      isStar = true; // export * from '…'
    } else if (ts.isNamespaceExport(clause)) {
      names = [clause.name.text]; // export * as ns from '…'
    } else if (ts.isNamedExports(clause)) {
      names = clause.elements.map(el => el.name.text); // re-exported name (alias target)
    }

    let resolvedModuleId: string | undefined;
    let isExternal = false;
    const shortcut = resolveSpecifierFromMap(
      specifier, importingFilePath, absPathToId, packages, repoRoot, pathsContext,
    );
    if (shortcut) {
      resolvedModuleId = shortcut.resolvedModuleId;
      isExternal = shortcut.isExternal;
    }

    result.push({
      moduleSpecifier: specifier,
      resolvedModuleId,
      ...(names ? { names } : {}),
      isStar,
      isExternal,
    });
  }

  return result;
}
