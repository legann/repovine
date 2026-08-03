// Canonical layout for sandbox harness artifacts:
//
//   .harness/active/           ephemeral — cleared each /goal intake
//     current-run.json
//     events.jsonl
//     <runId>/
//       summary.json
//       orient.json
//       verify.json
//       rollup.usage.json
//       rollup.mcp.json
//       sub-agents/<subAgentId>/
//         assignment.json
//         result.json
//         usage.json
//         mcp.json
//         attempts/<n>.result.json
//
//   .harness/runs/<runId>/     durable — cleared only on /reset
//     meta.json
//     events.jsonl
//     … (same tree as active/<runId>/)
//
//   .harness/index.jsonl       one JSON line per archived run
import fs from 'node:fs';
import path from 'node:path';

export const HARNESS_DIR_NAME = '.harness';
export const ACTIVE_SUBDIR = 'active';
export const RUNS_SUBDIR = 'runs';
export const INDEX_BASENAME = 'index.jsonl';
export const CURRENT_RUN_BASENAME = 'current-run.json';
export const EVENTS_BASENAME = 'events.jsonl';

export const RUN_LEVEL = {
  summary: 'summary.json',
  orient: 'orient.json',
  verify: 'verify.json',
  rollupUsage: 'rollup.usage.json',
  rollupMcp: 'rollup.mcp.json',
  meta: 'meta.json',
  events: 'events.jsonl',
};

export function harnessRoot(repoRoot) {
  return path.join(repoRoot, HARNESS_DIR_NAME);
}

export function harnessActiveDir(repoRoot) {
  return path.join(harnessRoot(repoRoot), ACTIVE_SUBDIR);
}

export function harnessRunsDir(repoRoot) {
  return path.join(harnessRoot(repoRoot), RUNS_SUBDIR);
}

export function harnessIndexPath(repoRoot) {
  return path.join(harnessRoot(repoRoot), INDEX_BASENAME);
}

export function activeTelemetryPath(repoRoot, basename) {
  return path.join(harnessActiveDir(repoRoot), basename);
}

export function activeRunDir(repoRoot, runId) {
  return path.join(harnessActiveDir(repoRoot), runId);
}

export function archivedRunDir(repoRoot, runId) {
  return path.join(harnessRunsDir(repoRoot), runId);
}

export function runDir(repoRoot, runId, { active = true } = {}) {
  return active ? activeRunDir(repoRoot, runId) : archivedRunDir(repoRoot, runId);
}

export function runLevelPath(repoRoot, runId, basename, { active = true } = {}) {
  return path.join(runDir(repoRoot, runId, { active }), basename);
}

export function subAgentDir(repoRoot, runId, subAgentId, { active = true } = {}) {
  return path.join(runDir(repoRoot, runId, { active }), 'sub-agents', subAgentId);
}

export function subAgentAttemptsDir(repoRoot, runId, subAgentId, { active = true } = {}) {
  return path.join(subAgentDir(repoRoot, runId, subAgentId, { active }), 'attempts');
}

/** @returns {{ runId: string, subAgentId: string }} */
export function splitSubAgentKey(subAgentKey) {
  const dot = subAgentKey.indexOf('.');
  if (dot === -1) return { runId: subAgentKey, subAgentId: 'default' };
  return { runId: subAgentKey.slice(0, dot), subAgentId: subAgentKey.slice(dot + 1) };
}

export function subAgentAssignmentPath(repoRoot, subAgentKey, { active = true } = {}) {
  const { runId, subAgentId } = splitSubAgentKey(subAgentKey);
  return path.join(subAgentDir(repoRoot, runId, subAgentId, { active }), 'assignment.json');
}

export function subAgentResultPath(repoRoot, subAgentKey, { active = true } = {}) {
  const { runId, subAgentId } = splitSubAgentKey(subAgentKey);
  return path.join(subAgentDir(repoRoot, runId, subAgentId, { active }), 'result.json');
}

export function subAgentAttemptResultPath(repoRoot, subAgentKey, attempt, { active = true } = {}) {
  const { runId, subAgentId } = splitSubAgentKey(subAgentKey);
  return path.join(subAgentAttemptsDir(repoRoot, runId, subAgentId, { active }), `${attempt}.result.json`);
}

export function subAgentUsagePath(repoRoot, subAgentKey, { active = true } = {}) {
  const { runId, subAgentId } = splitSubAgentKey(subAgentKey);
  return path.join(subAgentDir(repoRoot, runId, subAgentId, { active }), 'usage.json');
}

export function subAgentMcpPath(repoRoot, subAgentKey, { active = true } = {}) {
  const { runId, subAgentId } = splitSubAgentKey(subAgentKey);
  return path.join(subAgentDir(repoRoot, runId, subAgentId, { active }), 'mcp.json');
}

export function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function mergeDirContents(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    if (fs.statSync(from).isDirectory()) {
      mergeDirContents(from, to);
    } else if (!fs.existsSync(to)) {
      fs.renameSync(from, to);
    } else {
      fs.copyFileSync(from, to);
      fs.rmSync(from, { force: true });
    }
  }
}

