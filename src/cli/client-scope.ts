/**
 * Client scope detection for agent-asset doctor and health checks.
 *
 * Maps repovine setup targets to the instruction surfaces each client reads:
 *   - Cursor  → `.cursor/rules/repovine-*.mdc` + `.cursor/agents` + `.agents/skills`
 *   - Claude  → `AGENTS.md` + `.claude/agents` + `.claude/skills`
 *   - Codex   → `AGENTS.md` + `.codex/agents` + `.agents/skills`
 */
import fs from 'node:fs';
import path from 'node:path';

export type DoctorClient = 'cursor' | 'claude' | 'codex';
export type DoctorClientScope = DoctorClient | 'all';

const ALL_DOCTOR_CLIENTS: DoctorClient[] = ['cursor', 'claude', 'codex'];

export interface ResolvedDoctorClients {
  /** Clients whose instruction surfaces and agent dirs are checked. */
  clients: DoctorClient[];
  /** How the scope was chosen. */
  scope: 'auto' | DoctorClientScope;
  /** Clients detected from MCP config when scope is auto (empty when none found). */
  detected: DoctorClient[];
}

function jsonMcpHasrepovine(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    const servers = parsed.mcpServers;
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return false;
    return Object.prototype.hasOwnProperty.call(servers as Record<string, unknown>, 'repovine');
  } catch {
    return false;
  }
}

function codexConfigHasrepovine(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    return fs.readFileSync(filePath, 'utf-8').includes('[mcp_servers.repovine]');
  } catch {
    return false;
  }
}

/** Detect which clients have a repovine MCP entry configured. */
export function detectConfiguredDoctorClients(repoRoot: string): DoctorClient[] {
  const detected: DoctorClient[] = [];
  if (jsonMcpHasrepovine(path.join(repoRoot, '.cursor', 'mcp.json'))) detected.push('cursor');
  if (jsonMcpHasrepovine(path.join(repoRoot, '.mcp.json'))) detected.push('claude');
  if (codexConfigHasrepovine(path.join(repoRoot, '.codex', 'config.toml'))) detected.push('codex');
  return detected;
}

/**
 * Resolve which clients the doctor should inspect.
 * Default (`client` omitted): auto-detect from MCP config; when none found, check all.
 */
export function resolveDoctorClients(
  repoRoot: string,
  client?: DoctorClientScope,
): ResolvedDoctorClients {
  if (client === 'all') {
    return { clients: [...ALL_DOCTOR_CLIENTS], scope: 'all', detected: [] };
  }
  if (client === 'cursor' || client === 'claude' || client === 'codex') {
    return { clients: [client], scope: client, detected: [] };
  }

  const detected = detectConfiguredDoctorClients(repoRoot);
  return {
    clients: detected.length > 0 ? detected : [...ALL_DOCTOR_CLIENTS],
    scope: 'auto',
    detected,
  };
}

/** True when AGENTS.md is the main-agent instruction surface for the active scope. */
export function scopeUsesAgentsMd(clients: DoctorClient[]): boolean {
  return clients.includes('claude') || clients.includes('codex');
}

/** MCP config check labels used by `repovine doctor` (matches inspectMcpConfigs). */
export const DOCTOR_CLIENT_MCP_LABEL: Record<DoctorClient, 'Cursor' | 'Claude' | 'Codex'> = {
  cursor: 'Cursor',
  claude: 'Claude',
  codex: 'Codex',
};

/** Human-readable client scope line for CLI doctor output. */
export function describeDoctorClientScope(resolved: ResolvedDoctorClients): string {
  const names = resolved.clients.join(', ');
  if (resolved.scope === 'auto') {
    if (resolved.detected.length > 0) {
      return `${names} (auto-detected from MCP config)`;
    }
    return `${names} (no MCP config found; checking all clients)`;
  }
  if (resolved.scope === 'all') {
    return names;
  }
  return `${names} (explicit)`;
}
