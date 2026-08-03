// LLM `plan` step — implicit decomposition.
//
// Reads the orchestration RULE prose (the source of truth) + the task, asks the
// LLM for a JSON plan of role+scope+dependsOn sub-agents, and resolves them to specs.
// This is the JUDGMENT half of the rule (which roles, which scopes); the
// INVARIANT half (disjoint→parallel, barriers, flat sub-agents) stays in the
// scheduler/orchestrator code. Gated by AGENTS=auto; on any failure the
// caller falls back to the deterministic heuristic, so the demo still runs offline.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRole, isKnownRole, knownRoles, roleCatalog } from '../agents.mjs';
import { askLLM } from '../llm.mjs';
import { attachmentsBrief } from '../workers/prompt.mjs';
import { findUp } from '../find-up.mjs';
import { describeWorkspaceState, isGreenfieldContext } from './workspace-state.mjs';
import { logLine } from '../log.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Monorepo root = the nearest ancestor holding the repo's own .git (the demo's
// sandbox .git lives BELOW HERE, never above, so the upward search can't hit it).
// Used to strip the outer-layout prefix from planner scopes.
const MONOREPO_ROOT = findUp(HERE, '.git') || path.resolve(HERE, '..', '..', '..', '..', '..');
// Demo-owned orchestration rule (write-only sub-agent tasks). NOT the repovine client rule.
const BUNDLED_RULE = path.join(HERE, '..', 'rules', 'repovine-subagent-orchestration.mdc');

const VERBOSE = process.env.GRAPH_VERBOSE !== '0';
const log = (msg) => logLine('plan-llm', msg, { enabled: VERBOSE, indent: '  ' });

const stripFrontmatter = (t) => {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(t);
  return m ? t.slice(m[0].length).trimStart() : t;
};

// Orchestration rule for the planner (judgment half of decomposition).
// delivery-protocol-harness-demo ships its OWN write-only rule in lib/rules/ — workers cannot
// run npm/docker, so sub-agent `"task"` strings must say "edit files", not "run build".
// Override with HARNESS_RULES_DIR; bundled lib/rules/ is the default.
export function loadOrchestrationRule() {
  const candidates = [
    process.env.HARNESS_RULES_DIR && path.join(process.env.HARNESS_RULES_DIR, 'repovine-subagent-orchestration.mdc'),
    BUNDLED_RULE,
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return { rule: stripFrontmatter(fs.readFileSync(file, 'utf-8')).trim(), source: file };
    } catch {
      /* keep searching */
    }
  }
  return { rule: '', source: 'inline-fallback' };
}

// Safety net when the planner LLM disobeys the rule — applied in parsePlan.
const RUN_VERB_RE =
  /\b(npm\s+(run\s+)?(build|test|install|ci)|pnpm\s|yarn\s|vite\s+(build|dev)|docker\s+compose|typecheck|tsc\b|eslint|\blint\b|prettier|re-?run\s+(lint|build|check|test)|ensure\s+.*\bbuild\b.*\bsucceed)/i;

const WRITE_ONLY_SUFFIX =
  '\n\n[Harness write-only: edit files under scope only — do not execute npm, vite, docker, lint, typecheck, tests, or dev servers; operator verifies locally.]';

const REVIEW_WRITE_ONLY_TASK =
  'Read-only cross-stack review: inspect prior handoffs and changed files for contract alignment, defects, UX/accessibility gaps, and missing test source files; report blockers for operator e2e — do not execute shell commands.';

/** Normalize a planner-produced sub-agent task for the write-only harness sandbox. */
export function finalizeSubAgentTask(task, role) {
  if (!task) return task;
  if (role === 'review' && RUN_VERB_RE.test(task)) {
    log(`sanitized review sub-agent task (removed run/verify commands)`);
    return REVIEW_WRITE_ONLY_TASK;
  }
  if (RUN_VERB_RE.test(task)) {
    log(`appended write-only suffix to ${role} sub-agent task (planner mentioned execution)`);
    return `${task.trim()}${WRITE_ONLY_SUFFIX}`;
  }
  return task;
}

