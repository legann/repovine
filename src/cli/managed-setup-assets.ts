/**
 * Canonical managed onboarding assets (SSoT projections).
 *
 * Lists the files `repovine setup` would write per client and the exact content
 * each path should carry. Doctor compares on-disk files against this manifest.
 *
 * Cursor and Codex both project skills to `.agents/skills/`; `setup all` writes
 * in client order (cursor → claude → codex), so later clients win on conflicts.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  COMMANDS,
  CLAUDE_SHARED_SKILLS,
  CODEX_SHARED_SKILLS,
  CURSOR_RULES,
  CURSOR_SHARED_SKILLS,
  renderCursorBody,
  renderSkillMarkdown,
  type OnboardingAsset,
} from './onboarding-assets.js';
import { computeAgentsMdDiskContent, renderAgentAssets } from './agent-render.js';
import { type DoctorClient, scopeUsesAgentsMd } from './client-scope.js';

export type ManagedSetupAssetKind = 'agent' | 'skill' | 'rule' | 'agents-md';

/** Matches `repovine setup all` write order for overlapping managed paths. */
export const SETUP_ALL_MERGE_ORDER: DoctorClient[] = ['cursor', 'claude', 'codex'];

export interface ManagedSetupAsset {
  /** Repo-relative path */
  rel: string;
  expected: string;
  kind: ManagedSetupAssetKind;
}

interface ManagedSetupAssetWithClient extends ManagedSetupAsset {
  sourceClient: DoctorClient;
}

function skillsForClient(client: DoctorClient): OnboardingAsset[] {
  switch (client) {
    case 'cursor': return [...COMMANDS, ...CURSOR_SHARED_SKILLS];
    case 'claude': return [...COMMANDS, ...CLAUDE_SHARED_SKILLS];
    case 'codex': return [...COMMANDS, ...CODEX_SHARED_SKILLS];
  }
}

function skillRelPath(client: DoctorClient, asset: OnboardingAsset): string {
  if (client === 'claude') {
    return path.join('.claude', 'skills', asset.name, 'SKILL.md');
  }
  return path.join('.agents', 'skills', asset.name, 'SKILL.md');
}

function agentClientAssets(client: 'cursor' | 'claude' | 'codex'): ManagedSetupAssetWithClient[] {
  const preview = renderAgentAssets({ repoRoot: '', client, write: false }).preview ?? [];
  return preview
    .filter(asset => asset.writable)
    .map(asset => ({
      rel: asset.path,
      expected: asset.content,
      kind: 'agent' as const,
      sourceClient: client,
    }));
}

/** Collapse duplicate paths the way `setup all` overwrites on disk. */
export function mergeManagedAssetsBySetupOrder(
  assets: ManagedSetupAssetWithClient[],
): ManagedSetupAsset[] {
  const byPath = new Map<string, ManagedSetupAssetWithClient>();
  for (const asset of assets) {
    const existing = byPath.get(asset.rel);
    if (!existing) {
      byPath.set(asset.rel, asset);
      continue;
    }
    const existingRank = SETUP_ALL_MERGE_ORDER.indexOf(existing.sourceClient);
    const nextRank = SETUP_ALL_MERGE_ORDER.indexOf(asset.sourceClient);
    if (nextRank >= existingRank) {
      byPath.set(asset.rel, asset);
    }
  }
  return [...byPath.values()].map(({ sourceClient: _sourceClient, ...asset }) => asset);
}

/** Canonical managed paths + content for the active doctor client scope. */
export function listCanonicalManagedAssets(
  repoRoot: string,
  clients: DoctorClient[],
): ManagedSetupAsset[] {
  const assets: ManagedSetupAssetWithClient[] = [];
  const clientSet = new Set(clients);

  if (clientSet.has('cursor')) {
    assets.push(...agentClientAssets('cursor'));
    for (const rule of CURSOR_RULES) {
      assets.push({
        rel: path.join('.cursor', 'rules', `${rule.name}.mdc`),
        expected: renderCursorBody(rule),
        kind: 'rule',
        sourceClient: 'cursor',
      });
    }
    for (const skill of skillsForClient('cursor')) {
      assets.push({
        rel: skillRelPath('cursor', skill),
        expected: renderSkillMarkdown(skill),
        kind: 'skill',
        sourceClient: 'cursor',
      });
    }
  }

  if (clientSet.has('claude')) {
    assets.push(...agentClientAssets('claude'));
    for (const skill of skillsForClient('claude')) {
      assets.push({
        rel: skillRelPath('claude', skill),
        expected: renderSkillMarkdown(skill),
        kind: 'skill',
        sourceClient: 'claude',
      });
    }
  }

  if (clientSet.has('codex')) {
    assets.push(...agentClientAssets('codex'));
    for (const skill of skillsForClient('codex')) {
      assets.push({
        rel: skillRelPath('codex', skill),
        expected: renderSkillMarkdown(skill),
        kind: 'skill',
        sourceClient: 'codex',
      });
    }
  }

  const merged = mergeManagedAssetsBySetupOrder(assets);

  if (scopeUsesAgentsMd(clients)) {
    const canonical = renderAgentAssets({ repoRoot, client: 'agents-md', write: false }).preview?.[0];
    if (canonical) {
      merged.push({
        rel: 'AGENTS.md',
        expected: computeAgentsMdDiskContent(repoRoot, canonical.content),
        kind: 'agents-md',
      });
    }
  }

  return merged;
}

/** Read repo-relative path when present; otherwise null. */
export function readManagedFile(repoRoot: string, rel: string): string | null {
  const abs = path.join(repoRoot, rel);
  if (!fs.existsSync(abs)) return null;
  try {
    return fs.readFileSync(abs, 'utf-8');
  } catch {
    return null;
  }
}
