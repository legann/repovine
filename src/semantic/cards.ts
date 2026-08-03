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
/**
 * Xenova/all-MiniLM-L6-v2 has a roughly 256-token input window. A conservative
 * character budget makes our truncation deterministic instead of delegating a
 * silent second truncation to the tokenizer.
 */
export const SEMANTIC_CARD_CHAR_BUDGET = 1000;

export type SemanticCardField =
  | 'identity'
  | 'description'
  | 'exports'
  | 'summary'
  | 'invariants'
  | 'risks'
  | 'flow'
  | 'integration'
  | 'keyExports';

export interface NodeCardProjection {
  text: string;
  fullText: string;
  fullChars: number;
  retainedChars: number;
  truncated: boolean;
  annotationChars: number;
  retainedAnnotationChars: number;
  retainedByField: Partial<Record<SemanticCardField, number>>;
}

function stringValues(value: string | Record<string, string> | undefined): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  return Object.entries(value).map(([k, v]) => `${k}: ${v}`);
}

type CardSegment = { field: SemanticCardField; text: string; annotation: boolean };

function annotationCardSegments(annotation: AnnotationContent): CardSegment[] {
  const lines: CardSegment[] = [];
  // Order is deliberate: preserve the behavioural contract before descriptive
  // export prose when the model window cannot hold the whole annotation.
  if (annotation.summary) lines.push({ field: 'summary', text: annotation.summary, annotation: true });
  for (const invariant of annotation.invariants ?? []) {
    lines.push({ field: 'invariants', text: `invariant: ${invariant}`, annotation: true });
  }
  for (const risk of normalizeRisks(annotation.risks)) {
    lines.push({ field: 'risks', text: `risk: ${risk.text}`, annotation: true });
  }
  if (annotation.flowDescription) {
    lines.push({ field: 'flow', text: annotation.flowDescription, annotation: true });
  }
  for (const flow of stringValues(annotation.dataFlow)) {
    lines.push({ field: 'flow', text: `data flow: ${flow}`, annotation: true });
  }
  for (const point of stringValues(annotation.integrationPoints)) {
    lines.push({ field: 'integration', text: `integration: ${point}`, annotation: true });
  }
  for (const [name, description] of Object.entries(annotation.keyExports ?? {})) {
    lines.push({ field: 'keyExports', text: `${name}: ${description}`, annotation: true });
  }
  return lines;
}

export function buildNodeCardProjection(
  node: { id: string; type: string; label: string; description: string },
  moduleInfo: ModuleInfo | undefined,
  stored: StoredAnnotation | undefined,
): NodeCardProjection {
  const segments: CardSegment[] = [];
  segments.push({ field: 'identity', text: `${node.label} (${node.type})`, annotation: false });
  const pathish = node.id.replace(/^[^:]+:/, '').replace(/[/\-_.:]/g, ' ');
  segments.push({ field: 'identity', text: pathish, annotation: false });
  if (node.description) {
    segments.push({ field: 'description', text: node.description, annotation: false });
  }
  if (moduleInfo && moduleInfo.exports.length > 0) {
    const names = moduleInfo.exports.slice(0, MAX_EXPORTS_PER_CARD).map(e => e.name).join(', ');
    segments.push({ field: 'exports', text: `exports: ${names}`, annotation: false });
  }
  if (stored) segments.push(...annotationCardSegments(stored.annotation));

  const fullText = segments.map(segment => segment.text).join('\n');
  const text = fullText.slice(0, SEMANTIC_CARD_CHAR_BUDGET);
  const retainedByField: Partial<Record<SemanticCardField, number>> = {};
  let cursor = 0;
  let annotationChars = 0;
  let retainedAnnotationChars = 0;
  for (const [index, segment] of segments.entries()) {
    const start = cursor + (index === 0 ? 0 : 1);
    const end = start + segment.text.length;
    const retained = Math.max(0, Math.min(text.length, end) - Math.min(text.length, start));
    retainedByField[segment.field] = (retainedByField[segment.field] ?? 0) + retained;
    if (segment.annotation) {
      annotationChars += segment.text.length;
      retainedAnnotationChars += retained;
    }
    cursor = end;
  }
  return {
    text,
    fullText,
    fullChars: fullText.length,
    retainedChars: text.length,
    truncated: fullText.length > text.length,
    annotationChars,
    retainedAnnotationChars,
    retainedByField,
  };
}

export function buildNodeCard(
  node: { id: string; type: string; label: string; description: string },
  moduleInfo: ModuleInfo | undefined,
  stored: StoredAnnotation | undefined,
): string {
  return buildNodeCardProjection(node, moduleInfo, stored).text;
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
  if (stored && annotationCardSegments(stored.annotation).length > 0) return true;
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
