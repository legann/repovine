/**
 * Behavioral coverage for the client hook dispatcher's stale-graph-notice and
 * session-mcp-hint actions, per-client emit shapes, and CLI edge cases
 * (unknown action, malformed stdin). The boundary-notice action is covered in
 * boundary-notice-hook.test.ts. Each run spawns the dispatcher inside an ESM
 * project (package.json type:module).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { CLIENT_DISPATCHER_FILENAME, readClientDispatcherSource } from '../../../src/cli/dispatcher/index.js';

type Client = 'claude' | 'codex' | 'cursor';

describe('repovine-client-dispatcher', () => {
  let tmpDir: string;

  function runDispatcher(args: string[], stdin: string, env: Record<string, string> = {}) {
    const hookPath = path.join(tmpDir, CLIENT_DISPATCHER_FILENAME);
    fs.writeFileSync(hookPath, readClientDispatcherSource(), 'utf-8');
    return spawnSync(process.execPath, [hookPath, ...args], {
      input: stdin,
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir, ...env },
    });
  }

  function runAction(action: string, client: Client, payload: unknown, env: Record<string, string> = {}) {
    return runDispatcher([action, client], JSON.stringify(payload), env);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-dispatcher-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');
    fs.mkdirSync(path.join(tmpDir, '.repovine'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ships a shebang-first LF-only source', () => {
    const source = readClientDispatcherSource();
    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(source).not.toContain('\r');
  });

  it('exits 0 silently on an unknown action', () => {
    const res = runDispatcher(['made-up-action', 'claude'], '{}');
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('');
  });

  it('exits 0 silently on malformed stdin for edit-scoped actions', () => {
    for (const action of ['stale-graph-notice', 'boundary-notice']) {
      const res = runDispatcher([action, 'claude'], 'not json');
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe('');
    }
  });

  describe('stale-graph-notice', () => {
    it('emits the PostToolUse shape for claude and codex on a parsed-file edit', () => {
      for (const client of ['claude', 'codex'] as const) {
        const res = runAction('stale-graph-notice', client, {
          tool_input: { file_path: 'src/app.ts' },
        });
        expect(res.status).toBe(0);
        const out = JSON.parse(res.stdout.trim());
        expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
        expect(out.hookSpecificOutput.additionalContext).toContain('syntax index is now stale');
        expect(out.additional_context).toBeUndefined();
      }
    });

    it('emits the dual-key afterFileEdit shape for cursor, from camelCase payload keys', () => {
      const res = runAction('stale-graph-notice', 'cursor', {
        changedFiles: [{ path: 'src/app.ts' }],
      }, { CURSOR_WORKSPACE_ROOT: tmpDir });
      expect(res.status).toBe(0);
      const out = JSON.parse(res.stdout.trim());
      expect(out.additional_context).toContain('syntax index is now stale');
      expect(out.hookSpecificOutput.hookEventName).toBe('afterFileEdit');
    });

    it('stays silent for engine-owned and unparsed files', () => {
      for (const filePath of ['repovine.annots.json', '.repovine/graph.json', 'notes.txt']) {
        const res = runAction('stale-graph-notice', 'claude', { tool_input: { file_path: filePath } });
        expect(res.status).toBe(0);
        expect(res.stdout.trim()).toBe('');
      }
    });

    it('emits the annotation-conflict hint after a git merge command', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'repovine.annots.json'),
        '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> theirs\n',
        'utf-8',
      );
      const claude = runAction('stale-graph-notice', 'claude', { tool_input: { command: 'git merge main' } });
      expect(claude.status).toBe(0);
      const claudeOut = JSON.parse(claude.stdout.trim());
      expect(claudeOut.hookSpecificOutput.hookEventName).toBe('PostToolUse');
      expect(claudeOut.hookSpecificOutput.additionalContext).toContain('contains conflict markers');
      expect(claudeOut.hookSpecificOutput.additionalContext).toContain('merge_annotations');

      const cursor = runAction('stale-graph-notice', 'cursor', { command: 'git pull' }, { CURSOR_WORKSPACE_ROOT: tmpDir });
      expect(cursor.status).toBe(0);
      const cursorOut = JSON.parse(cursor.stdout.trim());
      expect(cursorOut.hookSpecificOutput.hookEventName).toBe('afterShellExecution');
      expect(cursorOut.additional_context).toContain('contains conflict markers');
    });
  });

  describe('session-mcp-hint', () => {
    it('emits the SessionStart hint for claude with the domains advisor contract', () => {
      const res = runAction('session-mcp-hint', 'claude', {});
      expect(res.status).toBe(0);
      const out = JSON.parse(res.stdout.trim());
      expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
      const context = out.hookSpecificOutput.additionalContext as string;
      expect(context).toContain('repovine MCP is available');
      expect(context).toContain('never auto-apply');
      expect(context).toContain('for skip/hide, call decline_advisory');
      expect(context).toContain('domains-config');
      expect(context).toContain('.repovine/onboarding-state.json');
      expect(out.additional_context).toBeUndefined();
    });

    it('emits the dual-key sessionStart shape for cursor', () => {
      const res = runAction('session-mcp-hint', 'cursor', {}, { CURSOR_WORKSPACE_ROOT: tmpDir });
      expect(res.status).toBe(0);
      const out = JSON.parse(res.stdout.trim());
      expect(out.hookSpecificOutput.hookEventName).toBe('sessionStart');
      expect(out.additional_context).toContain('repovine MCP is available');
    });

    it('stays silent on compact session resumes', () => {
      const res = runAction('session-mcp-hint', 'claude', { source: 'compact' });
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe('');
    });

    it('still emits on malformed stdin (empty-payload degradation)', () => {
      const res = runDispatcher(['session-mcp-hint', 'claude'], 'not json');
      expect(res.status).toBe(0);
      const out = JSON.parse(res.stdout.trim());
      expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    });

    it('appends onboarding-state and annotation-conflict hints when present', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.repovine', 'onboarding-state.json'),
        JSON.stringify({ graph: { built: true }, onboarding: { pending: 2 } }),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(tmpDir, 'repovine.annots.json'),
        '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> theirs\n',
        'utf-8',
      );
      const res = runAction('session-mcp-hint', 'claude', {});
      expect(res.status).toBe(0);
      const context = JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext as string;
      expect(context).toContain('Onboarding state:');
      expect(context).toContain('Annotation maintenance: repovine.annots.json currently contains conflict markers');
    });
  });

  it('defaults to the claude shape when the client argument is missing', () => {
    const res = runDispatcher(['session-mcp-hint'], '{}');
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout.trim());
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.additional_context).toBeUndefined();
  });
});
