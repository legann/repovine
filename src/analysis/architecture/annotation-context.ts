/**
 * Semantic-reasoning candidates for refactoring findings.
 *
 * Architecture: the MCP does not call any LLM. When `annotationReasoning: 'on'`,
 * findings whose verdict depends on annotation comparison are decorated with a
 * `annotationContext` packet: a structured question, the relevant annotation
 * field excerpts of the affected nodes, and a human-readable hint instructing
 * the caller (an agent in its own conversation context) how to decide.
 *
 * The caller is expected to read those excerpts, answer the question, and
 * suppress / confirm / boost the finding when reporting to the user.
 */

import type { RepositoryGraph, ModuleInfo, StoredAnnotation } from '../../types.js';
import type { AnnotationStore } from '../../annotations/store.js';
import { normalizeRisks } from '../../annotations/format.js';
import { truncateSideEffect } from '../../annotations/side-effect-vocab.js';

/**
 * The structured question a caller must answer for a finding. Every
 * `annotationContext` carries exactly one of these — keep the set small so
 * agents can learn the verbs without a manual.
 */
export type SemanticQuestion =
  | 'same-concept'           // duplicate-like
  | 'shared-invariant'       // low-cohesion, duplicated-client-policy
  | 'shared-state-shape'     // state-fragmentation
  | 'real-side-effect'       // client-business-logic
  | 'intentional-internal'   // boundary
  | 'type-only-or-barrel'    // god-module
  | 'shared-prep-logic'      // flow-convergence
  | 'workflow-orchestrator-or-layout' // prop-drilling-orchestration
  | 'secret-config-boundary'
  | 'shared-security-invariant'
  | 'input-validation-boundary'
  | 'privileged-client-side-effect'
  | 'sensitive-browser-storage'
  | 'server-client-boundary'
  | 'source-disclosure-surface';

type AnnotationField = keyof StoredAnnotation['annotation'];

/**
 * Per-question whitelist of annotation fields. The agent will see only these
 * fields — both to bound token cost and to focus the comparison.
 */
export const RELEVANT_FIELDS: Record<SemanticQuestion, AnnotationField[]> = {
  'same-concept': ['summary', 'keyExports', 'invariants', 'sideEffects'],
  'shared-invariant': ['summary', 'invariants', 'risks', 'assumptions'],
  'shared-state-shape': ['summary', 'stateShape'],
  'real-side-effect': ['summary', 'sideEffects'],
  'intentional-internal': ['summary', 'extensionPoints', 'integrationPoints', 'assumptions'],
  'type-only-or-barrel': ['summary', 'patterns'],
  'shared-prep-logic': ['summary', 'invariants', 'dataFlow'],
  'workflow-orchestrator-or-layout': ['summary', 'stateShape', 'dataFlow', 'sideEffects', 'invariants', 'patterns'],
  'secret-config-boundary': ['summary', 'assumptions', 'sideEffects', 'risks', 'envDependencies'],
  'shared-security-invariant': ['summary', 'invariants', 'risks', 'assumptions'],
  'input-validation-boundary': ['summary', 'assumptions', 'invariants', 'risks', 'dataFlow'],
  'privileged-client-side-effect': ['summary', 'sideEffects', 'risks', 'dataFlow'],
  'sensitive-browser-storage': ['summary', 'stateShape', 'dataFlow', 'risks', 'assumptions'],
  'server-client-boundary': ['summary', 'assumptions', 'sideEffects', 'risks', 'integrationPoints'],
  'source-disclosure-surface': ['summary', 'assumptions', 'sideEffects', 'risks', 'patterns'],
};

/**
 * Minimum annotated nodes required for the question to be meaningful.
 *
 * "Classify" questions (single-target) need 1 annotation — the agent decides
 * whether the *one* module fits a category.
 *
 * "Compare" questions (multi-target) need ≥2 annotations — the agent looks
 * for overlap/divergence between modules.
 */
