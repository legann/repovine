import { resolveNodeId, type McpToolRuntime } from '../../types.js';

export function analyzeCallgraph(ctx: McpToolRuntime, args: Record<string, unknown>): unknown {
  const { graph } = ctx.getState();
  const rawId = args.nodeId as string;
  const nodeId = resolveNodeId(graph, rawId);
  if (!nodeId) return { error: `Node not found: ${rawId}` };
  const node = graph.nodes.get(nodeId);
  if (!node) return { error: `Node not found: ${rawId}` };
  if (node.type !== 'export-symbol') {
    return { nodeId, calls: [], note: 'Node is not an export-symbol' };
  }
  const calls = node.data?.calls ?? [];
  if (calls.length === 0) {
    const lineRange = node.data?.lineRange;
    const lineCount = lineRange ? lineRange.end - lineRange.start : 0;
    if (lineCount > 500) {
      return { nodeId, calls: [], note: `Function is ${lineCount} lines — call graph skipped (max 500 lines)` };
    }
    return { nodeId, calls: [], note: 'No calls detected (calls are captured for functions, classes, consts, arrow-property methods, accessors, and HOC-wrapped components)' };
  }
  return { nodeId, label: node.label, calls };
}
