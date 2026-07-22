/**
 * scripts/lib/spawn.cjs: the parts a Linux run CAN prove. The ComSpec argv
 * branch itself only executes on a .cmd-only Windows install; its safety gate
 * and the npm_execpath trust rule are platform-independent and tested here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const spawnLib = require_('../../scripts/lib/spawn.cjs') as {
  assertComSpecSafe: (args: string[]) => void;
  resolveNpmCli: () => string | null;
  runNode: (args: string[], options?: object) => { status: number | null; stdout: string };
};

describe('assertComSpecSafe', () => {
  test.each(['a&b', 'a|b', 'a<b', 'a>b', 'a^b', 'a%b', 'a"b', 'a\rb', 'a\nb'])(
    'rejects cmd metacharacter arg %j',
    (arg) => {
      expect(() => spawnLib.assertComSpecSafe([arg])).toThrow(/cmd metacharacters/);
    },
  );

  test('accepts plain tokens and paths with spaces', () => {
    expect(() =>
      spawnLib.assertComSpecSafe(['view', 'repovine@1.2.3', 'version', 'C:\\path with space\\x.tgz', '--json']),
    ).not.toThrow();
  });
});

describe('resolveNpmCli npm_execpath trust rule', () => {
  const saved = process.env.npm_execpath;
  afterEach(() => {
    if (saved === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = saved;
  });

  test('rejects a non-npm npm_execpath (yarn.js) even when the file exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-helper-'));
    const yarnJs = path.join(dir, 'yarn.js');
    fs.writeFileSync(yarnJs, '// fake yarn cli\n');
    process.env.npm_execpath = yarnJs;
    expect(spawnLib.resolveNpmCli()).not.toBe(yarnJs);
  });

  test('accepts npm_execpath when it is npm-cli.js', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-helper-'));
    const npmCli = path.join(dir, 'npm-cli.js');
    fs.writeFileSync(npmCli, '// fake npm cli\n');
    process.env.npm_execpath = npmCli;
    expect(spawnLib.resolveNpmCli()).toBe(npmCli);
  });
});

test('runNode executes the current Node with argv array', () => {
  const r = spawnLib.runNode(['-e', 'console.log(7 * 6)'], { encoding: 'utf-8' });
  expect(r.status).toBe(0);
  expect(String(r.stdout).trim()).toBe('42');
});
