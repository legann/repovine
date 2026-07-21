// Per-role model + reasoning defaults for harness LLM calls.
//
// Roles: planner (main decomposition), implementer (code sub-agents), verify
// (read-only review + claim-verify), ask (/ask read-only agent).
//
// Env overrides (Claude provider; the local provider is tuned via LOCAL_* below):
//   PLANNER_REASONING      default opus:high
//   IMPLEMENTER_REASONING  default sonnet:medium
//   VERIFY_REASONING       default sonnet:low
//   ASK_REASONING          default sonnet:low
//
// Value format:
//   "opus:high"           — model + effort/reasoning
//   "high"                — effort/reasoning only (keep role default model)
//   "opus"                — model only (keep role default effort)
//   "claude-fable-5:high" — full model ids work too (Fable 5: thinking always on,
//                           effort low..max, longer turns — raise CLAUDE_AGENT_TIMEOUT_MS)
//
// Legacy fallbacks (implementer role only, when IMPLEMENTER_REASONING is unset):
//   CLAUDE_AGENT_MODEL

/** @typedef {'planner' | 'implementer' | 'verify' | 'ask'} HarnessModelRole */

const ENV_BY_ROLE = {
  planner: 'PLANNER_REASONING',
  implementer: 'IMPLEMENTER_REASONING',
  verify: 'VERIFY_REASONING',
  ask: 'ASK_REASONING',
};

const EFFORT_TOKENS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

// Floor is sonnet for every role. haiku:low was the read-only default for verify (review /
// claim-verify) and ask (orient / annotation sync), but haiku wrote basic-tier annotations
// where the annotate phase requires detailed — a capability gap, not a tooling one (haiku
// review still drove trace_flow/analyze_dependencies fine). Override per role via
// {VERIFY,ASK}_REASONING when cost matters more than depth on a given repo.
const CLAUDE_DEFAULTS = {
  planner: { model: 'opus', effort: 'high' },
  implementer: { model: 'sonnet', effort: 'medium' },
  verify: { model: 'sonnet', effort: 'low' },
  ask: { model: 'sonnet', effort: 'low' },
};

/** Map a sub-agent spec.role to a harness model role. */
export function subAgentModelRole(specRole) {
  if (specRole === 'review') return 'verify';
  if (specRole === 'repo-explorer' || specRole === 'annotation-writer') return 'ask';
  return 'implementer';
}

/** Parse PLANNER_REASONING-style env values. */
export function parseRoleSetting(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return {};
  if (s.includes(':')) {
    const [model, effort] = s.split(':').map((part) => part.trim());
    return {
      ...(model ? { model } : {}),
      ...(effort ? { effort: effort.toLowerCase() } : {}),
    };
  }
  if (EFFORT_TOKENS.has(s.toLowerCase())) return { effort: s.toLowerCase() };
  return { model: s };
}

function roleEnv(role) {
  return process.env[ENV_BY_ROLE[role]];
}

function legacyImplementerOverride(provider) {
  if (provider === 'claude') {
    const m = process.env.CLAUDE_AGENT_MODEL?.trim();
    return m ? { model: m } : {};
  }
  return {};
}

function mergeRoleSetting(role, provider, defaults) {
  const fromEnv = parseRoleSetting(roleEnv(role));
  const legacy = role === 'implementer' && !roleEnv(role) ? legacyImplementerOverride(provider) : {};
  const model = fromEnv.model ?? legacy.model ?? defaults.model;
  const effort = fromEnv.effort ?? legacy.effort ?? defaults.effort;
  return { model, effort };
}

/** Claude Agent SDK: model alias/id + effort level. */
export function resolveClaudeRole(role) {
  const { model, effort } = mergeRoleSetting(role, 'claude', CLAUDE_DEFAULTS[role]);
  return {
    model,
    ...(effort ? { effort } : {}),
  };
}

// Local (OpenAI-compatible) provider: the model IS config. Base model comes from
// LOCAL_MODEL; an optional per-role override (LOCAL_PLANNER_MODEL / LOCAL_IMPLEMENTER_MODEL
// / LOCAL_VERIFY_MODEL / LOCAL_ASK_MODEL) lets a cheap model plan while a stronger one
// implements. There is no provider-side reasoning/effort knob on a bare chat endpoint,
// so this returns model only (temperature lives in local-config.mjs).
export const LOCAL_DEFAULT_MODEL = 'qwen2.5-coder:32b';

const LOCAL_ROLE_ENV = {
  planner: 'LOCAL_PLANNER_MODEL',
  implementer: 'LOCAL_IMPLEMENTER_MODEL',
  verify: 'LOCAL_VERIFY_MODEL',
  ask: 'LOCAL_ASK_MODEL',
};

/** Resolve the model id for a harness role on the local provider. */
export function resolveLocalRole(role) {
  const perRole = process.env[LOCAL_ROLE_ENV[role]]?.trim();
  const base = process.env.LOCAL_MODEL?.trim();
  return { model: perRole || base || LOCAL_DEFAULT_MODEL };
}

/** Compact label for verbose logs. */
export function formatRoleLabel(provider, role) {
  if (provider === 'claude') {
    const { model, effort } = resolveClaudeRole(role);
    return effort ? `${model}:${effort}` : model;
  }
  if (provider === 'local') return resolveLocalRole(role).model;
  return role;
}
