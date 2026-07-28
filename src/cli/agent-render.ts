/**
 * Render agent-protocol assets from the canonical manifests.
 *
 * Internal projection helper used by `repovine setup` to write protocol-governed
 * assets (per-client agent files, the AGENTS.md main-agent block, the project
 * subagent scaffold, and the raw manifests JSON) and optionally writes them to
 * their standard locations. An AGENTS.md carrying the repovine markers keeps everything
 * outside them. Without markers, a file that opens with the repovine heading is replaced
 * whole; any other file keeps its content and gets the managed block appended.
 *
 * It is a leaf consumer: it imports onboarding-assets / templates / manifests,
 * and nothing imports it except the MCP handler and CLI.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  AGENTS,
  PROJECT_SAMPLE_SUBAGENT_MD,
  PROJECT_SUBAGENT_SAMPLE_FILENAME,
  PROJECT_SUBAGENT_SAMPLE_FILENAME_CODEX,
  PROJECT_SUBAGENT_TEMPLATE_FILENAME,
  PROJECT_SUBAGENT_TEMPLATE_FILENAME_CODEX,
  PROJECT_SUBAGENT_TEMPLATE_MD,
  renderClaudeFrontmatter,
  renderCursorAgentFrontmatter,
  renderCodexAgentToml,
  renderProjectSampleSubagentToml,
  renderProjectSubagentTemplateToml,
  type OnboardingAsset,
} from './onboarding-assets.js';
import { AGENTS_MD, AGENTS_MD_BEGIN_MARKER, AGENTS_MD_END_MARKER } from './templates.js';
import { PROJECTION_VERSION } from './agent-projection.js';
import { PROTOCOL_VERSION, buildAgentProtocol } from '../agents/protocol.js';
import { BUILTIN_MANIFESTS } from '../agents/manifests.js';

export type RenderClient = 'claude' | 'cursor' | 'codex' | 'agents-md' | 'json';
export type RenderClientArg = RenderClient | 'all';

export const RENDER_CLIENTS: RenderClient[] = ['claude', 'cursor', 'codex', 'agents-md', 'json'];

export interface RenderedAgentAsset {
  client: RenderClient;
  /** Manifest/agent name; omitted for agents-md and json. */
  agent?: string;
  /** Repo-relative target path (json is preview-only and uses a nominal path). */
  path: string;
  content: string;
  /** json assets are descriptive only and are never written to disk. */
  writable: boolean;
}

export interface RenderAgentAssetsOptions {
  repoRoot: string;
  client?: RenderClientArg;
  write?: boolean;
}

export interface RenderAgentAssetsResult {
  protocolVersion: string;
  projectionVersion: string;
  client: RenderClientArg;
  wrote: boolean;
  assets: Array<{
    client: RenderClient;
    agent?: string;
    path: string;
    bytes: number;
    written: boolean;
  }>;
  /** Full rendered content (returned for preview when not writing). */
  preview?: RenderedAgentAsset[];
}

/** Agent OnboardingAssets governed by the protocol. */
function agentAssets(): OnboardingAsset[] {
  return AGENTS;
}

function claudeAssets(): RenderedAgentAsset[] {
  const out: RenderedAgentAsset[] = agentAssets().map(asset => ({
    client: 'claude' as const,
    agent: asset.name,
    path: path.join('.claude', 'agents', `${asset.name}.md`),
    content: renderClaudeFrontmatter(asset),
    writable: true,
  }));
  out.push({
    client: 'claude',
    agent: 'project-subagent-sample',
    path: path.join('.claude', 'agents', PROJECT_SUBAGENT_SAMPLE_FILENAME),
    content: PROJECT_SAMPLE_SUBAGENT_MD,
    writable: true,
  });
  out.push({
    client: 'claude',
    agent: '_TEMPLATE.project-subagent',
    path: path.join('.claude', 'agents', PROJECT_SUBAGENT_TEMPLATE_FILENAME),
    content: PROJECT_SUBAGENT_TEMPLATE_MD,
    writable: true,
  });
  return out;
}

function cursorAssets(): RenderedAgentAsset[] {
  const out: RenderedAgentAsset[] = agentAssets().map(asset => ({
    client: 'cursor' as const,
    agent: asset.name,
    path: path.join('.cursor', 'agents', `${asset.name}.md`),
    content: renderCursorAgentFrontmatter(asset),
    writable: true,
  }));
  out.push({
    client: 'cursor',
    agent: 'project-subagent-sample',
    path: path.join('.cursor', 'agents', PROJECT_SUBAGENT_SAMPLE_FILENAME),
    content: PROJECT_SAMPLE_SUBAGENT_MD,
    writable: true,
  });
  out.push({
    client: 'cursor',
    agent: '_TEMPLATE.project-subagent',
    path: path.join('.cursor', 'agents', PROJECT_SUBAGENT_TEMPLATE_FILENAME),
    content: PROJECT_SUBAGENT_TEMPLATE_MD,
    writable: true,
  });
  return out;
}

