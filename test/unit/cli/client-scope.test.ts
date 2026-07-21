import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import {
  detectConfiguredDoctorClients,
  resolveDoctorClients,
  scopeUsesAgentsMd,
  describeDoctorClientScope,
} from '../../../src/cli/client-scope.js';

describe('client-scope', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'client-scope-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('detects configured clients from MCP config files', () => {
    fs.mkdirSync(path.join(repoRoot, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { repovine: { command: 'node' } } }),
    );
    expect(detectConfiguredDoctorClients(repoRoot)).toEqual(['cursor']);
  });

  it('auto-resolves to all clients when none are configured', () => {
    const resolved = resolveDoctorClients(repoRoot);
    expect(resolved.scope).toBe('auto');
    expect(resolved.detected).toEqual([]);
    expect(resolved.clients).toEqual(['cursor', 'claude', 'codex']);
  });

  it('honours explicit client scope', () => {
    const resolved = resolveDoctorClients(repoRoot, 'cursor');
    expect(resolved.scope).toBe('cursor');
    expect(resolved.clients).toEqual(['cursor']);
  });

  it('scopeUsesAgentsMd is false for cursor-only', () => {
    expect(scopeUsesAgentsMd(['cursor'])).toBe(false);
    expect(scopeUsesAgentsMd(['claude'])).toBe(true);
    expect(scopeUsesAgentsMd(['cursor', 'claude'])).toBe(true);
  });

  it('describeDoctorClientScope formats auto-detected clients', () => {
    expect(describeDoctorClientScope({
      clients: ['cursor'],
      scope: 'auto',
      detected: ['cursor'],
    })).toBe('cursor (auto-detected from MCP config)');

    expect(describeDoctorClientScope({
      clients: ['cursor', 'claude', 'codex'],
      scope: 'auto',
      detected: ['cursor', 'claude', 'codex'],
    })).toBe('cursor, claude, codex (auto-detected from MCP config)');
  });
});
