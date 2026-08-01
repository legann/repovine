// Role resolution for the multi-agent path and single sub-agent default prose.
//
// Demo harness briefs live in lib/agents/ (source of truth — edit those files).
// Optional override: HARNESS_AGENTS_DIR (compose bind-mounts ./lib/agents by default).
//
// Custom sub-agent: add `myrole` to ROLES below with files: ['myrole.md'], create
// lib/agents/myrole.md, then invoke with --roles myrole or @myrole in the task.
// Not automatic from filename alone — the role must be registered in ROLES.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = path.join(HERE, 'agents');

// `manifest` is a built-in repovine manifest NAME (repovine agents manifests). It
// drives two things: the required AgentRunResult fields `agents compliance` checks,
// and the engine-authored brief the worker prepends (`agents run-brief --name`).
// A null or unknown name drops both: compliance falls back to the `summary`-only
// required-field floor, and the prompt loses the honesty rules. The rest of
// compliance (graph nodes, annotations, scope, review consistency) still runs.
// Review carries the read-only code-reviewer manifest: it requires `review`, so a
// verdict-free review is rejected.
const ROLES = {
  frontend: { scope: ['.'], manifest: 'project-subagent-sample', files: ['frontend.md'], requiresTests: true, frame: true },
  backend: { scope: ['.'], manifest: 'project-subagent-sample', files: ['backend.md'], requiresTests: true, frame: true },
  infra: { scope: ['.'], manifest: 'project-subagent-sample', files: ['infra.md'], frame: true },
  'repo-explorer': { scope: ['.'], manifest: 'repovine-repo-explorer', files: ['repo-explorer.md'], contextPhase: 'explore', modelRole: 'ask' },
  'annotation-writer': { scope: ['.'], manifest: 'repovine-annotation-writer', files: ['annotation-writer.md'], contextPhase: 'annotate', modelRole: 'ask' },
  review: { scope: ['.'], manifest: 'repovine-code-reviewer', files: ['code-reviewer.md', 'review.md'] },
  default: { scope: ['.'], manifest: 'project-subagent-sample', files: ['sample.project-subagent.md', 'default.md'] },
};

// ── Role catalog (init-once per process) ──────────────────────────────────────
// The catalog is the ACTIVE role set every consumer reads (isKnownRole,
// resolveRole, planner role lists, @mention parsing, gates). It is resolved
// once from the target and stays immutable for the process lifetime:
//   sandbox                     → utility + bundled specialists (this registry)
//   attach with agents.roles    → utility + PROJECT roles (repository-owned
//                                 prose, read from the LAUNCH BASELINE tree —
//                                 custody: the worktree is agent-writable, the
//                                 prompt must come from the operator's commit)
//   attach without agents.roles → bundled fallback + explicit diagnostic
// Uninitialized (unit tests, host tools) = bundled semantics. Re-init with a
// different catalog is a harness bug and throws; identical re-init is a no-op.
const UTILITY_ROLE_IDS = ['default', 'review', 'repo-explorer', 'annotation-writer'];
let activeCatalog = null;
let activeCatalogKey = null;

function bundledCatalog() {
  return new Map(Object.entries(ROLES).map(([id, spec]) => [id, { ...spec, roleSource: 'bundled' }]));
}

function catalogKey(catalog) {
  return [...catalog.entries()]
    .map(([id, e]) => `${id}:${e.roleSource}:${e.briefHash ?? ''}`)
    .sort()
    .join('|');
}

export function roleCatalog() {
  return activeCatalog ?? bundledCatalog();
}

/**
 * Build + install the process catalog. `projectRoles` is the parsed output of
 * `repovine agents roles` (null/unconfigured → bundled fallback).
 */
