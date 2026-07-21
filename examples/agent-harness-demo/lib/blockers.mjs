// Out-of-scope infra blockers — advisory for implement subAgents, not run gate failures.

const OUT_OF_SCOPE_INFRA =
  /infra:docker-compose|docker-compose\.yml|outside (?:the )?(?:frontend|backend|infra) (?:sub-agent|scope|subAgent)|repo-wide validate_annotations reports .* outside/i;

/** True when a blocker cites infra/docker-compose outside this subAgent's assignment scope. */
export function isOutOfScopeInfraBlocker(text, scopeHints = []) {
  const s = String(text ?? '').trim();
  if (!s || !OUT_OF_SCOPE_INFRA.test(s)) return false;
  const scopes = Array.isArray(scopeHints) ? scopeHints : [];
  if (scopes.includes('.') || scopes.includes('infra')) return false;
  return true;
}

export function filterHardBlockers(blockers = [], scopeHints = []) {
  return blockers.filter((b) => b && !isOutOfScopeInfraBlocker(b, scopeHints));
}

/** Implement subAgent delivered code; only out-of-scope infra noise in blockers. */
export function subAgentGateEffectivelyOk(subAgent) {
  if (!subAgent) return false;
  if (subAgent.ok) return true;
  const result = subAgent.result ?? {};
  if (result.status === 'blocked' || result.status === 'failed') return false;
  const files = result.filesChanged ?? [];
  if (!files.length) return false;
  const blockers = [...(result.blockers ?? []), ...(subAgent.handoff?.blockers ?? [])].filter(Boolean);
  if (!blockers.length) return false;
  const scope = subAgent.scope ?? result.scope ?? [];
  return blockers.every((b) => isOutOfScopeInfraBlocker(b, scope));
}
