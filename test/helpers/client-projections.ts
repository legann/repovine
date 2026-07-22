/**
 * Helpers for the behavioral client-projection suite
 * (test/integration/client-projections.test.ts).
 *
 * Hook execution is config-driven: the suite parses the generated wiring files
 * (.cursor/hooks.json, .claude/settings.json or plugin hooks/hooks.json,
 * .codex/config.toml) and executes every hook entry they declare, using each
 * client's own launch contract (exec-form spawn, POSIX shell string, or
 * cmd.exe string). Nothing here names a concrete hook script file.
 */
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { HOOK_ACTIONS, type HookAction } from '../../src/cli/client-capabilities.js';

// ---------------------------------------------------------------------------
// Environment scrubbing
// ---------------------------------------------------------------------------

/**
 * Client/session variables removed from the base environment before per-case
 * variables are added. The machine running the suite may itself be inside a
 * client session; a leaked CLAUDE_PROJECT_DIR or CURSOR_WORKSPACE_ROOT would
 * silently redirect hook root resolution away from the fixture repo.
 * Case-insensitive: Windows environment variable names are case-insensitive.
 */
const SCRUBBED_ENV_KEY = /^(claude_|cursor_|repovine_|plugin_root$)/i;

export function makeScrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SCRUBBED_ENV_KEY.test(key)) continue;
    env[key] = value;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Fixture repos
// ---------------------------------------------------------------------------

/**
 * Temp-dir prefix: spaces + non-ASCII exercise path quoting in every hook
 * command and MCP launch. No cmd metacharacters and no `%` — cmd.exe command
 * lines cannot carry them safely.
 */
export const FIXTURE_PREFIX = 'repovine proj ünï-';

function git(cwd: string, args: string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (status ${res.status}): ${res.stderr}`);
  }
}

/**
 * Minimal TS repo: package.json, two source files, one git commit. The commit
 * makes `git rev-parse --show-toplevel` (Codex project hook commands) resolve
 * to the fixture root. realpathSync keeps later path comparisons stable on
 * platforms where the temp dir is a symlink (macOS /var → /private/var).
 */
export function makeFixtureRepo(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), FIXTURE_PREFIX)));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"client-projections-fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const hello = (name: string): string => `hi ${name}`;\n');
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const app = (): string => "app";\n');
  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  git(root, [
    '-c', 'user.name=fixture',
    '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', 'init',
  ]);
  return root;
}

/** Risk string carried by the synthetic boundary entry for src/app.ts. */
export const BOUNDARY_RISK = 'published contract';

/**
 * Synthetic engine state the hooks read: a v1 boundary index marking
 * src/app.ts and an onboarding-state snapshot for the session hint. Hooks need
 * no built graph — these files are their entire input surface.
 */
export function writeSyntheticEngineState(root: string): void {
  const dir = path.join(root, '.repovine');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'boundary-index.json'),
    `${JSON.stringify({
      version: 1,
      entries: { 'src/app.ts': [{ nodeId: 'n1', label: 'app', risks: [BOUNDARY_RISK] }] },
    }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'onboarding-state.json'),
    `${JSON.stringify({ graph: { built: true }, onboarding: { annotatedModules: 0 } }, null, 2)}\n`,
  );
}

