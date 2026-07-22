import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  writeMcpJsonConfig,
  writeCodexMcpConfig,
  resolveMcpJsonWritePlan,
  inspectMcpJsonConfig,
} from '../../../src/cli/merge-config.js';

const SERVER_ENTRY = {
  command: 'npx',
  args: ['-y', 'repovine'],
  env: { REPOVINE_ROOT: '.' },
};

const FULL_TEMPLATE = JSON.stringify(
  { mcpServers: { 'repovine': SERVER_ENTRY } },
  null,
  2,
) + '\n';

const CODEX_BLOCK = `[mcp_servers.repovine]
command = "npx"
`;

const CODEX_FULL = `project_doc_max_bytes = 65536\n\n${CODEX_BLOCK}`;

describe('resolveMcpJsonWritePlan', () => {
  it('requires merge when other servers exist', () => {
    const plan = resolveMcpJsonWritePlan(
      { kind: 'has-other-servers', otherServers: ['playwright', 'github'] },
      false,
    );
    expect(plan.plan).toBe('merge');
    expect(plan.reason).toContain('playwright');
  });

  it('downgrades --replace-mcp to merge when others exist', () => {
    const plan = resolveMcpJsonWritePlan(
      { kind: 'has-other-servers', otherServers: ['playwright'] },
      true,
    );
    expect(plan.plan).toBe('merge');
    expect(plan.reason).toContain('refusing --replace-mcp');
  });
});

describe('writeMcpJsonConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-mcp-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates file when missing', () => {
    const filePath = path.join(tmpDir, 'mcp.json');
    const result = writeMcpJsonConfig(filePath, 'mcpServers', SERVER_ENTRY, FULL_TEMPLATE, false);
    expect(result.status).toBe('created');
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(parsed.mcpServers['repovine']).toEqual(SERVER_ENTRY);
  });

  it('merges into existing mcpServers without removing other servers', () => {
    const filePath = path.join(tmpDir, 'mcp.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        mcpServers: {
          'other-server': { command: 'echo', args: ['hi'] },
        },
      }, null, 2),
    );

    const result = writeMcpJsonConfig(filePath, 'mcpServers', SERVER_ENTRY, FULL_TEMPLATE, false);
    expect(result.status).toBe('merged');
    expect(fs.existsSync(`${filePath}.bak`)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(parsed.mcpServers['other-server']).toEqual({ command: 'echo', args: ['hi'] });
    expect(parsed.mcpServers['repovine']).toEqual(SERVER_ENTRY);
  });

  it('skips when repovine already configured', () => {
    const filePath = path.join(tmpDir, 'mcp.json');
    fs.writeFileSync(filePath, FULL_TEMPLATE);

    const result = writeMcpJsonConfig(filePath, 'mcpServers', SERVER_ENTRY, FULL_TEMPLATE, false);
    expect(result.status).toBe('skipped');
  });

  it('creates mcpServers key when missing on existing file', () => {
    const filePath = path.join(tmpDir, 'mcp.json');
    fs.writeFileSync(filePath, JSON.stringify({ other: true }));

    const result = writeMcpJsonConfig(filePath, 'mcpServers', SERVER_ENTRY, FULL_TEMPLATE, false);
    expect(result.status).toBe('merged');
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(parsed.mcpServers['repovine']).toEqual(SERVER_ENTRY);
    expect(parsed.other).toBe(true);
  });

  it('merges into a CRLF file and keeps CRLF', () => {
    const filePath = path.join(tmpDir, 'mcp.json');
    const original = JSON.stringify({
      mcpServers: { other: { command: 'echo' } },
    }, null, 2).replace(/\n/g, '\r\n') + '\r\n';
    fs.writeFileSync(filePath, original);

    const result = writeMcpJsonConfig(filePath, 'mcpServers', SERVER_ENTRY, FULL_TEMPLATE, false);
    expect(result.status).toBe('merged');

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('\r\n');
    expect(content.replace(/\r\n/g, '')).not.toContain('\n');
    const parsed = JSON.parse(content);
    expect(parsed.mcpServers.other).toEqual({ command: 'echo' });
    expect(parsed.mcpServers['repovine']).toEqual(SERVER_ENTRY);
  });

  it('--replace-mcp is refused when other servers exist (stays merge)', () => {
    const filePath = path.join(tmpDir, 'mcp.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
    );

    const plan = resolveMcpJsonWritePlan(inspectMcpJsonConfig(filePath), true);
    expect(plan.plan).toBe('merge');

    const result = writeMcpJsonConfig(filePath, 'mcpServers', SERVER_ENTRY, FULL_TEMPLATE, true);
    expect(result.status).toBe('merged');
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(parsed.mcpServers.other).toEqual({ command: 'x' });
    expect(parsed.mcpServers['repovine']).toEqual(SERVER_ENTRY);
  });

  it('--replace-mcp replaces file when mcpServers is empty', () => {
    const filePath = path.join(tmpDir, 'mcp.json');
    fs.writeFileSync(filePath, JSON.stringify({ mcpServers: {} }));

    const result = writeMcpJsonConfig(filePath, 'mcpServers', SERVER_ENTRY, FULL_TEMPLATE, true);
    expect(result.status).toBe('overwritten');
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(Object.keys(parsed.mcpServers)).toEqual(['repovine']);
  });

  it('skips invalid JSON (no --replace-mcp) without modifying file', () => {
    const filePath = path.join(tmpDir, 'mcp.json');
    fs.writeFileSync(filePath, '{ broken');

    const result = writeMcpJsonConfig(filePath, 'mcpServers', SERVER_ENTRY, FULL_TEMPLATE, false);
    expect(result.status).toBe('skipped');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('{ broken');
  });

  it('returns error when mcpServers is a non-object (merge shape guard), leaving file intact', () => {
    const filePath = path.join(tmpDir, 'mcp.json');
    // Valid JSON, but mcpServers is an array — inspect classifies it as `empty`
    // → plan `merge` → applyMcpJsonPlan's object-shape guard drives status `error`.
    const original = JSON.stringify({ mcpServers: ['not', 'an', 'object'] });
    fs.writeFileSync(filePath, original);

    const result = writeMcpJsonConfig(filePath, 'mcpServers', SERVER_ENTRY, FULL_TEMPLATE, false);
    expect(result.status).toBe('error');
    expect(result.message).toContain('Expected "mcpServers" to be an object');
    // No backup written and file untouched on the error path.
    expect(result.backupPath).toBeUndefined();
    expect(fs.existsSync(`${filePath}.bak`)).toBe(false);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(original);
  });
});

