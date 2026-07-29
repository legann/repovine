import fs from 'node:fs';
import path from 'node:path';
import {
  ensureEmptyAnnotationsFile,
} from '../annotations/maintenance.js';
import {
  ANNOTATIONS_FILENAME,
  ARTIFACTS_DIR_NAME,
  DOMAINS_CONFIG_FILENAME,
} from '../paths.js';
import {
  REPOVINE_GITIGNORE_ENTRY,
  formatRepovineGitignoreBlock,
} from './repovine-gitignore.js';
import { CONFIG_FILENAME } from '../config.js';
import type { DomainsAdvisorCliResult } from './domains-advisor.js';
import {
  CURSOR_HOOKS_SETTINGS,
  CLAUDE_HOOKS_SETTINGS,
  CODEX_HOOKS_BLOCK,
  AGENTS_MD,
  AGENTS_MD_BEGIN_MARKER,
  AGENTS_MD_END_MARKER,
  CLAUDE_MD,
  REPOVINE_CONFIG_JSON,
  REPOVINE_DOMAINS_JSON,
  NPX_LAUNCHER,
  buildCursorMcpServer,
  buildClaudeMcpServer,
  buildCursorMcpJson,
  buildClaudeMcpJson,
  buildCodexMcpServerBlock,
  buildCodexConfigToml,
  type McpLauncher,
} from './templates.js';
import { applyEol, detectEol, isUniformEol, normalizeEol } from './eol.js';
import { CLIENT_CAPABILITIES, type ClientId } from './client-capabilities.js';
import { CLIENT_DISPATCHER_FILENAME, readClientDispatcherSource } from './dispatcher/index.js';
import { shouldWalkDiscoveryDir } from '../scan-filters.js';
// Side-effect import: the built-in source plugins must be registered before the preflight asks
import { getKnownExtensions } from '../plugins/source-set.js';
import { normalizeRelPath } from '../platform/paths.js';
import {
  isManagedClaudeHook,
  isManagedCursorHookCommand,
} from './dispatcher/hook-identity.js';
import {
  writeMcpJsonConfig,
  writeCodexMcpConfig,
  inspectMcpJsonConfig,
  inspectCodexMcpConfig,
  resolveMcpJsonWritePlan,
  resolveCodexWritePlan,
  formatMcpPreflight,
  type ConfigWriteResult,
  type ConfigWriteStatus,
} from './merge-config.js';
import {
  COMMANDS,
  CLAUDE_SHARED_SKILLS,
  CODEX_SHARED_SKILLS,
  CURSOR_SHARED_SKILLS,
  CURSOR_RULES,
  renderCursorBody,
  renderClaudeFrontmatter,
  renderCursorAgentFrontmatter,
  renderCodexAgentToml,
  renderSkillMarkdown,
  type OnboardingAsset,
  DEFAULT_PROJECT_SUBAGENT_NAME,
  INIT_ANNOTATION_QUEUE_HINT,
} from './onboarding-assets.js';
import { renderAgentAssets, type RenderClient } from './agent-render.js';
import { promptLineSync } from './prompt.js';
import {
  cli,
  formatSetupTitle,
  formatWorkspaceSupportLines,
  formatFileLine,
  formatGroupLabel,
  styleMcpPreflight,
  styleNextStepLine,
  type FileResultTone,
} from './ui.js';

export type ClientTarget = 'cursor' | 'claude' | 'codex' | 'all';

export interface InitOptions {
  /** Overwrite generated bootstrap files such as AGENTS.md/client assets; project config files are preserved. */
  forceBootstrap: boolean;
  /** Replace entire MCP config only when safe; refused if other MCP servers would be removed */
  replaceMcp: boolean;
  /** Prompt before changing existing files. Created files are still written without a prompt. */
  interactive?: boolean;
  /** Internal hook used by interactive setup. */
  confirmExistingWrite?: (proposal: InitExistingWriteProposal) => boolean;
  /** Create .bak files for generated assets during interactive updates. */
  backupGeneratedAssets?: boolean;
  /** True when the CLI dispatch will run a graph build right after setup (the default). */
  autoBuild?: boolean;
  /** How generated MCP configs launch the engine (npx vs local dist). Defaults to npx. */
  mcpLauncher?: McpLauncher;
}

export type FileResult = ConfigWriteResult;

export interface InitExistingWriteProposal {
  path: string;
  action: 'overwrite' | 'merge' | 'update';
  message?: string;
  backupPlanned: boolean;
}

let activeInitOptions: InitOptions | undefined;

function shouldApplyExistingWrite(
  filePath: string,
  action: InitExistingWriteProposal['action'],
  message: string | undefined,
  backupPlanned: boolean,
): boolean {
  if (!activeInitOptions?.confirmExistingWrite) return true;
  return activeInitOptions.confirmExistingWrite({
    path: filePath,
    action,
    message,
    backupPlanned,
  });
}

function skippedByPrompt(filePath: string, message?: string): FileResult {
  return {
    path: filePath,
    status: 'skipped',
    message: message ? `declined by interactive prompt: ${message}` : 'declined by interactive prompt',
  };
}

interface RenderedAssetTarget {
  relativeDir: string;
  extension?: string;
  fileName?: string;
  render: (asset: OnboardingAsset) => string;
}

function renderedAssetPath(cwd: string, asset: OnboardingAsset, target: RenderedAssetTarget): string {
  if (target.fileName) {
    return path.join(cwd, target.relativeDir, asset.name, target.fileName);
  }
  if (!target.extension) {
    throw new Error('Rendered asset target requires either extension or fileName');
  }
  return path.join(cwd, target.relativeDir, `${asset.name}.${target.extension}`);
}

