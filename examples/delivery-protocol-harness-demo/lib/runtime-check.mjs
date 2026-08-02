// Harness runtime_check — orchestrator-run build/test in the product sandbox.
//
// Agents stay write-only; this module installs dependencies without lifecycle
// scripts, then runs configured build/test commands via spawnSync and returns
// stdout/stderr for fix sub-agents or the channel reply. Not an LLM tool and not the
// legacy "operator" manual step.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logLine } from './log.mjs';
import { finitePositive } from './num.mjs';

const VERBOSE = process.env.GRAPH_VERBOSE !== '0';
const log = (msg) => logLine('runtime_check', msg, { enabled: VERBOSE, indent: '  ' });

const DEFAULT_CMD = 'npm run build';
const DEFAULT_CMDS = [DEFAULT_CMD, 'npm test'];
const DEFAULT_TIMEOUT_MS = finitePositive(process.env.HARNESS_RUNTIME_CHECK_TIMEOUT_MS, 600000);
const LOG_TAIL_LINES = finitePositive(process.env.HARNESS_RUNTIME_CHECK_LOG_TAIL, 40);
const INSTALL_CMD = 'npm install --ignore-scripts';

const SECRET_ENV_RE = /(?:api[_-]?key|token|secret|password|credential|oauth|auth|cookie|session)/i;
const PROXY_ENV_RE = /^(NO_PROXY|HTTP_PROXY|HTTPS_PROXY)$/i;
const PROXY_CREDENTIAL_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]+:[^/\s@]+@/i;
const RUNTIME_ENV_ALLOW = new Set([
  'CI',
  'HOME',
  'LANG',
  'LC_ALL',
  'NODE_ENV',
  'PATH',
  'PWD',
  'SHELL',
  'TERM',
  'TMPDIR',
  'USER',
]);

function runtimeCheckEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SECRET_ENV_RE.test(key)) continue;
    if (RUNTIME_ENV_ALLOW.has(key) || key.startsWith('npm_')) env[key] = value;
    else if (key.startsWith('HARNESS_RUNTIME_CHECK_')) env[key] = value;
    else if (key.startsWith('NPM_CONFIG_')) env[key] = value;
    else if (PROXY_ENV_RE.test(key) && !PROXY_CREDENTIAL_RE.test(value)) env[key] = value;
  }
  return env;
}

/**
 * Attach targets an existing repository. runtime_check would `npm install` +
 * build/test the WHOLE real repo after every task (a fresh worktree has no
 * node_modules), which fails closed under the default-deny egress and turns a
 * correct change into a failed goal at the acceptance gate. Attach forces the
 * check off; the operator builds/tests on the host after promotion. An explicit
 * HARNESS_RUNTIME_CHECK=1 is reported as overridden (intake), never silently
 * swallowed.
 */
function attachTarget() {
  return String(process.env.HARNESS_TARGET_MODE ?? '').trim() === 'attach';
}

export function runtimeCheckEnabled() {
  if (attachTarget()) return false;
  return process.env.HARNESS_RUNTIME_CHECK !== '0';
}

/** True when an explicit HARNESS_RUNTIME_CHECK=1 was overridden off by attach mode. */
export function runtimeCheckOverriddenByAttach() {
  return attachTarget() && process.env.HARNESS_RUNTIME_CHECK === '1';
}

/**
 * Demo runtime policy: runtime is REQUIRED when the check is enabled and the
 * sandbox has at least one package.json to build/test. Independent from the
 * protocol `tests` evidence — a passed runtime command is not a protocol test
 * claim. Drives the tri-state runtimeAccepted so a skipped-but-required
 * runtime is not treated as success.
 */
export function runtimeRequired(repoRoot) {
  return runtimeCheckEnabled() && discoverPackageDirs(repoRoot).length > 0;
}

export function runtimeCheckFixEnabled() {
  return process.env.HARNESS_RUNTIME_CHECK_FIX !== '0';
}

export function runtimeCheckFixMaxAttempts() {
  return Math.max(0, Number(process.env.HARNESS_RUNTIME_CHECK_FIX_MAX ?? 2));
}

