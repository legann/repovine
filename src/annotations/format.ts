import { z } from 'zod';
import type { AnnotationContent, NodeType, RiskEntry, StoredAnnotation } from '../types.js';
import { isDomainNodeId } from '../graph/node-ids.js';
import { SideEffectSchema } from './side-effect-vocab.js';

export type NormalizedRisk = { text: string; scope: 'local' | 'consumer' | 'boundary' };

const RiskEntrySchema = z.union([
  z.string(),
  z.object({
    text: z.string(),
    scope: z.enum(['local', 'consumer', 'boundary']).optional(),
  }),
]);

export function normalizeRisks(risks: RiskEntry[] | undefined): NormalizedRisk[] {
  if (!risks?.length) return [];
  return risks.map((entry) => {
    if (typeof entry === 'string') return { text: entry, scope: 'local' as const };
    return { text: entry.text, scope: entry.scope ?? 'local' };
  });
}

/**
 * Risks carried at one scope, in stored order. The single reading of "this risk is boundary-scoped":
 * the boundary index used to spell the comparison out again to collect the texts, so a change to
 * what counts as boundary-scoped would have moved the tag without moving the index.
 */
export function risksScoped(
  risks: RiskEntry[] | undefined,
  scope: NormalizedRisk['scope'],
): NormalizedRisk[] {
  return normalizeRisks(risks).filter((risk) => risk.scope === scope);
}

export function hasConsumerScopedRisk(content: AnnotationContent | undefined): boolean {
  return risksScoped(content?.risks, 'consumer').length > 0;
}

/**
 * `scope: "boundary"` marks an off-limits surface — a published contract, frozen migration, or
 * mapping the importer must not edit in place. The structured source for the investigate `boundary`
 * tag, mirroring {@link hasConsumerScopedRisk}.
 */
export function hasBoundaryScopedRisk(content: AnnotationContent | undefined): boolean {
  return risksScoped(content?.risks, 'boundary').length > 0;
}

export function riskEntryTexts(risks: RiskEntry[] | undefined): string[] {
  return normalizeRisks(risks).map((risk) => risk.text);
}

/** Cue words that read as an importer obligation rather than a standing fact. */
const IMPORTER_OBLIGATION_CUE = /\b(import|importer|consumer|caller|call ?site|verify|locally|downstream|must |should )/i;

/**
 * Marking-bar (soft authoring nudge): a `scope: "consumer"` risk should state what the importer
 * must do, not just the standing fact. Returns the consumer-scoped risk texts that read as bare
 * facts (no importer-obligation cue). Advisory only — never a gate.
 */
export function consumerRiskMarkingHints(content: AnnotationContent | undefined): string[] {
  return normalizeRisks(content?.risks)
    .filter((risk) => risk.scope === 'consumer' && !IMPORTER_OBLIGATION_CUE.test(risk.text))
    .map((risk) => risk.text);
}

export interface AnnotationFile {
  version: number;
  annotations: Record<string, StoredAnnotation>;
}

export interface AnnotationHydrationError {
  nodeId: string;
  message: string;
  value: unknown;
}

export const AnnotationContentSchema = z.object({
  summary: z.string(),
  keyExports: z.record(z.string(), z.string()).optional(),
  assumptions: z.array(z.string()).optional(),
  // Forbid empty array on purpose: `[]` is indistinguishable from "I forgot to fill in".
  // Either omit the field entirely, or write [{kind:'pure'}] for an intentional zero-effect
  // declaration, or list the actual effects.
  sideEffects: z.array(SideEffectSchema).min(1, 'sideEffects must not be empty — omit the field, or use [{kind:"pure"}] for declared-pure modules').optional(),
  risks: z.array(RiskEntrySchema).optional(),
  patterns: z.array(z.string()).optional(),
  flowDescription: z.string().optional(),
  invariants: z.array(z.string()).optional(),
  extensionPoints: z.array(z.string()).optional(),
  integrationPoints: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  stateShape: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  dataFlow: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  envDependencies: z.record(z.string(), z.string()).optional(),
  propagationSlice: z.object({
    anchor: z.string(),
    path: z.array(z.string()),
    entrypointId: z.string().optional(),
    reviewedAt: z.string(),
  }).optional(),
});

