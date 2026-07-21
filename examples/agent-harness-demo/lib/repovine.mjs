// Thin wrapper around the built `repovine agents <cmd>` CLI.
//
// This is the ONLY contact surface with repovine: file-in / JSON-out, exactly
// the way test/integration/agent-protocol-cli-blackbox.test.ts drives it via
//   spawnSync('node', [dist/mcp/index.js, 'agents', ...])
//
// repovine is the contract + validation layer. It never runs the agent; the
// harness (this demo) does. So every call here is either:
//   - discovery  (protocol / manifests / run-brief), or
//   - validation (validate-assignment / validate-result / compliance).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findUp } from './find-up.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repo-relative bundled handoff.md for this demo (explicit --out for writes). */

// env wins (Docker sets it); else find the built CLI by walking up to whatever
// ancestor holds dist/mcp/index.js (the repovine package root) — relocation-proof.
// The fixed lib/ -> agent-harness-demo/ -> examples/ -> repovine/ guess is the
// last resort if neither is available.
const CLI_REL = path.join('dist', 'mcp', 'index.js');
const repovineRoot = findUp(HERE, CLI_REL);
export const REPOVINE_CLI =
  process.env.REPOVINE_CLI ||
  (repovineRoot && path.join(repovineRoot, CLI_REL)) ||
  path.resolve(HERE, '..', '..', '..', CLI_REL);

/**
 * Pure command construction for a repovine CLI child: `cwd` and `REPOVINE_ROOT`
 * are both pinned to `repoRoot` (see repovine/src/paths.ts -> resolveWorkspaceRoot).
 * Root pinning is asserted on this object in tests — no engine spawn required.
 */
export function buildCliCommand(cliArgs, { repoRoot } = {}) {
  return {
    command: 'node',
    args: [REPOVINE_CLI, ...cliArgs],
    cwd: repoRoot || process.cwd(),
    env: { ...process.env, ...(repoRoot ? { REPOVINE_ROOT: repoRoot } : {}) },
  };
}

/** Run `repovine agents <args>` against `repoRoot` and parse stdout JSON. */
export function agents(args, { repoRoot } = {}) {
  const cmd = buildCliCommand(['agents', ...args], { repoRoot });
  const res = spawnSync(cmd.command, cmd.args, {
    cwd: cmd.cwd,
    env: cmd.env,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  let json;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    json = undefined;
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

/**
 * Rebuild the graph snapshot for `repoRoot` (orchestrator-level refresh barrier).
 * `repovine build` eagerly rebuilds + caches the graph, so a later phase's
 * validate/compliance sees the prior phase's edits. Used between multi-agent
 * stages; the worker itself still calls MCP refresh_context during its own run.
 */
export function refreshGraph(repoRoot, { cleanupOrphans = false } = {}) {
  const cmd = buildCliCommand(['build', ...(cleanupOrphans ? ['--cleanup-orphans'] : [])], { repoRoot });
  const res = spawnSync(cmd.command, cmd.args, {
    cwd: cmd.cwd,
    env: cmd.env,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/**
 * End-state annotation debt for `repoRoot` via the top-level `repovine status --json`.
 * Read-only snapshot of the post-sync graph: the authoritative signal for whether the
 * run left annotation work undone, distinct from whether each annotation-sync sub-agent
 * converged on its own. Returns { needsWork, clean } or null when the CLI is unavailable
 * or errors (callers treat null as "unknown" and fall back to the per-sub-agent tally).
 */
export function annotationHealth(repoRoot) {
  const cmd = buildCliCommand(['status', '--json'], { repoRoot });
  const res = spawnSync(cmd.command, cmd.args, {
    cwd: cmd.cwd,
    env: cmd.env,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  let json;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    json = undefined;
  }
  const ann = json?.annotations;
  if (!ann || typeof ann.needsWork !== 'number') return null;
  return { needsWork: ann.needsWork, clean: ann.status === 'clean' };
}

/**
 * Pre-run prompt material from repovine (`repovine agents run-brief`): role brief +
 * inter-subAgent handoff policy. Cached per process (repo-independent for brief/spec).
 */
const _runBriefCache = new Map();
export function runBrief(repoRoot, { role, name } = {}) {
  const key = name || role || 'implementer';
  if (_runBriefCache.has(key)) return _runBriefCache.get(key);
  const args = ['run-brief'];
  if (name) args.push('--name', name);
  else if (role) args.push('--role', role);
  const res = agents(args, { repoRoot });
  if (res.json?.error) return undefined;
  _runBriefCache.set(key, res.json);
  return res.json;
}

/** Role brief text for provider prompts (from run-brief). */
export function harnessBrief(repoRoot, { role, name } = {}) {
  const kit = runBrief(repoRoot, { role, name });
  return typeof kit?.brief === 'string' ? kit.brief : '';
}

/**
 * Repository role source (`agents.roles` in repovine.config.json) via the
 * read-only engine CLI. `at` pins the read to a committed tree-ish (attach
 * custody: prompts come from the launch baseline, never the agent-writable
 * working tree). Returns the parsed JSON, or { errors } on a structured failure.
 */
export function projectRoles(repoRoot, { at } = {}) {
  return agents(['roles', ...(at ? ['--at', at] : [])], { repoRoot });
}

/** Deterministic search_context + trace_flow (no LLM). */
export function orientQuery(repoRoot, query, { scope } = {}) {
  const args = ['orient', '--query', String(query ?? '')];
  if (scope) args.push('--scope', scope);
  return agents(args, { repoRoot });
}

// ── Discovery ──────────────────────────────────────────────────────────────
// Discovery may still touch repovine workspace/cache state, so callers pass the
// sandbox repoRoot just like validation/compliance calls.
export const getProtocol = (repoRoot) => agents(['protocol'], { repoRoot }).json;
export const getManifests = (role, repoRoot) =>
  agents(role ? ['manifests', '--role', role] : ['manifests'], { repoRoot }).json;

// ── Validation ─────────────────────────────────────────────────────────────
export function validateAssignment(file, repoRoot) {
  return agents(['validate-assignment', file], { repoRoot });
}

export function validateResult(file, { repoRoot } = {}) {
  // `validate-result` is schema-only: it takes just the result file and ignores
  // --assignment/--manifest (those belong to `compliance`). Callers may still pass
  // them; they are destructured away here rather than sent as no-op flags.
  const res = agents(['validate-result', file], { repoRoot });
  // CLI returns `valid`; graph nodes read `schemaValid`.
  if (res.json) res.json.schemaValid = res.json.schemaValid ?? res.json.valid ?? false;
  return res;
}

export function compliance(file, { assignment, manifest, repoRoot, greenfieldRun } = {}) {
  const flags = [
    ...(assignment ? ['--assignment', assignment] : []),
    ...(manifest ? ['--manifest', manifest] : []),
    // Greenfield run: no annotated context existed at run start, so the engine's context
    // exemption must hold for every sub-agent — not lapse once a sibling writes the first
    // annotation into the shared store. The harness owns run-start state; the engine cannot
    // see it from a single subAgent's on-disk snapshot.
    ...(greenfieldRun ? ['--greenfield-run'] : []),
  ];
  return agents(['compliance', file, ...flags], { repoRoot });
}

/** Context session quality report for a worker's contextSessionId (MCP call ledger). */
export function sessionQuality(sessionId, { repoRoot, phase, mode, events } = {}) {
  const flags = [
    ...(phase ? ['--phase', phase] : []),
    ...(mode ? ['--mode', mode] : []),
    ...(events ? ['--events'] : []),
  ];
  return agents(['session-quality', sessionId, ...flags], { repoRoot });
}