/** Failing shell command from a runtime_check result (e.g. `npm run build`, `npm test`). */
export function failedRuntimeCheckCommand(result) {
  if (!result || result.skipped || result.ok) return null;
  const cmd = String(result.command ?? '').trim();
  return cmd || null;
}

export function runtimeCheckFixAttemptsForCommand(failedCommand, attemptsByCommand) {
  if (!failedCommand) return 0;
  if (attemptsByCommand instanceof Map) return attemptsByCommand.get(failedCommand) ?? 0;
  return Number(attemptsByCommand?.[failedCommand] ?? 0);
}

/** Whether another fix sub-agent may run for this failing command (per-command budget). */
export function canAttemptRuntimeCheckFix(failedCommand, attemptsByCommand, maxFix) {
  if (!failedCommand || maxFix <= 0) return false;
  return runtimeCheckFixAttemptsForCommand(failedCommand, attemptsByCommand) < maxFix;
}

/** Increment per-command fix counter; mutates the Map or plain object in place. */
export function recordRuntimeCheckFixAttempt(failedCommand, attemptsByCommand) {
  if (!failedCommand) return 0;
  const next = runtimeCheckFixAttemptsForCommand(failedCommand, attemptsByCommand) + 1;
  if (attemptsByCommand instanceof Map) attemptsByCommand.set(failedCommand, next);
  else attemptsByCommand[failedCommand] = next;
  return next;
}

const SKIP_PACKAGE_WALK_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.harness',
  '.repovine',
]);

function runtimeCheckCommand() {
  return runtimeCheckCommands().join(' && ');
}

/** Ordered shell commands run per package (or once at repo root). */
export function runtimeCheckCommands() {
  const multi = process.env.HARNESS_RUNTIME_CHECK_CMDS?.trim();
  if (multi) {
    return multi.split(/[;\n]+/).map((s) => s.trim()).filter(Boolean);
  }
  const single = process.env.HARNESS_RUNTIME_CHECK_CMD?.trim();
  if (single) return [single];
  return DEFAULT_CMDS;
}

function hasPackageJson(repoRoot) {
  return fs.existsSync(path.join(repoRoot, 'package.json'));
}

function nodeModulesPresent(dir) {
  return fs.existsSync(path.join(dir, 'node_modules'));
}

/** Directories containing package.json (root + nested monorepo packages). */
export function discoverPackageDirs(repoRoot, { maxDepth = 4 } = {}) {
  const dirs = [];
  const seen = new Set();

  function visit(dir, depth) {
    const normalized = path.resolve(dir);
    if (seen.has(normalized)) return;
    seen.add(normalized);

    if (fs.existsSync(path.join(dir, 'package.json'))) dirs.push(dir);
    if (depth >= maxDepth) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || SKIP_PACKAGE_WALK_DIRS.has(ent.name)) continue;
      visit(path.join(dir, ent.name), depth + 1);
    }
  }

  visit(repoRoot, 0);
  return dirs.sort((a, b) => a.length - b.length);
}

/** npm install --ignore-scripts in each package dir missing node_modules. */
function runDependencyInstalls(repoRoot) {
  const steps = [];
  for (const dir of discoverPackageDirs(repoRoot)) {
    if (nodeModulesPresent(dir)) {
      const rel = path.relative(repoRoot, dir) || '.';
      log(`install skip: node_modules present (${rel})`);
      continue;
    }
    const rel = path.relative(repoRoot, dir) || '.';
    steps.push(runShell(INSTALL_CMD, dir, `install (${rel})`));
    if (!steps[steps.length - 1].ok) {
      return { ok: false, steps, failed: steps[steps.length - 1] };
    }
  }
  return { ok: true, steps };
}

function tailLines(text, maxLines = LOG_TAIL_LINES) {
  const lines = String(text ?? '').split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length <= maxLines) return lines.join('\n');
  return lines.slice(-maxLines).join('\n');
}