const CLIENT_ASSET_TARGETS = {
  claudeAgents: {
    relativeDir: path.join('.claude', 'agents'),
    extension: 'md',
    render: renderClaudeFrontmatter,
  },
  claudeSkills: {
    relativeDir: path.join('.claude', 'skills'),
    fileName: 'SKILL.md',
    render: renderSkillMarkdown,
  },
  cursorAgents: {
    relativeDir: path.join('.cursor', 'agents'),
    extension: 'md',
    render: renderCursorAgentFrontmatter,
  },
  cursorRules: {
    relativeDir: path.join('.cursor', 'rules'),
    extension: 'mdc',
    render: renderCursorBody,
  },
  codexAgents: {
    relativeDir: path.join('.codex', 'agents'),
    extension: 'toml',
    render: renderCodexAgentToml,
  },
  sharedAgentSkills: {
    relativeDir: path.join('.agents', 'skills'),
    fileName: 'SKILL.md',
    render: renderSkillMarkdown,
  },
} satisfies Record<string, RenderedAssetTarget>;

const INIT_CAPABILITY_MATRIX = {
  cursor: {
    mcp: { owner: 'project', policy: 'merge' },
    commands: { owner: 'unsupported' },
    agents: { owner: 'project', target: CLIENT_ASSET_TARGETS.cursorAgents },
    hooks: { owner: 'project', policy: 'hooks-json' },
    skills: { owner: 'shared', target: CLIENT_ASSET_TARGETS.sharedAgentSkills },
    rules: { owner: 'project', target: CLIENT_ASSET_TARGETS.cursorRules },
  },
  claude: {
    mcp: { owner: 'project', policy: 'merge' },
    commands: { owner: 'unsupported' },
    agents: { owner: 'project', target: CLIENT_ASSET_TARGETS.claudeAgents },
    hooks: { owner: 'project', policy: 'settings-json' },
    skills: { owner: 'project', target: CLIENT_ASSET_TARGETS.claudeSkills },
    rules: { owner: 'instructions', files: ['CLAUDE.md', 'AGENTS.md'] },
  },
  codex: {
    mcp: { owner: 'project', policy: 'merge' },
    commands: { owner: 'unsupported' },
    agents: { owner: 'project', target: CLIENT_ASSET_TARGETS.codexAgents },
    hooks: { owner: 'project', policy: 'config-toml' },
    skills: { owner: 'project', target: CLIENT_ASSET_TARGETS.sharedAgentSkills },
    rules: { owner: 'instructions', files: ['AGENTS.md'] },
  },
} as const;


// Python (pyproject.toml / setup.py) is a SUPPORTED source plugin now and is handled
// separately via pythonPackageCount — it is intentionally absent from this list.
const UNSUPPORTED_PROJECT_FILES = new Set([
  'requirements.txt', 'poetry.lock', 'Pipfile',
  'go.mod', 'go.sum',
  'Cargo.toml',
  'pom.xml', 'build.gradle', 'build.gradle.kts',
  'Gemfile',
  'composer.json',
]);

const PYTHON_PACKAGE_MARKERS = new Set(['pyproject.toml', 'setup.py']);

const UNSUPPORTED_SOURCE_EXTENSIONS = new Set([
  '.go', '.rs', '.java', '.kt', '.kts', '.rb', '.php', '.cs',
]);

const PROJECT_SIGNAL_FILES = new Set([
  'package.json', 'vite.config.js', 'vite.config.ts', 'next.config.js', 'next.config.ts',
]);

/**
 * A file the preflight counts as "there is a project here". Read from the registry, so the answer
 * matches what discovery will actually index: spelled by hand it listed the TypeScript family only,
 * and a repository written entirely in Python reported no project signals at all.
 */
function isProjectSignalExtension(ext: string): boolean {
  return getKnownExtensions().includes(ext.toLowerCase());
}

export interface WorkspaceSupportInspection {
  tsconfigCount: number;
  /** Count of Python package markers (pyproject.toml / setup.py). */
  pythonPackageCount: number;
  hasIaC: boolean;
  hasUnsupportedSignals: boolean;
  hasProjectSignals: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isLikelyIacFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.tf') return true;
  if (name === 'Dockerfile' || name.startsWith('Dockerfile.')) return true;
  if (name === 'Chart.yaml' || name === 'Chart.yml') return true;
  if (/^(template|sam|serverless|cloudformation)\.(ya?ml|json)$/i.test(name)) return true;
  return false;
}

export function inspectWorkspaceSupport(cwd: string): WorkspaceSupportInspection {
  const result: WorkspaceSupportInspection = {
    tsconfigCount: 0,
    pythonPackageCount: 0,
    hasIaC: false,
    hasUnsupportedSignals: false,
    hasProjectSignals: false,
  };

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        // The preflight count predicts what the graph will hold, so it prunes where discovery does.
        if (!shouldWalkDiscoveryDir(entry.name)) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;

      const name = entry.name;
      const ext = path.extname(name).toLowerCase();
      if (name === 'tsconfig.json') result.tsconfigCount++;
      if (PYTHON_PACKAGE_MARKERS.has(name)) result.pythonPackageCount++;
      if (isLikelyIacFile(name)) result.hasIaC = true;
      if (UNSUPPORTED_PROJECT_FILES.has(name) || UNSUPPORTED_SOURCE_EXTENSIONS.has(ext)) {
        result.hasUnsupportedSignals = true;
      }
      if (PROJECT_SIGNAL_FILES.has(name) || isProjectSignalExtension(ext)) {
        result.hasProjectSignals = true;
      }
    }
  };

  walk(cwd);
  return result;
}

/** Rough wall-time estimate for a cold-build on 4 worker threads. Heuristic only —
 * actual time depends on package sizes, shared imports, and machine speed. */
export function estimateColdBuild(tsconfigCount: number): { range: string; recommendBuild: boolean } {
  if (tsconfigCount === 0) return { range: '—', recommendBuild: false };
  if (tsconfigCount < 50) return { range: '~20-60s', recommendBuild: false };
  if (tsconfigCount < 200) return { range: '~1-3 min', recommendBuild: false };
  if (tsconfigCount < 600) return { range: '~3-10 min', recommendBuild: true };
  return { range: '~10-30 min (cold), seconds (warm)', recommendBuild: true };
}