export function appendRunIndex(repoRoot, entry) {
  const line = JSON.stringify({ archivedAt: new Date().toISOString(), ...entry });
  fs.mkdirSync(harnessRoot(repoRoot), { recursive: true });
  fs.appendFileSync(harnessIndexPath(repoRoot), `${line}\n`);
}

/** Move active/<runId>/ to runs/<runId>/ and finalize telemetry. */
export function archiveActiveRun(repoRoot, runId, meta = {}) {
  if (!repoRoot || !runId) return null;
  const runActive = activeRunDir(repoRoot, runId);
  const runArchive = archivedRunDir(repoRoot, runId);
  fs.mkdirSync(harnessRunsDir(repoRoot), { recursive: true });

  const eventsSrc = activeTelemetryPath(repoRoot, EVENTS_BASENAME);
  if (fs.existsSync(runActive)) {
    fs.mkdirSync(runArchive, { recursive: true });
    mergeDirContents(runActive, runArchive);
    fs.rmSync(runActive, { recursive: true, force: true });
  } else {
    fs.mkdirSync(runArchive, { recursive: true });
  }

  if (fs.existsSync(eventsSrc)) {
    const eventsDest = path.join(runArchive, RUN_LEVEL.events);
    try {
      const body = fs.readFileSync(eventsSrc, 'utf8');
      if (body.trim()) fs.writeFileSync(eventsDest, body);
    } catch {
      /* best-effort */
    }
  }

  const existingMeta = safeReadJson(path.join(runArchive, RUN_LEVEL.meta)) ?? {};
  writeJsonFile(path.join(runArchive, RUN_LEVEL.meta), { runId, ...existingMeta, ...meta });

  appendRunIndex(repoRoot, {
    runId,
    status: meta.status ?? existingMeta.status ?? null,
    ok: meta.ok ?? existingMeta.ok ?? null,
    partial: Boolean(meta.partial),
    summary: meta.summary ?? existingMeta.summary ?? null,
  });

  try {
    if (fs.existsSync(eventsSrc)) fs.writeFileSync(eventsSrc, '');
    const currentRun = activeTelemetryPath(repoRoot, CURRENT_RUN_BASENAME);
    if (fs.existsSync(currentRun)) fs.rmSync(currentRun, { force: true });
  } catch {
    /* best-effort */
  }

  return runArchive;
}

/** Archive in-flight run dirs left in active/ (crash or /stop). */
export function archiveOrphanActiveRuns(repoRoot) {
  const activeDir = harnessActiveDir(repoRoot);
  if (!fs.existsSync(activeDir)) return;
  const current = safeReadJson(activeTelemetryPath(repoRoot, CURRENT_RUN_BASENAME));
  for (const name of fs.readdirSync(activeDir)) {
    if (name === CURRENT_RUN_BASENAME || name === EVENTS_BASENAME) continue;
    const p = path.join(activeDir, name);
    if (!fs.statSync(p).isDirectory()) continue;
    archiveActiveRun(repoRoot, name, {
      status: current?.runId === name && current?.status === 'running' ? 'aborted' : (current?.status ?? 'partial'),
      ok: false,
      partial: true,
      summary: current?.summary ?? null,
    });
  }
}

