/**
 * A read-only invariant check over the composed stage2 graph.
 *
 * `composeRepositoryGraph` mutates one in-memory graph across the interpreter composer, an opt-in
 * inert-resource prune, and the domain passes. Nothing otherwise confirms that every stage1 snapshot
 * record survived into the graph or that the graph is internally consistent; a dropped or mis-linked
 * node surfaces only downstream in a detector or an MCP result. This check makes such a regression
 * observable at the source.
 *
 * It never mutates the graph. Intentional drops are safe: `pruneInertRuntimeResources` removes a node
 * together with every edge touching it, so a pruned resource leaves no dangling edge to flag.
 */
import type { RepositoryFactsSnapshot, RepositoryGraph } from '../types.js';
import { shortenList, omittedNote } from '../platform/text.js';

export interface GraphValidationProblem {
  kind: 'missing-module' | 'missing-template' | 'dangling-edge-from' | 'dangling-edge-to';
  detail: string;
}

export function validateComposedGraph(
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
): GraphValidationProblem[] {
  const problems: GraphValidationProblem[] = [];

  // Every stage1 module must project to a graph node.
  for (const mod of snapshot.modules) {
    if (!graph.nodes.has(mod.id)) {
      problems.push({ kind: 'missing-module', detail: mod.id });
    }
  }

  // Every discovered template must project to a graph node.
  for (const tpl of snapshot.templates ?? []) {
    if (!graph.nodes.has(tpl.id)) {
      problems.push({ kind: 'missing-template', detail: tpl.id });
    }
  }

  // No edge may reference a node that is not in the graph.
  for (const edge of graph.edges) {
    if (!graph.nodes.has(edge.from)) {
      problems.push({ kind: 'dangling-edge-from', detail: `${edge.from} -${edge.kind}-> ${edge.to}` });
    }
    if (!graph.nodes.has(edge.to)) {
      problems.push({ kind: 'dangling-edge-to', detail: `${edge.from} -${edge.kind}-> ${edge.to}` });
    }
  }

  return problems;
}

/** One-line summary of the first few problems for a log line or thrown error. */
export function summarizeGraphValidationProblems(problems: GraphValidationProblem[], max = 5): string {
  const { shown, omitted } = shortenList(problems, max);
  const head = shown.map(p => `${p.kind}(${p.detail})`).join('; ');
  const more = omittedNote(omitted);
  return `${problems.length} problem(s): ${head}${more}`;
}
