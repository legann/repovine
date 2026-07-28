/**
 * How complete an annotation is, and whether the fields it fills contradict the graph.
 *
 * Two orthogonal axes over one stored note. Completeness is a weighted field count that also names
 * what is missing; consistency is a contradiction list recomputed from `annotation × current graph`.
 * They never touch each other: a note can be comprehensive and contradictory at once.
 */
import { provenance, type Provenance } from '../response/provenance.js';
import type { ModuleInfo, StoredAnnotation } from '../types.js';
import { recommendedFieldsForKind, type ModuleKind } from './module-kind.js';
import { detectSideEffectKindsFromHints } from './side-effect-vocab.js';

/**
 * Consistency is a SEPARATE axis from completeness (`score`/`tier`). It does not measure how
 * many fields are filled; it asks whether the fields that ARE filled contradict facts the graph
 * already knows (real export names, detected env vars, detected side effects). It is recomputable
 * from `annotation × current graph`, but it is a contradiction list, not a ladder — one
 * contradiction is enough to distrust — so it is `ok` + `issues[]`, never a number. It MUST NOT
 * affect `score`/`tier`.
 */
export interface AnnotationConsistency {
  ok: boolean;
  /** ONLY concrete contradictions with graph facts — never "field is empty" (that is completeness's job). */
  issues: Array<{
    field: 'keyExports' | 'envDependencies' | 'sideEffects';
    kind: 'unknown-name' | 'contradicts-hints';
    detail: string;
  }>;
}

export interface AnnotationQuality {
  /** Completeness only (0–10). UNCHANGED by the consistency axis. */
  score: number;
  missingFields: string[];
  tier: 'minimal' | 'basic' | 'detailed' | 'comprehensive';
  /** Module kind inferred from snapshot/graph (or 'generic' if not available). */
  moduleKind?: ModuleKind;
  /** Orthogonal axis: do the filled fields contradict graph facts? Recomputable; does NOT move score/tier. */
  consistency: AnnotationConsistency;
  /**
   * What produced `score`/`tier`: a weighted count of filled fields. Travels with the value so a
   * reader of `comprehensive` learns what the word measures from the same object, on every path that
   * hands the quality block over.
   */
  provenance: Provenance;
}

export interface AnnotationQualityInput {
  exportCount: number;
  lineCount: number;
  envVars?: string[];
  /** Optional kind override (computed by inferModuleKind). When omitted, scoring uses generic baseline. */
  moduleKind?: ModuleKind;
  /**
   * Ground truth for the consistency axis: the module's real export names (`mod.exports.map(e => e.name)`).
   * When absent, the keyExports consistency check is SKIPPED — never fabricate ground truth.
   */
  exportNames?: string[];
  /**
   * Ground truth for the consistency axis: side-effect kinds the graph can honestly detect from
   * SemanticHints (see `detectSideEffectKindsFromHints`). When absent, the declared-`pure`-vs-detected
   * check is SKIPPED — never fabricate detected effects.
   */
  detectedSideEffectKinds?: string[];
}

/**
 * Field weights, expressed once and reused by both score accumulation and
 * the "missing" recommendation list. Numbers reflect prior implicit weights
 * but are now centralized.
 */
const FIELD_WEIGHTS = {
  summary: 1,
  keyExports: 1.5,
  assumptions: 0.5,
  sideEffects: 1,
  risks: 1,
  patterns: 1,
  flowDescription: 1,
  invariants: 1,
  extensionPoints: 0.5,
  integrationPoints: 1,
  stateShape: 1,
  dataFlow: 2,
  envDependencies: 1,
} as const;

type ScorableField = keyof typeof FIELD_WEIGHTS;

function hasField(content: StoredAnnotation['annotation'], field: ScorableField): boolean {
  switch (field) {
    case 'summary': return !!content.summary && content.summary.length > 20;
    case 'keyExports': return !!content.keyExports && Object.keys(content.keyExports).length > 0;
    case 'assumptions': return !!content.assumptions?.length;
    case 'sideEffects': return !!content.sideEffects?.length;
    case 'risks': return !!content.risks?.length;
    case 'patterns': return !!content.patterns?.length;
    case 'flowDescription': return !!content.flowDescription;
    case 'invariants': return !!content.invariants?.length;
    case 'extensionPoints': return !!content.extensionPoints?.length;
    case 'integrationPoints': return content.integrationPoints != null
      && (typeof content.integrationPoints === 'string'
        ? content.integrationPoints.length > 0
        : Object.keys(content.integrationPoints).length > 0);
    case 'stateShape': return content.stateShape != null
      && (typeof content.stateShape === 'string'
        ? content.stateShape.length > 0
        : Object.keys(content.stateShape).length > 0);
    case 'dataFlow': return content.dataFlow != null
      && (typeof content.dataFlow === 'string'
        ? content.dataFlow.length > 0
        : Object.keys(content.dataFlow).length > 0);
    case 'envDependencies': return !!content.envDependencies
      && Object.keys(content.envDependencies).length > 0;
  }
}

