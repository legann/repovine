/**
 * Repository role source: the `agents.roles` section of repovine.config.json.
 *
 * Repository-owned role prose for project subagents (e.g. `dexrx-backend`).
 * The loader is a VALIDATOR, never a transformer: a brief is served
 * byte-for-byte (client frontmatter included); a file that carries protocol
 * markers or embedded result blocks is a structured error the repository owner
 * fixes — nothing is auto-cleaned. Preparing the file is the user's job.
 *
 * `at` reads the config and every brief from a committed tree-ish via
 * `git show` against the workspace git — a generic pinned-revision read
 * (a harness uses it to pin role prose to a launch baseline).
 *
 * Consumed in-process by repovine and exposed read-only through
 * `repovine agents roles [--at <tree-ish>]`. No harness/client fields here:
 * the dependency direction is strictly consumer -> CLI -> this loader.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HASH_WIDTH } from '@repovine/plugin-sdk';
import { sha256Hex } from '@repovine/plugin-sdk/internal';
import { spawnSync } from 'node:child_process';
import { isPathInsideRepo } from '../fs/containment.js';

const CONFIG_FILENAME = 'repovine.config.json';

/** Deterministic hard-contamination signatures (never auto-cleaned). */
const CONTAMINATION_SIGNATURES = [
  '<!-- repovine:agent-protocol',
  '<!-- repovine:harness-agent-briefs',
  '<!-- repovine:harness-handoff',
  '## Agent Protocol result block',
] as const;

const ROLE_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface ProjectRole {
  id: string;
  description?: string;
  /** Repository-relative ownership paths; defaults to ["."]. */
  scope: string[];
  briefPath: string;
  /** Verbatim brief bytes (frontmatter included). */
  brief: string;
  /** sha256 hex of the exact UTF-8 brief bytes. */
  hash: string;
  /** Non-blocking facts (e.g. scope excluded from the scan config). */
  advisories: string[];
}

export interface ProjectRoleSource {
  /** False when the config has no `agents.roles` section (valid: not opted in). */
  configured: boolean;
  roles: ProjectRole[];
}

export interface LoadRolesOptions {
  /** Read config + briefs from this committed tree-ish instead of the working tree. */
  at?: string;
}

type ReadResult = { ok: true; content: string } | { ok: false; error: string };

function readWorkingFile(repoRoot: string, rel: string): ReadResult {
  const abs = path.join(repoRoot, rel);
  try {
    return { ok: true, content: fs.readFileSync(abs, 'utf-8') };
  } catch (err) {
    return { ok: false, error: `cannot read ${rel}: ${(err as NodeJS.ErrnoException).code ?? String(err)}` };
  }
}

