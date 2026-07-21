/**
 * Default agent manifests — the canonical source of truth for built-in agent
 * identity (name, role, description, tools, required result fields, model
 * hints). Client onboarding assets (AGENTS.md, Cursor/Codex/Claude agents,
 * project subagent scaffolds) are PROJECTIONS derived from these manifests, so
 * identity is defined once here and rendered many ways.
 *
 * Manifest `name` values intentionally match the existing onboarding asset
 * names so the projection layer can look identity up by name. Utility agents
 * are prefixed `repovine-` so they never collide with (or silently shadow) a
 * user's personal agents of the same generic name; roles stay unprefixed —
 * they are Agent Protocol vocabulary, not file identity:
 *   - 'repovine-repo-explorer'        -> REPO_EXPLORER_AGENT
 *   - 'repovine-annotation-writer'    -> ANNOTATION_WRITER_AGENT
 *   - 'project-subagent-sample'    -> PROJECT_SAMPLE_SUBAGENT_*
 *   - 'main'                       -> AGENTS.md main-agent policy
 *   - 'repovine-architecture-auditor' -> read-only architecture finding triage
 *   - 'repovine-code-reviewer'        -> read-only diff / acceptance review
 */
import {
  PROTOCOL_VERSION,
  type AgentManifest,
  type AgentRole,
  type ProjectionTarget,
} from './protocol.js';

/** Per-client cheap-model hints for summary-class roles (cost levers, not capability gates). */
export interface ManifestModelHints {
  /** Claude Code agent frontmatter `model:` alias, e.g. "haiku". */
  claude?: string;
  /** Cursor agent frontmatter `model:`, e.g. "fast". */
  cursor?: string;
  /** Codex agent TOML `model_reasoning_effort`, e.g. "low". */
  codexReasoningEffort?: string;
}

/** A built-in manifest plus projection metadata used by the asset renderer. */
export interface BuiltinAgentDef {
  manifest: AgentManifest;
  /** Cheap-model hints applied to generated client assets for this role. */
  models?: ManifestModelHints;
}

// ── Tool allowlists ──
// Curated agent-facing allowlists. The doctor validates GENERATED assets
// against the live tool-defs registry; these lists scope what each role uses.

const NAV_READ_TOOLS = [
  'search_context',
  'map_context',
  'inspect_node',
  'get_entrypoints',
  'trace_flow',
  'analyze_dependencies',
  'get_config_surface',
  'analyze_architecture',
  'get_annotation_status',
  'get_build_status',
  'get_context_session_quality',
];

const ANNOTATION_TOOLS = [
  'get_annotation_status',
  'get_annotation_merge_status',
  'merge_annotations',
  'validate_annotations',
  'inspect_node',
  'write_annotation',
  'refresh_context',
];

const ALL_PUBLIC_TOOLS = [
  'search_context',
  'map_context',
  'inspect_node',
  'get_entrypoints',
  'trace_flow',
  'analyze_dependencies',
  'get_config_surface',
  'analyze_architecture',
  'get_annotation_status',
  'get_annotation_merge_status',
  'merge_annotations',
  'validate_annotations',
  'write_annotation',
  'refresh_context',
  'get_build_status',
  'get_context_session_quality',
];

function dedupe(tools: string[]): string[] {
  return [...new Set(tools)];
}

function manifest(
  name: string,
  role: AgentRole,
  description: string,
  fields: {
    canEditFiles: boolean;
    allowedTools: string[];
    expectedInputs: string[];
    requiredRunResultFields: string[];
    projectionTargets: ProjectionTarget[];
  },
): AgentManifest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    name,
    role,
    description,
    canEditFiles: fields.canEditFiles,
    allowedTools: dedupe(fields.allowedTools),
    expectedInputs: fields.expectedInputs,
    requiredRunResultFields: fields.requiredRunResultFields,
    projectionTargets: fields.projectionTargets,
  };
}

// ── Built-in agent definitions ──

export const MAIN_AGENT_DEF: BuiltinAgentDef = {
  manifest: manifest(
    'main',
    'main',
    'Main orchestration agent: scopes repo changes with repovine, chooses the risk axis, delegates implementation, and verifies after edits.',
    {
      canEditFiles: true,
      allowedTools: ALL_PUBLIC_TOOLS,
      expectedInputs: ['task', 'scope', 'acceptanceCriteria', 'constraints', 'contracts'],
      requiredRunResultFields: ['summary', 'scope', 'compliance'],
      projectionTargets: ['agents-md', 'cursor', 'codex', 'claude', 'json'],
    },
  ),
};

