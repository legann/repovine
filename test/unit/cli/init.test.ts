/**
 * Tests for setup workspace bootstrap.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ANNOTATIONS_FILENAME, ARTIFACTS_DIR_NAME, DOMAINS_CONFIG_FILENAME } from '../../../src/paths.js';
import { CONFIG_FILENAME } from '../../../src/config.js';
import {
  initCursor,
  initClaude,
  initCodex,
  initAll,
  runSetup,
  printSetupNextSteps,
  runWorkspaceBootstrap,
  ensureWorkspaceBootstrap,
  inspectWorkspaceSupport,
  formatWorkspaceSupportPreflight,
  totalPackageMarkers,
} from '../../../src/cli/init.js';
import { stripAnsi } from '../../../src/cli/ui.js';
import {
  AGENTS_MD,
  CODEX_HOOKS_BEGIN_MARKER,
  REPOVINE_CONFIG_JSON,
  REPOVINE_DOMAINS_JSON,
} from '../../../src/cli/templates.js';
import { CLIENT_DISPATCHER_FILENAME, readClientDispatcherSource } from '../../../src/cli/dispatcher/index.js';
import { loadConfig } from '../../../src/config.js';
import { loadDomainsConfig } from '../../../src/stage2/domains.js';

const EXPECTED_CURSOR_MCP_SERVER = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', 'repovine'],
  env: { REPOVINE_ROOT: '${workspaceFolder}' },
};

// Every client now ships the identical five-skill surface: annotation
// maintenance, graph lifecycle/status, implementation workflow, and review/audit.
const EXPECTED_SHARED_SKILLS = [
  'repovine-annotations',
  'repovine-refresh',
  'repovine-review',
  'repovine-status',
  'repovine-workflow',
].sort();

const EXPECTED_CLAUDE_SKILLS = EXPECTED_SHARED_SKILLS;
const EXPECTED_CODEX_SKILLS = EXPECTED_SHARED_SKILLS;

describe('ensureWorkspaceBootstrap', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('creates config, domains, annotations, and artifacts dir', () => {
    const results = ensureWorkspaceBootstrap(tmpDir);
    const created = results.filter(r => r.status === 'created').map(r => path.basename(r.path));
    const config = JSON.parse(fs.readFileSync(path.join(tmpDir, CONFIG_FILENAME), 'utf-8'));
    const domains = JSON.parse(fs.readFileSync(path.join(tmpDir, DOMAINS_CONFIG_FILENAME), 'utf-8'));

    expect(fs.existsSync(path.join(tmpDir, CONFIG_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, DOMAINS_CONFIG_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ANNOTATIONS_FILENAME))).toBe(true);
    expect(fs.statSync(path.join(tmpDir, ARTIFACTS_DIR_NAME)).isDirectory()).toBe(true);
    expect(created).toContain(CONFIG_FILENAME);
    expect(created).toContain(DOMAINS_CONFIG_FILENAME);
    expect(created).toContain(ANNOTATIONS_FILENAME);
    expect(config).toEqual({
      build: {
        scan: {
          include: [],
          exclude: [],
        },
        linking: {
          handlers: {
            searchRoots: [],
          },
          bundles: {
            scripts: [],
            autoDetect: true,
          },
          containers: {
            dockerfileRoots: [],
          },
        },
      },
      mcp: {
        verbose: false,
        response: {
          mode: 'concise',
          pretty: false,
        },
      },
      analyze_architecture: {
        strictness: 'normal',
        thresholds: {},
      },
      workspace: {
        annotationsFile: 'repovine.annots.json',
      },
    });
    expect(domains).toEqual({
      domains: {},
      infra: {
        excludeSuffixes: [],
        excludePatterns: [],
      },
      basename: {
        files: {
          include: [],
          exclude: [],
        },
      },
      packages: {
        enabled: true,
        exclude: [],
        rename: {},
        merge: {},
      },
      structuralDirs: [],
    });
    expect(domains).not.toHaveProperty('linking');
  });

  it('init templates parse through config and domains loaders', () => {
    const templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-template-'));
    fs.writeFileSync(path.join(templateDir, CONFIG_FILENAME), REPOVINE_CONFIG_JSON);
    fs.writeFileSync(path.join(templateDir, DOMAINS_CONFIG_FILENAME), REPOVINE_DOMAINS_JSON);

    const config = JSON.parse(REPOVINE_CONFIG_JSON);
    expect(config.build.scan).toEqual({ include: [], exclude: [] });
    expect(config.build.linking.handlers.searchRoots).toEqual([]);
    expect(config.build.linking.bundles.autoDetect).toBe(true);
    expect(config.mcp.response.mode).toBe('concise');
    expect(config).not.toHaveProperty('buildOutputScripts');

    const domains = JSON.parse(REPOVINE_DOMAINS_JSON);
    expect(domains).not.toHaveProperty('linking');

    expect(loadConfig(templateDir).build.linking.containers.dockerfileRoots).toEqual([]);
    expect(loadDomainsConfig(templateDir)).not.toHaveProperty('linking');

    fs.rmSync(templateDir, { recursive: true, force: true });
  });

  it('keeps the domains advisor contract in the shared session hint (dispatcher source)', () => {
    // One dispatcher serves every client, so the contract text lives once.
    const hint = readClientDispatcherSource();
    expect(hint).toContain('never auto-apply');
    expect(hint).toContain('for skip/hide, call decline_advisory');
    expect(hint).toContain('domains-config');
    expect(hint).toContain('.repovine/onboarding-state.json');
    expect(hint).not.toContain('present the additive diff');
    expect(hint).not.toContain('record declined items');
  });

  it('skips existing files without force', () => {
    ensureWorkspaceBootstrap(tmpDir);
    const second = ensureWorkspaceBootstrap(tmpDir);
    expect(second).toHaveLength(4);
    expect(second.map(r => path.basename(r.path)).sort()).toEqual(
      [ANNOTATIONS_FILENAME, ARTIFACTS_DIR_NAME, CONFIG_FILENAME, DOMAINS_CONFIG_FILENAME].sort(),
    );
    expect(second.map(r => r.status)).toEqual(['skipped', 'skipped', 'skipped', 'skipped']);
  });

  it('preserves existing config and domains files during workspace bootstrap', () => {
    const configPath = path.join(tmpDir, CONFIG_FILENAME);
    const domainsPath = path.join(tmpDir, DOMAINS_CONFIG_FILENAME);
    fs.writeFileSync(configPath, '{"custom":true}\n');
    fs.writeFileSync(domainsPath, '{"domains":{"auth":["src/auth/**"]}}\n');

    const results = ensureWorkspaceBootstrap(tmpDir);

    expect(fs.readFileSync(configPath, 'utf-8')).toBe('{"custom":true}\n');
    expect(fs.readFileSync(domainsPath, 'utf-8')).toBe('{"domains":{"auth":["src/auth/**"]}}\n');
    expect(results).toContainEqual(expect.objectContaining({
      path: configPath,
      status: 'skipped',
      message: 'existing repovine workspace config preserved',
    }));
    expect(results).toContainEqual(expect.objectContaining({
      path: domainsPath,
      status: 'skipped',
      message: 'existing repovine domains config preserved',
    }));
  });

  it('runWorkspaceBootstrap creates only workspace config/cache files', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    runWorkspaceBootstrap(tmpDir, tmpDir, { autoBuild: true });

    expect(fs.existsSync(path.join(tmpDir, CONFIG_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, DOMAINS_CONFIG_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ARTIFACTS_DIR_NAME))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cursor'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.codex'))).toBe(false);

    const output = stripAnsi(log.mock.calls.map(args => args.join(' ')).join('\n'));
    expect(output).toContain('repovine setup');
    expect(output).toContain('Install or enable the repovine marketplace plugin');
  });

  // `npx repovine setup` (no client) is the command every plugin INSTALL.md prints, and it builds
  // by default. The preflight blurb and the next steps must describe that run, not a generic one.
  it.each([
    { autoBuild: true, says: 'The graph builds now as part of setup', omits: 'builds on the first MCP start' },
    { autoBuild: false, says: 'The graph builds on the first MCP start', omits: 'builds now as part of setup' },
  ])('runWorkspaceBootstrap reports the build it actually runs (autoBuild=$autoBuild)', ({ autoBuild, says, omits }) => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    runWorkspaceBootstrap(tmpDir, tmpDir, { autoBuild });

    const output = stripAnsi(log.mock.calls.map(args => args.join(' ')).join('\n'));
    expect(output).toContain(says);
    expect(output).not.toContain(omits);
    expect(output).not.toContain('--build` to build now'); // setup has no --build flag
  });
});

describe('runSetup next steps', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-next-steps-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('omits syntax-index guidance when the graph was built during init', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    runSetup('all', tmpDir, { forceBootstrap: false, replaceMcp: false });
    printSetupNextSteps('all', { noBuild: false });

    const output = stripAnsi(log.mock.calls.map(args => args.join(' ')).join('\n'));
    expect(output).not.toContain('Refresh syntax index:  ask Claude to use the repovine-refresh skill (usually 10-30s).');
    expect(output).not.toContain('Refresh syntax index:  ask Cursor to use the repovine-refresh skill (usually 10-30s).');
    expect(output).not.toContain('"Use the repovine-refresh skill to refresh the syntax index for this repo." (usually 10-30s)');
    expect(output).toContain('Initialize annotations: ask Cursor to use the repovine-annotations skill.');
    expect(output).toContain('Continue queue batches until needsWork 0');
    expect(output).toContain('content-stale before propagation-stale');
    expect(output).toContain('Check status:  ask Cursor to use the repovine-status skill.');
    expect(output).toContain('Installed repovine skills: repovine-annotations, repovine-refresh, repovine-review, repovine-status, repovine-workflow.');
    expect(output).toContain('2. Initialize annotations: ask Claude to use the repovine-annotations skill.');
    expect(output).toContain('3. Check status:  ask Claude to use the repovine-status skill.');
  });

  it('includes syntax-index guidance when init used --no-build', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    runSetup('all', tmpDir, { forceBootstrap: false, replaceMcp: false, autoBuild: false });
    printSetupNextSteps('all', { noBuild: true });

    const output = stripAnsi(log.mock.calls.map(args => args.join(' ')).join('\n'));
    expect(output).toContain('Refresh syntax index:  ask Claude to use the repovine-refresh skill (usually 10-30s).');
    expect(output).toContain('Refresh syntax index:  ask Cursor to use the repovine-refresh skill (usually 10-30s).');
    expect(output).toContain('"Use the repovine-refresh skill to refresh the syntax index for this repo." (usually 10-30s)');
    expect(output).toContain('Initialize annotations: ask Cursor to use the repovine-annotations skill.');
    expect(output).toContain('Annotation onboarding depends on repo size and can consume time/context; use smaller batches and consider a less expensive model.');
    expect(output).toContain('Check status:  ask Cursor to use the repovine-status skill.');
    expect(output).toContain('Installed repovine skills: repovine-annotations, repovine-refresh, repovine-review, repovine-status, repovine-workflow.');
    expect(output).toContain('Codex does not have project-scoped slash commands');
    expect(output).not.toContain('Use the repovine-refresh skill to rebuild the graph.');
  });
});

describe('initCursor', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-cursor-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates .cursor/mcp.json and workspace files', () => {
    const results = initCursor(tmpDir, { forceBootstrap: false, replaceMcp: false });
    const created = results.filter(r => r.status === 'created').map(r => path.relative(tmpDir, r.path));

    expect(created).toContain(path.join('.cursor', 'mcp.json'));
    expect(created).toContain(CONFIG_FILENAME);
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'mcp.json'))).toBe(true);

    const mcp = JSON.parse(fs.readFileSync(path.join(tmpDir, '.cursor', 'mcp.json'), 'utf-8'));
    expect(mcp.mcpServers['repovine']).toEqual(EXPECTED_CURSOR_MCP_SERVER);
  });

  it('merges repovine into existing .cursor/mcp.json', () => {
    const mcpPath = path.join(tmpDir, '.cursor', 'mcp.json');
    fs.mkdirSync(path.join(tmpDir, '.cursor'), { recursive: true });
    fs.writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          playwright: { command: 'npx', args: ['@playwright/mcp'] },
        },
      }, null, 2),
    );

    const results = initCursor(tmpDir, { forceBootstrap: false, replaceMcp: false });
    expect(results.some(r => r.path === mcpPath && r.status === 'merged')).toBe(true);

    const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    expect(mcp.mcpServers.playwright).toEqual({ command: 'npx', args: ['@playwright/mcp'] });
    expect(mcp.mcpServers['repovine']).toEqual(EXPECTED_CURSOR_MCP_SERVER);
  });

  it('writes Cursor project capabilities', () => {
    initCursor(tmpDir, { forceBootstrap: false, replaceMcp: false });

    // Cursor no longer gets slash commands; build/lifecycle workflows ship as skills.
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'commands'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-annotations', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-refresh', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-review', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-status', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'agents', 'repovine-annotation-writer.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'agents', 'repovine-architecture-auditor.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'agents', 'repovine-code-reviewer.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-workflow', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-backend-development', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'skills', 'repovine-explore', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'rules', 'repovine-policy.mdc'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'hooks', CLIENT_DISPATCHER_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'hooks.json'))).toBe(true);
  });

  it('merges Cursor hooks without duplicating repeated init', () => {
    initCursor(tmpDir, { forceBootstrap: false, replaceMcp: false });
    initCursor(tmpDir, { forceBootstrap: false, replaceMcp: false });

    const hooks = JSON.parse(fs.readFileSync(path.join(tmpDir, '.cursor', 'hooks.json'), 'utf-8'));
    expect(hooks.version).toBe(1);
    expect(hooks.hooks.afterFileEdit).toHaveLength(1);
    expect(hooks.hooks.afterShellExecution).toHaveLength(1);
    expect(hooks.hooks.sessionStart).toHaveLength(1);
    expect(hooks.hooks.afterFileEdit[0].command).toContain('hooks/repovine-client-dispatcher.mjs" stale-graph-notice cursor');
  });

});

describe('workspace support preflight', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-support-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports a marker-bearing project with and without IaC infra', () => {
    // `tsconfig.json` is named here because the TypeScript plugin declares it, and the preflight
    // reports the plugin that claimed the marker rather than a language it spells itself.
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');
    const tsOnly = formatWorkspaceSupportPreflight(inspectWorkspaceSupport(tmpDir));
    expect(tsOnly).toContain('Detected typescript (1 package(s))');
    expect(tsOnly).not.toContain('with IaC infra');

    fs.writeFileSync(path.join(tmpDir, 'main.tf'), 'resource "aws_s3_bucket" "bucket" {}\n');
    expect(formatWorkspaceSupportPreflight(inspectWorkspaceSupport(tmpDir))).toContain('with IaC infra');
  });

  it('recommends setup for larger repositories', () => {
    const message = formatWorkspaceSupportPreflight({
      packagesByPlugin: { typescript: 650 },
      hasIaC: true,
      hasUnsupportedSignals: false,
      hasProjectSignals: true,
    });

    expect(message).toContain('repovine setup');
    expect(message).not.toContain('repovine init');
  });

  it('says setup builds automatically when autoBuild is set', () => {
    const inspection = {
      packagesByPlugin: { typescript: 650 },
      hasIaC: true,
      hasUnsupportedSignals: false,
      hasProjectSignals: true,
    };

    const message = formatWorkspaceSupportPreflight(inspection, { autoBuild: true });
    expect(message).toContain('builds now as part of setup');
    expect(message).toContain('--no-build');
    expect(message).not.toContain('Recommended:');

    // No-opts path keeps the opt-in recommendation.
    expect(formatWorkspaceSupportPreflight(inspection)).toContain('repovine setup');
  });

  it('distinguishes empty workspaces from marker-bearing and infra-only projects', () => {
    expect(formatWorkspaceSupportPreflight(inspectWorkspaceSupport(tmpDir))).toBe('No supported files found yet.');

    // `pyproject.toml` is a marker the Python plugin declares, so the preflight counts it under that
    // plugin without the engine knowing what Python is.
    fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "demo"\n');
    expect(formatWorkspaceSupportPreflight(inspectWorkspaceSupport(tmpDir))).toContain('python (1 package(s))');

    fs.unlinkSync(path.join(tmpDir, 'pyproject.toml'));
    fs.writeFileSync(path.join(tmpDir, 'template.yaml'), 'Resources: {}\n');
    expect(formatWorkspaceSupportPreflight(inspectWorkspaceSupport(tmpDir))).toContain('infra-only graph');
  });

  it('treats source with no package marker as a project no loaded plugin owns', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const ok = true;\n');

    const message = formatWorkspaceSupportPreflight(inspectWorkspaceSupport(tmpDir));
    expect(message).toContain('no loaded plugin owns');
    // The message names what it looked for, and it looked for what the loaded set declared.
    expect(message).toContain('tsconfig.json');
    expect(message).toContain('pyproject.toml');
  });

  it('counts a package marker under the plugin that declared it, not under a spelled-out language', () => {
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "demo"\n');

    const inspection = inspectWorkspaceSupport(tmpDir);

    expect(inspection.packagesByPlugin).toEqual({ typescript: 1, python: 1 });
    expect(totalPackageMarkers(inspection)).toBe(2);
  });
});

describe('initClaude', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-claude-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes AGENTS.md with the new public-tool workflow and CLAUDE.md pointer', () => {
    initClaude(tmpDir, { forceBootstrap: false, replaceMcp: false });
    const agents = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(agents).toBe(AGENTS_MD);
    expect(agents).toContain('search_context');
    expect(agents).toContain('map_context');
    expect(agents).toContain('refresh_context({ "reloadConfig": true })');
    expect(agents).toContain('.claude/skills/*/SKILL.md');
    expect(agents).not.toContain('## Annotation onboarding');
    const claude = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(claude).toContain('@AGENTS.md');
    expect(claude).toContain('Thin repovine bootstrap');
  });

  it('writes Claude hooks into .claude/settings.json and .claude/hooks', () => {
    initClaude(tmpDir, { forceBootstrap: false, replaceMcp: false });

    expect(fs.existsSync(path.join(tmpDir, '.claude', 'hooks', CLIENT_DISPATCHER_FILENAME))).toBe(true);

    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf-8'),
    );
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    // Exec form: command + args, no shell field.
    expect(settings.hooks.PostToolUse[0].hooks[0]).toEqual({
      type: 'command',
      command: 'node',
      args: ['${CLAUDE_PROJECT_DIR}/.claude/hooks/repovine-client-dispatcher.mjs', 'stale-graph-notice', 'claude'],
    });
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].args).toEqual(
      ['${CLAUDE_PROJECT_DIR}/.claude/hooks/repovine-client-dispatcher.mjs', 'session-mcp-hint', 'claude'],
    );
    expect(settings.hooks.SessionStart[0].hooks[0].shell).toBeUndefined();
    expect(settings.permissions).toBeUndefined();
  });

  it('keeps repeated Claude hook init idempotent and preserves unrelated settings', () => {
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: { allow: ['Bash(echo ok)'] },
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: 'command', command: 'node ./other-hook.js' },
              ],
            },
          ],
        },
      }, null, 2),
    );

    initClaude(tmpDir, { forceBootstrap: false, replaceMcp: false });
    initClaude(tmpDir, { forceBootstrap: false, replaceMcp: false });

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.permissions.allow).toEqual(['Bash(echo ok)']);
    expect(JSON.stringify(settings.permissions)).not.toContain('repovine');
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.SessionStart).toHaveLength(2);
    const sessionHooks = settings.hooks.SessionStart.flatMap(
      (entry: { hooks: Array<{ command: string; args?: string[] }> }) => entry.hooks,
    );
    expect(sessionHooks.filter(
      (hook: { args?: string[] }) => hook.args?.[0]?.includes('repovine-client-dispatcher.mjs'),
    )).toHaveLength(1);
    expect(sessionHooks.some((hook: { command: string }) => hook.command === 'node ./other-hook.js')).toBe(true);
  });
});

