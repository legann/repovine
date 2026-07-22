/**
 * Behavioral fixture suite for the client projections (Cursor / Claude Code /
 * Codex × project-local setup / marketplace bundle).
 *
 * The suite renders real projections into temp fixture repos whose paths carry
 * spaces and non-ASCII, then:
 *   - executes every hook entry the generated wiring files declare, under each
 *     client's own launch contract, asserting the advisory I/O contract
 *     (exit 0, empty stderr, stdout empty or one JSON object);
 *   - drives a real MCP handshake through each generated project config's own
 *     command;
 *   - parses the generated Codex TOML with a real TOML parser and cross-checks
 *     the engine's regex readers against it.
 *
 * Hook execution is config-driven: entries come from parsing the wiring files,
 * never from hardcoded script filenames.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { initClaude, initCodex, initCursor, type InitOptions } from '../../src/cli/init.js';
import { renderPluginRepo } from '../../src/cli/plugin-render.js';
import { CLIENT_DISPATCHER_FILENAME } from '../../src/cli/dispatcher/index.js';
import { HOOK_ACTIONS, type HookAction } from '../../src/cli/client-capabilities.js';
import { CODEX_HOOKS_BEGIN_MARKER } from '../../src/cli/templates.js';
import {
  BOUNDARY_RISK,
  CONFLICT_ANNOTATIONS,
  FIXTURE_PREFIX,
  type DeclaredHook,
  type HookExecution,
  type HookRunResult,
  expectAdvisoryExit,
  expectCliExit0,
  makeFixtureRepo,
  makeScrubbedEnv,
  mcpHandshake,
  nonJsonRpcFrames,
  readClaudeHooks,
  readCodexConfig,
  readCodexHooks,
  readCursorHooks,
  repovineLaunchFromCodexTomlRegex,
  repovineLaunchFromParsedToml,
  runDeclaredHook,
  runEngineCli,
  writeSyntheticEngineState,
} from '../helpers/client-projections.js';

const engineRoot = process.cwd();
const engineCli = path.join(engineRoot, 'dist', 'mcp', 'index.js');
const pkgVersion = (JSON.parse(fs.readFileSync(path.join(engineRoot, 'package.json'), 'utf-8')) as { version: string }).version;
const isWin = process.platform === 'win32';
const scrub = makeScrubbedEnv();

const CLIENTS = ['cursor', 'claude', 'codex'] as const;
type ClientId = (typeof CLIENTS)[number];

/** Event names each emit channel uses, in the client's casing. */
const EVENT_NAMES: Record<'cursor' | 'default', Record<'boundary' | 'stale' | 'conflict' | 'session', string>> = {
  cursor: { boundary: 'preToolUse', stale: 'afterFileEdit', conflict: 'afterShellExecution', session: 'sessionStart' },
  default: { boundary: 'PreToolUse', stale: 'PostToolUse', conflict: 'PostToolUse', session: 'SessionStart' },
};

interface ClientRunContext {
  client: ClientId;
  /** Project/workspace root the hooks act on. */
  root: string;
  hooks: DeclaredHook[];
  exec: HookExecution;
}

const cleanupDirs: string[] = [];

/** Fixture set up by the blackbox CLI `setup <client>` runs; hooks execute here. */
let projectRepo: string;
/** Fixture with in-process local-launcher configs; MCP handshakes launch from here. */
let launchRepo: string;
/** Rendered plugin-repo root (marketplaces + bundles). */
let bundlesOut: string;
/** Workspace root the plugin-scope hooks act on. */
let bundleWorkspace: string;

function bundleDir(client: ClientId): string {
  return path.join(bundlesOut, 'repovine-plugins', client);
}

function setupClient(client: ClientId): void {
  const res = runEngineCli(
    engineCli,
    ['setup', client, '--no-build', '--force'],
    projectRepo,
    { ...scrub, REPOVINE_ROOT: projectRepo },
  );
  expectCliExit0(res, `setup ${client}`);
}

