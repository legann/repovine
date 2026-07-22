/**
 * Locks the per-client contract facts in CLIENT_CAPABILITIES and the exact
 * strings the templates derive from them (independent pins — the templates'
 * own consumers regenerate from the same constants and would track drift).
 */
import { describe, expect, it } from '@jest/globals';
import {
  CLIENT_CAPABILITIES,
  CODEX_WINDOWS_PLUGIN_ROOT_REF,
  HOOK_ACTIONS,
  hookDispatcherPath,
  shellHookCommand,
} from '../../../src/cli/client-capabilities.js';
import {
  CLAUDE_HOOKS_SETTINGS,
  CURSOR_HOOKS_SETTINGS,
  buildClaudeHooksSettings,
  buildCodexHooksBlock,
  buildClaudeMcpServer,
  buildCursorMcpServer,
} from '../../../src/cli/templates.js';

describe('CLIENT_CAPABILITIES contract facts', () => {
  it('locks the Claude hook contract (exec-form, no Windows override)', () => {
    const claude = CLIENT_CAPABILITIES.claude.hooks;
    expect(claude.commandForm).toBe('exec-or-shell');
    expect(claude.supportsShellField).toBe(true);
    expect(claude.windowsOverrideField).toBeNull();
    expect(claude.projectRootExpr).toBe('${CLAUDE_PROJECT_DIR}');
    expect(claude.pluginRootExpr).toBe('${CLAUDE_PLUGIN_ROOT}');
  });

  it('locks the Cursor hook contract (shell-string, workspace-relative, no plugin root)', () => {
    const cursor = CLIENT_CAPABILITIES.cursor.hooks;
    expect(cursor.commandForm).toBe('shell-string');
    expect(cursor.supportsShellField).toBe(false);
    expect(cursor.windowsOverrideField).toBeNull();
    expect(cursor.projectRootExpr).toBeNull();
    expect(cursor.pluginRootExpr).toBeNull();
  });

  it('locks the Codex hook contract (shell-string + command_windows)', () => {
    const codex = CLIENT_CAPABILITIES.codex.hooks;
    expect(codex.commandForm).toBe('shell-string');
    expect(codex.windowsOverrideField).toBe('command_windows');
    expect(codex.projectRootExpr).toBe('$(git rev-parse --show-toplevel)');
    expect(codex.pluginRootExpr).toBe('$PLUGIN_ROOT');
    expect(CODEX_WINDOWS_PLUGIN_ROOT_REF).toBe('%PLUGIN_ROOT%');
  });

  it('locks the MCP contracts (Cursor requires type:"stdio")', () => {
    expect(CLIENT_CAPABILITIES.cursor.mcp.stdioTypeField).toBe('required');
    expect(CLIENT_CAPABILITIES.claude.mcp.stdioTypeField).toBe('optional');
    expect(CLIENT_CAPABILITIES.codex.mcp.stdioTypeField).toBe('absent');
    expect(CLIENT_CAPABILITIES.cursor.mcp.projectRootValue).toBe('${workspaceFolder}');
    expect(CLIENT_CAPABILITIES.claude.mcp.projectRootValue).toBe('.');
    expect(CLIENT_CAPABILITIES.codex.mcp.projectRootValue).toBe('.');
  });
});

describe('dispatcher addressing helpers', () => {
  it('renders exact shell commands per client and scope', () => {
    expect(shellHookCommand('cursor', 'project', 'boundary-notice'))
      .toBe('node ".cursor/hooks/repovine-client-dispatcher.mjs" boundary-notice cursor');
    expect(shellHookCommand('codex', 'project', 'stale-graph-notice'))
      .toBe('node "$(git rev-parse --show-toplevel)/.codex/hooks/repovine-client-dispatcher.mjs" stale-graph-notice codex');
    expect(shellHookCommand('codex', 'plugin', 'session-mcp-hint'))
      .toBe('node "$PLUGIN_ROOT/.codex/hooks/repovine-client-dispatcher.mjs" session-mcp-hint codex');
    expect(shellHookCommand('claude', 'project', 'boundary-notice'))
      .toBe('node "${CLAUDE_PROJECT_DIR}/.claude/hooks/repovine-client-dispatcher.mjs" boundary-notice claude');
    expect(shellHookCommand('claude', 'plugin', 'boundary-notice'))
      .toBe('node "${CLAUDE_PLUGIN_ROOT}/hooks/repovine-client-dispatcher.mjs" boundary-notice claude');
  });

  it('renders dispatcher paths and throws for cursor plugin scope', () => {
    expect(hookDispatcherPath('cursor', 'project')).toBe('.cursor/hooks/repovine-client-dispatcher.mjs');
    expect(hookDispatcherPath('claude', 'plugin')).toBe('${CLAUDE_PLUGIN_ROOT}/hooks/repovine-client-dispatcher.mjs');
    expect(() => hookDispatcherPath('cursor', 'plugin')).toThrow(/plugin install root/);
  });

  it('serves exactly the three advisory actions', () => {
    expect([...HOOK_ACTIONS]).toEqual(['boundary-notice', 'stale-graph-notice', 'session-mcp-hint']);
  });
});

