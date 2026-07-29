import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RepositoryFactsSnapshot } from '../../../src/types.js';
import { collectRepositoryFactsAsync } from '../../../src/stage1/index.js';
import { listTsConfigSourceFiles } from '../../../packages/plugins/source-typescript/src/list-tsconfig-files.js';

// fs.symlinkSync needs SeCreateSymbolicLinkPrivilege on Windows, where a committed symlink is also
// only materialised as a link under git core.symlinks=true.
const describeSymlink = process.platform === 'win32' ? describe.skip : describe;

let base: string;
let repoRoot: string;
let snapshot: RepositoryFactsSnapshot;

/**
 * A repo whose tsconfig `include` covers three escapes and two legitimate files: `src/leak.ts`
 * links to an out-of-repo file, `src/linked` links to an out-of-repo directory, and `src/alias.ts`
 * links to a sibling that stays inside.
 */
function buildFixture(): void {
  // realpathSync: on macOS os.tmpdir() is itself a symlink (/var -> /private/var), which would make
  // every containment verdict measure the tmpdir link instead of the fixture.
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-stage1-containment-')));

  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(outside, 'vendored'), { recursive: true });
  fs.writeFileSync(
    path.join(outside, 'secret.ts'),
    'export type Secret = { awsKey: "AKIAEXAMPLE"; dbPassword: "hunter2" };\n'
    + 'export function decrypt(masterKey: string): string { return masterKey; }\n',
  );
  fs.writeFileSync(path.join(outside, 'vendored', 'leaked.ts'), 'export const vendoredSecret = 1;\n');

  repoRoot = path.join(base, 'repo');
  const src = path.join(repoRoot, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'fixture-pkg' }));
  fs.writeFileSync(path.join(repoRoot, 'tsconfig.json'), JSON.stringify({ include: ['src/**/*'] }));
  fs.writeFileSync(path.join(src, 'index.ts'), 'export const entry = 1;\n');
  fs.writeFileSync(path.join(src, 'real.ts'), 'export const real = 1;\n');

  fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(src, 'leak.ts'));
  fs.symlinkSync(path.join(outside, 'vendored'), path.join(src, 'linked'));
  fs.symlinkSync(path.join(src, 'real.ts'), path.join(src, 'alias.ts'));
}

describeSymlink('stage 1 — containment of discovered candidates', () => {
  beforeAll(async () => {
    buildFixture();
    snapshot = await collectRepositoryFactsAsync(repoRoot);
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('enumerates the escaping paths, so the guard has something to refuse', () => {
    // Pins the premise: TypeScript's own file enumeration stats through symlinks and classifies
    // them as files. Were that to change, the assertions below would pass for the wrong reason.
    const enumerated = listTsConfigSourceFiles(repoRoot).map(f => path.resolve(f));

    expect(enumerated).toContain(path.resolve(repoRoot, 'src', 'leak.ts'));
    expect(enumerated).toContain(path.resolve(repoRoot, 'src', 'linked', 'leaked.ts'));
  });

  it('keeps real files and a symlink that resolves inside the repo', () => {
    const rel = snapshot.modules.map(m => m.relativeFilePath).sort();

    expect(rel).toEqual(['src/alias.ts', 'src/index.ts', 'src/real.ts']);
  });

  it('refuses a file symlink and a file under a directory symlink that leave the repo', () => {
    const containment = (snapshot.buildRefusals ?? []).find(r => r.kind === 'outside-workspace');

    expect(containment?.reason).toBe('rejected-by-policy');
    expect(containment?.details).toEqual({ count: 2, sample: ['src/leak.ts', 'src/linked/leaked.ts'] });
    expect(containment?.message).toContain('src/leak.ts, src/linked/leaked.ts');
  });

  it('publishes no identifier extracted from an out-of-repo file', () => {
    // The escape mattered because extraction parses the target: refusing the candidate has to keep
    // its declaration text out of the graph, not merely keep the path out of the module list.
    const identifiers = JSON.stringify(snapshot.modules);

    for (const leaked of ['AKIAEXAMPLE', 'hunter2', 'Secret', 'decrypt', 'masterKey', 'vendoredSecret']) {
      expect(identifiers).not.toContain(leaked);
    }
  });

  it('assembles an in-repo module unchanged', () => {
    const entry = snapshot.modules.find(m => m.relativeFilePath === 'src/index.ts');

    expect(entry?.exports.map(e => e.name)).toContain('entry');
    expect(entry?.contentHash).not.toBe('');
  });
});