function buildPlanPrompt(task, rule, repoRoot) {
  const catalog = roleCatalog();
  const ids = knownRoles().filter((r) => r !== 'default');
  const roles = ids.join(', ');
  // Project roles carry repository-owned descriptions + default scopes — give
  // the planner that grounding instead of bare ids.
  const projectLines = ids
    .filter((r) => catalog.get(r)?.roleSource === 'project')
    .map((r) => {
      const e = catalog.get(r);
      return `- ${r}: ${e.description ?? 'project role'} (default scope: ${e.scope.join(', ')})`;
    });
  const greenfield = isGreenfieldContext({ repoRoot, orientTrail: task.repovineOrient });
  const workspaceState = describeWorkspaceState(repoRoot, { greenfield });
  return [
    'You are the main agent. Decompose the task below into sub-agents per this policy:',
    '',
    rule || `Roles: ${roles}. Keep scopes disjoint for independent sub-agents; use dependsOn for ordering.`,
    '',
    `Available roles: ${roles}.`,
    ...(projectLines.length ? ['', 'Project roles (repository-owned):', ...projectLines] : []),
    '',
    'HARNESS WRITE-ONLY (every sub-agent `"task"` field): workers edit files only — no shell.',
    'Never assign npm install/build/test, vite, docker compose, lint, typecheck, curl,',
    'or "ensure build succeeds". Say what FILES to create or fix; operator runs later.',
    'Review sub-agent: read-only inspection — never "re-run build/lint".',
    '',
    `WORKSPACE STATE: ${workspaceState}`,
    ...(task.repovineOrient?.suggestedScopes?.length
      ? ['', `ORIENT SUGGESTED SCOPES (derived from graph nodes — prefer these for subAgent scopes): ${task.repovineOrient.suggestedScopes.join(', ')}`]
      : []),
    '',
    `TASK: ${task.task}`,
    // The planner only sees text (askLLM is a string completion — it cannot view the
    // image). The harness threads these attachments down to every sub-agent, so route
    // the reference image into the sub-agent whose work it informs and have it open it.
    ...(attachmentsBrief(task)
      ? [
          '',
          attachmentsBrief(task),
          'A reference image is attached above. Do NOT just paraphrase it here: in the relevant'
            + " sub-agent's `task`, instruct that sub-agent to open the image file with its Read tool and match it"
            + ' (the file path is carried through to each sub-agent automatically).',
        ]
      : []),
    '',
    'Output the plan as a single ```json fenced array (and nothing else after it),',
    'each item shaped:',
    '  { "role": "<role>", "scope": ["path", ...], "task": "<file-editing instructions only>", "dependsOn": ["<role>", ...] }',
    'Rules: the workspace is the sandbox repository root;',
    'it may already contain a product. Scopes are SHORT paths relative to that root',
    '(e.g. "backend", "frontend", or "todo/backend"). Do NOT mirror any outer monorepo layout: no',
    'leading "repovine/", "examples/", or "delivery-protocol-harness-demo/" segments, no absolute',
    'paths, no "..". Keep scopes disjoint across independent sub-agents; dependsOn lists',
    'roles that must finish first (e.g. frontend dependsOn backend when it consumes',
    'a new backend contract).',
    '',
    'PLAN SELF-CHECK (before emitting): for each role, name to yourself which task',
    'requirements or orient claims it owns. Drop any role that owns none — a role added',
    '"for completeness" wastes a worker. Prefer the smallest role set that covers every',
    'requirement, and scope each role to the narrowest path containing its work.',
    '',
    'INTER-SUB-AGENT HANDOFF: the orchestrator threads prior sub-agents\' AgentRunResult',
    '(summary, filesChanged, contractsChanged). Each implementer sub-agent MUST emit',
    'contractsChanged for delta facts the next sub-agent needs. repovine annotations are',
    'durable graph memory via MCP; assignment/handoff history is coordination memory.',
    'If a planned contract would narrow or remove a graph-observed behavior, require',
    'explicit user intent or make the sub-agent report a blocker.',
  ].join('\n');
}

export { buildPlanPrompt };

/** Extract the first JSON array from model text (tolerates fences / surrounding prose). */
export function extractJsonArray(text) {
  if (!text) return null;
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
  for (const f of fenced) {
    try {
      const v = JSON.parse(f);
      if (Array.isArray(v)) return v;
    } catch {
      /* try next */
    }
  }
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const v = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(v)) return v;
    } catch {
      /* fall through */
    }
  }
  return null;
}

