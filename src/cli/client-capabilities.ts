/**
 * Per-client integration contracts for the generated hook and MCP projections.
 *
 * `CLIENT_CAPABILITIES` records each supported client's hook paths, root
 * expressions, and MCP server shape. Template builders, plugin rendering,
 * setup, and health derive their client-specific strings from this descriptor;
 * the values state each client's own contract. `commandForm`,
 * `supportsShellField`, and `windowsOverrideField` describe the launch form for
 * a reader; each renderer emits its client's form directly.
 */
import { CLIENT_DISPATCHER_FILENAME } from './dispatcher/index.js';

/** Client identifier. Same union as PluginClient (plugin-render) and DoctorClient (client-scope). */
export type ClientId = 'cursor' | 'claude' | 'codex';

/** Hook actions the client dispatcher serves; each maps to one advisory channel. */
export const HOOK_ACTIONS = ['boundary-notice', 'stale-graph-notice', 'session-mcp-hint'] as const;
export type HookAction = (typeof HOOK_ACTIONS)[number];

export interface ClientHookContract {
  /**
   * `exec-or-shell`: hook entries accept `command` + `args`; when `args` is
   * present the client spawns the command directly (no shell) and substitutes
   * `${VAR}` references itself. `shell-string`: `command` is a single shell line.
   */
  commandForm: 'shell-string' | 'exec-or-shell';
  /** Config key carrying a full alternate command for Windows, when the client defines one. */
  windowsOverrideField: 'command_windows' | null;
  /** The client accepts an explicit `shell` field on hook entries (ignored when `args` is present). */
  supportsShellField: boolean;
  /**
   * Expression the client resolves to the project root inside hook commands.
   * `null`: hook commands resolve relative to the workspace root and carry no
   * root expression.
   */
  projectRootExpr: string | null;
  /** Directory holding project-scope hook files, relative to the workspace root. */
  projectScriptsDir: string;
  /**
   * Expression the client resolves to the plugin install root. `null`: the
   * client defines no plugin-install-root variable; plugin hooks use the
   * project (workspace-relative) form.
   */
  pluginRootExpr: string | null;
  /** Directory holding plugin-scope hook files, relative to the plugin root; null when pluginRootExpr is null. */
  pluginScriptsDir: string | null;
}

export interface ClientMcpContract {
  /** Config format of the client's MCP server declaration. */
  format: 'json' | 'toml';
  /** Whether the server entry carries `type: "stdio"`: required by the client's schema, optional, or absent from it. */
  stdioTypeField: 'required' | 'optional' | 'absent';
  /** Value of the REPOVINE_ROOT env var in the generated project-scope MCP config. */
  projectRootValue: string;
}

export interface ClientCapabilities {
  hooks: ClientHookContract;
  mcp: ClientMcpContract;
}

export const CLIENT_CAPABILITIES: Record<ClientId, ClientCapabilities> = {
  claude: {
    // Claude Code hooks accept exec-form entries (command + args, no shell) or
    // shell strings; ${VAR} in command/args is substituted by the client.
    hooks: {
      commandForm: 'exec-or-shell',
      windowsOverrideField: null,
      supportsShellField: true,
      projectRootExpr: '${CLAUDE_PROJECT_DIR}',
      projectScriptsDir: '.claude/hooks',
      pluginRootExpr: '${CLAUDE_PLUGIN_ROOT}',
      pluginScriptsDir: 'hooks',
    },
    mcp: { format: 'json', stdioTypeField: 'optional', projectRootValue: '.' },
  },
  cursor: {
    // Cursor hooks are shell strings resolved against the workspace root; it
    // defines no plugin-install-root variable and no Windows override field.
    // Cursor's MCP schema requires type:"stdio" on stdio servers.
    hooks: {
      commandForm: 'shell-string',
      windowsOverrideField: null,
      supportsShellField: false,
      projectRootExpr: null,
      projectScriptsDir: '.cursor/hooks',
      pluginRootExpr: null,
      pluginScriptsDir: null,
    },
    mcp: { format: 'json', stdioTypeField: 'required', projectRootValue: '${workspaceFolder}' },
  },
  codex: {
    // Codex hooks are shell strings (TOML) with an optional `command_windows`
    // sibling carrying a full alternate Windows command. Project hooks resolve
    // the repo root through the shell; plugin hooks use $PLUGIN_ROOT.
    hooks: {
      commandForm: 'shell-string',
      windowsOverrideField: 'command_windows',
      supportsShellField: false,
      projectRootExpr: '$(git rev-parse --show-toplevel)',
      projectScriptsDir: '.codex/hooks',
      pluginRootExpr: '$PLUGIN_ROOT',
      pluginScriptsDir: '.codex/hooks',
    },
    mcp: { format: 'toml', stdioTypeField: 'absent', projectRootValue: '.' },
  },
};

/**
 * Windows (cmd-style) reference to the Codex plugin install root, used in
 * `command_windows` values inside the Codex plugin bundle. Verification of the
 * interpolation syntax on a real Windows Codex client is pending; the
 * reference lives in one constant so a syntax correction is a one-line change.
 */
export const CODEX_WINDOWS_PLUGIN_ROOT_REF = '%PLUGIN_ROOT%';

export type HookScope = 'project' | 'plugin';

/** Path of the dispatcher file as the client addresses it in the given scope. */
export function hookDispatcherPath(client: ClientId, scope: HookScope): string {
  const hooks = CLIENT_CAPABILITIES[client].hooks;
  if (scope === 'project') {
    return hooks.projectRootExpr === null
      ? `${hooks.projectScriptsDir}/${CLIENT_DISPATCHER_FILENAME}`
      : `${hooks.projectRootExpr}/${hooks.projectScriptsDir}/${CLIENT_DISPATCHER_FILENAME}`;
  }
  if (hooks.pluginRootExpr === null || hooks.pluginScriptsDir === null) {
    throw new Error(`${client} defines no plugin install root; plugin hooks use the project (workspace-relative) form`);
  }
  return `${hooks.pluginRootExpr}/${hooks.pluginScriptsDir}/${CLIENT_DISPATCHER_FILENAME}`;
}

/** Shell-string dispatcher invocation for one hook action in the given scope. */
export function shellHookCommand(client: ClientId, scope: HookScope, action: HookAction): string {
  return `node "${hookDispatcherPath(client, scope)}" ${action} ${client}`;
}
