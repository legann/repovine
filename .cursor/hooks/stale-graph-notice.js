#!/usr/bin/env node
// Cursor project hook for afterFileEdit / afterShellExecution.
// Reminds the agent that the repovine graph is stale after graph-relevant
// edits, and detects annotation conflict markers after pull/merge/rebase commands.

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

async function annotationConflictHint(data) {
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { dirname, join, resolve } = await import('node:path');
    const findRoot = start => {
      let dir = resolve(start || process.cwd());
      for (;;) {
        if (existsSync(join(dir, '.repovine'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return resolve(start || process.cwd());
        dir = parent;
      }
    };
    const root = findRoot(resolveRoot(data));
    const readAnnotationsRel = rootDir => {
      try {
        const envRel = process.env.REPOVINE_ANNOTATIONS_FILE;
        if (typeof envRel === 'string' && envRel.trim()) return envRel.trim();
        const cfgPath = join(rootDir, 'repovine.config.json');
        if (existsSync(cfgPath)) {
          const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
          const rel = cfg?.workspace?.annotationsFile;
          if (typeof rel === 'string' && rel.trim()) return rel.trim();
        }
      } catch {}
      return 'repovine.annots.json';
    };
    const rel = readAnnotationsRel(root);
    const filePath = join(root, rel);
    const hasMarkers = existsSync(filePath) && /^(<<<<<<<|=======|>>>>>>>) ?/m.test(readFileSync(filePath, 'utf-8'));
    if (!hasMarkers) return '';
    return 'repovine: ' + rel + ' contains conflict markers. ' +
      'Do not resolve the JSON by hand. Call the repovine MCP tools: get_annotation_merge_status, merge_annotations, validate_annotations. ' +
      'CLI fallback: npx repovine annotations merge && npx repovine annotations validate.';
  } catch {
    return '';
  }
}

async function onboardingStateHint(data) {
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { dirname, join, resolve } = await import('node:path');
    const findRoot = start => {
      let dir = resolve(start || process.cwd());
      for (;;) {
        if (existsSync(join(dir, '.repovine'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return resolve(start || process.cwd());
        dir = parent;
      }
    };
    const root = findRoot(resolveRoot(data));
    const filePath = join(root, '.repovine', 'onboarding-state.json');
    if (!existsSync(filePath)) return '';
    const state = JSON.parse(readFileSync(filePath, 'utf-8'));
    return ' Onboarding state: ' + JSON.stringify({
      graph: state.graph,
      onboarding: state.onboarding
    }) + '.';
  } catch {
    return '';
  }
}

function emit(eventName, message) {
  process.stdout.write(JSON.stringify({
    additional_context: message,
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: message
    }
  }));
}

function collectPaths(data) {
  const paths = [];
  const ti = data && data.tool_input;
  for (const source of [data, ti]) {
    if (!source || typeof source !== 'object') continue;
    if (typeof source.file_path === 'string') paths.push(source.file_path);
    if (typeof source.filePath === 'string') paths.push(source.filePath);
    if (typeof source.path === 'string') paths.push(source.path);
    for (const key of ['files', 'paths', 'changedFiles']) {
      const value = source[key];
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (typeof item === 'string') paths.push(item);
        else if (item && typeof item.path === 'string') paths.push(item.path);
        else if (item && typeof item.file_path === 'string') paths.push(item.file_path);
      }
    }
  }

  const patchText = firstString(
    ti && ti.input,
    ti && ti.patch,
    ti && ti.command,
    data && data.input,
    data && data.patch,
    data && data.command,
  );
  if (patchText) {
    const re = /^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm;
    let m;
    while ((m = re.exec(patchText)) !== null) paths.push(m[1].trim());
  }
  return paths;
}

process.stdin.on('end', async () => {
  let data;
  try { data = JSON.parse(raw || '{}'); } catch { process.exit(0); }

  const ti = data && data.tool_input;
  const commandText = firstString(
    data && data.command,
    data && data.shell_command,
    ti && ti.command,
  );
  const isGitMergeCommand = /\bgit\s+(merge|pull|rebase|cherry-pick)\b/.test(commandText);
  if (isGitMergeCommand) {
    const hint = await annotationConflictHint(data);
    if (hint) {
      emit('afterShellExecution', hint);
      return;
    }
  }

  const paths = collectPaths(data);
  if (paths.length === 0) process.exit(0);

  const isEngineOwned = p =>
    /[\\/]\.repovine[\\/]/.test(p) ||
    /(?:^|[\\/])\.repovine\.[^\\/]+$/.test(p) ||
    /(?:^|[\\/])repovine\.(?:annots|annotations|config|domains)\.json$/.test(p);
  const isParsed = p =>
    /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|tf|ya?ml)$/i.test(p) ||
    /(^|[\\/])Dockerfile[^\\/]*$/i.test(p);

  const relevant = paths.some(p => !isEngineOwned(p) && isParsed(p));
  if (!relevant) process.exit(0);

  emit(
    'afterFileEdit',
    'repovine: syntax index is now stale after this edit. ' +
      'Before the next structural navigation, dependency analysis, or annotation write, ' +
      'call repovine MCP tool refresh_context. ' +
      'Reading individual files directly is still fine without refresh.'
  );
});
