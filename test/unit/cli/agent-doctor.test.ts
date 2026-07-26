import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { doctorAgentAssets, runAgentAssetDoctor, agentAssetDoctorCliFindings } from '../../../src/cli/agent-doctor.js';
import { renderAgentAssets } from '../../../src/cli/agent-render.js';
import { initCodex, initCursor } from '../../../src/cli/init.js';
import {
  COMMANDS,
  CURSOR_RULES,
  CURSOR_SHARED_SKILLS,
  CODEX_SHARED_SKILLS,
  renderSkillMarkdown,
} from '../../../src/cli/onboarding-assets.js';
import { toolDefs } from '../../../src/mcp/tool-defs.js';

const validToolNames = toolDefs.map(d => d.name);

function writeCursorMcp(repoRoot: string): void {
  fs.mkdirSync(path.join(repoRoot, '.cursor'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: { repovine: { command: 'node', args: [] } } }),
  );
}

function writeCursorRules(repoRoot: string): void {
  const dir = path.join(repoRoot, '.cursor', 'rules');
  fs.mkdirSync(dir, { recursive: true });
  for (const rule of CURSOR_RULES) {
    fs.writeFileSync(path.join(dir, `${rule.name}.mdc`), rule.body);
  }
}

function writeCursorSkills(repoRoot: string): void {
  for (const skill of [...COMMANDS, ...CURSOR_SHARED_SKILLS]) {
    const dir = path.join(repoRoot, '.agents', 'skills', skill.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), renderSkillMarkdown(skill));
  }
}

