// Shared credential resolver for ALL providers (claude | local).
//
// Explicit env keys only — no home-login files, no silent spend.
// Set provider keys in .env (Docker) or export before running locally.
const PROVIDERS = {
  claude: {
    explicitEnv: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
    explicitHint: 'set ANTHROPIC_API_KEY in .env, or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`',
  },
  // The local provider runs an OSS model through an OpenAI-compatible endpoint.
  // Its "credential" is the ENDPOINT (LOCAL_BASE_URL), not a cloud key — so it is
  // NOT fail-closed: a reachable base url is enough, LOCAL_API_KEY is optional
  // (most local runtimes ignore it). See resolveAuth's local branch below.
  local: {
    baseUrlEnv: 'LOCAL_BASE_URL',
    explicitEnv: ['LOCAL_API_KEY'],
    explicitHint:
      'set LOCAL_BASE_URL to an OpenAI-compatible endpoint (e.g. http://localhost:11434/v1); LOCAL_API_KEY is optional',
  },
};

export function knownProvider(provider) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, provider);
}

/** First explicit env var that is set (non-empty), or undefined. */
function explicitEnvVar(spec) {
  return spec.explicitEnv.find((name) => process.env[name]);
}

/**
 * Resolve credentials for `provider`. Returns a shape safe to log:
 *   { ok: true,  mode: 'explicit', source }
 *   { ok: false, reason, hints: string[] }
 * Never returns secret values.
 */
export function resolveAuth(provider = process.env.LLM_PROVIDER || 'claude') {
  const spec = PROVIDERS[provider];
  if (!spec) {
    return { ok: false, reason: `Unknown LLM_PROVIDER "${provider}".`, hints: ['Use claude | local.'] };
  }

  // Local provider: presence-of-endpoint, NOT a cloud key. A reachable LOCAL_BASE_URL
  // is the whole credential; LOCAL_API_KEY is optional. This is the one provider that
  // is deliberately not fail-closed — no remote spend is possible against a local model.
  if (provider === 'local') {
    const baseUrl = process.env.LOCAL_BASE_URL?.trim();
    if (!baseUrl) {
      return { ok: false, reason: 'No LOCAL_BASE_URL set for the local provider.', hints: [spec.explicitHint] };
    }
    return { ok: true, mode: 'local-endpoint', source: 'LOCAL_BASE_URL' };
  }

  const explicit = explicitEnvVar(spec);
  if (explicit) {
    return { ok: true, mode: 'explicit', source: explicit };
  }

  return {
    ok: false,
    reason: `No ${provider} credentials in the environment.`,
    hints: [spec.explicitHint],
  };
}

/** Human-readable one-liner for blocked-result summaries. */
export function authBlockedReason(provider, auth) {
  const reason = auth?.reason || `No usable ${provider} credentials.`;
  const hints = (auth?.hints || []).join(' ');
  return hints ? `${reason} ${hints}` : reason;
}
