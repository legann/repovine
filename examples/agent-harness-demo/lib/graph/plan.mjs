// Decompose a task into role+scope sub-agents, and schedule them per the rule.
//
// Two modes (both decided at the ORCHESTRATOR level — never inside an LLM worker):
//   - explicit : the task names roles (task.roles / task.subAgents) → fixed sub-agent set.
//   - implicit : keyword/@-mention heuristic over the task text picks roles.
// (An LLM `plan` node — seeded with the projected orchestration rule — can later
//  replace the heuristic; the seam is `planSubAgents`. We keep the heuristic so the
//  demo runs offline and deterministically.)
//
// Scheduling encodes the rule's INVARIANTS in code, not in a prompt:
//   - "parallel only for disjoint scopes" → a stage batches only pairwise-disjoint scopes
//   - dependent phases (explicit dependsOn) run in earlier stages (→ refresh barrier between)
import { resolveRole, isKnownRole, knownRoles, agentsMode, appFrameRoles } from '../agents.mjs';
import { isGreenfieldSandbox, isGreenfieldContext } from './workspace-state.mjs';

// Canonical ordering for stable, readable plans (infra → backend → frontend).
const ROLE_ORDER = ['repo-explorer', 'infra', 'backend', 'frontend', 'annotation-writer', 'default', 'review'];
const orderIndex = (r) => {
  const i = ROLE_ORDER.indexOf(r);
  return i === -1 ? ROLE_ORDER.length : i;
};

/** Parse role names from free text: whole-word names or @role / @<prefix>-role mentions. */
export function parseRolesFromText(text = '') {
  const t = String(text).toLowerCase();
  const found = new Set();
  for (const role of knownRoles()) {
    if (role === 'default') continue;
    const re = new RegExp(`(^|[^a-z])(@?(?:[a-z]+-)?)${role}([^a-z]|$)`, 'i');
    if (re.test(t)) found.add(role);
  }
  return [...found].sort((a, b) => orderIndex(a) - orderIndex(b));
}

/** Normalize one explicit entry ("frontend", "frontend:pkg/ui", or an object). */
function normalizeEntry(entry) {
  if (typeof entry === 'string') {
    const [role, scope] = entry.split(':');
    return { role: role.trim(), scope: scope ? [scope.trim()] : undefined };
  }
  return { role: entry.role, scope: entry.scope, task: entry.task, manifest: entry.manifest, dependsOn: entry.dependsOn };
}

/**
 * Build the sub-agent specs for a task. Returns { mode, specs }.
 * specs[].dependsOn lists role names that must finish first (explicit only).
 */
export function planSubAgents(task, repoRoot) {
  let entries;
  let mode;
  if (Array.isArray(task.subAgents) && task.subAgents.length) {
    entries = task.subAgents.map(normalizeEntry);
    mode = 'explicit';
  } else if (Array.isArray(task.roles) && task.roles.length) {
    entries = task.roles.map(normalizeEntry);
    mode = 'explicit';
  } else {
    const roles = parseRolesFromText(task.task);
    entries = (roles.length ? roles : ['default']).map((role) => ({ role }));
    mode = roles.length ? 'keyword' : 'single';
  }

  const known = new Set(entries.map((e) => (isKnownRole(e.role) ? e.role : 'default')));
  const specs = entries.map((e) => {
    const resolved = resolveRole(e.role, repoRoot, { scope: e.scope, task: e.task, manifest: e.manifest });
    // Only keep dependsOn that refer to roles actually present.
    const dependsOn = (e.dependsOn ?? []).filter((d) => known.has(d) && d !== resolved.role);
    return { ...resolved, dependsOn };
  });
  return { mode, specs };
}