describe('doctorAgentAssets', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-doctor-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('reports clean for freshly rendered assets', () => {
    renderAgentAssets({ repoRoot, client: 'claude', write: true });
    renderAgentAssets({ repoRoot, client: 'agents-md', write: true });
    const report = doctorAgentAssets({ repoRoot, validToolNames, client: 'all' });
    expect(report.ok).toBe(true);
    expect(report.summary.errors).toBe(0);
    expect(report.governed.length).toBeGreaterThan(0);
  });

  it('flags stale managed agent content against canonical templates', () => {
    const dir = path.join(repoRoot, '.claude', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'repovine-annotation-writer.md'), '---\nname: repovine-annotation-writer\n---\n\nOld body.\n');

    const report = doctorAgentAssets({ repoRoot, validToolNames, client: 'claude' });
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: path.join('.claude', 'agents', 'repovine-annotation-writer.md'),
        code: 'stale-managed-content',
      }),
    ]));
  });

  it('governs repovine-architecture-auditor and repovine-code-reviewer template drift', () => {
    renderAgentAssets({ repoRoot, client: 'cursor', write: true });
    const rel = path.join('.cursor', 'agents', 'repovine-code-reviewer.md');
    fs.writeFileSync(
      path.join(repoRoot, rel),
      '---\nname: repovine-code-reviewer\n---\n\nStripped body.\n',
    );

    const report = doctorAgentAssets({ repoRoot, validToolNames, client: 'cursor' });
    expect(report.governed).toContain(rel);
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: rel,
        code: 'stale-managed-content',
      }),
    ]));
  });

  it('flags stale skill content when the skill file exists on disk', () => {
    writeCursorSkills(repoRoot);
    const rel = path.join('.agents', 'skills', 'repovine-annotations', 'SKILL.md');
    fs.writeFileSync(path.join(repoRoot, rel), '# stale skill\n');

    const report = doctorAgentAssets({ repoRoot, validToolNames, client: 'cursor' });
    expect(report.governed).toContain(rel);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: rel, code: 'stale-managed-content' }),
    ]));
  });

  it('cursor-only scope skips AGENTS.md when rules and agents are current', () => {
    writeCursorMcp(repoRoot);
    writeCursorRules(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# Old AGENTS.md without protocol markers\n');
    renderAgentAssets({ repoRoot, client: 'cursor', write: true });

    const report = doctorAgentAssets({ repoRoot, validToolNames, client: 'cursor' });
    expect(report.clients).toEqual(['cursor']);
    expect(report.findings.filter(f => f.file === 'AGENTS.md')).toHaveLength(0);
    expect(report.ok).toBe(true);
    expect(report.governed).toContain(path.join('.cursor', 'rules', 'repovine-policy.mdc'));
  });

  it('warns when Cursor rules coexist with generated repovine AGENTS.md', () => {
    writeCursorMcp(repoRoot);
    writeCursorRules(repoRoot);
    renderAgentAssets({ repoRoot, client: 'cursor', write: true });
    renderAgentAssets({ repoRoot, client: 'agents-md', write: true });

    const report = doctorAgentAssets({ repoRoot, validToolNames, client: 'cursor' });
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: 'Cursor instruction surfaces',
        severity: 'warning',
        code: 'mixed-cursor-instruction-surfaces',
        message: expect.stringContaining('scorecards intentionally use Cursor-only init surfaces'),
      }),
    ]));
    expect(report.findings.filter(f => f.file === 'AGENTS.md')).toHaveLength(0);
  });

  it('does not warn on mixed surfaces when AGENTS.md only mimics the repovine title', () => {
    writeCursorMcp(repoRoot);
    writeCursorRules(repoRoot);
    renderAgentAssets({ repoRoot, client: 'cursor', write: true });
    fs.writeFileSync(
      path.join(repoRoot, 'AGENTS.md'),
      '# repovine -- quick reference\n\nCustom notes without managed markers.\n',
    );

    const report = doctorAgentAssets({ repoRoot, validToolNames, client: 'cursor' });
    expect(report.ok).toBe(true);
    expect(report.findings.some(f => f.code === 'mixed-cursor-instruction-surfaces')).toBe(false);
  });

  it('maps mixed-surface advisory without suggesting agents render', () => {
    writeCursorMcp(repoRoot);
    writeCursorRules(repoRoot);
    renderAgentAssets({ repoRoot, client: 'cursor', write: true });
    renderAgentAssets({ repoRoot, client: 'agents-md', write: true });

    const report = doctorAgentAssets({ repoRoot, validToolNames, client: 'cursor' });
    const cliFindings = agentAssetDoctorCliFindings(report);
    const mixed = cliFindings.find(f => f.message.includes('mixed-cursor-instruction-surfaces'));
    expect(mixed?.action).toContain('Cursor scorecards exclude AGENTS.md');
    expect(mixed?.action).not.toContain('agents render');
    expect(mixed?.action).toContain('setup all');
  });

  it('auto-detects cursor scope from MCP config and ignores stale AGENTS.md', () => {
    writeCursorMcp(repoRoot);
    writeCursorRules(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# Old AGENTS.md without protocol markers\n');
    renderAgentAssets({ repoRoot, client: 'cursor', write: true });

    const report = doctorAgentAssets({ repoRoot, validToolNames });
    expect(report.clientScope).toBe('auto');
    expect(report.detectedClients).toEqual(['cursor']);
    expect(report.clients).toEqual(['cursor']);
    expect(report.findings.filter(f => f.file === 'AGENTS.md')).toHaveLength(0);
    expect(report.ok).toBe(true);
  });

  it('claude scope compares AGENTS.md against canonical managed content', () => {
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# repovine -- quick reference\n\nNo managed section.\n');

    const report = doctorAgentAssets({ repoRoot, validToolNames, client: 'claude' });
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: 'AGENTS.md',
        code: 'stale-managed-content',
      }),
    ]));
  });

  it('flags stale AGENTS.md that still requires AgentRunResult as a normal finish block', () => {
    renderAgentAssets({ repoRoot, client: 'agents-md', write: true });
    const rel = path.join(repoRoot, 'AGENTS.md');
    const current = fs.readFileSync(rel, 'utf-8');
    fs.writeFileSync(
      rel,
      current.replace(
        'Normal client conversations are not Agent Protocol runs',
        'When the run finishes, return an AgentRunResult block',
      ),
    );

    const report = doctorAgentAssets({ repoRoot, validToolNames, client: 'claude' });
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: 'AGENTS.md',
        code: 'stale-managed-content',
      }),
    ]));
  });

  it('does not flag absent managed files when setup was not run for that surface', () => {
    const report = doctorAgentAssets({ repoRoot, validToolNames, client: 'cursor' });
    expect(report.findings.filter(f => f.code === 'stale-managed-content')).toHaveLength(0);
    expect(report.ok).toBe(true);
  });

  it('never scans harness demo paths — the doctor checks only surfaces core owns', () => {
    const handoffDir = path.join(repoRoot, 'repovine/examples/agent-harness-demo/lib/handoff');
    fs.mkdirSync(handoffDir, { recursive: true });
    fs.writeFileSync(path.join(handoffDir, 'handoff.md'), '# stale handoff\n');
    const agentsDir = path.join(repoRoot, 'repovine/examples/agent-harness-demo/lib/agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'repo-explorer.md'), '# stale\n## Harness orient phase\n\nold\n');

    const report = doctorAgentAssets({ repoRoot, validToolNames, client: 'cursor' });
    expect(report.scanned.some(f => f.includes('agent-harness-demo'))).toBe(false);
    expect(report.findings.some(f => f.file.includes('agent-harness-demo'))).toBe(false);
  });

  it('matches setup all for shared .agents/skills when cursor and codex are both in scope', () => {
    for (const skill of [...COMMANDS, ...CURSOR_SHARED_SKILLS]) {
      const dir = path.join(repoRoot, '.agents', 'skills', skill.name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), renderSkillMarkdown(skill));
    }
    for (const skill of [...COMMANDS, ...CODEX_SHARED_SKILLS]) {
      const dir = path.join(repoRoot, '.agents', 'skills', skill.name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), renderSkillMarkdown(skill));
    }

    const report = doctorAgentAssets({ repoRoot, validToolNames, client: 'all' });
    expect(report.findings.filter(f => f.file.includes('repovine-workflow') && f.code === 'stale-managed-content')).toHaveLength(0);
  });

  it.each([
    ['cursor then codex', ['cursor', 'codex']],
    ['codex then cursor', ['codex', 'cursor']],
    ['cursor, codex, cursor', ['cursor', 'codex', 'cursor']],
    ['codex, cursor, codex', ['codex', 'cursor', 'codex']],
  ] as const)('keeps shared skills and native policies correct after setup order: %s', (_label, order) => {
    const initialCursorWorkflow = renderSkillMarkdown(
      CURSOR_SHARED_SKILLS.find(skill => skill.name === 'repovine-workflow')!,
    );
    const initialCodexWorkflow = renderSkillMarkdown(
      CODEX_SHARED_SKILLS.find(skill => skill.name === 'repovine-workflow')!,
    );
    expect(initialCursorWorkflow).toBe(initialCodexWorkflow);

    for (const client of order) {
      if (client === 'cursor') {
        initCursor(repoRoot, { forceBootstrap: false, replaceMcp: false });
      } else {
        initCodex(repoRoot, { forceBootstrap: false, replaceMcp: false });
      }
    }

    const workflow = fs.readFileSync(
      path.join(repoRoot, '.agents', 'skills', 'repovine-workflow', 'SKILL.md'),
      'utf-8',
    );
    const cursorPolicy = fs.readFileSync(
      path.join(repoRoot, '.cursor', 'rules', 'repovine-subagent-orchestration.mdc'),
      'utf-8',
    );
    const codexPolicy = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf-8');
    expect(workflow).toBe(initialCursorWorkflow);
    expect(workflow).toContain("Use the active client's native agent surface");
    expect(workflow).not.toContain('.cursor/agents/*.md');
    expect(workflow).not.toContain('.codex/agents/*.toml');
    expect(cursorPolicy).toContain('Cursor: `.cursor/agents/*.md`');
    expect(codexPolicy).toContain('Codex uses `.codex/agents/*.toml`');

    const report = doctorAgentAssets({ repoRoot, validToolNames, client: 'all' });
    expect(report.ok).toBe(true);
    expect(report.findings.filter(
      finding => finding.file.includes('repovine-workflow')
        && finding.code === 'stale-managed-content',
    )).toHaveLength(0);
  });

  it('flags references to unknown tool-like names', () => {
    const dir = path.join(repoRoot, '.claude', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    const rendered = renderAgentAssets({ repoRoot, client: 'claude' }).preview!
      .find(a => a.agent === 'repovine-repo-explorer')!.content;
    fs.writeFileSync(path.join(dir, 'repovine-repo-explorer.md'), `${rendered}\n\nAlso call write_semantic_note().\n`);

    const report = doctorAgentAssets({ repoRoot, validToolNames, client: 'claude' });
    const unknown = report.findings.filter(f => f.code === 'unknown-tool-name');
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown[0].message).toContain('write_semantic_note');
  });

  it('flags unknown tool-like names by comparing against the current tool registry', () => {
    const dir = path.join(repoRoot, '.claude', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    const rendered = renderAgentAssets({ repoRoot, client: 'claude' }).preview!
      .find(a => a.agent === 'repovine-repo-explorer')!.content;
    fs.writeFileSync(path.join(dir, 'repovine-repo-explorer.md'), `${rendered}\n\nAlso call get_totally_fake_context().\n`);

    const report = doctorAgentAssets({ repoRoot, validToolNames, client: 'claude' });
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unknown-tool-name', message: expect.stringContaining('get_totally_fake_context') }),
    ]));
  });

  it('ignores unmanaged agent files without comparing them to templates', () => {
    const dir = path.join(repoRoot, '.claude', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'my-custom-agent.md'), '---\nname: my-custom-agent\n---\n\nUnrelated user agent.\n');

    const report = doctorAgentAssets({ repoRoot, validToolNames, client: 'claude' });
    expect(report.governed).not.toContain(path.join('.claude/agents', 'my-custom-agent.md'));
    expect(report.ok).toBe(true);
  });

  it('does not govern local project agents even when they carry a protocol marker', () => {
    const dir = path.join(repoRoot, '.cursor', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'acme-backend.md'),
      [
        '---',
        'name: acme-backend',
        '---',
        '',
        '# Local project agent',
        '',
        '<!-- repovine:agent-protocol protocolVersion=1 projection=1 -->',
        '',
        'Use `search_context` before edits.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const report = doctorAgentAssets({ repoRoot, validToolNames, client: 'cursor' });
    expect(report.scanned).toContain(path.join('.cursor', 'agents', 'acme-backend.md'));
    expect(report.governed).not.toContain(path.join('.cursor', 'agents', 'acme-backend.md'));
    expect(report.findings.filter(f => f.file.endsWith('acme-backend.md') && f.code === 'stale-managed-content')).toEqual([]);
  });

  it('agentAssetDoctorCliFindings mirrors runAgentAssetDoctor for repovine doctor', () => {
    renderAgentAssets({ repoRoot, client: 'claude', write: true });
    renderAgentAssets({ repoRoot, client: 'agents-md', write: true });
    const report = runAgentAssetDoctor({ repoRoot, validToolNames, client: 'claude' });
    const cliFindings = agentAssetDoctorCliFindings(report);
    expect(report.ok).toBe(true);
    expect(cliFindings).toEqual([{
      area: 'agent assets',
      severity: 'ok',
      message: expect.stringContaining('match canonical templates'),
    }]);
  });
});