/** Node types that can carry annotations (excludes root/package). Declared against `NodeType` so a
 *  NodeType rename is a compile error here instead of a silent string drift. */
export const ANNOTATABLE_NODE_TYPES = ['module', 'export-symbol', 'domain', 'runtime-resource', 'template'] as const satisfies readonly [NodeType, ...NodeType[]];

/**
 * Node types that intentionally carry NO annotations: structural/aggregate anchors with no own
 * content to summarize (`root` = the repository itself, `package` = a manifest grouping). Declared
 * as the explicit complement of {@link ANNOTATABLE_NODE_TYPES} so that adding a new `NodeType`
 * forces a deliberate annotate/exempt decision rather than a silent omission — the partition
 * (`ANNOTATABLE ⊎ EXEMPT === NODE_TYPES`) is enforced in `test/laws/annotatable-surface.test.ts`.
 */
export const ANNOTATION_EXEMPT_NODE_TYPES = ['root', 'package'] as const satisfies readonly [NodeType, ...NodeType[]];

export const StoredAnnotationSchema = z.object({
  nodeId: z.string(),
  nodeType: z.enum(ANNOTATABLE_NODE_TYPES),
  contentHash: z.string(),
  pass: z.number(),
  updatedAt: z.string(),
  annotation: AnnotationContentSchema,
  importBaseline: z.record(z.string(), z.string()).optional(),
  schemaVersion: z.number().optional(),
});

const AnnotationFileRawSchema = z.object({
  version: z.number().optional(),
  annotations: z.record(z.string(), z.unknown()),
});

const ANNOTATION_CONTENT_KEY_ORDER: Array<keyof AnnotationContent> = [
  'summary',
  'keyExports',
  'assumptions',
  'sideEffects',
  'risks',
  'patterns',
  'flowDescription',
  'invariants',
  'extensionPoints',
  'integrationPoints',
  'stateShape',
  'dataFlow',
  'envDependencies',
  'propagationSlice',
];

const RUNTIME_ANNOTATION_KEY_ORDER: Array<keyof StoredAnnotation> = [
  'nodeId',
  'nodeType',
  'contentHash',
  'pass',
  'updatedAt',
  'annotation',
  'importBaseline',
  'schemaVersion',
];

const DISK_ANNOTATION_KEY_ORDER: Array<keyof StoredAnnotation> = [
  'contentHash',
  'pass',
  'updatedAt',
  'annotation',
  'importBaseline',
  'schemaVersion',
];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortRecord<T>(record: Record<string, T> | undefined): Record<string, T> | undefined {
  if (!record) return undefined;
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key];
  return out;
}

export function inferAnnotationNodeType(nodeId: string): StoredAnnotation['nodeType'] | undefined {
  if (nodeId.startsWith('mod:') || nodeId.startsWith('infra:')) return 'module';
  if (nodeId.startsWith('export:')) return 'export-symbol';
  if (isDomainNodeId(nodeId)) return 'domain';
  if (nodeId.startsWith('resource:')) return 'runtime-resource';
  if (nodeId.startsWith('template:')) return 'template';
  return undefined;
}

export function canonicalAnnotationContent(content: AnnotationContent): AnnotationContent {
  const source = content as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ANNOTATION_CONTENT_KEY_ORDER) {
    if (!(key in source) || source[key] === undefined) continue;
    const value = source[key];
    out[key] = isPlainRecord(value) ? sortRecord(value) : value;
  }
  return out as unknown as AnnotationContent;
}

export function canonicalAnnotation(annotation: StoredAnnotation): StoredAnnotation {
  const source = annotation as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of RUNTIME_ANNOTATION_KEY_ORDER) {
    if (!(key in source) || source[key] === undefined) continue;
    out[key] = key === 'annotation'
      ? canonicalAnnotationContent(source[key] as AnnotationContent)
      : key === 'importBaseline'
        ? sortRecord(source[key] as Record<string, string>)
        : source[key];
  }
  return out as unknown as StoredAnnotation;
}