export function initRoleCatalog({ targetMode = 'sandbox', projectRoles = null } = {}) {
  const catalog = bundledCatalog();
  if (targetMode === 'attach' && projectRoles?.configured && Array.isArray(projectRoles.roles) && projectRoles.roles.length) {
    // Project roles replace the bundled specialists; utility roles stay.
    for (const id of Object.keys(ROLES)) {
      if (!UTILITY_ROLE_IDS.includes(id)) catalog.delete(id);
    }
    for (const role of projectRoles.roles) {
      if (UTILITY_ROLE_IDS.includes(role.id)) {
        throw new Error(`role catalog: project role "${role.id}" shadows a harness-reserved id (${UTILITY_ROLE_IDS.join(', ')})`);
      }
      catalog.set(role.id, {
        scope: role.scope?.length ? role.scope : ['.'],
        manifest: 'project-subagent-sample',
        prompt: role.brief, // verbatim — as-is consumption, frontmatter included
        promptSource: role.briefPath,
        briefHash: role.hash,
        ...(role.description ? { description: role.description } : {}),
        ...(role.advisories?.length ? { advisories: role.advisories } : {}),
        roleSource: 'project',
      });
    }
  }
  const key = catalogKey(catalog);
  if (activeCatalog) {
    if (key !== activeCatalogKey) throw new Error('role catalog: conflicting re-initialization (catalog is per-process immutable)');
    return roleCatalog();
  }
  activeCatalog = catalog;
  activeCatalogKey = key;
  return catalog;
}

/** Test seam: drop the installed catalog (never used by runtime code). */
export function resetRoleCatalogForTests() {
  activeCatalog = null;
  activeCatalogKey = null;
}

export function knownRoles() {
  return [...roleCatalog().keys()];
}
export function isKnownRole(role) {
  return roleCatalog().has(role);
}

/** Explicit @mentions against the ACTIVE catalog — full-id match, no prefix stripping. */
export function rolesFromMentions(text) {
  const t = String(text ?? '');
  const found = new Set();
  for (const id of knownRoles()) {
    if (id === 'default') continue;
    const re = new RegExp(`@${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-])`, 'i');
    if (re.test(t)) found.add(id);
  }
  return [...found];
}

// Roles whose implementers must ship test source files. The role's `.md` carries the
// per-layer "what/how to test" guidance; this flag is the machine policy the grounded tests gate
// reads. `HARNESS_REQUIRE_TESTS_ROLES` (comma list, or `none`) overrides the defaults.
export function roleRequiresTests(role) {
  const override = (process.env.HARNESS_REQUIRE_TESTS_ROLES ?? '').trim().toLowerCase();
  if (override === 'none') return false;
  if (override) return override.split(',').map(s => s.trim()).includes(role);
  return roleCatalog().get(role)?.requiresTests === true;
}

// The full-stack frame: layers a greenfield BUILD plan engages by guarantee. The planner
// keeps framework choice; the frame only guards which layers exist. `HARNESS_APP_FRAME`
// overrides: `0`/`none`/`off` disables, a comma list replaces the default role set.
export function appFrameRoles() {
  const override = (process.env.HARNESS_APP_FRAME ?? '').trim().toLowerCase();
  if (override === '0' || override === 'none' || override === 'off') return [];
  if (override && override !== '1') {
    return override.split(',').map(s => s.trim()).filter(r => isKnownRole(r));
  }
  const catalog = roleCatalog();
  return [...catalog.keys()].filter(r => catalog.get(r).frame === true);
}

// ── Agents mode (the ONE knob) ────────────────────────────────────────────────
export const AGENTS_MODES = ['single', 'auto', 'keyword'];

export function agentsMode() {
  const raw = (process.env.AGENTS || '').trim().toLowerCase();
  if (AGENTS_MODES.includes(raw)) return raw;
  return 'single';
}

/** Strip a leading YAML frontmatter block (`---\n…\n---`). */
function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { body: text, meta: {} };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { body: text.slice(m[0].length).trimStart(), meta };
}

function agentSearchDirs() {
  const dirs = [];
  if (process.env.HARNESS_AGENTS_DIR) dirs.push(process.env.HARNESS_AGENTS_DIR);
  dirs.push(BUNDLED_DIR);
  return dirs;
}