export function formatWorkspaceSupportPreflight(
  inspection: WorkspaceSupportInspection,
  opts?: { autoBuild?: boolean },
): string {
  const { tsconfigCount, pythonPackageCount, hasIaC } = inspection;
  if (tsconfigCount > 0 || pythonPackageCount > 0) {
    const langs: string[] = [];
    if (tsconfigCount > 0) langs.push(`TypeScript (${tsconfigCount} tsconfig(s))`);
    if (pythonPackageCount > 0) langs.push(`Python (${pythonPackageCount} package(s))`);
    const iacSuffix = hasIaC ? ' with IaC infra' : '';
    const base = `Detected ${langs.join(' + ')} project${iacSuffix}.`;
    const est = estimateColdBuild(tsconfigCount);
    const buildLine = `First-time graph build: ${est.range === '—' ? 'seconds' : est.range}.`;
    const recLine = opts?.autoBuild
      ? 'The graph builds now as part of setup (pass --no-build to defer to first MCP start).'
      : est.recommendBuild
        ? 'Recommended: `repovine setup` or `repovine build` so MCP starts warm.'
        : 'Graph builds on first MCP start (or run `repovine build` now).';
    return `${base}\n  ${buildLine}\n  ${recLine}`;
  }
  if (hasIaC) {
    return 'IaC files detected but no source project (no tsconfig.json / pyproject.toml). repovine will build an infra-only graph (infra modules, no code modules).';
  }
  if (inspection.hasUnsupportedSignals || inspection.hasProjectSignals) {
    return 'Existing unsupported project detected. repovine currently indexes TypeScript and Python projects, with or without IaC infra.';
  }
  return 'No supported files found yet.';
}

function writeFileIfNotExists(
  filePath: string,
  content: string,
  force: boolean,
): FileResult {
  const exists = fs.existsSync(filePath);
  if (exists && !force) {
    return { path: filePath, status: 'skipped' };
  }

  const backupPath = exists && activeInitOptions?.interactive ? `${filePath}.bak` : undefined;
  if (exists && !shouldApplyExistingWrite(filePath, 'overwrite', 'overwrite existing file', !!backupPath)) {
    return skippedByPrompt(filePath, 'overwrite existing file');
  }

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (backupPath) {
    fs.copyFileSync(filePath, backupPath);
  }
  fs.writeFileSync(filePath, content, 'utf-8');
  return { path: filePath, status: exists ? 'overwritten' : 'created', backupPath };
}

function writeProjectConfigIfMissing(
  filePath: string,
  content: string,
  message: string,
): FileResult {
  if (fs.existsSync(filePath)) {
    return { path: filePath, status: 'skipped', message };
  }
  return writeFileIfNotExists(filePath, content, false);
}

interface ManagedWriteOptions {
  /** When false, the asset updates in place; `backupGeneratedAssets` still writes `<file>.bak`. */
  backup?: boolean;
}

function writeManagedFile(
  filePath: string,
  content: string,
  force: boolean,
  options: ManagedWriteOptions = {},
): FileResult {
  const backupEnabled = options.backup !== false || activeInitOptions?.backupGeneratedAssets === true;
  const exists = fs.existsSync(filePath);
  if (exists) {
    const current = fs.readFileSync(filePath, 'utf-8');
    if (current === content && !force) {
      return { path: filePath, status: 'skipped' };
    }
  }

  const backupPath = exists && backupEnabled ? `${filePath}.bak` : undefined;
  if (exists && !shouldApplyExistingWrite(
    filePath,
    force ? 'overwrite' : 'update',
    exists ? 'update managed repovine file' : undefined,
    !!backupPath,
  )) {
    return skippedByPrompt(filePath, 'update managed repovine file');
  }

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (backupPath) {
    fs.copyFileSync(filePath, backupPath);
  }
  fs.writeFileSync(filePath, content, 'utf-8');
  return {
    path: filePath,
    status: exists ? (force ? 'overwritten' : 'merged') : 'created',
    backupPath,
    message: exists ? 'updated managed file' : undefined,
  };
}

function replaceMarkedSection(current: string, nextSection: string): string | null {
  const begin = current.indexOf(AGENTS_MD_BEGIN_MARKER);
  const end = current.indexOf(AGENTS_MD_END_MARKER);
  if (begin === -1 || end === -1 || end < begin) return null;

  const sectionEnd = end + AGENTS_MD_END_MARKER.length;
  const before = current.slice(0, begin).trimEnd();
  const after = current.slice(sectionEnd).trimStart();
  return [
    before,
    nextSection.trimEnd(),
    after,
  ].filter(Boolean).join('\n\n') + '\n';
}

function looksLikeRepoContextAgentsMd(content: string): boolean {
  const trimmed = content.trimStart();
  return trimmed.startsWith('# repovine -- quick reference')
    || trimmed.startsWith('# repovine — quick reference');
}