beforeAll(() => {
  projectRepo = makeFixtureRepo();
  cleanupDirs.push(projectRepo);
  for (const client of CLIENTS) setupClient(client);
  // Hooks read only .repovine/ state files; a built graph is not required.
  writeSyntheticEngineState(projectRepo);

  bundlesOut = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), FIXTURE_PREFIX)));
  cleanupDirs.push(bundlesOut);
  renderPluginRepo({ engineRoot, outRoot: bundlesOut, version: pkgVersion });

  bundleWorkspace = makeFixtureRepo();
  cleanupDirs.push(bundleWorkspace);
  writeSyntheticEngineState(bundleWorkspace);
  // Cursor defines no plugin-install-root variable; its bundle hooks resolve
  // against the workspace root, so an install materializes .cursor/ there.
  fs.cpSync(path.join(bundleDir('cursor'), '.cursor'), path.join(bundleWorkspace, '.cursor'), { recursive: true });
});

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Payload builders (minimal shapes each client sends)
// ---------------------------------------------------------------------------

function fileEditPayload(ctx: ClientRunContext, filePath: string): unknown {
  // Cursor sends top-level fields plus workspace_roots; Claude/Codex nest tool_input.
  return ctx.client === 'cursor'
    ? { file_path: filePath, workspace_roots: [ctx.root] }
    : { tool_input: { file_path: filePath } };
}

function preEditPayload(ctx: ClientRunContext, filePath: string): unknown {
  return ctx.client === 'cursor'
    ? { tool_input: { file_path: filePath }, workspace_roots: [ctx.root] }
    : { tool_input: { file_path: filePath } };
}

function shellPayload(ctx: ClientRunContext, command: string): unknown {
  return ctx.client === 'cursor'
    ? { command, workspace_roots: [ctx.root] }
    : { tool_input: { command } };
}

function sessionPayload(ctx: ClientRunContext, source: string): unknown {
  return ctx.client === 'cursor' ? { source, workspace_roots: [ctx.root] } : { source };
}

// ---------------------------------------------------------------------------
// Hook selection and result assertions
// ---------------------------------------------------------------------------

function eventNames(client: ClientId): Record<'boundary' | 'stale' | 'conflict' | 'session', string> {
  return client === 'cursor' ? EVENT_NAMES.cursor : EVENT_NAMES.default;
}

function hookFor(ctx: ClientRunContext, action: HookAction, event?: string): DeclaredHook {
  const candidates = ctx.hooks.filter(h => h.action === action);
  expect(candidates.length).toBeGreaterThan(0);
  return (event !== undefined && candidates.find(h => h.event === event)) || candidates[0]!;
}

function expectSilent(result: HookRunResult, label: string): void {
  expectAdvisoryExit(result, label);
  expect(result.stdout).toBe('');
}

function expectAdvisory(
  ctx: ClientRunContext,
  result: HookRunResult,
  expectedEvent: string,
  substrings: string[],
  label: string,
): void {
  expectAdvisoryExit(result, label);
  expect(result.message).not.toBeNull();
  const hso = (result.message as Record<string, unknown>).hookSpecificOutput as {
    hookEventName?: string;
    additionalContext?: string;
  };
  expect(hso.hookEventName).toBe(expectedEvent);
  for (const s of substrings) expect(hso.additionalContext).toContain(s);
  if (ctx.client === 'cursor') {
    // Cursor's dual-key contract: top-level additional_context equals hookSpecificOutput.additionalContext.
    expect((result.message as Record<string, unknown>).additional_context).toBe(hso.additionalContext);
  } else {
    expect(result.message).not.toHaveProperty('additional_context');
  }
}

/** Run `fn` with the boundary index temporarily replaced (or removed when content is null). */
function withBoundaryIndex(root: string, content: string | null, fn: () => void): void {
  const indexPath = path.join(root, '.repovine', 'boundary-index.json');
  const original = fs.readFileSync(indexPath, 'utf-8');
  try {
    if (content === null) fs.rmSync(indexPath);
    else fs.writeFileSync(indexPath, content);
    fn();
  } finally {
    fs.writeFileSync(indexPath, original);
  }
}