describe('initCodex', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-codex-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a thin AGENTS.md that points Codex to generated skills and agents', () => {
    initCodex(tmpDir, { forceBootstrap: false, replaceMcp: false });
    const agents = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('This managed block is intentionally short');
    expect(agents).toContain('.codex/agents/*.toml');
    expect(agents).toContain('.agents/skills/*/SKILL.md');
    expect(agents).toContain('refresh_context({ "reloadConfig": true })');
    expect(agents).not.toContain('Context budget');
    expect(agents).not.toContain('## Annotation onboarding');
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'config.toml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'hooks', CLIENT_DISPATCHER_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'agents', 'repovine-annotation-writer.toml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'agents', 'repovine-repo-explorer.toml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'agents', 'repovine-architecture-auditor.toml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'agents', 'repovine-code-reviewer.toml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-annotations', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-review', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-workflow', 'SKILL.md'))).toBe(true);
  });

  it('writes project subagent scaffold for Codex (TOML)', () => {
    initCodex(tmpDir, { forceBootstrap: false, replaceMcp: false });

    const samplePath = path.join(tmpDir, '.codex', 'agents', 'sample.project-subagent.toml');
    const templatePath = path.join(tmpDir, '.codex', 'agents', '_TEMPLATE.project-subagent.toml');
    expect(fs.existsSync(samplePath)).toBe(true);
    expect(fs.existsSync(templatePath)).toBe(true);

    const sample = fs.readFileSync(samplePath, 'utf-8');
    expect(sample).toContain('name = "project-subagent-sample"');
    expect(sample).toContain('developer_instructions');

    const template = fs.readFileSync(templatePath, 'utf-8');
    expect(template).toContain('name = "{{agent-name}}"');
    expect(template).toContain('{{agent-name}}');

    const agents = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('Codex uses `.codex/agents/*.toml`');
    expect(agents).toContain('repovine-workflow');
  });

  it('does NOT write .codex/commands — Codex has no project-scoped slash commands', () => {
    initCodex(tmpDir, { forceBootstrap: false, replaceMcp: false });
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'commands'))).toBe(false);
  });

  it('keeps annotation onboarding details in the Codex skill instead of AGENTS.md', () => {
    initCodex(tmpDir, { forceBootstrap: false, replaceMcp: false });
    const agents = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('repovine-annotations');
    expect(agents).not.toContain('## Annotation onboarding');
    expect(agents).not.toContain('tokens / annotation');
    const annotationsSkill = fs.readFileSync(
      path.join(tmpDir, '.agents', 'skills', 'repovine-annotations', 'SKILL.md'),
      'utf-8',
    );
    expect(annotationsSkill).toContain('get_annotation_status');
    expect(annotationsSkill).toContain('tokens / annotation');
  });

  it('updates previously generated AGENTS.md to the current tool names', () => {
    const agentsPath = path.join(tmpDir, 'AGENTS.md');
    fs.writeFileSync(
      agentsPath,
      '# repovine — quick reference\n\nCall `get_domain_or_focus_context` first.\n',
    );

    initCodex(tmpDir, { forceBootstrap: false, replaceMcp: false });

    const agents = fs.readFileSync(agentsPath, 'utf-8');
    expect(agents).toContain('search_context');
    expect(agents).toContain('map_context');
    expect(agents).toContain('inspect_node');
    expect(agents).not.toContain('get_domain_or_focus_context');
    expect(fs.existsSync(`${agentsPath}.bak`)).toBe(true);
  });

  it('writes Codex hooks once and keeps repeated init idempotent', () => {
    initCodex(tmpDir, { forceBootstrap: false, replaceMcp: false });
    initCodex(tmpDir, { forceBootstrap: false, replaceMcp: false });

    const config = fs.readFileSync(path.join(tmpDir, '.codex', 'config.toml'), 'utf-8');
    const markerCount = config.split(CODEX_HOOKS_BEGIN_MARKER).length - 1;
    expect(markerCount).toBe(1);
    expect(config).toContain('.codex/hooks/repovine-client-dispatcher.mjs" stale-graph-notice codex');
    expect(config).toContain('.codex/hooks/repovine-client-dispatcher.mjs" session-mcp-hint codex');
    expect(config).toContain('command_windows = ');
  });

  it('adds Codex hooks when MCP already exists without duplicating the MCP section', () => {
    const configPath = path.join(tmpDir, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      `[mcp_servers.repovine]\ncommand = "npx"\nargs = ["-y", "repovine"]\n`,
    );

    initCodex(tmpDir, { forceBootstrap: false, replaceMcp: false });

    const config = fs.readFileSync(configPath, 'utf-8');
    expect(config.split('[mcp_servers.repovine]').length - 1).toBe(1);
    expect(config.split(CODEX_HOOKS_BEGIN_MARKER).length - 1).toBe(1);
  });

  it('writes Codex custom agents as TOML files', () => {
    initCodex(tmpDir, { forceBootstrap: false, replaceMcp: false });

    const writerAgent = fs.readFileSync(
      path.join(tmpDir, '.codex', 'agents', 'repovine-annotation-writer.toml'),
      'utf-8',
    );
    expect(writerAgent).toContain('name = "repovine-annotation-writer"');
    expect(writerAgent).toContain('description = "Batch annotator');
    expect(writerAgent).toContain('developer_instructions =');
    expect(writerAgent).toContain('write_annotation');
    // Summary-class subagents run cheap on Codex via low reasoning effort.
    expect(writerAgent).toContain('model_reasoning_effort = "low"');
    // Annotations are MCP-owned: never hand-edited.
    expect(writerAgent).toContain('Only ever change `repovine.annots.json` through repovine MCP tools');
    expect(writerAgent).toContain('scope: "consumer"');
    expect(writerAgent).toContain('Importer must verify this at the consumer');
    expect(writerAgent).toContain('scope: "boundary"');
    expect(writerAgent).toContain('Carrier-link authoring');
    expect(writerAgent).toContain('missing-carrier-link');
    expect(writerAgent).toContain('mod:pkg/deep-gate');

    const explorerAgent = fs.readFileSync(
      path.join(tmpDir, '.codex', 'agents', 'repovine-repo-explorer.toml'),
      'utf-8',
    );
    expect(explorerAgent).toContain('name = "repovine-repo-explorer"');
    expect(explorerAgent).toContain('search_context');
    expect(explorerAgent).toContain('analyze_architecture');
    expect(explorerAgent).toContain('model_reasoning_effort = "low"');
  });

  it('writes Codex command workflows and repo skills under .agents/skills', () => {
    initCodex(tmpDir, { forceBootstrap: false, replaceMcp: false });

    const skillNames = fs.readdirSync(path.join(tmpDir, '.agents', 'skills')).sort();
    expect(skillNames).toEqual(EXPECTED_CODEX_SKILLS);

    const workflowSkill = fs.readFileSync(
      path.join(tmpDir, '.agents', 'skills', 'repovine-workflow', 'SKILL.md'),
      'utf-8',
    );
    expect(workflowSkill).toContain('name: repovine-workflow');
    expect(workflowSkill).toContain('Main-agent implementation playbook');
    expect(workflowSkill).toContain('Relationship to Subagent Orchestration');
    expect(workflowSkill).toContain("Use the active client's native agent surface");
    expect(workflowSkill).toContain('You are the **main agent**');
    expect(workflowSkill).not.toContain('Codex: `.codex/agents/*.toml`');
    expect(workflowSkill).toContain('delegate to **project-subagent-sample**');
    expect(workflowSkill).not.toContain('For Codex delegation rules');
    expect(workflowSkill).toContain('Project-specific skills usually belong');
    expect(workflowSkill).toContain('search_context');
    expect(workflowSkill).toContain('annotationMatched');
    expect(workflowSkill).toContain('omits annotation fields');
    expect(workflowSkill).toContain('analyze_dependencies');
    expect(workflowSkill).toContain('name-matched impact candidates');
    expect(workflowSkill).toContain('explicitly code-cite why they are out of scope');
    expect(workflowSkill).toContain('analyze_architecture');
    expect(workflowSkill).toContain('refresh_context');

    const reviewSkill = fs.readFileSync(
      path.join(tmpDir, '.agents', 'skills', 'repovine-review', 'SKILL.md'),
      'utf-8',
    );
    expect(reviewSkill).toContain('name: repovine-review');
    expect(reviewSkill).toContain('Use the managed `repovine-code-reviewer` agent');
    expect(reviewSkill).toContain('repovine-architecture-auditor');
    expect(reviewSkill).toContain('AgentRunResult.review');
    expect(reviewSkill).toContain('architectureAudit');
    expect(reviewSkill).toContain('analyze_dependencies');
    expect(reviewSkill).toContain('detailFindingId');
    expect(reviewSkill).toContain('annotationReasoning');
    expect(reviewSkill).not.toContain('get_refactoring_report');
    expect(reviewSkill).not.toContain('get_refactoring_opportunity_detail');

    const annotationQueue = fs.readFileSync(
      path.join(tmpDir, '.agents', 'skills', 'repovine-annotations', 'SKILL.md'),
      'utf-8',
    );
    expect(annotationQueue).toContain('name: repovine-annotations');
    expect(annotationQueue).toContain('# repovine-annotations');
    expect(annotationQueue).not.toContain('# /repovine-annotations');
    expect(annotationQueue).toContain('Skill inputs');
    expect(annotationQueue).toContain('tokens / annotation');
    expect(annotationQueue).toContain('annotation time');
    expect(annotationQueue).toContain('do not auto-continue without user approval');
    expect(annotationQueue).toContain('scope: "consumer"');
    expect(annotationQueue).toContain('Importer must verify this at the consumer');
    expect(annotationQueue).toContain('scope: "boundary"');
    expect(annotationQueue).toContain('Carrier pair example');
    expect(annotationQueue).toContain('missing-carrier-link');
    expect(annotationQueue).toContain('named-but-undeliverable');
    expect(annotationQueue).toContain('mod:pkg/deep-gate');
    for (const oldName of [
      'repovine-init-annotations',
      'repovine-annotate',
      'repovine-explore',
      'repovine-impact',
      'repovine-analyze-architecture',
      'repovine-code-review',
      'repovine-verify',
    ]) {
      expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', oldName))).toBe(false);
    }
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-backend-development'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-frontend-development'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-iac-development'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-infra-topology'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repo-explore'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'skills'))).toBe(false);
  });

});