function writeAgentsMd(cwd: string, force: boolean): FileResult {
  const filePath = path.join(cwd, 'AGENTS.md');
  const exists = fs.existsSync(filePath);
  if (!exists) {
    return writeFileIfNotExists(filePath, AGENTS_MD, force);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  // Merge in LF space; the write restores the file's EOL. Mixed-EOL files merge
  // on the raw bytes and are written verbatim, so newlines outside the managed
  // section survive.
  const uniform = isUniformEol(raw);
  const current = uniform ? normalizeEol(raw) : raw;
  if (current === AGENTS_MD && !force) {
    return { path: filePath, status: 'skipped' };
  }

  const marked = replaceMarkedSection(current, AGENTS_MD);
  const nextContent = marked
    ?? (looksLikeRepoContextAgentsMd(current) || force
      ? AGENTS_MD
      : `${current.trimEnd()}\n\n${AGENTS_MD}`);

  if (current === nextContent && !force) {
    return { path: filePath, status: 'skipped' };
  }

  const message = marked
    ? 'updated repovine AGENTS.md section'
    : looksLikeRepoContextAgentsMd(current)
      ? 'updated generated repovine AGENTS.md'
      : force
        ? 'overwrote AGENTS.md'
        : 'added repovine AGENTS.md section';
  const backupPath = `${filePath}.bak`;
  if (!shouldApplyExistingWrite(filePath, force ? 'overwrite' : 'merge', message, true)) {
    return skippedByPrompt(filePath, message);
  }
  fs.copyFileSync(filePath, backupPath);
  fs.writeFileSync(filePath, uniform ? applyEol(nextContent, detectEol(raw)) : nextContent, 'utf-8');
  return {
    path: filePath,
    status: force ? 'overwritten' : 'merged',
    backupPath,
    message,
  };
}

function writeRenderedAssets(
  cwd: string,
  assets: OnboardingAsset[],
  target: RenderedAssetTarget,
  force: boolean,
): FileResult[] {
  return assets.map(asset =>
    writeManagedFile(
      renderedAssetPath(cwd, asset, target),
      target.render(asset),
      force,
      { backup: false },
    ),
  );
}

function writeProjectedAgentAssets(cwd: string, client: RenderClient, force: boolean): FileResult[] {
  const preview = renderAgentAssets({ repoRoot: cwd, client, write: false }).preview ?? [];
  return preview
    .filter(asset => asset.writable)
    .map(asset =>
      writeManagedFile(path.join(cwd, asset.path), asset.content, force, { backup: false }),
    );
}

function writeClaudeSkills(cwd: string, force: boolean): FileResult[] {
  return writeRenderedAssets(cwd, [...COMMANDS, ...CLAUDE_SHARED_SKILLS], INIT_CAPABILITY_MATRIX.claude.skills.target, force);
}

/** Write the client's hooks dir: one managed dispatcher file for every hook action. */
function writeHookDispatcher(cwd: string, client: ClientId, force: boolean): FileResult[] {
  const hooksDir = path.join(cwd, ...CLIENT_CAPABILITIES[client].hooks.projectScriptsDir.split('/'));
  const results: FileResult[] = [
    writeManagedFile(
      path.join(hooksDir, CLIENT_DISPATCHER_FILENAME),
      readClientDispatcherSource(),
      force,
      { backup: false },
    ),
  ];
  return results;
}

function writeClaudeHooks(cwd: string, force: boolean): FileResult[] {
  return writeHookDispatcher(cwd, 'claude', force);
}

/** Managed-entry test for Claude settings merge: any hook in the entry is repovine's (dispatcher form). */
function claudeHookEntryIsManaged(entry: unknown): boolean {
  return isRecord(entry) && Array.isArray(entry.hooks) && entry.hooks.some(isManagedClaudeHook);
}

function writeClaudeSettingsHooks(cwd: string): FileResult {
  const filePath = path.join(cwd, '.claude', 'settings.json');
  const desiredHooks = cloneJson(CLAUDE_HOOKS_SETTINGS);

  let settings: Record<string, unknown> = {};
  const exists = fs.existsSync(filePath);
  const previousContent = exists ? fs.readFileSync(filePath, 'utf-8') : '';
  if (exists) {
    try {
      settings = JSON.parse(previousContent) as Record<string, unknown>;
    } catch (e) {
      return {
        path: filePath,
        status: 'error',
        message: `Could not parse JSON: ${(e as Error).message}`,
      };
    }
    if (!isRecord(settings)) {
      return {
        path: filePath,
        status: 'error',
        message: 'Expected Claude settings to be a JSON object',
      };
    }
  }

  const existingHooks = settings.hooks;
  if (existingHooks !== undefined && !isRecord(existingHooks)) {
    return {
      path: filePath,
      status: 'error',
      message: 'Expected "hooks" to be an object',
    };
  }

  const nextHooks = isRecord(existingHooks) ? { ...existingHooks } : {};
  for (const [eventName, desiredEntries] of Object.entries(desiredHooks)) {
    const currentEntries = nextHooks[eventName];
    // Re-runs replace repovine's entries instead of duplicating them.
    const keptEntries = Array.isArray(currentEntries)
      ? currentEntries.filter(entry => !claudeHookEntryIsManaged(entry))
      : [];
    nextHooks[eventName] = [...keptEntries, ...desiredEntries];
  }

  const nextSettings = { ...settings, hooks: nextHooks };
  // Uniform-EOL files get their EOL restored on write; mixed-EOL files keep
  // the LF JSON serialization, since no single EOL represents them.
  const eol = isUniformEol(previousContent) ? detectEol(previousContent) : '\n';
  const nextContent = applyEol(`${JSON.stringify(nextSettings, null, 2)}\n`, eol);
  if (exists && previousContent === nextContent) {
    return { path: filePath, status: 'skipped', message: 'Claude hooks already present' };
  }

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const backupPath = exists ? `${filePath}.bak` : undefined;
  if (exists && !shouldApplyExistingWrite(filePath, 'merge', 'updated Claude hooks', !!backupPath)) {
    return skippedByPrompt(filePath, 'updated Claude hooks');
  }
  if (backupPath) {
    fs.copyFileSync(filePath, backupPath);
  }
  fs.writeFileSync(filePath, nextContent, 'utf-8');
  return {
    path: filePath,
    status: exists ? 'merged' : 'created',
    backupPath,
    message: exists ? 'updated Claude hooks' : 'created Claude settings with hooks',
  };
}

function writeCursorSkills(cwd: string, force: boolean): FileResult[] {
  // Cursor has no project-scoped slash commands; the build/lifecycle workflows
  // (COMMANDS) ship as skills alongside the shared skill set, same as Claude/Codex.
  return writeRenderedAssets(cwd, [...COMMANDS, ...CURSOR_SHARED_SKILLS], INIT_CAPABILITY_MATRIX.cursor.skills.target, force);
}

function writeCursorRules(cwd: string, force: boolean): FileResult[] {
  return writeRenderedAssets(cwd, CURSOR_RULES, INIT_CAPABILITY_MATRIX.cursor.rules.target, force);
}

function writeCursorHooksConfig(cwd: string): FileResult {
  const filePath = path.join(cwd, '.cursor', 'hooks.json');
  const desired = cloneJson(CURSOR_HOOKS_SETTINGS);

  let config: Record<string, unknown> = {};
  const exists = fs.existsSync(filePath);
  const previousContent = exists ? fs.readFileSync(filePath, 'utf-8') : '';
  if (exists) {
    try {
      config = JSON.parse(previousContent) as Record<string, unknown>;
    } catch (e) {
      return {
        path: filePath,
        status: 'error',
        message: `Could not parse JSON: ${(e as Error).message}`,
      };
    }
    if (!isRecord(config)) {
      return {
        path: filePath,
        status: 'error',
        message: 'Expected Cursor hooks config to be a JSON object',
      };
    }
  }

  const existingHooks = config.hooks;
  if (existingHooks !== undefined && !isRecord(existingHooks)) {
    return {
      path: filePath,
      status: 'error',
      message: 'Expected "hooks" to be an object',
    };
  }

  const nextHooks = isRecord(existingHooks) ? { ...existingHooks } : {};
  for (const [eventName, desiredEntries] of Object.entries(desired.hooks)) {
    const currentEntries = nextHooks[eventName];
    // Re-runs replace repovine's entries instead of duplicating them.
    const keptEntries = Array.isArray(currentEntries)
      ? currentEntries.filter(entry => !(isRecord(entry) && isManagedCursorHookCommand(entry.command)))
      : [];
    nextHooks[eventName] = [...keptEntries, ...desiredEntries];
  }

  const nextConfig = { version: desired.version, ...config, hooks: nextHooks };
  // Uniform-EOL files get their EOL restored on write; mixed-EOL files keep
  // the LF JSON serialization, since no single EOL represents them.
  const eol = isUniformEol(previousContent) ? detectEol(previousContent) : '\n';
  const nextContent = applyEol(`${JSON.stringify(nextConfig, null, 2)}\n`, eol);
  if (exists && previousContent === nextContent) {
    return { path: filePath, status: 'skipped', message: 'Cursor hooks already present' };
  }

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const backupPath = exists ? `${filePath}.bak` : undefined;
  if (exists && !shouldApplyExistingWrite(filePath, 'merge', 'updated Cursor hooks', !!backupPath)) {
    return skippedByPrompt(filePath, 'updated Cursor hooks');
  }
  if (backupPath) {
    fs.copyFileSync(filePath, backupPath);
  }
  fs.writeFileSync(filePath, nextContent, 'utf-8');
  return {
    path: filePath,
    status: exists ? 'merged' : 'created',
    backupPath,
    message: exists ? 'updated Cursor hooks' : 'created Cursor hooks',
  };
}

function writeCursorHooks(cwd: string, force: boolean): FileResult[] {
  return [
    ...writeHookDispatcher(cwd, 'cursor', force),
    writeCursorHooksConfig(cwd),
  ];
}

function writeCodexHooks(cwd: string, force: boolean): FileResult[] {
  return writeHookDispatcher(cwd, 'codex', force);
}

function writeCodexSkills(cwd: string, force: boolean): FileResult[] {
  return writeRenderedAssets(cwd, [...COMMANDS, ...CODEX_SHARED_SKILLS], INIT_CAPABILITY_MATRIX.codex.skills.target, force);
}

function ensureArtifactsDir(cwd: string): FileResult {
  const dir = path.join(cwd, ARTIFACTS_DIR_NAME);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    return { path: dir, status: 'created' };
  }
  return { path: dir, status: 'skipped' };
}