/** Annotations-file content carrying git conflict markers (merge-hint cases). */
export const CONFLICT_ANNOTATIONS = [
  '{',
  '<<<<<<< HEAD',
  '  "version": 1',
  '=======',
  '  "version": 2',
  '>>>>>>> feature',
  '}',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Wiring-file parsing
// ---------------------------------------------------------------------------

/** One hook entry as a client wiring file declares it. */
export interface DeclaredHook {
  /** Event key the entry is registered under (client-native casing). */
  event: string;
  /** Dispatcher action the entry invokes. */
  action: HookAction;
  /** Shell string, or the exec-form command when `args` is present. */
  command: string;
  /** Exec-form argument vector (Claude entries). */
  args?: string[];
  /** Full alternate Windows command (Codex `command_windows`). */
  commandWindows?: string;
}

/** The single dispatcher action a hook entry invokes; ambiguity is a wiring bug. */
export function hookActionOf(text: string): HookAction {
  const found = HOOK_ACTIONS.filter(action => text.includes(action));
  if (found.length !== 1) {
    throw new Error(`Expected exactly one dispatcher action in hook entry, found [${found.join(', ')}]: ${text}`);
  }
  return found[0]!;
}

/** Parse `.cursor/hooks.json`: `{ version, hooks: { <event>: [{ command }] } }`. */
export function readCursorHooks(filePath: string): DeclaredHook[] {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { hooks?: Record<string, unknown> };
  const out: DeclaredHook[] = [];
  for (const [event, entries] of Object.entries(parsed.hooks ?? {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as Array<{ command?: unknown }>) {
      if (typeof entry.command !== 'string') {
        throw new Error(`Cursor hook entry under ${event} has no string command: ${JSON.stringify(entry)}`);
      }
      out.push({ event, action: hookActionOf(entry.command), command: entry.command });
    }
  }
  return out;
}

/**
 * Parse Claude hook wiring. Project settings nest the event map under a
 * `hooks` key (`.claude/settings.json`); the plugin `hooks/hooks.json` is the
 * event map itself.
 */
export function readClaudeHooks(filePath: string): DeclaredHook[] {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  const events = (
    parsed.hooks && typeof parsed.hooks === 'object' && !Array.isArray(parsed.hooks) ? parsed.hooks : parsed
  ) as Record<string, unknown>;
  const out: DeclaredHook[] = [];
  for (const [event, entries] of Object.entries(events)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as Array<{ hooks?: unknown }>) {
      if (!Array.isArray(entry.hooks)) continue;
      for (const hook of entry.hooks as Array<{ command?: unknown; args?: unknown }>) {
        if (typeof hook.command !== 'string') {
          throw new Error(`Claude hook under ${event} has no string command: ${JSON.stringify(hook)}`);
        }
        const args = Array.isArray(hook.args) ? hook.args.map(String) : undefined;
        out.push({
          event,
          action: hookActionOf([hook.command, ...(args ?? [])].join(' ')),
          command: hook.command,
          ...(args ? { args } : {}),
        });
      }
    }
  }
  return out;
}

/** Parse a Codex `config.toml` into a plain record (real TOML parse). */
export function readCodexConfig(filePath: string): Record<string, unknown> {
  return parseToml(fs.readFileSync(filePath, 'utf-8')) as unknown as Record<string, unknown>;
}

/** Parse `[[hooks.<Event>]]` / `[[hooks.<Event>.hooks]]` tables from Codex config. */
export function readCodexHooks(filePath: string): DeclaredHook[] {
  const parsed = readCodexConfig(filePath);
  const hooksTable = parsed.hooks;
  if (!hooksTable || typeof hooksTable !== 'object') {
    throw new Error(`${filePath} declares no [[hooks.*]] tables`);
  }
  const out: DeclaredHook[] = [];
  for (const [event, entries] of Object.entries(hooksTable as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as Array<{ hooks?: unknown }>) {
      if (!Array.isArray(entry.hooks)) continue;
      for (const hook of entry.hooks as Array<Record<string, unknown>>) {
        if (typeof hook.command !== 'string') {
          throw new Error(`Codex hook under ${event} has no string command: ${JSON.stringify(hook)}`);
        }
        out.push({
          event,
          action: hookActionOf(hook.command),
          command: hook.command,
          ...(typeof hook.command_windows === 'string' ? { commandWindows: hook.command_windows } : {}),
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Codex MCP launch extraction (real parse + regex mirror)
// ---------------------------------------------------------------------------

export interface RepovineLaunch {
  command?: string;
  args?: string[];
  root?: string;
}

/** `mcp_servers.repovine` launch fields from a real TOML parse. */
export function repovineLaunchFromParsedToml(parsed: Record<string, unknown>): RepovineLaunch {
  const servers = parsed.mcp_servers as Record<string, unknown> | undefined;
  const entry = servers?.repovine as Record<string, unknown> | undefined;
  if (!entry) return {};
  const env = entry.env as Record<string, unknown> | undefined;
  return {
    ...(typeof entry.command === 'string' ? { command: entry.command } : {}),
    ...(Array.isArray(entry.args) ? { args: entry.args.filter((a): a is string => typeof a === 'string') } : {}),
    ...(env && typeof env.REPOVINE_ROOT === 'string' ? { root: env.REPOVINE_ROOT } : {}),
  };
}

/**
 * The engine reads Codex TOML with regular expressions (doctor's launch
 * inspection and the config merge path), accepting double-quoted basic strings
 * and a single-line args array. This mirror extracts with the same patterns;
 * agreement with the real TOML parse pins the generated config inside that
 * regex-readable subset.
 */
export function repovineLaunchFromCodexTomlRegex(content: string): RepovineLaunch {
  const block = /\[mcp_servers\.repovine\]([\s\S]*?)(?=\n\[|$)/.exec(content);
  if (!block) return {};
  const command = /command\s*=\s*"([^"]+)"/.exec(block[1] ?? '')?.[1];
  const argsRaw = /args\s*=\s*\[([^\]]*)\]/.exec(block[1] ?? '')?.[1] ?? '';
  const args = [...argsRaw.matchAll(/"([^"]+)"/g)].map(m => m[1]!);
  const envBlock = /\[mcp_servers\.repovine\.env\]([\s\S]*?)(?=\n\[|$)/.exec(content);
  const root = envBlock ? /REPOVINE_ROOT\s*=\s*"([^"]+)"/.exec(envBlock[1] ?? '')?.[1] : undefined;
  return {
    ...(command !== undefined ? { command } : {}),
    ...(args.length > 0 ? { args } : {}),
    ...(root !== undefined ? { root } : {}),
  };
}

// ---------------------------------------------------------------------------
// Hook execution
// ---------------------------------------------------------------------------

export interface HookExecution {
  /** Project/workspace root the hook acts on; always the child cwd. */
  cwd: string;
  /** Full child environment (scrubbed base + the client's documented variables). */
  env: NodeJS.ProcessEnv;
  /** `${VAR}` values substituted into exec-form command/args, as the client substitutes them. */
  substitutions?: Record<string, string>;
}

export interface HookRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Parsed stdout object, or null when the hook stayed silent. */
  message: Record<string, unknown> | null;
}

function substituteTokens(value: string, substitutions: Record<string, string>): string {
  let out = value;
  for (const [token, replacement] of Object.entries(substitutions)) {
    out = out.split(token).join(replacement);
  }
  if (/\$\{[A-Z_]+\}/.test(out)) {
    throw new Error(`Unsubstituted variable reference in exec-form hook entry: ${out}`);
  }
  return out;
}

/**
 * Execute one declared hook entry with a stdin payload, per launch form:
 * - exec-form (`args` present): direct spawn, no shell, after `${VAR}` substitution;
 * - shell string on POSIX: `/bin/sh -c <command>`;
 * - shell string on win32: `%ComSpec% /d /s /c "<command>"` — `command_windows`
 *   when the entry declares one, else the same string. `/s` plus outer quotes
 *   plus windowsVerbatimArguments survives quoted paths with spaces.
 */
export function runDeclaredHook(hook: DeclaredHook, payload: unknown, exec: HookExecution): HookRunResult {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const common = { cwd: exec.cwd, env: exec.env, input, encoding: 'utf-8' as const };
  let res: SpawnSyncReturns<string>;
  if (hook.args) {
    const subs = exec.substitutions ?? {};
    const command = substituteTokens(hook.command, subs);
    const args = hook.args.map(a => substituteTokens(a, subs));
    // The client resolves `node` from PATH; the harness pins it to the running executable.
    res = spawnSync(command === 'node' ? process.execPath : command, args, common);
  } else if (process.platform === 'win32') {
    const command = hook.commandWindows ?? hook.command;
    res = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
      ...common,
      windowsVerbatimArguments: true,
    });
  } else {
    res = spawnSync('/bin/sh', ['-c', hook.command], common);
  }
  if (res.error) throw res.error;

  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';
  let message: Record<string, unknown> | null = null;
  if (stdout !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`Hook stdout must be empty or one JSON object, got: ${stdout.slice(0, 400)}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Hook stdout must be a JSON object, got: ${stdout.slice(0, 400)}`);
    }
    message = parsed as Record<string, unknown>;
  }
  return { status: res.status, stdout, stderr, message };
}

