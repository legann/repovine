// Shared implementer brief helpers for the harness workers.
//
// The Claude adapter uses the Agent SDK's `claude_code` preset + a system append
// (see lib/claude-agent.mjs). buildWorkerPrompt assembles the SAME role + honesty
// rules and the task into one combined prompt string for a prompt-string agent.
// Keeping the contract identical across surfaces is the whole point of the seam.
//
// The brief itself is the SINGLE-SOURCE autonomous harness brief fetched from
// `repovine delivery run-brief` (authored once in the engine), not a copy kept
// here. A tiny fallback keeps the demo runnable against an older CLI.
import { harnessBrief } from '../repovine.mjs';
import { logLine } from '../log.mjs';

// Write-only policy (shared with the Claude adapter). This harness hands you a
// sandbox with NO network for executed commands and a workspace-write provider
// sandbox — running things will fail. Your job is to PRODUCE code, not run it.
//
// Annotation deferral is THIS DEMO's scheduling decision, not a Delivery Protocol
// rule (the engine brief is topology-neutral). The demo defers annotation sync to
// a dedicated annotate-phase subAgent scheduled after code/runtime stabilization and
// before final review, resuming the same warm provider session. So implement
// workers must not write annotations; they report the deferred honest state.
export const WRITE_ONLY_POLICY = [
  'POLICY — WRITE CODE ONLY:',
  '- Create and edit files to implement the task.',
  '- Do NOT execute or run anything: no builds, tests, servers, `npm install`,',
  '  shell commands, or network/HTTP requests. Executed commands have no network',
  '  and will fail — do not rely on them.',
  '- Do NOT call write_annotation in this implement phase. This harness defers',
  '  annotation sync to a separate annotate-phase subAgent it schedules after code and',
  '  runtime stabilization and before final review. Set compliance.annotationsClean=false',
  '  and leave annotationsWritten []; a non-empty annotationsWritten here is premature',
  '  (review may reshape the code) and it defeats the greenfield context exemption for',
  '  your sibling sub-agents.',
  '- Deliver the code and the AgentRunResult; the operator runs it.',
].join('\n');

export const READ_ONLY_POLICY = [
  'POLICY — READ ONLY:',
  '- Inspect repovine graph context and source files to answer or review.',
  '- Do NOT edit files, write annotations, run builds/tests/servers, or start shell/network actions.',
  '- Return findings or explanations plus the AgentRunResult requested by the assignment.',
].join('\n');

export const ANNOTATION_ONLY_POLICY = [
  'POLICY — ANNOTATIONS ONLY:',
  '- Do NOT edit application code, configs, tests, Dockerfiles, package manifests, or docs.',
  '- Use repovine MCP annotation tools to refresh, inspect, write annotations, clean orphans, and validate.',
  '- Emit an annotation-only AgentRunResult with filesChanged: [] and annotationsWritten listing real node ids.',
].join('\n');

const FALLBACK_BRIEF = [
  'You are a repovine implementer subagent (role: implementer).',
  'Orient via repovine MCP first. In implement phase, edit files and run refresh_context;',
  'in annotate phase, do not edit code and finish write_annotation / validate_annotations sync. Then',
  'emit exactly one ```json Delivery Protocol v1 AgentRunResult block.',
].join('\n');

// Engine role names (repovine delivery run-brief --role): main | explorer |
// implementer | annotation-writer | architecture-auditor | code-reviewer.
// A name outside that set resolves to no manifest, and the brief silently
// degrades to FALLBACK_BRIEF — the sub-agent then runs without the honesty
// rules, the result-block contract, and the contextSessionId instruction.
function harnessBriefRole(assignment) {
  if (assignment?.contextSession?.phase === 'annotate') return 'annotation-writer';
  if (assignment?.contextSession?.phase === 'explore') return 'explorer';
  return 'implementer';
}