function ensureGitignoreEntries(cwd: string): void {
  const gitignorePath = path.join(cwd, '.gitignore');

  let content = '';
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, 'utf-8');
  }

  if (content.includes(REPOVINE_GITIGNORE_ENTRY)) return;

  // Uniform-EOL files get the block appended in their EOL; mixed-EOL files get
  // the LF block, since no single EOL represents them.
  const eol = isUniformEol(content) ? detectEol(content) : '\n';
  fs.appendFileSync(gitignorePath, applyEol(formatRepovineGitignoreBlock(), eol), 'utf-8');
  console.log(formatFileLine('updated', '.gitignore', { note: 'repovine cache entries' }));
}

/**
 * Create missing workspace-level config files and artifacts dir.
 * Used by `setup` and on first MCP server start.
 */
export function ensureWorkspaceBootstrap(cwd: string): FileResult[] {
  const results: FileResult[] = [];
  results.push(
    writeProjectConfigIfMissing(
      path.join(cwd, CONFIG_FILENAME),
      REPOVINE_CONFIG_JSON,
      'existing repovine workspace config preserved',
    ),
  );
  results.push(
    writeProjectConfigIfMissing(
      path.join(cwd, DOMAINS_CONFIG_FILENAME),
      REPOVINE_DOMAINS_JSON,
      'existing repovine domains config preserved',
    ),
  );
  results.push(ensureArtifactsDir(cwd));
  const annotationsPath = path.join(cwd, ANNOTATIONS_FILENAME);
  if (ensureEmptyAnnotationsFile(cwd, ANNOTATIONS_FILENAME)) {
    results.push({ path: annotationsPath, status: 'created' });
  } else {
    results.push({
      path: annotationsPath,
      status: 'skipped',
      message: 'existing annotations preserved',
    });
  }
  ensureGitignoreEntries(cwd);
  return results;
}

export function initCursor(cwd: string, opts: InitOptions): FileResult[] {
  const results = ensureWorkspaceBootstrap(cwd);
  const launcher = opts.mcpLauncher ?? NPX_LAUNCHER;
  results.push(
    writeMcpJsonConfig(
      path.join(cwd, '.cursor', 'mcp.json'),
      'mcpServers',
      buildCursorMcpServer(launcher),
      buildCursorMcpJson(launcher),
      opts.replaceMcp,
      opts.confirmExistingWrite,
    ),
  );
  results.push(...writeProjectedAgentAssets(cwd, 'cursor', opts.forceBootstrap));
  results.push(...writeCursorSkills(cwd, opts.forceBootstrap));
  results.push(...writeCursorRules(cwd, opts.forceBootstrap));
  results.push(...writeCursorHooks(cwd, opts.forceBootstrap));
  return results;
}

export function initClaude(cwd: string, opts: InitOptions): FileResult[] {
  const results = ensureWorkspaceBootstrap(cwd);
  const launcher = opts.mcpLauncher ?? NPX_LAUNCHER;
  results.push(
    writeMcpJsonConfig(
      path.join(cwd, '.mcp.json'),
      'mcpServers',
      buildClaudeMcpServer(launcher),
      buildClaudeMcpJson(launcher),
      opts.replaceMcp,
      opts.confirmExistingWrite,
    ),
  );
  results.push(writeAgentsMd(cwd, opts.forceBootstrap));
  results.push(
    writeFileIfNotExists(
      path.join(cwd, 'CLAUDE.md'),
      CLAUDE_MD,
      opts.forceBootstrap,
    ),
  );
  results.push(...writeProjectedAgentAssets(cwd, 'claude', opts.forceBootstrap));
  results.push(...writeClaudeSkills(cwd, opts.forceBootstrap));
  results.push(...writeClaudeHooks(cwd, opts.forceBootstrap));
  results.push(writeClaudeSettingsHooks(cwd));
  return results;
}