/**
 * Full-stack frame guarantee: a greenfield BUILD plan (≥1 frame role already planned,
 * new-project context) engages every frame layer. Decomposition variance — an LLM plan
 * that dropped `backend`, a keyword plan that matched only `frontend` — cannot silently
 * omit a layer; the missing frame roles are injected with the parent task text. A plan
 * with NO frame role (question/doc/single-default task) is not a build plan and is left
 * alone; continuation (`isGreenfieldContext` false) is orient-driven and never framed.
 */
export function applyAppFrame(plan, task, repoRoot) {
  const frame = appFrameRoles();
  if (!frame.length) return plan;
  const present = new Set(plan.specs.map((s) => s.role));
  if (!frame.some((r) => present.has(r))) return plan;
  // With an orient trail the full new-project predicate applies. Without orient
  // evidence (repovine process disabled, orient failed) only a bare greenfield
  // sandbox counts — a continuation workspace with stub annotations must not be
  // re-scaffolded by an injected frame.
  const orientTrail = task.repovineOrient ?? null;
  const greenfield = orientTrail
    ? isGreenfieldContext({ repoRoot, orientTrail })
    : isGreenfieldSandbox(repoRoot);
  if (!greenfield) return plan;
  const missing = frame.filter((r) => !present.has(r));
  if (!missing.length) return plan;
  // No dependsOn: frame roles all carry root scope, so scheduleStages already orders
  // them sequentially in canonical ROLE_ORDER (infra → backend → frontend). No task
  // override: the subAgent falls back to the parent task text, like keyword-planned specs.
  const injected = missing.map((role) => resolveRole(role, repoRoot, {}));
  return { ...plan, specs: [...plan.specs, ...injected], injectedFrameRoles: missing };
}

/**
 * Annotation sync is HARNESS-owned: it runs after verify, so graph memory read at
 * verification still holds prior runs' contracts, and delivered-work eligibility plus
 * the curation contract live in the sync phase. A planner-authored annotate stage
 * re-annotates mid-pipeline (pre-fix state, duplicate cost) and rewrites the memory
 * verify is about to check against — dropped from non-explicit plans. Explicit
 * user-pinned role lists stay exempt. An all-annotation plan is left unchanged
 * (degenerate; stripping would leave an empty run).
 */
export function stripAnnotationStages(plan) {
  const isAnnotationRole = (s) => /^annotation/.test(s?.role ?? '');
  const kept = (plan.specs ?? []).filter((s) => !isAnnotationRole(s));
  if (kept.length === plan.specs.length || kept.length === 0) return plan;
  const dropped = plan.specs.filter(isAnnotationRole).map((s) => s.role);
  return { ...plan, specs: kept, droppedAnnotationRoles: dropped };
}

/**
 * Async planner: explicit roles always win (deterministic, no LLM). Otherwise, in
 * AGENTS=auto the `plan` node (LLM) decomposes the task; on any failure (no auth,
 * parse error, unwired provider) it falls back to the heuristic planSubAgents — which
 * is exactly AGENTS=keyword — so the demo always runs, offline included.
 */
export async function planSubAgentsAsync(task, repoRoot, provider) {
  const explicit = (Array.isArray(task.subAgents) && task.subAgents.length) || (Array.isArray(task.roles) && task.roles.length);
  let plan;
  if (!explicit && agentsMode() === 'auto') {
    const { planWithLLM } = await import('./planner.mjs');
    const llm = await planWithLLM(task, repoRoot, provider);
    plan = llm?.specs?.length ? { mode: 'auto', specs: llm.specs } : planSubAgents(task, repoRoot);
  } else {
    plan = planSubAgents(task, repoRoot);
  }

  // Frame guarantee sits at the post-branch merge: the AGENTS=auto LLM branch bypasses
  // planSubAgents, and LLM decomposition is exactly the variance mode that drops a layer.
  // Explicit role lists are user-pinned and stay exempt. HARNESS_GREENFIELD_SINGLE below
  // still wins — under the single-agent override the frame does not fire.
  if (!explicit) {
    plan = stripAnnotationStages(plan);
    plan = applyAppFrame(plan, task, repoRoot);
  }

  // Opt-in: empty sandbox + generic app task → single default sub-agent (HARNESS_GREENFIELD_SINGLE=1).
  if (
    process.env.HARNESS_GREENFIELD_SINGLE === '1'
    && !explicit
    && !task.multi
    && isGreenfieldSandbox(repoRoot)
    && plan.specs.length > 1
  ) {
    return {
      mode: 'greenfield-single',
      specs: [resolveRole('default', repoRoot, { scope: ['.'], task: task.task })],
    };
  }
  return plan;
}

