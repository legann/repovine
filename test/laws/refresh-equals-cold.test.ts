import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import type { RepositoryFactsSnapshot } from '../../src/types.js';
import { detectPython } from '../../packages/plugins/source-python/src/discover.js';

/**
 * Law: an incremental refresh over a mutated tree produces the same module set, order, and
 * import/re-export resolutions as a cold build of that tree. A module reused by content-hash keeps
 * its own content, but its import edges resolve against the whole module set — which the mutation
 * changed. Reusing the pre-mutation resolutions would make an incremental graph diverge from a cold
 * one; this suite pins them equal.
 */

interface Edge {
  s: string;
  r: string | null;
  e: boolean;
}

interface ModuleEdges {
  id: string;
  imports: Edge[];
  reExports: Edge[];
}

function edgesOf(snapshot: RepositoryFactsSnapshot): ModuleEdges[] {
  return snapshot.modules.map(m => ({
    id: m.id,
    imports: m.imports.map(i => ({ s: i.moduleSpecifier, r: i.resolvedModuleId ?? null, e: i.isExternal })),
    reExports: (m.reExports ?? []).map(r => ({ s: r.moduleSpecifier, r: r.resolvedModuleId ?? null, e: r.isExternal })),
  }));
}

function byId(list: ModuleEdges[]): ModuleEdges[] {
  return [...list].sort((a, b) => a.id.localeCompare(b.id));
}

async function build(root: string, previousSnapshot?: RepositoryFactsSnapshot): Promise<RepositoryFactsSnapshot> {
  return collectRepositoryFactsAsync(root, { maxPackageWorkers: 1, ...(previousSnapshot ? { previousSnapshot } : {}) });
}

/** Cold-build the initial tree, apply `mutate`, then compare a refresh (previous = cold v1) against a
 * cold build of the mutated tree. Both must agree on module order and every resolved edge. Returns the
 * cold snapshot so a caller can assert the mutation was actually extracted (guarding a vacuous pass). */
async function assertRefreshEqualsCold(root: string, mutate: () => void): Promise<RepositoryFactsSnapshot> {
  const v1 = await build(root);
  mutate();
  const refreshed = await build(root, v1);
  const cold = await build(root);

  // Module set and order are identical.
  expect(refreshed.modules.map(m => m.id)).toEqual(cold.modules.map(m => m.id));
  // Every import and re-export resolves to the same id (or stays unresolved) under both paths.
  expect(byId(edgesOf(refreshed))).toEqual(byId(edgesOf(cold)));
  return cold;
}

describe('law: incremental refresh equals cold build (TypeScript)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-refresh-cold-ts-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function srcDir(): string {
    const pkgDir = path.join(tmpDir, 'app');
    fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'app', version: '0.1.0' }));
    fs.writeFileSync(
      path.join(pkgDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
        include: ['src/**/*.ts'],
      }),
    );
    return path.join(pkgDir, 'src');
  }

  it('resolves a relative import when its target file is added', async () => {
    const src = srcDir();
    fs.writeFileSync(path.join(src, 'a.ts'), `import { b } from './b';\nexport const a = () => b;\n`);
    await assertRefreshEqualsCold(tmpDir, () => {
      fs.writeFileSync(path.join(src, 'b.ts'), `export const b = 1;\n`);
    });
  });

  it('unresolves a relative import when its target file is removed', async () => {
    const src = srcDir();
    fs.writeFileSync(path.join(src, 'a.ts'), `import { b } from './b';\nexport const a = () => b;\n`);
    fs.writeFileSync(path.join(src, 'b.ts'), `export const b = 1;\n`);
    await assertRefreshEqualsCold(tmpDir, () => {
      fs.rmSync(path.join(src, 'b.ts'));
    });
  });

  it('resolves a barrel re-export when its target file is added', async () => {
    const src = srcDir();
    fs.writeFileSync(path.join(src, 'barrel.ts'), `export { thing } from './impl';\n`);
    fs.writeFileSync(path.join(src, 'main.ts'), `import { thing } from './barrel';\nexport const m = () => thing;\n`);
    await assertRefreshEqualsCold(tmpDir, () => {
      fs.writeFileSync(path.join(src, 'impl.ts'), `export const thing = 1;\n`);
    });
  });
});

// Python extraction shells out to an interpreter; skip where none is installed (same gate the other
// Python suites use), so a missing interpreter does not fail the run.
const describePython = detectPython() ? describe : describe.skip;

describePython('law: incremental refresh equals cold build (Python)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-refresh-cold-py-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves a relative import when its target module is added', async () => {
    const pkgDir = path.join(tmpDir, 'svc');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'pyproject.toml'), `[project]\nname = "svc"\n`);
    fs.writeFileSync(path.join(pkgDir, '__init__.py'), '');
    fs.writeFileSync(path.join(pkgDir, 'a.py'), `from .b import thing\n\nvalue = thing\n`);
    const cold = await assertRefreshEqualsCold(tmpDir, () => {
      fs.writeFileSync(path.join(pkgDir, 'b.py'), `thing = 1\n`);
    });
    // Guard against a vacuous pass: a failed interpreter subprocess would leave both snapshots empty,
    // so parity would hold trivially. Assert the Python import was actually extracted and resolved.
    const importer = cold.modules.find(m => m.imports.some(i => i.moduleSpecifier === '.b'));
    const resolved = importer?.imports.find(i => i.moduleSpecifier === '.b')?.resolvedModuleId;
    expect(resolved).toBeTruthy();
    expect(cold.modules.map(m => m.id)).toContain(resolved);
  });
});