const MIN_NODES_PER_QUESTION: Record<SemanticQuestion, number> = {
  'same-concept': 2,
  'shared-invariant': 2,
  'shared-state-shape': 2,
  'shared-prep-logic': 2,
  'real-side-effect': 1,
  'intentional-internal': 1,
  'type-only-or-barrel': 1,
  'workflow-orchestrator-or-layout': 1,
  'secret-config-boundary': 1,
  'shared-security-invariant': 2,
  'input-validation-boundary': 1,
  'privileged-client-side-effect': 1,
  'sensitive-browser-storage': 1,
  'server-client-boundary': 1,
  'source-disclosure-surface': 1,
};

/**
 * One-paragraph instruction per question. Reads first-person to the agent;
 * keep terse so it fits in a single finding payload.
 */
export const QUESTION_HINTS: Record<SemanticQuestion, string> = {
  'same-concept':
    'Read summary + keyExports + invariants + sideEffects of each node. If 2+ describe the same '
    + 'concept (not just same filename — same business responsibility AND same effect shape), this '
    + 'is a real duplicate. If they share a name but describe distinct concerns (e.g., HTTP logger '
    + 'vs lambda telemetry) or diverge on sideEffects[].kind (client io-write/http vs server '
    + 'io-write/db), suppress this finding when reporting to the user.',

  'shared-invariant':
    'Compare invariants[] across nodes. Overlap of 1+ invariant tokens => real shared rule, '
    + 'this is a refactoring candidate. No overlap => the heuristic was a false positive; '
    + 'suppress when reporting.',

  'shared-state-shape':
    'Compare stateShape descriptions. If they describe the same domain entity, fragmentation '
    + 'is real. If they describe orthogonal concerns (draft vs submission state), this is '
    + 'intentional separation; suppress.',

  'real-side-effect':
    'Check sideEffects[] of this module. If any entry has kind "io-read", "io-write", or '
    + '"external" (especially subtype "http" | "db" | "queue" | "sdk"), this UI module owns '
    + 'business logic — confirm finding. If sideEffects is [{kind:"pure"}], empty, or only '
    + 'kind "io-write" with subtype "stdout"/"stderr" (logging), suppress.',

  'intentional-internal':
    'Read extensionPoints + integrationPoints + assumptions of the target node. If they '
    + 'document this module as intentionally internal (or intentionally public despite path), '
    + 'adjust confidence accordingly.',

  'type-only-or-barrel':
    'Read summary + patterns. If they describe a type-only module or a re-export barrel, '
    + 'suppress this god-module finding. The export count is misleading for these patterns.',

  'shared-prep-logic':
    'Compare invariants[] of the prep-stage nodes only (not entrypoints, not targets). '
    + 'Repeated invariants across flows => real duplication, lift to shared. Distinct '
    + 'invariants => each flow has its own legitimate prep step.',

  'workflow-orchestrator-or-layout':
    'Read stateShape + dataFlow + sideEffects + patterns. If sideEffects includes kinds '
    + '"io-read"/"io-write"/"external"/"state-global" (business-state coordination), confirm '
    + 'as orchestrator. If sideEffects is [{kind:"pure"}] or only "subscribe"/"state-local" '
    + '(layout/presentation), suppress as intentional prop composition.',

  'secret-config-boundary':
    'Read envDependencies + assumptions + risks. If the module handles secret/private config '
    + 'or assumes server-only access, confirm when syntax places it on a client/public surface. '
    + 'If annotations explicitly say the variables are public client config, lower confidence.',

  'shared-security-invariant':
    'Compare invariants/assumptions across nodes. If 2+ enforce the same permission, role, '
    + 'tenant, ownership, or eligibility rule, confirm as policy drift. If each rule is '
    + 'flow-specific presentation logic, suppress.',

  'input-validation-boundary':
    'Read assumptions + dataFlow + risks. If input is trusted from HTTP/webhook/queue/user '
    + 'boundary and no annotation names runtime validation, confirm. If annotation documents '
    + 'a validated upstream contract, lower confidence.',

  'privileged-client-side-effect':
    'Read sideEffects + dataFlow. If a client/UI module has sideEffects with kind "io-write" '
    + '(any subtype except "stdout"/"stderr"), "external" (subtype "sdk"/"cli"), "state-global", '
    + 'or "resource", confirm — these are privileged actions. If it only has kind "io-read" '
    + 'against a narrow public API wrapper, lower confidence.',

  'sensitive-browser-storage':
    'Read stateShape + dataFlow + risks. If stored data includes tokens, sessions, auth state, '
    + 'PII, tenant/user identifiers, or payment/customer data, confirm. Theme/preferences-only '
    + 'storage should be suppressed.',

  'server-client-boundary':
    'Read assumptions + sideEffects + integrationPoints. If the imported target has sideEffects '
    + 'with kind "io-read"/"io-write" against db/queue/secret-storage or kind "external" SDKs, '
    + 'confirm as server-only crossing. If it is a deliberate public client adapter, lower confidence.',

  'source-disclosure-surface':
    'Read assumptions + risks + patterns. If this module exposes source body, grep snippets, '
    + 'private members, file paths, or raw annotations to a tool/API caller, confirm and check '
    + 'root containment, limits, and redaction.',
};

