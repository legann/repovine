// Target contract: which workspace the harness runs against, and what it may do there.
//
//   HARNESS_TARGET_MODE=sandbox  (default) — managed empty workspace under .workspace/sandbox;
//                                 the harness seeds repovine stubs and owns reset.
//   HARNESS_TARGET_MODE=attach   — pre-created host Git worktree mounted at /workspace;
//                                 existing repovine files are authoritative. /workspace/.git
//                                 is a read-only pointer into the launch-scoped DISPOSABLE
//                                 repo (/state/git, baseline commit = tree at launch): full
//                                 Git over the baseline + the agent's own commits, while the
//                                 source common dir stays host-side. Reset restores the
//                                 baseline; promotion stays a host-side merge/fetch.
//
// The mode switch is an application contract; in Docker the filesystem isolation is
// enforced by the Compose mount topology (see compose.yaml attach services and
// scripts/attach-launcher.mjs), not by this module.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureGitRepo } from './graph/worktree.mjs';
import { ATTACH_BASELINE_REF, ATTACH_GIT_POINTER_CONTENT, ATTACH_STATE_GIT_DIR } from './attach-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Default sandbox root (gitignored). Module-private: consumers resolve via resolveTargetFromEnv. */
const DEFAULT_SANDBOX = path.resolve(HERE, '..', '.workspace', 'sandbox');

/** Parent of the default sandbox — bind-mounted in Docker (host disk, not container tmpfs). */
const WORKSPACE_ROOT = path.resolve(HERE, '..', '.workspace');

/**
 * Stable machine-readable code for an unavailable attach reset. Since Phase 2 it
 * marks the fail-loud baseline-missing error (a workspace the attach launcher
 * did not prepare) and the policy-driven HTTP refusal guard.
 */
export const ATTACH_RESET_DISABLED = 'ATTACH_RESET_DISABLED';

// Excluded from the repovine scan: deps the agent may install, our own runtime
// dirs, and the per-provider client config we seed.
const SANDBOX_IGNORE = ['node_modules', '.git', 'dist', '.repovine', '.harness', '.attachments', '.claude', '.worktrees'];

const ANNOTATIONS_STUB = '{"version":1,"annotations":{}}\n';
// enforcement.mode:"harness" makes compliance HARD-FAIL leftover unannotated/
// stale/orphan nodes in scope (validation.ts coverage gate). This is the sandbox
// config only — it never affects any client repo's projections or compliance.
// In attach mode this stub is NEVER written: the worktree's committed
// repovine.config.json is the workspace source of truth.
//
// Harness-owned CSQ gate calibration. Two carriers deliver it to the engine:
// the sandbox config stub below, and EVERY sub-agent assignment's contextSession
// policy (lib/graph/sub-agent.mjs). The assignment carrier is what reaches
// attach mode — there the target repo's committed config is authoritative, and
// a repo without a contextQuality section would otherwise be graded by engine
// defaults (implement 0.55 / explore 0.40 / byteBudget 80–120k). Engine
// precedence: assignment.contextSession.qualityThreshold ?? config threshold.
// recoveryWindow is config-only (no assignment field) — in attach it stays the
// target's value (engine default 3).
//
// explore covers orient + review + verify. On continuation the graph is known
// and the context (claims, tree-diff, obligations) is pre-delivered, so the
// navigation funnel is legitimately thin (observed review/verify at 0.366/0.387
// vs the 0.40 default — retries cost money, added no quality). Implement
// sub-agents receive the contract ledger + orient section (observed honest
// deliverers at 0.318–0.549 vs the 0.55 engine default). Both bars are advisory:
// threshold derives acceptHandoff, warningThreshold derives belowWarningThreshold,
// and compliance reports both as warnings — the score never fails a sub-agent.
// byteBudget
// raised over engine defaults (80k/120k/100k): a rejected subAgent's session is
// retained for retry recovery, so BYTES ACCUMULATE across attempts — budgets
// must absorb ~2 attempts (observed: orient 141k over 2 attempts, frontend 118k).
export const CSQ_CALIBRATION = {
  explore: { threshold: 0.3, warningThreshold: 0.4, byteBudget: 200_000 },
  implement: { threshold: 0.3, warningThreshold: 0.55, byteBudget: 200_000 },
  annotate: { byteBudget: 200_000 },
};

