import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { loadProjectRoleSource } from '../../../src/agents/roles-source.js';

const BRIEF = '---\nname: acme-backend\n---\n\n# Acme Backend\n\nRole knowledge only.\n';

function writeConfig(repoRoot: string, agents: unknown, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(repoRoot, 'repovine.config.json'),
    JSON.stringify({ ...(agents === undefined ? {} : { agents }), ...extra }),
  );
}

function git(repoRoot: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

describe('loadProjectRoleSource', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-source-'));
    fs.mkdirSync(path.join(repoRoot, '.cursor', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, '.cursor', 'agents', 'acme-backend.md'), BRIEF);
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('absent section is a valid unconfigured result', () => {
    writeConfig(repoRoot, undefined);
    expect(loadProjectRoleSource(repoRoot)).toEqual({ configured: false, roles: [] });
  });

  it('serves a valid role verbatim with hash and defaulted scope', () => {
    writeConfig(repoRoot, { roles: { 'acme-backend': { brief: '.cursor/agents/acme-backend.md', description: 'Acme backend dev' } } });
    const result = loadProjectRoleSource(repoRoot);
    if ('errors' in result) throw new Error(result.errors.join('; '));
    expect(result.configured).toBe(true);
    const role = result.roles[0];
    expect(role.id).toBe('acme-backend');
    expect(role.scope).toEqual(['.']);
    expect(role.brief).toBe(BRIEF); // byte-for-byte, frontmatter included
    expect(role.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects malformed entries with structured errors (id, missing brief, bad scope, escape)', () => {
    writeConfig(repoRoot, {
      roles: {
        'Bad_Id': { brief: '.cursor/agents/acme-backend.md' },
        'no-brief': {},
        'bad-scope': { brief: '.cursor/agents/acme-backend.md', scope: ['/abs'] },
        'escapes': { brief: '../outside.md' },
      },
    });
    const result = loadProjectRoleSource(repoRoot);
    if (!('errors' in result)) throw new Error('expected errors');
    expect(result.errors.join('\n')).toMatch(/kebab-case/);
    expect(result.errors.join('\n')).toMatch(/"brief" path is required/);
    expect(result.errors.join('\n')).toMatch(/repository-relative/);
    expect(result.errors.join('\n')).toMatch(/without "\.\." segments/);
  });

  it('an empty roles object is an error, not silence', () => {
    writeConfig(repoRoot, { roles: {} });
    const result = loadProjectRoleSource(repoRoot);
    if (!('errors' in result)) throw new Error('expected errors');
    expect(result.errors[0]).toMatch(/empty/);
  });

  it('hard contamination fails loud and is never auto-cleaned', () => {
    fs.writeFileSync(
      path.join(repoRoot, '.cursor', 'agents', 'acme-backend.md'),
      `${BRIEF}\n<!-- repovine:agent-protocol protocolVersion=1 -->\n`,
    );
    writeConfig(repoRoot, { roles: { 'acme-backend': { brief: '.cursor/agents/acme-backend.md' } } });
    const result = loadProjectRoleSource(repoRoot);
    if (!('errors' in result)) throw new Error('expected errors');
    expect(result.errors[0]).toMatch(/must stay neutral/);
  });

  it('scan-exclude intersection and missing scope paths surface as advisories, not errors', () => {
    writeConfig(
      repoRoot,
      { roles: { 'acme-infra': { brief: '.cursor/agents/acme-backend.md', scope: ['infra', 'ghost-dir'] } } },
      { build: { scan: { exclude: [{ path: 'infra/sam/template.yaml', scope: 'infra' }] } } },
    );
    fs.mkdirSync(path.join(repoRoot, 'infra'));
    const result = loadProjectRoleSource(repoRoot);
    if ('errors' in result) throw new Error(result.errors.join('; '));
    const advisories = result.roles[0].advisories.join('\n');
    expect(advisories).toMatch(/intersects scan exclude/);
    expect(advisories).toMatch(/"ghost-dir" does not exist/);
  });

  describe('--at (pinned tree-ish read)', () => {
    beforeEach(() => {
      git(repoRoot, 'init', '-q', '-b', 'main');
      writeConfig(repoRoot, { roles: { 'acme-backend': { brief: '.cursor/agents/acme-backend.md' } } });
      git(repoRoot, 'add', '-A');
      git(repoRoot, 'commit', '-qm', 'baseline');
      git(repoRoot, 'tag', 'pin');
    });

    it('serves committed content even when the working tree was edited after the pin', () => {
      fs.writeFileSync(path.join(repoRoot, '.cursor', 'agents', 'acme-backend.md'), '# EDITED BY AGENT\n');
      const result = loadProjectRoleSource(repoRoot, { at: 'pin' });
      if ('errors' in result) throw new Error(result.errors.join('; '));
      expect(result.roles[0].brief).toBe(BRIEF);
    });

    it('fails loud on an unresolvable ref and on a brief missing from the tree', () => {
      const badRef = loadProjectRoleSource(repoRoot, { at: 'no-such-ref' });
      if (!('errors' in badRef)) throw new Error('expected errors');
      expect(badRef.errors[0]).toMatch(/not readable from the tree/);

      writeConfig(repoRoot, { roles: { 'acme-backend': { brief: '.cursor/agents/uncommitted.md' } } });
      fs.writeFileSync(path.join(repoRoot, '.cursor', 'agents', 'uncommitted.md'), BRIEF);
      git(repoRoot, 'add', 'repovine.config.json');
      git(repoRoot, 'commit', '-qm', 'config points at uncommitted brief');
      const missing = loadProjectRoleSource(repoRoot, { at: 'HEAD' });
      if (!('errors' in missing)) throw new Error('expected errors');
      expect(missing.errors[0]).toMatch(/uncommitted\.md.*not readable/);
    });
  });
});
