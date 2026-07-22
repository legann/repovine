/**
 * Identity predicates for repovine-managed hook entries in client configs.
 *
 * Setup (dedupe on re-run) and clear (removal) recognize the same entries:
 * the dispatcher form. User-defined hooks never match — including exec-form
 * user hooks whose command is plain `node` with unrelated args.
 */
import { CLIENT_DISPATCHER_FILENAME } from './index.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Managed Claude hook: dispatcher exec-form (command `node`, args[0] the
 * dispatcher path). The match requires the dispatcher file name in args[0];
 * `command === 'node'` alone never matches, so user-defined node hooks
 * survive dedupe and clear.
 */
export function isManagedClaudeHook(hook: unknown): boolean {
  if (!isRecord(hook) || typeof hook.command !== 'string') return false;
  return hook.command === 'node'
    && Array.isArray(hook.args)
    && typeof hook.args[0] === 'string'
    && hook.args[0].includes(CLIENT_DISPATCHER_FILENAME);
}

/** Managed Cursor hook command: the dispatcher shell string. */
export function isManagedCursorHookCommand(command: unknown): boolean {
  return typeof command === 'string' && command.includes(CLIENT_DISPATCHER_FILENAME);
}