// Segments between the monorepo root and the sandbox, e.g.
// ['repovine','examples','delivery-protocol-harness-demo','.workspace','sandbox']. A planner
// LLM (esp. claude) sometimes mirrors this OUTER layout into the scope, so the
// worker recreates a deep monorepo-shaped tree inside its sandbox. Stripping any
// leading run of these segments re-anchors the scope to the sandbox root the
// worker actually starts in.
function sandboxPrefixSegments(repoRoot) {
  if (!repoRoot) return [];
  const rel = path.relative(MONOREPO_ROOT, repoRoot);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return [];
  return rel.split(path.sep).filter(Boolean);
}

/** Normalize one scope path: drop absolute/.. junk and the outer-monorepo prefix. */
export function normalizeScopePath(p, prefixSegs = []) {
  const raw = String(p).trim().replace(/\\/g, '/').replace(/^\/+/, '');
  let segs = raw.split('/').filter((s) => s && s !== '.' && s !== '..');
  let i = 0;
  while (i < segs.length && i < prefixSegs.length && segs[i] === prefixSegs[i]) i += 1;
  segs = segs.slice(i);
  return segs.length ? segs.join('/') : '.';
}

function normalizeScope(raw, prefixSegs) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cleaned = list.map((p) => normalizeScopePath(p, prefixSegs)).filter(Boolean);
  return cleaned.length ? cleaned : undefined;
}

/** Turn raw plan entries into resolved specs (coerce roles, normalize scope, filter deps). */
export function parsePlan(text, repoRoot) {
  const arr = extractJsonArray(text);
  if (!Array.isArray(arr) || arr.length === 0) return null;
  // An unknown role id INVALIDATES the whole plan (explicit reason + the
  // deterministic fallback takes over). Silent coercion to `default` hid
  // planner hallucinations and made project-role typos unobservable.
  const unknown = arr
    .map((e) => String(e?.role ?? '').toLowerCase())
    .filter((r) => !isKnownRole(r));
  if (unknown.length > 0) {
    log(`plan invalidated: unknown role(s) [${[...new Set(unknown)].join(', ')}] not in the active catalog — falling back to the deterministic planner`);
    return null;
  }
  const prefix = sandboxPrefixSegments(repoRoot);
  const entries = arr
    .map((e) => ({
      role: String(e.role).toLowerCase(),
      scope: normalizeScope(e?.scope, prefix),
      task: typeof e?.task === 'string' ? finalizeSubAgentTask(e.task, String(e?.role).toLowerCase()) : undefined,
      dependsOn: Array.isArray(e?.dependsOn) ? e.dependsOn.map((d) => String(d).toLowerCase()) : [],
    }))
    .filter((e) => e.role);
  if (!entries.length) return null;
  const present = new Set(entries.map((e) => e.role));
  return entries.map((e) =>
    ({ ...resolveRole(e.role, repoRoot, { scope: e.scope, task: e.task }), dependsOn: e.dependsOn.filter((d) => present.has(d) && d !== e.role) }),
  );
}

/**
 * Plan via the LLM. Returns { specs } on success, or null to signal fallback.
 * Never throws and never edits the repo (planning is a no-tools completion).
 */
export async function planWithLLM(task, repoRoot, provider) {
  try {
    const { rule, source } = loadOrchestrationRule();
    log(`rule source: ${source}`);
    const res = await askLLM(buildPlanPrompt(task, rule, repoRoot), { provider });
    if (!res.ok) {
      log(`LLM unavailable (${res.reason}) — fall back to heuristic`);
      return null;
    }
    const specs = parsePlan(res.text, repoRoot);
    if (!specs?.length) {
      log('could not parse a plan — fall back to heuristic');
      return null;
    }
    log(`planned sub-agents: [${specs.map((s) => `${s.role}${s.dependsOn.length ? `<-${s.dependsOn.join(',')}` : ''}`).join(', ')}]`);
    return { specs };
  } catch (e) {
    // Contract: never throw — buildPlanPrompt/askLLM/loadOrchestrationRule may (e.g.
    // mkdtempSync). Any failure falls back to the deterministic heuristic planner.
    log(`planner threw (${e?.message || e}) — fall back to heuristic`);
    return null;
  }
}