/**
 * Advisory hooks never block the client: every run must exit 0 with an empty
 * stderr. Throws with the full diagnosis; a bare status diff from a CI runner
 * is undebuggable from the log alone.
 */
export function expectAdvisoryExit(result: HookRunResult, label: string): void {
  if (result.status === 0 && result.stderr === '') return;
  throw new Error(
    `${label}: expected exit 0 with empty stderr, got status=${result.status}\n` +
      `stderr:\n${result.stderr.slice(0, 1200)}\n` +
      `stdout:\n${result.stdout.slice(0, 400)}`,
  );
}

// ---------------------------------------------------------------------------
// Engine CLI (blackbox)
// ---------------------------------------------------------------------------

/** Spawn the built engine CLI (dist/mcp/index.js) against a workspace root. */
export function runEngineCli(
  engineCli: string,
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [engineCli, ...argv], {
    cwd,
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** Exit-0 assertion carrying the diagnosis (signal, spawn error, stderr tail). */
export function expectCliExit0(res: SpawnSyncReturns<string>, label: string): void {
  if (res.status === 0) return;
  throw new Error(
    `${label}: exited status=${res.status} signal=${res.signal} spawnError=${res.error?.message ?? 'none'}\n` +
      `stderr tail:\n${(res.stderr ?? '').slice(-1200)}`,
  );
}

// ---------------------------------------------------------------------------
// MCP handshake
// ---------------------------------------------------------------------------

export interface McpLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface McpHandshakeResult {
  tools: Array<{ name?: string }>;
  stdout: string;
  stderr: string;
  /** True when the server exited 0 on its own after stdin EOF (host-disconnect lifecycle). */
  eofExit: boolean;
}

/**
 * Drive one MCP session over stdio exactly as a client does: initialize →
 * notifications/initialized → tools/list, then close stdin and wait for a
 * clean exit. Launches the config's own command verbatim.
 */
export function mcpHandshake(launch: McpLaunchSpec): Promise<McpHandshakeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let tools: Array<{ name?: string }> | undefined;
    let eofTimedOut = false;
    let eofTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`MCP server did not answer in 90s. stderr: ${stderr.slice(0, 500)}`));
    }, 90_000);

    child.stdout.on('data', (d: Buffer) => {
      // Any throw inside a stream 'data' handler is an uncaughtException that
      // kills the jest worker (exit 1, silent retry loop) — the whole body
      // stays inside try, and every parse result is object-guarded before
      // property access (JSON.parse('null') succeeds and then `.id` throws).
      try {
        stdout += d;
        for (const line of stdout.split('\n')) {
          let message: unknown;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (
            message !== null
            && typeof message === 'object'
            && (message as { id?: number }).id === 2
            && tools === undefined
          ) {
            clearTimeout(timer);
            tools = (message as { result?: { tools?: Array<{ name?: string }> } }).result?.tools ?? [];
            child.stdin.end();
            // Generous EOF window: the fixture server drains a cold bootstrap
            // on shutdown, and a slow CI runner must not convert that into a
            // SIGKILL race. A miss still fails visibly via eofExit: false.
            eofTimer = setTimeout(() => {
              eofTimedOut = true;
              child.kill('SIGKILL');
            }, 60_000);
          }
        }
      } catch (err) {
        clearTimeout(timer);
        if (eofTimer) clearTimeout(eofTimer);
        child.kill('SIGKILL');
        reject(err as Error);
      }
    });
    child.stderr.on('data', (d: Buffer) => { stderr += d; });
    child.on('error', reject);
    // Stream errors are NOT covered by child.on('error'): an 'error' event on
    // any stdio stream (stdin EPIPE after early child death, read-side pipe
    // errors after a SIGKILL with in-flight I/O) is an uncaughtException that
    // kills the jest worker. Swallow them on all three streams; the 'close'
    // handler reports the real failure with the child's stderr.
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    // 'close', not 'exit': stdio can still hold buffered data at 'exit', and the
    // stdout-purity check must see everything written during the shutdown window.
    child.on('close', (code) => {
      clearTimeout(timer);
      if (eofTimer) clearTimeout(eofTimer);
      if (tools !== undefined) {
        resolve({ tools, stderr, stdout, eofExit: !eofTimedOut && code === 0 });
      } else {
        reject(new Error(`MCP server exited with ${code} before tools/list. stderr: ${stderr.slice(0, 500)}`));
      }
    });

    for (const request of [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'client-projections', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
    }
  });
}

/**
 * Lines on an MCP stdout stream that are not JSON-RPC 2.0 frames. Drops a
 * possibly-partial trailing fragment; JSON.parse tolerates a trailing \r on
 * CRLF frames.
 */
export function nonJsonRpcFrames(stdout: string): string[] {
  const frames = stdout.split('\n');
  frames.pop();
  return frames
    .filter(line => line.trim() !== '')
    .filter(line => {
      try {
        return (JSON.parse(line) as { jsonrpc?: string }).jsonrpc !== '2.0';
      } catch {
        return true;
      }
    });
}