export interface SemanticContextNode {
  id: string;
  label: string;
  annotation: Partial<StoredAnnotation['annotation']> | null;
  /**
   * Whether the note still matches the module's own text and schema.
   *
   * Narrower than `inspect_node`'s `annotationMeta.fresh` on purpose, and named for what it
   * answers: the questions in this packet compare notes across modules, so what matters is
   * whether each note describes the text it sits on. Whether its upstream claims still hold is the
   * propagation question, and `inspect_node` reports that one.
   */
  annotationContentFresh: boolean;
}

export interface AnnotationContext {
  question: SemanticQuestion;
  relevantFields: AnnotationField[];
  nodes: SemanticContextNode[];
  hint: string;
}

// ── Truncation budgets ──
// Sized so a typical finding's annotationContext fits in ~1-3 KB regardless of
// annotation depth. Agents already understand summaries; we don't need full text.

const MAX_NODES_PER_CONTEXT = 8;
const MAX_SUMMARY_CHARS = 200;
const MAX_INVARIANT_CHARS = 150;
const MAX_LIST_ITEMS = 5;
const MAX_KEY_EXPORTS = 8;
const MAX_KEY_EXPORT_VALUE_CHARS = 100;

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return value;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function pickAnnotationFields(
  annotation: StoredAnnotation['annotation'],
  fields: AnnotationField[],
): Partial<StoredAnnotation['annotation']> {
  const out: Partial<StoredAnnotation['annotation']> = {};
  for (const field of fields) {
    switch (field) {
      case 'summary':
        if (annotation.summary) out.summary = truncate(annotation.summary, MAX_SUMMARY_CHARS);
        break;
      case 'keyExports':
        if (annotation.keyExports) {
          const entries = Object.entries(annotation.keyExports).slice(0, MAX_KEY_EXPORTS);
          if (entries.length > 0) {
            out.keyExports = Object.fromEntries(
              entries.map(([k, v]) => [k, truncate(v, MAX_KEY_EXPORT_VALUE_CHARS) ?? '']),
            );
          }
        }
        break;
      case 'invariants':
        if (annotation.invariants?.length) {
          out.invariants = annotation.invariants
            .slice(0, MAX_LIST_ITEMS)
            .map(item => truncate(item, MAX_INVARIANT_CHARS) ?? '');
        }
        break;
      case 'risks':
        if (annotation.risks?.length) {
          out.risks = normalizeRisks(annotation.risks)
            .slice(0, MAX_LIST_ITEMS)
            .map(item => truncate(item.text, MAX_INVARIANT_CHARS) ?? '');
        }
        break;
      case 'assumptions':
        if (annotation.assumptions?.length) {
          out.assumptions = annotation.assumptions.slice(0, MAX_LIST_ITEMS).map(item => truncate(item, MAX_INVARIANT_CHARS) ?? '');
        }
        break;
      case 'sideEffects':
        if (annotation.sideEffects?.length) {
          out.sideEffects = annotation.sideEffects
            .slice(0, MAX_LIST_ITEMS)
            .map(se => truncateSideEffect(se, MAX_INVARIANT_CHARS));
        }
        break;
      case 'patterns':
        if (annotation.patterns?.length) {
          out.patterns = annotation.patterns.slice(0, MAX_LIST_ITEMS).map(item => truncate(item, MAX_INVARIANT_CHARS) ?? '');
        }
        break;
      case 'extensionPoints':
        if (annotation.extensionPoints?.length) {
          out.extensionPoints = annotation.extensionPoints.slice(0, MAX_LIST_ITEMS).map(item => truncate(item, MAX_INVARIANT_CHARS) ?? '');
        }
        break;
      case 'integrationPoints': {
        const ip = annotation.integrationPoints;
        if (typeof ip === 'string') out.integrationPoints = truncate(ip, MAX_INVARIANT_CHARS);
        else if (ip && Object.keys(ip).length > 0) out.integrationPoints = ip;
        break;
      }
      case 'stateShape': {
        const ss = annotation.stateShape;
        if (typeof ss === 'string') out.stateShape = truncate(ss, MAX_SUMMARY_CHARS);
        else if (ss && Object.keys(ss).length > 0) out.stateShape = ss;
        break;
      }
      case 'dataFlow': {
        const df = annotation.dataFlow;
        if (typeof df === 'string') out.dataFlow = truncate(df, MAX_SUMMARY_CHARS);
        else if (df && Object.keys(df).length > 0) out.dataFlow = df;
        break;
      }
      case 'envDependencies':
        if (annotation.envDependencies && Object.keys(annotation.envDependencies).length > 0) {
          out.envDependencies = Object.fromEntries(
            Object.entries(annotation.envDependencies)
              .slice(0, MAX_KEY_EXPORTS)
              .map(([k, v]) => [k, truncate(v, MAX_KEY_EXPORT_VALUE_CHARS) ?? '']),
          );
        }
        break;
      default:
        // ignore unknown fields
        break;
    }
  }
  return out;
}

