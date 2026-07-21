import fs from 'node:fs';
import path from 'node:path';

export const REPOVINE_MCP_SERVER_NAME = 'repovine';

export type ConfigWriteStatus = 'created' | 'skipped' | 'overwritten' | 'merged' | 'removed' | 'error';

export interface ConfigWriteResult {
  path: string;
  status: ConfigWriteStatus;
  backupPath?: string;
  message?: string;
}

export interface ExistingConfigWriteProposal {
  path: string;
  action: 'overwrite' | 'merge' | 'update';
  message?: string;
  backupPlanned: boolean;
}

export type ExistingConfigWriteConfirm = (proposal: ExistingConfigWriteProposal) => boolean;

export type McpJsonInspect =
  | { kind: 'missing' }
  | { kind: 'invalid'; error: string }
  | { kind: 'empty' }
  | { kind: 'only-repovine' }
  | { kind: 'has-other-servers'; otherServers: string[] };

export type CodexInspect =
  | { kind: 'missing' }
  | { kind: 'has-repovine' }
  | { kind: 'has-other-mcp'; otherServers: string[] }
  | { kind: 'no-repovine' };

export type McpWritePlan = 'create' | 'merge' | 'replace-all' | 'skip';

export interface ResolveMcpPlanResult {
  plan: McpWritePlan;
  /** Shown in init output — why this plan was chosen */
  reason: string;
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function backupFile(filePath: string): string {
  const backupPath = `${filePath}.bak`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

/** Inspect Cursor/Claude MCP JSON before init decides create vs merge. */
export function inspectMcpJsonConfig(
  filePath: string,
  serversKey: 'mcpServers' = 'mcpServers',
): McpJsonInspect {
  if (!fs.existsSync(filePath)) {
    return { kind: 'missing' };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch (e) {
    return { kind: 'invalid', error: (e as Error).message };
  }

  const servers = parsed[serversKey];
  if (
    servers === undefined ||
    typeof servers !== 'object' ||
    servers === null ||
    Array.isArray(servers)
  ) {
    return { kind: 'empty' };
  }

  const names = Object.keys(servers as Record<string, unknown>);
  if (names.length === 0) {
    return { kind: 'empty' };
  }

  const otherServers = names.filter(n => n !== REPOVINE_MCP_SERVER_NAME);
  if (otherServers.length === 0) {
    return { kind: 'only-repovine' };
  }

  return { kind: 'has-other-servers', otherServers };
}

const CODEX_SERVER_MARKER = '[mcp_servers.repovine]';
const CODEX_OTHER_MCP_RE = /\[mcp_servers\.([^\]]+)\]/g;
const CODEX_HOOKS_BEGIN_MARKER = '# BEGIN repovine hooks';
const CODEX_HOOKS_END_MARKER = '# END repovine hooks';

/** Inspect Codex config.toml for existing MCP sections. */
export function inspectCodexMcpConfig(filePath: string): CodexInspect {
  if (!fs.existsSync(filePath)) {
    return { kind: 'missing' };
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  if (content.includes(CODEX_SERVER_MARKER)) {
    return { kind: 'has-repovine' };
  }

  const otherServers: string[] = [];
  for (const m of content.matchAll(CODEX_OTHER_MCP_RE)) {
    const name = m[1]?.trim();
    if (name && name !== 'repovine') {
      otherServers.push(name);
    }
  }

  if (otherServers.length > 0) {
    return { kind: 'has-other-mcp', otherServers: [...new Set(otherServers)] };
  }

  return { kind: 'no-repovine' };
}

/**
 * Choose create / merge / replace-all / skip from inspection.
 * When other MCP servers exist, merge is required — `--replace-mcp` is refused.
 */
export function resolveMcpJsonWritePlan(
  inspect: McpJsonInspect,
  replaceMcp: boolean,
): ResolveMcpPlanResult {
  if (inspect.kind === 'missing') {
    return { plan: 'create', reason: 'no MCP config file yet' };
  }
  if (inspect.kind === 'invalid') {
    if (replaceMcp) {
      return { plan: 'replace-all', reason: 'invalid JSON — replacing entire file (--replace-mcp)' };
    }
    return {
      plan: 'skip',
      reason: `invalid JSON (${inspect.error}) — fix manually or use --replace-mcp`,
    };
  }
  if (inspect.kind === 'empty') {
    if (replaceMcp) {
      return { plan: 'replace-all', reason: 'empty mcpServers — writing fresh template (--replace-mcp)' };
    }
    return { plan: 'merge', reason: 'mcpServers empty — adding repovine' };
  }
  if (inspect.kind === 'only-repovine') {
    return { plan: 'skip', reason: 'repovine already configured' };
  }

  // has-other-servers
  if (replaceMcp) {
    return {
      plan: 'merge',
      reason:
        `refusing --replace-mcp: would remove ${inspect.otherServers.length} server(s) `
        + `(${inspect.otherServers.join(', ')}) — using merge instead`,
    };
  }
  return {
    plan: 'merge',
    reason:
      `detected ${inspect.otherServers.length} existing MCP server(s) `
      + `(${inspect.otherServers.join(', ')}) — merge mode`,
  };
}

export function resolveCodexWritePlan(
  inspect: CodexInspect,
  replaceMcp: boolean,
): ResolveMcpPlanResult {
  if (inspect.kind === 'missing') {
    return { plan: 'create', reason: 'no Codex config yet' };
  }
  if (inspect.kind === 'has-repovine') {
    return { plan: 'skip', reason: 'repovine section already present' };
  }
  if (inspect.kind === 'has-other-mcp') {
    if (replaceMcp) {
      return {
        plan: 'merge',
        reason:
          `refusing --replace-mcp: would remove Codex MCP section(s) `
          + `(${inspect.otherServers.join(', ')}) — appending repovine block instead`,
      };
    }
    return {
      plan: 'merge',
      reason:
        `detected other Codex MCP server(s) (${inspect.otherServers.join(', ')}) — append merge`,
    };
  }
  if (replaceMcp) {
    return { plan: 'replace-all', reason: 'replacing Codex config (--replace-mcp)' };
  }
  return { plan: 'merge', reason: 'appending repovine section' };
}

function backupFileIfNeeded(filePath: string): string {
  const backupPath = `${filePath}.bak`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath);
  }
  return backupPath;
}

function normalizeTomlAppend(content: string, block: string): string {
  const separator = content.endsWith('\n') ? '\n' : '\n\n';
  return `${content}${separator}${block.trim()}\n`;
}

function reconcileCodexHooksBlock(
  content: string,
  hooksBlock: string | undefined,
): { content: string; changed: boolean; message?: string } {
  if (!hooksBlock) {
    return { content, changed: false };
  }

  const desired = hooksBlock.trim();
  const beginIndex = content.indexOf(CODEX_HOOKS_BEGIN_MARKER);
  const endIndex = content.indexOf(CODEX_HOOKS_END_MARKER);

  if (beginIndex >= 0 && endIndex > beginIndex) {
    let blockStart = content.lastIndexOf('\n', beginIndex);
    blockStart = blockStart >= 0 ? blockStart + 1 : 0;

    const previousLineEnd = Math.max(0, blockStart - 1);
    const previousLineStart = content.lastIndexOf('\n', previousLineEnd - 1) + 1;
    const previousLine = content.slice(previousLineStart, previousLineEnd);
    if (/^\s*# repovine hooks/.test(previousLine)) {
      blockStart = previousLineStart;
    }

    let blockEnd = endIndex + CODEX_HOOKS_END_MARKER.length;
    if (content[blockEnd] === '\n') blockEnd += 1;

    const current = content.slice(blockStart, blockEnd).trim();
    if (current === desired) {
      return { content, changed: false, message: 'Codex hooks already present' };
    }

    const before = content.slice(0, blockStart).trimEnd();
    const after = content.slice(blockEnd).trimStart();
    const next = [before, desired, after].filter(Boolean).join('\n\n');
    return {
      content: `${next}\n`,
      changed: true,
      message: 'updated Codex hooks block',
    };
  }

  const next = normalizeTomlAppend(content.trimEnd(), desired);
  return {
    content: next,
    changed: true,
    message: 'added Codex hooks block',
  };
}

function reconcileCodexManagedBlocks(
  content: string,
  hooksBlock?: string,
): { content: string; changed: boolean; messages: string[] } {
  let next = content;
  const messages: string[] = [];
  let changed = false;

  const hooks = reconcileCodexHooksBlock(next, hooksBlock);
  if (hooks.changed) {
    next = hooks.content;
    changed = true;
    if (hooks.message) messages.push(hooks.message);
  }

  return { content: next, changed, messages };
}

function applyMcpJsonPlan(
  filePath: string,
  serversKey: 'mcpServers',
  serverEntry: Record<string, unknown>,
  fullTemplateContent: string,
  plan: McpWritePlan,
  confirmExistingWrite?: ExistingConfigWriteConfirm,
): ConfigWriteResult {
  ensureParentDir(filePath);

  if (plan === 'skip') {
    return { path: filePath, status: 'skipped' };
  }

  if (plan === 'create') {
    fs.writeFileSync(filePath, fullTemplateContent, 'utf-8');
    return { path: filePath, status: 'created' };
  }

  if (plan === 'replace-all') {
    if (fs.existsSync(filePath) && confirmExistingWrite && !confirmExistingWrite({
      path: filePath,
      action: 'overwrite',
      message: 'replace MCP config',
      backupPlanned: true,
    })) {
      return { path: filePath, status: 'skipped', message: 'declined by interactive prompt: replace MCP config' };
    }
    const backupPath = fs.existsSync(filePath) ? backupFile(filePath) : undefined;
    fs.writeFileSync(filePath, fullTemplateContent, 'utf-8');
    return {
      path: filePath,
      status: backupPath ? 'overwritten' : 'created',
      backupPath,
    };
  }

  // merge
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, fullTemplateContent, 'utf-8');
    return { path: filePath, status: 'created' };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch (e) {
    return {
      path: filePath,
      status: 'error',
      message: `Could not parse JSON: ${(e as Error).message}`,
    };
  }