function codexAssets(): RenderedAgentAsset[] {
  const out: RenderedAgentAsset[] = agentAssets().map(asset => ({
    client: 'codex' as const,
    agent: asset.name,
    path: path.join('.codex', 'agents', `${asset.name}.toml`),
    content: renderCodexAgentToml(asset),
    writable: true,
  }));
  out.push({
    client: 'codex',
    agent: 'project-subagent-sample',
    path: path.join('.codex', 'agents', PROJECT_SUBAGENT_SAMPLE_FILENAME_CODEX),
    content: renderProjectSampleSubagentToml(),
    writable: true,
  });
  out.push({
    client: 'codex',
    agent: '_TEMPLATE.project-subagent',
    path: path.join('.codex', 'agents', PROJECT_SUBAGENT_TEMPLATE_FILENAME_CODEX),
    content: renderProjectSubagentTemplateToml(),
    writable: true,
  });
  return out;
}

function agentsMdAsset(): RenderedAgentAsset {
  return {
    client: 'agents-md',
    path: 'AGENTS.md',
    content: AGENTS_MD,
    writable: true,
  };
}

function jsonAsset(): RenderedAgentAsset {
  return {
    client: 'json',
    path: 'repovine.agent-protocol.json',
    content: JSON.stringify(
      { protocol: buildAgentProtocol(), manifests: BUILTIN_MANIFESTS },
      null,
      2,
    ),
    writable: false,
  };
}

function assetsForClient(client: RenderClient): RenderedAgentAsset[] {
  switch (client) {
    case 'claude': return claudeAssets();
    case 'cursor': return cursorAssets();
    case 'codex': return codexAssets();
    case 'agents-md': return [agentsMdAsset()];
    case 'json': return [jsonAsset()];
  }
}

function replaceMarkedAgentsMdSection(current: string, nextSection: string): string | null {
  const begin = current.indexOf(AGENTS_MD_BEGIN_MARKER);
  const end = current.indexOf(AGENTS_MD_END_MARKER);
  if (begin === -1 || end === -1 || end < begin) return null;

  const sectionEnd = end + AGENTS_MD_END_MARKER.length;
  const before = current.slice(0, begin).trimEnd();
  const after = current.slice(sectionEnd).trimStart();
  return [
    before,
    nextSection.trimEnd(),
    after,
  ].filter(Boolean).join('\n\n') + '\n';
}

function looksLikeRepoContextAgentsMd(content: string): boolean {
  const trimmed = content.trimStart();
  return trimmed.startsWith('# repovine -- quick reference')
    || trimmed.startsWith('# repovine — quick reference');
}

/**
 * Expected on-disk AGENTS.md after setup. With markers, the marked section is replaced
 * and the rest of the file stands. Without markers, a file that opens with the repovine
 * heading is replaced whole, and any other file keeps its content with the managed block
 * appended. `setup --force` bypasses the last branch and overwrites, so the expectation
 * this returns describes a run without `--force`.
 */
export function computeAgentsMdDiskContent(repoRoot: string, canonicalSection: string): string {
  const abs = path.join(repoRoot, 'AGENTS.md');
  if (!fs.existsSync(abs)) return canonicalSection;

  const current = fs.readFileSync(abs, 'utf-8');
  const marked = replaceMarkedAgentsMdSection(current, canonicalSection);
  if (marked) return marked;
  if (looksLikeRepoContextAgentsMd(current)) return canonicalSection;
  const preserved = current.trimEnd();
  return preserved
    ? `${preserved}\n\n${canonicalSection.trimEnd()}\n`
    : `${canonicalSection.trimEnd()}\n`;
}

function contentToWrite(repoRoot: string, asset: RenderedAgentAsset): string {
  if (asset.client !== 'agents-md') return asset.content;
  return computeAgentsMdDiskContent(repoRoot, asset.content);
}

/**
 * Project agent-protocol assets from the manifests. When `write` is true,
 * writable assets are written to their standard locations under `repoRoot`.
 * Per-client generated agent files are overwritten; AGENTS.md goes through
 * `computeAgentsMdDiskContent`.
 */
export function renderAgentAssets(options: RenderAgentAssetsOptions): RenderAgentAssetsResult {
  const client: RenderClientArg = options.client ?? 'all';
  const clients: RenderClient[] = client === 'all' ? RENDER_CLIENTS : [client];

  const rendered: RenderedAgentAsset[] = clients.flatMap(assetsForClient);
  const write = Boolean(options.write);

  const assets = rendered.map(asset => {
    let written = false;
    let content = asset.content;
    if (write && asset.writable) {
      const abs = path.join(options.repoRoot, asset.path);
      content = contentToWrite(options.repoRoot, asset);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf-8');
      written = true;
    }
    return {
      client: asset.client,
      ...(asset.agent ? { agent: asset.agent } : {}),
      path: asset.path,
      bytes: Buffer.byteLength(content, 'utf-8'),
      written,
    };
  });

  return {
    protocolVersion: PROTOCOL_VERSION,
    projectionVersion: PROJECTION_VERSION,
    client,
    wrote: write && assets.some(a => a.written),
    assets,
    ...(write ? {} : { preview: rendered }),
  };
}