function readTreeFile(repoRoot: string, at: string, rel: string): ReadResult {
  const r = spawnSync('git', ['-C', repoRoot, 'show', `${at}:${rel}`], {
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) return { ok: false, error: `git show failed for ${rel}: ${String(r.error.message)}` };
  if (r.status !== 0) {
    const firstErr = (r.stderr || '').split(/\r?\n/)[0]; // Git for Windows can emit CRLF stderr
    return { ok: false, error: `"${at}:${rel}" is not readable from the tree: ${firstErr}` };
  }
  return { ok: true, content: r.stdout };
}

function scopeEntryError(entry: unknown): string | undefined {
  if (typeof entry !== 'string' || !entry.trim()) return 'scope entries must be non-empty strings';
  const value = entry.trim();
  if (value === '.') return undefined;
  if (path.isAbsolute(value)) return `scope "${value}" must be repository-relative`;
  if (value.split(/[\\/]/).includes('..')) return `scope "${value}" must not contain ".." segments`;
  return undefined;
}

/** Cheap deterministic scan-coverage advisory: scope named by a scan exclude. */
function scanExcludeAdvisories(scope: string[], scanExclude: unknown): string[] {
  if (!Array.isArray(scanExclude)) return [];
  const advisories: string[] = [];
  for (const entry of scope) {
    if (entry === '.') continue;
    for (const exclude of scanExclude) {
      const excludePath =
        typeof exclude === 'string'
          ? exclude
          : exclude && typeof exclude === 'object' && typeof (exclude as { path?: unknown }).path === 'string'
            ? (exclude as { path: string }).path
            : undefined;
      if (!excludePath) continue;
      const norm = excludePath.replace(/\/+$/, '');
      if (norm === entry || norm.startsWith(`${entry}/`)) {
        advisories.push(`scope "${entry}" intersects scan exclude "${excludePath}" — graph coverage may be partial (context-quality gates resolve scopes against the graph)`);
        break;
      }
    }
  }
  return advisories;
}

/**
 * Load and validate the repository role source. Returns the neutral facts or
 * a structured error list; absent section = `{ configured: false, roles: [] }`.
 */
export function loadProjectRoleSource(
  repoRoot: string,
  options: LoadRolesOptions = {},
): ProjectRoleSource | { errors: string[] } {
  const read = options.at
    ? (rel: string) => readTreeFile(repoRoot, options.at as string, rel)
    : (rel: string) => readWorkingFile(repoRoot, rel);

  const configRead = read(CONFIG_FILENAME);
  if (!configRead.ok) {
    // Working tree without a config is "not a repovine workspace" — surface it;
    // a tree-ish without the config is equally an error (the ref may be wrong).
    return { errors: [configRead.error] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(configRead.content);
  } catch (err) {
    return { errors: [`${CONFIG_FILENAME} does not parse: ${String((err as Error).message)}`] };
  }
  const config = parsed as { agents?: { roles?: unknown }; build?: { scan?: { exclude?: unknown } } };
  const rolesSection = config.agents?.roles;
  if (rolesSection === undefined) return { configured: false, roles: [] };
  if (rolesSection === null || typeof rolesSection !== 'object' || Array.isArray(rolesSection)) {
    return { errors: ['agents.roles must be an object of role entries'] };
  }
  const entries = Object.entries(rolesSection as Record<string, unknown>);
  if (entries.length === 0) return { errors: ['agents.roles is empty — remove the section or add roles'] };

  const errors: string[] = [];
  const roles: ProjectRole[] = [];
  const scanExclude = config.build?.scan?.exclude;

  for (const [id, raw] of entries) {
    const label = `role "${id}"`;
    if (!ROLE_ID_RE.test(id)) {
      errors.push(`${label}: role ids must be lowercase kebab-case`);
      continue;
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${label}: entry must be an object`);
      continue;
    }
    const entry = raw as { brief?: unknown; description?: unknown; scope?: unknown };
    if (typeof entry.brief !== 'string' || !entry.brief.trim()) {
      errors.push(`${label}: non-empty "brief" path is required`);
      continue;
    }
    const briefPath = entry.brief.trim();
    if (path.isAbsolute(briefPath) || briefPath.split(/[\\/]/).includes('..')) {
      errors.push(`${label}: brief path must be repository-relative without ".." segments`);
      continue;
    }
    if (!options.at && !isPathInsideRepo(repoRoot, briefPath)) {
      errors.push(`${label}: brief path escapes the repository after symlink resolution`);
      continue;
    }
    if (entry.description !== undefined && (typeof entry.description !== 'string' || !entry.description.trim())) {
      errors.push(`${label}: "description" must be a non-empty string when present`);
      continue;
    }

    let scope: string[] = ['.'];
    if (entry.scope !== undefined) {
      if (!Array.isArray(entry.scope) || entry.scope.length === 0) {
        errors.push(`${label}: "scope" must be a non-empty array when present`);
        continue;
      }
      const scopeErrors = entry.scope.map(scopeEntryError).filter((e): e is string => Boolean(e));
      if (scopeErrors.length > 0) {
        errors.push(`${label}: ${scopeErrors[0]}`);
        continue;
      }
      scope = (entry.scope as string[]).map(s => s.trim());
    }

    const briefRead = read(briefPath);
    if (!briefRead.ok) {
      errors.push(`${label}: ${briefRead.error}`);
      continue;
    }
    const contamination = CONTAMINATION_SIGNATURES.filter(sig => briefRead.content.includes(sig));
    if (contamination.length > 0) {
      errors.push(
        `${label}: brief carries protocol/projection content ("${contamination[0]}") — role prose must stay neutral; remove it from ${briefPath}`,
      );
      continue;
    }

    const advisories = scanExcludeAdvisories(scope, scanExclude);
    if (!options.at) {
      for (const entryPath of scope) {
        if (entryPath !== '.' && !fs.existsSync(path.join(repoRoot, entryPath))) {
          advisories.push(`scope "${entryPath}" does not exist in the working tree (allowed: scope describes ownership)`);
        }
      }
    }

    roles.push({
      id,
      ...(entry.description ? { description: (entry.description as string).trim() } : {}),
      scope,
      briefPath,
      brief: briefRead.content,
      hash: sha256Hex(briefRead.content, HASH_WIDTH.full),
      advisories,
    });
  }

  if (errors.length > 0) return { errors };
  return { configured: true, roles };
}