/**
 * Pure consistency check: does the annotation content contradict facts the graph already knows?
 * Recomputable from `content × input` alone. Only fields the agent actually FILLED are checked —
 * an empty field is completeness's concern, never an issue here (so we never double-count). When a
 * check's ground truth is missing from `input`, that check is silently skipped (never fabricate).
 */
function computeConsistency(
  content: StoredAnnotation['annotation'],
  input: AnnotationQualityInput,
): AnnotationConsistency {
  const issues: AnnotationConsistency['issues'] = [];

  // keyExports — declared export names that the graph does not actually export (drift after refactor).
  // Skip when the module has no captured NAMED exports: re-export barrels (`export { X } from './y'`)
  // record an empty / `default`-only export set because stage1 does not resolve re-exports, so the
  // ground truth is absent — not "exports nothing". Flagging every key there is a false positive, so
  // we treat it like any other absent ground truth and skip (never fabricate a contradiction).
  if (content.keyExports && input.exportNames && input.exportNames.some(n => n !== 'default')) {
    const real = new Set(input.exportNames);
    for (const k of Object.keys(content.keyExports)) {
      if (!real.has(k)) issues.push({ field: 'keyExports', kind: 'unknown-name', detail: k });
    }
  }

  // envDependencies declared but not detected among the module's env vars.
  if (content.envDependencies && input.envVars) {
    const real = new Set(input.envVars);
    for (const k of Object.keys(content.envDependencies)) {
      if (!real.has(k)) issues.push({ field: 'envDependencies', kind: 'unknown-name', detail: k });
    }
  }

  // declared pure while the graph detects real side effects (high signal).
  if (content.sideEffects?.some(e => e.kind === 'pure') && input.detectedSideEffectKinds?.length) {
    issues.push({
      field: 'sideEffects',
      kind: 'contradicts-hints',
      detail: `declared pure; detected ${input.detectedSideEffectKinds.join(',')}`,
    });
  }

  return { ok: issues.length === 0, issues };
}

export function computeAnnotationQuality(
  content: StoredAnnotation['annotation'],
  moduleData: AnnotationQualityInput,
): AnnotationQuality {
  let score = 0;
  const missing: string[] = [];

  const kind: ModuleKind = moduleData.moduleKind ?? 'generic';
  const recommendedForKind = new Set(recommendedFieldsForKind(kind));

  // Universal: always score summary; recommended only when too short.
  if (hasField(content, 'summary')) score += FIELD_WEIGHTS.summary;
  else missing.push('summary (>20 chars)');

  // keyExports — required for kinds that surface exports (everything except 'runtime-resource'/'infra'/'domain'
  // where exports aren't well-defined, and except types-only where summary alone is sometimes enough
  // unless the file has real exports — recommendedFieldsForKind('types') already includes keyExports).
  if (hasField(content, 'keyExports')) score += FIELD_WEIGHTS.keyExports;
  else if (recommendedForKind.has('keyExports') && moduleData.exportCount > 0) missing.push('keyExports');

  if (hasField(content, 'assumptions')) score += FIELD_WEIGHTS.assumptions;
  else if (recommendedForKind.has('assumptions')) missing.push('assumptions');

  if (hasField(content, 'sideEffects')) score += FIELD_WEIGHTS.sideEffects;
  else if (recommendedForKind.has('sideEffects') || moduleData.envVars?.length) missing.push('sideEffects');

  if (hasField(content, 'risks')) score += FIELD_WEIGHTS.risks;
  else if (recommendedForKind.has('risks') || moduleData.lineCount > 500) missing.push('risks');

  if (hasField(content, 'patterns')) score += FIELD_WEIGHTS.patterns;
  else if (recommendedForKind.has('patterns')) missing.push('patterns');

  if (hasField(content, 'flowDescription')) score += FIELD_WEIGHTS.flowDescription;
  else if (recommendedForKind.has('flowDescription')) missing.push('flowDescription');

  if (hasField(content, 'invariants')) score += FIELD_WEIGHTS.invariants;
  else if (recommendedForKind.has('invariants')) missing.push('invariants');

  if (hasField(content, 'extensionPoints')) score += FIELD_WEIGHTS.extensionPoints;
  else if (recommendedForKind.has('extensionPoints')) missing.push('extensionPoints');

  if (hasField(content, 'integrationPoints')) score += FIELD_WEIGHTS.integrationPoints;
  else if (recommendedForKind.has('integrationPoints') || moduleData.exportCount > 5) missing.push('integrationPoints');

  if (hasField(content, 'stateShape')) score += FIELD_WEIGHTS.stateShape;
  else if (recommendedForKind.has('stateShape')) missing.push('stateShape');

  if (hasField(content, 'dataFlow')) score += FIELD_WEIGHTS.dataFlow;
  else if (moduleData.lineCount > 200 && (kind === 'api-handler' || kind === 'service-mgr' || kind === 'generic')) {
    missing.push('dataFlow');
  }

  if (hasField(content, 'envDependencies')) score += FIELD_WEIGHTS.envDependencies;
  else if (moduleData.envVars?.length) missing.push('envDependencies');

  const tier: AnnotationQuality['tier'] = score >= 8 ? 'comprehensive'
    : score >= 5 ? 'detailed'
    : score >= 2 ? 'basic'
    : 'minimal';

  // Consistency is computed independently and attached, but deliberately does NOT touch score/tier.
  const consistency = computeConsistency(content, moduleData);

  return {
    score: Math.min(10, score),
    missingFields: missing,
    tier,
    moduleKind: kind,
    consistency,
    provenance: provenance('field-completeness'),
  };
}