/** Run `fn` with the workspace annotations file temporarily carrying conflict markers. */
function withConflictedAnnotations(root: string, fn: () => void): void {
  const annotsPath = path.join(root, 'repovine.annots.json');
  const original = fs.existsSync(annotsPath) ? fs.readFileSync(annotsPath, 'utf-8') : null;
  try {
    fs.writeFileSync(annotsPath, CONFLICT_ANNOTATIONS);
    fn();
  } finally {
    if (original === null) fs.rmSync(annotsPath, { force: true });
    else fs.writeFileSync(annotsPath, original);
  }
}

/**
 * Behavioral cases shared by every client context. `full` runs the whole
 * stdin/assertion matrix (project scope); plugin scope runs the positive case
 * per action, which proves the bundle's dispatcher addressing end to end.
 */
function declareHookBehaviorCases(name: string, ctx: () => ClientRunContext, opts: { full: boolean }): void {
  describe(name, () => {
    it('delivers the boundary advisory for an indexed file', () => {
      const c = ctx();
      const events = eventNames(c.client);
      const result = runDeclaredHook(
        hookFor(c, 'boundary-notice'),
        preEditPayload(c, path.join(c.root, 'src', 'app.ts')),
        c.exec,
      );
      expectAdvisory(c, result, events.boundary, ['repovine boundary advisory', 'src/app.ts', BOUNDARY_RISK], `${name} boundary`);
    });

    it('emits the staleness notice after a parsed-file edit', () => {
      const c = ctx();
      const events = eventNames(c.client);
      const result = runDeclaredHook(
        hookFor(c, 'stale-graph-notice', events.stale),
        fileEditPayload(c, 'src/app.ts'),
        c.exec,
      );
      expectAdvisory(c, result, events.stale, ['syntax index is now stale'], `${name} stale`);
    });

    it('emits the session MCP hint with onboarding state on startup', () => {
      const c = ctx();
      const events = eventNames(c.client);
      const result = runDeclaredHook(hookFor(c, 'session-mcp-hint'), sessionPayload(c, 'startup'), c.exec);
      expectAdvisory(c, result, events.session, ['repovine MCP is available', 'Onboarding state:'], `${name} session`);
    });

    if (!opts.full) return;

    it('stays silent for a file absent from the boundary index', () => {
      const c = ctx();
      const result = runDeclaredHook(
        hookFor(c, 'boundary-notice'),
        preEditPayload(c, path.join(c.root, 'src', 'index.ts')),
        c.exec,
      );
      expectSilent(result, `${name} boundary non-indexed`);
    });

    it('reports paused boundary advisories on a newer index schema', () => {
      const c = ctx();
      const events = eventNames(c.client);
      withBoundaryIndex(c.root, JSON.stringify({ version: 2, entries: {} }), () => {
        const result = runDeclaredHook(
          hookFor(c, 'boundary-notice'),
          preEditPayload(c, path.join(c.root, 'src', 'app.ts')),
          c.exec,
        );
        expectAdvisory(c, result, events.boundary, ['advisories are paused'], `${name} boundary drift`);
      });
    });

    it('stays silent when the boundary index is absent', () => {
      const c = ctx();
      withBoundaryIndex(c.root, null, () => {
        const result = runDeclaredHook(
          hookFor(c, 'boundary-notice'),
          preEditPayload(c, path.join(c.root, 'src', 'app.ts')),
          c.exec,
        );
        expectSilent(result, `${name} boundary index absent`);
      });
    });

    if (isWin) {
      it('resolves a native backslash payload path against the boundary index', () => {
        const c = ctx();
        const events = eventNames(c.client);
        const result = runDeclaredHook(
          hookFor(c, 'boundary-notice'),
          preEditPayload(c, `${c.root}\\src\\app.ts`),
          c.exec,
        );
        expectAdvisory(c, result, events.boundary, ['repovine boundary advisory', 'src/app.ts'], `${name} boundary win path`);
      });
    }

    it('stays silent for an engine-owned path', () => {
      const c = ctx();
      const result = runDeclaredHook(
        hookFor(c, 'stale-graph-notice', eventNames(c.client).stale),
        fileEditPayload(c, 'repovine.annots.json'),
        c.exec,
      );
      expectSilent(result, `${name} stale engine-owned`);
    });

    it('stays silent for a non-parsed extension', () => {
      const c = ctx();
      const result = runDeclaredHook(
        hookFor(c, 'stale-graph-notice', eventNames(c.client).stale),
        fileEditPayload(c, 'docs/notes.md'),
        c.exec,
      );
      expectSilent(result, `${name} stale non-parsed`);
    });

    it('surfaces annotation conflict markers after a git merge command', () => {
      const c = ctx();
      const events = eventNames(c.client);
      withConflictedAnnotations(c.root, () => {
        const result = runDeclaredHook(
          hookFor(c, 'stale-graph-notice', events.conflict),
          shellPayload(c, 'git merge feature'),
          c.exec,
        );
        expectAdvisory(
          c,
          result,
          events.conflict,
          ['contains conflict markers', 'get_annotation_merge_status', 'merge_annotations'],
          `${name} merge conflict`,
        );
      });
    });

    it('stays silent on session compact', () => {
      const c = ctx();
      const result = runDeclaredHook(hookFor(c, 'session-mcp-hint'), sessionPayload(c, 'compact'), c.exec);
      expectSilent(result, `${name} session compact`);
    });

    it('never crashes on malformed stdin', () => {
      const c = ctx();
      const boundary = runDeclaredHook(hookFor(c, 'boundary-notice'), 'not-json', c.exec);
      expectSilent(boundary, `${name} boundary malformed stdin`);
      // The session hint degrades to an empty payload instead of going silent.
      const session = runDeclaredHook(hookFor(c, 'session-mcp-hint'), 'not-json', c.exec);
      expectAdvisory(c, session, eventNames(c.client).session, ['repovine MCP is available'], `${name} session malformed stdin`);
    });
  });
}

