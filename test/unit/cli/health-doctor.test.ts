import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, expect, it, beforeEach, afterEach, jest } from '@jest/globals';
import { darwinTransformersFloorWarning, detectFsCase, parseLongPathsRegOutput, runDoctorCli } from '../../../src/cli/health.js';
import { CURSOR_RULES } from '../../../src/cli/onboarding-assets.js';
import { renderAgentAssets } from '../../../src/cli/agent-render.js';

describe('runDoctorCli client scope', () => {
  let repoRoot: string;
  let homeDir: string;
  let env: { repoRoot: string; artifactsDir: string };
  let outSpy: ReturnType<typeof jest.spyOn>;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'health-doctor-'));
    // Point os.homedir() at a clean temp home so the global-MCP sweep does not
    // read the runner's real ~/.claude.json etc. Keeps Global MCP findings
    // deterministic regardless of the machine's actual home. os.homedir() reads
    // HOME (POSIX) / USERPROFILE (Windows).
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-doctor-home-'));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    env = { repoRoot, artifactsDir: path.join(repoRoot, '.repovine') };
    outSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    jest.restoreAllMocks();
  });

  function lastJson(): {
    findings: Array<{ area: string; message: string; severity: string }>;
    clientScope: { clients: string[]; description: string };
    agentAssets: { clients: string[]; ok: boolean };
    platform: {
      os: string;
      arch: string;
      node: string;
      execPath: string;
      entrypoint: string | null;
      git: { version: string | null };
      python: { interpreter: string | null; version: string | null };
      fsCase: string;
      embedder: {
        enabled: boolean;
        model: string;
        transformers: { resolved: boolean; source: string | null; entryPath: string | null; version: string | null };
        modelCacheDir: string | null;
        modelCacheDirExists: boolean;
        darwinFloorWarning: string | null;
      };
      supportDoc: string;
    };
  } {
    const calls = outSpy.mock.calls;
    return JSON.parse(String(calls[calls.length - 1][0]));
  }

  function writeCursorMcp(): void {
    fs.mkdirSync(path.join(repoRoot, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { repovine: { command: 'node', args: [] } } }),
    );
  }

  function writeCursorRules(): void {
    const dir = path.join(repoRoot, '.cursor', 'rules');
    fs.mkdirSync(dir, { recursive: true });
    for (const rule of CURSOR_RULES) {
      fs.writeFileSync(path.join(dir, `${rule.name}.mdc`), rule.body);
    }
  }

  it('reports cursor-only scope and skips Claude/Codex MCP warnings', async () => {
    writeCursorMcp();
    writeCursorRules();
    renderAgentAssets({ repoRoot, client: 'cursor', write: true });
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# stale AGENTS.md\n');

    expect(await runDoctorCli(['--json'], env)).toBe(0);
    const result = lastJson();
    expect(result.clientScope.clients).toEqual(['cursor']);
    expect(result.clientScope.description).toContain('auto-detected');
    expect(result.findings.some(f => f.area === 'Client scope' && f.message.includes('cursor'))).toBe(true);
    expect(result.findings.some(f => f.area === 'Claude MCP')).toBe(false);
    expect(result.findings.some(f => f.area === 'Codex MCP')).toBe(false);
    expect(result.findings.some(f => f.area === 'AGENTS.md' && f.message.includes('Not in scope'))).toBe(true);
    expect(result.findings.some(f => f.area.startsWith('agent assets: AGENTS.md'))).toBe(false);
  });

  it('reports all three clients when all MCP configs are present', async () => {
    writeCursorMcp();
    fs.writeFileSync(
      path.join(repoRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: { repovine: { command: 'node', args: [] } } }),
    );
    fs.mkdirSync(path.join(repoRoot, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, '.codex', 'config.toml'),
      '[mcp_servers.repovine]\ncommand = "node"\n',
    );

    expect(await runDoctorCli(['--json'], env)).toBe(0);
    const result = lastJson();
    expect(result.clientScope.clients).toEqual(['cursor', 'claude', 'codex']);
    expect(result.findings.some(f => f.area === 'Client scope' && f.message.includes('cursor, claude, codex'))).toBe(true);
    expect(result.findings.some(f => f.area === 'Cursor MCP')).toBe(true);
    expect(result.findings.some(f => f.area === 'Claude MCP')).toBe(true);
    expect(result.findings.some(f => f.area === 'Codex MCP')).toBe(true);
  });

  it('includes agentAssets in --json output', async () => {
    writeCursorMcp();
    writeCursorRules();
    renderAgentAssets({ repoRoot, client: 'cursor', write: true });

    expect(await runDoctorCli(['--json'], env)).toBe(0);
    const result = lastJson();
    expect(result.agentAssets.clients).toEqual(['cursor']);
    expect(result.agentAssets.ok).toBe(true);
  });

  it('places Global MCP findings last', async () => {
    writeCursorMcp();

    expect(await runDoctorCli(['--json'], env)).toBe(0);
    const result = lastJson();
    const last = result.findings[result.findings.length - 1];
    expect(last.area).toBe('Global MCP');
    expect(last.message).toContain('No user-scope repovine MCP servers detected');
  });

  it('includes a platform report in --json output', async () => {
    writeCursorMcp();

    expect(await runDoctorCli(['--json'], env)).toBe(0);
    const result = lastJson();
    const platform = result.platform;
    expect(platform).toBeDefined();
    expect(platform.os).toBe(process.platform);
    expect(platform.arch).toBe(process.arch);
    expect(platform.node).toBe(process.version);
    expect(platform.execPath).toBe(process.execPath);
    expect(['known-sensitive', 'known-insensitive', 'unknown']).toContain(platform.fsCase);
    // git is present on every CI runner; python may legitimately be absent.
    // string on any machine with git (all CI runners); null tolerated on a dev box without it
    expect(typeof platform.git.version === 'string' || platform.git.version === null).toBe(true);
    expect(typeof platform.python.interpreter === 'string' || platform.python.interpreter === null).toBe(true);
    expect(platform.embedder.model).toBe('Xenova/all-MiniLM-L6-v2');
    expect(typeof platform.embedder.transformers.resolved).toBe('boolean');
    expect(typeof platform.embedder.modelCacheDir).toBe('string');
    expect(typeof platform.embedder.modelCacheDirExists).toBe('boolean');
    expect(platform.supportDoc).toBe('docs/platform-support.md');
    // Tripwire: the report must carry no env var dumps.
    expect(JSON.stringify(platform)).not.toContain('API_KEY');

    // Platform findings are present and never displace Global MCP from last place.
    expect(result.findings.some(f => f.area === 'platform')).toBe(true);
    expect(result.findings[result.findings.length - 1]!.area).toBe('Global MCP');
  });

  function writeBoundaryIndexFile(version: number): void {
    fs.mkdirSync(path.join(repoRoot, '.repovine'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, '.repovine', 'boundary-index.json'),
      JSON.stringify({ version, builtAt: new Date().toISOString(), entries: {} }),
    );
  }

  it('warns when the pre-edit boundary index is missing', async () => {
    writeCursorMcp();
    expect(await runDoctorCli(['--json'], env)).toBe(0);
    const result = lastJson();
    const finding = result.findings.find(f => f.area === 'boundary push channel');
    expect(finding).toBeDefined();
    expect(finding!.message).toContain('No pre-edit boundary index');
  });

  it('reports ok when a current-version boundary index is present', async () => {
    writeCursorMcp();
    writeBoundaryIndexFile(1);
    expect(await runDoctorCli(['--json'], env)).toBe(0);
    const result = lastJson();
    const finding = result.findings.find(f => f.area === 'boundary push channel');
    expect(finding!.message).toContain('present');
    // A warning-state message can also contain 'present' (e.g. "present but not
    // valid JSON"); the happy path must be the ok severity, not just the word.
    expect(finding!.severity).toBe('ok');
  });

  it('warns when an installed hook accepts a different index schema version', async () => {
    writeCursorMcp();
    writeBoundaryIndexFile(1);
    fs.mkdirSync(path.join(repoRoot, '.cursor', 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, '.cursor', 'hooks', 'repovine-client-dispatcher.mjs'),
      'if (index.version !== 2) process.exit(0);',
    );
    expect(await runDoctorCli(['--json'], env)).toBe(0);
    const result = lastJson();
    const finding = result.findings.find(
      f => f.area === 'boundary push channel' && f.message.includes('Installed Cursor'),
    );
    expect(finding).toBeDefined();
    expect(finding!.message).toContain('v2');
  });

  it('reads the accepted schema version from the installed dispatcher', async () => {
    writeCursorMcp();
    writeBoundaryIndexFile(1);
    fs.mkdirSync(path.join(repoRoot, '.cursor', 'hooks'), { recursive: true });
    // Current-version dispatcher: no version-drift warning.
    fs.writeFileSync(
      path.join(repoRoot, '.cursor', 'hooks', 'repovine-client-dispatcher.mjs'),
      'if (index.version !== 1) process.exit(0);',
    );
    expect(await runDoctorCli(['--json'], env)).toBe(0);
    expect(lastJson().findings.some(
      f => f.area === 'boundary push channel' && f.message.includes('Installed Cursor'),
    )).toBe(false);

    // Drifted dispatcher: version warning fires.
    fs.writeFileSync(
      path.join(repoRoot, '.cursor', 'hooks', 'repovine-client-dispatcher.mjs'),
      'if (index.version !== 2) process.exit(0);',
    );
    expect(await runDoctorCli(['--json'], env)).toBe(0);
    const drift = lastJson().findings.find(
      f => f.area === 'boundary push channel' && f.message.includes('Installed Cursor'),
    );
    expect(drift).toBeDefined();
    expect(drift!.message).toContain('v2');
  });
});

