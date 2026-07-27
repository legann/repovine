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
import { packageNameFromId } from '../graph/node-ids.js';
export function nodeInScopeHints(nodeId: string, scopeHints?: string[]): boolean {
  if (!scopeHints?.length || scopeHints.includes('.')) return true;
  // A hint written as a path is a prefix guess, so `backend` is allowed to reach `backend-api/…`.
  // A hint written as `pkg:` is a name the graph holds exactly, and the same relaxation would put
  // every module of `pkg:repovine-agent-harness-demo` inside the scope `pkg:repovine`.
  const expanded = scopeHints.flatMap(hint => hint.startsWith('pkg:')
    ? [{ text: hint, exactName: true }, { text: packageNameFromId(hint), exactName: true }]
    : [{ text: hint, exactName: false }]);
  return expanded.some(({ text, exactName }) => {
    if (nodeId.startsWith(`${text}:`)) return true;
    const tail = nodeId.includes(':') ? nodeId.slice(nodeId.indexOf(':') + 1) : nodeId;
    return tail === text
      || tail.startsWith(`${text}/`)
      || text.startsWith(`${tail}/`)
      || (!exactName && tail.startsWith(`${text}-`));
  });
}
