import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_EMBEDDING_MODEL, loadConfig } from '../config.js';
import { describeTransformersInstall, resolveModelCacheDir } from '../semantic/embedder.js';
import { detectPython } from '../source-plugins/python/discover.js';
import { graphStats } from '../graph/index.js';
import { RepovineRuntime } from '../mcp/context.js';
import { toolDefs } from '../mcp/tool-defs.js';
import { boundaryIndexFilePath, readBoundaryIndex, BOUNDARY_INDEX_VERSION } from '../mcp/boundary-index.js';
import {
  getAnnotationMergeStatus,
  validateAnnotationHealth,
} from '../annotations/maintenance.js';
import {
  agentAssetDoctorCliFindings,
  runAgentAssetDoctor,
} from './agent-doctor.js';
import {
  type DoctorClient,
  type ResolvedDoctorClients,
  DOCTOR_CLIENT_MCP_LABEL,
  describeDoctorClientScope,
  resolveDoctorClients,
  scopeUsesAgentsMd,
} from './client-scope.js';
import { AGENTS_MD_BEGIN_MARKER, AGENTS_MD_END_MARKER } from './templates.js';
import {
  formatModuleCoverageLine,
} from './human-output.js';
import { cli, logCli, setPipelineLogSink } from './ui.js';

export interface HealthCliEnv {
  repoRoot: string;
  artifactsDir: string;
}

type FindingSeverity = 'ok' | 'warning' | 'error';

interface HealthFinding {
  area: string;
  severity: FindingSeverity;
  message: string;
  action?: string;
}

interface McpConfigCheck {
  client: 'Cursor' | 'Claude' | 'Codex';
  path: string;
  exists: boolean;
  parseOk: boolean;
  hasrepovine: boolean;
  otherServers: string[];
  message?: string;
}

