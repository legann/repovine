import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, afterEach } from '@jest/globals';
import {
  REPOVINE_GITIGNORE_ENTRY,
  REPOVINE_GITIGNORE_HEADER,
  formatRepovineGitignoreBlock,
} from '../../../src/cli/repovine-gitignore.js';
import { initCursor } from '../../../src/cli/init.js';

describe('repovine gitignore block', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('formatRepovineGitignoreBlock matches init/clear constants', () => {
    expect(formatRepovineGitignoreBlock()).toBe(
      `\n${REPOVINE_GITIGNORE_HEADER}\n${REPOVINE_GITIGNORE_ENTRY}\n`,
    );
  });

  it('init appends only the current .repovine/ block', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-gitignore-'));
    initCursor(tmpDir, { forceBootstrap: false, replaceMcp: false });

    const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain(REPOVINE_GITIGNORE_HEADER);
    expect(gitignore).toContain(REPOVINE_GITIGNORE_ENTRY);
    expect(gitignore).not.toContain('repository-facts-snapshot.json');
    expect(gitignore).not.toContain('ignore the rest');
  });
});
