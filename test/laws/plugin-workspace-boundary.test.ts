import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';
import { repoRoot } from './graph-law-helpers.js';

const BUILTIN_PACKAGES = {
  'source-typescript': '@repovine/plugin-source-typescript',
  'source-python': '@repovine/plugin-source-python',
  'iac-sam': '@repovine/plugin-iac-sam',
  'iac-kubernetes': '@repovine/plugin-iac-kubernetes',
  'iac-helm': '@repovine/plugin-iac-helm',
  'iac-terraform': '@repovine/plugin-iac-terraform',
  'iac-vercel': '@repovine/plugin-iac-vercel',
  'iac-dockerfile': '@repovine/plugin-iac-dockerfile',
  'iac-docker-compose': '@repovine/plugin-iac-docker-compose',
} as const;

const DEFAULT_PRESET_DIR = 'default-preset';
const DEFAULT_PRESET_PACKAGE = '@repovine/plugin-default-preset';
const BUILTIN_NAMES = Object.values(BUILTIN_PACKAGES);
const BUILTIN_NAME_SET = new Set<string>(BUILTIN_NAMES);
const ALL_PACKAGE_NAMES = [DEFAULT_PRESET_PACKAGE, ...BUILTIN_NAMES].sort();
const ALL_PACKAGE_DIRS = [DEFAULT_PRESET_DIR, ...Object.keys(BUILTIN_PACKAGES)].sort();

interface PackageManifest {
  name?: string;
  version?: string;
  private?: boolean;
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function* walkTypeScript(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTypeScript(full);
    } else if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)) {
      yield full;
    }
  }
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(from, to);
    else fs.copyFileSync(from, to);
  }
}

function moduleSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specs.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node)
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0]!)
      && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      )
    ) {
      specs.push(node.arguments[0]!.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specs;
}

function relativePosix(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

function escapesPackage(packageDir: string, file: string, spec: string): boolean {
  const target = path.resolve(path.dirname(file), spec);
  const rel = path.relative(packageDir, target);
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

function scanPluginWorkspace(root: string): string[] {
  const pluginsRoot = path.join(root, 'packages', 'plugins');
  const violations: string[] = [];
  const actualDirs = fs.readdirSync(pluginsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  if (JSON.stringify(actualDirs) !== JSON.stringify(ALL_PACKAGE_DIRS)) {
    violations.push(`package dirs: expected ${ALL_PACKAGE_DIRS.join(', ')}, got ${actualDirs.join(', ')}`);
  }

  for (const dirName of ALL_PACKAGE_DIRS) {
    const packageDir = path.join(pluginsRoot, dirName);
    const manifest = readJson<PackageManifest>(path.join(packageDir, 'package.json'));
    const expectedName = dirName === DEFAULT_PRESET_DIR
      ? DEFAULT_PRESET_PACKAGE
      : BUILTIN_PACKAGES[dirName as keyof typeof BUILTIN_PACKAGES];
    if (manifest.name !== expectedName) violations.push(`${dirName}: package name is ${String(manifest.name)}`);
    if (manifest.version !== '0.1.0') violations.push(`${dirName}: version is ${String(manifest.version)}`);
    if (manifest.private !== true) violations.push(`${dirName}: package is not private`);
    const rootExport = manifest.exports?.['.'];
    if (!rootExport || typeof rootExport !== 'object') {
      violations.push(`${dirName}: root package export is missing`);
    } else {
      const conditions = rootExport as Record<string, unknown>;
      if (conditions.import !== './dist/index.js' || conditions.default !== './dist/index.js') {
        violations.push(`${dirName}: root package export must support import and anchored resolution`);
      }
    }

    const dependencyNames = dirName === DEFAULT_PRESET_DIR
      ? Object.keys(manifest.dependencies ?? {}).sort()
      : Object.keys(manifest.peerDependencies ?? {}).sort();
    const expectedDependencies = dirName === DEFAULT_PRESET_DIR
      ? [...BUILTIN_NAMES].sort()
      : ['@repovine/plugin-sdk'];
    if (JSON.stringify(dependencyNames) !== JSON.stringify(expectedDependencies)) {
      violations.push(
        `${dirName}: dependencies expected ${expectedDependencies.join(', ')}, got ${dependencyNames.join(', ')}`,
      );
    }
    if (dirName !== DEFAULT_PRESET_DIR && Object.keys(manifest.dependencies ?? {}).length > 0) {
      violations.push(`${dirName}: runtime dependencies must be empty in the scaffold`);
    }
    for (const dependency of dependencyNames) {
      const version = dirName === DEFAULT_PRESET_DIR
        ? manifest.dependencies?.[dependency]
        : manifest.peerDependencies?.[dependency];
      if (version !== '0.1.0') {
        violations.push(`${dirName}: ${dependency} must stay on first-version line 0.1.0`);
      }
    }

    const srcDir = path.join(packageDir, 'src');
    for (const file of walkTypeScript(srcDir)) {
      for (const spec of moduleSpecifiers(file)) {
        const label = `${relativePosix(pluginsRoot, file)} -> ${spec}`;
        if (path.isAbsolute(spec) || path.win32.isAbsolute(spec)) {
          violations.push(`${label}: absolute import`);
          continue;
        }
        if (spec.startsWith('.')) {
          if (escapesPackage(packageDir, file, spec)) violations.push(`${label}: escapes package boundary`);
          continue;
        }
        if (
          spec === 'repovine'
          || spec.startsWith('repovine/')
          || spec === '@repovine/plugin-sdk/src'
          || spec.startsWith('@repovine/plugin-sdk/src/')
          || spec === '@repovine/plugin-sdk/dist'
          || spec.startsWith('@repovine/plugin-sdk/dist/')
        ) {
          violations.push(`${label}: private engine/SDK path`);
          continue;
        }
        const isPublicSdkImport = spec === '@repovine/plugin-sdk'
          || spec.startsWith('@repovine/plugin-sdk/');
        if (dirName !== DEFAULT_PRESET_DIR && spec.startsWith('@repovine/') && !isPublicSdkImport) {
          violations.push(`${label}: built-in imports another product package`);
          continue;
        }
        if (dirName === DEFAULT_PRESET_DIR && spec.startsWith('@repovine/') && !BUILTIN_NAME_SET.has(spec)) {
          violations.push(`${label}: preset imports a non-built-in product package`);
        }
      }
    }
  }
  return violations;
}

function scanCoreProductImports(root: string): string[] {
  const violations: string[] = [];
  const pluginsRoot = path.join(root, 'packages', 'plugins');
  const productionRoots = [
    path.join(root, 'src'),
    path.join(root, 'packages', 'plugin-sdk', 'src'),
  ];
  for (const productionRoot of productionRoots) {
    if (!fs.existsSync(productionRoot)) continue;
    for (const file of walkTypeScript(productionRoot)) {
      for (const spec of moduleSpecifiers(file)) {
        const productPackage = ALL_PACKAGE_NAMES.find(
          packageName => spec === packageName || spec.startsWith(`${packageName}/`),
        );
        const relativeTarget = spec.startsWith('.')
          ? path.resolve(path.dirname(file), spec)
          : undefined;
        const targetFromPluginsRoot = relativeTarget
          ? path.relative(pluginsRoot, relativeTarget)
          : undefined;
        const reachesPluginWorkspace = targetFromPluginsRoot !== undefined
          && targetFromPluginsRoot !== '..'
          && !targetFromPluginsRoot.startsWith(`..${path.sep}`)
          && !path.isAbsolute(targetFromPluginsRoot);
        if (productPackage || reachesPluginWorkspace) {
          violations.push(
            `${relativePosix(root, file)} -> ${spec}: core/SDK must not activate a product package in Stage 1`,
          );
        }
      }
    }
  }
  return violations;
}

describe('core-laws physical plugin workspace boundary', () => {
  it('has ten private first-version workspaces with only the permitted product dependencies', () => {
    expect(scanPluginWorkspace(repoRoot())).toEqual([]);

    const rootManifest = readJson<{
      workspaces: string[];
      dependencies: Record<string, string>;
      bundleDependencies: string[];
    }>(path.join(repoRoot(), 'package.json'));
    expect(rootManifest.workspaces).toContain('packages/plugins/*');
    expect([...rootManifest.bundleDependencies].sort()).toEqual(ALL_PACKAGE_NAMES);
    expect(
      ALL_PACKAGE_NAMES.map(name => [name, rootManifest.dependencies[name]]),
    ).toEqual(ALL_PACKAGE_NAMES.map(name => [name, '0.1.0']));

    const rootTsconfig = readJson<{ references: Array<{ path: string }> }>(
      path.join(repoRoot(), 'tsconfig.json'),
    );
    const references = new Set(rootTsconfig.references.map(ref => ref.path.replaceAll('\\', '/')));
    for (const dirName of ALL_PACKAGE_DIRS) {
      expect(references.has(`packages/plugins/${dirName}`)).toBe(true);
    }
  });

  it('turns red when a plugin reaches into private core source (kill mutation)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine plugin-boundary ünï-'));
    try {
      const tmpPlugins = path.join(tmpRoot, 'packages', 'plugins');
      fs.mkdirSync(path.dirname(tmpPlugins), { recursive: true });
      copyDirSync(path.join(repoRoot(), 'packages', 'plugins'), tmpPlugins);
      const mutation = path.join(tmpPlugins, 'source-typescript', 'src', '__kill_private_import.ts');
      fs.writeFileSync(mutation, "import model = require('../../../../src/graph/model.js');\n");

      expect(scanPluginWorkspace(tmpRoot)).toContain(
        'source-typescript/src/__kill_private_import.ts -> ../../../../src/graph/model.js: escapes package boundary',
      );
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('keeps product packages out of core and SDK production imports', () => {
    expect(scanCoreProductImports(repoRoot())).toEqual([]);
  });

  it('turns red when core activates the preset (reverse-boundary kill mutation)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine reverse-boundary ünï-'));
    try {
      const coreMutation = path.join(tmpRoot, 'src', '__kill_product_import.ts');
      fs.mkdirSync(path.dirname(coreMutation), { recursive: true });
      fs.writeFileSync(coreMutation, "import '@repovine/plugin-default-preset';\n");
      const sdkMutation = path.join(
        tmpRoot,
        'packages',
        'plugin-sdk',
        'src',
        '__kill_relative_product_import.ts',
      );
      fs.mkdirSync(path.dirname(sdkMutation), { recursive: true });
      fs.writeFileSync(
        sdkMutation,
        "import '../../plugins/default-preset/src/index.js';\n",
      );

      expect(scanCoreProductImports(tmpRoot)).toEqual([
        'src/__kill_product_import.ts -> @repovine/plugin-default-preset: core/SDK must not activate a product package in Stage 1',
        'packages/plugin-sdk/src/__kill_relative_product_import.ts -> ../../plugins/default-preset/src/index.js: core/SDK must not activate a product package in Stage 1',
      ]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('keeps the new preset scaffold inactive while the named legacy bootstraps own production', () => {
    const sourceBootstrap = fs.readFileSync(
      path.join(repoRoot(), 'src', 'stage1', 'source', 'bootstrap.ts'),
      'utf8',
    );
    const iacBootstrap = fs.readFileSync(
      path.join(repoRoot(), 'src', 'stage1', 'iac', 'bootstrap.ts'),
      'utf8',
    );
    const productionBootstrap = sourceBootstrap + iacBootstrap;
    expect(productionBootstrap).toContain('../../source-plugins/typescript/index.js');
    expect(productionBootstrap).toContain('../../source-plugins/python/index.js');
    expect(productionBootstrap).toContain('../../iac-plugins/sam/index.js');
    expect(productionBootstrap).not.toContain('@repovine/plugin-default-preset');
  });
});
