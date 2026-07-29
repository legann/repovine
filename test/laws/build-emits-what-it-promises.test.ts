import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { repoRoot } from './graph-law-helpers.js';

/**
 * Law: the build's own output check is live, and CI never turns it off.
 *
 * `npm run build` deletes `dist` before compiling, so every reader of the tree during that window
 * sees a partial one. The check that closes it lives in the build (`scripts/verify-build-output.mjs`)
 * and answers one mechanical question: does every compiled module have an emitted counterpart. A
 * check like that fails quietly in the other direction — narrow its idea of what a source file is and
 * it examines nothing while still reporting success, which is exactly the state the entry-point list
 * it replaced was in.
 *
 * So this law asks two things the checker cannot ask about itself: that it looked at a real number
 * of modules, and that the escape hatch which skips the build (`REPOVINE_SKIP_BUILD=1`) is not set
 * anywhere in CI, where a stale `dist` would make a whole run meaningless.
 */

const WORKFLOWS = '.github/workflows';

describe('core-laws the build checks what it emitted', () => {
  it('finds nothing missing in the tree the tests are running against', async () => {
    const { missingBuildOutput } = await import('../../scripts/verify-build-output.mjs');

    expect(missingBuildOutput(repoRoot())).toEqual([]);
  });

  it('covers every workspace that compiles, and a real number of modules in each', async () => {
    const { compiledProjects } = await import('../../scripts/verify-build-output.mjs');
    const projects = compiledProjects(repoRoot());

    // The engine plus the SDK plus the nine plugin packages that carry source. A checker that
    // stopped enumerating would report an empty answer and pass the case above.
    expect(projects.length).toBeGreaterThanOrEqual(11);
    expect(projects.map(project => project.name)).toContain('repovine');
    expect(projects.map(project => project.name)).toContain('@repovine/plugin-sdk');

    // And each one holds compiled sources: a project whose `src` went empty examines nothing.
    for (const project of projects) {
      const count = countTypeScript(project.srcDir);
      expect(`${project.name}=${count > 0}`).toBe(`${project.name}=true`);
    }
  });

  it('names a module whose output is absent, and stays quiet when it is there', async () => {
    // The positive control. "Nothing is missing" is also what a checker that examines nothing says,
    // and that is the failure this whole file exists to prevent — so the checker is pointed at a
    // tree with a known answer instead of only at the real one.
    const { missingBuildOutput } = await import('../../scripts/verify-build-output.mjs');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-emit-law-')));
    try {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
      fs.mkdirSync(path.join(root, 'packages', 'plugins'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
      // A declaration compiles to nothing, so demanding output for it would be a false positive.
      fs.writeFileSync(path.join(root, 'src', 'b.d.ts'), 'export declare const b: number;\n');

      expect(missingBuildOutput(root)).toEqual(['repovine: dist/a.js']);

      fs.writeFileSync(path.join(root, 'dist', 'a.js'), 'export const a = 1;\n');
      expect(missingBuildOutput(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('is not switched off anywhere in CI', () => {
    const dir = path.join(repoRoot(), WORKFLOWS);
    const files = fs.readdirSync(dir).filter(name => name.endsWith('.yml') || name.endsWith('.yaml'));
    // Not vacuous: a repository with no workflows would pass without asking anything.
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.filter(name =>
      fs.readFileSync(path.join(dir, name), 'utf8').includes('REPOVINE_SKIP_BUILD'));
    expect(offenders).toEqual([]);
  });
});

function countTypeScript(dir: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) count += countTypeScript(abs);
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) count++;
  }
  return count;
}