export function initCodex(cwd: string, opts: InitOptions): FileResult[] {
  const results = ensureWorkspaceBootstrap(cwd);
  const launcher = opts.mcpLauncher ?? NPX_LAUNCHER;
  results.push(
    writeCodexMcpConfig(
      path.join(cwd, '.codex', 'config.toml'),
      buildCodexMcpServerBlock(launcher),
      buildCodexConfigToml(launcher),
      opts.replaceMcp,
      CODEX_HOOKS_BLOCK,
      opts.confirmExistingWrite,
    ),
  );
  results.push(...writeCodexHooks(cwd, opts.forceBootstrap));
  results.push(...writeProjectedAgentAssets(cwd, 'codex', opts.forceBootstrap));
  results.push(...writeCodexSkills(cwd, opts.forceBootstrap));
  results.push(writeAgentsMd(cwd, opts.forceBootstrap));
  return results;
}

export function initAll(cwd: string, opts: InitOptions): FileResult[] {
  const results = ensureWorkspaceBootstrap(cwd);
  const launcher = opts.mcpLauncher ?? NPX_LAUNCHER;
  results.push(
    writeMcpJsonConfig(
      path.join(cwd, '.cursor', 'mcp.json'),
      'mcpServers',
      buildCursorMcpServer(launcher),
      buildCursorMcpJson(launcher),
      opts.replaceMcp,
      opts.confirmExistingWrite,
    ),
  );
  results.push(...writeProjectedAgentAssets(cwd, 'cursor', opts.forceBootstrap));
  results.push(...writeCursorSkills(cwd, opts.forceBootstrap));
  results.push(...writeCursorRules(cwd, opts.forceBootstrap));
  results.push(...writeCursorHooks(cwd, opts.forceBootstrap));
  results.push(
    writeMcpJsonConfig(
      path.join(cwd, '.mcp.json'),
      'mcpServers',
      buildClaudeMcpServer(launcher),
      buildClaudeMcpJson(launcher),
      opts.replaceMcp,
      opts.confirmExistingWrite,
    ),
  );
  results.push(writeAgentsMd(cwd, opts.forceBootstrap));
  results.push(
    writeFileIfNotExists(
      path.join(cwd, 'CLAUDE.md'),
      CLAUDE_MD,
      opts.forceBootstrap,
    ),
  );
  results.push(...writeProjectedAgentAssets(cwd, 'claude', opts.forceBootstrap));
  results.push(...writeClaudeSkills(cwd, opts.forceBootstrap));
  results.push(...writeClaudeHooks(cwd, opts.forceBootstrap));
  results.push(writeClaudeSettingsHooks(cwd));
  results.push(
    writeCodexMcpConfig(
      path.join(cwd, '.codex', 'config.toml'),
      buildCodexMcpServerBlock(launcher),
      buildCodexConfigToml(launcher),
      opts.replaceMcp,
      CODEX_HOOKS_BLOCK,
      opts.confirmExistingWrite,
    ),
  );
  results.push(...writeCodexHooks(cwd, opts.forceBootstrap));
  results.push(...writeProjectedAgentAssets(cwd, 'codex', opts.forceBootstrap));
  results.push(...writeCodexSkills(cwd, opts.forceBootstrap));
  return results;
}

/** Print what setup will do to each MCP config before writing. */
export function printSetupPreflight(cwd: string, target: ClientTarget, replaceMcp: boolean, autoBuild = false): void {
  console.log(`${cli.bold('MCP config plan:')}\n`);

  const lines: string[] = [];

  if (target === 'cursor' || target === 'all') {
    const p = path.join(cwd, '.cursor', 'mcp.json');
    const inspect = inspectMcpJsonConfig(p);
    const plan = resolveMcpJsonWritePlan(inspect, replaceMcp);
    lines.push(formatMcpPreflight('Cursor', p, inspect, plan));
  }

  if (target === 'claude' || target === 'all') {
    const p = path.join(cwd, '.mcp.json');
    const inspect = inspectMcpJsonConfig(p);
    const plan = resolveMcpJsonWritePlan(inspect, replaceMcp);
    lines.push(formatMcpPreflight('Claude', p, inspect, plan));
  }

  if (target === 'codex' || target === 'all') {
    const p = path.join(cwd, '.codex', 'config.toml');
    const inspect = inspectCodexMcpConfig(p);
    const plan = resolveCodexWritePlan(inspect, replaceMcp);
    lines.push(formatMcpPreflight('Codex', p, inspect, plan));
  }

  for (const line of lines) {
    console.log(styleMcpPreflight(line));
  }
  console.log('');
  console.log(cli.bold('Workspace support:'));
  for (const line of formatWorkspaceSupportLines(formatWorkspaceSupportPreflight(inspectWorkspaceSupport(cwd), { autoBuild }))) {
    console.log(`  ${line}`);
  }
  console.log('');
}

const INIT_RESULT_GROUPS: Array<{ label: string; status: ConfigWriteStatus; tone: FileResultTone }> = [
  { label: 'Created:', status: 'created', tone: 'created' },
  { label: 'Merged (added repovine):', status: 'merged', tone: 'merged' },
  { label: 'Overwritten (--force):', status: 'overwritten', tone: 'overwritten' },
  { label: 'Removed:', status: 'removed', tone: 'removed' },
  { label: 'Skipped:', status: 'skipped', tone: 'skipped' },
  { label: 'Errors:', status: 'error', tone: 'error' },
];

function printResultGroup(
  cwd: string,
  label: string,
  results: FileResult[],
  status: ConfigWriteStatus,
  tone: FileResultTone,
): void {
  const group = results.filter(r => r.status === status);
  if (group.length === 0) return;
  console.log(formatGroupLabel(label, tone));
  for (const r of group) {
    const rel = path.relative(cwd, r.path);
    console.log(formatFileLine(tone, rel, {
      backup: r.backupPath ? path.relative(cwd, r.backupPath) : undefined,
      note: r.message,
    }));
  }
}

