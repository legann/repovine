import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parsePackageTsConfig } from '../../../packages/plugins/source-typescript/src/list-tsconfig-files.js';

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

describe('parsePackageTsConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-tsconfig-refs-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('follows same-package references when the root config has no files', () => {
    const pkgDir = path.join(tmpDir, 'api');
    fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'src', 'handler.ts'), 'export const ok = true;\n');
    fs.writeFileSync(path.join(pkgDir, 'src', 'handler.spec.ts'), 'export const test = true;\n');

    writeJson(path.join(pkgDir, 'tsconfig.json'), {
      files: [],
      include: [],
      references: [
        { path: './tsconfig.app.json' },
        { path: './tsconfig.spec.json' },
      ],
    });
    writeJson(path.join(pkgDir, 'tsconfig.app.json'), {
      extends: './tsconfig.json',
      include: ['src/**/*.ts'],
      exclude: ['**/*.spec.ts'],
    });
    writeJson(path.join(pkgDir, 'tsconfig.spec.json'), {
      extends: './tsconfig.json',
      include: ['src/**/*.spec.ts'],
    });

    const parsed = parsePackageTsConfig(pkgDir);
    const basenames = parsed.fileNames.map(file => path.basename(file));
    expect(basenames).toContain('handler.ts');
    expect(basenames).not.toContain('handler.spec.ts');
  });

  it('does not follow references to separate package directories', () => {
    const rootDir = path.join(tmpDir, 'workspace');
    const apiDir = path.join(rootDir, 'packages', 'api');
    fs.mkdirSync(path.join(apiDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(apiDir, 'src', 'handler.ts'), 'export const ok = true;\n');

    writeJson(path.join(rootDir, 'tsconfig.json'), {
      files: [],
      references: [{ path: './packages/api' }],
    });
    writeJson(path.join(apiDir, 'tsconfig.json'), {
      include: ['src/**/*.ts'],
    });

    const parsed = parsePackageTsConfig(rootDir);
    expect(parsed.fileNames).toHaveLength(0);
  });

  it('supplements entry-only app configs with a src tree walk', () => {
    const pkgDir = path.join(tmpDir, 'web');
    fs.mkdirSync(path.join(pkgDir, 'src', 'components'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'src', 'main.ts'), 'import "./components/Button";\n');
    fs.writeFileSync(path.join(pkgDir, 'src', 'components', 'Button.tsx'), 'export const Button = 1;\n');

    writeJson(path.join(pkgDir, 'tsconfig.json'), {
      files: [],
      references: [{ path: './tsconfig.app.json' }],
    });
    writeJson(path.join(pkgDir, 'tsconfig.app.json'), {
      extends: './tsconfig.json',
      files: ['src/main.ts'],
    });

    const parsed = parsePackageTsConfig(pkgDir);
    const basenames = parsed.fileNames.map(file => path.basename(file));
    expect(basenames).toContain('main.ts');
    expect(basenames).toContain('Button.tsx');
  });
});
