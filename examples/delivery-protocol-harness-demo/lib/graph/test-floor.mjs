// Scope-grounded test floor (deterministic existence gate).
//
// Verify is a read-only LLM forbidden to run tests, and claims are
// unscoped — so "verify grounds tests-as-claims" is not implementable yet. The
// implementable grounded gate: every require-tests implementer subAgent must leave at
// least one test SOURCE file under the top-level directories it demonstrably wrote
// to (its `filesChanged` placement hint). Existence, not behavior coverage; the
// reviewer's `testReview` stays the advisory quality lens. Known asymmetry
// (accepted): the scan dirs come from the subAgent's self-reported `filesChanged`; a
// subAgent that under-reports evades the floor.
import fs from 'node:fs';
import path from 'node:path';
import { roleRequiresTests } from '../agents.mjs';

export const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

const SKIP_SCAN_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.harness',
  '.repovine',
  '.worktrees',
]);

/**
 * Top-level directories of a subAgent's self-reported `filesChanged` — where it
 * demonstrably wrote, per-role-distinct in a monorepo. Root-level files yield no
 * scan dir. NOT `subAgent.result.scope` (defaults to `['.']` → vacuous whole-workspace
 * scan) and NOT role→directory (the run-4 false-fire).
 */
export function subAgentTestScanDirs(subAgent) {
  const dirs = new Set();
  for (const raw of subAgent?.result?.filesChanged ?? []) {
    const p = String(raw).replace(/\\/g, '/').replace(/^\.\//, '').trim();
    const slash = p.indexOf('/');
    if (slash <= 0) continue;
    const dir = p.slice(0, slash);
    // Sandbox-relative only: a confused self-report ('..', '.', absolute) must not
    // make the existence scan walk outside the workspace.
    if (dir === '.' || dir === '..' || p.startsWith('/')) continue;
    dirs.add(dir);
  }
  return [...dirs].sort();
}

/** Bounded existence scan for one test source file under repoRoot/relDir. */
export function hasTestFileUnder(repoRoot, relDir, { maxDepth = 6 } = {}) {
  const start = path.join(repoRoot, relDir);
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const ent of entries) {
      if (ent.isFile() && TEST_FILE_RE.test(ent.name)) return true;
    }
    if (depth >= maxDepth) return false;
    for (const ent of entries) {
      if (!ent.isDirectory() || SKIP_SCAN_DIRS.has(ent.name)) continue;
      if (walk(path.join(dir, ent.name), depth + 1)) return true;
    }
    return false;
  };
  return walk(start, 0);
}

/**
 * Gated = a require-tests IMPLEMENTER subAgent that changed files. Annotation-sync
 * subAgents keep their implementer role but write no code (the run-4 false-fire);
 * verify/review/orient roles never carry `requiresTests`.
 */
export function testFloorEligible(subAgent) {
  if (!subAgent || !roleRequiresTests(subAgent.role)) return false;
  if (subAgent.instanceId?.endsWith('-annotations')) return false;
  if (!(subAgent.result?.filesChanged ?? []).length) return false;
  return true;
}

/**
 * One blocker per (role, scan-dir set) whose real scope contains no test source
 * file. A subAgent whose `filesChanged` are all root-level yields no scan dir → not
 * gated. Re-scan after fix subAgents: a fix that adds tests clears the blocker.
 */
export function missingTestFloorBlockers(repoRoot, subAgents = []) {
  const out = [];
  const seen = new Set();
  for (const subAgent of subAgents) {
    if (!testFloorEligible(subAgent)) continue;
    const dirs = subAgentTestScanDirs(subAgent);
    if (!dirs.length) continue;
    const key = `${subAgent.role}:${dirs.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (dirs.some((d) => hasTestFileUnder(repoRoot, d))) continue;
    out.push(
      `grounded tests gate: ${subAgent.instanceId || subAgent.role} (${subAgent.role}) wrote under ${dirs.join(', ')} `
        + `but no *.test/*.spec source file exists there`,
    );
  }
  return out;
}
