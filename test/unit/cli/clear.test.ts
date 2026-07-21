import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { clearWorkspace, runClear } from '../../../src/cli/clear.js';
import { initAll, initCodex, initCursor } from '../../../src/cli/init.js';
import { stripAnsi } from '../../../src/cli/ui.js';
import {
  REPOVINE_GITIGNORE_ENTRY,
  REPOVINE_GITIGNORE_HEADER,
} from '../../../src/cli/repovine-gitignore.js';
import { ANNOTATIONS_FILENAME, ARTIFACTS_DIR_NAME, DOMAINS_CONFIG_FILENAME } from '../../../src/paths.js';
import { BUILD_CALIBRATION_FILENAME } from '../../../src/stage1/calibration.js';
import { CONFIG_FILENAME } from '../../../src/config.js';

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

describe('clearWorkspace', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clear-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dry-runs by reporting removals without changing files', () => {
    initAll(tmpDir, { forceBootstrap: false, replaceMcp: false });
    fs.writeFileSync(path.join(tmpDir, ANNOTATIONS_FILENAME), '{}\n');

    const results = clearWorkspace(tmpDir, { dryRun: true });

    expect(results.some(result => result.status === 'would-remove')).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, CONFIG_FILENAME))).toBe(true);
    expect(results).not.toContainEqual(expect.objectContaining({
      path: path.join(tmpDir, CONFIG_FILENAME),
      status: 'would-remove',
    }));
    expect(results).not.toContainEqual(expect.objectContaining({
      path: path.join(tmpDir, DOMAINS_CONFIG_FILENAME),
      status: 'would-remove',
    }));
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ANNOTATIONS_FILENAME))).toBe(true);
  });

  it('removes repovine setup while preserving annotations and unrelated merged settings', () => {
    fs.mkdirSync(path.join(tmpDir, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          playwright: { command: 'npx', args: ['@playwright/mcp'] },
        },
      }, null, 2),
    );
    fs.writeFileSync(
      path.join(tmpDir, '.cursor', 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: {
          afterFileEdit: [{ command: 'node "./custom-cursor-hook.js"' }],
        },
      }, null, 2),
    );

    fs.writeFileSync(
      path.join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          github: { command: 'npx', args: ['@modelcontextprotocol/server-github'] },
        },
      }, null, 2),
    );

    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.claude', 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(echo ok)'] },
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: 'command', command: 'node ./custom-claude-hook.js' },
              ],
            },
          ],
        },
      }, null, 2),
    );

    fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.codex', 'config.toml'),
      '[mcp_servers.other]\ncommand = "node"\nargs = ["other.js"]\n',
    );

    initAll(tmpDir, { forceBootstrap: false, replaceMcp: false });
    fs.writeFileSync(path.join(tmpDir, ANNOTATIONS_FILENAME), '{}\n');
    fs.mkdirSync(path.join(tmpDir, ARTIFACTS_DIR_NAME, '.cache'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ARTIFACTS_DIR_NAME, '.cache', BUILD_CALIBRATION_FILENAME), '{}\n');
    fs.writeFileSync(path.join(tmpDir, ARTIFACTS_DIR_NAME, '.cache', 'graph.json'), '{}\n');

    const results = clearWorkspace(tmpDir, { dryRun: false });

    expect(fs.existsSync(path.join(tmpDir, ANNOTATIONS_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ARTIFACTS_DIR_NAME))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, CONFIG_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, DOMAINS_CONFIG_FILENAME))).toBe(true);

    const cursorMcp = readJson<{ mcpServers: Record<string, unknown> }>(
      path.join(tmpDir, '.cursor', 'mcp.json'),
    );
    expect(cursorMcp.mcpServers.playwright).toEqual({ command: 'npx', args: ['@playwright/mcp'] });
    expect(cursorMcp.mcpServers.repovine).toBeUndefined();

    const claudeMcp = readJson<{ mcpServers: Record<string, unknown> }>(
      path.join(tmpDir, '.mcp.json'),
    );
    expect(claudeMcp.mcpServers.github).toEqual({
      command: 'npx',
      args: ['@modelcontextprotocol/server-github'],
    });
    expect(claudeMcp.mcpServers.repovine).toBeUndefined();

    const codexConfig = fs.readFileSync(path.join(tmpDir, '.codex', 'config.toml'), 'utf-8');
    expect(codexConfig).toContain('[mcp_servers.other]');
    expect(codexConfig).not.toContain('[mcp_servers.repovine]');
    expect(codexConfig).not.toContain('BEGIN repovine hooks');

    const cursorHooks = readJson<{ hooks: { afterFileEdit: Array<{ command: string }> } }>(
      path.join(tmpDir, '.cursor', 'hooks.json'),
    );
    expect(cursorHooks.hooks.afterFileEdit).toEqual([{ command: 'node "./custom-cursor-hook.js"' }]);

    const claudeSettings = readJson<{
      permissions: { allow: string[] };
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    }>(path.join(tmpDir, '.claude', 'settings.json'));
    expect(claudeSettings.permissions.allow).toEqual(['Bash(echo ok)']);
    expect(claudeSettings.hooks.SessionStart[0].hooks[0].command).toBe('node ./custom-claude-hook.js');
    expect(results).toContainEqual(expect.objectContaining({
      path: path.join(tmpDir, '.gitignore'),
      backupPath: path.join(tmpDir, '.gitignore.bak'),
      backupCreated: true,
    }));

    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'rules', 'repovine-policy.mdc'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'agents', 'repovine-code-reviewer.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'agents', 'sample.project-subagent.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'agents', '_TEMPLATE.project-subagent.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'agents', 'repovine-architecture-auditor.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'agents', 'sample.project-subagent.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'agents', '_TEMPLATE.project-subagent.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'agents', 'repovine-code-reviewer.toml'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'agents', 'sample.project-subagent.toml'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'agents', '_TEMPLATE.project-subagent.toml'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'skills', 'repovine-annotations', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'skills', 'repovine-review', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'skills', 'repovine-workflow', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'hooks', 'stale-graph-notice.js'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-annotations', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-review', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-workflow', 'SKILL.md'))).toBe(false);
  });

  it('removes repovine gitignore cache blocks', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.gitignore'),
      `${REPOVINE_GITIGNORE_HEADER}\n${REPOVINE_GITIGNORE_ENTRY}\n\nkeep-me\n`,
    );

    clearWorkspace(tmpDir, { dryRun: false });

    const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore).not.toContain(REPOVINE_GITIGNORE_ENTRY);
    expect(gitignore).toContain('keep-me');
  });

  it('clears Codex artifacts before a later Cursor-only init', () => {
    initCodex(tmpDir, { forceBootstrap: false, replaceMcp: false });

    clearWorkspace(tmpDir, { dryRun: false });
    initCursor(tmpDir, { forceBootstrap: false, replaceMcp: false });

    expect(fs.existsSync(path.join(tmpDir, '.codex', 'config.toml'))).toBe(true);
    const codexConfig = fs.readFileSync(path.join(tmpDir, '.codex', 'config.toml'), 'utf-8');
    expect(codexConfig).toContain('project_doc_max_bytes = 65536');
    expect(codexConfig).not.toContain('[mcp_servers.repovine]');
    expect(codexConfig).not.toContain('BEGIN repovine hooks');
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'hooks'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'agents'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'skills'))).toBe(false);

    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-refresh', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-workflow', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-review', 'SKILL.md'))).toBe(true);
  });

  it('preserves generated-only Claude and Codex config files while clearing repovine hooks', () => {
    initAll(tmpDir, { forceBootstrap: false, replaceMcp: false });

    clearWorkspace(tmpDir, { dryRun: false });

    expect(fs.existsSync(path.join(tmpDir, '.claude', 'settings.json'))).toBe(true);
    expect(readJson<Record<string, unknown>>(path.join(tmpDir, '.claude', 'settings.json'))).toEqual({});

    expect(fs.existsSync(path.join(tmpDir, '.codex', 'config.toml'))).toBe(true);
    const codexConfig = fs.readFileSync(path.join(tmpDir, '.codex', 'config.toml'), 'utf-8');
    expect(codexConfig).toContain('project_doc_max_bytes = 65536');
    expect(codexConfig).not.toContain('[mcp_servers.repovine]');
    expect(codexConfig).not.toContain('BEGIN repovine hooks');
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'hooks'))).toBe(false);
  });

  it('previews and waits for confirmation before applying', async () => {
    initCursor(tmpDir, { forceBootstrap: false, replaceMcp: false });
    const mcpPath = path.join(tmpDir, '.cursor', 'mcp.json');

    await runClear(tmpDir, { confirm: () => false });
    expect(fs.existsSync(mcpPath)).toBe(true);

    await runClear(tmpDir, { confirm: () => true });
    expect(fs.existsSync(mcpPath)).toBe(false);
  });

  it('declines (never hangs) on non-TTY stdin when no confirm override is given', async () => {
    initCursor(tmpDir, { forceBootstrap: false, replaceMcp: false });
    const mcpPath = path.join(tmpDir, '.cursor', 'mcp.json');

    // jest stdin is not a TTY; the default confirm must decline instead of awaiting a
    // never-answered readline question (which would exit on an unsettled top-level await).
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await runClear(tmpDir);
    } finally {
      log.mockRestore();
    }

    expect(fs.existsSync(mcpPath)).toBe(true); // declined — nothing removed
  });

  it('prints created .bak files after applying clear', async () => {
    initCursor(tmpDir, { forceBootstrap: false, replaceMcp: false });
    const mcpPath = path.join(tmpDir, '.cursor', 'mcp.json');
    const mcp = readJson<{ mcpServers: Record<string, unknown> }>(mcpPath);
    mcp.mcpServers.playwright = { command: 'npx', args: ['@playwright/mcp'] };
    fs.writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);

    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    let output = '';
    try {
      await runClear(tmpDir, { confirm: () => true });
      output = stripAnsi(log.mock.calls.map(call => String(call[0] ?? '')).join('\n'));
    } finally {
      log.mockRestore();
    }

    expect(output).toContain('Created .bak files:');
    expect(output).toContain(path.join('.cursor', 'mcp.json.bak'));
  });
});
