import { asHostPath } from '@repovine/plugin-sdk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverPackages } from '../../../packages/plugins/source-typescript/src/packages.js';
import { collectRepositoryFactsAsync } from '../../../src/stage1/index.js';
import { packageMarkersFor } from '../../../src/paths.js';

function fixtureRoot(name: string): string {
  const candidates = [
    path.resolve(process.cwd(), 'test', 'fixtures', name),
    path.resolve(process.cwd(), 'repovine', 'test', 'fixtures', name),
  ];
  const root = candidates.find(candidate => fs.existsSync(candidate));
  if (!root) throw new Error(`Could not find fixture ${name}. Tried: ${candidates.join(', ')}`);
  return root;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

describe('stage1 package discovery', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-stage1-packages-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('discovers a repo-owned repovine package without scanning test folders', async () => {
    const packageDir = path.join(tmpDir, 'repovine');
    fs.mkdirSync(path.join(packageDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(packageDir, 'test'), { recursive: true });
    writeJson(path.join(packageDir, 'package.json'), { name: 'repovine', version: '0.1.0' });
    writeJson(path.join(packageDir, 'tsconfig.json'), {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
      },
      include: ['src/**/*.ts', 'test/**/*.ts'],
    });
    fs.writeFileSync(path.join(packageDir, 'src', 'index.ts'), 'export const source = true;\n');
    fs.writeFileSync(path.join(packageDir, 'test', 'helper.ts'), 'export const helper = true;\n');

    const packages = discoverPackages(asHostPath(tmpDir), packageMarkersFor('typescript'));
    expect(packages.map(pkg => pkg.name)).toContain('repovine');

    const snapshot = await collectRepositoryFactsAsync(tmpDir);
    expect(snapshot.modules.map(mod => mod.id)).toContain('mod:repovine/src');
    expect(snapshot.modules.map(mod => mod.id)).not.toContain('mod:repovine/test/helper');
  });

  it('skips package roots under singular test directories', () => {
    const fixtureDir = path.join(tmpDir, 'test', 'fixture');
    fs.mkdirSync(fixtureDir, { recursive: true });
    writeJson(path.join(fixtureDir, 'package.json'), { name: 'fixture' });
    writeJson(path.join(fixtureDir, 'tsconfig.json'), {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
      },
      include: ['src/**/*.ts'],
    });

    expect(discoverPackages(asHostPath(tmpDir), packageMarkersFor('typescript')).map(pkg => pkg.name)).not.toContain('fixture');
  });

  it('discovers a package when the scanned root lives under a test directory', async () => {
    const fixtureDir = path.join(tmpDir, 'test', 'fixtures', 'vue-spa');
    fs.mkdirSync(path.join(fixtureDir, 'src'), { recursive: true });
    writeJson(path.join(fixtureDir, 'package.json'), { name: 'vue-spa-fixture' });
    writeJson(path.join(fixtureDir, 'tsconfig.json'), {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
      },
      include: ['src/**/*.ts'],
    });
    fs.writeFileSync(path.join(fixtureDir, 'src', 'app.ts'), 'export const app = true;\n');

    expect(discoverPackages(asHostPath(fixtureDir), packageMarkersFor('typescript')).map(pkg => pkg.name)).toContain('vue-spa-fixture');

    const snapshot = await collectRepositoryFactsAsync(fixtureDir);
    expect(snapshot.modules.length).toBeGreaterThan(0);
  });

  it('discovers modules from solution-style tsconfig references', async () => {
    const fixtureDir = fixtureRoot('tsconfig-references-monorepo');
    const expected = JSON.parse(
      fs.readFileSync(path.join(fixtureDir, 'expected.json'), 'utf-8'),
    ) as { modules: string[]; excludedModules?: string[] };

    const snapshot = await collectRepositoryFactsAsync(fixtureDir);
    const moduleIds = snapshot.modules.map(mod => mod.id);

    for (const moduleId of expected.modules) {
      expect(moduleIds).toContain(moduleId);
    }
    for (const moduleId of expected.excludedModules ?? []) {
      expect(moduleIds).not.toContain(moduleId);
    }

    expect(snapshot.modules.filter(mod => mod.id.startsWith('mod:root/')).length).toBe(0);
  });

  it('discovers explicitly included files outside tsconfig includes without scanning skipped paths', async () => {
    const packageDir = path.join(tmpDir, 'app');
    fs.mkdirSync(packageDir, { recursive: true });
    writeJson(path.join(packageDir, 'package.json'), { name: 'explicit-include-app', version: '0.1.0' });
    writeJson(path.join(packageDir, 'tsconfig.json'), {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
      },
      include: ['src/**/*.ts'],
    });
    fs.mkdirSync(path.join(packageDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(packageDir, 'tools', 'safe'), { recursive: true });
    fs.mkdirSync(path.join(packageDir, 'tools', '__tests__'), { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'src', 'index.ts'), 'export const source = true;\n');
    fs.writeFileSync(path.join(packageDir, 'tools', 'safe', 'worker.ts'), 'export const worker = true;\n');
    fs.writeFileSync(path.join(packageDir, 'tools', '__tests__', 'helper.ts'), 'export const helper = true;\n');
    fs.writeFileSync(path.join(packageDir, 'tools', 'safe', 'worker.test.ts'), 'export const testWorker = true;\n');

    const snapshot = await collectRepositoryFactsAsync(tmpDir, {
      scanInclude: ['app/tools/**/*.ts'],
      maxPackageWorkers: 1,
    });
    const moduleIds = snapshot.modules.map(mod => mod.id).sort();

    expect(moduleIds).toEqual([
      'mod:explicit-include-app/src',
      'mod:explicit-include-app/tools/safe/worker',
    ]);
  });
});
