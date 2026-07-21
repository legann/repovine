/**
 * Node cards: deterministic natural-language descriptions of graph nodes used as
 * the embedding corpus. The key design decision vs chunk-based RAG: we embed
 * GRAPH NODES, not text chunks — a semantic hit is a node id that plugs straight
 * into inspect_node / analyze_dependencies / navigation.
 *
 * Card text is rebuilt from the graph + annotations on every sync; the store
 * re-embeds only cards whose text hash changed.
 */

import type { AnnotationContent, ModuleInfo, NodeType, RepositoryGraph, StoredAnnotation } from '../types.js';
import { normalizeRisks } from '../annotations/format.js';

/** Capabilities are excluded: they are numerous, token-searchable, and their names appear in module cards via exports.
 *  Declared against `NodeType` (via `satisfies`) so a NodeType rename is a compile error here. */
export const SEMANTIC_CARD_NODE_TYPES: ReadonlySet<string> = new Set(['module', 'runtime-resource', 'template', 'package', 'domain'] as const satisfies readonly NodeType[]);

const MAX_EXPORTS_PER_CARD = 30;
const MAX_CARD_CHARS = 2000;

function stringValues(value: string | Record<string, string> | undefined): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  return Object.entries(value).map(([k, v]) => `${k}: ${v}`);
}

function annotationCardLines(annotation: AnnotationContent): string[] {
  const lines: string[] = [];
  if (annotation.summary) lines.push(annotation.summary);
  for (const [name, description] of Object.entries(annotation.keyExports ?? {})) {
    lines.push(`${name}: ${description}`);
  }
  for (const risk of normalizeRisks(annotation.risks)) lines.push(`risk: ${risk.text}`);
  for (const invariant of annotation.invariants ?? []) lines.push(`invariant: ${invariant}`);
  if (annotation.flowDescription) lines.push(annotation.flowDescription);
  for (const flow of stringValues(annotation.dataFlow)) lines.push(`data flow: ${flow}`);
  for (const point of stringValues(annotation.integrationPoints)) lines.push(`integration: ${point}`);
  return lines;
}

export function buildNodeCard(
  node: { id: string; type: string; label: string; description: string },
  moduleInfo: ModuleInfo | undefined,
  stored: StoredAnnotation | undefined,
): string {
  const lines: string[] = [];
  lines.push(`${node.label} (${node.type})`);
  const pathish = node.id.replace(/^[^:]+:/, '').replace(/[/\-_.:]/g, ' ');
  lines.push(pathish);
  if (node.description) lines.push(node.description);
  if (moduleInfo && moduleInfo.exports.length > 0) {
    const names = moduleInfo.exports.slice(0, MAX_EXPORTS_PER_CARD).map(e => e.name).join(', ');
    lines.push(`exports: ${names}`);
  }
  if (stored) lines.push(...annotationCardLines(stored.annotation));
  return lines.join('\n').slice(0, MAX_CARD_CHARS);
}

/**
 * A node earns a vector only if its card carries semantic surface the deterministic
 * token index lacks: export symbol names or annotation prose. The token index already
 * covers every node's identifier (label + path + package), so an identifier-only card
 * — most auto-derived leaf domains, empty re-export barrels, un-annotated packages —
 * is strictly redundant with it and only dilutes the embedding space. Skipping these
 * keeps the corpus annotation-driven and self-tuning: annotating a node promotes it
 * into the semantic index on the next sync, with no thresholds or config flags.
 */
function cardHasSemanticSignal(
  moduleInfo: ModuleInfo | undefined,
  stored: StoredAnnotation | undefined,
): boolean {
  if (moduleInfo && moduleInfo.exports.length > 0) return true;
  if (stored && annotationCardLines(stored.annotation).length > 0) return true;
  return false;
}

/**
 * Build the full embedding corpus: nodeId -> card text.
 * Deterministic given (graph, modulesById, annotations). Identifier-only nodes are
 * omitted (see cardHasSemanticSignal); they stay discoverable via the token index.
 */
export function projectNodeCards(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  annotations: Record<string, StoredAnnotation>,
): Map<string, string> {
  const cards = new Map<string, string>();
  for (const node of graph.nodes.values()) {
    if (!SEMANTIC_CARD_NODE_TYPES.has(node.type)) continue;
    // Module graph node id === ModuleInfo.id (both carry the `mod:` prefix); look up directly.
    const moduleInfo = node.type === 'module' ? modulesById.get(node.id) : undefined;
    const stored = annotations[node.id];
    if (!cardHasSemanticSignal(moduleInfo, stored)) continue;
    cards.set(node.id, buildNodeCard(node, moduleInfo, stored));
  }
  return cards;
}