const WORKSPACE_HEADER_RE = /^> [\w.-]+@|^npm error workspace\s+/i;
const RUNTIME_ERROR_LINE_RE = /error TS\d+|npm error|Lifecycle script `.+` failed|may not disable emit|Missing script|must have setting/i;

/**
 * Failure log tail for fix sub-agents: keep error lines from each failed workspace/build
 * segment instead of truncating to the last N lines of a monorepo build (which can
 * hide frontend errors behind backend output).
 */
export function runtimeFailureLogTail(text, maxLines = LOG_TAIL_LINES) {
  const lines = String(text ?? '').split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return '';

  const segmentStarts = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (WORKSPACE_HEADER_RE.test(lines[i]) || /npm error path\s+/i.test(lines[i])) {
      segmentStarts.push(i);
    }
  }

  if (segmentStarts.length >= 2 || /workspace\s+todo-(backend|frontend)\b/i.test(text)) {
    const picked = [];
    const seen = new Set();
    const push = (line) => {
      if (!line || seen.has(line)) return;
      seen.add(line);
      picked.push(line);
    };

    for (let s = 0; s < segmentStarts.length; s += 1) {
      const start = segmentStarts[s];
      const end = s + 1 < segmentStarts.length ? segmentStarts[s + 1] : lines.length;
      const chunk = lines.slice(start, end);
      const failed = chunk.some((line) => RUNTIME_ERROR_LINE_RE.test(line));
      if (!failed) continue;
      for (const line of chunk) {
        if (
          WORKSPACE_HEADER_RE.test(line)
          || /npm error path\s+/i.test(line)
          || RUNTIME_ERROR_LINE_RE.test(line)
          || /^> tsc|^> vite build/i.test(line)
        ) {
          push(line);
        }
      }
    }

    if (picked.length) {
      return picked.length <= maxLines ? picked.join('\n') : picked.slice(-maxLines).join('\n');
    }
  }

  const errorLines = lines.filter((line) => RUNTIME_ERROR_LINE_RE.test(line));
  if (errorLines.length) {
    const ctx = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!RUNTIME_ERROR_LINE_RE.test(lines[i])) continue;
      for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 1); j += 1) {
        ctx.push(lines[j]);
      }
    }
    const unique = [...new Set(ctx)];
    return unique.length <= maxLines ? unique.join('\n') : unique.slice(-maxLines).join('\n');
  }

  return tailLines(text, maxLines);
}

function runShell(command, repoRoot, label) {
  log(`${label}: ${command}`);
  const startedAtMs = Date.now();
  const res = spawnSync(command, {
    cwd: repoRoot,
    shell: true,
    encoding: 'utf-8',
    timeout: DEFAULT_TIMEOUT_MS,
    env: runtimeCheckEnv(),
    maxBuffer: 10 * 1024 * 1024,
  });
  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';
  const timedOut = res.error?.code === 'ETIMEDOUT';
  const exitCode = timedOut ? 124 : (res.status ?? 1);
  const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
  const stepOk = exitCode === 0;
  const durationMs = Date.now() - startedAtMs;
  return {
    command,
    exitCode,
    ok: stepOk,
    timedOut,
    durationMs,
    stdout,
    stderr,
    combined,
    logTail: stepOk ? tailLines(combined) : runtimeFailureLogTail(combined),
    error: res.error?.message,
  };
}

