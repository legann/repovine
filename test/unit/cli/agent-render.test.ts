import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { renderAgentAssets, RENDER_CLIENTS } from '../../../src/cli/agent-render.js';
import { AGENT_PROTOCOL_MARKER } from '../../../src/cli/agent-projection.js';
import { AGENTS_MD_BEGIN_MARKER, AGENTS_MD_END_MARKER } from '../../../src/cli/templates.js';
import { PROTOCOL_VERSION } from '../../../src/agents/protocol.js';

describe('renderAgentAssets', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-render-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('previews without writing by default', () => {
    const result = renderAgentAssets({ repoRoot, client: 'claude' });
    expect(result.wrote).toBe(false);
    expect(result.preview).toBeDefined();
    expect(result.assets.every(a => a.written === false)).toBe(true);
    // No files created on a preview.
    expect(fs.existsSync(path.join(repoRoot, '.claude'))).toBe(false);
  });

  it('embeds the protocol marker + explicit-use gating in every rendered agent', () => {
    const result = renderAgentAssets({ repoRoot, client: 'claude' });
    for (const asset of result.preview!) {
      expect(asset.content).toContain(AGENT_PROTOCOL_MARKER);
      expect(asset.content).toContain('Normal client conversations are not Agent Protocol runs');
      expect(asset.content).not.toContain(`"protocolVersion": "${PROTOCOL_VERSION}"`);
      expect(asset.content).toContain('contextSessionId');
    }
  });

  it('writes writable assets to standard locations when asked', () => {
    const result = renderAgentAssets({ repoRoot, client: 'claude', write: true });
    expect(result.wrote).toBe(true);
    const written = result.assets.filter(a => a.written).map(a => a.path);
    expect(written).toContain(path.join('.claude', 'agents', 'repovine-annotation-writer.md'));
    expect(written).toContain(path.join('.claude', 'agents', 'repovine-repo-explorer.md'));
    expect(written).toContain(path.join('.claude', 'agents', 'repovine-architecture-auditor.md'));
    expect(written).toContain(path.join('.claude', 'agents', 'repovine-code-reviewer.md'));
    expect(written).toContain(path.join('.claude', 'agents', '_TEMPLATE.project-subagent.md'));
    for (const p of written) {
      expect(fs.existsSync(path.join(repoRoot, p))).toBe(true);
    }
  });

  it('renders all clients and renders codex as TOML', () => {
    const result = renderAgentAssets({ repoRoot, client: 'all' });
    const clients = new Set(result.assets.map(a => a.client));
    for (const c of RENDER_CLIENTS) expect(clients.has(c)).toBe(true);
    const codex = result.preview!.find(a => a.client === 'codex' && a.agent === 'repovine-annotation-writer');
    expect(codex?.path.endsWith('.toml')).toBe(true);
    expect(codex?.content).toContain('developer_instructions');
  });

  it('projects unified propagation queue guidance into all three client annotation writers', () => {
    const result = renderAgentAssets({ repoRoot, client: 'all' });
    for (const client of ['claude', 'cursor', 'codex'] as const) {
      const asset = result.preview!.find(a => a.client === client && a.agent === 'repovine-annotation-writer');
      expect(asset?.content).toContain('Drain order (engine-sorted)');
      expect(asset?.content).toContain('content-stale (`staleKind: "content"`)');
      expect(asset?.content).toContain('staleKind: "propagation"');
      expect(asset?.content).toContain('needsWork: 0');
      expect(asset?.content).toContain('"view": "derived-review"');
      expect(asset?.content).toContain('importBaseline');
      expect(asset?.content).toContain('refreshImportBaseline');
      expect(asset?.content).toContain('upstreamTriggers');
      expect(asset?.content).not.toContain('annotation queue is empty');
      expect(asset?.content).not.toContain('totalRemaining` is the full backlog');
      expect(asset?.content).not.toContain('get_propagation_slice');
    }
  });

  it('keeps the json target preview-only (never written)', () => {
    // Even with write:true the json target is not written to disk.
    const written = renderAgentAssets({ repoRoot, client: 'json', write: true });
    expect(written.assets.find(a => a.client === 'json')?.written).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, 'repovine.agent-protocol.json'))).toBe(false);

    // Its content (available in preview mode) carries protocol + manifests.
    const preview = renderAgentAssets({ repoRoot, client: 'json' });
    const parsed = JSON.parse(preview.preview!.find(a => a.client === 'json')!.content);
    expect(parsed.protocol.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(Array.isArray(parsed.manifests)).toBe(true);
  });

  it('preserves existing AGENTS.md content when writing the agents-md projection', () => {
    const agentsPath = path.join(repoRoot, 'AGENTS.md');
    fs.writeFileSync(agentsPath, '# Team rules\n\nKeep this.\n', 'utf-8');

    const result = renderAgentAssets({ repoRoot, client: 'agents-md', write: true });
    expect(result.wrote).toBe(true);

    const content = fs.readFileSync(agentsPath, 'utf-8');
    expect(content).toContain('# Team rules');
    expect(content).toContain('Keep this.');
    expect(content).toContain(AGENTS_MD_BEGIN_MARKER);
    expect(content).toContain(AGENT_PROTOCOL_MARKER);
  });

  it('replaces only the marked repovine section in AGENTS.md', () => {
    const agentsPath = path.join(repoRoot, 'AGENTS.md');
    fs.writeFileSync(
      agentsPath,
      [
        '# Team rules',
        '',
        'Before.',
        '',
        AGENTS_MD_BEGIN_MARKER,
        'old repovine block',
        AGENTS_MD_END_MARKER,
        '',
        'After.',
        '',
      ].join('\n'),
      'utf-8',
    );

    renderAgentAssets({ repoRoot, client: 'agents-md', write: true });

    const content = fs.readFileSync(agentsPath, 'utf-8');
    expect(content).toContain('# Team rules');
    expect(content).toContain('Before.');
    expect(content).toContain('After.');
    expect(content).not.toContain('old repovine block');
    expect(content).toContain(AGENT_PROTOCOL_MARKER);
  });

  it('renders only the canonical cursor asset set and leaves unrelated .cursor/agents files untouched', () => {
    // renderAgentAssets projects a fixed manifest-derived set; it never enumerates
    // or reconciles pre-existing files under .cursor/agents. A file it did not
    // author is neither in the render set nor rewritten on disk.
    const dir = path.join(repoRoot, '.cursor', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    const customPath = path.join(dir, 'acme-backend.md');
    const original = [
      '---',
      'name: acme-backend',
      '---',
      '',
      '# Acme Backend Developer',
      '',
      'Keep this project-specific guidance.',
      '',
    ].join('\n');
    fs.writeFileSync(customPath, original, 'utf-8');

    const result = renderAgentAssets({ repoRoot, client: 'cursor', write: true });

    // Exact canonical cursor path set: 4 manifest agents + sample + template.
    const cursorPaths = result.assets.map(a => a.path).sort();
    expect(cursorPaths).toEqual(
      [
        path.join('.cursor', 'agents', 'repovine-annotation-writer.md'),
        path.join('.cursor', 'agents', 'repovine-repo-explorer.md'),
        path.join('.cursor', 'agents', 'repovine-architecture-auditor.md'),
        path.join('.cursor', 'agents', 'repovine-code-reviewer.md'),
        path.join('.cursor', 'agents', 'sample.project-subagent.md'),
        path.join('.cursor', 'agents', '_TEMPLATE.project-subagent.md'),
      ].sort(),
    );

    // The unrelated project file is not part of the render set and is byte-identical.
    expect(cursorPaths).not.toContain(path.join('.cursor', 'agents', 'acme-backend.md'));
    expect(fs.readFileSync(customPath, 'utf-8')).toBe(original);
  });
});
