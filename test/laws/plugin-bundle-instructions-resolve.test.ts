import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';
import { renderPluginRepo } from '../../src/cli/plugin-render.js';

/**
 * Law: an instruction file a bundle ships names only files that bundle ships.
 *
 * `CLAUDE.md` opens with `@AGENTS.md`, which is an import, not a mention: the client loads the named
 * file and the instructions it carries. A bundle that wrote one of the two shipped a pointer into
 * nothing, and the failure is silent on both ends — the client reports no error and the agent simply
 * never sees the workflow rules. Nothing else measures it: the render test counts files, and no
 * count can tell whether the ones present name the ones absent.
 *
 * The reference syntax is the clients' own: a line whose first non-space character is `@` followed by
 * a path. Only same-directory references are asked about — a reference reaching out of the bundle is
 * about the target repository, not about what the bundle carries.
 */

function resolveEngineRoot(): string {
  const candidates = [process.cwd(), path.resolve(process.cwd(), 'repovine')];
  const found = candidates.find(root =>
    fs.existsSync(path.join(root, 'package.json'))
    && fs.existsSync(path.join(root, 'src', 'cli', 'onboarding-assets.ts')));
  if (!found) throw new Error('repovine engine root not found from test cwd');
  return found;
}

/** Files a client reads as instructions, in the bundles that carry them. */
const INSTRUCTION_FILES: ReadonlyArray<{ bundle: string; file: string }> = [
  { bundle: 'claude', file: 'CLAUDE.md' },
  { bundle: 'claude', file: 'AGENTS.md' },
  { bundle: 'codex', file: 'AGENTS.md' },
];

const IMPORT_LINE = /^\s*@([A-Za-z0-9._/-]+)\s*$/;

describe('core-laws a plugin bundle resolves the instruction files it names', () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
    tmpRoots.length = 0;
  });

  it('ships every instruction file its own instructions import', () => {
    const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-bundle-law-'));
    tmpRoots.push(outRoot);

    renderPluginRepo({ engineRoot: resolveEngineRoot(), outRoot, version: '0.1.0-test' });

    const pluginsDir = path.join(outRoot, 'repovine-plugins');
    const dangling: string[] = [];
    let importsSeen = 0;
    for (const { bundle, file } of INSTRUCTION_FILES) {
      const abs = path.join(pluginsDir, bundle, file);
      // The file itself first: a bundle that stopped writing it would otherwise have no imports to
      // check and would pass with nothing examined.
      if (!fs.existsSync(abs)) {
        dangling.push(`${bundle}/${file}: not written`);
        continue;
      }
      for (const line of fs.readFileSync(abs, 'utf-8').split('\n')) {
        const match = IMPORT_LINE.exec(line);
        if (!match) continue;
        const target = match[1];
        if (target.startsWith('/') || target.startsWith('..')) continue;
        importsSeen++;
        if (!fs.existsSync(path.join(pluginsDir, bundle, target))) {
          dangling.push(`${bundle}/${file} imports ${target}, which the bundle does not ship`);
        }
      }
    }

    expect(dangling).toEqual([]);
    // A guard on the guard: the regex matching nothing would make the loop above vacuous.
    expect(importsSeen).toBeGreaterThan(0);
  });
});