export function hydrateAnnotationEntry(nodeId: string, value: unknown): { ok: true; annotation: StoredAnnotation } | { ok: false; error: AnnotationHydrationError } {
  if (!isPlainRecord(value)) {
    return { ok: false, error: { nodeId, value, message: 'entry is not an object' } };
  }

  const explicitType = typeof value.nodeType === 'string' ? value.nodeType : undefined;
  const inferredType = inferAnnotationNodeType(nodeId);
  const candidate = {
    ...value,
    nodeId,
    nodeType: explicitType ?? inferredType,
    pass: 'pass' in value ? value.pass : 1,
    schemaVersion: 'schemaVersion' in value ? value.schemaVersion : 1,
  };
  const result = StoredAnnotationSchema.safeParse(candidate);
  if (!result.success) {
    return {
      ok: false,
      error: {
        nodeId,
        value,
        message: result.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('; '),
      },
    };
  }
  return { ok: true, annotation: canonicalAnnotation(result.data) };
}

export function hydrateAnnotationMap(rawAnnotations: Record<string, unknown>): {
  data: Record<string, StoredAnnotation>;
  quarantine: Record<string, unknown>;
  errors: AnnotationHydrationError[];
} {
  const data: Record<string, StoredAnnotation> = {};
  const quarantine: Record<string, unknown> = {};
  const errors: AnnotationHydrationError[] = [];

  for (const [nodeId, value] of Object.entries(rawAnnotations)) {
    const hydrated = hydrateAnnotationEntry(nodeId, value);
    if (hydrated.ok) {
      data[nodeId] = hydrated.annotation;
    } else {
      quarantine[nodeId] = value;
      errors.push(hydrated.error);
    }
  }

  return { data, quarantine, errors };
}

/**
 * Validate ONLY the outer file shape (a `{ version?, annotations: object }` envelope) and return the raw,
 * un-hydrated annotations map. Returns null when the shape is invalid (e.g. `annotations` is not an object)
 * — distinct from per-entry validation, which is deferred to hydration/quarantine downstream. Used by the
 * save path to decide whether a changed-on-disk file is a mergeable base or must fail closed.
 */
export function parseAnnotationsRawShape(content: string): Record<string, unknown> | null {
  const parsed = AnnotationFileRawSchema.safeParse(JSON.parse(content));
  return parsed.success ? parsed.data.annotations : null;
}

export function parseAnnotationFile(content: string | undefined, label: string): AnnotationFile {
  if (!content || !content.trim()) return { version: 1, annotations: {} };
  const parsed = AnnotationFileRawSchema.safeParse(JSON.parse(content));
  if (!parsed.success) {
    throw new Error(`Invalid annotations file shape: ${label}: ${parsed.error.message}`);
  }

  const hydrated = hydrateAnnotationMap(parsed.data.annotations);
  if (hydrated.errors.length > 0) {
    const first = hydrated.errors[0];
    throw new Error(`Invalid annotation entry (${first.nodeId}) in ${label}: ${first.message}`);
  }

  return {
    version: 1,
    annotations: hydrated.data,
  };
}

function toDiskAnnotation(nodeId: string, value: unknown): unknown {
  const hydrated = hydrateAnnotationEntry(nodeId, value);
  if (!hydrated.ok) return value;

  const source = canonicalAnnotation(hydrated.annotation) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of DISK_ANNOTATION_KEY_ORDER) {
    if (!(key in source) || source[key] === undefined) continue;
    if (key === 'pass' && source[key] === 1) continue;
    if (key === 'schemaVersion' && source[key] === 1) continue;
    out[key] = source[key];
  }
  return out;
}

function stringifyEntry(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 'null' : serialized;
}

export function serializeAnnotationFileFromRaw(file: { version?: number; annotations: Record<string, unknown> }): string {
  const ids = Object.keys(file.annotations).sort();
  if (ids.length === 0) {
    return '{\n  "version": 1,\n  "annotations": {}\n}\n';
  }

  const lines = [
    '{',
    '  "version": 1,',
    '  "annotations": {',
  ];

  ids.forEach((nodeId, index) => {
    const diskValue = toDiskAnnotation(nodeId, file.annotations[nodeId]);
    const comma = index === ids.length - 1 ? '' : ',';
    lines.push(`    ${JSON.stringify(nodeId)}: ${stringifyEntry(diskValue)}${comma}`);
  });

  lines.push('  }', '}', '');
  return lines.join('\n');
}

export function serializeAnnotationFile(file: AnnotationFile): string {
  return serializeAnnotationFileFromRaw(file);
}
