import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { renderPluginRepo } from '../../../src/cli/plugin-render.js';

function resolveEngineRoot(): string {
  const candidates = [process.cwd(), path.resolve(process.cwd(), 'repovine')];
  const found = candidates.find((root) =>
    fs.existsSync(path.join(root, 'package.json'))
    && fs.existsSync(path.join(root, 'scripts', 'validate-client-plugins.mjs')),
  );
  if (!found) throw new Error('repovine engine root not found from test cwd');
  return found;
}

/** Run the maintainer validator against a rendered plugin repo. */
function validate(outRoot: string): { code: number; output: string } {
  const script = path.join(resolveEngineRoot(), 'scripts', 'validate-client-plugins.mjs');
  try {
    const stdout = execFileSync(process.execPath, [script, '--out', outRoot], { encoding: 'utf-8', stdio: 'pipe' });
    return { code: 0, output: stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

describe('validate-client-plugins', () => {
  const tmpRoots: string[] = [];
  let engineRoot: string;

  beforeAll(() => {
    engineRoot = resolveEngineRoot();
  });

  afterEach(() => {
    for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
    tmpRoots.length = 0;
  });

  function render(): string {
    const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-validate-'));
    tmpRoots.push(outRoot);
    renderPluginRepo({ engineRoot, outRoot, version: '0.1.0-test' });
    return outRoot;
  }

  it('passes on a freshly rendered plugin repo', () => {
    const result = validate(render());
    expect(result.output).toContain('Static checks passed');
    expect(result.code).toBe(0);
  });

  it('fails when the dispatcher a hooks file calls is missing', () => {
    const outRoot = render();
    fs.rmSync(path.join(outRoot, 'repovine-plugins', 'claude', 'hooks', 'repovine-client-dispatcher.mjs'));

    const result = validate(outRoot);

    expect(result.code).toBe(1);
    expect(result.output).toContain('repovine-client-dispatcher.mjs');
  });

  it('fails when the cursor MCP server drops the required type "stdio"', () => {
    const outRoot = render();
    const mcpPath = path.join(outRoot, 'repovine-plugins', 'cursor', '.cursor', 'mcp.json');
    const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf-8')) as {
      mcpServers: Record<string, { type?: string }>;
    };
    delete mcp.mcpServers.repovine.type;
    fs.writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`, 'utf-8');

    const result = validate(outRoot);

    expect(result.code).toBe(1);
    expect(result.output).toContain('type "stdio"');
  });

  it('fails when a codex hook command loses its command_windows sibling', () => {
    const outRoot = render();
    const tomlPath = path.join(outRoot, 'repovine-plugins', 'codex', '.codex', 'config.toml');
    const toml = fs.readFileSync(tomlPath, 'utf-8')
      .split('\n')
      .filter(line => !line.startsWith('command_windows = '))
      .join('\n');
    fs.writeFileSync(tomlPath, toml, 'utf-8');

    const result = validate(outRoot);

    expect(result.code).toBe(1);
    expect(result.output).toContain('command_windows');
  });

  it('fails when an MCP config pins a version the manifests do not carry', () => {
    const outRoot = render();
    const mcpPath = path.join(outRoot, 'repovine-plugins', 'claude', '.mcp.json');
    const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf-8')) as {
      mcpServers: Record<string, { args: string[] }>;
    };
    mcp.mcpServers.repovine.args = ['-y', 'repovine@9.9.9'];
    fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2), 'utf-8');

    const result = validate(outRoot);

    expect(result.code).toBe(1);
    expect(result.output).toContain('repovine@9.9.9');
  });

  it('fails when a client bundle ships no MCP config', () => {
    const outRoot = render();
    fs.rmSync(path.join(outRoot, 'repovine-plugins', 'cursor', '.cursor', 'mcp.json'));

    const result = validate(outRoot);

    expect(result.code).toBe(1);
    expect(result.output).toContain('.cursor/mcp.json');
  });

  it('fails when the Claude manifest points hooks at the auto-loaded default file', () => {
    const outRoot = render();
    const manifestPath = path.join(outRoot, 'repovine-plugins', 'claude', '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    manifest.hooks = './hooks/hooks.json';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    const result = validate(outRoot);

    expect(result.code).toBe(1);
    expect(result.output).toContain('duplicate hooks');
  });
});
