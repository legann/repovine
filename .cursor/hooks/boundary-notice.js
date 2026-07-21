#!/usr/bin/env node
// Cursor project hook for preToolUse (Edit|Write|apply_patch tools).
// Deterministic boundary delivery: resolves the edited file to its node and, when that node carries a
// scope:"boundary" risk (recorded in .repovine/boundary-index.json by the build), surfaces the
// off-limits reason as additional_context. Advisory, never blocking. Standalone — no running server.

let raw = '';
process.stdin.on('data', chunk => { raw += chunk; });

function firstString(...values) {
  return values.find(value => typeof value === 'string' && value.length > 0) || '';
}

function resolveRoot(data) {
  const workspaceRoots = Array.isArray(data.workspace_roots) ? data.workspace_roots : data.workspaceRoots;
  return firstString(
    process.env.CURSOR_WORKSPACE_ROOT,
    process.env.CLAUDE_PROJECT_DIR,
    Array.isArray(workspaceRoots) ? workspaceRoots[0] : '',
    data.workspace_root,
    data.workspaceRoot,
    data.cwd,
    process.cwd(),
  );
}

function collectPaths(data) {
  const paths = [];
  const ti = data && data.tool_input;
  for (const source of [data, ti]) {
    if (!source || typeof source !== 'object') continue;
    if (typeof source.file_path === 'string') paths.push(source.file_path);
    if (typeof source.filePath === 'string') paths.push(source.filePath);
    if (typeof source.path === 'string') paths.push(source.path);
    if (typeof source.notebook_path === 'string') paths.push(source.notebook_path);
  }
  const patchText = firstString(
    ti && ti.input, ti && ti.patch, ti && ti.command,
    data && data.input, data && data.patch, data && data.command,
  );
  if (patchText) {
    const re = /^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm;
    let m;
    while ((m = re.exec(patchText)) !== null) paths.push(m[1].trim());
  }
  return paths;
}

function buildAdvisory(blocks) {
  const lines = ['repovine boundary advisory — the file(s) you are editing carry scope:"boundary" annotations (off-limits surface: published contract, frozen migration, or structural slot).'];
  for (const block of blocks) {
    lines.push(block.relPath + ':');
    for (const entry of block.entries) {
      const who = entry.label ? entry.label + ' [' + entry.nodeId + ']' : entry.nodeId;
      for (const risk of (entry.risks || [])) lines.push('  - ' + who + ': ' + risk);
    }
  }
  lines.push('Editing a boundary surface is legitimate for a real fix in the surface itself. If this change would alter the contract, re-plan to the consumer / write path instead of editing the frozen surface in place.');
  return lines.join('\n');
}

process.stdin.on('end', async () => {
  let data;
  try { data = JSON.parse(raw || '{}'); } catch { process.exit(0); }

  const paths = collectPaths(data);
  if (paths.length === 0) process.exit(0);

  const { existsSync, readFileSync } = await import('node:fs');
  const { dirname, join, resolve, isAbsolute, relative } = await import('node:path');

  const findRoot = start => {
    let dir = resolve(start || process.cwd());
    for (;;) {
      if (existsSync(join(dir, '.repovine'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) return resolve(start || process.cwd());
      dir = parent;
    }
  };
  const startDir = resolveRoot(data);
  const root = findRoot(startDir);

  let index;
  try {
    const filePath = join(root, '.repovine', 'boundary-index.json');
    if (!existsSync(filePath)) process.exit(0);
    index = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch { process.exit(0); }
  if (!index || typeof index !== 'object') process.exit(0);
  const entriesOk = index.entries && typeof index.entries === 'object';
  if (index.version !== 1) {
    // Schema drift: fail LOUD (actionable notice) instead of silently disabling the channel; only
    // when the index is otherwise well-formed. Cursor dual-key payload.
    if (entriesOk) {
      const notice = 'repovine: boundary index schema (v' + index.version + ') is newer than this pre-edit hook; run "npx repovine setup" to refresh it. Boundary advisories are paused until then.';
      process.stdout.write(JSON.stringify({ additional_context: notice, hookSpecificOutput: { hookEventName: 'preToolUse', additionalContext: notice } }));
    }
    process.exit(0);
  }
  if (!entriesOk) process.exit(0);

  const toRel = p => relative(root, isAbsolute(p) ? p : resolve(startDir, p)).split('\\').join('/');

  const seen = new Set();
  const blocks = [];
  for (const p of paths) {
    const rel = toRel(p);
    if (seen.has(rel)) continue;
    seen.add(rel);
    const entries = index.entries[rel];
    if (Array.isArray(entries) && entries.length > 0) blocks.push({ relPath: rel, entries });
  }
  if (blocks.length === 0) process.exit(0);

  const message = buildAdvisory(blocks);
  process.stdout.write(JSON.stringify({
    additional_context: message,
    hookSpecificOutput: {
      hookEventName: 'preToolUse',
      additionalContext: message
    }
  }));
});
