/**
 * Agent Protocol validators.
 *
 * Two layers, as specified by the build plan:
 *
 *   1. Schema validation  — is the structured artifact shaped correctly?
 *                           (required fields, enum values, runId linkage,
 *                           supported protocolVersion).
 *   2. Compliance validation — do the claims hold against observable repovine
 *                              state? (declared graph nodes exist, declared
 *                              annotations exist and are fresh, orphans absent
 *                              or reported, requested checks reflected, scope
 *                              matches, refresh_context run when code changed).
 *
 * repovine never reads conversational transcripts; it validates structured
 * claims plus observable repository state.
 */
import type { RepositoryGraph, RepositoryFactsSnapshot } from '../types.js';
import type { AnnotationStore } from '../annotations/store.js';
import { computeAnnotationQuality, isHardConsistencyIssue } from '../annotations/quality.js';
import { isPropagationStaleItem, isContentStaleItem } from '../annotations/backlog.js';
import { detectSideEffectKindsFromHints } from '../annotations/side-effect-vocab.js';
import { inferModuleKind } from '../annotations/module-kind.js';
import { nodeInScopeHints } from '../annotations/scope-hints.js';
import { owningModuleId } from '../graph/node-ids.js';
import { renderNextCall } from '../response/next-call.js';
import { validateAnnotationHealth, buildAnnotationHealthScan } from '../annotations/maintenance.js';
import type { AnnotationHealthScan } from '../annotations/store.js';
import {
  PROTOCOL_VERSION,
  AgentAssignmentSchema,
  AgentRunResultSchema,
  SubagentHandoffSchema,
  ReviewInputSchema,
  RequestedCheckSchema,
  type AgentAssignment,
  type AgentRunResult,
  type AgentComplianceReport,
  type RequestedCheck,
  type SubagentHandoff,
  type ReviewInput,
} from './protocol.js';
import { getManifest } from './manifests.js';
import type { ContextQualityReport, ContextSessionPolicy, ContextQualityConfig } from '../context-quality/types.js';
import { stripIndexBasename, stripModuleIdSuffix } from '../plugins/source-set.js';
import { resolveNodeIdByShape as resolveGraphNodeId } from '../graph/module-files.js';
export { resolveNodeIdByShape as resolveGraphNodeId } from '../graph/module-files.js';
import { moduleNodeId } from '../graph/node-ids.js';
import { resolveRelPath, toPosixPath } from '../platform/paths.js';
import { shortenList, omittedNote } from '../platform/text.js';

// The weighted context-quality score was measured against outcome-labelled sessions and did not
// beat a trivial baseline, so it may not reject a handoff. The report is still emitted in full;
// only its authority is withheld. See docs/context-quality.md for the bar a hard gate must clear.
const CONTEXT_QUALITY_HARD_GATE_VALIDATED = false;

// ── Shared shapes ──

/** Observable repository state the compliance layer reads. */
export interface ComplianceState {
  repoRoot: string;
  graph: RepositoryGraph;
  snapshot: RepositoryFactsSnapshot;
  annotations: AnnotationStore;
  getContextQualityReport?: (
    sessionId: string,
    policy?: ContextSessionPolicy,
  ) => ContextQualityReport | undefined;
  consumeContextQualitySession?: (
    sessionId: string,
    options?: { retain?: boolean },
  ) => boolean;
  contextQualityConfig?: ContextQualityConfig;
}

/** Result of a schema-only validation pass over an untrusted artifact. */
export interface SchemaValidation<T> {
  valid: boolean;
  /** Parsed + typed value when valid. */
  value?: T;
  errors: string[];
  warnings: string[];
  /** Set when protocolVersion was present but unsupported. */
  unsupportedVersion?: string;
}

// ── Helpers ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Detect a present-but-unsupported protocolVersion before strict parsing. */
function unsupportedVersionOf(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const v = input.protocolVersion;
  if (typeof v === 'string' && v !== PROTOCOL_VERSION) return v;
  if (typeof v === 'number' && String(v) !== PROTOCOL_VERSION) return String(v);
  return undefined;
}

function formatIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string[] {
  return error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`);
}


/**
 * Map a changed file path (repo- or package-relative, any extension) to the graph module id(s)
 * it backs. Used by the annotation provenance check: editing a file grounds annotations on its
 * module. Matches the canonical `mod:<path>` id directly and, as a fallback, by path suffix
 * against the snapshot's module records.
 */
function modulesForFile(graph: RepositoryGraph, snapshot: RepositoryFactsSnapshot, file: string): string[] {
  const norm = resolveRelPath;
  const stripExt = (p: string): string => stripIndexBasename(stripModuleIdSuffix(p));
  const target = stripExt(norm(file));
  if (!target) return [];
  const out = new Set<string>();
  const targetId = moduleNodeId(target);
  if (graph.nodes.has(targetId)) out.add(targetId);
  for (const mod of snapshot.modules ?? []) {
    const rel = stripExt(norm(mod.relativeFilePath ?? ''));
    const abs = stripExt(norm(mod.filePath ?? ''));
    if (rel && (target === rel || target.endsWith(`/${rel}`) || rel.endsWith(`/${target}`))) out.add(mod.id);
    else if (abs && (abs === target || abs.endsWith(`/${target}`))) out.add(mod.id);
  }
  return [...out];
}

function scopeEntryCovered(entry: string, allowed: string[]): boolean {
  return allowed.some(a => entry === a || entry.startsWith(`${a}/`) || a.startsWith(`${entry}/`));
}

function collectScopeCollisions(entries: string[], allowed: string[]): string[] {
  if (allowed.length === 0) return [];
  return entries.filter(entry => !scopeEntryCovered(entry, allowed));
}

function hasResolvedAnchors(value: unknown): value is AgentRunResult['contextPack'] {
  return isRecord(value) && Array.isArray(value.resolvedAnchors) && Array.isArray(value.scope);
}

// ── Schema validators ──

/** Validate an AgentAssignment shape. */
export function validateAssignment(input: unknown): SchemaValidation<AgentAssignment> {
  const unsupportedVersion = unsupportedVersionOf(input);
  const parsed = AgentAssignmentSchema.safeParse(input);
  if (parsed.success) {
    return { valid: true, value: parsed.data, errors: [], warnings: [] };
  }
  const errors = formatIssues(parsed.error);
  if (unsupportedVersion) {
    errors.unshift(
      `Unsupported protocolVersion "${unsupportedVersion}"; this repovine supports "${PROTOCOL_VERSION}".`,
    );
  }
  return { valid: false, errors, warnings: [], ...(unsupportedVersion ? { unsupportedVersion } : {}) };
}

/** Validate an AgentRunResult shape. */
export function validateRunResult(input: unknown): SchemaValidation<AgentRunResult> {
  const unsupportedVersion = unsupportedVersionOf(input);
  const parsed = AgentRunResultSchema.safeParse(input);
  if (parsed.success) {
    return { valid: true, value: parsed.data, errors: [], warnings: [] };
  }
  const errors = formatIssues(parsed.error);
  if (unsupportedVersion) {
    errors.unshift(
      `Unsupported protocolVersion "${unsupportedVersion}"; this repovine supports "${PROTOCOL_VERSION}".`,
    );
  }
  return { valid: false, errors, warnings: [], ...(unsupportedVersion ? { unsupportedVersion } : {}) };
}

/** Validate an internal SubagentHandoff shape (used by main-agent orchestration). */
export function validateSubagentHandoff(input: unknown): SchemaValidation<SubagentHandoff> {
  const unsupportedVersion = unsupportedVersionOf(input);
  const parsed = SubagentHandoffSchema.safeParse(input);
  if (parsed.success) {
    return { valid: true, value: parsed.data, errors: [], warnings: [] };
  }
  const errors = formatIssues(parsed.error);
  if (unsupportedVersion) {
    errors.unshift(
      `Unsupported protocolVersion "${unsupportedVersion}"; this repovine supports "${PROTOCOL_VERSION}".`,
    );
  }
  return { valid: false, errors, warnings: [], ...(unsupportedVersion ? { unsupportedVersion } : {}) };
}

// ── ReviewInput validation ──

/**
 * Normalize a repository-relative path for set comparison: convert `\\`→`/`,
 * collapse duplicate separators, drop `.` segments and trailing separators.
 * Reject empty, absolute, or parent-traversal (`..`) entries — a ReviewInput
 * file set is repository-relative POSIX. Returns the normalized path or a
 * rejection reason.
 */
function normalizeReviewPath(raw: string): { path?: string; error?: string } {
  const collapsed = toPosixPath(raw.trim()).replace(/\/{2,}/g, '/');
  if (collapsed.startsWith('/') || /^[A-Za-z]:\//.test(collapsed)) {
    return { error: `absolute path not allowed: "${raw}"` };
  }
  const segments = collapsed.split('/').filter(seg => seg !== '' && seg !== '.');
  if (segments.length === 0) return { error: `empty path entry "${raw}"` };
  if (segments.includes('..')) return { error: `parent-traversal not allowed: "${raw}"` };
  return { path: segments.join('/') };
}

/** Normalize a path list into a stable-sorted unique set, collecting rejects. */
function normalizePathSet(paths: string[]): { set: string[]; errors: string[] } {
  const set = new Set<string>();
  const errors: string[] = [];
  for (const raw of paths) {
    const { path: p, error } = normalizeReviewPath(raw);
    if (error) errors.push(error);
    else if (p) set.add(p);
  }
  return { set: [...set].sort(), errors };
}

/** Trim, dedupe, and stable-sort graph node ids (no path normalization). */
function normalizeNodeIdSet(ids: string[]): string[] {
  return [...new Set(ids.map(id => id.trim()).filter(id => id.length > 0))].sort();
}

function setsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Validate a standalone ReviewInput: schema shape plus cross-object linkage.
 *
 * `ReviewInput.assignment` is normatively the ORIGINAL parent implementation
 * assignment (the separate review assignment is the reviewer's own dispatch
 * envelope), so its runId must equal `implementationResult.runId`. The top-level
 * `changedFiles` / `graphNodesTouched` are the reviewer-facing delta and MUST be
 * set-equal to the implementation result's own claims. Reports errors; never
 * rewrites the submitted object.
 */
export function validateReviewInput(input: unknown): SchemaValidation<ReviewInput> {
  const parsed = ReviewInputSchema.safeParse(input);
  if (!parsed.success) {
    return { valid: false, errors: formatIssues(parsed.error), warnings: [] };
  }
  const value = parsed.data;
  const errors: string[] = [];

  // runId linkage: the assignment is the implementation assignment.
  if (value.assignment.runId !== value.implementationResult.runId) {
    errors.push(
      `ReviewInput linkage: assignment.runId "${value.assignment.runId}" != implementationResult.runId "${value.implementationResult.runId}".`,
    );
  }

  // changedFiles set-equality with implementationResult.filesChanged.
  const changed = normalizePathSet(value.changedFiles);
  const resultFiles = normalizePathSet(value.implementationResult.filesChanged);
  for (const e of changed.errors) errors.push(`ReviewInput.changedFiles: ${e}`);
  for (const e of resultFiles.errors) errors.push(`ReviewInput.implementationResult.filesChanged: ${e}`);
  if (changed.errors.length === 0 && resultFiles.errors.length === 0 && !setsEqual(changed.set, resultFiles.set)) {
    errors.push(
      `ReviewInput.changedFiles must set-equal implementationResult.filesChanged `
      + `(changedFiles=[${changed.set.join(', ')}], filesChanged=[${resultFiles.set.join(', ')}]).`,
    );
  }

  // graphNodesTouched set-equality with implementationResult.graphNodesTouched.
  const changedNodes = normalizeNodeIdSet(value.graphNodesTouched);
  const resultNodes = normalizeNodeIdSet(value.implementationResult.graphNodesTouched);
  if (!setsEqual(changedNodes, resultNodes)) {
    errors.push(
      `ReviewInput.graphNodesTouched must set-equal implementationResult.graphNodesTouched `
      + `(graphNodesTouched=[${changedNodes.join(', ')}], result=[${resultNodes.join(', ')}]).`,
    );
  }

  return { valid: errors.length === 0, value, errors, warnings: [] };
}

// ── Compliance validation ──

const CHECK_TO_FLAG: Record<Exclude<RequestedCheck, 'code-review'>, keyof AgentRunResult['compliance'] | 'testsRun'> = {
  dependencies: 'dependencyImpactChecked',
  config: 'configSurfaceChecked',
  'runtime-flow': 'flowChecked',
  architecture: 'architectureChecked',
  annotations: 'annotationsClean',
  tests: 'testsRun',
};

const CHECK_FOLLOWUP: Record<RequestedCheck, string> = {
  dependencies: 'Run analyze_dependencies({ "scope": "mod:<path/to/module>", "mode": "impact" }) for the touched scope; impact needs a module or export-symbol scope.',
  config: 'Run get_config_surface for the touched scope.',
  'runtime-flow': 'Run trace_flow for the touched runtime scope.',
  architecture: 'Run analyze_architecture for the touched scope.',
  'code-review': 'Provide AgentRunResult.review with a read-only CodeReviewResult verdict.',
  annotations: 'Run get_annotation_status / validate_annotations and clear the queue.',
  tests: 'Record the tests run in result.testsRun.',
};

/** A run result field is "empty" when absent, an empty string, or an empty array. */
function isFieldEmpty(result: AgentRunResult, field: string): boolean {
  const value = (result as unknown as Record<string, unknown>)[field];
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export interface CheckComplianceInput {
  result: AgentRunResult;
  assignment?: AgentAssignment;
  state: ComplianceState;
  /** Optional manifest name/role to source requiredRunResultFields from. */
  manifestName?: string;
  /**
   * The run began greenfield: no prior annotated context existed when it started.
   * Set by a multi-sub-agent harness so the greenfield context exemption holds for
   * EVERY sub-agent in the run, not just the first. Without it, the exemption is
   * per-sub-agent: the moment one sibling writes an annotation, later siblings see it
   * as "prior context" and get their weak first-pass sessions hard-failed. Prior
   * context is a run-start property, so the harness that knows run-start state owns it.
   */
  greenfieldRun?: boolean;
}

/**
 * Validate a run result's claims against observable repovine state and produce
 * an AgentComplianceReport. The result is assumed already schema-valid; callers
 * that accept untrusted input should run {@link validateRunResult} first.
 */
export function checkCompliance(input: CheckComplianceInput): AgentComplianceReport {
  const { result, assignment, state } = input;
  const { graph } = state;

  // Enforcement mode (harness | client) gates how hard annotation/context issues
  // bite. Computed once up front so the annotation section and the context-session
  // section share it. Source of truth: assignment.contextSession.mode, else the
  // repo's contextQuality.enforcement.mode, else client. Client mode preserves the
  // pre-existing warning-only behavior. Harness mode still hard-fails the
  // evidence-backed annotation checks; the unvalidated context score is
  // explicitly advisory below.
  const contextPolicy = assignment?.contextSession;
  const contextRequired = contextPolicy?.required === true;
  const enforcementMode = contextPolicy?.mode ?? state.contextQualityConfig?.enforcement.mode ?? 'client';
  const harnessStrict = enforcementMode === 'harness';

  const errors: string[] = [];
  const warnings: string[] = [];
  const missingFields: string[] = [];
  const staleAnnotations: string[] = [];
  const missingAnnotations: string[] = [];
  const unresolvedGraphNodes: string[] = [];
  const scopeCollisions: string[] = [];
  const requiredFollowups: string[] = [];
  // Structured annotation-grounding facts (surfaced regardless of mode; consumers apply their own
  // policy). Hard only — env mismatches stay advisory in warnings and never enter these.
  const ungroundedAnnotations: string[] = [];
  const inconsistentAnnotations: Array<{ nodeId: string; issues: string[] }> = [];
  let contextQuality: ContextQualityReport | undefined;

  // runId linkage between assignment and result.
  if (assignment && assignment.runId !== result.runId) {
    errors.push(
      `runId mismatch: assignment "${assignment.runId}" != result "${result.runId}".`,
    );
  }

  // Required-by-role result fields (manifest-driven; baseline is summary).
  const manifest = input.manifestName ? getManifest(input.manifestName) : undefined;
  const requiredFields = manifest?.requiredRunResultFields ?? ['summary'];
  for (const field of requiredFields) {
    if (isFieldEmpty(result, field)) missingFields.push(field);
  }
  if (missingFields.length > 0) {
    requiredFollowups.push(
      `Populate required result field(s): ${missingFields.join(', ')}.`,
    );
  }

  // Declared read-only capability: a canEditFiles=false manifest, or an
  // annotate-phase assignment, must not report source edits. Annotation-writer
  // effects are represented by annotationsWritten, never sub-agent filesChanged.
  if (result.filesChanged.length > 0) {
    if (manifest && manifest.canEditFiles === false) {
      errors.push(
        `Manifest "${manifest.name}" is read-only (canEditFiles=false) but result.filesChanged is non-empty: ${result.filesChanged.join(', ')}.`,
      );
      requiredFollowups.push('Run edits under an edit-capable manifest, or report annotation effects via annotationsWritten instead of filesChanged.');
    }
    if (contextPolicy?.phase === 'annotate') {
      errors.push('assignment.contextSession.phase="annotate" but result.filesChanged is non-empty; the annotate phase is source-read-only.');
      requiredFollowups.push('Move code edits to an implementation phase; the annotate phase only writes annotations.');
    }
  }

  // Declared graph nodes must exist in the current graph.
  for (const nodeId of result.graphNodesTouched) {
    if (!resolveGraphNodeId(graph, nodeId)) unresolvedGraphNodes.push(nodeId);
  }
  if (unresolvedGraphNodes.length > 0) {
    errors.push(`Declared graphNodesTouched not found in graph: ${unresolvedGraphNodes.join(', ')}.`);
    requiredFollowups.push('Run refresh_context and correct graphNodesTouched to canonical node ids.');
  }

  const annotationsRequested = assignment?.requestedChecks.includes('annotations') === true;
  const annotationPhase = contextPolicy?.phase === 'annotate' || annotationsRequested;

  // Annotation state (orphans, stale, parse/merge) from a single shared scan,
  // reused by the health report and every scoped check below.
  const annotationScan = buildAnnotationHealthScan({
    repoRoot: state.repoRoot,
    graph,
    snapshot: state.snapshot,
    annotations: state.annotations,
  });
  const health = validateAnnotationHealth({
    repoRoot: state.repoRoot,
    graph,
    snapshot: state.snapshot,
    annotations: state.annotations,
    scan: annotationScan,
  });
  const orphanedAnnotations = health.mergeStatus.file.exists
    ? state.annotations.detectOrphaned(graph).orphaned.map(o => o.nodeId)
    : [];

  // Declared-written annotations must actually exist; flag claimed-but-absent.
  const queue = annotationScan.rows;
  const staleSet = new Set(
    queue.filter(q => q.status === 'stale' && !isPropagationStaleItem(q)).map(q => q.nodeId),
  );
  const propagationStaleSet = new Set(
    queue.filter(q => isPropagationStaleItem(q)).map(q => q.nodeId),
  );
  for (const rawId of result.annotationsWritten) {
    const nodeId = resolveGraphNodeId(graph, rawId) ?? rawId;
    if (!state.annotations.get(nodeId)) {
      missingAnnotations.push(rawId);
    } else if (staleSet.has(nodeId)) {
      staleAnnotations.push(nodeId);
    } else if (propagationStaleSet.has(nodeId)) {
      errors.push(`Declared annotation is propagation-stale and should be reviewed against upstream changes: ${nodeId}.`);
    }
  }
  if (missingAnnotations.length > 0) {
    errors.push(`Declared annotationsWritten with no stored annotation: ${missingAnnotations.join(', ')}.`);
    requiredFollowups.push('Re-run write_annotation for the claimed nodes, or remove them from annotationsWritten.');
  }
  if (staleAnnotations.length > 0) {
    warnings.push(`Declared annotations are content-stale: ${staleAnnotations.join(', ')}.`);
    requiredFollowups.push('Refresh annotations for stale declared nodes via write_annotation.');
  }

  const implementPhase = contextPolicy?.phase === 'implement';
  const assignmentScope = assignment?.scope ?? result.scope ?? [];
  // Annotate-phase sync sub-agents are scoped writers: N of them drain disjoint
  // scopes of ONE shared queue sequentially, so the first cannot honestly claim
  // repo-wide clean while sibling scopes are still stale. Judge each against its
  // OWN scope's staleness — same treatment implement leaves already get. A
  // whole-repo scope ('.') stays repo-wide.
  const scopedAnnotationsCleanGate =
    (implementPhase || annotationPhase)
    && assignmentScope.length > 0
    && !assignmentScope.includes('.');

  // annotationsClean claim cross-check against observable state.
  if (result.compliance.annotationsClean) {
    if (scopedAnnotationsCleanGate) {
      const scopedHealth = validateAnnotationHealth({
        repoRoot: state.repoRoot,
        graph,
        snapshot: state.snapshot,
        annotations: state.annotations,
        scope: assignmentScope,
        scan: annotationScan,
      });
      if (!scopedHealth.scopedClean) {
        errors.push(
          'compliance.annotationsClean=true but annotation checks are not clean within assignment scope '
          + `[${assignmentScope.join(', ')}] `
          + `(needsWorkInScope=${scopedHealth.needsWorkInScope ?? scopedHealth.needsWork}).`,
        );
      } else if (health.status !== 'clean') {
        warnings.push(
          'compliance.annotationsClean=true within assignment scope; repo-wide annotation queue still has '
          + `${health.counts.stale} stale, ${health.counts.unannotated} unannotated item(s) — defer outside-scope debt to annotation-sync.`,
        );
      }
      const scopedPropagation = queue.filter(
        (q) => isPropagationStaleItem(q) && nodeInScopeHints(q.nodeId, assignmentScope),
      );
      if (scopedPropagation.length > 0) {
        errors.push(
          `compliance.annotationsClean=true while ${scopedPropagation.length} propagation-stale annotation(s) remain in assignment scope; `
          + 'clear via write_annotation({ refreshImportBaseline: true }) or rewrite when upstream contract changed.',
        );
      } else if (health.counts.stalePropagation > 0) {
        warnings.push(
          `compliance.annotationsClean=true within scope; ${health.counts.stalePropagation} propagation-stale item(s) outside assignment scope.`,
        );
      }
    } else {
      if (health.status !== 'clean') {
        errors.push(
          'compliance.annotationsClean=true but annotation hard checks are not clean '
          + `(orphaned=${health.counts.orphaned}, stale=${health.counts.stale}, conflictMarkers=${health.mergeStatus.file.hasConflictMarkers}).`,
        );
      }
      if (health.counts.stalePropagation > 0) {
        errors.push(
          `compliance.annotationsClean=true while ${health.counts.stalePropagation} propagation-stale annotation(s) remain; clear via write_annotation({ refreshImportBaseline: true }) or rewrite when upstream contract changed.`,
        );
      }
    }
  }
  if (orphanedAnnotations.length > 0) {
    const orphanMsg = `Orphaned annotations present (${orphanedAnnotations.length}); report or clean before handoff.`;
    if (harnessStrict && annotationPhase) errors.push(orphanMsg);
    else warnings.push(orphanMsg);
    requiredFollowups.push('Run refresh_context({ "cleanupOrphans": true }) or get_annotation_status({ "view": "orphans" }).');
  }

  if (harnessStrict && implementPhase && assignmentScope.length && !assignmentScope.includes('.')) {
    const inScope = (nodeId: string) => nodeInScopeHints(nodeId, assignmentScope);
    const outOfScopeNeedsWork = queue.filter((q) => {
      if (inScope(q.nodeId)) return false;
      if (q.status === 'unannotated') return true;
      return isContentStaleItem(q) || isPropagationStaleItem(q);
    });
    if (outOfScopeNeedsWork.length > 0) {
      const outOfScopeShown = shortenList(outOfScopeNeedsWork, 3);
      const sample = outOfScopeShown.shown.map((q) => q.nodeId).join(', ');
      warnings.push(
        `Annotation queue has ${outOfScopeNeedsWork.length} item(s) outside assignment scope (${sample}${omittedNote(outOfScopeShown.omitted)}); defer to the infra/annotation-sync sub-agent.`,
      );
    }
  }

  // Harness coverage gate (harness mode ONLY — zero behavior change for clients):
  // annotation completeness is enforced during an explicit annotation phase or
  // when the assignment requested the annotations check. Code/review phases may
  // defer annotation sync to a later reviewed pass, but false annotationsClean=true
  // claims are still rejected above.
  if (harnessStrict && annotationPhase) {
    const scopeHints = assignment?.scope ?? result.scope ?? [];
    const inScope = (nodeId: string): boolean => nodeInScopeHints(nodeId, scopeHints);
    // Hard-fail on own-content drift (stale) and on unannotated CODE MODULES.
    // Derived-stale is an advisory upstream-review signal, so it should not force
    // bulk re-annotation unless a stricter assignment explicitly asks for it.
    // Synthetic domain/service/infra roll-ups that are merely unannotated stay
    // advisory — they are auto-derived aggregates, not the agent's edits, so
    // forcing a note on every micro-task would be noise.
    const isAggregate = (q: { phase?: string }) =>
      q.phase === 'domain'
      || q.phase === 'runtime-resource'
      || q.phase === 'infra';
    const uncovered = queue.filter(q => {
      if (!inScope(q.nodeId)) return false;
      if (q.status === 'unannotated' && isAggregate(q)) return false;
      return q.status === 'unannotated' || isContentStaleItem(q) || isPropagationStaleItem(q);
    });
    if (uncovered.length > 0) {
      const { shown, omitted } = shortenList(uncovered, 8);
      const sample = shown.map(q => `${q.nodeId} (${q.staleKind ?? q.status})`).join(', ');
      const more = omittedNote(omitted);
      errors.push(`Annotation coverage incomplete in scope (${uncovered.length} node(s) unannotated/stale): ${sample}${more}.`);
      requiredFollowups.push('write_annotation each unannotated/content-stale/propagation-stale node in scope, then refresh_context + validate_annotations until needsWork is 0.');
    }

  }

  // Touched-set annotation quality for touched CODE modules. Two orthogonal axes:
  //  • completeness (thin): a fresh, annotated module must have no missing recommended fields.
  //    `missingFields` is ground-truth-aware (keyExports only when the module has exports, risks
  //    only above the size trigger, …), so the gate is always satisfiable by honest annotation.
  //    The absolute tier score is NOT gated: a small module (entry point, zero exports) caps
  //    below `detailed` with every recommended field filled — gating on tier forces padding.
  //    Harness-annotate-only error (zero behavior change for clients).
  //  • consistency: filled fields that contradict graph facts (keyExports/env/declared-pure).
  //    Hard error under harnessStrict && annotationPhase; a warning otherwise, so drift surfaces
  //    in every mode without forcing repo-wide re-annotation.
  // Evaluated for the nodes the run claims to have touched/written (not the whole repo).
  const touched = new Set(
    [...result.graphNodesTouched, ...result.annotationsWritten].map(id => resolveGraphNodeId(graph, id) ?? id),
  );
  const thin: string[] = [];
  const inconsistentHard: string[] = [];
  const inconsistentEnv: string[] = [];
  for (const nodeId of touched) {
    const stored = state.annotations.get(nodeId);
    if (!stored) continue; // unannotated → coverage gate already owns this
    const mod = state.snapshot.modules?.find(m => m.id === nodeId);
    if (!mod) continue; // not a code module (domain/service roll-up) → skip
    const maxLine = mod.exports.reduce((m, e) => Math.max(m, e.lineRange.end), 0);
    const quality = computeAnnotationQuality(stored.annotation, {
      exportCount: mod.exports.length,
      lineCount: maxLine,
      envVars: mod.semanticHints?.envVars,
      moduleKind: inferModuleKind({ mod, node: graph.nodes.get(mod.id) }),
      exportNames: mod.exports.map(e => e.name),
      detectedSideEffectKinds: detectSideEffectKindsFromHints(mod.semanticHints),
    });
    if (quality.missingFields.length > 0) {
      thin.push(`${nodeId} (tier=${quality.tier}, missing: ${quality.missingFields.join('/')})`);
    }
    if (!quality.consistency.ok) {
      // Split hard (keyExports/sideEffects) from advisory env: the env-var detector resolves a name
      // written at the access site, so a computed key, an aliased container, or a name arriving as an
      // argument leaves a declared-but-undetected env dep — a likely detection gap, not annotation
      // drift, and never a hard gate error. Rationale in full: isHardConsistencyIssue.
      const hard = quality.consistency.issues.filter(isHardConsistencyIssue);
      const env = quality.consistency.issues.filter(i => !isHardConsistencyIssue(i));
      if (hard.length > 0) {
        const issueStrings = hard.map(i => `${i.field}:${i.detail}`);
        inconsistentHard.push(`${nodeId} (${issueStrings.join(', ')})`);
        inconsistentAnnotations.push({ nodeId, issues: issueStrings });
      }
      if (env.length > 0) inconsistentEnv.push(`${nodeId} (${env.map(i => `${i.field}:${i.detail}`).join(', ')})`);
    }
  }
  if (harnessStrict && annotationPhase && thin.length > 0) {
    const thinShown = shortenList(thin, 8);
    const sample = thinShown.shown.join('; ');
    const more = omittedNote(thinShown.omitted);
    errors.push(`Annotation is missing recommended fields for touched node(s): ${sample}${more}.`);
    requiredFollowups.push('Fill the listed missing recommended fields and re-run write_annotation until no missing fields remain.');
  }
  if (inconsistentHard.length > 0) {
    const hardShown = shortenList(inconsistentHard, 8);
    const sample = hardShown.shown.join('; ');
    const more = omittedNote(hardShown.omitted);
    const message = `Annotation contradicts graph facts for touched node(s): ${sample}${more}.`;
    if (harnessStrict && annotationPhase) errors.push(message);
    else warnings.push(message);
    requiredFollowups.push('Fix the contradicting keyExports/sideEffects to match the current graph, then re-run write_annotation.');
  }
  if (inconsistentEnv.length > 0) {
    const envShown = shortenList(inconsistentEnv, 8);
    const sample = envShown.shown.join('; ');
    const more = omittedNote(envShown.omitted);
    warnings.push(`Annotation declares env dependencies not detected in graph hints (advisory; env detection may be incomplete) for touched node(s): ${sample}${more}.`);
  }

  // refresh_context must have run when graph-relevant files changed.
  if (result.filesChanged.length > 0 && !result.compliance.refreshContextRun) {
    warnings.push('filesChanged is non-empty but compliance.refreshContextRun=false.');
    requiredFollowups.push('Run refresh_context after code changes so the graph reflects edits.');
  }

  // Requested checks must be reflected in the result.
  for (const check of assignment?.requestedChecks ?? []) {
    if (!RequestedCheckSchema.safeParse(check).success) continue;
    if (check === 'code-review') {
      if (!result.review) {
        errors.push('Requested check "code-review" is missing AgentRunResult.review.');
        requiredFollowups.push(CHECK_FOLLOWUP[check]);
      } else if (result.review.reviewedFiles.length === 0) {
        errors.push('Requested check "code-review" has an empty review.reviewedFiles list.');
        requiredFollowups.push('Record the files reviewed in AgentRunResult.review.reviewedFiles.');
      }
      continue;
    }
    const flag = CHECK_TO_FLAG[check];
    const reflected = flag === 'testsRun'
      ? result.testsRun.length > 0
      : Boolean(result.compliance[flag]);
    if (!reflected) {
      warnings.push(`Requested check "${check}" is not reflected in the result.`);
      requiredFollowups.push(CHECK_FOLLOWUP[check]);
    }
  }

  // Scope: result scope entries outside the assignment scope.
  if (assignment && assignment.scope.length > 0 && result.scope.length > 0) {
    scopeCollisions.push(...collectScopeCollisions(result.scope, assignment.scope));
    if (scopeCollisions.length > 0) {
      warnings.push(`Result scope entries outside the assignment scope: ${scopeCollisions.join(', ')}.`);
      requiredFollowups.push('Confirm out-of-scope changes were intended, or split into a separate assignment.');
    }
  }

  // ContextPack anchors are observable graph claims; scope drift is advisory.
  const validateContextPack = (label: string, pack: NonNullable<AgentRunResult['contextPack']>) => {
    const unresolvedAnchors = pack.resolvedAnchors
      .map(a => a.nodeId)
      .filter(nodeId => !resolveGraphNodeId(graph, nodeId));
    if (unresolvedAnchors.length > 0) {
      unresolvedGraphNodes.push(...unresolvedAnchors);
      errors.push(`${label}.resolvedAnchors nodeId(s) not found in graph: ${unresolvedAnchors.join(', ')}.`);
      requiredFollowups.push('Refresh context and correct ContextPack.resolvedAnchors to canonical node ids.');
    }
    if (assignment && assignment.scope.length > 0) {
      const contextScopeCollisions = collectScopeCollisions(pack.scope, assignment.scope);
      if (contextScopeCollisions.length > 0) {
        warnings.push(`${label}.scope entries outside the assignment scope: ${contextScopeCollisions.join(', ')}.`);
        requiredFollowups.push('Confirm context scope expansion was intended, or split exploration into a separate assignment.');
      }
    }
  };

  if (result.contextPack) validateContextPack('result.contextPack', result.contextPack);
  if (assignment?.priorContext && hasResolvedAnchors(assignment.priorContext)) {
    validateContextPack('assignment.priorContext', assignment.priorContext);
  }

  const priorScope = assignment?.priorContext && isRecord(assignment.priorContext) && Array.isArray(assignment.priorContext.scope)
    ? assignment.priorContext.scope.filter((s): s is string => typeof s === 'string')
    : [];
  if (priorScope.length > 0 && result.scope.length > 0) {
    const drift = collectScopeCollisions(result.scope, priorScope);
    if (drift.length > 0) {
      warnings.push(`Result scope drifted outside priorContext.scope: ${drift.join(', ')}.`);
      requiredFollowups.push('Confirm prior context still covers the run, or collect a new ContextPack for the expanded scope.');
    }
  }

  if (result.architectureAudit) {
    if (!result.compliance.architectureChecked) {
      warnings.push('AgentRunResult.architectureAudit is present but compliance.architectureChecked=false.');
      requiredFollowups.push('Set compliance.architectureChecked=true only after architecture audit tools were used.');
    }
    if (assignment && assignment.scope.length > 0) {
      const auditScopeCollisions = collectScopeCollisions(result.architectureAudit.auditScope, assignment.scope);
      if (auditScopeCollisions.length > 0) {
        warnings.push(`architectureAudit.auditScope entries outside the assignment scope: ${auditScopeCollisions.join(', ')}.`);
      }
    }
    const seenFindingIds = new Set<string>();
    for (const finding of result.architectureAudit.findings) {
      if (seenFindingIds.has(finding.findingId)) {
        warnings.push(`architectureAudit contains duplicate findingId "${finding.findingId}".`);
      }
      seenFindingIds.add(finding.findingId);
      const unresolvedNodes = finding.nodes.filter(nodeId => !resolveGraphNodeId(graph, nodeId));
      if (unresolvedNodes.length > 0) {
        unresolvedGraphNodes.push(...unresolvedNodes);
        errors.push(`architectureAudit finding "${finding.findingId}" references graph node(s) not found: ${unresolvedNodes.join(', ')}.`);
      }
      const proposed = finding.proposedAssignment;
      if (proposed && proposed.scopeExpansion !== true) {
        const outsideAuditScope = collectScopeCollisions(proposed.scope, result.architectureAudit.auditScope);
        if (outsideAuditScope.length > 0) {
          warnings.push(`architectureAudit finding "${finding.findingId}" proposes assignment scope outside auditScope: ${outsideAuditScope.join(', ')}.`);
          requiredFollowups.push('Mark proposedAssignment.scopeExpansion=true or keep proposed work inside the audited scope.');
        }
      }
    }
  }

  if (result.review) {
    if (result.filesChanged.length > 0) {
      errors.push('AgentRunResult.review is present but filesChanged is non-empty; code review runs must be read-only.');
      requiredFollowups.push('Run code review as a separate read-only assignment, or remove review from an implementation result.');
    }
    if (assignment && assignment.scope.length > 0) {
      const reviewedOutOfScope = collectScopeCollisions(result.review.reviewedFiles, assignment.scope);
      if (reviewedOutOfScope.length > 0) {
        warnings.push(`review.reviewedFiles outside the assignment scope: ${reviewedOutOfScope.join(', ')}.`);
      }
    }
    const seriousFindings = result.review.findings.filter(f => f.severity === 'blocker' || f.severity === 'major');
    if (result.review.verdict === 'approve' && seriousFindings.length > 0) {
      errors.push('review.verdict="approve" but blocker/major review findings are present.');
      requiredFollowups.push('Use changes-requested/needs-human, or downgrade/remove serious findings with evidence.');
    }
    if (result.review.verdict === 'approve' && result.review.testReview.coverageAssessment !== 'adequate') {
      errors.push(`review.verdict="approve" but testReview.coverageAssessment="${result.review.testReview.coverageAssessment}".`);
      requiredFollowups.push('Use needs-human/changes-requested or record adequate test coverage evidence.');
    }
    const seriousMissingTests = result.review.testReview.missingTests.filter(
      t => t.severity === 'blocker' || t.severity === 'major',
    );
    if (result.review.verdict === 'approve' && seriousMissingTests.length > 0) {
      errors.push(`review.verdict="approve" but testReview.missingTests contains ${seriousMissingTests.length} blocker/major entr${seriousMissingTests.length === 1 ? 'y' : 'ies'}.`);
      requiredFollowups.push('Use changes-requested/needs-human, or resolve the blocker/major missing tests before approving.');
    }
    const unresolvedReviewNodes = result.review.findings
      .map(f => f.graphNodeId)
      .filter((nodeId): nodeId is string => typeof nodeId === 'string' && !resolveGraphNodeId(graph, nodeId));
    if (unresolvedReviewNodes.length > 0) {
      unresolvedGraphNodes.push(...unresolvedReviewNodes);
      errors.push(`review.findings graphNodeId(s) not found in graph: ${unresolvedReviewNodes.join(', ')}.`);
    }
    const coverage = result.review.testReview.coverageAssessment;
    const hasCoverageExplanation = result.review.testReview.missingTests.length > 0
      || result.review.findings.length > 0
      || result.review.residualRisks.length > 0;
    if ((coverage === 'insufficient' || coverage === 'not-run') && !hasCoverageExplanation) {
      warnings.push(`review.testReview.coverageAssessment="${coverage}" without missingTests, findings, or residualRisks.`);
      requiredFollowups.push('Explain weak review coverage through missingTests, findings, or residualRisks.');
    }
  }

  if (assignment?.contextSession?.sessionId && result.contextSessionId && assignment.contextSession.sessionId !== result.contextSessionId) {
    errors.push(
      `contextSession.sessionId mismatch: assignment "${assignment.contextSession.sessionId}" != result "${result.contextSessionId}".`,
    );
  }

  // Greenfield exemption (harness-level, NOT harness-specific). Context Session
  // Quality measures how well the agent used EXISTING context. On the first pass
  // of a fresh repo there is no prior annotated context to use, so a required
  // session could not fairly be enforced once a validated score is restored.
  // "Prior context" = annotated nodes this
  // run did not itself write; when there are none, context enforcement downgrades
  // to advisory regardless of which harness set required=true. This lets every
  // harness unconditionally request a context session and rely on repovine to not
  // punish a genuine greenfield first iteration.
  // "Prior context" is annotated nodes the RUN did not itself write. `writtenThisRun` only
  // captures the current sub-agent's writes; in a multi-sub-agent run a sibling's writes land in
  // the shared annots store and would read as prior context here. `greenfieldRun` closes that gap:
  // when the run started with no annotations, none on disk are prior — sibling writes included.
  const writtenThisRun = new Set(result.annotationsWritten.map(id => resolveGraphNodeId(graph, id) ?? id));
  const priorAnnotatedCount = Object.keys(state.annotations.getAll()).filter(id => !writtenThisRun.has(id)).length;
  const priorContextAvailable = !input.greenfieldRun && priorAnnotatedCount > 0;
  const contextEnforceable = contextRequired && priorContextAvailable;
  if (contextRequired && !priorContextAvailable && (harnessStrict || result.contextSessionId)) {
    warnings.push(
      input.greenfieldRun
        ? 'Context session enforcement skipped: greenfield run (no annotated context existed at run start).'
        : 'Context session enforcement skipped: no prior annotated context to use (greenfield first pass).',
    );
  }

  // Context Session Quality is opt-in for Agent Protocol v1. When an assignment marks
  // it required, repovine recomputes the report from the session store instead
  // of trusting the agent's optional self-report. Both modes currently emit
  // warnings + requiredFollowups: the weighted score never beat a trivial baseline on
  // outcome-labelled sessions, so the hard gate stays disabled until that bar is met.
  if (contextRequired || result.contextSessionId) {
    if (!result.contextSessionId) {
      const message = 'assignment.contextSession.required=true but result.contextSessionId is missing.';
      if (CONTEXT_QUALITY_HARD_GATE_VALIDATED && harnessStrict && contextEnforceable) errors.push(message);
      else if (contextRequired) warnings.push(message);
      requiredFollowups.push('Call the repovine MCP context tools with a shared contextSessionId and include it in AgentRunResult.');
    } else if (!state.getContextQualityReport) {
      // Environmental, not a quality failure: we cannot read the session store
      // (e.g. compliance ran in a different process than the agent's MCP server).
      // Advisory in all modes — never hard-fail an agent for harness plumbing.
      warnings.push(`Context session quality store is unavailable for contextSessionId "${result.contextSessionId}".`);
      requiredFollowups.push('Run compliance in the repovine MCP/CLI process that can read .repovine/.cache/sessions.');
    } else {
      contextQuality = state.getContextQualityReport(result.contextSessionId, {
        ...(contextPolicy ?? {}),
        mode: enforcementMode,
        assignmentScope: assignment?.scope ?? [],
      });
      const reportMode = contextQuality?.policy.mode ?? enforcementMode;
      const strict = reportMode === 'harness';

      if (!contextQuality) {
        // Session id was declared but no session was recorded under it. This is
        // ambiguous (agent may not have threaded the id, or the provider's MCP
        // server did not persist events where compliance can read them), so it is
        // advisory. A genuinely context-skipping agent is still made observable
        // through NO_RECORDED_EVENTS once an empty recorded session exists.
        warnings.push(`Context session not found: ${result.contextSessionId}.`);
        requiredFollowups.push('Pass the same contextSessionId on repovine MCP calls before handoff validation.');
      } else {
        for (const warning of contextQuality.warnings) {
          warnings.push(warning);
        }
        if (
          CONTEXT_QUALITY_HARD_GATE_VALIDATED
          && strict
          && contextEnforceable
          && !contextQuality.acceptHandoff
        ) {
          errors.push(
            `Context session quality rejected handoff: overall=${contextQuality.overall}, `
            + `reasons=${contextQuality.rejectReasons.join(', ') || 'none'}.`,
          );
        } else if (!contextQuality.acceptHandoff) {
          warnings.push(
            `Context session quality did not accept handoff: overall=${contextQuality.overall}, `
            + `reasons=${contextQuality.rejectReasons.join(', ') || 'none'}.`,
          );
        } else if (contextQuality.belowWarningThreshold) {
          warnings.push(
            `Context session score (${contextQuality.overall}) is below warningThreshold `
            + `(${contextQuality.policy.warningThreshold}); verify code quality because repovine context was weak.`,
          );
        }
        for (const action of contextQuality.requiredFollowups) {
          requiredFollowups.push(action);
        }
        appendAnnotationFollowupsForWeakContext({
          contextQuality,
          result,
          assignment,
          health,
          scan: annotationScan,
          graph,
          requiredFollowups,
        });
        const selfOverall = result.contextQuality?.overall;
        if (typeof selfOverall === 'number' && Math.abs(selfOverall - contextQuality.overall) > 0.02) {
          warnings.push(
            `Self-reported contextQuality.overall (${selfOverall}) differs from repovine recomputed overall (${contextQuality.overall}).`,
          );
        }
      }
    }
  }

  // Provenance gate (annotation grounding): every CODE-MODULE annotation this run claims to have
  // written must be backed by inspection or an edit in the SAME run/session — otherwise an agent
  // can fabricate plausible fields without reading the code (score measures completeness, not
  // correctness). Grounded when the module was edited (filesChanged), explicitly declared
  // (graphNodesTouched), or inspected/mapped in the session (stableAnchors; an `export:` anchor grounds
  // its owning module, but coarse pkg:/domain: anchors deliberately do NOT — that would re-open the
  // cheat of "inspect a package, ground every module in it"). Hard error only under harnessStrict &&
  // annotationPhase, scoped to this run's annotationsWritten; client mode stays advisory. Pre-existing
  // annotations are never re-judged: they never appear in a future run's annotationsWritten.
  if (result.annotationsWritten.length > 0) {
    const anchors = new Set(contextQuality?.aggregates.stableAnchors ?? []);
    const editedModules = new Set(result.filesChanged.flatMap(f => modulesForFile(graph, state.snapshot, f)));
    const declaredTouched = new Set(result.graphNodesTouched.map(id => resolveGraphNodeId(graph, id) ?? id));
    const isGrounded = (nodeId: string): boolean => {
      if (editedModules.has(nodeId) || declaredTouched.has(nodeId) || anchors.has(nodeId)) return true;
      for (const a of anchors) {
        if (a.startsWith('export:') && owningModuleId(a) === nodeId) return true;
      }
      return false;
    };
    for (const rawId of result.annotationsWritten) {
      const nodeId = resolveGraphNodeId(graph, rawId) ?? rawId;
      // Provenance applies to code modules only; domain/service/infra roll-ups are auto-derived.
      if (!state.snapshot.modules?.some(m => m.id === nodeId)) continue;
      if (!isGrounded(nodeId)) ungroundedAnnotations.push(nodeId);
    }
    if (ungroundedAnnotations.length > 0) {
      const ungroundedShown = shortenList(ungroundedAnnotations, 8);
      const sample = ungroundedShown.shown.join(', ');
      const more = omittedNote(ungroundedShown.omitted);
      const message = `Annotation provenance: ${ungroundedAnnotations.length} written code-module annotation(s) were not inspected or edited in this run/session: ${sample}${more}.`;
      if (harnessStrict && annotationPhase) errors.push(message);
      else warnings.push(message);
      requiredFollowups.push('inspect_node each annotated node, or edit its file, in the same contextSessionId before write_annotation.');
    }
  }

  // Carry the health check's own next calls forward, rendered for the report's prose list.
  for (const call of health.nextActions) {
    const action = renderNextCall(call);
    if (!requiredFollowups.includes(action)) requiredFollowups.push(action);
  }

  // A rejected report remains available for review even though the score is
  // advisory. Accepted reports are consumed only after every evidence-backed
  // compliance gate has run.
  if (
    errors.length === 0
    && contextQuality?.acceptHandoff !== false
    && result.contextSessionId
    && state.consumeContextQualitySession
  ) {
    state.consumeContextQualitySession(result.contextSessionId, {
      retain: contextPolicy?.retain === true,
    });
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    runId: result.runId,
    valid: errors.length === 0,
    errors,
    warnings,
    missingFields,
    staleAnnotations,
    orphanedAnnotations,
    missingAnnotations,
    ungroundedAnnotations,
    inconsistentAnnotations,
    unresolvedGraphNodes,
    scopeCollisions,
    requiredFollowups: [...new Set(requiredFollowups)],
    ...(contextQuality ? { contextQuality } : {}),
  };
}

function appendAnnotationFollowupsForWeakContext(input: {
  contextQuality: ContextQualityReport;
  result: AgentRunResult;
  assignment?: AgentAssignment;
  health: ReturnType<typeof validateAnnotationHealth>;
  scan: AnnotationHealthScan;
  graph: RepositoryGraph;
  requiredFollowups: string[];
}): void {
  const weakContext = !input.contextQuality.acceptHandoff || input.contextQuality.belowWarningThreshold;
  if (!weakContext) return;

  const add = (message: string) => {
    if (!input.requiredFollowups.includes(message)) input.requiredFollowups.push(message);
  };

  const scopeHints = [
    ...(input.assignment?.scope ?? []),
    ...input.result.scope,
    ...input.result.graphNodesTouched.map(id => resolveGraphNodeId(input.graph, id) ?? id),
  ];
  const queue = input.scan.rows;
  const touchedHard = queue.filter(item => {
    if (item.status !== 'stale' && item.status !== 'unannotated') return false;
    if (scopeHints.length === 0) return true;
    return scopeHints.some(scope => item.nodeId === scope || item.nodeId.startsWith(`${scope}/`) || scope.startsWith(item.nodeId));
  });
  const touchedDerived = queue.filter(item => {
    if (!isPropagationStaleItem(item)) return false;
    if (scopeHints.length === 0) return true;
    return scopeHints.some(scope => item.nodeId === scope || item.nodeId.startsWith(`${scope}/`) || scope.startsWith(item.nodeId));
  });

  if (input.health.counts.stale > 0 || touchedHard.length > 0) {
    add('Annotations in touched scope are stale or missing; run targeted review and write_annotation before relying on handoff context.');
  }
  if ((input.health.counts.stalePropagation > 0) || touchedDerived.length > 0) {
    add('Propagation-stale annotations remain; clear with refreshImportBaseline or rewrite integrationPoints/dataFlow when upstream contract changed.');
  }
  if (input.health.counts.unannotated > 0 && scopeHints.length > 0) {
    add('Annotation coverage is low in the repo; with weak repovine context, prefer inspect_node + file reads and update annotations in touched scope.');
  }
  add('Repeat the context funnel: search_context(types:["package","module"]) → map_context → inspect_node / analyze_dependencies.');
}

/**
 * Convenience: schema-validate a run result, then (if shaped correctly) run
 * compliance. Used by `repovine agents compliance` / `repovine agents validate-result`,
 * which accept untrusted input.
 */
export function validateAndCheckCompliance(input: {
  result: unknown;
  assignment?: unknown;
  state: ComplianceState;
  manifestName?: string;
  greenfieldRun?: boolean;
}): {
  schema: SchemaValidation<AgentRunResult>;
  assignmentSchema?: SchemaValidation<AgentAssignment>;
  complianceSkipped?: boolean;
  skipReason?: string;
  compliance?: AgentComplianceReport;
} {
  const schema = validateRunResult(input.result);
  let assignmentSchema: SchemaValidation<AgentAssignment> | undefined;
  if (input.assignment !== undefined) {
    assignmentSchema = validateAssignment(input.assignment);
  }
  if (!schema.valid || !schema.value) {
    return {
      schema,
      ...(assignmentSchema ? { assignmentSchema } : {}),
      complianceSkipped: true,
      skipReason: 'result failed schema validation',
    };
  }
  if (assignmentSchema && !assignmentSchema.valid) {
    return {
      schema,
      assignmentSchema,
      complianceSkipped: true,
      skipReason: 'assignment failed schema validation',
    };
  }
  const compliance = checkCompliance({
    result: schema.value,
    assignment: assignmentSchema?.value,
    state: input.state,
    manifestName: input.manifestName,
    greenfieldRun: input.greenfieldRun,
  });
  return { schema, ...(assignmentSchema ? { assignmentSchema } : {}), compliance };
}