const configStub = () =>
  `${JSON.stringify(
    {
      build: { scan: { exclude: SANDBOX_IGNORE } },
      contextQuality: {
        enforcement: { mode: 'harness' },
        thresholds: CSQ_CALIBRATION,
        // OR-recovery = a stable anchor via map/inspect within N calls after an
        // OR-relaxed search. The engine default (3) is too tight for the explore
        // funnel, which legitimately interleaves trace_flow/get_entrypoints
        // between the search and the anchoring inspect.
        recoveryWindow: 8,
      },
    },
    null,
    2,
  )}\n`;

// ── Mode resolution and capabilities ────────────────────────────────────────

/**
 * Resolve the target from the environment. Fails loud on an unknown mode, a
 * missing attach root, a non-/workspace root inside the attach container, or a
 * conflicting independent REPOVINE_ROOT — all before any provider spend.
 */
export function resolveTargetFromEnv(env = process.env) {
  const mode = String(env.HARNESS_TARGET_MODE ?? 'sandbox').trim() || 'sandbox';
  if (mode !== 'sandbox' && mode !== 'attach') {
    throw new Error(`Unknown HARNESS_TARGET_MODE "${mode}". Use sandbox | attach.`);
  }
  let repoRoot;
  if (mode === 'attach') {
    if (!env.HARNESS_REPO_ROOT) {
      throw new Error('attach mode requires HARNESS_REPO_ROOT (the workspace path as seen by this process; /workspace in Docker).');
    }
    repoRoot = path.resolve(String(env.HARNESS_REPO_ROOT));
    if (env.REPOVINE_IN_DOCKER === '1' && repoRoot !== '/workspace') {
      throw new Error(`attach in Docker pins the workspace to /workspace; got HARNESS_REPO_ROOT=${repoRoot}.`);
    }
  } else {
    repoRoot = env.HARNESS_REPO_ROOT ? path.resolve(String(env.HARNESS_REPO_ROOT)) : DEFAULT_SANDBOX;
  }
  // REPOVINE_ROOT is derived from repoRoot for every repovine CLI/MCP child; an
  // explicit conflicting value would split the graph root from the workspace.
  if (env.REPOVINE_ROOT && path.resolve(String(env.REPOVINE_ROOT)) !== repoRoot) {
    throw new Error(
      `REPOVINE_ROOT (${env.REPOVINE_ROOT}) conflicts with the resolved workspace root (${repoRoot}). Unset it or make them equal.`,
    );
  }
  return { mode, repoRoot };
}

// `resetAllowed`: attach reset restores the launch baseline (tag pinned by the
// launcher in the disposable repo) — sandbox reset wipes the workspace.
// `gitOperationsAllowed` scopes ONE thing since Phase 2: harness-internal
// Git-PARALLEL execution (greenfield stage collapse + worktree fan-out). Custody
// and patch apply run over the target's own repo unconditionally; attach stays
// sequential for contract-barrier reasons, not Git reasons.
const POLICIES = {
  sandbox: Object.freeze({ resetAllowed: true, gitOperationsAllowed: true }),
  attach: Object.freeze({ resetAllowed: true, gitOperationsAllowed: false }),
};

/** Capabilities per mode. Pure — no environment input, no override. */
export function targetPolicy(mode) {
  const policy = POLICIES[mode];
  if (!policy) throw new Error(`Unknown target mode "${mode}".`);
  return policy;
}

// ── Sandbox lifecycle (module-private mechanics) ────────────────────────────

/** Ensure provider SDK scratch dirs live on the workspace bind mount (not container tmpfs). */
function ensureHarnessRuntimeDirs(workspaceRoot) {
  fs.mkdirSync(path.join(workspaceRoot, '.harness-home'), { recursive: true });
  return workspaceRoot;
}

function ensureRepovineWorkspace(repoRoot) {
  ensureHarnessRuntimeDirs(path.dirname(repoRoot));
  fs.mkdirSync(repoRoot, { recursive: true });
  const ann = path.join(repoRoot, 'repovine.annots.json');
  if (!fs.existsSync(ann)) fs.writeFileSync(ann, ANNOTATIONS_STUB);
  const cfg = path.join(repoRoot, 'repovine.config.json');
  if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, configStub());
  // Make the sandbox its OWN git repo (idempotent). The sandbox lives inside the
  // monorepo, so without a local .git a git-aware worker (e.g. Claude Code)
  // resolves its workspace boundary up to the monorepo root and writes there
  // instead of in the sandbox. A self-contained .git pins that boundary to the
  // sandbox in every mode — the worktree-parallel path already relied on this;
  // sequential runs now get it too. Best-effort: no-ops when git is unavailable.
  ensureGitRepo(repoRoot);
  return repoRoot;
}

