import { describe, expect, it } from '@jest/globals';
import {
  PROJECTION_VERSION,
  AGENT_PROTOCOL_MARKER,
  renderStructuredResultBlock,
  renderClientProtocolGuidanceSection,
  renderMainAgentProtocolSection,
  renderImplementerBrief,
} from '../../../src/cli/agent-projection.js';
import { PROTOCOL_VERSION, AgentRunResultSchema } from '../../../src/agents/protocol.js';
import { BUILTIN_MANIFESTS, getManifest } from '../../../src/agents/manifests.js';
import {
  ANNOTATION_INSPECT_SCOPE_POLICY,
  ANNOTATION_RISK_SCOPE_CANDIDATE_ADVISORY,
  ANNOTATION_RUNTIME_RESOURCE_HANDOFF_AUTHORING,
  ANNOTATION_WRITER_AGENT,
  ANNOTATIONS_SKILL,
  ARCHITECTURE_AUDITOR_AGENT,
  CODE_REVIEWER_AGENT,
  CURSOR_RULES,
  CURSOR_SHARED_SKILLS,
  REFRESH_COMMAND,
  REPO_EXPLORER_AGENT,
  PROJECT_SAMPLE_SUBAGENT_MD,
  RUNTIME_HANDOFF_WORKFLOW_NOTE,
  STATUS_COMMAND,
  renderSkillMarkdown,
} from '../../../src/cli/onboarding-assets.js';
import { AGENTS_MD } from '../../../src/cli/templates.js';