export function clearHarnessActive(repoRoot) {
  const dir = harnessActiveDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

/** @returns {string|null} runId from a legacy flat artifact basename. */
export function legacyRunIdFromBasename(name) {
  if (name === CURRENT_RUN_BASENAME || name === EVENTS_BASENAME || name === INDEX_BASENAME) return null;
  if (name.endsWith('.run.usage.json') || name.endsWith('.run.mcp.json')) {
    return name.replace(/\.run\.(usage|mcp)\.json$/, '');
  }
  if (name.endsWith('.summary.json') || name.endsWith('.orient.json') || name.endsWith('.verify.json')) {
    return name.replace(/\.(summary|orient|verify)\.json$/, '');
  }
  const attempt = name.match(/^(.+)\.attempt-\d+\.result\.json$/);
  if (attempt) return legacyRunIdFromSubAgentPrefix(attempt[1]);
  const subAgent = name.match(/^(.+)\.(assignment|result|usage|mcp)\.json$/);
  if (subAgent) return legacyRunIdFromSubAgentPrefix(subAgent[1]);
  return null;
}

function legacyRunIdFromSubAgentPrefix(prefix) {
  const dot = prefix.indexOf('.');
  return dot === -1 ? prefix : prefix.slice(0, dot);
}

/** Move legacy flat `.harness/*` files into `runs/<runId>/`. Idempotent for already-migrated names. */
export function migrateLegacyFlatHarness(repoRoot) {
  const root = harnessRoot(repoRoot);
  if (!fs.existsSync(root)) return { migratedRuns: [] };
  const migrated = new Set();

  for (const name of fs.readdirSync(root)) {
    if (name === ACTIVE_SUBDIR || name === RUNS_SUBDIR || name === INDEX_BASENAME) continue;
    const src = path.join(root, name);
    if (!fs.statSync(src).isFile()) continue;

    const runId = legacyRunIdFromBasename(name);
    if (!runId) continue;

    let dest;
    if (name.endsWith('.run.usage.json')) {
      dest = runLevelPath(repoRoot, runId, RUN_LEVEL.rollupUsage, { active: false });
    } else if (name.endsWith('.run.mcp.json')) {
      dest = runLevelPath(repoRoot, runId, RUN_LEVEL.rollupMcp, { active: false });
    } else if (name.endsWith('.summary.json')) {
      dest = runLevelPath(repoRoot, runId, RUN_LEVEL.summary, { active: false });
    } else if (name.endsWith('.orient.json')) {
      dest = runLevelPath(repoRoot, runId, RUN_LEVEL.orient, { active: false });
    } else if (name.endsWith('.verify.json')) {
      dest = runLevelPath(repoRoot, runId, RUN_LEVEL.verify, { active: false });
    } else if (name === EVENTS_BASENAME) {
      dest = runLevelPath(repoRoot, runId, RUN_LEVEL.events, { active: false });
    } else if (name === CURRENT_RUN_BASENAME) {
      continue;
    } else {
      const attempt = name.match(/^(.+)\.attempt-(\d+)\.result\.json$/);
      if (attempt) {
        dest = subAgentAttemptResultPath(repoRoot, attempt[1], Number(attempt[2]), { active: false });
      } else {
        const m = name.match(/^(.+)\.(assignment|result|usage|mcp)\.json$/);
        if (!m) continue;
        const subAgentKey = m[1];
        const kind = m[2];
        if (kind === 'assignment') dest = subAgentAssignmentPath(repoRoot, subAgentKey, { active: false });
        else if (kind === 'result') dest = subAgentResultPath(repoRoot, subAgentKey, { active: false });
        else if (kind === 'usage') dest = subAgentUsagePath(repoRoot, subAgentKey, { active: false });
        else dest = subAgentMcpPath(repoRoot, subAgentKey, { active: false });
      }
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest)) fs.renameSync(src, dest);
    else fs.rmSync(src, { force: true });
    migrated.add(runId);
  }

  for (const runId of migrated) {
    const metaPath = runLevelPath(repoRoot, runId, RUN_LEVEL.meta, { active: false });
    if (!fs.existsSync(metaPath)) {
      const summary = safeReadJson(runLevelPath(repoRoot, runId, RUN_LEVEL.summary, { active: false }));
      writeJsonFile(metaPath, {
        runId,
        migratedFrom: 'legacy-flat',
        status: summary?.status ?? null,
        ok: summary?.ok ?? null,
        archivedAt: new Date().toISOString(),
      });
    }
  }

  const latest = findLatestArchivedRunId(repoRoot);
  if (latest) {
    for (const orphan of [EVENTS_BASENAME, CURRENT_RUN_BASENAME]) {
      const src = path.join(root, orphan);
      if (!fs.existsSync(src)) continue;
      if (orphan === EVENTS_BASENAME) {
        const dest = runLevelPath(repoRoot, latest, RUN_LEVEL.events, { active: false });
        if (!fs.existsSync(dest)) fs.renameSync(src, dest);
        else fs.rmSync(src, { force: true });
      } else {
        fs.rmSync(src, { force: true });
      }
    }
  }

  return { migratedRuns: [...migrated] };
}

export function findLatestArchivedRunId(repoRoot) {
  const runsDir = harnessRunsDir(repoRoot);
  if (!fs.existsSync(runsDir)) return null;
  let best = null;
  let bestMt = 0;
  for (const runId of fs.readdirSync(runsDir)) {
    const dir = path.join(runsDir, runId);
    if (!fs.statSync(dir).isDirectory()) continue;
    const candidates = [
      path.join(dir, RUN_LEVEL.meta),
      path.join(dir, RUN_LEVEL.summary),
    ];
    for (const subAgent of listSubAgentResultFiles(repoRoot, runId, { active: false })) {
      candidates.push(subAgent.file);
    }
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const mt = fs.statSync(file).mtimeMs;
      if (mt > bestMt) {
        bestMt = mt;
        best = runId;
      }
    }
  }
  return best;
}

export function listSubAgentResultFiles(repoRoot, runId, { active = false } = {}) {
  // Legacy fallback: runs archived before the sub-agents rename used `leaves/`.
  let subAgentsRoot = path.join(runDir(repoRoot, runId, { active }), 'sub-agents');
  if (!fs.existsSync(subAgentsRoot)) {
    subAgentsRoot = path.join(runDir(repoRoot, runId, { active }), 'leaves');
  }
  if (!fs.existsSync(subAgentsRoot)) return [];
  const out = [];
  for (const subAgentId of fs.readdirSync(subAgentsRoot)) {
    const result = path.join(subAgentsRoot, subAgentId, 'result.json');
    if (fs.existsSync(result)) out.push({ subAgentId, file: result });
  }
  return out;
}
