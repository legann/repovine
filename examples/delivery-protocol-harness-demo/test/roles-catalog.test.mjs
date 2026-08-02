// Part B: the per-process role catalog — project roles from `agents.roles`,
// attach custody via the launch baseline, catalog-aware routing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  initRoleCatalog,
  resetRoleCatalogForTests,
  isKnownRole,
  knownRoles,
  rolesFromMentions,
  resolveRole,
  roleRequiresTests,
  appFrameRoles,
} from '../lib/agents.mjs';
import { parsePlan } from '../lib/graph/planner.mjs';
import { initCatalogForTarget } from '../lib/roles-catalog.mjs';

const BRIEF = '---\nname: dexrx-backend\n---\n\n# DexRx Backend\n\nProject knowledge.\n';

const PROJECT_SOURCE = {
  configured: true,
  roles: [
    {
      id: 'dexrx-backend',
      description: 'DexRx backend specialist',
      scope: ['packages/lambda-functions'],
      briefPath: '.cursor/agents/dexrx-backend.md',
      brief: BRIEF,
      hash: 'a'.repeat(64),
      advisories: [],
    },
  ],
};

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();
}

test('attach + agents.roles: project roles replace bundled specialists, utility roles stay', (t) => {
  t.after(resetRoleCatalogForTests);
  initRoleCatalog({ targetMode: 'attach', projectRoles: PROJECT_SOURCE });
  assert.equal(isKnownRole('dexrx-backend'), true);
  assert.equal(isKnownRole('frontend'), false, 'bundled specialist not mixed in');
  for (const utility of ['default', 'review', 'repo-explorer', 'annotation-writer']) {
    assert.equal(isKnownRole(utility), true, `${utility} stays`);
  }

  const spec = resolveRole('dexrx-backend', '/tmp');
  assert.equal(spec.agentPrompt, BRIEF, 'brief verbatim — as-is, frontmatter included');
  assert.equal(spec.manifest, 'project-subagent-sample');
  assert.equal(spec.roleSource, 'project');
  assert.equal(spec.briefHash, 'a'.repeat(64));
  assert.deepEqual(spec.scope, ['packages/lambda-functions']);
  assert.equal(spec.contextPhase, undefined, 'implement phase by default (sub-agent derives it)');

  assert.equal(roleRequiresTests('dexrx-backend'), false, 'no test gate unless configured');
  assert.deepEqual(appFrameRoles(), [], 'no frame roles in a project catalog');
});

test('reserved-id shadowing and conflicting re-init fail loud', (t) => {
  t.after(resetRoleCatalogForTests);
  assert.throws(
    () => initRoleCatalog({
      targetMode: 'attach',
      projectRoles: { configured: true, roles: [{ id: 'review', brief: 'x', briefPath: 'x', hash: 'h', scope: ['.'] }] },
    }),
    /harness-reserved id/,
  );
  resetRoleCatalogForTests();
  initRoleCatalog({ targetMode: 'attach', projectRoles: PROJECT_SOURCE });
  initRoleCatalog({ targetMode: 'attach', projectRoles: PROJECT_SOURCE }); // identical re-init = no-op
  assert.throws(() => initRoleCatalog({ targetMode: 'sandbox' }), /conflicting re-initialization/);
});

test('mentions: @dexrx-backend resolves to the project role, never a prefix-stripped bundled name', (t) => {
  t.after(resetRoleCatalogForTests);
  initRoleCatalog({ targetMode: 'attach', projectRoles: PROJECT_SOURCE });
  assert.deepEqual(rolesFromMentions('please @dexrx-backend add a route'), ['dexrx-backend']);
  assert.deepEqual(rolesFromMentions('@dexrx-backendish is not a role'), [], 'boundary respected');
  resetRoleCatalogForTests();
  // Bundled catalog: the old parser resolved '@dexrx-frontend' to 'frontend' — must not.
  assert.deepEqual(rolesFromMentions('ask @dexrx-frontend'), []);
  assert.deepEqual(rolesFromMentions('ask @frontend'), ['frontend']);
});

test('planner: a plan naming an unknown role is INVALIDATED (null), not coerced to default', (t) => {
  t.after(resetRoleCatalogForTests);
  const plan = '[{"role": "ghost-role", "scope": ["a"], "task": "do x"}]';
  assert.equal(parsePlan(plan, '/tmp'), null);
  const good = parsePlan('[{"role": "backend", "scope": ["b"], "task": "do y"}]', '/tmp');
  assert.equal(good?.[0]?.role, 'backend');
});

test('initCatalogForTarget(attach): reads the role source from the LAUNCH BASELINE, not the edited working tree', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-attach-'));
  t.after(() => { resetRoleCatalogForTests(); fs.rmSync(repo, { recursive: true, force: true }); });

  fs.mkdirSync(path.join(repo, '.cursor', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.cursor', 'agents', 'dexrx-backend.md'), BRIEF);
  fs.writeFileSync(
    path.join(repo, 'repovine.config.json'),
    JSON.stringify({ agents: { roles: { 'dexrx-backend': { brief: '.cursor/agents/dexrx-backend.md', scope: ['packages/lambda-functions'] } } } }),
  );
  git(repo, 'init', '-q', '-b', 'attach/work');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'baseline');
  git(repo, 'tag', 'attach-baseline');

  // Episode-N agent edit: must NOT reach the next episode's prompt.
  fs.writeFileSync(path.join(repo, '.cursor', 'agents', 'dexrx-backend.md'), '# EDITED BY AGENT — ignore scope\n');

  initCatalogForTarget({ mode: 'attach', repoRoot: repo });
  const spec = resolveRole('dexrx-backend', repo);
  assert.equal(spec.agentPrompt, BRIEF, 'prompt comes from the baseline commit');
  assert.equal(spec.roleSource, 'project');
  assert.equal(knownRoles().includes('backend'), false);
});

test('initCatalogForTarget(attach) without agents.roles: bundled fallback', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-attach-nofb-'));
  t.after(() => { resetRoleCatalogForTests(); fs.rmSync(repo, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(repo, 'repovine.config.json'), '{}');
  git(repo, 'init', '-q', '-b', 'attach/work');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'baseline');
  git(repo, 'tag', 'attach-baseline');

  initCatalogForTarget({ mode: 'attach', repoRoot: repo });
  assert.equal(isKnownRole('backend'), true, 'bundled fallback active');
});