/**
 * A consistency issue is "hard" (trustworthy contradiction → gate error under harness, counted as
 * inconsistent) vs "advisory" (the backing graph detector is known-incomplete, so a mismatch may be
 * a detection gap rather than annotation drift). Currently only `envDependencies` is advisory.
 *
 * The env-var detector resolves a read whose name is written at the access site. Three forms carry
 * the name elsewhere and stay unresolved: a computed key (`process.env[BY_ROLE[role]]`), an aliased
 * container (`const env = process.env` then `env.NAME`), and a name that reaches the read as an
 * argument (`envEnabled('NAME')`). Each is a live source of honestly-declared env dependencies the
 * graph cannot see, so a mismatch stays advisory. keyExports/sideEffects stay hard.
 */
export function isHardConsistencyIssue(issue: AnnotationConsistency['issues'][number]): boolean {
  return issue.field !== 'envDependencies';
}

/** Build the consistency-aware quality input for a module (shared ground-truth derivation). */
export function annotationQualityInputForModule(mod: ModuleInfo, moduleKind?: ModuleKind): AnnotationQualityInput {
  return {
    exportCount: mod.exports.length,
    lineCount: mod.exports.reduce((m, e) => Math.max(m, e.lineRange.end), 0),
    envVars: mod.semanticHints?.envVars,
    ...(moduleKind ? { moduleKind } : {}),
    exportNames: mod.exports.map(e => e.name),
    detectedSideEffectKinds: detectSideEffectKindsFromHints(mod.semanticHints),
  };
}

export interface InconsistentModuleAnnotation {
  nodeId: string;
  /** Only HARD issues (advisory env mismatches are excluded — see isHardConsistencyIssue). */
  issues: AnnotationConsistency['issues'];
}

/** The stored notes this axis reads; narrower than the store so scoring never reaches for its state. */
export interface StoredAnnotationSource {
  getAll(): Record<string, StoredAnnotation>;
}

/**
 * Recompute the consistency axis for every stored MODULE annotation against the current snapshot and
 * return those with at least one HARD contradiction. Advisory-only mismatches do not make a note
 * "inconsistent" here. Pure function of `annotations × modulesById`, so it surfaces drift on existing
 * notes (e.g. keyExports after a refactor) without re-annotating — an advisory health signal, never a
 * gate. Module-only: domain/service/infra roll-ups carry no keyExports/env/sideEffects to contradict.
 */
export function computeInconsistentModuleAnnotations(
  annotations: StoredAnnotationSource,
  modulesById: Map<string, ModuleInfo>,
): InconsistentModuleAnnotation[] {
  const out: InconsistentModuleAnnotation[] = [];
  for (const [nodeId, stored] of Object.entries(annotations.getAll())) {
    if (stored.nodeType !== 'module') continue;
    const mod = modulesById.get(nodeId);
    if (!mod) continue;
    const quality = computeAnnotationQuality(stored.annotation, annotationQualityInputForModule(mod));
    const hard = quality.consistency.issues.filter(isHardConsistencyIssue);
    if (hard.length > 0) out.push({ nodeId, issues: hard });
  }
  return out;
}