/**
 * Build a `AnnotationContext` for a finding, given the affected node ids and the
 * question to ask. Returns `undefined` if fewer than `MIN_NODES_PER_QUESTION`
 * affected nodes carry an annotation — in that case the agent does not have
 * enough material to decide and the heuristic verdict stands on its own
 * (or the user should annotate first).
 */
export function buildAnnotationContext(
  question: SemanticQuestion,
  nodeIds: string[],
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  annotations: AnnotationStore,
): AnnotationContext | undefined {
  const fields = RELEVANT_FIELDS[question];
  const nodes: SemanticContextNode[] = [];
  for (const id of nodeIds.slice(0, MAX_NODES_PER_CONTEXT)) {
    const ann = annotations.get(id);
    if (!ann) continue;
    const mod = modulesById.get(id);
    const contentFresh = mod ? annotations.isFresh(id, mod.contentHash) : false;
    const picked = pickAnnotationFields(ann.annotation, fields);
    if (Object.keys(picked).length === 0) continue;
    nodes.push({
      id,
      label: graph.nodes.get(id)?.label ?? id,
      annotation: picked,
      annotationContentFresh: contentFresh,
    });
  }
  if (nodes.length < MIN_NODES_PER_QUESTION[question]) return undefined;
  return {
    question,
    relevantFields: fields,
    nodes,
    hint: QUESTION_HINTS[question],
  };
}