// ── Plan review (HARNESS_PLAN_REVIEW=1, advisory) ─────────────────────────────
// Bounded critic over the emitted plan: structured verdict, every revision must
// cite a claim fragment or graph node (uncited findings are discarded), one round,
// no veto — findings are logged and recorded in plan_finished for precision
// telemetry. Open-ended "is the plan ready?" critics return findings near-100% of
// the time (critic bias); the evidence requirement is the bias filter.

/** Prompt for the bounded plan critic. Exported for tests. */
export function buildPlanReviewPrompt(task, specs) {
  const criteria = (task.repovineOrient?.criteria ?? [])
    .map((c) => (typeof c === 'string' ? c : c?.statement ?? ''))
    .filter(Boolean)
    .map((t) => `- ${t}`);
  const nodes = task.repovineOrient?.graphNodes ?? [];
  const plan = (specs ?? []).map(
    (s) => `- role=${s.role} scope=[${(s.scope ?? []).join(', ')}]${s.dependsOn?.length ? ` dependsOn=[${s.dependsOn.join(', ')}]` : ''}`,
  );
  return [
    'You review a sub-agent plan for execution readiness. Do NOT rewrite it.',
    '',
    `TASK: ${task.task}`,
    '',
    criteria.length ? `ORIENT ACCEPTANCE CRITERIA:\n${criteria.join('\n')}` : 'ORIENT ACCEPTANCE CRITERIA: (none)',
    '',
    nodes.length ? `ORIENT GRAPH NODES: ${nodes.join(', ')}` : 'ORIENT GRAPH NODES: (none)',
    '',
    `PLAN:\n${plan.join('\n')}`,
    '',
    'Verdict rules:',
    '- A revision is VALID only when its `evidence` cites a criterion fragment or graph node id from above.',
    '- Discard any finding you cannot evidence. No valid revisions → verdict "approve".',
    '- At most 3 revisions. Actions: drop (role owns no requirement), add (uncovered criterion),',
    '  rescope (scope misses or exceeds the cited evidence), retask (role task contradicts a criterion).',
    '',
    'Output one ```json fenced object (and nothing else after it):',
    '  { "verdict": "approve" | "revise",',
    '    "revisions": [ { "role": "<role>", "action": "drop|add|rescope|retask", "evidence": "<claim fragment or node id>", "reason": "<one sentence>" } ] }',
  ].join('\n');
}

/** Parse the critic's verdict; uncited revisions are dropped, empty revise coerces to approve. */
export function parsePlanReview(text) {
  const fenced = [...String(text ?? '').matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
  for (const block of [...fenced, String(text ?? '').trim()]) {
    try {
      const obj = JSON.parse(block);
      if (obj && (obj.verdict === 'approve' || obj.verdict === 'revise')) {
        const revisions = (Array.isArray(obj.revisions) ? obj.revisions : [])
          .filter((r) => r && typeof r.evidence === 'string' && r.evidence.trim())
          .slice(0, 3)
          .map((r) => ({
            role: String(r.role ?? ''),
            action: String(r.action ?? ''),
            evidence: r.evidence.trim(),
            reason: String(r.reason ?? ''),
          }));
        return { verdict: revisions.length ? obj.verdict : 'approve', revisions };
      }
    } catch { /* try the next block */ }
  }
  return null;
}

/** One bounded advisory review call. Contract: never throws, null = skipped. */
export async function reviewPlanWithLLM(task, specs, provider) {
  try {
    const res = await askLLM(buildPlanReviewPrompt(task, specs), { provider });
    if (!res.ok) {
      log(`plan review unavailable (${res.reason}) — skipped`);
      return null;
    }
    const review = parsePlanReview(res.text);
    if (!review) {
      log('plan review unparseable — skipped');
      return null;
    }
    log(`plan review: ${review.verdict}${review.revisions.length ? ` (${review.revisions.length} evidenced revision(s))` : ''}`);
    return review;
  } catch (e) {
    log(`plan review threw (${e?.message || e}) — skipped`);
    return null;
  }
}
