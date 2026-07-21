#!/usr/bin/env node
// Cursor project hook for sessionStart. Injects a one-time reminder that the
// repovine MCP should be the first call for non-trivial tasks.

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
    return ' Annotation maintenance: ' + rel + ' currently contains conflict markers. ' +
      'Before annotation work, call the repovine MCP tools: get_annotation_merge_status, merge_annotations, validate_annotations. ' +
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

function emit(message) {
  process.stdout.write(JSON.stringify({
    additional_context: message,
    hookSpecificOutput: {
      hookEventName: 'sessionStart',
      additionalContext: message
    }
  }));
}

process.stdin.on('end', async () => {
  let data;
  try { data = JSON.parse(raw || '{}'); } catch { data = {}; }

  if (data.source === 'compact') process.exit(0);
  const conflictHint = await annotationConflictHint(data);
  const onboardingHint = await onboardingStateHint(data);
  emit(
    'repovine MCP is available (server name: repovine). ' +
      'For any non-trivial task, START with repovine MCP tools search_context or map_context; do not grep or read files first. ' +
      'The MCP provides structure, annotations, entrypoints, dependency analysis, config surface, and flow tracing. ' +
      'After editing files, call repovine MCP tool refresh_context to refresh the syntax index before further structural navigation. ' +
      'Build state: tool calls received before the graph finishes building return a successful response (not an error) with status:"building" and an eta_sec; ' +
      'do not retry in a loop — call get_build_status with waitSec (e.g. { waitSec: 45 }) to long-poll until the build settles, respect retry_after_sec, and fall back to direct file reads when eta_sec >= 60. ' +
      "When get_build_status or refresh_context reports domainsSuggestions.count > 0, call suggest_domains_config; never auto-apply. With user approval, write a repovine.domains.json preview and call refresh_context: accept = write the mergedConfig (exclude), keep = write the keepConfig (committed infra.keep marker — keeps the resource visible and stops the suggestion); for skip/hide, call decline_advisory({ \"kind\": \"domains-config\" }) so ids are stored in .repovine/onboarding-state.json." +
      onboardingHint +
      conflictHint
  );
});
