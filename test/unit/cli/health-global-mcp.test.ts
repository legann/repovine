import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { inspectGlobalMcpConfigs, globalMcpFindings } from '../../../src/cli/health.js';

describe('doctor global-scope MCP sweep', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-global-home-'));
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('reports ok when no global client configs exist', () => {
    const checks = inspectGlobalMcpConfigs(['cursor', 'claude', 'codex'], homeDir);
    expect(checks).toHaveLength(3);
    expect(checks.every(check => !check.hasRepovine)).toBe(true);

    const findings = globalMcpFindings(checks);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('ok');
  });

  it('ignores global configs that have other servers but no repovine', () => {
    fs.mkdirSync(path.join(homeDir, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['-y', 'github-mcp'] } } }),
    );

    const checks = inspectGlobalMcpConfigs(['cursor'], homeDir);
    expect(checks[0]!.exists).toBe(true);
    expect(checks[0]!.hasRepovine).toBe(false);

    const findings = globalMcpFindings(checks);
    expect(findings[0]!.severity).toBe('ok');
  });

  it('flags a user-scope repovine server in ~/.claude.json', () => {
    fs.writeFileSync(
      path.join(homeDir, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          repovine: { command: 'npx', args: ['-y', 'repovine'], env: { REPOVINE_ROOT: '/some/other/repo' } },
        },
      }),
    );

    const checks = inspectGlobalMcpConfigs(['claude'], homeDir);
    expect(checks[0]!.hasRepovine).toBe(true);
    expect(checks[0]!.launch?.root).toBe('/some/other/repo');

    const findings = globalMcpFindings(checks, {
      Claude: { command: 'npx', args: ['-y', 'repovine'], root: '.' },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('warning');
    expect(findings[0]!.message).toContain('.claude.json');
    expect(findings[0]!.message).toContain('DIFFERS');
    expect(findings[0]!.message).toContain('REPOVINE_ROOT=/some/other/repo');
  });

  it('does not claim divergence when global and project launches match', () => {
    fs.writeFileSync(
      path.join(homeDir, '.claude.json'),
      JSON.stringify({
        mcpServers: { repovine: { command: 'npx', args: ['-y', 'repovine'], env: { REPOVINE_ROOT: '.' } } },
      }),
    );

    const checks = inspectGlobalMcpConfigs(['claude'], homeDir);
    const findings = globalMcpFindings(checks, {
      Claude: { command: 'npx', args: ['-y', 'repovine'], root: '.' },
    });
    expect(findings[0]!.severity).toBe('warning');
    expect(findings[0]!.message).not.toContain('DIFFERS');
  });

  it('flags [mcp_servers.repovine] in the global Codex config.toml and extracts its launch', () => {
    fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.codex', 'config.toml'),
      [
        '[mcp_servers.repovine]',
        'command = "node"',
        'args = ["/old/install/dist/mcp/index.js"]',
        '',
        '[mcp_servers.repovine.env]',
        'REPOVINE_ROOT = "/old/repo"',
        '',
        '[mcp_servers.other]',
        'command = "npx"',
      ].join('\n'),
    );

    const checks = inspectGlobalMcpConfigs(['codex'], homeDir);
    expect(checks[0]!.hasRepovine).toBe(true);
    expect(checks[0]!.launch).toEqual({
      command: 'node',
      args: ['/old/install/dist/mcp/index.js'],
      root: '/old/repo',
    });

    const findings = globalMcpFindings(checks, {
      Codex: { command: 'npx', args: ['-y', 'repovine'], root: '.' },
    });
    expect(findings[0]!.severity).toBe('warning');
    expect(findings[0]!.message).toContain('DIFFERS');
  });

  it('survives an unparseable global config without flagging repovine', () => {
    fs.writeFileSync(path.join(homeDir, '.claude.json'), '{not json');

    const checks = inspectGlobalMcpConfigs(['claude'], homeDir);
    expect(checks[0]!.parseOk).toBe(false);
    expect(checks[0]!.hasRepovine).toBe(false);

    const findings = globalMcpFindings(checks);
    expect(findings[0]!.severity).toBe('ok');
  });

  it('only inspects files for clients in scope', () => {
    fs.writeFileSync(
      path.join(homeDir, '.claude.json'),
      JSON.stringify({ mcpServers: { repovine: { command: 'npx', args: ['-y', 'repovine'] } } }),
    );

    const checks = inspectGlobalMcpConfigs(['cursor'], homeDir);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.client).toBe('Cursor');
    expect(globalMcpFindings(checks)[0]!.severity).toBe('ok');
  });
});
