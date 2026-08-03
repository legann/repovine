import type { RepositoryGraph } from '../types.js';
import { nodesOfType } from './index.js';

/**
 * Scope a logical-id reference is made from. Resolution prefers a target the reference's own
 * document declares; without that preference a label match is a global name collision, and the
 * first node visited wins by scan order rather than by evidence.
 */
export interface InfraRefScope {
  /**
   * Repo-relative paths of the IaC documents declaring the referencing resource. More than one
   * entry when separate documents declare the same logical id and collapse onto one node.
   */
  declaredIn?: readonly string[];
  /**
   * The scope the referencing resource confines its own references to, as its plugin spelled it.
   *
   * Opaque here: two resources are in one scope when the strings are equal, and nothing else about
   * the string is read. Its presence replaces the declaring document as the scope — an ecosystem
   * that carries one names its targets across documents and never outside it.
   */
  refScope?: string;
}

export type InfraRefResolution =
  | { status: 'resolved'; serviceId: string }
  | { status: 'unresolved'; reason: 'ambiguous' | 'out-of-scope' | 'missing'; candidates: string[] };

const MISSING: InfraRefResolution = { status: 'unresolved', reason: 'missing', candidates: [] };

/**
 * Nested SAM stacks pass DynamoDB identifiers as parameters (`FooTableName`, `FooTableArn`);
 * the actual `AWS::DynamoDB::Table` resource is often `FooTable` in another template (e.g. data.yaml).
 */
export function resourceLogicalIdAliases(logicalId: string): string[] {
  const suffixes: Array<[suffix: string, replacement: string]> = [
    ['TableName', 'Table'],
    ['TableArn', 'Table'],
    ['QueueUrl', 'Queue'],
    ['QueueArn', 'Queue'],
    ['TopicArn', 'Topic'],
    ['FunctionName', 'Function'],
    ['FunctionArn', 'Function'],
  ];
  const out: string[] = [];
  for (const [suffix, replacement] of suffixes) {
    if (logicalId.endsWith(suffix)) {
      out.push(logicalId.slice(0, -suffix.length) + replacement);
    }
  }
  return out;
}

/** True when the candidate node is declared where the reference can see it. */
function candidateInScope(graph: RepositoryGraph, candidateId: string, scope: InfraRefScope): boolean {
  const node = graph.nodes.get(candidateId);
  if (node?.type !== 'runtime-resource') return false;
  // A declared scope answers on its own: the reference names something inside it, and a candidate
  // carrying a different scope — or none — is a different thing with the same name.
  if (scope.refScope !== undefined) return node.data?.refScope === scope.refScope;
  if (!scope.declaredIn?.length) return false;
  const declaredIn = node.data?.declaredIn ?? [];
  return scope.declaredIn.some(path => declaredIn.includes(path));
}

function decide(
  graph: RepositoryGraph,
  candidates: string[],
  scope: InfraRefScope,
): InfraRefResolution {
  const inScope = candidates.filter(id => candidateInScope(graph, id, scope));
  if (inScope.length === 1) return { status: 'resolved', serviceId: inScope[0] };
  if (inScope.length > 1) return { status: 'unresolved', reason: 'ambiguous', candidates: inScope };
  // A declared scope does not leak: a candidate outside it is not a target, and the repository-wide
  // fallback below would answer with one.
  if (scope.refScope !== undefined) return { status: 'unresolved', reason: 'out-of-scope', candidates };
  // Nested stacks hand identifiers to sibling templates: one candidate repo-wide still names one
  // resource, and refusing it would drop the cross-template links this aliasing exists to serve.
  if (candidates.length === 1) return { status: 'resolved', serviceId: candidates[0] };
  return { status: 'unresolved', reason: 'ambiguous', candidates };
}

/**
 * Resolve a logical id to one runtime-resource node, scoped to the declaring document. Ambiguity
 * that scope does not settle stays unresolved: an edge picked from equal candidates would report a
 * coin toss as a proven link.
 */
export function resolveInfraRef(
  graph: RepositoryGraph,
  logicalId: string,
  scope: InfraRefScope,
): InfraRefResolution {
  const serviceSet = nodesOfType(graph, 'runtime-resource');
  if (serviceSet.length === 0) return MISSING;

  // The exact label decides on its own: when it matches, an alias match is a weaker reading of the
  // same reference and cannot break a tie the exact name already produced.
  for (const label of [logicalId, ...resourceLogicalIdAliases(logicalId)]) {
    const candidates: string[] = [];
    for (const id of serviceSet) {
      if (graph.nodes.get(id)?.label === label) candidates.push(id);
    }
    if (candidates.length > 0) return decide(graph, candidates, scope);
  }
  return MISSING;
}
