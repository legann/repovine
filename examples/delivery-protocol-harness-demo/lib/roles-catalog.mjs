// Role-catalog bootstrap: resolve the ACTIVE catalog for the resolved target.
//
// Every entrypoint calls this once after ensureTarget. In attach the role
// source (`agents.roles` + briefs) is read from the LAUNCH BASELINE tree —
// custody: the worktree is agent-writable, so working-tree reads would let
// episode N's agent edit its own episode-N+1 system prompt. Roles are a
// property of the launch; updating them = commit + new `prepare`.
//
// Fail-loud: a repository that OPTED IN to project roles but ships an invalid
// source aborts startup — it must not silently run on the bundled fallback.
import * as rp from './repovine.mjs';
import { initRoleCatalog } from './agents.mjs';
import { ATTACH_BASELINE_REF } from './attach-guard.mjs';
import { logLine } from './log.mjs';

const log = (msg) => logLine('roles', msg);

export function initCatalogForTarget(target) {
  const mode = target?.mode ?? 'sandbox';
  if (mode !== 'attach') return initRoleCatalog({ targetMode: mode });

  const res = rp.projectRoles(target.repoRoot, { at: ATTACH_BASELINE_REF });
  if (res.status !== 0 || !res.json) {
    const detail = res.json?.errors?.[0] ?? (res.stderr || res.stdout || 'no output').split('\n')[0];
    throw new Error(`role source invalid at ${ATTACH_BASELINE_REF}: ${detail} — fix agents.roles / the brief files and re-prepare the launch`);
  }
  const source = res.json;
  if (!source.configured) {
    log('no agents.roles in the target config — bundled specialist fallback (frontend/backend/infra)');
    return initRoleCatalog({ targetMode: mode, projectRoles: null });
  }
  const catalog = initRoleCatalog({ targetMode: mode, projectRoles: source });
  const ids = source.roles.map((r) => r.id);
  log(`project catalog from ${ATTACH_BASELINE_REF}: [${ids.join(', ')}]`);
  for (const role of source.roles) {
    for (const advisory of role.advisories ?? []) {
      log(`advisory [${role.id}]: ${advisory}`);
    }
  }
  return catalog;
}
