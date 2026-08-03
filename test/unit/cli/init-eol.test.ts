/**
 * EOL preservation when init edits existing user files: AGENTS.md,
 * .claude/settings.json, .cursor/hooks.json, and .gitignore. Uniform-EOL files
 * keep their EOL; mixed-EOL files follow the merge-config semantics (byte-exact
 * text handling, LF JSON serialization).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  initClaude,
  initCursor,
  ensureWorkspaceBootstrap,
} from '../../../src/cli/init.js';
import {
  AGENTS_MD,
  AGENTS_MD_BEGIN_MARKER,
  AGENTS_MD_END_MARKER,
} from '../../../src/cli/templates.js';
import { formatRepovineGitignoreBlock } from '../../../src/cli/repovine-gitignore.js';

const INIT_OPTS = { forceBootstrap: false, replaceMcp: false };

function toCrlf(content: string): string {
  return content.replace(/\n/g, '\r\n');
}

/** Every newline in `content` is CRLF (byte-level check). */
function isAllCrlf(content: string): boolean {
  return content.includes('\r\n') && !content.replace(/\r\n/g, '').includes('\n');
}

describe('init EOL preservation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-eol-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('AGENTS.md', () => {
    const userDoc = '# My project\n\nUser notes.\n';

    it('appends the repovine section to a CRLF file and keeps CRLF', () => {
      const agentsPath = path.join(tmpDir, 'AGENTS.md');
      fs.writeFileSync(agentsPath, toCrlf(userDoc));

      const results = initClaude(tmpDir, INIT_OPTS);
      expect(results.some(r => r.path === agentsPath && r.status === 'merged')).toBe(true);

      const content = fs.readFileSync(agentsPath, 'utf-8');
      expect(content).toBe(toCrlf(`${userDoc.trimEnd()}\n\n${AGENTS_MD}`));
      expect(isAllCrlf(content)).toBe(true);

      // Re-run: the CRLF file is already up to date — no spurious rewrite.
      const second = initClaude(tmpDir, INIT_OPTS);
      expect(second.some(r => r.path === agentsPath && r.status === 'skipped')).toBe(true);
      expect(fs.readFileSync(agentsPath, 'utf-8')).toBe(content);
    });

    it('appends the repovine section to an LF file and keeps LF', () => {
      const agentsPath = path.join(tmpDir, 'AGENTS.md');
      fs.writeFileSync(agentsPath, userDoc);

      initClaude(tmpDir, INIT_OPTS);

      const content = fs.readFileSync(agentsPath, 'utf-8');
      expect(content).toBe(`${userDoc.trimEnd()}\n\n${AGENTS_MD}`);
      expect(content).not.toContain('\r');
    });

    it('keeps mixed-EOL user bytes verbatim and appends the LF section', () => {
      const agentsPath = path.join(tmpDir, 'AGENTS.md');
      const mixed = '# My project\r\nline a\nline b\r\n';
      fs.writeFileSync(agentsPath, mixed);

      initClaude(tmpDir, INIT_OPTS);

      const content = fs.readFileSync(agentsPath, 'utf-8');
      expect(content).toBe(`${mixed.trimEnd()}\n\n${AGENTS_MD}`);
    });

    it('replaces the marked section in a CRLF file and keeps CRLF', () => {
      const agentsPath = path.join(tmpDir, 'AGENTS.md');
      const original =
        `# Intro\n\n${AGENTS_MD_BEGIN_MARKER}\nold section\n${AGENTS_MD_END_MARKER}\n\n# Outro\n`;
      fs.writeFileSync(agentsPath, toCrlf(original));

      const results = initClaude(tmpDir, INIT_OPTS);
      expect(results.some(r => r.path === agentsPath && r.status === 'merged')).toBe(true);

      const content = fs.readFileSync(agentsPath, 'utf-8');
      // replaceMarkedSection keeps the trailing text and adds a final newline.
      expect(content).toBe(toCrlf(`# Intro\n\n${AGENTS_MD.trimEnd()}\n\n# Outro\n\n`));
      expect(isAllCrlf(content)).toBe(true);
    });

    it('skips a CRLF checkout of the generated template (no rewrite)', () => {
      const agentsPath = path.join(tmpDir, 'AGENTS.md');
      const original = toCrlf(AGENTS_MD);
      fs.writeFileSync(agentsPath, original);

      const results = initClaude(tmpDir, INIT_OPTS);
      expect(results.some(r => r.path === agentsPath && r.status === 'skipped')).toBe(true);
      expect(fs.readFileSync(agentsPath, 'utf-8')).toBe(original);
    });
  });

  describe('.claude/settings.json', () => {
    const userSettings = `${JSON.stringify({ permissions: { allow: ['Bash(echo ok)'] } }, null, 2)}\n`;

    it('merges hooks into a CRLF file and keeps CRLF', () => {
      const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, toCrlf(userSettings));

      const results = initClaude(tmpDir, INIT_OPTS);
      expect(results.some(r => r.path === settingsPath && r.status === 'merged')).toBe(true);

      const content = fs.readFileSync(settingsPath, 'utf-8');
      expect(isAllCrlf(content)).toBe(true);
      const parsed = JSON.parse(content);
      expect(parsed.permissions.allow).toEqual(['Bash(echo ok)']);
      expect(parsed.hooks.SessionStart).toHaveLength(1);

      // Re-run: the CRLF file already carries the hooks — no spurious rewrite.
      const second = initClaude(tmpDir, INIT_OPTS);
      expect(second.some(r => r.path === settingsPath && r.status === 'skipped')).toBe(true);
      expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(content);
    });

    it('merges hooks into an LF file and keeps LF', () => {
      const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, userSettings);

      initClaude(tmpDir, INIT_OPTS);

      const content = fs.readFileSync(settingsPath, 'utf-8');
      expect(content).not.toContain('\r');
      expect(JSON.parse(content).hooks.SessionStart).toHaveLength(1);
    });

    it('writes the LF JSON serialization for a mixed-EOL file', () => {
      const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const mixed = '{\r\n  "permissions": {\n    "allow": []\r\n  }\n}\n';
      fs.writeFileSync(settingsPath, mixed);

      initClaude(tmpDir, INIT_OPTS);

      const content = fs.readFileSync(settingsPath, 'utf-8');
      expect(content).not.toContain('\r');
      expect(JSON.parse(content).hooks.SessionStart).toHaveLength(1);
    });
  });

  describe('.cursor/hooks.json', () => {
    const userHooks = `${JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: './guard.sh' }] } }, null, 2)}\n`;

    it('merges hooks into a CRLF file and keeps CRLF', () => {
      const hooksPath = path.join(tmpDir, '.cursor', 'hooks.json');
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      fs.writeFileSync(hooksPath, toCrlf(userHooks));

      const results = initCursor(tmpDir, INIT_OPTS);
      expect(results.some(r => r.path === hooksPath && r.status === 'merged')).toBe(true);

      const content = fs.readFileSync(hooksPath, 'utf-8');
      expect(isAllCrlf(content)).toBe(true);
      const parsed = JSON.parse(content);
      expect(parsed.hooks.beforeShellExecution).toEqual([{ command: './guard.sh' }]);
      expect(parsed.hooks.sessionStart).toHaveLength(1);

      // Re-run: the CRLF file already carries the hooks — no spurious rewrite.
      const second = initCursor(tmpDir, INIT_OPTS);
      expect(second.some(r => r.path === hooksPath && r.status === 'skipped')).toBe(true);
      expect(fs.readFileSync(hooksPath, 'utf-8')).toBe(content);
    });

    it('merges hooks into an LF file and keeps LF', () => {
      const hooksPath = path.join(tmpDir, '.cursor', 'hooks.json');
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      fs.writeFileSync(hooksPath, userHooks);

      initCursor(tmpDir, INIT_OPTS);

      const content = fs.readFileSync(hooksPath, 'utf-8');
      expect(content).not.toContain('\r');
      expect(JSON.parse(content).hooks.sessionStart).toHaveLength(1);
    });

    it('writes the LF JSON serialization for a mixed-EOL file', () => {
      const hooksPath = path.join(tmpDir, '.cursor', 'hooks.json');
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      const mixed = '{\r\n  "version": 1,\n  "hooks": {\r\n  }\n}\n';
      fs.writeFileSync(hooksPath, mixed);

      initCursor(tmpDir, INIT_OPTS);

      const content = fs.readFileSync(hooksPath, 'utf-8');
      expect(content).not.toContain('\r');
      expect(JSON.parse(content).hooks.sessionStart).toHaveLength(1);
    });
  });

  describe('.gitignore', () => {
    it('appends the repovine block in CRLF to a CRLF file', () => {
      const gitignorePath = path.join(tmpDir, '.gitignore');
      const original = toCrlf('dist/\nnode_modules/\n');
      fs.writeFileSync(gitignorePath, original);

      ensureWorkspaceBootstrap(tmpDir);

      const content = fs.readFileSync(gitignorePath, 'utf-8');
      expect(content).toBe(original + toCrlf(formatRepovineGitignoreBlock()));
      expect(isAllCrlf(content)).toBe(true);
    });

    it('appends the repovine block in LF to an LF file', () => {
      const gitignorePath = path.join(tmpDir, '.gitignore');
      const original = 'dist/\nnode_modules/\n';
      fs.writeFileSync(gitignorePath, original);

      ensureWorkspaceBootstrap(tmpDir);

      const content = fs.readFileSync(gitignorePath, 'utf-8');
      expect(content).toBe(original + formatRepovineGitignoreBlock());
      expect(content).not.toContain('\r');
    });

    it('appends the LF block to a mixed-EOL file, keeping user bytes verbatim', () => {
      const gitignorePath = path.join(tmpDir, '.gitignore');
      const original = 'dist/\r\nnode_modules/\n*.log\r\n';
      fs.writeFileSync(gitignorePath, original);

      ensureWorkspaceBootstrap(tmpDir);

      const content = fs.readFileSync(gitignorePath, 'utf-8');
      expect(content).toBe(original + formatRepovineGitignoreBlock());
    });
  });
});