/**
 * Over-plan advisory (continuation only): an implement role whose scope shares no
 * token with the orient evidence (graph nodes, suggested scopes, claim texts) has
 * no grounding for being in the plan. Conservative by construction — any token hit
 * clears the role, root scope always clears, greenfield never fires — so only the
 * blatant class is flagged. Advisory: the caller logs and records it; nothing is
 * dropped (orient can be wrong too, and review still judges the merged diff).
 */
export function overPlannedRoles(specs, orientTrail, { greenfield = false } = {}) {
  if (greenfield) return [];
  const claims = (orientTrail?.claims ?? []).map((c) => (typeof c === 'string' ? c : c?.text ?? ''));
  const evidence = [
    ...(orientTrail?.graphNodes ?? []),
    ...(orientTrail?.suggestedScopes ?? []),
    ...claims,
  ].join(' ').toLowerCase();
  if (!evidence.trim()) return [];
  const exempt = new Set(['review', 'repo-explorer', 'annotation-writer']);
  const out = [];
  for (const s of specs ?? []) {
    if (!s || exempt.has(s.role)) continue;
    const scopes = (s.scope ?? []).map((p) => String(p)).filter((p) => p && p !== '.');
    if (!scopes.length) continue; // root scope overlaps everything
    const tokens = scopes.flatMap((p) => p.toLowerCase().split('/').filter((t) => t.length >= 3));
    if (tokens.length && !tokens.some((t) => evidence.includes(t))) out.push(s.instanceId || s.role);
  }
  return out;
}

/** Greenfield worktree fan-out (default on). HARNESS_GREENFIELD_PARALLEL=0 disables. */
export function greenfieldParallelEnabled() {
  return (process.env.HARNESS_GREENFIELD_PARALLEL ?? '1') !== '0';
}

/**
 * Greenfield-only parallelism: collapse implement-role specs into one batch stage so
 * the scaffold roles fan out in git worktrees. Scope overlap is allowed here — each
 * role builds in its own worktree and the sequential merge surfaces real conflicts as
 * blockers. The inter-stage contract channel (refresh barrier) is traded for
 * wall-clock; role briefs and assignments carry the scaffold contract instead.
 * Applies only to orient-confirmed new-project runs with planner/frame-authored
 * plans. Explicit user-pinned plans keep their stage order. Continuation never
 * parallelizes: the refresh barrier between stages is how real contracts propagate
 * through the graph, and no override exists.
 */
export function applyGreenfieldParallelStages(stages, { greenfield = false, planMode = '', gitOperationsAllowed = true } = {}) {
  // Stage collapsing exists to feed worktree fan-out. Without Git capability
  // (attach target policy) the collapsed batch could only run sequentially
  // against one shared tree, trading the refresh-barrier contract channel for
  // nothing. Checked BEFORE the env toggle: HARNESS_GREENFIELD_PARALLEL=1
  // cannot re-enable collapsing against a guarded workspace.
  if (gitOperationsAllowed !== true) return stages;
  if (!greenfield || planMode === 'explicit' || !greenfieldParallelEnabled()) return stages;
  const isImplement = (s) => s?.role !== 'review' && !/^annotation/.test(s?.role ?? '');
  const flat = stages.flat();
  const implementers = flat.filter(isImplement);
  if (implementers.length < 2) return stages;
  const rest = flat.filter((s) => !isImplement(s));
  return [implementers, ...rest.map((s) => [s])];
}

