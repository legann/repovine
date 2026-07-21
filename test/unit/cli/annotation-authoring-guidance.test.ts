import { describe, expect, it } from '@jest/globals';
import {
  ANNOTATION_RISK_SHAPE_GUIDANCE,
  ANNOTATIONS_SKILL,
  renderSkillMarkdown,
} from '../../../src/cli/onboarding-assets.js';
import { renderAgentAssets } from '../../../src/cli/agent-render.js';

// Guidance for authoring scoped-risk text at the right altitude: state the
// obligation, withhold the mechanism (leak-guard), plus a boundary risk-text
// rule and an optional conversion-verification step in the orchestration skill.
// The altitude counter-note was intentionally dropped (option A) because it was
// added to ANNOTATION_QUALITY_PUSH, an unwired/dead constant; that constant has
// since been deleted, and its three-axis completeness/consistency/provenance
// message is delivered live by the Agent Protocol section embedded in every
// rendered agent (renderClientProtocolGuidanceSection).
describe('annotation authoring — risk-text altitude guidance', () => {
  describe('ANNOTATION_RISK_SHAPE_GUIDANCE (SSOT, wired into agents + skills)', () => {
    it('states the consumer obligation AND withholds the mechanism (leak-guard)', () => {
      expect(ANNOTATION_RISK_SHAPE_GUIDANCE).toContain('state the importer obligation');
      expect(ANNOTATION_RISK_SHAPE_GUIDANCE).toContain('withhold the mechanism');
      expect(ANNOTATION_RISK_SHAPE_GUIDANCE).toContain('acknowledgement-without-action');
    });

    it('carries the boundary risk-text rule (contract status, not migration recipe)', () => {
      expect(ANNOTATION_RISK_SHAPE_GUIDANCE).toContain('contract/compat/wire status');
      expect(ANNOTATION_RISK_SHAPE_GUIDANCE).toContain('in-place edit wrong');
    });
  });

  describe('ANNOTATION_QUALITY_PUSH deleted — three-axis quality guidance stays delivered live', () => {
    it('no longer exports the dead ANNOTATION_QUALITY_PUSH constant', async () => {
      const mod = await import('../../../src/cli/onboarding-assets.js');
      expect((mod as Record<string, unknown>).ANNOTATION_QUALITY_PUSH).toBeUndefined();
    });

    for (const client of ['claude', 'cursor', 'codex'] as const) {
      it(`the rendered annotation-writer agent (${client}) still states the three completeness/consistency/provenance axes`, () => {
        const result = renderAgentAssets({ repoRoot: '', client });
        const writer = result.preview!.find(a => a.agent === 'repovine-annotation-writer');
        expect(writer).toBeDefined();
        expect(writer!.content).toContain('three orthogonal axes');
        expect(writer!.content).toContain('completeness only');
      });
    }
  });

  describe('WS3 conversion verification is orchestration-only', () => {
    it('the repovine-annotations skill documents the optional verification step', () => {
      const md = renderSkillMarkdown(ANNOTATIONS_SKILL);
      expect(md).toContain('Optional conversion verification');
      expect(md).toContain('acknowledged-but-ungated');
    });

    it('the cheap batch annotation-writer agent does NOT carry the verification loop', () => {
      const result = renderAgentAssets({ repoRoot: '', client: 'claude' });
      const writer = result.preview!.find(a => a.agent === 'repovine-annotation-writer');
      expect(writer).toBeDefined();
      expect(writer!.content).not.toContain('Optional conversion verification');
    });
  });

  describe('delivery: leak-guard + boundary text reach every rendered annotation-writer agent', () => {
    for (const client of ['claude', 'cursor', 'codex'] as const) {
      it(`client ${client} carries the clauses`, () => {
        const result = renderAgentAssets({ repoRoot: '', client });
        const writer = result.preview!.find(a => a.agent === 'repovine-annotation-writer');
        expect(writer).toBeDefined();
        expect(writer!.content).toContain('withhold the mechanism');
        expect(writer!.content).toContain('in-place edit wrong');
      });
    }
  });
});