  let servers = parsed[serversKey];
  if (servers === undefined) {
    servers = {};
    parsed[serversKey] = servers;
  }
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    return {
      path: filePath,
      status: 'error',
      message: `Expected "${serversKey}" to be an object`,
    };
  }

  const serversObj = servers as Record<string, unknown>;
  if (serversObj[REPOVINE_MCP_SERVER_NAME] !== undefined) {
    return {
      path: filePath,
      status: 'skipped',
      message: `${REPOVINE_MCP_SERVER_NAME} already present`,
    };
  }

  if (confirmExistingWrite && !confirmExistingWrite({
    path: filePath,
    action: 'merge',
    message: `add ${REPOVINE_MCP_SERVER_NAME} to ${serversKey}`,
    backupPlanned: true,
  })) {
    return { path: filePath, status: 'skipped', message: `declined by interactive prompt: add ${REPOVINE_MCP_SERVER_NAME} to ${serversKey}` };
  }
  const backupPath = backupFile(filePath);
  serversObj[REPOVINE_MCP_SERVER_NAME] = serverEntry;
  fs.writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
  return { path: filePath, status: 'merged', backupPath };
}

function applyCodexPlan(
  filePath: string,
  serverBlock: string,
  fullTemplateContent: string,
  plan: McpWritePlan,
  hooksBlock?: string,
  confirmExistingWrite?: ExistingConfigWriteConfirm,
): ConfigWriteResult {
  ensureParentDir(filePath);

  if (plan === 'skip') {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const managed = reconcileCodexManagedBlocks(content, hooksBlock);
      if (managed.changed) {
        if (confirmExistingWrite && !confirmExistingWrite({
          path: filePath,
          action: 'update',
          message: managed.messages.join('; ') || 'update Codex managed blocks',
          backupPlanned: true,
        })) {
          return { path: filePath, status: 'skipped', message: 'declined by interactive prompt: update Codex managed blocks' };
        }
        const backupPath = backupFileIfNeeded(filePath);
        fs.writeFileSync(filePath, managed.content, 'utf-8');
        return {
          path: filePath,
          status: 'merged',
          backupPath,
          message: managed.messages.join('; '),
        };
      }
    }
    return { path: filePath, status: 'skipped' };
  }

  if (plan === 'create') {
    fs.writeFileSync(filePath, fullTemplateContent, 'utf-8');
    return { path: filePath, status: 'created' };
  }

  if (plan === 'replace-all') {
    if (fs.existsSync(filePath) && confirmExistingWrite && !confirmExistingWrite({
      path: filePath,
      action: 'overwrite',
      message: 'replace Codex config',
      backupPlanned: true,
    })) {
      return { path: filePath, status: 'skipped', message: 'declined by interactive prompt: replace Codex config' };
    }
    const backupPath = fs.existsSync(filePath) ? backupFile(filePath) : undefined;
    fs.writeFileSync(filePath, fullTemplateContent, 'utf-8');
    return {
      path: filePath,
      status: backupPath ? 'overwritten' : 'created',
      backupPath,
    };
  }

  // merge append
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, fullTemplateContent, 'utf-8');
    return { path: filePath, status: 'created' };
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  if (content.includes(CODEX_SERVER_MARKER)) {
    return {
      path: filePath,
      status: 'skipped',
      message: `${REPOVINE_MCP_SERVER_NAME} section already present`,
    };
  }

  if (confirmExistingWrite && !confirmExistingWrite({
    path: filePath,
    action: 'merge',
    message: `append ${REPOVINE_MCP_SERVER_NAME} MCP section`,
    backupPlanned: true,
  })) {
    return { path: filePath, status: 'skipped', message: `declined by interactive prompt: append ${REPOVINE_MCP_SERVER_NAME} MCP section` };
  }
  const backupPath = backupFile(filePath);
  const withServer = normalizeTomlAppend(content, serverBlock);
  const managed = reconcileCodexManagedBlocks(withServer, hooksBlock);
  fs.writeFileSync(filePath, managed.content, 'utf-8');
  return {
    path: filePath,
    status: 'merged',
    backupPath,
    message: managed.messages.join('; '),
  };
}