/** Load a role's prompt prose from lib/agents/ (or HARNESS_AGENTS_DIR override). */
export function loadRolePrompt(role) {
  const entry = roleCatalog().get(role);
  if (entry?.prompt !== undefined) {
    // Project role: repository-owned prose served byte-for-byte (as-is
    // consumption — no frontmatter stripping, no transformation).
    return { prompt: entry.prompt, source: entry.promptSource ?? 'agents.roles' };
  }
  const spec = ROLES[role] || ROLES.default;
  for (const dir of agentSearchDirs()) {
    for (const name of spec.files) {
      const file = path.join(dir, name);
      try {
        if (fs.existsSync(file)) {
          const { body, meta } = parseFrontmatter(fs.readFileSync(file, 'utf-8'));
          // `stack:` frontmatter is the ROLE's technology declaration — the brief
          // (the swappable skill) owns the stack; the harness threads it into
          // greenfield assignments, the channel with proven adherence. Prose in
          // the brief body describes HOW to use the stack, never WHICH stack.
          return { prompt: body.trim(), source: file, ...(meta.stack ? { stack: meta.stack } : {}) };
        }
      } catch {
        /* keep searching */
      }
    }
  }
  return { prompt: `You are the ${role} implementer sub-agent. Stay within your scope.`, source: 'inline-fallback' };
}

export function roleScope(role) {
  return (roleCatalog().get(role) ?? ROLES.default).scope;
}

export function manifestForRole(role) {
  return (roleCatalog().get(role) ?? ROLES.default).manifest;
}

// repovine manifest NAME -> Agent Protocol role. The manifest a spec already carries
// is the authoritative source (repovine core maps name -> role); project roles all
// carry `project-subagent-sample`, so they resolve to `implementer` for free.
const MANIFEST_PROTOCOL_ROLE = {
  main: 'main',
  'project-subagent-sample': 'implementer',
  'repovine-repo-explorer': 'explorer',
  'repovine-annotation-writer': 'annotation-writer',
  'repovine-architecture-auditor': 'architecture-auditor',
  'repovine-code-reviewer': 'code-reviewer',
};

/**
 * The Agent Protocol `role` for a sub-agent spec's assignment. The repovine schema
 * validates `role` against a fixed enum (main | explorer | implementer |
 * annotation-writer | architecture-auditor | code-reviewer), so the demo's planner
 * labels (backend/frontend/infra/review/…) cannot ride into the assignment as-is.
 * The spec's manifest name resolves it; a manifest-less spec (the verify
 * claim-checker) falls back to its context phase. Unknown -> implementer, the
 * editing default.
 */
export function protocolRoleForSpec(spec = {}) {
  const byManifest = MANIFEST_PROTOCOL_ROLE[spec.manifest];
  if (byManifest) return byManifest;
  if (spec.contextPhase === 'annotate') return 'annotation-writer';
  if (spec.contextPhase === 'explore') return 'explorer';
  return 'implementer';
}

/** Resolve a full subAgent spec for a role, with optional per-task scope/task overrides. */
export function resolveRole(role, _repoRoot, overrides = {}) {
  const known = isKnownRole(role) ? role : 'default';
  const entry = roleCatalog().get(known) ?? ROLES.default;
  const { prompt, source, stack } = loadRolePrompt(known);
  return {
    role: known,
    scope: overrides.scope || entry.scope,
    manifest: overrides.manifest === undefined ? entry.manifest : overrides.manifest,
    agentPrompt: prompt,
    agentSource: source,
    ...(stack ? { stack } : {}),
    contextPhase: overrides.contextPhase === undefined ? entry.contextPhase : overrides.contextPhase,
    modelRole: overrides.modelRole === undefined ? entry.modelRole : overrides.modelRole,
    roleSource: entry.roleSource ?? 'bundled',
    ...(entry.briefHash ? { briefHash: entry.briefHash } : {}),
    task: overrides.task,
  };
}