describe('writeCodexMcpConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-codex-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends server block to existing config.toml', () => {
    const filePath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(filePath, 'project_doc_max_bytes = 1000\n');

    const result = writeCodexMcpConfig(filePath, CODEX_BLOCK, CODEX_FULL, false);
    expect(result.status).toBe('merged');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('project_doc_max_bytes = 1000');
    expect(content).toContain('[mcp_servers.repovine]');
  });

  it('skips when section already present', () => {
    const filePath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(filePath, CODEX_FULL);

    const result = writeCodexMcpConfig(filePath, CODEX_BLOCK, CODEX_FULL, false);
    expect(result.status).toBe('skipped');
  });

  it('appends with CRLF into a CRLF config.toml', () => {
    const filePath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(filePath, 'project_doc_max_bytes = 1000\r\n');

    const result = writeCodexMcpConfig(filePath, CODEX_BLOCK, CODEX_FULL, false);
    expect(result.status).toBe('merged');

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('project_doc_max_bytes = 1000');
    expect(content).toContain('[mcp_servers.repovine]');
    expect(content).toContain('\r\n');
    expect(content.replace(/\r\n/g, '')).not.toContain('\n'); // every line CRLF
  });

  it('keeps non-managed bytes verbatim when merging into a mixed-EOL config.toml', () => {
    const filePath = path.join(tmpDir, 'config.toml');
    // Majority-CRLF file with an LF-bodied TOML multi-line string.
    const original = [
      'project_doc_max_bytes = 1000\r\n',
      'notes = """\r\n',
      'line one\n',
      'line two\n',
      '"""\r\n',
    ].join('');
    fs.writeFileSync(filePath, original);

    const result = writeCodexMcpConfig(filePath, CODEX_BLOCK, CODEX_FULL, false);
    expect(result.status).toBe('merged');

    const content = fs.readFileSync(filePath, 'utf-8');
    // The user region survives byte-for-byte; only the LF repovine block is appended.
    expect(content.startsWith(original)).toBe(true);
    expect(content).toContain('[mcp_servers.repovine]');
    expect(content.slice(original.length)).not.toContain('\r');
  });

  it('skips a CRLF file whose hooks block is already up to date (no rewrite)', () => {
    const filePath = path.join(tmpDir, 'config.toml');
    const hooksBlock = '# BEGIN repovine hooks\nnotify = ["node", "hook.js"]\n# END repovine hooks';
    const original = `${CODEX_BLOCK}\n${hooksBlock}\n`.replace(/\n/g, '\r\n');
    fs.writeFileSync(filePath, original);

    const result = writeCodexMcpConfig(filePath, CODEX_BLOCK, CODEX_FULL, false, hooksBlock);
    expect(result.status).toBe('skipped');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(original); // no spurious rewrite
  });

  it('does not add Codex tool approval blocks when repovine section already exists', () => {
    const filePath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(
      filePath,
      `[mcp_servers.repovine]\ncommand = "npx"\n`,
    );

    const result = writeCodexMcpConfig(filePath, CODEX_BLOCK, CODEX_FULL, false);
    expect(result.status).toBe('skipped');

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('[mcp_servers.repovine]');
    expect(content).not.toContain('[mcp_servers.repovine.tools.');
    expect(content).not.toContain('approval_mode');
  });
});