// ---------------------------------------------------------------------------
// Project-local setup (blackbox CLI)
// ---------------------------------------------------------------------------

describe('project-local setup (CLI blackbox)', () => {
  it('generates the published npx launcher in every client MCP config', () => {
    const cursorMcp = JSON.parse(fs.readFileSync(path.join(projectRepo, '.cursor', 'mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, { type?: string; command: string; args: string[]; env: Record<string, string> }>;
    };
    const cursorServer = cursorMcp.mcpServers.repovine!;
    // Cursor's MCP schema requires type:"stdio"; it leads the entry.
    expect(Object.keys(cursorServer)[0]).toBe('type');
    expect(cursorServer.type).toBe('stdio');
    expect(cursorServer.command).toBe('npx');
    expect(cursorServer.args).toEqual(['-y', 'repovine']);
    expect(cursorServer.env.REPOVINE_ROOT).toBe('${workspaceFolder}');

    const claudeMcp = JSON.parse(fs.readFileSync(path.join(projectRepo, '.mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, { type?: string; command: string; args: string[]; env: Record<string, string> }>;
    };
    const claudeServer = claudeMcp.mcpServers.repovine!;
    expect(claudeServer).not.toHaveProperty('type');
    expect(claudeServer.command).toBe('npx');
    expect(claudeServer.args).toEqual(['-y', 'repovine']);
    expect(claudeServer.env.REPOVINE_ROOT).toBe('.');

    const codexLaunch = repovineLaunchFromParsedToml(readCodexConfig(path.join(projectRepo, '.codex', 'config.toml')));
    expect(codexLaunch.command).toBe('npx');
    expect(codexLaunch.args).toEqual(['-y', 'repovine']);
    expect(codexLaunch.root).toBe('.');
  });

  it('ships exactly one hook file per client hooks dir (the dispatcher)', () => {
    for (const dir of ['.cursor/hooks', '.claude/hooks', '.codex/hooks']) {
      expect(fs.readdirSync(path.join(projectRepo, ...dir.split('/')))).toEqual([CLIENT_DISPATCHER_FILENAME]);
    }
  });

  it('wires every dispatcher action in every client wiring file', () => {
    const wirings: Array<[string, DeclaredHook[]]> = [
      ['cursor', readCursorHooks(path.join(projectRepo, '.cursor', 'hooks.json'))],
      ['claude', readClaudeHooks(path.join(projectRepo, '.claude', 'settings.json'))],
      ['codex', readCodexHooks(path.join(projectRepo, '.codex', 'config.toml'))],
    ];
    for (const [client, hooks] of wirings) {
      const wired = new Set(hooks.map(h => h.action));
      for (const action of HOOK_ACTIONS) {
        if (!wired.has(action)) throw new Error(`${client} wiring lacks the ${action} action`);
      }
    }
  });

  it('claude hook entries are exec-form; no entry relies on shell $VAR expansion', () => {
    const hooks = readClaudeHooks(path.join(projectRepo, '.claude', 'settings.json'));
    expect(hooks.length).toBeGreaterThan(0);
    for (const hook of hooks) {
      expect(hook.command).toBe('node');
      expect(hook.args).toBeDefined();
      // A string-only entry carrying $VAR would need a POSIX shell and break on win32.
      expect(hook.args!.length).toBeGreaterThan(0);
    }
  });

  it('cursor hook strings are cross-shell (no substitution syntax, no backslashes)', () => {
    const hooks = readCursorHooks(path.join(projectRepo, '.cursor', 'hooks.json'));
    expect(hooks.length).toBeGreaterThan(0);
    for (const hook of hooks) {
      expect(hook.command).not.toMatch(/[$\\]/);
    }
  });

  it('codex project hooks pair a POSIX command with a full command_windows alternate', () => {
    const hooks = readCodexHooks(path.join(projectRepo, '.codex', 'config.toml'));
    expect(hooks.length).toBeGreaterThan(0);
    for (const hook of hooks) {
      expect(hook.command).toContain('$(git rev-parse --show-toplevel)');
      // cmd.exe cannot evaluate $(...); the alternate is workspace-relative.
      expect(hook.commandWindows).toBeDefined();
      expect(hook.commandWindows).not.toMatch(/[$\\]/);
      expect(hook.commandWindows).toContain(hook.action);
    }
  });

  it('codex TOML stays inside the regex-readable subset the engine parses', () => {
    const content = fs.readFileSync(path.join(projectRepo, '.codex', 'config.toml'), 'utf-8');
    const fromParser = repovineLaunchFromParsedToml(readCodexConfig(path.join(projectRepo, '.codex', 'config.toml')));
    expect(repovineLaunchFromCodexTomlRegex(content)).toEqual(fromParser);
  });

  it('re-running setup keeps hook wiring free of duplicate entries', () => {
    for (const client of CLIENTS) setupClient(client);

    const cursorHooks = readCursorHooks(path.join(projectRepo, '.cursor', 'hooks.json'));
    const cursorByEvent = new Map<string, number>();
    for (const hook of cursorHooks) cursorByEvent.set(hook.event, (cursorByEvent.get(hook.event) ?? 0) + 1);
    for (const [event, count] of cursorByEvent) {
      if (count !== 1) throw new Error(`cursor event ${event} carries ${count} entries after re-run`);
    }

    const claudeSettings = JSON.parse(fs.readFileSync(path.join(projectRepo, '.claude', 'settings.json'), 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    for (const [event, entries] of Object.entries(claudeSettings.hooks)) {
      if (entries.length !== 1) throw new Error(`claude event ${event} carries ${entries.length} entries after re-run`);
    }

    const codexToml = fs.readFileSync(path.join(projectRepo, '.codex', 'config.toml'), 'utf-8');
    expect(codexToml.split(CODEX_HOOKS_BEGIN_MARKER).length - 1).toBe(1);
    expect(codexToml.split('[mcp_servers.repovine]').length - 1).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Project-scope hook execution (full matrix)
// ---------------------------------------------------------------------------

declareHookBehaviorCases(
  'cursor project hooks (shell string, workspace-relative)',
  () => ({
    client: 'cursor',
    root: projectRepo,
    hooks: readCursorHooks(path.join(projectRepo, '.cursor', 'hooks.json')),
    // Root travels in the payload (workspace_roots) and cwd; no undocumented
    // env root variable is supplied.
    exec: { cwd: projectRepo, env: { ...scrub, CURSOR_PROJECT_DIR: projectRepo } },
  }),
  { full: true },
);

declareHookBehaviorCases(
  'claude project hooks (exec-form, ${CLAUDE_PROJECT_DIR})',
  () => ({
    client: 'claude',
    root: projectRepo,
    hooks: readClaudeHooks(path.join(projectRepo, '.claude', 'settings.json')),
    exec: {
      cwd: projectRepo,
      env: { ...scrub, CLAUDE_PROJECT_DIR: projectRepo },
      substitutions: { '${CLAUDE_PROJECT_DIR}': projectRepo },
    },
  }),
  { full: true },
);

declareHookBehaviorCases(
  'codex project hooks (shell string via git rev-parse; command_windows under ComSpec)',
  () => ({
    client: 'codex',
    root: projectRepo,
    hooks: readCodexHooks(path.join(projectRepo, '.codex', 'config.toml')),
    // No root env variable: POSIX commands resolve the root through the shell,
    // the Windows alternate resolves workspace-relative from cwd.
    exec: { cwd: projectRepo, env: { ...scrub } },
  }),
  { full: true },
);

// ---------------------------------------------------------------------------
// Marketplace bundles
// ---------------------------------------------------------------------------

describe('marketplace bundles', () => {
  it('each bundle ships exactly one hook file (the dispatcher)', () => {
    const hooksDirs: Array<[ClientId, string]> = [
      ['cursor', path.join(bundleDir('cursor'), '.cursor', 'hooks')],
      ['claude', path.join(bundleDir('claude'), 'hooks')],
      ['codex', path.join(bundleDir('codex'), '.codex', 'hooks')],
    ];
    for (const [client, dir] of hooksDirs) {
      const files = fs.readdirSync(dir).filter(name => /\.m?js$/.test(name));
      if (files.length !== 1 || files[0] !== CLIENT_DISPATCHER_FILENAME) {
        throw new Error(`${client} bundle hooks dir ships ${JSON.stringify(files)}`);
      }
    }
  });

  it('pins repovine@<version> in every bundle MCP config', () => {
    const cursorMcp = JSON.parse(fs.readFileSync(path.join(bundleDir('cursor'), '.cursor', 'mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, { type?: string; args: string[] }>;
    };
    expect(cursorMcp.mcpServers.repovine!.type).toBe('stdio');
    expect(cursorMcp.mcpServers.repovine!.args).toEqual(['-y', `repovine@${pkgVersion}`]);

    const claudeMcp = JSON.parse(fs.readFileSync(path.join(bundleDir('claude'), '.mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, { type?: string; args: string[] }>;
    };
    expect(claudeMcp.mcpServers.repovine!).not.toHaveProperty('type');
    expect(claudeMcp.mcpServers.repovine!.args).toEqual(['-y', `repovine@${pkgVersion}`]);

    const codexTomlPath = path.join(bundleDir('codex'), '.codex', 'config.toml');
    const codexLaunch = repovineLaunchFromParsedToml(readCodexConfig(codexTomlPath));
    expect(codexLaunch.command).toBe('npx');
    expect(codexLaunch.args).toEqual(['-y', `repovine@${pkgVersion}`]);
    // The regex readers must agree with the real parse on the pinned launch.
    expect(repovineLaunchFromCodexTomlRegex(fs.readFileSync(codexTomlPath, 'utf-8'))).toEqual(codexLaunch);
  });

  it('claude bundle hooks are exec-form and address ${CLAUDE_PLUGIN_ROOT}', () => {
    const hooks = readClaudeHooks(path.join(bundleDir('claude'), 'hooks', 'hooks.json'));
    expect(hooks.length).toBeGreaterThan(0);
    for (const hook of hooks) {
      expect(hook.command).toBe('node');
      expect(hook.args![0]).toBe(`\${CLAUDE_PLUGIN_ROOT}/hooks/${CLIENT_DISPATCHER_FILENAME}`);
      expect(hook.args).toContain(hook.action);
      expect([hook.command, ...hook.args!].join(' ')).not.toContain('CLAUDE_PROJECT_DIR');
    }
  });

  it('codex bundle hooks address $PLUGIN_ROOT with a %PLUGIN_ROOT% Windows alternate', () => {
    const hooks = readCodexHooks(path.join(bundleDir('codex'), '.codex', 'config.toml'));
    expect(hooks.length).toBeGreaterThan(0);
    for (const hook of hooks) {
      expect(hook.command).toContain('$PLUGIN_ROOT/');
      expect(hook.command).not.toContain('$(git rev-parse');
      expect(hook.commandWindows).toBeDefined();
      expect(hook.commandWindows).toContain('%PLUGIN_ROOT%/');
    }
  });

  it('cursor bundle hook strings are workspace-relative and cross-shell', () => {
    const hooks = readCursorHooks(path.join(bundleDir('cursor'), '.cursor', 'hooks.json'));
    expect(hooks.length).toBeGreaterThan(0);
    for (const hook of hooks) {
      expect(hook.command).not.toMatch(/[$\\]/);
    }
  });

  declareHookBehaviorCases(
    'cursor bundle hooks (materialized into the workspace)',
    () => ({
      client: 'cursor',
      root: bundleWorkspace,
      hooks: readCursorHooks(path.join(bundleWorkspace, '.cursor', 'hooks.json')),
      exec: { cwd: bundleWorkspace, env: { ...scrub, CURSOR_PROJECT_DIR: bundleWorkspace } },
    }),
    { full: false },
  );

  declareHookBehaviorCases(
    'claude plugin hooks (run from the bundle via ${CLAUDE_PLUGIN_ROOT})',
    () => ({
      client: 'claude',
      root: bundleWorkspace,
      hooks: readClaudeHooks(path.join(bundleDir('claude'), 'hooks', 'hooks.json')),
      exec: {
        cwd: bundleWorkspace,
        env: { ...scrub, CLAUDE_PROJECT_DIR: bundleWorkspace, CLAUDE_PLUGIN_ROOT: bundleDir('claude') },
        substitutions: {
          '${CLAUDE_PROJECT_DIR}': bundleWorkspace,
          '${CLAUDE_PLUGIN_ROOT}': bundleDir('claude'),
        },
      },
    }),
    { full: false },
  );

  declareHookBehaviorCases(
    'codex plugin hooks (run from the bundle via $PLUGIN_ROOT)',
    () => ({
      client: 'codex',
      root: bundleWorkspace,
      hooks: readCodexHooks(path.join(bundleDir('codex'), '.codex', 'config.toml')),
      exec: {
        cwd: bundleWorkspace,
        env: { ...scrub, PLUGIN_ROOT: bundleDir('codex'), CLAUDE_PROJECT_DIR: bundleWorkspace },
      },
    }),
    { full: false },
  );
});

// ---------------------------------------------------------------------------
// MCP handshake on generated project configs
// ---------------------------------------------------------------------------

describe('MCP handshake on generated project configs', () => {
  beforeAll(() => {
    launchRepo = makeFixtureRepo();
    cleanupDirs.push(launchRepo);
    // The local-launcher form a source-checkout setup emits: configs launch the
    // built dist entry verbatim, so the handshake runs exactly what they say.
    const opts: InitOptions = {
      forceBootstrap: true,
      replaceMcp: false,
      autoBuild: false,
      mcpLauncher: { command: process.execPath, args: [engineCli] },
    };
    initCursor(launchRepo, opts);
    initClaude(launchRepo, opts);
    initCodex(launchRepo, opts);

    // Graph inference is not this suite's surface; the token index keeps the
    // handshake's cold build bounded to seconds.
    const cfgPath = path.join(launchRepo, 'repovine.config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
    cfg.semantic_search_embeddings = false;
    fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

    // Remove the artifacts setup created: their reappearance after a handshake
    // proves the server bootstrapped this workspace, not some other root.
    fs.rmSync(path.join(launchRepo, '.repovine'), { recursive: true, force: true });
    fs.rmSync(path.join(launchRepo, 'repovine.annots.json'), { force: true });
  });

  async function handshakeAndAssert(
    server: { command: string; args: string[] },
    rootValue: string,
    label: string,
  ): Promise<void> {
    const res = await mcpHandshake({
      command: server.command,
      args: server.args,
      cwd: launchRepo,
      env: { ...scrub, REPOVINE_ROOT: rootValue },
    });
    expect(res.tools.length).toBeGreaterThanOrEqual(18);
    expect(res.eofExit).toBe(true);
    expect(/ERR_MODULE_NOT_FOUND|Cannot find package/.test(res.stderr)).toBe(false);
    expect(nonJsonRpcFrames(res.stdout)).toEqual([]);
    // Root-resolution proof under the spaced + non-ASCII path.
    if (!fs.existsSync(path.join(launchRepo, 'repovine.annots.json')) || !fs.existsSync(path.join(launchRepo, '.repovine'))) {
      throw new Error(`${label}: MCP start did not bootstrap workspace artifacts in ${launchRepo}`);
    }
  }

  it('cursor config launches and bootstraps the workspace (type:"stdio", ${workspaceFolder} root)', async () => {
    const mcp = JSON.parse(fs.readFileSync(path.join(launchRepo, '.cursor', 'mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, { type?: string; command: string; args: string[]; env: Record<string, string> }>;
    };
    const server = mcp.mcpServers.repovine!;
    expect(server.type).toBe('stdio');
    expect(server.command).toBe(process.execPath);
    // The client substitutes ${workspaceFolder}; the harness does the same before launch.
    const rootValue = server.env.REPOVINE_ROOT.replace('${workspaceFolder}', launchRepo);
    expect(rootValue).toBe(launchRepo);
    await handshakeAndAssert(server, rootValue, 'cursor handshake');
  });

  it('claude config launches with REPOVINE_ROOT "." resolved against the workspace cwd', async () => {
    const mcp = JSON.parse(fs.readFileSync(path.join(launchRepo, '.mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, { type?: string; command: string; args: string[]; env: Record<string, string> }>;
    };
    const server = mcp.mcpServers.repovine!;
    expect(server).not.toHaveProperty('type');
    expect(server.command).toBe(process.execPath);
    await handshakeAndAssert(server, server.env.REPOVINE_ROOT, 'claude handshake');
  });

  it('codex config launches from the real TOML parse (backslash round-trip on win32)', async () => {
    const tomlPath = path.join(launchRepo, '.codex', 'config.toml');
    const launch = repovineLaunchFromParsedToml(readCodexConfig(tomlPath));
    // TOML basic-string escaping must round-trip the executable path exactly;
    // on win32 that path carries backslashes (and typically spaces).
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual([engineCli]);
    if (!isWin) {
      // The regex readers keep escape sequences verbatim, so agreement with the
      // real parse holds only for escape-free paths (any POSIX executable path).
      expect(repovineLaunchFromCodexTomlRegex(fs.readFileSync(tomlPath, 'utf-8'))).toEqual(launch);
    }
    await handshakeAndAssert({ command: launch.command!, args: launch.args! }, launch.root!, 'codex handshake');
  });
});