// ── scheduling ───────────────────────────────────────────────────────────────
const normPath = (p) => String(p).replace(/\/+$/, '');
function pathsOverlap(pa, pb) {
  pa = normPath(pa);
  pb = normPath(pb);
  if (pa === '.' || pb === '.' || pa === '' || pb === '') return true; // root overlaps all
  if (pa === pb) return true;
  return pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`);
}
export function scopesDisjoint(a = [], b = []) {
  for (const pa of a) for (const pb of b) if (pathsOverlap(pa, pb)) return false;
  return true;
}

function depthOf(spec, byRole, memo) {
  const key = spec.instanceId ?? spec.role;
  if (memo.has(key)) return memo.get(key);
  memo.set(key, 0); // cycle guard
  const deps = spec.dependsOn ?? [];
  // A dep names a role; resolve it to the max depth over that role's specs so two
  // same-role instances with different dependsOn each get their own depth.
  const d = deps.length
    ? 1 + Math.max(0, ...deps.flatMap((r) => (byRole.get(r) ?? []).map((ds) => depthOf(ds, byRole, memo))))
    : 0;
  memo.set(key, d);
  return d;
}

/**
 * Group specs into ordered STAGES. Dependent specs land in later stages; within a
 * stage, scopes are pairwise disjoint (so a stage is safe to run in parallel).
 * Between stages the orchestrator runs a refresh_context barrier.
 */
export function scheduleStages(specs) {
  const byRole = new Map(); // role -> specs[] (a role can have multiple instances)
  for (const s of specs) {
    if (!byRole.has(s.role)) byRole.set(s.role, []);
    byRole.get(s.role).push(s);
  }
  const memo = new Map();
  const byDepth = new Map();
  for (const s of specs) {
    const d = depthOf(s, byRole, memo);
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d).push(s);
  }

  const stages = [];
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    const level = byDepth.get(depth).sort((a, b) => orderIndex(a.role) - orderIndex(b.role));
    // Greedy disjoint batching within this dependency level.
    const batches = [];
    for (const s of level) {
      let placed = false;
      for (const batch of batches) {
        if (batch.every((m) => scopesDisjoint(m.scope, s.scope))) {
          batch.push(s);
          placed = true;
          break;
        }
      }
      if (!placed) batches.push([s]);
    }
    stages.push(...batches);
  }
  return stages;
}

/**
 * Disambiguate same-role sub-agents so their .harness artifacts and per-sub-agent context-session
 * ids don't collide. `subAgentInstanceId` falls back to the role, so two planner sub-agents of the
 * same role (e.g. an `annotation-writer` for frontend and one for backend) would both map
 * to `<run>.annotation-writer.*` and clobber each other's audit trail. A role that appears
 * once keeps a clean label (no instanceId); a repeated role gets a unique instanceId from
 * its scope (e.g. `annotation-writer-frontend`), falling back to a numeric suffix.
 */
export function assignSubAgentInstanceIds(specs = []) {
  const roleCounts = new Map();
  for (const s of specs) roleCounts.set(s.role, (roleCounts.get(s.role) || 0) + 1);
  const used = new Set();
  return specs.map((s) => {
    if (s.instanceId) { used.add(s.instanceId); return s; }
    if ((roleCounts.get(s.role) || 0) <= 1) return s; // unique role → keep clean label
    const seg = (s.scope || []).find((x) => x && x !== '.');
    const tag = seg ? String(seg).split('/')[0].replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') : '';
    const baseId = tag ? `${s.role}-${tag}` : s.role;
    let id = baseId;
    let n = 1;
    while (used.has(id)) { n += 1; id = `${baseId}-${n}`; }
    used.add(id);
    return { ...s, instanceId: id };
  });
}