/**
 * Smart MCP JSON init: inspect → plan (merge when other servers exist) → write.
 */
export function writeMcpJsonConfig(
  filePath: string,
  serversKey: 'mcpServers',
  serverEntry: Record<string, unknown>,
  fullTemplateContent: string,
  replaceMcp: boolean,
  confirmExistingWrite?: ExistingConfigWriteConfirm,
): ConfigWriteResult {
  const inspect = inspectMcpJsonConfig(filePath, serversKey);
  const { plan, reason } = resolveMcpJsonWritePlan(inspect, replaceMcp);
  const result = applyMcpJsonPlan(filePath, serversKey, serverEntry, fullTemplateContent, plan, confirmExistingWrite);
  if (result.message) {
    result.message = `${result.message}; ${reason}`;
  } else {
    result.message = reason;
  }
  return result;
}

/**
 * Smart Codex init: inspect → plan → write/append.
 */
export function writeCodexMcpConfig(
  filePath: string,
  serverBlock: string,
  fullTemplateContent: string,
  replaceMcp: boolean,
  hooksBlock?: string,
  confirmExistingWrite?: ExistingConfigWriteConfirm,
): ConfigWriteResult {
  const inspect = inspectCodexMcpConfig(filePath);
  const { plan, reason } = resolveCodexWritePlan(inspect, replaceMcp);
  const result = applyCodexPlan(filePath, serverBlock, fullTemplateContent, plan, hooksBlock, confirmExistingWrite);
  result.message = result.message ? `${result.message}; ${reason}` : reason;
  return result;
}

/** Human-readable preflight lines for `setup` console output. */
export function formatMcpPreflight(
  label: string,
  filePath: string,
  inspect: McpJsonInspect | CodexInspect,
  plan: ResolveMcpPlanResult,
): string {
  const rel = path.basename(filePath);
  if (inspect.kind === 'missing') {
    return `  ${label} (${rel}): not found → ${plan.plan} (${plan.reason})`;
  }
  if (inspect.kind === 'has-other-servers') {
    return `  ${label} (${rel}): ${inspect.otherServers.length} server(s) [${inspect.otherServers.join(', ')}] → ${plan.plan} (${plan.reason})`;
  }
  if (inspect.kind === 'has-other-mcp') {
    return `  ${label} (${rel}): other MCP [${inspect.otherServers.join(', ')}] → ${plan.plan} (${plan.reason})`;
  }
  if (inspect.kind === 'only-repovine' || inspect.kind === 'has-repovine') {
    return `  ${label} (${rel}): already set up → ${plan.plan}`;
  }
  if (inspect.kind === 'invalid') {
    return `  ${label} (${rel}): invalid JSON → ${plan.plan} (${plan.reason})`;
  }
  return `  ${label} (${rel}): → ${plan.plan} (${plan.reason})`;
}
