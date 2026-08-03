import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { CLIENT_DISPATCHER_FILENAME, readClientDispatcherSource } from '../../../src/cli/dispatcher/index.js';

/**
 * End-to-end smoke for the boundary-notice action of the client hook dispatcher: write the
 * dispatcher into an ESM project (package.json type:module — the strict case where a `require`
 * in the hook would crash), feed it a tool_input over stdin, and assert the advisory it prints.
 * Validates ESM compatibility, the file→relPath normalization, and the additionalContext JSON
 * shape against the on-disk index.
 */
function runHook(client: 'claude' | 'cursor', projectDir: string, payload: unknown, env: Record<string, string>) {
  const hookPath = path.join(projectDir, CLIENT_DISPATCHER_FILENAME);
  fs.writeFileSync(hookPath, readClientDispatcherSource(), 'utf-8');
  const res = spawnSync(process.execPath, [hookPath, 'boundary-notice', client], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
  return res;
}

function writeIndex(projectDir: string, entries: Record<string, unknown>) {
  const dir = path.join(projectDir, '.repovine');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'boundary-index.json'),
    JSON.stringify({ version: 1, builtAt: '2026-06-29T00:00:00.000Z', entries }),
    'utf-8',
  );
}

describe('dispatcher boundary-notice action', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-hook-'));
    // Force ESM evaluation, replicating an ESM consumer repo.
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits a PreToolUse advisory when editing a boundary file (Claude, absolute path)', () => {
    writeIndex(tmpDir, {
      'src/contracts/order-dto.ts': [
        { nodeId: 'mod:app/src/contracts/order-dto', label: 'order-dto', risks: ['published DTO — do not rename fields'] },
      ],
    });
    const res = runHook(
      'claude',
      tmpDir,
      { tool_input: { file_path: path.join(tmpDir, 'src/contracts/order-dto.ts') } },
      { CLAUDE_PROJECT_DIR: tmpDir },
    );
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout.trim());
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('published DTO — do not rename fields');
    expect(out.hookSpecificOutput.additionalContext).toContain('src/contracts/order-dto.ts');
    // Claude/Codex shape carries hookSpecificOutput only.
    expect(out.additional_context).toBeUndefined();
  });

  it('stays silent (no output) when the edited file is not a boundary surface', () => {
    writeIndex(tmpDir, {
      'src/contracts/order-dto.ts': [{ nodeId: 'mod:x', risks: ['frozen'] }],
    });
    const res = runHook(
      'claude',
      tmpDir,
      { tool_input: { file_path: path.join(tmpDir, 'src/services/unrelated.ts') } },
      { CLAUDE_PROJECT_DIR: tmpDir },
    );
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('');
  });

  it('stays silent when no boundary index exists', () => {
    const res = runHook(
      'claude',
      tmpDir,
      { tool_input: { file_path: path.join(tmpDir, 'src/x.ts') } },
      { CLAUDE_PROJECT_DIR: tmpDir },
    );
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('');
  });

  it('resolves apply_patch file paths (Codex/Claude patch text)', () => {
    writeIndex(tmpDir, {
      'src/contracts/order-dto.ts': [{ nodeId: 'mod:app/src/contracts/order-dto', risks: ['frozen wire shape'] }],
    });
    const patch = '*** Begin Patch\n*** Update File: src/contracts/order-dto.ts\n@@\n-old\n+new\n*** End Patch';
    const res = runHook(
      'claude',
      tmpDir,
      { tool_input: { input: patch } },
      { CLAUDE_PROJECT_DIR: tmpDir },
    );
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout.trim());
    expect(out.hookSpecificOutput.additionalContext).toContain('frozen wire shape');
  });

  it('emits the Cursor preToolUse shape with additional_context', () => {
    writeIndex(tmpDir, {
      'src/contracts/order-dto.ts': [{ nodeId: 'mod:app/src/contracts/order-dto', risks: ['frozen'] }],
    });
    const res = runHook(
      'cursor',
      tmpDir,
      { tool_input: { file_path: path.join(tmpDir, 'src/contracts/order-dto.ts') } },
      { CURSOR_WORKSPACE_ROOT: tmpDir },
    );
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout.trim());
    expect(out.additional_context).toContain('frozen');
    expect(out.hookSpecificOutput.hookEventName).toBe('preToolUse');
  });

  it('fires for a NotebookEdit payload (notebook_path, not file_path)', () => {
    writeIndex(tmpDir, {
      'notebooks/analysis.ipynb': [
        { nodeId: 'mod:app/notebooks/analysis', label: 'analysis', risks: ['frozen notebook contract'] },
      ],
    });
    const res = runHook(
      'claude',
      tmpDir,
      { tool_input: { notebook_path: path.join(tmpDir, 'notebooks/analysis.ipynb') } },
      { CLAUDE_PROJECT_DIR: tmpDir },
    );
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout.trim());
    expect(out.hookSpecificOutput.additionalContext).toContain('frozen notebook contract');
  });

  it('emits a schema-drift notice (not silence) when the index version is newer than the hook', () => {
    const dir = path.join(tmpDir, '.repovine');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'boundary-index.json'),
      JSON.stringify({ version: 2, builtAt: '2026-06-29T00:00:00.000Z', entries: { 'src/x.ts': [{ nodeId: 'mod:x', risks: ['frozen'] }] } }),
      'utf-8',
    );
    const res = runHook(
      'claude',
      tmpDir,
      { tool_input: { file_path: path.join(tmpDir, 'src/x.ts') } },
      { CLAUDE_PROJECT_DIR: tmpDir },
    );
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout.trim());
    expect(out.hookSpecificOutput.additionalContext).toContain('npx repovine setup');
    expect(out.hookSpecificOutput.additionalContext).toContain('schema');
  });

  it('stays silent on a newer-version index that is also malformed (no entries object)', () => {
    const dir = path.join(tmpDir, '.repovine');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'boundary-index.json'), JSON.stringify({ version: 2 }), 'utf-8');
    const res = runHook(
      'claude',
      tmpDir,
      { tool_input: { file_path: path.join(tmpDir, 'src/x.ts') } },
      { CLAUDE_PROJECT_DIR: tmpDir },
    );
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('');
  });
});