interface AnnotationCoverageSummary {
  totalModules: number;
  annotated: number;
  fresh: number;
  stale: number;
  unannotated: number;
  templates: { total: number; annotated: number; fresh: number; stale: number; unannotated: number };
  infraModules: { total: number; annotated: number; fresh: number; stale: number; unannotated: number };
  services: { total: number; annotated: number; fresh: number; stale: number; unannotated: number };
  domainAnnotations: { totalDomains: number; annotated: number; fresh: number; stale: number };
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usageStatus(): void {
  console.error('Usage: repovine status');
}

function usageDoctor(): void {
  console.error('Usage: repovine doctor [--json]');
  console.error('  Diagnose MCP setup, cache, annotations, and client setup projections.');
}

function rel(env: HealthCliEnv, filePath: string): string {
  return path.relative(env.repoRoot, filePath) || '.';
}

function snapshotCachePath(env: HealthCliEnv): string {
  return path.join(env.artifactsDir, '.cache', 'repository-facts-snapshot.json');
}

/** Guarded version probe: trimmed stdout, or null when the command is absent or fails. */
function probeVersion(cmd: string, args: string[]): string | null {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf-8',
      timeout: 3000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

let cachedGitVersion: string | null | undefined;

function gitVersion(): string | null {
  if (cachedGitVersion !== undefined) return cachedGitVersion;
  const out = probeVersion('git', ['--version']);
  // `.trim()` above already strips the Git-for-Windows CRLF tail.
  cachedGitVersion = out === null ? null : (/git version (\S+)/.exec(out)?.[1] ?? out.split('\n')[0]!.trim());
  return cachedGitVersion;
}

/** Plain descriptor so a later change of detectPython's shape touches only this mapping. */
function pythonDescriptor(): { interpreter: string | null; version: string | null } {
  const interpreter = detectPython();
  if (interpreter === null) return { interpreter: null, version: null };
  const out = probeVersion(interpreter, ['--version']);
  const version = out === null ? null : (/(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null);
  return { interpreter, version };
}

function inspectJsonMcpConfig(client: 'Cursor' | 'Claude', filePath: string): McpConfigCheck {
  if (!fs.existsSync(filePath)) {
    return { client, path: filePath, exists: false, parseOk: true, hasrepovine: false, otherServers: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    const servers = parsed.mcpServers;
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
      return {
        client,
        path: filePath,
        exists: true,
        parseOk: true,
        hasrepovine: false,
        otherServers: [],
        message: 'mcpServers is missing or is not an object',
      };
    }
    const names = Object.keys(servers as Record<string, unknown>);
    return {
      client,
      path: filePath,
      exists: true,
      parseOk: true,
      hasrepovine: names.includes('repovine'),
      otherServers: names.filter(name => name !== 'repovine'),
    };
  } catch (e) {
    return {
      client,
      path: filePath,
      exists: true,
      parseOk: false,
      hasrepovine: false,
      otherServers: [],
      message: (e as Error).message,
    };
  }
}

function inspectCodexConfig(filePath: string): McpConfigCheck {
  if (!fs.existsSync(filePath)) {
    return { client: 'Codex', path: filePath, exists: false, parseOk: true, hasrepovine: false, otherServers: [] };
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const otherServers = new Set<string>();
  for (const match of content.matchAll(/\[mcp_servers\.([^\]]+)\]/g)) {
    const name = match[1]?.trim().split('.')[0];
    if (name && name !== 'repovine') otherServers.add(name);
  }
  return {
    client: 'Codex',
    path: filePath,
    exists: true,
    parseOk: true,
    hasrepovine: content.includes('[mcp_servers.repovine]'),
    otherServers: [...otherServers],
  };
}

function inspectMcpConfigs(env: HealthCliEnv): McpConfigCheck[] {
  return [
    inspectJsonMcpConfig('Cursor', path.join(env.repoRoot, '.cursor', 'mcp.json')),
    inspectJsonMcpConfig('Claude', path.join(env.repoRoot, '.mcp.json')),
    inspectCodexConfig(path.join(env.repoRoot, '.codex', 'config.toml')),
  ];
}

// ── Global (user-scope) MCP sweep ──
// repovine is repo-scoped by design: init writes only project files. A `repovine` server in a
// user-global client config applies to every repo, can shadow or diverge from the project
// config, and is the usual cause of "wrong root / wrong version" confusion — so doctor flags it.

interface RepovineLaunch {
  command?: string;
  args?: string[];
  root?: string;
}

export interface GlobalMcpCheck {
  client: 'Cursor' | 'Claude' | 'Codex';
  path: string;
  exists: boolean;
  parseOk: boolean;
  hasRepovine: boolean;
  launch?: RepovineLaunch;
  message?: string;
}

function formatLaunch(launch: RepovineLaunch | undefined): string {
  if (!launch) return 'unknown command';
  const cmd = [launch.command, ...(launch.args ?? [])].filter(Boolean).join(' ') || 'unknown command';
  return launch.root ? `${cmd} (REPOVINE_ROOT=${launch.root})` : cmd;
}

function sameLaunch(a: RepovineLaunch | undefined, b: RepovineLaunch | undefined): boolean {
  if (!a || !b) return true; // cannot prove divergence without both sides
  return formatLaunch(a) === formatLaunch(b);
}

function repovineLaunchFromMcpJson(filePath: string): RepovineLaunch | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    const servers = parsed.mcpServers as Record<string, unknown> | undefined;
    const entry = servers && typeof servers === 'object' ? (servers['repovine'] as Record<string, unknown> | undefined) : undefined;
    if (!entry || typeof entry !== 'object') return undefined;
    const env = entry.env as Record<string, unknown> | undefined;
    return {
      command: typeof entry.command === 'string' ? entry.command : undefined,
      args: Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : undefined,
      root: env && typeof env.REPOVINE_ROOT === 'string' ? env.REPOVINE_ROOT : undefined,
    };
  } catch {
    return undefined;
  }
}

function repovineLaunchFromCodexToml(content: string): RepovineLaunch | undefined {
  const block = /\[mcp_servers\.repovine\]([\s\S]*?)(?=\n\[|$)/.exec(content);
  if (!block) return undefined;
  const command = /command\s*=\s*"([^"]+)"/.exec(block[1] ?? '')?.[1];
  const argsRaw = /args\s*=\s*\[([^\]]*)\]/.exec(block[1] ?? '')?.[1] ?? '';
  const args = [...argsRaw.matchAll(/"([^"]+)"/g)].map(m => m[1]!);
  const envBlock = /\[mcp_servers\.repovine\.env\]([\s\S]*?)(?=\n\[|$)/.exec(content);
  const root = envBlock ? /REPOVINE_ROOT\s*=\s*"([^"]+)"/.exec(envBlock[1] ?? '')?.[1] : undefined;
  return { command, args: args.length > 0 ? args : undefined, root };
}