/** Infer fix scope hints from compiler/test output paths. */
export function deriveScopeFromRuntimeLog(logText = '') {
  const scopes = new Set();
  const text = String(logText);

  if (
    /\bbackend[/\\]/i.test(text)
    || /(?:^|\s|>)backend@/i.test(text)
    || /todo-backend@/i.test(text)
    || /workspace\s+todo-backend\b/i.test(text)
    || /npm error path\s+[^\n]*[/\\]backend(?:[/\\]|$)/i.test(text)
  ) {
    scopes.add('backend');
  }

  if (
    /\bfrontend[/\\]/i.test(text)
    || /(?:^|\s|>)frontend@/i.test(text)
    || /todo-frontend@/i.test(text)
    || /workspace\s+todo-frontend\b/i.test(text)
    || /npm error path\s+[^\n]*[/\\]frontend(?:[/\\]|$)/i.test(text)
  ) {
    scopes.add('frontend');
  }

  // tsc run inside a workspace often prints src/... without a backend/ prefix
  if (/workspace\s+todo-backend\b|^> todo-backend@/im.test(text) && /\bsrc[/\\]/i.test(text)) {
    scopes.add('backend');
  }
  if (/workspace\s+todo-frontend\b|^> todo-frontend@/im.test(text) && /\bsrc[/\\]/i.test(text)) {
    scopes.add('frontend');
  }

  if (/\bdocker-compose|Dockerfile|vite\.config/i.test(text)) scopes.add('infra');
  if (scopes.size === 0) scopes.add('.');
  return [...scopes];
}

export function runtimeCheckBlockers(result) {
  if (!result || result.skipped || result.ok) return [];
  const pkg = result.failedPackage ? ` in ${result.failedPackage}` : '';
  const head = `runtime_check failed (${result.command}${pkg}, exit ${result.exitCode})`;
  const tail = result.logTail?.trim();
  return tail ? [`${head}\n${tail}`] : [head];
}