describe('initClaude — onboarding distribution', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-claude-onboard-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes managed utility subagents with YAML frontmatter', () => {
    initClaude(tmpDir, { forceBootstrap: false, replaceMcp: false });
    for (const name of ['repovine-annotation-writer', 'repovine-repo-explorer', 'repovine-architecture-auditor', 'repovine-code-reviewer']) {
      const p = path.join(tmpDir, '.claude', 'agents', `${name}.md`);
      expect(fs.existsSync(p)).toBe(true);
      const body = fs.readFileSync(p, 'utf-8');
      expect(body.startsWith('---\n')).toBe(true);
      expect(body).toContain(`name: ${name}`);
      if (name !== 'repovine-code-reviewer') {
        // Summary-class subagents declare the cheap Claude model in frontmatter.
        expect(body).toContain('model: haiku');
      }
    }
  });

  it('writes project subagent scaffold for Claude', () => {
    initClaude(tmpDir, { forceBootstrap: false, replaceMcp: false });

    const samplePath = path.join(tmpDir, '.claude', 'agents', 'sample.project-subagent.md');
    const templatePath = path.join(tmpDir, '.claude', 'agents', '_TEMPLATE.project-subagent.md');
    expect(fs.existsSync(samplePath)).toBe(true);
    expect(fs.existsSync(templatePath)).toBe(true);
    expect(fs.readFileSync(samplePath, 'utf-8')).toContain('name: project-subagent-sample');

    const agentsMd = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('Claude uses `.claude/agents/*.md`');
    expect(agentsMd).toContain('repovine-workflow');
    expect(agentsMd).not.toContain('## Main agent + project subagents');
  });

  it('writes Claude command workflows and project skills under .claude/skills', () => {
    initClaude(tmpDir, { forceBootstrap: false, replaceMcp: false });

    const skillNames = fs.readdirSync(path.join(tmpDir, '.claude', 'skills')).sort();
    expect(skillNames).toEqual(EXPECTED_CLAUDE_SKILLS);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'commands'))).toBe(false);

    const reviewSkill = fs.readFileSync(
      path.join(tmpDir, '.claude', 'skills', 'repovine-review', 'SKILL.md'),
      'utf-8',
    );
    expect(reviewSkill).toContain('name: repovine-review');
    expect(reviewSkill).toContain('description:');
    expect(reviewSkill).toContain('read-only implementation/diff reviews');
    expect(reviewSkill).toContain('repovine-architecture-auditor');
    expect(reviewSkill).toContain('analyze_architecture');

    const annotationQueue = fs.readFileSync(
      path.join(tmpDir, '.claude', 'skills', 'repovine-annotations', 'SKILL.md'),
      'utf-8',
    );
    expect(annotationQueue).toContain('name: repovine-annotations');
    expect(annotationQueue).toContain('# repovine-annotations');
    expect(annotationQueue).not.toContain('# /repovine-annotations');
    expect(annotationQueue).toContain('Skill inputs');
    expect(annotationQueue).toContain('tokens / annotation');
    expect(annotationQueue).toContain('Ask the user before each batch');
    expect(annotationQueue).toContain('do not auto-continue without user approval');
    expect(annotationQueue).toContain('scope: "consumer"');
    expect(annotationQueue).toContain('Importer must verify this at the consumer');
    expect(annotationQueue).toContain('scope: "boundary"');
    expect(annotationQueue).toContain('Carrier pair example');
    expect(annotationQueue).toContain('missing-carrier-link');
    expect(annotationQueue).toContain('named-but-undeliverable');
    expect(annotationQueue).toContain('mod:pkg/deep-gate');
    expect(annotationQueue).toContain('with continue');

    const workflowSkill = fs.readFileSync(
      path.join(tmpDir, '.claude', 'skills', 'repovine-workflow', 'SKILL.md'),
      'utf-8',
    );
    expect(workflowSkill).toContain('Main-agent implementation playbook');
    expect(workflowSkill).toContain('Relationship to Subagent Orchestration');
    // Claude carries the full main-agent delegation policy inline; AGENTS.md/CLAUDE.md stay thin.
    expect(workflowSkill).toContain('You are the **main agent**');
    expect(workflowSkill).toContain('Claude Code: `.claude/agents/*.md`');
    expect(workflowSkill).toContain('delegate to **project-subagent-sample**');
    expect(workflowSkill).not.toContain('For Claude Code delegation rules');
  });
});