function inspectGlobalMcpConfig(
  client: 'Cursor' | 'Claude' | 'Codex',
  filePath: string,
  kind: 'json' | 'claude-json' | 'toml',
): GlobalMcpCheck {
  if (!fs.existsSync(filePath)) {
    return { client, path: filePath, exists: false, parseOk: true, hasRepovine: false };
  }
  try {
    if (kind === 'toml') {
      const content = fs.readFileSync(filePath, 'utf-8');
      const hasRepovine = content.includes('[mcp_servers.repovine]');
      return {
        client,
        path: filePath,
        exists: true,
        parseOk: true,
        hasRepovine,
        launch: hasRepovine ? repovineLaunchFromCodexToml(content) : undefined,
      };
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    // `~/.claude.json` keeps user-scope servers under top-level `mcpServers`, same shape as mcp.json.
    const servers = parsed.mcpServers as Record<string, unknown> | undefined;
    const hasRepovine = !!servers && typeof servers === 'object' && !Array.isArray(servers) && 'repovine' in servers;
    return {
      client,
      path: filePath,
      exists: true,
      parseOk: true,
      hasRepovine,
      launch: hasRepovine ? repovineLaunchFromMcpJson(filePath) : undefined,
    };
  } catch (e) {
    return { client, path: filePath, exists: true, parseOk: false, hasRepovine: false, message: (e as Error).message };
  }
}

export function inspectGlobalMcpConfigs(clients: DoctorClient[], homeDir: string = os.homedir()): GlobalMcpCheck[] {
  const labels = new Set(clients.map(client => DOCTOR_CLIENT_MCP_LABEL[client]));
  const checks: GlobalMcpCheck[] = [];
  if (labels.has('Cursor')) {
    checks.push(inspectGlobalMcpConfig('Cursor', path.join(homeDir, '.cursor', 'mcp.json'), 'json'));
  }
  if (labels.has('Claude')) {
    checks.push(inspectGlobalMcpConfig('Claude', path.join(homeDir, '.claude.json'), 'claude-json'));
  }
  if (labels.has('Codex')) {
    checks.push(inspectGlobalMcpConfig('Codex', path.join(homeDir, '.codex', 'config.toml'), 'toml'));
  }
  return checks;
}

export function globalMcpFindings(
  checks: GlobalMcpCheck[],
  projectLaunches: Partial<Record<'Cursor' | 'Claude' | 'Codex', RepovineLaunch | undefined>> = {},
): HealthFinding[] {
  const findings: HealthFinding[] = [];
  for (const check of checks) {
    if (!check.hasRepovine) continue;
    const projectLaunch = projectLaunches[check.client];
    const diverges = !sameLaunch(check.launch, projectLaunch);
    const divergence = diverges
      ? ` It DIFFERS from the project config: global runs \`${formatLaunch(check.launch)}\`, project runs \`${formatLaunch(projectLaunch)}\`.`
      : '';
    findings.push({
      area: `${check.client} MCP (global)`,
      severity: 'warning',
      message:
        `A \`repovine\` MCP server is configured at user scope (${check.path}). `
        + `repovine is repo-scoped by design — a global entry applies to every repository and can point at the wrong root or version.${divergence}`,
      action: 'Remove the user-scope repovine entry and keep the project config written by repovine setup.',
    });
  }
  if (findings.length === 0) {
    findings.push({
      area: 'Global MCP',
      severity: 'ok',
      message: 'No user-scope repovine MCP servers detected (repo-scoped setup is canonical).',
    });
  }
  return findings;
}

function projectRepovineLaunches(env: HealthCliEnv): Partial<Record<'Cursor' | 'Claude' | 'Codex', RepovineLaunch | undefined>> {
  const codexPath = path.join(env.repoRoot, '.codex', 'config.toml');
  return {
    Cursor: repovineLaunchFromMcpJson(path.join(env.repoRoot, '.cursor', 'mcp.json')),
    Claude: repovineLaunchFromMcpJson(path.join(env.repoRoot, '.mcp.json')),
    Codex: fs.existsSync(codexPath) ? repovineLaunchFromCodexToml(fs.readFileSync(codexPath, 'utf-8')) : undefined,
  };
}

function clientScopeFinding(resolved: ResolvedDoctorClients): HealthFinding {
  return {
    area: 'Client scope',
    severity: 'ok',
    message: describeDoctorClientScope(resolved),
  };
}

function agentsMdFinding(env: HealthCliEnv, clients: DoctorClient[]): HealthFinding {
  if (!scopeUsesAgentsMd(clients)) {
    return {
      area: 'AGENTS.md',
      severity: 'ok',
      message: 'Not in scope for Cursor-only (main-agent policy is in .cursor/rules).',
    };
  }
  const filePath = path.join(env.repoRoot, 'AGENTS.md');
  if (!fs.existsSync(filePath)) {
    return {
      area: 'AGENTS.md',
      severity: 'warning',
      message: 'AGENTS.md is missing, so agents may not see repovine-first instructions.',
      action: 'Run repovine setup -i, or repovine setup <client>.',
    };
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  if (!content.includes(AGENTS_MD_BEGIN_MARKER) || !content.includes(AGENTS_MD_END_MARKER)) {
    return {
      area: 'AGENTS.md',
      severity: 'warning',
      message: 'AGENTS.md exists but does not contain the repovine managed section.',
      action: 'Regenerate AGENTS.md with repovine setup (claude/codex/all) or repovine setup --force.',
    };
  }
  return {
    area: 'AGENTS.md',
    severity: 'ok',
    message: 'repovine managed instructions are present.',
  };
}

function invertNameCase(name: string): string {
  return name.replace(/[a-zA-Z]/g, ch => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()));
}

/**
 * Case sensitivity of the filesystem holding the repo, from reads only — no temp
 * writes. An existing repo file is looked up under a case-inverted name; the
 * readdir guard skips candidates with a real distinct case-variant twin, where
 * an insensitivity verdict would be wrong. Probing the repo path matters: the
 * volume under process.execPath can behave differently.
 */
export function detectFsCase(repoRoot: string): 'known-sensitive' | 'known-insensitive' | 'unknown' {
  const candidates = ['package.json', 'AGENTS.md', 'repovine.config.json', path.join('.git', 'HEAD')];
  for (const candidate of candidates) {
    const abs = path.join(repoRoot, candidate);
    if (!fs.existsSync(abs)) continue;
    const base = path.basename(abs);
    const variant = invertNameCase(base);
    if (variant === base) continue; // no letters to invert
    let entries: string[];
    try {
      entries = fs.readdirSync(path.dirname(abs));
    } catch {
      continue;
    }
    if (entries.includes(variant)) continue; // real case-variant twin — ambiguous candidate
    return fs.existsSync(path.join(path.dirname(abs), variant)) ? 'known-insensitive' : 'known-sensitive';
  }
  return 'unknown';
}

function cacheFinding(env: HealthCliEnv): HealthFinding & { cachePath: string; mtime?: string; bytes?: number } {
  const filePath = snapshotCachePath(env);
  if (!fs.existsSync(filePath)) {
    return {
      area: 'graph cache',
      severity: 'warning',
      message: 'No warm graph cache found.',
      action: 'Run repovine build so first MCP tool calls do not wait on a cold graph build.',
      cachePath: filePath,
    };
  }
  const stat = fs.statSync(filePath);
  return {
    area: 'graph cache',
    severity: 'ok',
    message: 'Warm repository facts snapshot cache exists.',
    cachePath: filePath,
    mtime: stat.mtime.toISOString(),
    bytes: stat.size,
  };
}

function mcpChecksForClients(checks: McpConfigCheck[], clients: DoctorClient[]): McpConfigCheck[] {
  const labels = new Set(clients.map(client => DOCTOR_CLIENT_MCP_LABEL[client]));
  return checks.filter(check => labels.has(check.client));
}

function mcpConfigFindings(env: HealthCliEnv, checks: McpConfigCheck[], clients: DoctorClient[]): HealthFinding[] {
  const scopedChecks = mcpChecksForClients(checks, clients);
  const findings: HealthFinding[] = [];
  for (const check of scopedChecks) {
    const relativePath = rel(env, check.path);
    if (!check.exists) {
      findings.push({
        area: `${check.client} MCP`,
        severity: 'warning',
        message: `${relativePath} is missing.`,
        action: `Run repovine setup ${check.client.toLowerCase()} or repovine setup -i.`,
      });
      continue;
    }
    if (!check.parseOk) {
      findings.push({
        area: `${check.client} MCP`,
        severity: 'error',
        message: `${relativePath} cannot be parsed: ${check.message ?? 'invalid config'}.`,
        action: 'Fix the config or rerun setup with --replace-mcp if it is safe.',
      });
      continue;
    }
    if (!check.hasrepovine) {
      findings.push({
        area: `${check.client} MCP`,
        severity: 'warning',
        message: `${relativePath} exists but has no repovine server entry.`,
        action: `Run repovine setup ${check.client.toLowerCase()} to merge the repovine MCP server.`,
      });
      continue;
    }
    findings.push({
      area: `${check.client} MCP`,
      severity: 'ok',
      message: `${relativePath} contains a repovine MCP server entry.`,
    });
  }

  if (!scopedChecks.some(check => check.hasrepovine)) {
    findings.push({
      area: 'MCP',
      severity: 'error',
      message: 'No client MCP config in scope currently points at repovine.',
      action: 'Run repovine setup -i and choose the client(s) your agent uses.',
    });
  }
  return findings;
}

function annotationFindings(env: HealthCliEnv): HealthFinding[] {
  const cfg = loadConfig(env.repoRoot);
  const annotationsFile = cfg.workspace.annotationsFile;
  const status = getAnnotationMergeStatus(env.repoRoot, annotationsFile);
  if (status.file.hasConflictMarkers) {
    return [{
      area: 'annotations',
      severity: 'error',
      message: `${annotationsFile} contains merge conflict markers.`,
      action: 'Run repovine annotations merge, then repovine annotations validate.',
    }];
  }
  if (status.file.exists && !status.file.parseOk) {
    return [{
      area: 'annotations',
      severity: 'error',
      message: `${annotationsFile} is not parseable: ${status.file.error ?? 'invalid JSON'}.`,
      action: 'Restore or fix the annotation file before asking agents to trust memory.',
    }];
  }
  if (!status.file.exists) {
    return [{
      area: 'annotations',
      severity: 'warning',
      message: `${annotationsFile} does not exist yet.`,
      action: 'Run repovine annotations plan after the graph is built to see onboarding work.',
    }];
  }
  return [{
    area: 'annotations',
    severity: 'ok',
    message: `Annotation file is parseable (${status.file.annotationCount ?? 0} note(s)).`,
  }];
}

const BOUNDARY_HOOK_CLIENT_PATHS: ReadonlyArray<readonly [string, string]> = [
  ['Claude', path.join('.claude', 'hooks', 'boundary-notice.js')],
  ['Codex', path.join('.codex', 'hooks', 'boundary-notice.js')],
  ['Cursor', path.join('.cursor', 'hooks', 'boundary-notice.js')],
];

/**
 * Diagnose the pre-edit boundary push channel — the delivery path the pre-edit hook depends on:
 * the on-disk `.repovine/boundary-index.json` (presence, schema version, freshness) and every
 * installed hook's accepted schema version. Fail-loud only; nothing here auto-repairs.
 */
function boundaryPushChannelFindings(env: HealthCliEnv): HealthFinding[] {
  const area = 'boundary push channel';
  const findings: HealthFinding[] = [boundaryIndexFinding(env, area)];

  for (const [client, rel] of BOUNDARY_HOOK_CLIENT_PATHS) {
    const hookPath = path.join(env.repoRoot, rel);
    if (!fs.existsSync(hookPath)) continue;
    let accepted: number | undefined;
    try {
      const m = fs.readFileSync(hookPath, 'utf-8').match(/index\.version !== (\d+)/);
      accepted = m ? Number(m[1]) : undefined;
    } catch {
      accepted = undefined;
    }
    if (accepted !== undefined && accepted !== BOUNDARY_INDEX_VERSION) {
      findings.push({
        area,
        severity: 'warning',
        message: `Installed ${client} boundary hook accepts index v${accepted}, but this engine emits v${BOUNDARY_INDEX_VERSION}.`,
        action: 'Run npx repovine setup to refresh the pre-edit hook; boundary advisories are paused until then.',
      });
    }
  }
  return findings;
}

function boundaryIndexFinding(env: HealthCliEnv, area: string): HealthFinding {
  const indexPath = boundaryIndexFilePath(env.repoRoot);
  if (!fs.existsSync(indexPath)) {
    return {
      area,
      severity: 'warning',
      message: 'No pre-edit boundary index (.repovine/boundary-index.json); the pre-edit hook cannot deliver advisories.',
      action: 'Run refresh_context (or restart the MCP server) to emit the boundary index.',
    };
  }
  let raw: { version?: unknown; builtAt?: unknown } | undefined;
  try {
    raw = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  } catch {
    return { area, severity: 'warning', message: 'Boundary index is present but not valid JSON.', action: 'Rebuild it: refresh_context (or restart the MCP server).' };
  }
  const version = raw && typeof raw === 'object' ? raw.version : undefined;
  if (version !== BOUNDARY_INDEX_VERSION) {
    return {
      area,
      severity: 'warning',
      message: `Boundary index schema is v${String(version)}; this engine emits v${BOUNDARY_INDEX_VERSION}.`,
      action: 'Rebuild it: refresh_context (or restart the MCP server).',
    };
  }
  if (!readBoundaryIndex(env.repoRoot)) {
    return { area, severity: 'warning', message: 'Boundary index is present but malformed.', action: 'Rebuild it: refresh_context (or restart the MCP server).' };
  }
  // Freshness heuristic (never gated): index older than the annotations file means a boundary risk
  // written since the last build is not yet pushed.
  const builtAtMs = typeof raw?.builtAt === 'string' ? Date.parse(raw.builtAt) : NaN;
  let annPath: string | undefined;
  try {
    annPath = path.join(env.repoRoot, loadConfig(env.repoRoot).workspace.annotationsFile);
  } catch {
    annPath = undefined;
  }
  if (!Number.isNaN(builtAtMs) && annPath && fs.existsSync(annPath) && fs.statSync(annPath).mtimeMs > builtAtMs) {
    return {
      area,
      severity: 'warning',
      message: 'Boundary index is older than the annotations file; a boundary risk written since the last build is not yet pushed.',
      action: 'Run refresh_context to rebuild the boundary index.',
    };
  }
  return { area, severity: 'ok', message: 'Pre-edit boundary index present, current-version, and not older than the annotations file.' };
}

function buildDoctorClientScope(env: HealthCliEnv): ResolvedDoctorClients {
  return resolveDoctorClients(env.repoRoot);
}

function buildAgentAssetDoctorReport(
  env: HealthCliEnv,
  resolved: ResolvedDoctorClients,
) {
  return runAgentAssetDoctor({
    repoRoot: env.repoRoot,
    validToolNames: toolDefs.map(d => d.name),
    resolved,
  });
}

function serverFinding(): HealthFinding {
  return {
    area: 'MCP server',
    severity: toolDefs.length > 0 ? 'ok' : 'error',
    message: toolDefs.length > 0
      ? `Tool registry loaded (${toolDefs.length} public MCP tool(s)).`
      : 'Tool registry is empty; the MCP server cannot expose repovine tools.',
  };
}

function printFindings(title: string, findings: HealthFinding[], env: HealthCliEnv): void {
  logCli(`${cli.bold(title)}\n`);
  for (const finding of findings) {
    const marker = finding.severity === 'ok'
      ? cli.success('ok')
      : finding.severity === 'warning'
        ? cli.warn('warn')
        : cli.error('error');
    logCli(`  ${marker} ${cli.bold(finding.area)}: ${finding.message}`);
    if (finding.action) logCli(`       ${cli.dim(finding.action)}`);
  }
  logCli('');
  logCli(cli.dim(`Workspace: ${env.repoRoot}`));
}

function compactCoverage(stats: AnnotationCoverageSummary & {
  byDomain?: unknown;
  byTier?: unknown;
  domainAnnotations: AnnotationCoverageSummary['domainAnnotations'] & { list?: string[] };
}): AnnotationCoverageSummary {
  return {
    totalModules: stats.totalModules,
    annotated: stats.annotated,
    fresh: stats.fresh,
    stale: stats.stale,
    unannotated: stats.unannotated,
    templates: stats.templates,
    infraModules: stats.infraModules,
    services: stats.services,
    domainAnnotations: {
      totalDomains: stats.domainAnnotations.totalDomains,
      annotated: stats.domainAnnotations.annotated,
      fresh: stats.domainAnnotations.fresh,
      stale: stats.domainAnnotations.stale,
    },
  };
}

export interface PlatformReport {
  os: NodeJS.Platform;
  arch: string;
  node: string;
  execPath: string;
  entrypoint: string | null;
  git: { version: string | null };
  python: { interpreter: string | null; version: string | null };
  fsCase: 'known-sensitive' | 'known-insensitive' | 'unknown';
  embedder: {
    enabled: boolean;
    model: string;
    transformers: {
      resolved: boolean;
      source: 'repovine' | 'workspace' | null;
      entryPath: string | null;
      version: string | null;
    };
    modelCacheDir: string | null;
    modelCacheDirExists: boolean;
    darwinFloorWarning: string | null;
  };
  supportDoc: 'docs/platform-support.md';
}

/**
 * The darwin embedder floor (docs/platform-support.md): transformers < 4 bundles
 * onnxruntime 1.21, whose exit teardown aborts on macOS. Null on other platforms,
 * on versions >= 4, and when no version is known.
 */
export function darwinTransformersFloorWarning(platform: NodeJS.Platform, version: string | undefined): string | null {
  if (platform !== 'darwin' || version === undefined) return null;
  const major = parseInt(version.split('.')[0]!, 10);
  if (!(major < 4)) return null; // NaN falls through to null
  return `@huggingface/transformers ${version} on macOS bundles onnxruntime 1.21, `
    + 'which aborts at process exit after inference; install @huggingface/transformers@^4 '
    + '(see docs/platform-support.md).';
}

/** Local paths, version strings, and enums only — never secret-bearing env values
 * (the resolved model-cache path may originate from REPOVINE_MODEL_CACHE). */
function buildPlatformReport(env: HealthCliEnv): PlatformReport {
  let enabled = true;
  try {
    enabled = loadConfig(env.repoRoot).semanticSearchEmbeddings;
  } catch {
    /* bad config must not break the platform block; true matches the config default */
  }
  const transformers = describeTransformersInstall(env.repoRoot);
  let modelCacheDir: string | null;
  try {
    modelCacheDir = resolveModelCacheDir();
  } catch {
    modelCacheDir = null;
  }
  return {
    os: process.platform,
    arch: process.arch,
    node: process.version,
    execPath: process.execPath,
    entrypoint: process.argv[1] ?? null,
    git: { version: gitVersion() },
    python: pythonDescriptor(),
    fsCase: detectFsCase(env.repoRoot),
    embedder: {
      enabled,
      model: DEFAULT_EMBEDDING_MODEL,
      transformers: {
        resolved: transformers.resolved,
        source: transformers.source ?? null,
        entryPath: transformers.entryPath ?? null,
        version: transformers.version ?? null,
      },
      modelCacheDir,
      // Read-only: doctor never creates the cache dir.
      modelCacheDirExists: modelCacheDir !== null && fs.existsSync(modelCacheDir),
      darwinFloorWarning: darwinTransformersFloorWarning(process.platform, transformers.version),
    },
    supportDoc: 'docs/platform-support.md',
  };
}

// Never 'error' severity here: a missing git/python must not flip doctor's ok/exit code.
function platformFindings(report: PlatformReport): HealthFinding[] {
  const gitPart = report.git.version === null ? 'git missing' : `git ${report.git.version}`;
  const pythonPart = report.python.interpreter === null
    ? 'python missing'
    : `python ${report.python.interpreter}${report.python.version === null ? '' : ` ${report.python.version}`}`;
  const findings: HealthFinding[] = [{
    area: 'platform',
    severity: 'ok',
    message: `${report.os} ${report.arch}, node ${report.node}, ${gitPart}, ${pythonPart}, `
      + `fs case ${report.fsCase} — support matrix: ${report.supportDoc}`,
  }];
  if (report.git.version === null) {
    findings.push({
      area: 'platform',
      severity: 'warning',
      message: 'Git not found on PATH; graph freshness and annotation provenance need it.',
      action: 'Install git and make sure it is on PATH.',
    });
  }
  const { darwinFloorWarning, enabled, transformers } = report.embedder;
  if (darwinFloorWarning !== null && enabled && transformers.resolved) {
    findings.push({
      area: 'embedder',
      severity: 'warning',
      message: darwinFloorWarning,
    });
  }
  return findings;
}

export async function runDoctorCli(argv: string[], env: HealthCliEnv): Promise<number> {
  setPipelineLogSink('silent');
  if (argv.includes('--help') || argv.includes('-h')) {
    usageDoctor();
    return 0;
  }
  const json = argv.includes('--json');
  const allowed = new Set(['--json', '--help', '-h']);
  const unknown = argv.filter(arg => arg.startsWith('--') && !allowed.has(arg));
  if (unknown.length > 0) {
    console.error(`Unknown doctor option(s): ${unknown.join(', ')}`);
    usageDoctor();
    return 1;
  }

  const clientScope = buildDoctorClientScope(env);
  const agentReport = buildAgentAssetDoctorReport(env, clientScope);
  const checks = inspectMcpConfigs(env);

  const globalChecks = inspectGlobalMcpConfigs(clientScope.clients);
  const platformReport = buildPlatformReport(env);
  const findings = [
    clientScopeFinding(clientScope),
    ...mcpConfigFindings(env, checks, clientScope.clients),
    agentsMdFinding(env, clientScope.clients),
    cacheFinding(env),
    ...annotationFindings(env),
    ...boundaryPushChannelFindings(env),
    ...agentAssetDoctorCliFindings(agentReport),
    serverFinding(),
    // Platform findings sit before the global MCP sweep: Global MCP stays last.
    ...platformFindings(platformReport),
    ...globalMcpFindings(globalChecks, projectRepovineLaunches(env)),
  ];
  const result = {
    ok: !findings.some(f => f.severity === 'error'),
    summary: {
      errors: findings.filter(f => f.severity === 'error').length,
      warnings: findings.filter(f => f.severity === 'warning').length,
      ok: findings.filter(f => f.severity === 'ok').length,
    },
    clientScope: {
      clients: clientScope.clients,
      scope: clientScope.scope,
      detectedClients: clientScope.detected,
      description: describeDoctorClientScope(clientScope),
    },
    agentAssets: agentReport,
    checks: mcpChecksForClients(checks, clientScope.clients),
    globalMcp: globalChecks,
    platform: platformReport,
    findings,
  };

  if (json) printJson(result);
  else printFindings('repovine doctor', findings, env);
  return result.ok ? 0 : 1;
}

export async function runStatusCli(argv: string[], env: HealthCliEnv): Promise<number> {
  setPipelineLogSink('silent');
  if (argv.includes('--help') || argv.includes('-h')) {
    usageStatus();
    return 0;
  }
  const allowed = new Set(['--json', '--help', '-h']);
  const unknown = argv.filter(arg => arg.startsWith('--') && !allowed.has(arg));
  if (unknown.length > 0) {
    console.error(`Unknown status option(s): ${unknown.join(', ')}`);
    usageStatus();
    return 1;
  }
  const json = argv.includes('--json');

  try {
    const cfg = loadConfig(env.repoRoot);
    const ctx = await RepovineRuntime.create(env.repoRoot, env.artifactsDir, cfg);
    const state = ctx.getState();
    const stats = graphStats(state.graph);
    const annotationHealth = validateAnnotationHealth({
      repoRoot: env.repoRoot,
      graph: state.graph,
      snapshot: state.snapshot,
      annotations: state.annotations,
    });
    const annotationStats = state.annotations.getStats(state.graph, state.snapshot);
    const cache = cacheFinding(env);
    const clientScope = buildDoctorClientScope(env);
    const agentAssets = buildAgentAssetDoctorReport(env, clientScope);
    const mcpConfigs = inspectMcpConfigs(env);
    const configuredClients = mcpConfigs.filter(check => check.hasrepovine).map(check => check.client);
    const statusNextActions = annotationHealth.nextActions
      .filter(action => !action.startsWith('Annotation file is parseable, merged, and fresh'));
    const result = {
      ok: annotationHealth.status === 'clean' && agentAssets.summary.errors === 0,
      workspace: env.repoRoot,
      builtAt: state.builtAt,
      graph: {
        modules: state.snapshot.modules.length,
        nodes: stats.totalNodes,
        edges: stats.totalEdges,
        packages: state.graph.byType.get('package')?.size ?? 0,
        domains: state.graph.byType.get('domain')?.size ?? 0,
      },
      cache,
      mcp: {
        configuredClients,
        configs: mcpConfigs,
      },
      annotations: {
        status: annotationHealth.status,
        counts: annotationHealth.counts,
        needsWork: annotationHealth.needsWork,
        coverage: compactCoverage(annotationStats),
        ...(statusNextActions.length > 0 ? { nextActions: statusNextActions } : {}),
      },
      agentAssets: {
        ok: agentAssets.ok,
        summary: agentAssets.summary,
      },
    };

    if (json) {
      printJson(result);
    } else {
      logCli(`${cli.bold('repovine status')}\n`);
      logCli(`  ${cli.dim('Workspace:')}   ${env.repoRoot}`);
      logCli(`  ${cli.dim('Built at:')}    ${state.builtAt}`);
      logCli(`  ${cli.dim('Graph:')}       ${stats.totalNodes} nodes, ${stats.totalEdges} edges, ${state.snapshot.modules.length} modules`);
      logCli(`  ${cli.dim('MCP clients:')} ${configuredClients.length ? configuredClients.join(', ') : cli.warn('none configured')}`);
      logCli(`  ${cli.dim('Cache:')}       ${cache.severity === 'ok' ? cli.success('warm') : cli.warn('missing')}`);
      logCli(`  ${cli.dim('Annotations:')} ${annotationHealth.status === 'clean' ? cli.success('clean') : cli.warn('needs review')} `
        + `(needsWork ${annotationHealth.needsWork}, stale ${annotationHealth.counts.stale}, propagation-stale ${annotationHealth.counts.stalePropagation}, unannotated ${annotationHealth.counts.unannotated})`);
      logCli(`  ${cli.dim('Coverage:')}   ${formatModuleCoverageLine(compactCoverage(annotationStats))}`);
      logCli(`  ${cli.dim('Agent assets:')} ${agentAssets.ok ? cli.success('ok') : cli.warn(`${agentAssets.summary.errors} errors, ${agentAssets.summary.warnings} warnings`)}`);
      if (statusNextActions.length > 0) {
        logCli(`\n${cli.bold('Next actions:')}`);
        for (const action of statusNextActions.slice(0, 5)) logCli(`  - ${action}`);
      }
    }
    return result.ok ? 0 : 1;
  } catch (e) {
    const result = {
      ok: false,
      workspace: env.repoRoot,
      error: (e as Error).message,
    };
    if (json) printJson(result);
    else {
      logCli(`${cli.bold('repovine status')}\n`);
      logCli(`  ${cli.error('error')} ${(e as Error).message}`);
    }
    return 1;
  }
}
