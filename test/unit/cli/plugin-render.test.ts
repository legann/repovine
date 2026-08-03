import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';
import { renderPluginRepo, wipePluginOutRoot } from '../../../src/cli/plugin-render.js';

function resolveEngineRoot(): string {
  const candidates = [
    process.cwd(),
    path.resolve(process.cwd(), 'repovine'),
  ];
  const found = candidates.find((root) =>
    fs.existsSync(path.join(root, 'package.json'))
    && fs.existsSync(path.join(root, 'src', 'cli', 'onboarding-assets.ts')),
  );
  if (!found) throw new Error('repovine engine root not found from test cwd');
  return found;
}

describe('renderPluginRepo', () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    for (const dir of tmpRoots) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpRoots.length = 0;
  });

  it('writes marketplace catalogs and client bundles', () => {
    const engineRoot = resolveEngineRoot();
    const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-plugin-'));
    tmpRoots.push(outRoot);

    const result = renderPluginRepo({ engineRoot, outRoot, version: '0.1.0-test' });

    expect(result.filesWritten).toBeGreaterThan(20);
    expect(result.wiped).toEqual([]);
    expect(fs.existsSync(path.join(outRoot, '.cursor-plugin', 'marketplace.json'))).toBe(true);
    expect(fs.existsSync(path.join(outRoot, '.claude-plugin', 'marketplace.json'))).toBe(true);
    expect(fs.existsSync(path.join(outRoot, '.agents', 'plugins', 'marketplace.json'))).toBe(true);
    expect(fs.existsSync(path.join(outRoot, 'LICENSE'))).toBe(true);

    const cursorPlugin = JSON.parse(
      fs.readFileSync(path.join(outRoot, 'repovine-plugins', 'cursor', '.cursor-plugin', 'plugin.json'), 'utf-8'),
    ) as Record<string, string>;
    expect(cursorPlugin.commands).toBeUndefined();
    expect(cursorPlugin.skills).toBe('.agents/skills');
    expect(cursorPlugin.mcpServers).toBe('.cursor/mcp.json');

    const cursorMcp = JSON.parse(
      fs.readFileSync(path.join(outRoot, 'repovine-plugins', 'cursor', '.cursor', 'mcp.json'), 'utf-8'),
    ) as { mcpServers: Record<string, { type?: string; args: string[] }> };
    expect(cursorMcp.mcpServers.repovine.args).toEqual(['-y', 'repovine@0.1.0-test']);
    // Cursor's MCP schema requires type:"stdio"; the Claude config carries no type key.
    expect(cursorMcp.mcpServers.repovine.type).toBe('stdio');
    expect(fs.existsSync(path.join(outRoot, 'repovine-plugins', 'cursor', '.cursor', 'agents', 'repovine-architecture-auditor.md'))).toBe(true);
    expect(fs.existsSync(path.join(outRoot, 'repovine-plugins', 'cursor', '.cursor', 'agents', 'repovine-code-reviewer.md'))).toBe(true);
    expect(fs.existsSync(path.join(outRoot, 'repovine-plugins', 'cursor', '.agents', 'skills', 'repovine-review', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(outRoot, 'repovine-plugins', 'claude', 'agents', 'repovine-architecture-auditor.md'))).toBe(true);
    expect(fs.existsSync(path.join(outRoot, 'repovine-plugins', 'claude', 'skills', 'repovine-review', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(outRoot, 'repovine-plugins', 'codex', '.codex', 'agents', 'repovine-code-reviewer.toml'))).toBe(true);
    expect(fs.existsSync(path.join(outRoot, 'repovine-plugins', 'codex', '.agents', 'skills', 'repovine-review', 'SKILL.md'))).toBe(true);

    const claudePlugin = JSON.parse(
      fs.readFileSync(path.join(outRoot, 'repovine-plugins', 'claude', '.claude-plugin', 'plugin.json'), 'utf-8'),
    ) as Record<string, string>;
    expect(claudePlugin.mcpServers).toBeUndefined();
    expect(claudePlugin.agents).toBeUndefined();
    expect(claudePlugin.skills).toBeUndefined();
    expect(claudePlugin.hooks).toBeUndefined();

    const claudeMcp = JSON.parse(
      fs.readFileSync(path.join(outRoot, 'repovine-plugins', 'claude', '.mcp.json'), 'utf-8'),
    ) as { mcpServers: Record<string, { type?: string }> };
    expect(claudeMcp.mcpServers.repovine.type).toBeUndefined();

    const claudeHooks = JSON.parse(
      fs.readFileSync(path.join(outRoot, 'repovine-plugins', 'claude', 'hooks', 'hooks.json'), 'utf-8'),
    ) as {
      PreToolUse: Array<{ hooks: Array<{ command: string; args?: string[] }> }>;
      PostToolUse: Array<{ hooks: Array<{ command: string; args?: string[] }> }>;
      SessionStart: Array<{ hooks: Array<{ command: string; args?: string[] }> }>;
    };
    // Exec form: node + plugin-root dispatcher args; no project-scoped remnants.
    expect(claudeHooks.PreToolUse[0]?.hooks[0]?.command).toBe('node');
    expect(claudeHooks.PreToolUse[0]?.hooks[0]?.args).toEqual(
      ['${CLAUDE_PLUGIN_ROOT}/hooks/repovine-client-dispatcher.mjs', 'boundary-notice', 'claude'],
    );
    expect(claudeHooks.PostToolUse[0]?.hooks[0]?.args).toEqual(
      ['${CLAUDE_PLUGIN_ROOT}/hooks/repovine-client-dispatcher.mjs', 'stale-graph-notice', 'claude'],
    );
    expect(claudeHooks.SessionStart[0]?.hooks[0]?.args).toEqual(
      ['${CLAUDE_PLUGIN_ROOT}/hooks/repovine-client-dispatcher.mjs', 'session-mcp-hint', 'claude'],
    );
    expect(JSON.stringify(claudeHooks)).not.toContain('$CLAUDE_PROJECT_DIR');
    expect(fs.existsSync(path.join(outRoot, 'repovine-plugins', 'claude', '.claude', 'settings.json'))).toBe(false);

    // Each bundle ships exactly one hook file: the dispatcher.
    expect(fs.readdirSync(path.join(outRoot, 'repovine-plugins', 'cursor', '.cursor', 'hooks')))
      .toEqual(['repovine-client-dispatcher.mjs']);
    expect(fs.readdirSync(path.join(outRoot, 'repovine-plugins', 'claude', 'hooks')).sort())
      .toEqual(['hooks.json', 'repovine-client-dispatcher.mjs']);
    expect(fs.readdirSync(path.join(outRoot, 'repovine-plugins', 'codex', '.codex', 'hooks')))
      .toEqual(['repovine-client-dispatcher.mjs']);

    const codexMarketplace = JSON.parse(
      fs.readFileSync(path.join(outRoot, '.agents', 'plugins', 'marketplace.json'), 'utf-8'),
    ) as {
      interface: { displayName: string };
      plugins: Array<{ source: { source: string; path: string }; policy: { installation: string } }>;
    };
    expect(codexMarketplace.interface.displayName).toBe('repovine');
    expect(codexMarketplace.plugins[0]?.source).toEqual({
      source: 'local',
      path: './repovine-plugins/codex',
    });
    expect(codexMarketplace.plugins[0]?.policy.installation).toBe('AVAILABLE');

    expect(fs.existsSync(path.join(outRoot, 'repovine-plugins', 'codex', '.mcp.json'))).toBe(true);

    const codexConfigToml = fs.readFileSync(
      path.join(outRoot, 'repovine-plugins', 'codex', '.codex', 'config.toml'),
      'utf-8',
    );
    expect(codexConfigToml).toContain('args = ["-y", "repovine@0.1.0-test"]');
    expect(codexConfigToml).not.toContain('args = ["-y", "repovine"]');
    // Plugin hooks address the plugin root; every command carries a Windows sibling.
    expect(codexConfigToml).toContain(
      `command = 'node "$PLUGIN_ROOT/.codex/hooks/repovine-client-dispatcher.mjs" boundary-notice codex'`,
    );
    expect(codexConfigToml).toContain(
      `command_windows = 'node "%PLUGIN_ROOT%/.codex/hooks/repovine-client-dispatcher.mjs" boundary-notice codex'`,
    );
    expect(codexConfigToml).not.toContain('$(git rev-parse');
    expect(codexConfigToml.match(/^command = /gm)?.length).toBe(4); // 1 MCP + 3 hooks
    expect(codexConfigToml.match(/^command_windows = /gm)?.length).toBe(3);

    const readme = fs.readFileSync(path.join(outRoot, 'README.md'), 'utf-8');
    expect(readme).toContain(`npx repovine@0.1.0-test setup`);
    expect(readme).not.toContain(`npx repovine@0.1.0-test init`);
    const cursorInstall = fs.readFileSync(path.join(outRoot, 'repovine-plugins', 'cursor', 'INSTALL.md'), 'utf-8');
    expect(cursorInstall).toContain(`npx repovine@0.1.0-test setup`);
  });

  it('wipes prior generated output but preserves assets/', () => {
    const engineRoot = resolveEngineRoot();
    const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-plugin-'));
    tmpRoots.push(outRoot);

    renderPluginRepo({ engineRoot, outRoot, version: '0.1.0-test' });

    const staleBundle = path.join(outRoot, 'repovine-plugins', 'cursor', 'STALE.txt');
    fs.writeFileSync(staleBundle, 'stale', 'utf-8');
    fs.mkdirSync(path.join(outRoot, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(outRoot, 'assets', 'keep.txt'), 'logo', 'utf-8');

    const second = renderPluginRepo({ engineRoot, outRoot, version: '0.1.0-test' });

    expect(fs.existsSync(staleBundle)).toBe(false);
    expect(fs.readFileSync(path.join(outRoot, 'assets', 'keep.txt'), 'utf-8')).toBe('logo');
    expect(second.wiped.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(outRoot, '.claude-plugin', 'marketplace.json'))).toBe(true);
    expect(fs.existsSync(path.join(outRoot, '.cursor-plugin', 'marketplace.json'))).toBe(true);
  });

  it('renders one client without deleting the other bundles', () => {
    const engineRoot = resolveEngineRoot();
    const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-plugin-'));
    tmpRoots.push(outRoot);

    renderPluginRepo({ engineRoot, outRoot, version: '0.1.0-test' });

    // outRoot defaults to the published plugins repo, so a scoped render must touch
    // only the selected client — the other bundles stay installable.
    const stale = path.join(outRoot, 'repovine-plugins', 'claude', 'STALE.txt');
    fs.writeFileSync(stale, 'stale', 'utf-8');
    const scoped = renderPluginRepo({ engineRoot, outRoot, version: '0.1.0-test', clients: ['claude'] });

    expect(scoped.clients).toEqual(['claude']);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(path.join(outRoot, '.claude-plugin', 'marketplace.json'))).toBe(true);

    for (const client of ['cursor', 'codex'] as const) {
      expect(fs.existsSync(path.join(outRoot, 'repovine-plugins', client, 'INSTALL.md'))).toBe(true);
    }
    expect(fs.existsSync(path.join(outRoot, '.cursor-plugin', 'marketplace.json'))).toBe(true);
    expect(fs.existsSync(path.join(outRoot, '.agents', 'plugins', 'marketplace.json'))).toBe(true);
  });

  it('wipePluginOutRoot scoped to a client removes only that client entries', () => {
    const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-wipe-'));
    tmpRoots.push(outRoot);

    for (const client of ['cursor', 'claude', 'codex']) {
      fs.mkdirSync(path.join(outRoot, 'repovine-plugins', client), { recursive: true });
    }
    fs.mkdirSync(path.join(outRoot, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(outRoot, '.cursor-plugin'), { recursive: true });
    fs.writeFileSync(path.join(outRoot, 'README.md'), 'old', 'utf-8');

    const removed = wipePluginOutRoot(outRoot, ['claude']);

    expect(removed).toEqual([path.join('repovine-plugins', 'claude'), '.claude-plugin'].sort());
    expect(fs.existsSync(path.join(outRoot, 'repovine-plugins', 'claude'))).toBe(false);
    expect(fs.existsSync(path.join(outRoot, 'repovine-plugins', 'cursor'))).toBe(true);
    expect(fs.existsSync(path.join(outRoot, 'repovine-plugins', 'codex'))).toBe(true);
    expect(fs.existsSync(path.join(outRoot, '.cursor-plugin'))).toBe(true);
    expect(fs.existsSync(path.join(outRoot, 'README.md'))).toBe(true);
  });

  it('wipePluginOutRoot removes generated entries only', () => {
    const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-wipe-'));
    tmpRoots.push(outRoot);

    fs.mkdirSync(path.join(outRoot, 'repovine-plugins'), { recursive: true });
    fs.mkdirSync(path.join(outRoot, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(outRoot, '.git'), { recursive: true });
    fs.writeFileSync(path.join(outRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf-8');
    fs.writeFileSync(path.join(outRoot, '.gitignore'), 'node_modules\n', 'utf-8');
    fs.writeFileSync(path.join(outRoot, 'README.md'), 'old', 'utf-8');

    const removed = wipePluginOutRoot(outRoot);

    expect(removed).toContain('README.md');
    expect(removed).toContain('repovine-plugins');
    expect(fs.existsSync(path.join(outRoot, 'assets'))).toBe(true);
    expect(fs.existsSync(path.join(outRoot, 'README.md'))).toBe(false);
    // .git and .gitignore are in PRESERVE_OUTROOT_ENTRIES so a render never nukes the plugins repo's own history.
    expect(removed).not.toContain('.git');
    expect(removed).not.toContain('.gitignore');
    expect(fs.readFileSync(path.join(outRoot, '.git', 'HEAD'), 'utf-8')).toBe('ref: refs/heads/main\n');
    expect(fs.existsSync(path.join(outRoot, '.gitignore'))).toBe(true);
  });
});