/** Workspace-only setup (plugin mode): the marketplace plugin owns client assets. */
export function runWorkspaceBootstrap(cwd: string, invocationCwd = cwd, opts?: { autoBuild?: boolean }): void {
  // The caller builds right after this returns unless --no-build; the preflight blurb and the
  // next steps must describe that same run, not a generic one.
  const autoBuild = opts?.autoBuild ?? false;
  const workspaceNote = path.resolve(cwd) !== path.resolve(invocationCwd)
    ? `Workspace root: ${cwd}`
    : undefined;
  console.log(`\n${cli.bold('repovine setup')}${workspaceNote ? `\n${cli.dim(workspaceNote)}` : ''}\n`);
  console.log(cli.bold('Workspace support:'));
  for (const line of formatWorkspaceSupportLines(formatWorkspaceSupportPreflight(inspectWorkspaceSupport(cwd), { autoBuild }))) {
    console.log(`  ${line}`);
  }
  console.log('');

  const results = ensureWorkspaceBootstrap(cwd);
  for (const group of INIT_RESULT_GROUPS) {
    printResultGroup(cwd, group.label, results, group.status, group.tone);
  }

  console.log(`\n${cli.bold('Next steps:')}`);
  console.log(styleNextStepLine('  1. Install or enable the repovine marketplace plugin for your client if it is not installed yet.'));
  console.log(styleNextStepLine(autoBuild
    ? '  2. The graph builds now as part of setup (pass --no-build to defer to first MCP start).'
    : '  2. The graph builds on the first MCP start (--no-build was passed).'));
  console.log(cli.dim('     To rebuild later: `repovine build`, or ask your agent to use the repovine-refresh skill.'));
  console.log(cli.dim(`  Commit ${CONFIG_FILENAME}, ${DOMAINS_CONFIG_FILENAME}, and ${ANNOTATIONS_FILENAME}.`));
  console.log('');
}

function promptYesNo(question: string): boolean {
  const answer = promptLineSync(
    `${question} [y/N] `,
    'Interactive setup requires a TTY. Rerun without --interactive or pass explicit flags.',
  ).toLowerCase();
  return answer === 'y' || answer === 'yes';
}

function makeInteractiveConfirm(cwd: string): (proposal: InitExistingWriteProposal) => boolean {
  return (proposal) => {
    const relPath = path.relative(cwd, proposal.path) || '.';
    const backup = proposal.backupPlanned ? 'backup .bak will be written' : 'no backup';
    const detail = proposal.message ? ` — ${proposal.message}` : '';
    return promptYesNo(`Update ${relPath}? (${proposal.action}, ${backup})${detail}`);
  };
}

/**
 * Decide how generated MCP configs should launch the engine.
 *
 * Self-dogfood — a contributor running their own built `dist/` from the repovine
 * source repo — wires the MCP at that exact local entry, so the MCP exercises their
 * checkout instead of silently pulling the published version. Everything else
 * (consumers, including a `node_modules` install) gets the published npx launcher.
 * `forcePublished` (setup --published) forces npx even from the source repo, e.g. to
 * validate a release.
 *
 * Signal = "which engine ran setup": the running entry lives inside repoRoot and not
 * under a `node_modules/` segment ⇒ it is the source checkout, not an install.
 */
export function resolveMcpLauncher(
  repoRoot: string,
  engineEntry: string,
  options: { forcePublished?: boolean; nodePath?: string } = {},
): McpLauncher {
  if (options.forcePublished) return NPX_LAUNCHER;
  const entry = path.resolve(engineEntry);
  const rel = path.relative(path.resolve(repoRoot), entry);
  const insideRepo = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  const viaNodeModules = normalizeRelPath(rel).split('/').includes('node_modules');
  if (!insideRepo || viaNodeModules) return NPX_LAUNCHER;
  return { command: options.nodePath ?? process.execPath, args: [entry] };
}

export function runSetup(
  target: ClientTarget,
  cwd: string,
  options: InitOptions,
  invocationCwd = cwd,
): void {
  const opts: InitOptions = {
    ...options,
    ...(options.interactive && !options.confirmExistingWrite
      ? { confirmExistingWrite: makeInteractiveConfirm(cwd) }
      : {}),
    ...(options.interactive && options.backupGeneratedAssets === undefined
      ? { backupGeneratedAssets: true }
      : {}),
  };

  const initFns: Record<ClientTarget, (cwd: string, opts: InitOptions) => FileResult[]> = {
    cursor: initCursor,
    claude: initClaude,
    codex: initCodex,
    all: initAll,
  };

  const fn = initFns[target];
  if (!fn) {
    console.error(`Unknown setup client: ${target}`);
    console.error(`Valid targets: cursor, claude, codex, all`);
    process.exit(1);
  }

  const workspaceNote = path.resolve(cwd) !== path.resolve(invocationCwd)
    ? `Workspace root: ${cwd}`
    : undefined;
  console.log(`\n${formatSetupTitle(target, workspaceNote)}\n`);
  printSetupPreflight(cwd, target, opts.replaceMcp, opts.autoBuild ?? false);

  const previousInitOptions = activeInitOptions;
  activeInitOptions = opts;
  let results: FileResult[];
  try {
    results = fn(cwd, opts);
  } finally {
    activeInitOptions = previousInitOptions;
  }

  for (const group of INIT_RESULT_GROUPS) {
    printResultGroup(cwd, group.label, results, group.status, group.tone);
  }
}

