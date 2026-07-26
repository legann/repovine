import type { McpToolRuntime } from '../../types.js';
import { paginateList } from '../../response/pagination.js';

/**
 * List the classes that implement a named interface by walking the graph `implements` edges into
 * the interface node(s) of that name. Edge traversal (vs. the former string match on every
 * export-symbol's `implementsInterfaces`) is precise: it never confuses same-named interfaces from
 * different modules and only reports implementations the resolver actually proved (pass4 in
 * interpreters/code-structure/graph.ts). External / unresolved interfaces have no node and no edge,
 * so they return empty rather than a false positive.
 */
export function findInterfaceImplementations(ctx: McpToolRuntime, args: Record<string, unknown>): unknown {
  const { graph } = ctx.getState();
  const ifaceName = args.interfaceName as string;
  const limit = typeof args.limit === 'number' ? Math.max(1, args.limit) : 20;
  const offset = typeof args.offset === 'number' ? Math.max(0, args.offset) : 0;
  const implementations: Array<Record<string, unknown>> = [];
  const seenClass = new Set<string>();

  for (const ifaceId of (graph.byType.get('export-symbol') ?? [])) {
    const ifaceNode = graph.nodes.get(ifaceId);
    if (ifaceNode?.type !== 'export-symbol' || ifaceNode.label !== ifaceName) continue;

    for (const edge of (graph.inEdges.get(ifaceId) ?? [])) {
      if (edge.kind !== 'implements' || seenClass.has(edge.from)) continue;
      const node = graph.nodes.get(edge.from);
      if (node?.type !== 'export-symbol' || !node.data) continue;
      seenClass.add(edge.from);

      const parentEdge = (graph.inEdges.get(edge.from) ?? []).find(e => e.kind === 'contains');
      const parentMod = parentEdge ? graph.nodes.get(parentEdge.from) : undefined;
      implementations.push({
        classId: edge.from,
        className: node.label,
        moduleId: parentMod?.id,
        moduleLabel: parentMod?.label,
        signature: node.data.signature,
        calls: node.data.calls,
        lineRange: node.data.lineRange,
      });
    }
  }

  const { page, truncation } = paginateList(implementations, {
    limit, offset, noun: 'implementation', narrow: 'page with offset',
  });
  return {
    interface: ifaceName,
    count: implementations.length,
    implementations: page,
    ...(truncation ? { truncation: { implementations: truncation } } : {}),
  };
}