describe('detectFsCase', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-case-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('classifies a dir containing package.json', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    const verdict = detectFsCase(dir);
    expect(verdict).not.toBe('unknown');
    if (process.platform === 'linux') {
      expect(verdict).toBe('known-sensitive');
    }
  });

  it('returns unknown for an empty dir', () => {
    expect(detectFsCase(dir)).toBe('unknown');
  });

  it('skips a candidate whose case-inverted twin really exists', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'PACKAGE.JSON'), '{}');
    // On a case-insensitive FS the second write aliases the first; the twin
    // scenario only exists when both names are distinct directory entries.
    if (fs.readdirSync(dir).length === 2) {
      expect(detectFsCase(dir)).toBe('unknown');
    }
  });
});

describe('darwinTransformersFloorWarning', () => {
  it('warns for transformers < 4 on darwin', () => {
    const warning = darwinTransformersFloorWarning('darwin', '3.8.1');
    expect(warning).not.toBeNull();
    expect(warning).toContain('4');
    expect(warning).toContain('docs/platform-support.md');
  });

  it('is null for transformers >= 4 on darwin', () => {
    expect(darwinTransformersFloorWarning('darwin', '4.2.0')).toBeNull();
  });

  it('is null on other platforms', () => {
    expect(darwinTransformersFloorWarning('linux', '3.8.1')).toBeNull();
  });

  it('is null without a version', () => {
    expect(darwinTransformersFloorWarning('darwin', undefined)).toBeNull();
  });
});

describe('parseLongPathsRegOutput', () => {
  const regQueryOutput = (dword: string): string =>
    '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\FileSystem\r\n'
    + `    LongPathsEnabled    REG_DWORD    ${dword}\r\n\r\n`;

  it('reads 0x1 as enabled', () => {
    expect(parseLongPathsRegOutput(regQueryOutput('0x1'))).toBe('enabled');
  });

  it('reads 0x0 as disabled', () => {
    expect(parseLongPathsRegOutput(regQueryOutput('0x0'))).toBe('disabled');
  });

  it('is unknown when the value line is absent', () => {
    const keyOnly = '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\FileSystem\r\n\r\n';
    expect(parseLongPathsRegOutput(keyOnly)).toBe('unknown');
  });

  it('is unknown on garbage output', () => {
    expect(parseLongPathsRegOutput('ERROR: The system was unable to find the specified registry key or value.')).toBe('unknown');
  });

  it('is unknown on empty output', () => {
    expect(parseLongPathsRegOutput('')).toBe('unknown');
  });
});