export function printSetupNextSteps(target: ClientTarget, options: { noBuild?: boolean; domainsAdvisor?: DomainsAdvisorCliResult } = {}): void {
  const { noBuild = false, domainsAdvisor } = options;
  const skillList = 'repovine-annotations, repovine-refresh, repovine-review, repovine-status, repovine-workflow';
  console.log(`\n${cli.bold('Next steps:')}`);
  // Pending (non-applied, non-declined) domains suggestions become the LAST step of each
  // client block below, phrased in that client's voice. No cache paths — the suggestions are
  // already in the graph; the agent fetches them on request.
  const domainsAdvisorPendingCount = domainsAdvisor?.pendingCount ?? domainsAdvisor?.count ?? 0;
  const showDomainsAdvisor = domainsAdvisorPendingCount > 0;
  if (target === 'claude' || target === 'all') {
    let step = 1;
    console.log(`  ${cli.bold('Claude Code')}`);
    console.log(styleNextStepLine(`    ${step++}. Open Claude Code at the workspace root — it reads .mcp.json, CLAUDE.md, AGENTS.md, and .claude/settings.json.`));
    console.log(cli.dim(`       Installed repovine skills: ${skillList}.`));
    if (noBuild) {
      console.log(styleNextStepLine(`    ${step++}. Refresh syntax index:  ask Claude to use the repovine-refresh skill (usually 10-30s).`));
    }
    console.log(styleNextStepLine(`    ${step++}. Initialize annotations: ask Claude to use the repovine-annotations skill.`));
    console.log(cli.dim('       Annotation onboarding depends on repo size and can consume time/context; use smaller batches and consider a less expensive model.'));
    console.log(cli.dim(`       ${INIT_ANNOTATION_QUEUE_HINT}`));
    console.log(styleNextStepLine(`    ${step++}. Check status:  ask Claude to use the repovine-status skill.`));
    if (showDomainsAdvisor) {
      console.log(styleNextStepLine(`    ${step++}. Review domains suggestions:  ${domainsAdvisorPendingCount} ready; ask Claude to review and apply them.`));
    }
    console.log(cli.dim('    Agents available: repovine-annotation-writer (batch), repovine-repo-explorer (navigation), repovine-architecture-auditor (audit), repovine-code-reviewer (review).'));
    console.log(styleNextStepLine(`    Default subagent implementer: @${DEFAULT_PROJECT_SUBAGENT_NAME} (sample.project-subagent.md).`));
    console.log(cli.dim('    Add subagent specialists: copy .claude/agents/_TEMPLATE.project-subagent.md → <role>.md'));
  }
  if (target === 'cursor' || target === 'all') {
    let step = 1;
    console.log(`  ${cli.bold('Cursor')}`);
    console.log(styleNextStepLine(`    ${step++}. Open the project — Cursor reads .cursor/rules, .agents/skills, .cursor/agents, and .cursor/hooks.json.`));
    console.log(cli.dim('       MCP starts from .cursor/mcp.json.'));
    console.log(cli.dim('       Enable the repovine MCP server in Cursor MCP settings manually.'));
    console.log(cli.dim('       The repovine-* entries below are skills in .agents/skills; ask Cursor to use them (or pick them from the skills menu) to call the MCP tools.'));
    console.log(cli.dim(`       Installed repovine skills: ${skillList}.`));
    if (noBuild) {
      console.log(styleNextStepLine(`    ${step++}. Refresh syntax index:  ask Cursor to use the repovine-refresh skill (usually 10-30s).`));
    }
    console.log(styleNextStepLine(`    ${step++}. Initialize annotations: ask Cursor to use the repovine-annotations skill.`));
    console.log(cli.dim('       Annotation onboarding depends on repo size and can consume time/context; use smaller batches and consider a less expensive model.'));
    console.log(cli.dim(`       ${INIT_ANNOTATION_QUEUE_HINT}`));
    console.log(styleNextStepLine(`    ${step++}. Check status:  ask Cursor to use the repovine-status skill.`));
    if (showDomainsAdvisor) {
      console.log(styleNextStepLine(`    ${step++}. Review domains suggestions:  ${domainsAdvisorPendingCount} ready; ask Cursor to review and apply them.`));
    }
    console.log(cli.dim('    Agents available: repovine-annotation-writer (batch), repovine-repo-explorer (navigation), repovine-architecture-auditor (audit), repovine-code-reviewer (review).'));
    console.log(styleNextStepLine(`    Default subagent implementer: @${DEFAULT_PROJECT_SUBAGENT_NAME} (sample.project-subagent.md).`));
    console.log(cli.dim('    Add subagent specialists: copy .cursor/agents/_TEMPLATE.project-subagent.md → <role>.md'));
  }
  if (target === 'codex' || target === 'all') {
    console.log(`  ${cli.bold('Codex')}`);
    console.log(styleNextStepLine('    1. Open Codex at the workspace root — it reads .codex/config.toml, .codex/hooks/, .codex/agents/, .agents/skills/, and AGENTS.md.'));
    console.log(cli.dim(`       Installed repovine skills: ${skillList}.`));
    console.log(styleNextStepLine('    2. Codex does not have project-scoped slash commands. Ask Codex to use the named skills:'));
    if (noBuild) {
      console.log(styleNextStepLine('         "Use the repovine-refresh skill to refresh the syntax index for this repo." (usually 10-30s)'));
    }
    console.log(styleNextStepLine('         "Use the repovine-annotations skill to initialize annotations."'));
    console.log(cli.dim('           Annotation onboarding depends on repo size and can consume time/context; use smaller batches and consider a less expensive model.'));
    console.log(cli.dim(`           ${INIT_ANNOTATION_QUEUE_HINT}`));
    console.log(styleNextStepLine('         "Use the repovine-status skill to check status."'));
    if (showDomainsAdvisor) {
      console.log(styleNextStepLine(`         "Review and apply the ${domainsAdvisorPendingCount} domains suggestion(s) for this repo."`));
    }
    console.log(cli.dim('    Agents available: repovine-annotation-writer (batch), repovine-repo-explorer (navigation), repovine-architecture-auditor (audit), repovine-code-reviewer (review).'));
    console.log(styleNextStepLine(`    Default subagent implementer: ${DEFAULT_PROJECT_SUBAGENT_NAME} (sample.project-subagent.toml).`));
    console.log(cli.dim('    Add subagent specialists: copy .codex/agents/_TEMPLATE.project-subagent.toml → <role>.toml'));
  }
  console.log('');
  console.log(cli.dim(`Commit ${CONFIG_FILENAME}, ${DOMAINS_CONFIG_FILENAME}, and ${ANNOTATIONS_FILENAME}.`));
  console.log('');
}
