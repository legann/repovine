/**
 * Self-dogfood MCP launcher: `setup` wires the MCP at whatever engine ran it —
 * a contributor's local dist/ from the source repo, otherwise the published npx.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { resolveMcpLauncher, initClaude } from '../../../src/cli/init.js';
import {
  NPX_LAUNCHER,
  buildClaudeMcpJson,
  buildCodexConfigToml,
  type McpLauncher,
} from '../../../src/cli/templates.js';

describe('resolveMcpLauncher', () => {
  const repo = path.resolve('/home/dev/repovine');
  const localEntry = path.join(repo, 'dist', 'mcp', 'index.js');

  it('wires the local dist when the engine runs from inside the source repo', () => {
    const launcher = resolveMcpLauncher(repo, localEntry, { nodePath: '/usr/bin/node' });
    expect(launcher.command).toBe('/usr/bin/node');
    expect(launcher.args).toEqual([localEntry]);
  });

  it('falls back to npx for a consumer repo (engine outside the repo)', () => {
    const launcher = resolveMcpLauncher(
      '/home/dev/my-app',
      '/home/dev/.npm/_npx/abc/node_modules/repovine/dist/mcp/index.js',
    );
    expect(launcher).toEqual(NPX_LAUNCHER);
  });

  it('falls back to npx for a node_modules install nested inside the repo', () => {
    const launcher = resolveMcpLauncher(repo, path.join(repo, 'node_modules', 'repovine', 'dist', 'mcp', 'index.js'));
    expect(launcher).toEqual(NPX_LAUNCHER);
  });

  it('forces npx from the source repo when forcePublished is set (release validation)', () => {
    const launcher = resolveMcpLauncher(repo, localEntry, { forcePublished: true });
    expect(launcher).toEqual(NPX_LAUNCHER);
  });
});

describe('MCP template builders', () => {
  it('npx default renders the published launcher', () => {
    const claude = JSON.parse(buildClaudeMcpJson());
    expect(claude.mcpServers.repovine.command).toBe('npx');
    expect(claude.mcpServers.repovine.args).toEqual(['-y', 'repovine']);
    expect(buildCodexConfigToml()).toContain('command = "npx"');
    expect(buildCodexConfigToml()).toContain('args = ["-y", "repovine"]');
  });

  it('local launcher renders node + dist entry instead of npx', () => {
    const local: McpLauncher = { command: '/usr/bin/node', args: ['/repo/dist/mcp/index.js'] };
    const claude = JSON.parse(buildClaudeMcpJson(local));
    expect(claude.mcpServers.repovine.command).toBe('/usr/bin/node');
    expect(claude.mcpServers.repovine.args).toEqual(['/repo/dist/mcp/index.js']);
    expect(claude.mcpServers.repovine.env.REPOVINE_ROOT).toBe('.');
    const codex = buildCodexConfigToml(local);
    expect(codex).toContain('command = "/usr/bin/node"');
    expect(codex).toContain('args = ["/repo/dist/mcp/index.js"]');
  });
});

describe('initClaude threads the launcher into .mcp.json', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-launcher-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the local launcher when one is supplied', () => {
    const entry = path.join(dir, 'dist', 'mcp', 'index.js');
    initClaude(dir, {
      forceBootstrap: false,
      replaceMcp: false,
      mcpLauncher: { command: '/usr/bin/node', args: [entry] },
    });
    const mcp = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf-8'));
    expect(mcp.mcpServers.repovine.command).toBe('/usr/bin/node');
    expect(mcp.mcpServers.repovine.args).toEqual([entry]);
  });

  it('defaults to npx when no launcher is supplied', () => {
    initClaude(dir, { forceBootstrap: false, replaceMcp: false });
    const mcp = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf-8'));
    expect(mcp.mcpServers.repovine.command).toBe('npx');
  });
});
