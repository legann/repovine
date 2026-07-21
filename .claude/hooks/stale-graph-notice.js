#!/usr/bin/env node
// PostToolUse hook for Edit|Write|NotebookEdit/apply_patch/Bash.
// Reminds the agent that the repovine graph is stale and must be
// refreshed before structural navigation or annotation writes.

let raw = '';
process.stdin.on('data', chunk => { raw += chunk; });
async function annotationConflictHint() {
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
    const root = findRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
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

async function onboardingStateHint() {
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
    const root = findRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
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

process.stdin.on('end', async () => {
  let data;
  try { data = JSON.parse(raw || '{}'); } catch { process.exit(0); }

  const paths = [];
  const ti = data && data.tool_input;
  if (ti && typeof ti.file_path === 'string') paths.push(ti.file_path);

  const patchText = ti && (ti.input || ti.patch || ti.command);
  if (typeof patchText === 'string') {
    const re = /^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm;
    let m;
    while ((m = re.exec(patchText)) !== null) paths.push(m[1].trim());
  }

  const commandText = ti && typeof ti.command === 'string' ? ti.command : '';
  const isGitMergeCommand = /\bgit\s+(merge|pull|rebase|cherry-pick)\b/.test(commandText);
  if (isGitMergeCommand) {
    const hint = await annotationConflictHint();
    if (hint) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: hint
        }
      }));
      return;
    }
  }

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

  const out = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        'repovine: syntax index is now stale after this edit. ' +
        'Before the next structural navigation, dependency analysis, or annotation write, ' +
        'call repovine MCP tool refresh_context. ' +
        'Reading individual files directly is still fine without refresh.'
    }
  };
  process.stdout.write(JSON.stringify(out));
});