export const REPO_EXPLORER_DEF: BuiltinAgentDef = {
  manifest: manifest(
    'repovine-repo-explorer',
    'explorer',
    'Codebase navigator that explores architecture, relationships, and task context through the graph',
    {
      canEditFiles: false,
      allowedTools: dedupe([...NAV_READ_TOOLS, ...ANNOTATION_TOOLS]),
      expectedInputs: ['task', 'scope'],
      requiredRunResultFields: ['summary', 'scope'],
      projectionTargets: ['cursor', 'codex', 'claude', 'json'],
    },
  ),
  models: { claude: 'haiku', cursor: 'fast', codexReasoningEffort: 'low' },
};

export const ANNOTATION_WRITER_DEF: BuiltinAgentDef = {
  manifest: manifest(
    'repovine-annotation-writer',
    'annotation-writer',
    'Batch annotator that maintains annotations for the repository graph',
    {
      canEditFiles: false,
      allowedTools: ANNOTATION_TOOLS,
      expectedInputs: ['scope', 'batchLimit'],
      requiredRunResultFields: ['summary', 'annotationsWritten'],
      projectionTargets: ['cursor', 'codex', 'claude', 'json'],
    },
  ),
  models: { claude: 'haiku', cursor: 'fast', codexReasoningEffort: 'low' },
};

export const IMPLEMENTER_DEF: BuiltinAgentDef = {
  manifest: manifest(
    'project-subagent-sample',
    'implementer',
    'Generic project implementer — scope set by main agent; uses repovine MCP before editing',
    {
      canEditFiles: true,
      allowedTools: ALL_PUBLIC_TOOLS,
      expectedInputs: ['task', 'scope', 'acceptanceCriteria', 'contracts'],
      requiredRunResultFields: ['summary', 'scope', 'filesChanged', 'graphNodesTouched', 'compliance'],
      projectionTargets: ['cursor', 'codex', 'claude', 'json'],
    },
  ),
};

export const ARCHITECTURE_AUDITOR_DEF: BuiltinAgentDef = {
  manifest: manifest(
    'repovine-architecture-auditor',
    'architecture-auditor',
    'Read-only architecture auditor: triages analyze_architecture findings and proposes scoped follow-up assignments.',
    {
      canEditFiles: false,
      allowedTools: dedupe([...NAV_READ_TOOLS, 'validate_annotations', 'get_annotation_merge_status']),
      expectedInputs: ['task', 'scope', 'categories', 'priorContext'],
      requiredRunResultFields: ['summary', 'scope', 'architectureAudit'],
      projectionTargets: ['cursor', 'codex', 'claude', 'json'],
    },
  ),
  models: { claude: 'haiku', cursor: 'fast', codexReasoningEffort: 'low' },
};

export const CODE_REVIEWER_DEF: BuiltinAgentDef = {
  manifest: manifest(
    'repovine-code-reviewer',
    'code-reviewer',
    'Read-only code reviewer: reviews a diff against assignment criteria, contracts, tests, and repovine context.',
    {
      canEditFiles: false,
      allowedTools: dedupe([...NAV_READ_TOOLS, 'validate_annotations', 'get_annotation_merge_status']),
      expectedInputs: ['assignment', 'priorContext', 'implementationResult', 'diffBase', 'changedFiles', 'graphNodesTouched'],
      requiredRunResultFields: ['summary', 'scope', 'review'],
      projectionTargets: ['cursor', 'codex', 'claude', 'json'],
    },
  ),
};

/** All built-in definitions, in canonical (main-first) order. */
export const BUILTIN_AGENT_DEFS: BuiltinAgentDef[] = [
  MAIN_AGENT_DEF,
  REPO_EXPLORER_DEF,
  ANNOTATION_WRITER_DEF,
  IMPLEMENTER_DEF,
  ARCHITECTURE_AUDITOR_DEF,
  CODE_REVIEWER_DEF,
];

/** Public manifests only (what `repovine agents manifests` and projections expose). */
export const BUILTIN_MANIFESTS: AgentManifest[] = BUILTIN_AGENT_DEFS.map(d => d.manifest);

const defsByName = new Map(BUILTIN_AGENT_DEFS.map(d => [d.manifest.name, d]));
const defsByRole = new Map(BUILTIN_AGENT_DEFS.map(d => [d.manifest.role, d]));

/** Look up a built-in definition (manifest + model hints) by agent name. */
export function getAgentDef(name: string): BuiltinAgentDef | undefined {
  return defsByName.get(name);
}

/** Look up a built-in manifest by agent name. */
export function getManifest(name: string): AgentManifest | undefined {
  return defsByName.get(name)?.manifest;
}

/** Look up the canonical built-in definition for a role. */
export function getManifestByRole(role: AgentRole): AgentManifest | undefined {
  return defsByRole.get(role)?.manifest;
}

/** Model hints for a built-in agent (per-client cheap-model levers), if any. */
export function getModelHints(name: string): ManifestModelHints | undefined {
  return defsByName.get(name)?.models;
}
