import { z } from 'zod';
import { EDGE_KINDS, NODE_DATA_KEYS, NODE_TYPES } from '../types.js';
import type { EdgeKind, GraphDelta, GraphEdge, GraphNode, NodeType, RepositoryGraph } from '../types.js';

export type GraphDeltaLogLevel = 'debug' | 'warn' | 'error';

export interface ApplyGraphDeltaOptions {
  /** Skip validation for a delta the caller vouches for. Off by default: a delta is validated
   *  unless its producer is named at the call site. */
  trusted?: boolean;
  logger?: (level: GraphDeltaLogLevel, message: string) => void;
}

export interface GraphDeltaValidationResult {
  ok: boolean;
  delta: GraphDelta;
  errors: string[];
}

const NodeTypeSchema = z.enum(NODE_TYPES);

const EdgeKindSchema = z.enum(EDGE_KINDS);

const GraphNodeSchema = z.object({
  id: z.string(),
  type: NodeTypeSchema,
  label: z.string(),
  description: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
}).passthrough().superRefine((node, ctx) => {
  // Per-type discriminant the GraphNode TS union only enforces at compile time: reject `data` keys
  // foreign to this node type (e.g. an `export-symbol`-shaped payload on a `module` node). Values
  // stay loose by design — consumers read defensively and narrow by `type`; this guards the shape,
  // not every leaf. Runs on every delta; `trusted: true` is the caller's explicit opt-out.
  if (!node.data) return;
  const allowed = NODE_DATA_KEYS[node.type as NodeType] as readonly string[] | undefined;
  if (!allowed) return; // unknown type already flagged by NodeTypeSchema
  for (const key of Object.keys(node.data)) {
    if (!allowed.includes(key)) {
      ctx.addIssue({ code: 'custom', message: `unexpected data key '${key}' for node type '${node.type}'`, path: ['data', key] });
    }
  }
});

const GraphEdgeMetadataSchema = z.object({
  tagSource: z.enum(['path', 'package', 'cluster', 'pattern']).optional(),
  usedNames: z.array(z.string()).optional(),
}).passthrough();

const GraphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: EdgeKindSchema,
  metadata: GraphEdgeMetadataSchema.optional(),
}).passthrough();

export const GraphDeltaSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
}).passthrough();

export function emptyGraphDelta(): GraphDelta {
  return { nodes: [], edges: [] };
}

export function validateGraphDelta(value: unknown): GraphDeltaValidationResult {
  if (!value || typeof value !== 'object') {
    return {
      ok: false,
      delta: emptyGraphDelta(),
      errors: ['<root>: Expected object'],
    };
  }

  const candidate = value as Partial<GraphDelta>;
  const out: GraphDelta = { nodes: [], edges: [] };
  const errors: string[] = [];

  if (!Array.isArray(candidate.nodes)) {
    errors.push('nodes: Expected array');
  } else {
    candidate.nodes.forEach((node, index) => {
      const parsed = GraphNodeSchema.safeParse(node);
      if (parsed.success) out.nodes.push(parsed.data as GraphNode);
      else errors.push(formatZodError(describeEntry(`nodes.${index}`, node), parsed.error));
    });
  }

  if (!Array.isArray(candidate.edges)) {
    errors.push('edges: Expected array');
  } else {
    candidate.edges.forEach((edge, index) => {
      const parsed = GraphEdgeSchema.safeParse(edge);
      if (parsed.success) out.edges.push(parsed.data as GraphEdge);
      else errors.push(formatZodError(describeEntry(`edges.${index}`, edge), parsed.error));
    });
  }

  return { ok: errors.length === 0, delta: out, errors };
}

export function applyValidated(
  graph: RepositoryGraph,
  delta: GraphDelta,
  options: ApplyGraphDeltaOptions = {},
): void {
  const { trusted = false } = options;
  const log = options.logger ?? defaultLogger;
  const validated = trusted ? { ok: true, delta, errors: [] } : validateGraphDelta(delta);

  for (const error of validated.errors) log('warn', `dropped invalid GraphDelta entry: ${error}`);

  const existingNodeIds = new Set(graph.nodes.keys());
  const nodeIdsInDelta = new Set<string>();
  const nodes = [...validated.delta.nodes]
    .filter(node => {
      if (nodeIdsInDelta.has(node.id)) return false;
      nodeIdsInDelta.add(node.id);
      return !existingNodeIds.has(node.id);
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const node of nodes) addDeltaNode(graph, node);

  const edgeKeys = new Set(graph.edges.map(edgeKey));
  const edges = [...validated.delta.edges]
    .filter(edge => {
      if (!graph.nodes.has(edge.from) || !graph.nodes.has(edge.to)) {
        if (!trusted) log('warn', `dropped edge with missing endpoint: ${edge.from} -> ${edge.to}`);
        return false;
      }
      const key = edgeKey(edge);
      if (edgeKeys.has(key)) return false;
      edgeKeys.add(key);
      return true;
    })
    .sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));

  for (const edge of edges) addDeltaEdge(graph, edge.from, edge.to, edge.kind as EdgeKind, edge.metadata);
}

function addDeltaNode(graph: RepositoryGraph, node: GraphNode): void {
  graph.nodes.set(node.id, node);

  let typeSet = graph.byType.get(node.type);
  if (!typeSet) {
    typeSet = new Set();
    graph.byType.set(node.type, typeSet);
  }
  typeSet.add(node.id);
}

function addDeltaEdge(
  graph: RepositoryGraph,
  from: string,
  to: string,
  kind: EdgeKind,
  metadata?: GraphEdge['metadata'],
): void {
  const edge: GraphEdge = metadata ? { from, to, kind, metadata } : { from, to, kind };
  graph.edges.push(edge);

  let out = graph.outEdges.get(from);
  if (!out) { out = []; graph.outEdges.set(from, out); }
  out.push(edge);

  let inc = graph.inEdges.get(to);
  if (!inc) { inc = []; graph.inEdges.set(to, inc); }
  inc.push(edge);
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.from}\0${edge.to}\0${edge.kind}\0${stableJson(edge.metadata ?? {})}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function formatZodError(prefix: string, error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map(issue => `${prefix}.${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

function describeEntry(prefix: string, value: unknown): string {
  if (!value || typeof value !== 'object') return prefix;
  const record = value as Record<string, unknown>;
  if (typeof record.id === 'string') return `${prefix}(${record.id})`;
  if (typeof record.from === 'string' && typeof record.to === 'string') {
    if (typeof record.kind === 'string') return `${prefix}(${record.from}->${record.to}:${record.kind})`;
    return `${prefix}(${record.from}->${record.to})`;
  }
  return prefix;
}

function defaultLogger(level: GraphDeltaLogLevel, message: string): void {
  if (level === 'error') console.error(`[repovine:graph-delta] ${message}`);
  else if (level === 'warn') console.warn(`[repovine:graph-delta] ${message}`);
  else if (process.env.REPOVINE_VERBOSE) console.log(`[repovine:graph-delta] ${message}`);
}