describe('agent projection helpers', () => {
  it('emits a valid structured result block', () => {
    const block = JSON.parse(renderStructuredResultBlock());
    expect(block.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(block).toHaveProperty('compliance.refreshContextRun');
    expect(block).toHaveProperty('graphNodesTouched');
    // The emitted example must itself be a schema-valid AgentRunResult, so a
    // dropped required field (e.g. status) or wrong-typed compliance flag fails.
    expect(AgentRunResultSchema.safeParse(block).success).toBe(true);
  });

  it('shows every role-required artifact in the skeleton it renders', () => {
    // A field named as required but absent from the example is a trap: the agent copies the
    // skeleton it was shown, and compliance then rejects the result for the field it never saw.
    // This is what left `review` unemitted by every code-reviewer run.
    for (const manifest of BUILTIN_MANIFESTS) {
      const block = JSON.parse(renderStructuredResultBlock(manifest));
      for (const field of manifest.requiredRunResultFields) {
        expect(block).toHaveProperty(field);
      }
      expect(AgentRunResultSchema.safeParse(block).success).toBe(true);
    }
  });

  it('gives the code-reviewer its review artifact and enum vocabulary', () => {
    const brief = renderImplementerBrief(getManifest('repovine-code-reviewer')!);
    const fence = /```json\n([\s\S]*?)\n```/.exec(brief);
    const block = JSON.parse(fence![1]);
    expect(block).toHaveProperty('review.verdict');
    expect(block).toHaveProperty('review.testReview.coverageAssessment');
    expect(brief).toContain('approve | changes-requested | needs-human | blocked');
  });

  it('embeds marker, conditional protocol guidance, and required fields in client guidance', () => {
    const section = renderClientProtocolGuidanceSection(getManifest('project-subagent-sample')!);
    expect(section).toContain(AGENT_PROTOCOL_MARKER);
    expect(section).toContain(`Agent Protocol v${PROTOCOL_VERSION}`);
    expect(section).toContain('Normal client conversations are not Agent Protocol runs');
    expect(section).toContain('Only return an **Agent Protocol');
    expect(section).not.toContain(`"protocolVersion": "${PROTOCOL_VERSION}"`);
    expect(section).toContain('refresh_context');
    expect(section).toContain('write_annotation');
    expect(section).toContain('repovine.annots.json');
    expect(section).toContain('implementer');
    expect(section).toContain('filesChanged');
  });

  it('bakes the current projection version into the marker', () => {
    expect(AGENT_PROTOCOL_MARKER).toContain(`protocolVersion=${PROTOCOL_VERSION}`);
    expect(AGENT_PROTOCOL_MARKER).toContain(`projection=${PROJECTION_VERSION}`);
  });

  it('describes implement vs annotate phases in the harness brief', () => {
    const brief = renderImplementerBrief(getManifest('project-subagent-sample')!);
    expect(brief).toContain('phase is "annotate"');
    // Build-lifecycle awareness in the orient step: building → retry; terminal cancelled → re-trigger.
    expect(brief).toContain('status:"building", check get_build_status and retry');
    expect(brief).toContain('status:"cancelled" (no graph), call refresh_context once to re-trigger a build');
    expect(brief).toContain('annotationsClean=false');
    // Topology-neutral: explore/implement/annotate are context phases, not a mandatory
    // scheduler sequence. The canonical brief must NOT prescribe deferred annotation
    // sync or a same-session post-review resume — those are harness decisions.
    expect(brief).toContain('scheduling decision, not a protocol rule');
    expect(brief).not.toContain('resumes THIS SAME session');
    expect(brief).not.toContain('dedicated annotate phase after review passes');
    expect(brief).not.toContain('deferred here by design');
    expect(brief).not.toContain('Do NOT call write_annotation in this phase');
    expect(brief).toContain('needsWork is 0');
    expect(brief).toContain('riskScopeCandidates');
    expect(brief).toContain('advisory authoring candidates, not proof');
    expect(brief).toContain('no suppression state in v1');
    expect(brief).not.toContain('derived-review", "scope"');
    expect(brief).toContain('derive annotation obligations from relevant `invariants`, `risks`, `dataFlow`');
    expect(brief).toContain('do not bound inspect scope');
    expect(brief).toContain('Locality:');
    expect(brief).toContain('nodeIds were left unchanged');
    // new inspect-scope semantics — guard against silent regression
    expect(brief).toContain('breadth is the task'); // task-conditioned closure
    expect(brief).toContain('consumed at mount and render predicates'); // derived-flag nudge
    expect(brief).toContain('Investigate channel'); // investigate channel (migrated from risk:true)
    expect(brief).toContain('Enumerate-before-unchanged'); // intra-node enumeration obligation
    expect(brief).toContain('affordanceCount'); // affordance count surfaced in the enumeration obligation
    expect(brief).toContain('consumer-scoped risk');
    expect(brief).toContain('not closeable as verified or already-correct'); // accept-loophole closed
    expect(brief).toContain('accepted requires explicit user sign-off');
    expect(brief).toContain('must preserve required behavior/contracts');
    expect(brief).toContain('Unclosed relevant obligations belong in blockers or partial compliance');
    expect(brief).toContain(`"protocolVersion": "${PROTOCOL_VERSION}"`);
  });
});

describe('projection inversion (identity from manifests)', () => {
  it('projects agent identity from the canonical manifests', () => {
    expect(ANNOTATION_WRITER_AGENT.name).toBe(getManifest('repovine-annotation-writer')!.name);
    expect(ANNOTATION_WRITER_AGENT.description).toBe(getManifest('repovine-annotation-writer')!.description);
    expect(ANNOTATION_WRITER_AGENT.claudeModel).toBe('haiku');
    expect(REPO_EXPLORER_AGENT.name).toBe(getManifest('repovine-repo-explorer')!.name);
    expect(REPO_EXPLORER_AGENT.cursorModel).toBe('fast');
  });

  it('embeds conditional protocol guidance in all built-in utility agents', () => {
    for (const asset of [ANNOTATION_WRITER_AGENT, REPO_EXPLORER_AGENT, ARCHITECTURE_AUDITOR_AGENT, CODE_REVIEWER_AGENT]) {
      expect(asset.body).toContain(AGENT_PROTOCOL_MARKER);
      expect(asset.body).toContain('Normal client conversations are not Agent Protocol runs');
      expect(asset.body).not.toContain(`"protocolVersion": "${PROTOCOL_VERSION}"`);
    }
  });

  it('embeds conditional protocol guidance in the project subagent scaffold', () => {
    expect(PROJECT_SAMPLE_SUBAGENT_MD).toContain(AGENT_PROTOCOL_MARKER);
    expect(PROJECT_SAMPLE_SUBAGENT_MD).toContain('Normal client conversations are not Agent Protocol runs');
    expect(PROJECT_SAMPLE_SUBAGENT_MD).not.toContain(`"protocolVersion": "${PROTOCOL_VERSION}"`);
  });

  it('embeds the main-agent protocol section into AGENTS.md', () => {
    expect(AGENTS_MD).toContain('## Agent Protocol');
    expect(AGENTS_MD).toContain(AGENT_PROTOCOL_MARKER);
    expect(AGENTS_MD).toContain(`Agent Protocol v${PROTOCOL_VERSION}`);
    expect(AGENTS_MD).toContain('get_context_session_quality');
    expect(AGENTS_MD).toContain('repovine.annots.json');
    expect(renderMainAgentProtocolSection()).toContain('Normal client conversations are not Agent Protocol runs');
    expect(renderMainAgentProtocolSection()).not.toContain(`"protocolVersion": "${PROTOCOL_VERSION}"`);
  });

  it('keeps AGENTS.md thin while Cursor carries full orchestration rules', () => {
    const cursorOrchestration = CURSOR_RULES.find(rule => rule.name === 'repovine-subagent-orchestration')?.body ?? '';
    expect(AGENTS_MD).toContain('repovine-review');
    expect(AGENTS_MD).not.toContain('Architecture audits use `repovine-architecture-auditor`');
    expect(AGENTS_MD).not.toContain('read-only implementation/diff reviews use `repovine-code-reviewer`');
    expect(cursorOrchestration).toContain('repovine-architecture-auditor');
    expect(cursorOrchestration).toContain('repovine-code-reviewer');
    expect(cursorOrchestration).toContain('Architecture audits');
    expect(cursorOrchestration).toContain('read-only implementation/diff reviews');
  });
});

describe('onboarding workflow projection', () => {
  it('projects annotation inspect-scope policy into workflow skill and cursor rule', () => {
    const workflowSkill = CURSOR_SHARED_SKILLS.find(skill => skill.name === 'repovine-workflow');
    const workflowRule = CURSOR_RULES.find(rule => rule.name === 'repovine-workflow');
    expect(workflowSkill).toBeDefined();
    expect(workflowRule).toBeDefined();

    const renderedSkill = renderSkillMarkdown(workflowSkill!);
    expect(renderedSkill).toContain(ANNOTATION_INSPECT_SCOPE_POLICY);
    expect(workflowRule!.body).toContain(ANNOTATION_INSPECT_SCOPE_POLICY);
    expect(renderedSkill).toContain('scope: "consumer"');
    expect(renderedSkill).toContain('Enumerate-before-unchanged'); // intra-node enumeration obligation
    expect(renderedSkill).toContain('affordanceCount'); // affordance count in the client workflow skill
    expect(renderedSkill).toContain('Locality:');
    expect(renderedSkill).toContain('nodeIds were left unchanged');
    expect(renderedSkill).toContain('derive annotation obligations from the existing fields');
    expect(renderedSkill).toContain(RUNTIME_HANDOFF_WORKFLOW_NOTE);
  });

  it('projects runtime resource handoff authoring into annotation guidance', () => {
    const renderedAnnotations = renderSkillMarkdown(ANNOTATIONS_SKILL);
    expect(renderedAnnotations).toContain(ANNOTATION_RUNTIME_RESOURCE_HANDOFF_AUTHORING);
  });
});

describe('build-cancel guidance projection', () => {
  it('carries get_build_status cancel guidance into AGENTS.md', () => {
    expect(AGENTS_MD).toContain('get_build_status({ "cancel": true })');
    expect(AGENTS_MD).toContain('cancel:true');
  });

  it('carries cancel guidance into the refresh and status skills', () => {
    const refresh = renderSkillMarkdown(REFRESH_COMMAND);
    expect(refresh).toContain('get_build_status({ "cancel": true })');
    expect(refresh).toContain('status:"cancelled"');

    const status = renderSkillMarkdown(STATUS_COMMAND);
    expect(status).toContain('get_build_status({ "cancel": true })');
    expect(status).toContain('status:"cancelled"');
  });
});

describe('onboarding annotation authoring projection', () => {
  it('projects consumer-scoped risk shape into repovine-annotations skill', () => {
    const rendered = renderSkillMarkdown(ANNOTATIONS_SKILL);
    expect(rendered).toContain('scope: "consumer"');
    expect(rendered).toContain('Importer must verify this at the consumer');
    expect(rendered).toContain('scope: "boundary"');
    expect(rendered).toContain(ANNOTATION_RISK_SCOPE_CANDIDATE_ADVISORY);
    expect(rendered).toContain('candidate is not proof');
  });

  it('projects consumer-scoped risk shape into annotation-writer agent', () => {
    expect(ANNOTATION_WRITER_AGENT.body).toContain('scope: "consumer"');
    expect(ANNOTATION_WRITER_AGENT.body).toContain('Importer must verify this at the consumer');
    expect(ANNOTATION_WRITER_AGENT.body).toContain('scope: "boundary"');
    expect(ANNOTATION_WRITER_AGENT.body).toContain(ANNOTATION_RISK_SCOPE_CANDIDATE_ADVISORY);
  });
});
