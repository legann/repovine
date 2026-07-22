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
 *
 * Runner: node:test, not jest. Executing this suite inside jest on
 * windows-latest dies silently — exit 127 with no output — even with
 * --runInBand, while every other layer was proven alive in isolation (node
 * itself, the jest CLI, jest config plus module resolution, the global setup).
 * node:test is the execution model the pack-install smoke test and the agent
 * harness demo already run reliably on Windows, so the suite runs there. It
 * imports the built engine from dist/; the invoking flow builds first
 * (`npm run test:projections`, or CI's Build step).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initClaude, initCodex, initCursor } from '../../dist/cli/init.js';
import { renderPluginRepo } from '../../dist/cli/plugin-render.js';
import { CLIENT_DISPATCHER_FILENAME } from '../../dist/cli/dispatcher/index.js';
import { HOOK_ACTIONS } from '../../dist/cli/client-capabilities.js';
import { CODEX_HOOKS_BEGIN_MARKER } from '../../dist/cli/templates.js';
import {
  BOUNDARY_RISK,
  CONFLICT_ANNOTATIONS,
  FIXTURE_PREFIX,
  expectAdvisoryExit,
  expectCliExit0,
  copyDirSync,
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
} from '../helpers/client-projections.mjs';

const engineRoot = process.cwd();
const engineCli = path.join(engineRoot, 'dist', 'mcp', 'index.js');
const pkgVersion = JSON.parse(fs.readFileSync(path.join(engineRoot, 'package.json'), 'utf-8')).version;
const isWin = process.platform === 'win32';
const scrub = makeScrubbedEnv();

const CLIENTS = ['cursor', 'claude', 'codex'];

/** Event names each emit channel uses, in the client's casing. */
const EVENT_NAMES = {
  cursor: { boundary: 'preToolUse', stale: 'afterFileEdit', conflict: 'afterShellExecution', session: 'sessionStart' },
  default: { boundary: 'PreToolUse', stale: 'PostToolUse', conflict: 'PostToolUse', session: 'SessionStart' },
};

const cleanupDirs = [];

/** Fixture set up by the blackbox CLI `setup <client>` runs; hooks execute here. */
let projectRepo;
/** Fixture with in-process local-launcher configs; MCP handshakes launch from here. */
let launchRepo;
/** Rendered plugin-repo root (marketplaces + bundles). */
let bundlesOut;
/** Workspace root the plugin-scope hooks act on. */
let bundleWorkspace;

function bundleDir(client) {
  return path.join(bundlesOut, 'repovine-plugins', client);
}

function setupClient(client) {
  const res = runEngineCli(
    engineCli,
    ['setup', client, '--no-build', '--force'],
    projectRepo,
    { ...scrub, REPOVINE_ROOT: projectRepo },
  );
  expectCliExit0(res, `setup ${client}`);
}

before(() => {
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
  copyDirSync(path.join(bundleDir('cursor'), '.cursor'), path.join(bundleWorkspace, '.cursor'));
});

after(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Payload builders (minimal shapes each client sends)
// ---------------------------------------------------------------------------

function fileEditPayload(ctx, filePath) {
  // Cursor sends top-level fields plus workspace_roots; Claude/Codex nest tool_input.
  return ctx.client === 'cursor'
    ? { file_path: filePath, workspace_roots: [ctx.root] }
    : { tool_input: { file_path: filePath } };
}

function preEditPayload(ctx, filePath) {
  return ctx.client === 'cursor'
    ? { tool_input: { file_path: filePath }, workspace_roots: [ctx.root] }
    : { tool_input: { file_path: filePath } };
}

function shellPayload(ctx, command) {
  return ctx.client === 'cursor'
    ? { command, workspace_roots: [ctx.root] }
    : { tool_input: { command } };
}

function sessionPayload(ctx, source) {
  return ctx.client === 'cursor' ? { source, workspace_roots: [ctx.root] } : { source };
}

// ---------------------------------------------------------------------------
// Hook selection and result assertions
// ---------------------------------------------------------------------------

function eventNames(client) {
  return client === 'cursor' ? EVENT_NAMES.cursor : EVENT_NAMES.default;
}

function hookFor(ctx, action, event) {
  const candidates = ctx.hooks.filter(h => h.action === action);
  assert.ok(candidates.length > 0, `no hook declares the ${action} action`);
  return (event !== undefined && candidates.find(h => h.event === event)) || candidates[0];
}

function expectSilent(result, label) {
  expectAdvisoryExit(result, label);
  assert.equal(result.stdout, '', `${label}: expected silent stdout`);
}

function expectAdvisory(ctx, result, expectedEvent, substrings, label) {
  expectAdvisoryExit(result, label);
  assert.notEqual(result.message, null, `${label}: expected an advisory message on stdout`);
  const hso = result.message.hookSpecificOutput;
  assert.equal(hso.hookEventName, expectedEvent, `${label}: hookEventName`);
  for (const s of substrings) {
    assert.ok(hso.additionalContext.includes(s), `${label}: additionalContext lacks ${JSON.stringify(s)}`);
  }
  if (ctx.client === 'cursor') {
    // Cursor's dual-key contract: top-level additional_context equals hookSpecificOutput.additionalContext.
    assert.equal(result.message.additional_context, hso.additionalContext, `${label}: cursor dual-key`);
  } else {
    assert.ok(!('additional_context' in result.message), `${label}: unexpected top-level additional_context`);
  }
}

/** Run `fn` with the boundary index temporarily replaced (or removed when content is null). */
async function withBoundaryIndex(root, content, fn) {
  const indexPath = path.join(root, '.repovine', 'boundary-index.json');
  const original = fs.readFileSync(indexPath, 'utf-8');
  try {
    if (content === null) fs.rmSync(indexPath);
    else fs.writeFileSync(indexPath, content);
    await fn();
  } finally {
    fs.writeFileSync(indexPath, original);
  }
}

/** Run `fn` with the workspace annotations file temporarily carrying conflict markers. */
async function withConflictedAnnotations(root, fn) {
  const annotsPath = path.join(root, 'repovine.annots.json');
  const original = fs.existsSync(annotsPath) ? fs.readFileSync(annotsPath, 'utf-8') : null;
  try {
    fs.writeFileSync(annotsPath, CONFLICT_ANNOTATIONS);
    await fn();
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
function declareHookBehaviorCases(name, ctx, opts) {
  describe(name, () => {
    it('delivers the boundary advisory for an indexed file', async () => {
      const c = ctx();
      const events = eventNames(c.client);
      const result = await runDeclaredHook(
        hookFor(c, 'boundary-notice'),
        preEditPayload(c, path.join(c.root, 'src', 'app.ts')),
        c.exec,
      );
      expectAdvisory(c, result, events.boundary, ['repovine boundary advisory', 'src/app.ts', BOUNDARY_RISK], `${name} boundary`);
    });

    it('emits the staleness notice after a parsed-file edit', async () => {
      const c = ctx();
      const events = eventNames(c.client);
      const result = await runDeclaredHook(
        hookFor(c, 'stale-graph-notice', events.stale),
        fileEditPayload(c, 'src/app.ts'),
        c.exec,
      );
      expectAdvisory(c, result, events.stale, ['syntax index is now stale'], `${name} stale`);
    });

    it('emits the session MCP hint with onboarding state on startup', async () => {
      const c = ctx();
      const events = eventNames(c.client);
      const result = await runDeclaredHook(hookFor(c, 'session-mcp-hint'), sessionPayload(c, 'startup'), c.exec);
      expectAdvisory(c, result, events.session, ['repovine MCP is available', 'Onboarding state:'], `${name} session`);
    });

    if (!opts.full) return;

    it('stays silent for a file absent from the boundary index', async () => {
      const c = ctx();
      const result = await runDeclaredHook(
        hookFor(c, 'boundary-notice'),
        preEditPayload(c, path.join(c.root, 'src', 'index.ts')),
        c.exec,
      );
      expectSilent(result, `${name} boundary non-indexed`);
    });

    it('reports paused boundary advisories on a newer index schema', async () => {
      const c = ctx();
      const events = eventNames(c.client);
      await withBoundaryIndex(c.root, JSON.stringify({ version: 2, entries: {} }), async () => {
        const result = await runDeclaredHook(
          hookFor(c, 'boundary-notice'),
          preEditPayload(c, path.join(c.root, 'src', 'app.ts')),
          c.exec,
        );
        expectAdvisory(c, result, events.boundary, ['advisories are paused'], `${name} boundary drift`);
      });
    });

    it('stays silent when the boundary index is absent', async () => {
      const c = ctx();
      await withBoundaryIndex(c.root, null, async () => {
        const result = await runDeclaredHook(
          hookFor(c, 'boundary-notice'),
          preEditPayload(c, path.join(c.root, 'src', 'app.ts')),
          c.exec,
        );
        expectSilent(result, `${name} boundary index absent`);
      });
    });

    if (isWin) {
      it('resolves a native backslash payload path against the boundary index', async () => {
        const c = ctx();
        const events = eventNames(c.client);
        const result = await runDeclaredHook(
          hookFor(c, 'boundary-notice'),
          preEditPayload(c, `${c.root}\\src\\app.ts`),
          c.exec,
        );
        expectAdvisory(c, result, events.boundary, ['repovine boundary advisory', 'src/app.ts'], `${name} boundary win path`);
      });
    }

    it('stays silent for an engine-owned path', async () => {
      const c = ctx();
      const result = await runDeclaredHook(
        hookFor(c, 'stale-graph-notice', eventNames(c.client).stale),
        fileEditPayload(c, 'repovine.annots.json'),
        c.exec,
      );
      expectSilent(result, `${name} stale engine-owned`);
    });

    it('stays silent for a non-parsed extension', async () => {
      const c = ctx();
      const result = await runDeclaredHook(
        hookFor(c, 'stale-graph-notice', eventNames(c.client).stale),
        fileEditPayload(c, 'docs/notes.md'),
        c.exec,
      );
      expectSilent(result, `${name} stale non-parsed`);
    });

    it('surfaces annotation conflict markers after a git merge command', async () => {
      const c = ctx();
      const events = eventNames(c.client);
      await withConflictedAnnotations(c.root, async () => {
        const result = await runDeclaredHook(
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

    it('stays silent on session compact', async () => {
      const c = ctx();
      const result = await runDeclaredHook(hookFor(c, 'session-mcp-hint'), sessionPayload(c, 'compact'), c.exec);
      expectSilent(result, `${name} session compact`);
    });

    it('never crashes on malformed stdin', async () => {
      const c = ctx();
      const boundary = await runDeclaredHook(hookFor(c, 'boundary-notice'), 'not-json', c.exec);
      expectSilent(boundary, `${name} boundary malformed stdin`);
      // The session hint degrades to an empty payload instead of going silent.
      const session = await runDeclaredHook(hookFor(c, 'session-mcp-hint'), 'not-json', c.exec);
      expectAdvisory(c, session, eventNames(c.client).session, ['repovine MCP is available'], `${name} session malformed stdin`);
    });
  });
}

// ---------------------------------------------------------------------------
// Project-local setup (blackbox CLI)
// ---------------------------------------------------------------------------

describe('project-local setup (CLI blackbox)', () => {
  it('generates the published npx launcher in every client MCP config', async () => {
    const cursorMcp = JSON.parse(fs.readFileSync(path.join(projectRepo, '.cursor', 'mcp.json'), 'utf-8'));
    const cursorServer = cursorMcp.mcpServers.repovine;
    // Cursor's MCP schema requires type:"stdio"; it leads the entry.
    assert.equal(Object.keys(cursorServer)[0], 'type');
    assert.equal(cursorServer.type, 'stdio');
    assert.equal(cursorServer.command, 'npx');
    assert.deepEqual(cursorServer.args, ['-y', 'repovine']);
    assert.equal(cursorServer.env.REPOVINE_ROOT, '${workspaceFolder}');

    const claudeMcp = JSON.parse(fs.readFileSync(path.join(projectRepo, '.mcp.json'), 'utf-8'));
    const claudeServer = claudeMcp.mcpServers.repovine;
    assert.ok(!('type' in claudeServer), 'claude MCP entry must not carry a type field');
    assert.equal(claudeServer.command, 'npx');
    assert.deepEqual(claudeServer.args, ['-y', 'repovine']);
    assert.equal(claudeServer.env.REPOVINE_ROOT, '.');

    const codexLaunch = repovineLaunchFromParsedToml(readCodexConfig(path.join(projectRepo, '.codex', 'config.toml')));
    assert.equal(codexLaunch.command, 'npx');
    assert.deepEqual(codexLaunch.args, ['-y', 'repovine']);
    assert.equal(codexLaunch.root, '.');
  });

  it('ships exactly one hook file per client hooks dir (the dispatcher)', async () => {
    for (const dir of ['.cursor/hooks', '.claude/hooks', '.codex/hooks']) {
      assert.deepEqual(fs.readdirSync(path.join(projectRepo, ...dir.split('/'))), [CLIENT_DISPATCHER_FILENAME]);
    }
  });

  it('wires every dispatcher action in every client wiring file', async () => {
    const wirings = [
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

  it('claude hook entries are exec-form; no entry relies on shell $VAR expansion', async () => {
    const hooks = readClaudeHooks(path.join(projectRepo, '.claude', 'settings.json'));
    assert.ok(hooks.length > 0);
    for (const hook of hooks) {
      assert.equal(hook.command, 'node');
      assert.ok(hook.args !== undefined, 'claude hook entry must be exec-form (args present)');
      // A string-only entry carrying $VAR would need a POSIX shell and break on win32.
      assert.ok(hook.args.length > 0);
    }
  });

  it('cursor hook strings are cross-shell (no substitution syntax, no backslashes)', async () => {
    const hooks = readCursorHooks(path.join(projectRepo, '.cursor', 'hooks.json'));
    assert.ok(hooks.length > 0);
    for (const hook of hooks) {
      assert.doesNotMatch(hook.command, /[$\\]/);
    }
  });

  it('codex project hooks pair a POSIX command with a full command_windows alternate', async () => {
    const hooks = readCodexHooks(path.join(projectRepo, '.codex', 'config.toml'));
    assert.ok(hooks.length > 0);
    for (const hook of hooks) {
      assert.ok(hook.command.includes('$(git rev-parse --show-toplevel)'), `POSIX command resolves the root via git: ${hook.command}`);
      // cmd.exe cannot evaluate $(...); the alternate is workspace-relative.
      assert.ok(hook.commandWindows !== undefined, 'codex hook entry must declare command_windows');
      assert.doesNotMatch(hook.commandWindows, /[$\\]/);
      assert.ok(hook.commandWindows.includes(hook.action), `command_windows carries the ${hook.action} action`);
    }
  });

  it('codex TOML stays inside the regex-readable subset the engine parses', async () => {
    const content = fs.readFileSync(path.join(projectRepo, '.codex', 'config.toml'), 'utf-8');
    const fromParser = repovineLaunchFromParsedToml(readCodexConfig(path.join(projectRepo, '.codex', 'config.toml')));
    assert.deepEqual(repovineLaunchFromCodexTomlRegex(content), fromParser);
  });

  it('re-running setup keeps hook wiring free of duplicate entries', async () => {
    for (const client of CLIENTS) setupClient(client);

    const cursorHooks = readCursorHooks(path.join(projectRepo, '.cursor', 'hooks.json'));
    const cursorByEvent = new Map();
    for (const hook of cursorHooks) cursorByEvent.set(hook.event, (cursorByEvent.get(hook.event) ?? 0) + 1);
    for (const [event, count] of cursorByEvent) {
      if (count !== 1) throw new Error(`cursor event ${event} carries ${count} entries after re-run`);
    }

    const claudeSettings = JSON.parse(fs.readFileSync(path.join(projectRepo, '.claude', 'settings.json'), 'utf-8'));
    for (const [event, entries] of Object.entries(claudeSettings.hooks)) {
      if (entries.length !== 1) throw new Error(`claude event ${event} carries ${entries.length} entries after re-run`);
    }

    const codexToml = fs.readFileSync(path.join(projectRepo, '.codex', 'config.toml'), 'utf-8');
    assert.equal(codexToml.split(CODEX_HOOKS_BEGIN_MARKER).length - 1, 1);
    assert.equal(codexToml.split('[mcp_servers.repovine]').length - 1, 1);
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
  it('each bundle ships exactly one hook file (the dispatcher)', async () => {
    const hooksDirs = [
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

  it('pins repovine@<version> in every bundle MCP config', async () => {
    const cursorMcp = JSON.parse(fs.readFileSync(path.join(bundleDir('cursor'), '.cursor', 'mcp.json'), 'utf-8'));
    assert.equal(cursorMcp.mcpServers.repovine.type, 'stdio');
    assert.deepEqual(cursorMcp.mcpServers.repovine.args, ['-y', `repovine@${pkgVersion}`]);

    const claudeMcp = JSON.parse(fs.readFileSync(path.join(bundleDir('claude'), '.mcp.json'), 'utf-8'));
    assert.ok(!('type' in claudeMcp.mcpServers.repovine), 'claude bundle MCP entry must not carry a type field');
    assert.deepEqual(claudeMcp.mcpServers.repovine.args, ['-y', `repovine@${pkgVersion}`]);

    const codexTomlPath = path.join(bundleDir('codex'), '.codex', 'config.toml');
    const codexLaunch = repovineLaunchFromParsedToml(readCodexConfig(codexTomlPath));
    assert.equal(codexLaunch.command, 'npx');
    assert.deepEqual(codexLaunch.args, ['-y', `repovine@${pkgVersion}`]);
    // The regex readers must agree with the real parse on the pinned launch.
    assert.deepEqual(repovineLaunchFromCodexTomlRegex(fs.readFileSync(codexTomlPath, 'utf-8')), codexLaunch);
  });

  it('claude bundle hooks are exec-form and address ${CLAUDE_PLUGIN_ROOT}', async () => {
    const hooks = readClaudeHooks(path.join(bundleDir('claude'), 'hooks', 'hooks.json'));
    assert.ok(hooks.length > 0);
    for (const hook of hooks) {
      assert.equal(hook.command, 'node');
      assert.equal(hook.args[0], `\${CLAUDE_PLUGIN_ROOT}/hooks/${CLIENT_DISPATCHER_FILENAME}`);
      assert.ok(hook.args.includes(hook.action), `args carry the ${hook.action} action`);
      assert.ok(![hook.command, ...hook.args].join(' ').includes('CLAUDE_PROJECT_DIR'), 'bundle entry must not address CLAUDE_PROJECT_DIR');
    }
  });

  it('codex bundle hooks address $PLUGIN_ROOT with a %PLUGIN_ROOT% Windows alternate', async () => {
    const hooks = readCodexHooks(path.join(bundleDir('codex'), '.codex', 'config.toml'));
    assert.ok(hooks.length > 0);
    for (const hook of hooks) {
      assert.ok(hook.command.includes('$PLUGIN_ROOT/'), `command addresses $PLUGIN_ROOT: ${hook.command}`);
      assert.ok(!hook.command.includes('$(git rev-parse'), 'bundle command must not resolve the root via git');
      assert.ok(hook.commandWindows !== undefined, 'codex bundle hook must declare command_windows');
      assert.ok(hook.commandWindows.includes('%PLUGIN_ROOT%/'), `command_windows addresses %PLUGIN_ROOT%: ${hook.commandWindows}`);
    }
  });

  it('cursor bundle hook strings are workspace-relative and cross-shell', async () => {
    const hooks = readCursorHooks(path.join(bundleDir('cursor'), '.cursor', 'hooks.json'));
    assert.ok(hooks.length > 0);
    for (const hook of hooks) {
      assert.doesNotMatch(hook.command, /[$\\]/);
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
  before(() => {
    launchRepo = makeFixtureRepo();
    cleanupDirs.push(launchRepo);
    // The local-launcher form a source-checkout setup emits: configs launch the
    // built dist entry verbatim, so the handshake runs exactly what they say.
    const opts = {
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
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    cfg.semantic_search_embeddings = false;
    fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

    // Remove the artifacts setup created: their reappearance after a handshake
    // proves the server bootstrapped this workspace, not some other root.
    fs.rmSync(path.join(launchRepo, '.repovine'), { recursive: true, force: true });
    fs.rmSync(path.join(launchRepo, 'repovine.annots.json'), { force: true });
  });

  async function handshakeAndAssert(server, rootValue, label) {
    const res = await mcpHandshake({
      command: server.command,
      args: server.args,
      cwd: launchRepo,
      env: { ...scrub, REPOVINE_ROOT: rootValue },
    });
    assert.ok(res.tools.length >= 18, `${label}: expected >= 18 tools, got ${res.tools.length}`);
    assert.equal(res.eofExit, true, `${label}: server must exit 0 on its own after stdin EOF`);
    assert.doesNotMatch(res.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/, `${label}: module resolution failed`);
    assert.deepEqual(nonJsonRpcFrames(res.stdout), [], `${label}: stdout must carry only JSON-RPC frames`);
    // Root-resolution proof under the spaced + non-ASCII path.
    if (!fs.existsSync(path.join(launchRepo, 'repovine.annots.json')) || !fs.existsSync(path.join(launchRepo, '.repovine'))) {
      throw new Error(`${label}: MCP start did not bootstrap workspace artifacts in ${launchRepo}`);
    }
  }

  it('cursor config launches and bootstraps the workspace (type:"stdio", ${workspaceFolder} root)', async () => {
    const mcp = JSON.parse(fs.readFileSync(path.join(launchRepo, '.cursor', 'mcp.json'), 'utf-8'));
    const server = mcp.mcpServers.repovine;
    assert.equal(server.type, 'stdio');
    assert.equal(server.command, process.execPath);
    // The client substitutes ${workspaceFolder}; the harness does the same before launch.
    const rootValue = server.env.REPOVINE_ROOT.replace('${workspaceFolder}', launchRepo);
    assert.equal(rootValue, launchRepo);
    await handshakeAndAssert(server, rootValue, 'cursor handshake');
  });

  it('claude config launches with REPOVINE_ROOT "." resolved against the workspace cwd', async () => {
    const mcp = JSON.parse(fs.readFileSync(path.join(launchRepo, '.mcp.json'), 'utf-8'));
    const server = mcp.mcpServers.repovine;
    assert.ok(!('type' in server), 'claude MCP entry must not carry a type field');
    assert.equal(server.command, process.execPath);
    await handshakeAndAssert(server, server.env.REPOVINE_ROOT, 'claude handshake');
  });

  it('codex config launches from the real TOML parse (backslash round-trip on win32)', async () => {
    const tomlPath = path.join(launchRepo, '.codex', 'config.toml');
    const launch = repovineLaunchFromParsedToml(readCodexConfig(tomlPath));
    // TOML basic-string escaping must round-trip the executable path exactly;
    // on win32 that path carries backslashes (and typically spaces).
    assert.equal(launch.command, process.execPath);
    assert.deepEqual(launch.args, [engineCli]);
    if (!isWin) {
      // The regex readers keep escape sequences verbatim, so agreement with the
      // real parse holds only for escape-free paths (any POSIX executable path).
      assert.deepEqual(repovineLaunchFromCodexTomlRegex(fs.readFileSync(tomlPath, 'utf-8')), launch);
    }
    await handshakeAndAssert({ command: launch.command, args: launch.args }, launch.root, 'codex handshake');
  });
});
