/**
 * Whether a graph node id falls under a set of scope hints.
 *
 * A hint is a repo path (`backend` → `mod:backend/…`), a graph kind (`infra` → `infra:…` nodes and
 * `domain:infra-…` roll-ups), or a package id (`pkg:client-ui`). `.` means the whole repository.
 *
 * A `pkg:` hint is matched by its bare name as well, because module ids carry the package name in
 * the path tail rather than the prefix: `mod:client-ui/src/app` has tail `client-ui/src/app`, which
 * `pkg:client-ui` never prefixes. Expanding the hint also lets `pkg:client-ui` match the package
 * node itself.
 */
export function nodeInScopeHints(nodeId: string, scopeHints?: string[]): boolean {
  if (!scopeHints?.length || scopeHints.includes('.')) return true;
  const expanded = scopeHints.flatMap(hint => hint.startsWith('pkg:') ? [hint, hint.slice(4)] : [hint]);
  return expanded.some(hint => {
    if (nodeId.startsWith(`${hint}:`)) return true;
    const tail = nodeId.includes(':') ? nodeId.slice(nodeId.indexOf(':') + 1) : nodeId;
    return tail === hint
      || tail.startsWith(`${hint}/`)
      || hint.startsWith(`${tail}/`)
      || tail.startsWith(`${hint}-`);
  });
}