describe('initCursor — onboarding distribution', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-cursor-onboard-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes build/lifecycle workflows as skills, not slash commands', () => {
    initCursor(tmpDir, { forceBootstrap: false, replaceMcp: false });
    // Cursor no longer gets a .cursor/commands surface.
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'commands'))).toBe(false);
    for (const name of EXPECTED_SHARED_SKILLS) {
      const p = path.join(tmpDir, '.agents', 'skills', name, 'SKILL.md');
      expect(fs.existsSync(p)).toBe(true);
      const body = fs.readFileSync(p, 'utf-8');
      // Skills carry YAML frontmatter and a non-slash heading.
      expect(body.startsWith('---\n')).toBe(true);
      expect(body).toContain(`name: ${name}`);
      expect(body).not.toContain('# /');
    }
  });

  it('writes sample project subagent and template (managed), not DESIGN.md', () => {
    initCursor(tmpDir, { forceBootstrap: false, replaceMcp: false });

    const samplePath = path.join(tmpDir, '.cursor', 'agents', 'sample.project-subagent.md');
    const templatePath = path.join(tmpDir, '.cursor', 'agents', '_TEMPLATE.project-subagent.md');
    expect(fs.existsSync(samplePath)).toBe(true);
    expect(fs.existsSync(templatePath)).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'DESIGN.md'))).toBe(false);

    const sample = fs.readFileSync(samplePath, 'utf-8');
    expect(sample).toContain('name: project-subagent-sample');
    expect(sample).toContain('leaf subagent');
    expect(sample).toContain('refresh_context');

    const template = fs.readFileSync(templatePath, 'utf-8');
    expect(template).toContain('name: {{agent-name}}');
    expect(template).toContain('leaf subagent');
    expect(template).toContain('refresh_context');
    expect(template).toContain('Orchestration (for the main agent)');

    const orchestration = fs.readFileSync(
      path.join(tmpDir, '.cursor', 'rules', 'repovine-subagent-orchestration.mdc'),
      'utf-8',
    );
    expect(orchestration).toContain('@project-subagent-sample');

    const second = initCursor(tmpDir, { forceBootstrap: false, replaceMcp: false });
    expect(second.some(r => r.path === samplePath && r.status === 'skipped')).toBe(true);
    expect(second.some(r => r.path === templatePath && r.status === 'skipped')).toBe(true);

    fs.writeFileSync(templatePath, '# stale template\n', 'utf-8');
    initCursor(tmpDir, { forceBootstrap: false, replaceMcp: false });
    expect(fs.existsSync(`${templatePath}.bak`)).toBe(false);
    expect(fs.readFileSync(templatePath, 'utf-8')).toContain('name: {{agent-name}}');

    const orchestrationPath = path.join(
      tmpDir,
      '.cursor',
      'rules',
      'repovine-subagent-orchestration.mdc',
    );
    fs.writeFileSync(orchestrationPath, '# stale rule\n', 'utf-8');
    initCursor(tmpDir, { forceBootstrap: false, replaceMcp: false });
    expect(fs.existsSync(`${orchestrationPath}.bak`)).toBe(false);
    expect(fs.readFileSync(orchestrationPath, 'utf-8')).toContain('@project-subagent-sample');

    const hookPath = path.join(tmpDir, '.cursor', 'hooks', CLIENT_DISPATCHER_FILENAME);
    fs.writeFileSync(hookPath, '// stale hook\n', 'utf-8');
    initCursor(tmpDir, { forceBootstrap: false, replaceMcp: false });
    expect(fs.existsSync(`${hookPath}.bak`)).toBe(false);
    expect(fs.readFileSync(hookPath, 'utf-8')).not.toBe('// stale hook\n');
  });

  it('writes Cursor agents, shared skills, rules, and hooks', () => {
    initCursor(tmpDir, { forceBootstrap: false, replaceMcp: false });
    const agent = fs.readFileSync(path.join(tmpDir, '.cursor', 'agents', 'repovine-repo-explorer.md'), 'utf-8');
    expect(agent.startsWith('---\n')).toBe(true);
    expect(agent).toContain('name: repovine-repo-explorer');
    // Cursor's cheap-model alias for summary-class subagents.
    expect(agent).toContain('model: fast');

    const skillNames = fs.readdirSync(path.join(tmpDir, '.agents', 'skills')).sort();
    expect(skillNames).toEqual(EXPECTED_SHARED_SKILLS);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-annotations'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-review'))).toBe(true);

    const workflowSkill = fs.readFileSync(path.join(tmpDir, '.agents', 'skills', 'repovine-workflow', 'SKILL.md'), 'utf-8');
    expect(workflowSkill).toContain('name: repovine-workflow');
    expect(workflowSkill).toContain('Main-agent implementation playbook');
    expect(workflowSkill).toContain('Relationship to Subagent Orchestration');
    expect(workflowSkill).toContain("Use the active client's native agent surface");
    expect(workflowSkill).toContain('delegate to **project-subagent-sample**');
    expect(workflowSkill).not.toContain('For Cursor delegation rules');
    expect(workflowSkill).not.toContain('Claude Code');
    expect(workflowSkill).not.toContain('Codex');
    expect(workflowSkill).toContain('local project skills');
    expect(workflowSkill).toContain('search_context');
    expect(workflowSkill).toContain('annotationMatched');
    expect(workflowSkill).toContain('omits annotation fields');
    expect(workflowSkill).toContain('analyze_dependencies');
    expect(workflowSkill).toContain('derive annotation obligations from the existing fields');
    expect(workflowSkill).toContain('do not bound inspect scope');
    expect(workflowSkill).toContain('must preserve: behavior, contracts, or invariants');
    expect(workflowSkill).toContain('close every relevant obligation as satisfied by code');
    // new inspect-scope semantics — guard against silent regression
    expect(workflowSkill).toContain('breadth is the task'); // task-conditioned closure
    expect(workflowSkill).toContain('required for affordance-class consumers'); // integrationPoints obligation
    expect(workflowSkill).toContain('cite the line that proves it is out of class'); // accept-loophole closed
    expect(workflowSkill).toContain('not a self-served default');
    expect(workflowSkill).toContain('consumed at mount and render predicates'); // derived-flag nudge
    expect(workflowSkill).toContain('scope: "consumer"');
    expect(workflowSkill).toContain('Importer must verify this at the consumer');
    expect(workflowSkill).toContain('runtimeHandoff');
    expect(workflowSkill).toContain('handler module');
    const annotationsSkill = fs.readFileSync(path.join(tmpDir, '.agents', 'skills', 'repovine-annotations', 'SKILL.md'), 'utf-8');
    expect(annotationsSkill).toContain('resource-to-module refs are runtime handoff prose');
    const reviewSkill = fs.readFileSync(path.join(tmpDir, '.agents', 'skills', 'repovine-review', 'SKILL.md'), 'utf-8');
    expect(reviewSkill).toContain('name: repovine-review');
    expect(reviewSkill).toContain('repovine-code-reviewer');
    expect(reviewSkill).toContain('repovine-architecture-auditor');
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'skills', 'repovine-explore', 'SKILL.md'))).toBe(false);

    const rule = fs.readFileSync(path.join(tmpDir, '.cursor', 'rules', 'repovine-policy.mdc'), 'utf-8');
    expect(rule).toContain('alwaysApply: true');
    expect(rule).toContain('Call MCP before reading files');
    expect(rule).toContain('If a consumer-risk SSOT is hidden behind a facade');
    expect(rule).toContain('carrier pair');

    const workflowRule = fs.readFileSync(path.join(tmpDir, '.cursor', 'rules', 'repovine-workflow.mdc'), 'utf-8');
    expect(workflowRule).toContain('implementation delegation stays in orchestration policy');
    expect(workflowRule).toContain('Relationship to Subagent Orchestration');
    expect(workflowRule).toContain('For Cursor delegation rules');
    expect(workflowRule).toContain('.cursor/rules/repovine-subagent-orchestration.mdc');
    expect(workflowRule).toContain('derive annotation obligations from the existing fields');
    expect(workflowRule).toContain('do not bound inspect scope');
    expect(workflowRule).toContain('surface to check: entrypoints, dependencies, config');
    expect(workflowRule).toContain('breadth is the task'); // task-conditioned closure projected to cursor rule
    expect(workflowRule).toContain('cite the line that proves it is out of class'); // accept-loophole closed
    expect(workflowRule).not.toContain('AGENTS.md may mirror');

    const hooks = JSON.parse(fs.readFileSync(path.join(tmpDir, '.cursor', 'hooks.json'), 'utf-8'));
    expect(hooks.hooks.sessionStart[0].command).toContain('hooks/repovine-client-dispatcher.mjs" session-mcp-hint cursor');
  });
});