describe('derived template bytes (golden)', () => {
  it('CURSOR_HOOKS_SETTINGS serializes to the exact hooks.json bytes', () => {
    expect(`${JSON.stringify(CURSOR_HOOKS_SETTINGS, null, 2)}\n`).toBe(`{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "command": "node \\".cursor/hooks/repovine-client-dispatcher.mjs\\" boundary-notice cursor"
      }
    ],
    "afterFileEdit": [
      {
        "command": "node \\".cursor/hooks/repovine-client-dispatcher.mjs\\" stale-graph-notice cursor"
      }
    ],
    "afterShellExecution": [
      {
        "command": "node \\".cursor/hooks/repovine-client-dispatcher.mjs\\" stale-graph-notice cursor"
      }
    ],
    "sessionStart": [
      {
        "command": "node \\".cursor/hooks/repovine-client-dispatcher.mjs\\" session-mcp-hint cursor"
      }
    ]
  }
}
`);
  });

  it('CLAUDE_HOOKS_SETTINGS serializes to the exact settings.json hooks bytes', () => {
    expect(`${JSON.stringify({ hooks: CLAUDE_HOOKS_SETTINGS }, null, 2)}\n`).toBe(`{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": [
              "\${CLAUDE_PROJECT_DIR}/.claude/hooks/repovine-client-dispatcher.mjs",
              "boundary-notice",
              "claude"
            ]
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": [
              "\${CLAUDE_PROJECT_DIR}/.claude/hooks/repovine-client-dispatcher.mjs",
              "stale-graph-notice",
              "claude"
            ]
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": [
              "\${CLAUDE_PROJECT_DIR}/.claude/hooks/repovine-client-dispatcher.mjs",
              "session-mcp-hint",
              "claude"
            ]
          }
        ]
      }
    ]
  }
}
`);
  });

  it('SessionStart entries carry no matcher key and hooks carry no shell key', () => {
    expect(Object.keys(CLAUDE_HOOKS_SETTINGS.SessionStart[0]!)).toEqual(['hooks']);
    for (const scope of ['project', 'plugin'] as const) {
      for (const entries of Object.values(buildClaudeHooksSettings(scope))) {
        for (const entry of entries) {
          for (const hook of entry.hooks) {
            expect(Object.keys(hook)).toEqual(['type', 'command', 'args']);
          }
        }
      }
    }
  });

  it('buildCodexHooksBlock renders the exact managed TOML block', () => {
    expect(buildCodexHooksBlock()).toBe(`# repovine hooks (managed by: npx repovine setup codex)
# BEGIN repovine hooks
[[hooks.PreToolUse]]
matcher = "Edit|Write|NotebookEdit|apply_patch"

[[hooks.PreToolUse.hooks]]
type = "command"
command = 'node "$(git rev-parse --show-toplevel)/.codex/hooks/repovine-client-dispatcher.mjs" boundary-notice codex'
command_windows = 'node ".codex/hooks/repovine-client-dispatcher.mjs" boundary-notice codex'
timeout = 5
statusMessage = "Checking repovine boundary surface"

[[hooks.PostToolUse]]
matcher = "Edit|Write|NotebookEdit|apply_patch|Bash"

[[hooks.PostToolUse.hooks]]
type = "command"
command = 'node "$(git rev-parse --show-toplevel)/.codex/hooks/repovine-client-dispatcher.mjs" stale-graph-notice codex'
command_windows = 'node ".codex/hooks/repovine-client-dispatcher.mjs" stale-graph-notice codex'
timeout = 5
statusMessage = "Checking repovine graph freshness"

[[hooks.SessionStart]]
matcher = "startup|resume|clear"

[[hooks.SessionStart.hooks]]
type = "command"
command = 'node "$(git rev-parse --show-toplevel)/.codex/hooks/repovine-client-dispatcher.mjs" session-mcp-hint codex'
command_windows = 'node ".codex/hooks/repovine-client-dispatcher.mjs" session-mcp-hint codex'
timeout = 5
statusMessage = "Loading repovine MCP reminder"
# END repovine hooks
`);
  });

  it('cursor MCP server carries type:"stdio" as the first key; claude does not gain one', () => {
    const cursor = buildCursorMcpServer();
    expect(Object.keys(cursor)[0]).toBe('type');
    expect(cursor.type).toBe('stdio');
    expect(buildClaudeMcpServer()).not.toHaveProperty('type');
  });
});
