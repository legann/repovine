import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ModuleKind, ModuleResolutionKind, type Project } from 'ts-morph';
import {
  createTypeScriptExtractionProject,
} from '../../../../src/source-plugins/typescript/extract.js';
import { collectExports } from '../../../../src/source-plugins/typescript/exports.js';
import { collectSemanticHints } from '../../../../src/source-plugins/typescript/semantic-hints.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function guardedSource(source: string): { project: Project; sourceFile: ReturnType<Project['createSourceFile']>; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-ts-resolution-'));
  roots.push(root);
  const dependencyDir = path.join(root, 'node_modules', 'installed-dep');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(dependencyDir, { recursive: true });
  fs.writeFileSync(path.join(dependencyDir, 'package.json'), JSON.stringify({
    name: 'installed-dep',
    types: 'index.d.ts',
  }));
  fs.writeFileSync(path.join(dependencyDir, 'index.d.ts'), 'export declare const remote: string;\n');
  fs.writeFileSync(path.join(root, 'src', 'local.ts'), 'export const localValue = 1;\n');

  const project = createTypeScriptExtractionProject({
    module: ModuleKind.NodeNext,
    moduleResolution: ModuleResolutionKind.NodeNext,
  });
  const sourceFile = project.createSourceFile(path.join(root, 'src', 'index.ts'), source);
  return { project, sourceFile, root };
}

function loadedInstalledDependencies(project: Project, root: string): string[] {
  const dependencyRoot = path.join(root, 'node_modules') + path.sep;
  return project.getProgram().compilerObject.getSourceFiles()
    .map(sourceFile => path.resolve(sourceFile.fileName))
    .filter(fileName => fileName.startsWith(dependencyRoot));
}

describe('TypeScript node_modules TypeChecker guard', () => {
  it('keeps collectExports from reopening installed dependency declarations', () => {
    const { project, sourceFile, root } = guardedSource(`
      import { localValue } from './local.js';
      import { remote } from 'installed-dep';
      export const local = localValue + remote.length;
    `);

    expect(collectExports(sourceFile).exports.map(entry => entry.name)).toContain('local');
    expect(loadedInstalledDependencies(project, root)).toEqual([]);
    expect(project.getProgram().compilerObject.getSourceFiles().map(file => path.resolve(file.fileName)))
      .toContain(path.join(root, 'src', 'local.ts'));
  });

  it('keeps the semantic-hints getExportedDeclarations path inside the workspace', () => {
    const { project, sourceFile, root } = guardedSource(`
      import type { remote } from 'installed-dep';
      export const loader = (): typeof remote | undefined => undefined;
    `);

    expect(collectSemanticHints(sourceFile)?.ssr?.loader).toBe(true);
    expect(loadedInstalledDependencies(project, root)).toEqual([]);
  });
});