describe('initAll', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-all-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sets up all clients including Claude and Codex project hooks', () => {
    initAll(tmpDir, { forceBootstrap: false, replaceMcp: false });

    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'hooks.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'agents', 'repovine-repo-explorer.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'agents', 'repovine-architecture-auditor.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'agents', 'repovine-code-reviewer.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'skills', 'repovine-verify', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'rules', 'repovine-workflow.mdc'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'config.toml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'hooks', CLIENT_DISPATCHER_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'agents', 'repovine-annotation-writer.toml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'agents', 'repovine-code-reviewer.toml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-annotations', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-review', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-workflow', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-refresh', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-status', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'commands'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'skills', 'repovine-annotations', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'skills', 'repovine-review', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'skills', 'repovine-workflow', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'repovine-iac-development', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'hooks', CLIENT_DISPATCHER_FILENAME))).toBe(true);
  });
});

/**
 * AGENTS.md ends with one sentence telling each client where its instruction surfaces live. The
 * sentence is read as the map of where a client's instructions are, so an instruction surface the run
 * creates and the sentence omits sends the reader to the wrong directory. The two sides here are
 * independent: the clause comes from the template constant, the surfaces come from the filesystem one
 * setup run produced.
 *
 * Instruction surface is the three shapes a reader opens for text: the client's `agents` directory,
 * its `skills` directory of `SKILL.md` files, and its `rules` directory. A setup run also writes
 * client config files and a `hooks` directory holding the dispatcher script; those are wiring, held by
 * the setup tests above, and the sentence does not map them. The last test here holds that boundary:
 * a directory kind outside the triaged list is one nobody decided about.
 */