/**
 * The engine-authored brief for this sub-agent. The spec's manifest NAME is the
 * precise selector — it separates the review sub-agent (code-reviewer) from the
 * orient sub-agent (explorer), which share `phase: "explore"`. Phase is the
 * fallback for specs that carry no manifest.
 *
 * A brief that resolves to nothing is a harness bug, not a soft default: shout it
 * once per sub-agent rather than shipping the 4-line stub in silence.
 */
export function resolveHarnessBrief(repoRoot, assignment, briefName) {
  const byName = briefName ? harnessBrief(repoRoot, { name: briefName }) : '';
  if (byName) return byName;
  const byRole = harnessBrief(repoRoot, { role: harnessBriefRole(assignment) });
  if (byRole) return byRole;
  logLine(
    'brief',
    `no engine brief for ${briefName ? `manifest "${briefName}"` : `role "${harnessBriefRole(assignment)}"`}`
      + ' — falling back to the stub brief (honesty rules and result-block contract are NOT in the prompt)',
    { indent: '    ' },
  );
  return FALLBACK_BRIEF;
}

export function policyForAssignment(assignment) {
  if (assignment?.contextSession?.phase === 'annotate') return ANNOTATION_ONLY_POLICY;
  if (assignment?.contextSession?.phase === 'explore') return READ_ONLY_POLICY;
  return WRITE_ONLY_POLICY;
}

/**
 * Render the task's image/file attachments as a prompt section (single source for
 * the Claude adapter and the combined worker prompt). Paths are relative to the
 * worker cwd (= repoRoot); every provider has an image-capable read tool, so we
 * just point the agent at the file rather than inlining bytes. Returns '' when
 * there are no attachments.
 */
export function attachmentsBrief(task) {
  const atts = Array.isArray(task?.attachments) ? task.attachments : [];
  if (!atts.length) return '';
  const lines = atts.map((a, i) => {
    const meta = [a.mediaType, a.caption].filter(Boolean).join(' — ');
    return `  ${i + 1}. ${a.path}${meta ? ` (${meta})` : ''}`;
  });
  return [
    'Attachments (saved in the sandbox, relative to your working dir — open them with your file/Read tool to view the image):',
    ...lines,
  ].join('\n');
}

/**
 * Build the single prompt string a CLI agent receives.
 * `resuming` is best-effort: most CLI agents start a fresh process per turn, so
 * we always restate the task; when a resume handle exists we just note it.
 * `roleBrief` (Phase 4) is a role-specific agent prose prepended before the
 * canonical harness brief — the sub-agent reads its specialization, then the
 * mandatory workflow + result-block contract.
 */
export function buildWorkerPrompt(task, assignment, { resuming = false, roleBrief, repoRoot, briefName } = {}) {
  const implementerBrief = resolveHarnessBrief(repoRoot, assignment, briefName);
  const brief = [roleBrief, policyForAssignment(assignment), implementerBrief].filter(Boolean).join('\n\n');
  const attachments = attachmentsBrief(task);
  const body = [
    `Task: ${task.task}`,
    `runId: ${assignment.runId}`,
    `Scope (stay within): ${JSON.stringify(assignment.scope)}`,
    `Acceptance criteria: ${JSON.stringify(assignment.acceptanceCriteria ?? [])}`,
    `Constraints: ${JSON.stringify(assignment.constraints ?? [])}`,
    // task.task embeds the inter-sub-agent section (full contract ledger) — skip the
    // duplicate Contracts JSON line when present. Single source.
    ...(task?.embedsContracts ? [] : [`Contracts: ${JSON.stringify(assignment.contracts ?? [])}`]),
    `Requested checks: ${JSON.stringify(assignment.requestedChecks ?? [])}`,
    ...(attachments ? ['', attachments] : []),
    '',
    resuming ? '(Continuing in the same sandbox.)' : '',
    'Complete this assignment now, then emit the AgentRunResult JSON block.',
  ]
    .filter(Boolean)
    .join('\n');
  return `${brief}\n\n${body}`;
}
