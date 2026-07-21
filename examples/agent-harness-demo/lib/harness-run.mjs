// Harness run boundary: compact cross-task memory + fresh active artifacts per invoke.
//
// Each graph intake reads the latest prior run summary from .harness/runs/, injects a
// short text block into the new task, then clears .harness/active/ only. Archived runs
// under .harness/runs/ survive until /reset. LLM worker sessions are reset separately in
// intake (workerSessions: {}) — intra-task resume stays in multi.mjs / run_sub_agent.
import fs from 'node:fs';
import path from 'node:path';
import {
  RUN_LEVEL,
  archiveActiveRun,
  archiveOrphanActiveRuns,
  clearHarnessActive,
  findLatestArchivedRunId,
  listSubAgentResultFiles,
  migrateLegacyFlatHarness,
  runLevelPath,
} from './harness-paths.mjs';

export { HARNESS_DIR_NAME } from './harness-paths.mjs';
export {
  archiveActiveRun,
  archiveOrphanActiveRuns,
  clearHarnessActive,
  migrateLegacyFlatHarness,
} from './harness-paths.mjs';

export const DEFAULT_PRIOR_SUMMARY_MAX_BYTES = 2048;

function clip(text, maxChars) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars - 1)}…`;
}

function subAgentLabelFromId(subAgentId) {
  return subAgentId === 'default' ? 'default' : subAgentId;
}

/** Aggregate the latest completed harness run into a compact summary object. */
export function readPriorRunSummary(repoRoot) {
  migrateLegacyFlatHarness(repoRoot);
  const runId = findLatestArchivedRunId(repoRoot);
  if (!runId) return null;

  const resultFiles = listSubAgentResultFiles(repoRoot, runId, { active: false });
  if (!resultFiles.length) return null;

  const subAgents = [];
  for (const { subAgentId, file } of resultFiles.sort((a, b) => a.subAgentId.localeCompare(b.subAgentId))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      subAgents.push({
        label: subAgentLabelFromId(subAgentId),
        status: parsed.status,
        summary: parsed.summary,
        filesChanged: parsed.filesChanged ?? [],
        contractsChanged: parsed.contractsChanged ?? [],
        blockers: parsed.blockers ?? [],
      });
    } catch {
      /* skip corrupt artifact */
    }
  }
  if (!subAgents.length) return null;

  const statuses = subAgents.map((a) => a.status).filter(Boolean);
  const status = statuses.every((s) => s === 'complete') ? 'complete'
    : statuses.some((s) => s === 'failed' || s === 'blocked') ? 'failed'
      : 'partial';

  // The archived summary's tree-diff is the observed change set. A run whose
  // capture failed claims NO files (fail-closed) — never the optimistic subAgent
  // union. The union survives only as the legacy fallback for pre-signals archives.
  let filesChanged = null;
  try {
    const summary = JSON.parse(
      fs.readFileSync(runLevelPath(repoRoot, runId, RUN_LEVEL.summary, { active: false }), 'utf8'),
    );
    const treeDiff = summary?.signals?.treeDiff;
    if (treeDiff) {
      filesChanged = treeDiff.captured && Array.isArray(treeDiff.changedFiles)
        ? treeDiff.changedFiles
        : [];
    }
  } catch {
    /* no archived summary — fall back to the subAgent union */
  }
  filesChanged ??= [...new Set(subAgents.flatMap((a) => a.filesChanged))];
  const contractsChanged = [...new Set(subAgents.flatMap((a) => a.contractsChanged))];
  const blockers = [...new Set(subAgents.flatMap((a) => a.blockers).filter(Boolean))];

  const summaryParts = subAgents
    .filter((a) => a.summary)
    .map((a) => `[${a.label}] ${a.summary}`);

  return {
    runId,
    status,
    summary: summaryParts.join(' '),
    filesChanged,
    contractsChanged,
    blockers,
    subAgentCount: subAgents.length,
  };
}

/** Format prior run for injection at the top of a new task (target ≤ maxBytes). */
export function formatPriorRunSummaryForTask(prior, maxBytes = DEFAULT_PRIOR_SUMMARY_MAX_BYTES) {
  if (!prior) return '';
  const lines = [
    '## Prior harness run (compact)',
    'repovine annotations + sandbox code are the durable source of truth; this block is coordination memory only.',
    `- runId: ${prior.runId}`,
    `- status: ${prior.status} (${prior.subAgentCount} sub-agent result(s))`,
    `- summary: ${clip(prior.summary, 500)}`,
  ];
  if (prior.filesChanged.length) {
    lines.push(
      `- filesChanged (${prior.filesChanged.length}): ${clip(prior.filesChanged.slice(0, 14).join(', '), 420)}`,
    );
    if (prior.filesChanged.length > 14) {
      lines.push(`  …+${prior.filesChanged.length - 14} more file(s)`);
    }
  }
  if (prior.contractsChanged.length) {
    lines.push(`- contracts (${prior.contractsChanged.length} total, sample):`);
    for (const c of prior.contractsChanged.slice(0, 6)) {
      lines.push(`  - ${clip(c, 140)}`);
    }
    if (prior.contractsChanged.length > 6) {
      lines.push(`  …+${prior.contractsChanged.length - 6} more (see code/annotations)`);
    }
  }
  if (prior.blockers.length) {
    lines.push(`- blockers: ${clip(prior.blockers.join('; '), 240)}`);
  }

  let text = lines.join('\n');
  while (Buffer.byteLength(text, 'utf8') > maxBytes && text.length > 80) {
    text = `${text.slice(0, text.length - 40).trimEnd()}\n…(truncated)`;
  }
  return text;
}

/** @deprecated Use clearHarnessActive — kept for tests importing the old name. */
export function clearHarnessArtifacts(repoRoot) {
  clearHarnessActive(repoRoot);
}

/**
 * Intake barrier: read the latest prior run summary, wipe .harness/active/ only,
 * return text to prepend to the new task (or null when greenfield / first run).
 */
export function prepareHarnessRun(repoRoot) {
  migrateLegacyFlatHarness(repoRoot);
  archiveOrphanActiveRuns(repoRoot);
  const priorRunSummary = readPriorRunSummary(repoRoot);
  clearHarnessActive(repoRoot);
  const priorRunSummaryText = formatPriorRunSummaryForTask(priorRunSummary);
  return { priorRunSummary, priorRunSummaryText };
}

/** Latest task prefix by newest archived run (compat helper). */
export function findLatestTaskPrefix(repoRoot) {
  migrateLegacyFlatHarness(repoRoot);
  return findLatestArchivedRunId(repoRoot);
}