describe('AGENTS.md client-surface sentence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-surface-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Instruction surfaces present under a workspace root, in the glob shape AGENTS.md names. */
  function writtenSurfaces(root: string): string[] {
    const found = new Set<string>();
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('.')) continue;
      const agentsDir = path.join(root, entry.name, 'agents');
      if (fs.existsSync(agentsDir)) {
        for (const file of fs.readdirSync(agentsDir)) {
          if (file.startsWith('repovine-')) found.add(`${entry.name}/agents/*${path.extname(file)}`);
        }
      }
      const skillsDir = path.join(root, entry.name, 'skills');
      if (fs.existsSync(skillsDir)) {
        for (const skill of fs.readdirSync(skillsDir)) {
          if (fs.existsSync(path.join(skillsDir, skill, 'SKILL.md'))) {
            found.add(`${entry.name}/skills/*/SKILL.md`);
          }
        }
      }
      if (fs.existsSync(path.join(root, entry.name, 'rules'))) found.add(`${entry.name}/rules`);
    }
    // Directory order is discovery order; sort so a failure lists the same surfaces everywhere.
    return [...found].sort();
  }

  /** The clause the surface sentence gives one client. */
  function surfaceClause(client: string): string {
    const clauses = [...AGENTS_MD.matchAll(
      /\b(Claude|Codex|Cursor) uses ([\s\S]*?)(?=\b(?:Claude|Codex|Cursor) uses |\n)/g,
    )];
    const clause = clauses.find(match => match[1] === client);
    if (!clause) throw new Error(`AGENTS.md carries no surface clause for ${client}`);
    return clause[2];
  }

  /**
   * Directory kinds a setup run puts under a client directory, and who holds each one.
   *
   * | kind | held by |
   * |---|---|
   * | agents, rules, skills | the surface sentence, through the tests below |
   * | hooks | the setup tests above, which assert the dispatcher file |
   *
   * Written by hand: a kind outside this list is a directory the recogniser above passes over in
   * silence, so the run that introduces one has to say where it belongs.
   */
  const TRIAGED_CLIENT_DIRECTORIES = ['agents', 'hooks', 'rules', 'skills'];

  /** Directories one level under the workspace's dot-directories. */
  function writtenClientDirectories(root: string): string[] {
    const found: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('.')) continue;
      for (const child of fs.readdirSync(path.join(root, entry.name), { withFileTypes: true })) {
        if (child.isDirectory()) found.push(path.join(entry.name, child.name));
      }
    }
    // Directory order is discovery order; sort so a failure lists the same directories everywhere.
    return found.sort();
  }

  type SetupRun = (cwd: string, opts: { forceBootstrap: boolean; replaceMcp: boolean }) => unknown;

  function expectClauseNamesEveryInstructionSurface(client: string, init: SetupRun): void {
    init(tmpDir, { forceBootstrap: false, replaceMcp: false });
    const surfaces = writtenSurfaces(tmpDir);
    // A run that wrote nothing would make the check below pass without reading anything.
    expect(surfaces.length).toBeGreaterThan(1);
    const clause = surfaceClause(client);
    const unnamed = surfaces.filter(surface => !clause.includes(`\`${surface}\``));
    expect({ client, unnamed }).toEqual({ client, unnamed: [] });
  }

  function expectEveryClientDirectoryTriaged(client: string, init: SetupRun): void {
    init(tmpDir, { forceBootstrap: false, replaceMcp: false });
    const written = writtenClientDirectories(tmpDir);
    // A run that created no client directory would make the filter below pass over an empty list.
    expect(written.length).toBeGreaterThan(1);
    const untriaged = written.filter(dir => !TRIAGED_CLIENT_DIRECTORIES.includes(path.basename(dir)));
    expect({ client, untriaged }).toEqual({ client, untriaged: [] });
  }

  it('names every instruction surface a Claude setup writes', () => {
    expectClauseNamesEveryInstructionSurface('Claude', initClaude);
  });

  it('names every instruction surface a Codex setup writes', () => {
    expectClauseNamesEveryInstructionSurface('Codex', initCodex);
  });

  it('names every instruction surface a Cursor setup writes', () => {
    expectClauseNamesEveryInstructionSurface('Cursor', initCursor);
  });

  it('writes no untriaged client directory in a Claude setup', () => {
    expectEveryClientDirectoryTriaged('Claude', initClaude);
  });

  it('writes no untriaged client directory in a Codex setup', () => {
    expectEveryClientDirectoryTriaged('Codex', initCodex);
  });

  it('writes no untriaged client directory in a Cursor setup', () => {
    expectEveryClientDirectoryTriaged('Cursor', initCursor);
  });
});
