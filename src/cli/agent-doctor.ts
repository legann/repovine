/**
 * Agent-asset doctor.
 *
 * Compares on-disk managed setup projections against the canonical onboarding
 * templates (SSoT). When a managed file exists for the active client scope,
 * its bytes must match what `repovine setup` would render today.
 *
 * Scope is client-aware (cursor / claude / codex). Project-owned agent files are
 * scanned for stale MCP tool names only — they are not compared to templates.
 *
 * Read-only — regenerate managed assets with `repovine setup` (or `repovine setup --force`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROTOCOL_VERSION } from '../agents/protocol.js';
import { PROJECTION_VERSION } from './agent-projection.js';
import {
  type DoctorClient,
  type DoctorClientScope,
  type ResolvedDoctorClients,
  resolveDoctorClients,
} from './client-scope.js';
import { AGENTS_MD_BEGIN_MARKER, AGENTS_MD_END_MARKER } from './templates.js';
import {
  listCanonicalManagedAssets,
  readManagedFile,
} from './managed-setup-assets.js';

const CURSOR_MIXED_SURFACES_LABEL = 'Cursor instruction surfaces';

export interface AgentAssetFinding {
  file: string;
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface DoctorAgentAssetsReport {
  ok: boolean;
  protocolVersion: string;
  projectionVersion: string;
  clients: DoctorClient[];
  clientScope: ResolvedDoctorClients['scope'];
  detectedClients: DoctorClient[];
  scanned: string[];
  governed: string[];
  findings: AgentAssetFinding[];
  summary: { assets: number; governed: number; errors: number; warnings: number };
}

/** CLI finding row for `repovine doctor` (human) and `repovine doctor --json` (CI). */
export interface AgentAssetDoctorCliFinding {
  area: string;
  severity: 'ok' | 'warning' | 'error';
  message: string;
  action?: string;
}

export interface AgentAssetDoctorInput {
  repoRoot: string;
  validToolNames: string[];
  /** Override auto-detect (`cursor` | `claude` | `codex` | `all`). */
  client?: DoctorClientScope;
  /** Pre-resolved scope (e.g. from `repovine doctor`); skips a second MCP lookup. */
  resolved?: ResolvedDoctorClients;
}

const TOOL_NAME_PREFIXES = [
  'analyze_',
  'check_',
  'cleanup_',
  'doctor_',
  'get_',
  'inspect_',
  'map_',
  'merge_',
  'refresh_',
  'render_',
  'search_',
  'trace_',
  'validate_',
  'write_',
] as const;

function listAgentFiles(
  dir: string,
  abs: string,
  ext: string,
): Array<{ rel: string; abs: string }> {
  if (!fs.existsSync(abs)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(abs);
  } catch {
    return [];
  }
  return entries
    .filter(name => name.endsWith(ext))
    .map(name => ({
      rel: path.join(dir, name),
      abs: path.join(abs, name),
    }));
}

function gatherProjectAgentFiles(repoRoot: string, clients: DoctorClient[]): Array<{ rel: string; abs: string }> {
  const out: Array<{ rel: string; abs: string }> = [];
  const clientSet = new Set(clients);
  if (clientSet.has('claude')) {
    out.push(...listAgentFiles('.claude/agents', path.join(repoRoot, '.claude', 'agents'), '.md'));
  }
  if (clientSet.has('cursor')) {
    out.push(...listAgentFiles('.cursor/agents', path.join(repoRoot, '.cursor', 'agents'), '.md'));
  }
  if (clientSet.has('codex')) {
    out.push(...listAgentFiles('.codex/agents', path.join(repoRoot, '.codex', 'agents'), '.toml'));
  }
  return out;
}

