import { describe, expect, it } from '@jest/globals';
import {
  BUILTIN_MANIFESTS,
  getManifest,
  getManifestByRole,
  getModelHints,
} from '../../../src/agents/manifests.js';
import { AGENT_ROLES, AgentRunResultSchema } from '../../../src/agents/protocol.js';

describe('built-in manifests', () => {
  it('covers all declared roles with unique names', () => {
    const roles = BUILTIN_MANIFESTS.map(m => m.role).sort();
    expect(roles).toEqual([...AGENT_ROLES].sort());
    const names = BUILTIN_MANIFESTS.map(m => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('aligns names with the onboarding asset names so projections can look them up', () => {
    expect(getManifest('repovine-annotation-writer')?.role).toBe('annotation-writer');
    expect(getManifest('repovine-repo-explorer')?.role).toBe('explorer');
    expect(getManifest('project-subagent-sample')?.role).toBe('implementer');
    expect(getManifest('repovine-architecture-auditor')?.role).toBe('architecture-auditor');
    expect(getManifest('repovine-code-reviewer')?.role).toBe('code-reviewer');
    expect(getManifest('main')?.role).toBe('main');
  });

  it('marks only implementer and main as file editors', () => {
    expect(getManifestByRole('implementer')?.canEditFiles).toBe(true);
    expect(getManifestByRole('main')?.canEditFiles).toBe(true);
    expect(getManifestByRole('explorer')?.canEditFiles).toBe(false);
    expect(getManifestByRole('annotation-writer')?.canEditFiles).toBe(false);
    expect(getManifestByRole('architecture-auditor')?.canEditFiles).toBe(false);
    expect(getManifestByRole('code-reviewer')?.canEditFiles).toBe(false);
  });

  it('declares cheap-model hints for summary-class roles only', () => {
    expect(getModelHints('repovine-annotation-writer')).toEqual({ claude: 'haiku', cursor: 'fast', codexReasoningEffort: 'low' });
    expect(getModelHints('repovine-repo-explorer')).toEqual({ claude: 'haiku', cursor: 'fast', codexReasoningEffort: 'low' });
    expect(getModelHints('repovine-architecture-auditor')).toEqual({ claude: 'haiku', cursor: 'fast', codexReasoningEffort: 'low' });
    expect(getModelHints('project-subagent-sample')).toBeUndefined();
    expect(getModelHints('repovine-code-reviewer')).toBeUndefined();
    expect(getModelHints('main')).toBeUndefined();
  });

  it('gives each role a non-empty allowedTools and requiredRunResultFields', () => {
    for (const m of BUILTIN_MANIFESTS) {
      expect(m.allowedTools.length).toBeGreaterThan(0);
      expect(new Set(m.allowedTools).size).toBe(m.allowedTools.length); // deduped
      expect(m.requiredRunResultFields.length).toBeGreaterThan(0);
      expect(m.requiredRunResultFields).toContain('summary');
    }
  });

  it('lists only real AgentRunResult schema keys in requiredRunResultFields', () => {
    // The manifest field drives compliance, but nothing tied it to the schema: a typo, or a stale name
    // after an optional artifact field (review / architectureAudit) is renamed, would validate against
    // nothing and pass. The projection skeleton test does not catch the optional-key case — its example
    // echoes the old key and the renamed optional field is absent-and-valid. Read the keys from the
    // schema shape so the guard cannot drift from the source of truth.
    const realKeys = new Set(Object.keys(AgentRunResultSchema.shape));
    expect(realKeys.size).toBeGreaterThan(0);
    const offenders = BUILTIN_MANIFESTS.flatMap(m =>
      m.requiredRunResultFields.filter(f => !realKeys.has(f)).map(f => `${m.name}: ${f}`),
    );
    expect(offenders).toEqual([]);
  });

  it('requires editors to report files and touched nodes', () => {
    const impl = getManifest('project-subagent-sample')!;
    expect(impl.requiredRunResultFields).toEqual(expect.arrayContaining(['filesChanged', 'graphNodesTouched', 'compliance']));
  });

  it('requires capability artifacts from audit and review roles', () => {
    expect(getManifest('repovine-architecture-auditor')?.requiredRunResultFields).toEqual(expect.arrayContaining(['architectureAudit']));
    expect(getManifest('repovine-code-reviewer')?.requiredRunResultFields).toEqual(expect.arrayContaining(['review']));
  });

  it('exposes context session quality to handoff-capable roles', () => {
    expect(getManifest('main')?.allowedTools).toContain('get_context_session_quality');
    expect(getManifest('project-subagent-sample')?.allowedTools).toContain('get_context_session_quality');
    expect(getManifest('repovine-repo-explorer')?.allowedTools).toContain('get_context_session_quality');
  });

  it('returns undefined for unknown lookups', () => {
    expect(getManifest('nope')).toBeUndefined();
    expect(getModelHints('nope')).toBeUndefined();
  });
});