/** Wipe and recreate an EMPTY sandbox (stubs restored so validation can run pre-worker). */
function seedSandbox(repoRoot) {
  fs.rmSync(repoRoot, { recursive: true, force: true });
  return ensureRepovineWorkspace(repoRoot);
}

/**
 * Wipe everything under `workspaceRoot` but keep the directory itself.
 * Bind mounts (Docker) are often EROFS on rmdir of the mount root.
 */
export function clearWorkspaceContents(workspaceRoot = WORKSPACE_ROOT) {
  fs.mkdirSync(workspaceRoot, { recursive: true });
  for (const name of fs.readdirSync(workspaceRoot)) {
    fs.rmSync(path.join(workspaceRoot, name), { recursive: true, force: true });
  }
  return workspaceRoot;
}

// ── Attach validation (in-container provable checks only) ───────────────────

const fail = (msg) => {
  throw new Error(`attach target invalid: ${msg}`);
};

/**
 * Validate an attached workspace. Only checks that are provable from inside the
 * container: existence and shape of the repovine files, the read-only pointer,
 * the disposable repo, and mount writability. Proving the host path was a
 * registered clean Git worktree is the host launcher's job
 * (scripts/attach-launcher.mjs) — that evidence stays host-side. Never writes;
 * the only git spawn is a read-only HEAD probe of the disposable repo.
 */