const MISSING_TEST_SCRIPT_RE = /Missing script:\s*["']test["']/i;
const EXPRESS_PARAMS_TS2345_RE = /TS2345[\s\S]{0,200}string \| string\[\][\s\S]{0,120}string/i;

/** True when runtime_check failed because npm test / a test script is absent. */
export function isMissingTestScriptFailure(result) {
  const text = String(result?.combined || result?.logTail || '');
  return MISSING_TEST_SCRIPT_RE.test(text);
}

/** True when tsc failed on Express req.params string | string[] vs string APIs. */
export function isExpressParamsTypeFailure(result) {
  const text = String(result?.combined || result?.logTail || '');
  return EXPRESS_PARAMS_TS2345_RE.test(text) || /req\.params\.\w+.*TS2345/i.test(text);
}

/** Scope hints for a runtime-fix sub-agent; widens to root + app packages for missing test scripts. */
export function deriveRuntimeCheckFixScopes(check) {
  const fromLog = deriveScopeFromRuntimeLog(check?.combined || check?.logTail || '');
  if (!isMissingTestScriptFailure(check)) return fromLog;
  return [...new Set(['.', 'backend', 'frontend', ...fromLog])];
}

/** Assignment task body for a runtime-fix sub-agent (orchestrator-owned; agents stay write-only). */
export function buildRuntimeCheckFixTask(check, blockers = runtimeCheckBlockers(check)) {
  const lines = [
    'Fix runtime_check failures below (write-only). Consume inter-sub-agent contracts from prior phases.',
    'Do not run shell commands, tests, builds, Docker, curl, or dev servers — the harness re-runs runtime_check.',
    'This fix phase is TIME-BOXED by a wall-clock limit: make the smallest targeted fix and emit your result',
    'promptly — start editing within your first few actions, skip broad exploration. The harness re-runs the',
    'check and iterates if more is needed.',
    '',
    `runtime_check command: ${check?.command ?? '(unknown)'}`,
    '',
    'Failure output (tail):',
    check?.logTail || '(no output)',
    '',
    'Blockers:',
    ...blockers.map((b) => `- ${b}`),
  ];

  if (isMissingTestScriptFailure(check)) {
    lines.push(
      '',
      'Missing test script — add minimal automated test coverage and wire scripts so runtime_check can pass:',
      '- Root package.json (npm workspaces): ADD "test": "npm run test --workspaces --if-present" when workspaces exist',
      '- backend/package.json: ADD "test" script and at least one backend test file (e.g. node:test + supertest for API/store)',
      '- frontend/package.json: ADD "test" script and at least one frontend test file (e.g. vitest + @testing-library/react)',
      '- List new scripts and test file paths in contractsChanged',
    );
  }

  if (isExpressParamsTypeFailure(check)) {
    lines.push(
      '',
      'TypeScript build failure — Express req.params is string | string[]:',
      '- Normalize route params to string before service/repository calls (String(req.params.id) or Zod on params)',
      '- Fix all controllers/routes in backend scope; list files in contractsChanged',
    );
  }

  return lines.join('\n');
}

function packageRelPaths(repoRoot, packageDirs) {
  return packageDirs.map((dir) => path.relative(repoRoot, dir) || '.');
}

function collectStepsOutput(steps, { failed = false } = {}) {
  const combined = steps.map((s) => s.combined).filter(Boolean).join('\n');
  const anyFailed = failed || steps.some((s) => !s.ok);
  return {
    combined,
    logTail: anyFailed ? runtimeFailureLogTail(combined) : tailLines(combined),
  };
}

function failedRuntimeCheckResult({ command, steps, checkSteps, failedStep, repoRoot, packageDirs, failedPackage }) {
  const out = collectStepsOutput(checkSteps, { failed: true });
  return {
    ok: false,
    skipped: false,
    command: failedStep.command,
    commands: runtimeCheckCommands(),
    exitCode: failedStep.exitCode,
    steps,
    logTail: out.logTail,
    combined: out.combined,
    timedOut: failedStep.timedOut,
    packages: packageRelPaths(repoRoot, packageDirs),
    failedPackage,
  };
}

function runCheckCommandsInDir({ dir, rel, commands, repoRoot, packageDirs, steps, checkSteps }) {
  for (const command of commands) {
    const label = rel === '.' ? `check: ${command}` : `check (${rel}): ${command}`;
    const step = runShell(command, dir, label);
    checkSteps.push(step);
    steps.push(step);
    if (!step.ok) {
      return failedRuntimeCheckResult({
        command,
        steps,
        checkSteps,
        failedStep: step,
        repoRoot,
        packageDirs,
        failedPackage: rel === '.' ? undefined : rel,
      });
    }
  }
  return null;
}

/**
 * Run the configured runtime_check command in repoRoot.
 * Installs npm dependencies in each package dir missing node_modules, then runs the check command.
 * When repoRoot has package.json, runs once at root (workspaces / root scripts).
 * When only nested packages exist (e.g. backend/ + frontend/), runs the command in each package.
 * Skips when disabled or when no package.json exists anywhere under repoRoot.
 */
export function runRuntimeCheck(repoRoot) {
  const startedAtMs = Date.now();
  const done = (result) => ({ ...result, durationMs: Date.now() - startedAtMs });
  if (!runtimeCheckEnabled()) {
    return done({ ok: true, skipped: true, reason: 'disabled' });
  }

  const packageDirs = discoverPackageDirs(repoRoot);
  if (packageDirs.length === 0) {
    log('skip: no package.json in sandbox');
    return done({ ok: true, skipped: true, reason: 'no-package-json' });
  }

  const steps = [];
  const install = runDependencyInstalls(repoRoot);
  steps.push(...install.steps);
  if (!install.ok) {
    const failed = install.failed;
    return done({
      ok: false,
      skipped: false,
      command: failed.command,
      exitCode: failed.exitCode,
      steps,
      logTail: runtimeFailureLogTail(failed.combined),
      combined: failed.combined,
      timedOut: failed.timedOut,
    });
  }

  const commands = runtimeCheckCommands();

  if (hasPackageJson(repoRoot)) {
    const checkSteps = [];
    const failed = runCheckCommandsInDir({
      dir: repoRoot,
      rel: '.',
      commands,
      repoRoot,
      packageDirs,
      steps,
      checkSteps,
    });
    if (failed) return done(failed);
    const out = collectStepsOutput(checkSteps);
    return done({
      ok: true,
      skipped: false,
      command: runtimeCheckCommand(),
      commands,
      exitCode: 0,
      steps,
      logTail: out.logTail,
      combined: out.combined,
    });
  }

  const relPackages = packageRelPaths(repoRoot, packageDirs);
  log(`nested packages: ${relPackages.join(', ')}`);
  const checkSteps = [];
  for (const dir of packageDirs) {
    const rel = path.relative(repoRoot, dir) || '.';
    const failed = runCheckCommandsInDir({
      dir,
      rel,
      commands,
      repoRoot,
      packageDirs,
      steps,
      checkSteps,
    });
    if (failed) return done(failed);
  }

  const out = collectStepsOutput(checkSteps);
  return done({
    ok: true,
    skipped: false,
    command: runtimeCheckCommand(),
    commands,
    exitCode: 0,
    steps,
    logTail: out.logTail,
    combined: out.combined,
    packages: relPackages,
  });
}

export function runtimeCheckPassed(result) {
  return !result || result.skipped || result.ok;
}

/**
 * Tri-state runtime outcome for the run's signal block. A missing result (the
 * phase never ran — review gate closed, abort) fails closed when runtime is
 * required, unlike `runtimeCheckPassed` (a process-flow gate that treats absence
 * as pass-through).
 */
export function runtimeStatusOf(result, required) {
  if (result == null) return required ? 'failed' : 'skipped';
  if (result.skipped) return 'skipped';
  return result.ok ? 'passed' : 'failed';
}

/** Required + skipped ≠ accepted: acceptance demands a pass, or an honest optional skip. */
export function runtimeAcceptedOf(result, required) {
  const status = runtimeStatusOf(result, required);
  return status === 'passed' || (status === 'skipped' && !required);
}

/** Human label for Telegram (npm run build && npm test → "build & test"). */
export function runtimeCheckShortLabel(result) {
  const raw = result?.commands?.length
    ? result.commands
    : String(result?.command ?? '').split(/\s&&\s/).map((s) => s.trim()).filter(Boolean);
  const parts = [];
  for (const cmd of raw) {
    const s = String(cmd).trim();
    // Independent checks (not else-if): one combined command like
    // "npm run build && npm test" must contribute both labels, not just test.
    if (/npm\s+(run\s+)?test\b/i.test(s)) parts.push('test');
    if (/npm\s+run\s+build\b/i.test(s)) parts.push('build');
  }
  const uniq = [...new Set(parts)];
  if (uniq.includes('build') && uniq.includes('test')) return 'build & test';
  if (uniq.length) return uniq.join(' & ');
  const joined = String(result?.command ?? '').toLowerCase();
  if (/build/.test(joined) && /test/.test(joined)) return 'build & test';
  if (/build/.test(joined)) return 'build';
  if (/test/.test(joined)) return 'test';
  return 'check';
}

/** One-line summary for Telegram / compose_reply (no pass/fail emoji — header owns that). */
export function formatRuntimeCheckSummary(result, { clip, verbose } = {}) {
  const trim = clip ?? ((s, max = 360) => {
    const t = String(s ?? '').trim();
    return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
  });
  if (!result || result.skipped) {
    const why = result?.reason === 'disabled' ? 'disabled' : result?.reason ?? 'skipped';
    return `runtime_check: ${why}`;
  }
  const label = runtimeCheckShortLabel(result);
  // fixAttempts > 0 with ok means the build/test was RED, an auto-fix sub-agent ran, and the
  // re-check went GREEN. Surface that so "OK" next to a "fixed build errors" sub-agent isn't
  // ambiguous about whether the build actually passes now.
  const fixes = Number(result.fixAttempts) || 0;
  const recovered = result.ok && fixes > 0
    ? ` (was failing — auto-fixed in ${fixes} pass${fixes === 1 ? '' : 'es'}, now green)`
    : '';
  const line = result.ok
    ? `runtime_check: ${label} OK${recovered}`
    : `runtime_check: ${label} failed (exit ${result.exitCode ?? '?'})`;
  if (result.ok || !result.logTail || !verbose) return line;
  const tailBudget = /\bworkspace\s+todo-/i.test(result.combined || result.logTail || '') ? 720 : 480;
  return `${line}\n    ${trim(result.logTail.replace(/\n/g, '\n    '), tailBudget)}`;
}