function collectMentionedToolLikeNames(content: string): Set<string> {
  const names = new Set<string>();
  const backtickRe = /`([a-z][a-z0-9_]*_[a-z0-9_]+)`/g;
  const callRe = /\b([a-z][a-z0-9_]*_[a-z0-9_]+)\s*\(/g;

  let match: RegExpExecArray | null;
  while ((match = backtickRe.exec(content)) !== null) names.add(match[1]);
  while ((match = callRe.exec(content)) !== null) names.add(match[1]);
  return names;
}

function looksLikeToolName(name: string): boolean {
  return TOOL_NAME_PREFIXES.some(prefix => name.startsWith(prefix));
}

function hasGeneratedRepovineAgentsMd(repoRoot: string): boolean {
  const agentsMdPath = path.join(repoRoot, 'AGENTS.md');
  if (!fs.existsSync(agentsMdPath)) return false;
  try {
    const content = fs.readFileSync(agentsMdPath, 'utf-8');
    return content.includes(AGENTS_MD_BEGIN_MARKER) && content.includes(AGENTS_MD_END_MARKER);
  } catch {
    return false;
  }
}

function checkToolMentions(rel: string, content: string, validToolNames: Set<string>): AgentAssetFinding[] {
  const findings: AgentAssetFinding[] = [];
  for (const name of collectMentionedToolLikeNames(content)) {
    if (validToolNames.has(name)) continue;
    if (!looksLikeToolName(name)) continue;
    findings.push({
      file: rel,
      severity: 'warning',
      code: 'unknown-tool-name',
      message: `References unknown tool-like name "${name}"; compare against MCP tools/list, then rerun repovine setup if this is a stale agent instruction.`,
    });
  }
  return findings;
}

function checkStaleManagedContent(rel: string, actual: string, expected: string): AgentAssetFinding | null {
  if (actual === expected) return null;
  return {
    file: rel,
    severity: 'error',
    code: 'stale-managed-content',
    message: 'On-disk content does not match the canonical setup template. Run repovine setup (or repovine setup --force).',
  };
}

/**
 * Scan agent assets under `repoRoot` and report drift from canonical templates.
 * Prefer {@link runAgentAssetDoctor} from CLI entrypoints so scope resolution
 * stays consistent for `repovine doctor` human and `--json` output.
 */
export function doctorAgentAssets(input: AgentAssetDoctorInput): DoctorAgentAssetsReport {
  const validToolNames = new Set(input.validToolNames);
  const resolved = input.resolved ?? resolveDoctorClients(input.repoRoot, input.client);
  const { clients } = resolved;

  const findings: AgentAssetFinding[] = [];
  const governedFiles: string[] = [];
  const scannedFiles: string[] = [];

  if (clients.includes('cursor') && hasGeneratedRepovineAgentsMd(input.repoRoot)) {
    findings.push({
      file: CURSOR_MIXED_SURFACES_LABEL,
      severity: 'warning',
      code: 'mixed-cursor-instruction-surfaces',
      message: 'Managed Cursor rules and generated repovine AGENTS.md both exist. '
        + 'Cursor may load overlapping instruction surfaces in mixed repos; slimming scorecards intentionally use Cursor-only init surfaces and exclude AGENTS.md.',
    });
  }

  for (const asset of listCanonicalManagedAssets(input.repoRoot, clients)) {
    const actual = readManagedFile(input.repoRoot, asset.rel);
    if (actual === null) continue;

    scannedFiles.push(asset.rel);
    governedFiles.push(asset.rel);
    findings.push(...checkToolMentions(asset.rel, actual, validToolNames));

    const stale = checkStaleManagedContent(asset.rel, actual, asset.expected);
    if (stale) findings.push(stale);
  }

  const governedSet = new Set(governedFiles);
  for (const candidate of gatherProjectAgentFiles(input.repoRoot, clients)) {
    if (governedSet.has(candidate.rel)) continue;

    let content: string;
    try {
      content = fs.readFileSync(candidate.abs, 'utf-8');
    } catch {
      continue;
    }

    scannedFiles.push(candidate.rel);
    findings.push(...checkToolMentions(candidate.rel, content, validToolNames));
  }

  const errors = findings.filter(f => f.severity === 'error').length;
  const warnings = findings.filter(f => f.severity === 'warning').length;

  return {
    ok: errors === 0,
    protocolVersion: PROTOCOL_VERSION,
    projectionVersion: PROJECTION_VERSION,
    clients,
    clientScope: resolved.scope,
    detectedClients: resolved.detected,
    scanned: scannedFiles,
    governed: governedFiles,
    findings,
    summary: { assets: scannedFiles.length, governed: governedFiles.length, errors, warnings },
  };
}

const DOCTOR_CLIENT_SCOPE_VALUES = ['cursor', 'claude', 'codex', 'all'] as const;

/** Parse `--client` for agent-asset doctor commands. */
export function parseDoctorClientScopeArg(
  clientArg: string | undefined,
): { client?: DoctorClientScope; error?: string } {
  if (!clientArg) return {};
  if ((DOCTOR_CLIENT_SCOPE_VALUES as readonly string[]).includes(clientArg)) {
    return { client: clientArg as DoctorClientScope };
  }
  return {
    error: `Unknown --client "${clientArg}". Valid: ${DOCTOR_CLIENT_SCOPE_VALUES.join(', ')}.`,
  };
}

/** Single entry point for agent-asset doctor scans (`repovine doctor`). */
export function runAgentAssetDoctor(input: AgentAssetDoctorInput): DoctorAgentAssetsReport {
  return doctorAgentAssets(input);
}

/**
 * Remediation line for one finding. Every branch must name a command the argv router dispatches:
 * an unreachable branch is still a latent string, and the one a reader trusts is the one that
 * looks specific. `managed-asset-remediation.test.ts` holds the branches to that.
 */
function agentAssetDoctorCliAction(finding: AgentAssetFinding): string | undefined {
  if (finding.code === 'mixed-cursor-instruction-surfaces') {
    return 'Expected in mixed repos (setup all). Cursor scorecards exclude AGENTS.md; remove AGENTS.md only if you want a Cursor-only instruction surface.';
  }
  if (finding.severity === 'error') {
    return 'Rerun repovine setup (or repovine setup --force) after reviewing repovine doctor findings.';
  }
  return 'Rerun repovine setup when regeneration is intended.';
}

/** Map an agent-asset doctor report to human CLI rows for `repovine doctor`. */
export function agentAssetDoctorCliFindings(
  report: DoctorAgentAssetsReport,
): AgentAssetDoctorCliFinding[] {
  const scopeHint = report.clients.join(', ');
  if (report.findings.length === 0) {
    return [{
      area: 'agent assets',
      severity: 'ok',
      message: `Managed setup assets match canonical templates (${report.summary.governed} file(s) checked; clients: ${scopeHint}).`,
    }];
  }
  return report.findings.map(finding => ({
    area: `agent assets: ${finding.file}`,
    severity: finding.severity,
    message: `${finding.code}: ${finding.message}`,
    action: agentAssetDoctorCliAction(finding),
  }));
}

// Re-export for CLI/MCP consumers.
export type { DoctorClient, DoctorClientScope } from './client-scope.js';
export { detectConfiguredDoctorClients, resolveDoctorClients } from './client-scope.js';