export function validateAttachedWorkspace(repoRoot, {
  inDocker = process.env.REPOVINE_IN_DOCKER === '1',
  requiredRoot = '/workspace',
  stateHome = '/state/home',
  stateGitDir = ATTACH_STATE_GIT_DIR,
} = {}) {
  let rootStat;
  try {
    rootStat = fs.statSync(repoRoot);
  } catch {
    fail(`workspace root ${repoRoot} does not exist`);
  }
  if (!rootStat.isDirectory()) fail(`workspace root ${repoRoot} is not a directory`);

  const cfg = path.join(repoRoot, 'repovine.config.json');
  if (!fs.existsSync(cfg) || !fs.statSync(cfg).isFile()) {
    fail(`missing repovine.config.json — attach requires the worktree's committed repovine workspace; the harness never writes stubs`);
  }
  const ann = path.join(repoRoot, 'repovine.annots.json');
  if (!fs.existsSync(ann) || !fs.statSync(ann).isFile()) {
    fail("missing repovine.annots.json — attach requires the worktree's committed annotation store");
  }
  try {
    JSON.parse(fs.readFileSync(ann, 'utf8'));
  } catch (e) {
    fail(`repovine.annots.json does not parse (${e.message}) — refusing to run against a corrupt annotation store`);
  }

  const gitPath = path.join(repoRoot, '.git');
  let gitStat;
  try {
    gitStat = fs.lstatSync(gitPath);
  } catch {
    fail('missing .git — the attach target must be a pre-created Git worktree');
  }
  if (gitStat.isDirectory()) fail('.git is a directory — attaching a primary checkout is not allowed; use a linked worktree');
  if (!gitStat.isFile()) fail('.git is not a regular file');

  if (inDocker) {
    if (path.resolve(repoRoot) !== requiredRoot) {
      fail(`Docker attach pins the workspace to ${requiredRoot}; got ${repoRoot}`);
    }
    // The Compose pointer mount: exact bytes, read-only. It targets the
    // launch-scoped disposable repo — divergent bytes or a writable pointer
    // mean the mount topology is not the launcher's; refuse to run.
    const pointer = fs.readFileSync(gitPath, 'utf8');
    if (pointer !== ATTACH_GIT_POINTER_CONTENT) {
      fail('.git does not match the attach pointer — launch through scripts/attach-launcher.mjs');
    }
    let fd = null;
    try {
      fd = fs.openSync(gitPath, 'r+');
    } catch (e) {
      if (!['EROFS', 'EACCES', 'EPERM'].includes(e.code)) fail(`.git write probe failed unexpectedly (${e.code})`);
    }
    if (fd !== null) {
      fs.closeSync(fd);
      fail('.git pointer is writable — the read-only pointer mount is missing');
    }
    // The disposable repo must be mounted, writable, and functional (baseline
    // HEAD present). HEAD may sit past the baseline after run commits — a
    // restart of a long-running channel is a legitimate state.
    if (!fs.existsSync(stateGitDir) || !fs.statSync(stateGitDir).isDirectory()) {
      fail(`disposable repo mount ${stateGitDir} is missing`);
    }
    try {
      fs.accessSync(stateGitDir, fs.constants.W_OK);
    } catch {
      fail(`disposable repo mount ${stateGitDir} is not writable`);
    }
    // Probe the mounted repo directly (not through the pointer): the check must
    // hold wherever the fixture lives, and HEAD may sit past the baseline after
    // run commits — a restarted long-running channel is a legitimate state.
    const head = spawnSync('git', ['--git-dir', stateGitDir, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf-8' });
    if (head.status !== 0) {
      fail('disposable repo has no resolvable HEAD — launch through scripts/attach-launcher.mjs');
    }
    // Runtime mounts the worker owns: external .harness and the provider HOME.
    for (const p of [path.join(repoRoot, '.harness'), stateHome]) {
      try {
        fs.accessSync(p, fs.constants.W_OK);
      } catch {
        fail(`runtime mount ${p} is missing or not writable`);
      }
    }
  } else if (!fs.readFileSync(gitPath, 'utf8').startsWith('gitdir:')) {
    fail('.git is not a worktree pointer file (gitdir: …)');
  }

  // The agent edits the worktree in place: target files must be writable by the
  // running numeric UID/GID.
  for (const p of [repoRoot, cfg, ann]) {
    try {
      fs.accessSync(p, fs.constants.W_OK);
    } catch {
      fail(`${p} is not writable by uid=${process.getuid?.() ?? '?'} gid=${process.getgid?.() ?? '?'}`);
    }
  }
  return repoRoot;
}

// ── Target lifecycle ────────────────────────────────────────────────────────

/**
 * Ensure the target workspace is usable. Sandbox: create-if-missing + seed the
 * repovine stubs (lazy, non-destructive — the pre-refactor ensureSandbox
 * behavior). Attach: validation only; never creates, seeds, or initializes Git.
 */
export function ensureTarget(target, opts = {}) {
  if (target?.mode === 'sandbox') {
    return fs.existsSync(target.repoRoot)
      ? ensureRepovineWorkspace(target.repoRoot)
      : seedSandbox(target.repoRoot);
  }
  if (target?.mode === 'attach') {
    return validateAttachedWorkspace(target.repoRoot, opts);
  }
  throw new Error(`Unknown target mode "${target?.mode}".`);
}

const resetGit = (repoRoot, args) => spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf-8' });

/**
 * Destructive reset. Sandbox: the default sandbox wipes the whole `.workspace`
 * parent (sandbox, `.harness-home`, caches — the legacy /reset); a custom
 * sandbox root wipes only its own contents. Attach (Phase 2): RESET-TO-BASELINE
 * — tracked files hard-reset to the launcher-pinned `attach-baseline` tag,
 * untracked files cleaned except harness/engine runtime. `attach/run-*`
 * branches in the disposable repo survive, so committed work stays fetchable
 * after a reset. Fails loud when the baseline tag is absent (a worktree that
 * was not launched through the attach launcher).
 */
export function resetTarget(target) {
  if (target?.mode === 'attach') {
    const root = target.repoRoot;
    const verify = resetGit(root, ['rev-parse', '--verify', `${ATTACH_BASELINE_REF}^{commit}`]);
    if (verify.status !== 0) {
      const err = new Error(
        `attach reset unavailable: baseline tag "${ATTACH_BASELINE_REF}" is missing — this workspace was not prepared by the attach launcher`,
      );
      err.code = ATTACH_RESET_DISABLED;
      throw err;
    }
    const reset = resetGit(root, ['reset', '--hard', ATTACH_BASELINE_REF]);
    if (reset.status !== 0) throw new Error(`attach reset failed: ${(reset.stderr || '').trim() || 'git reset error'}`);
    // Untracked cleanup. `.harness` is a live mount (telemetry/attachments) and
    // `.repovine` is the engine cache — both harness runtime, never baseline
    // content. -x ignores the repo's .gitignore so agent-materialized ignored
    // artifacts (node_modules, dist) are removed too.
    const clean = resetGit(root, ['clean', '-fdxq', '-e', '.harness', '-e', '.repovine']);
    if (clean.status !== 0) throw new Error(`attach reset failed: ${(clean.stderr || '').trim() || 'git clean error'}`);
    return root;
  }
  if (target?.mode !== 'sandbox') throw new Error(`Unknown target mode "${target?.mode}".`);
  if (target.repoRoot === DEFAULT_SANDBOX) {
    clearWorkspaceContents(WORKSPACE_ROOT);
  } else {
    clearWorkspaceContents(target.repoRoot);
  }
  return target.repoRoot;
}
