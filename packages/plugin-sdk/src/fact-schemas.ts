import { z } from 'zod';
import { zSemanticHints } from './source-plugin/semantic-hints-schema.js';
import { resourceIdentityProblem } from './plugin/resource-identity.js';
import type { SemanticModuleDelta, SemanticInfraDelta } from './types.js';

/**
 * Producer-output Zod schemas — the boundary validation for UNTRUSTED (config-loaded, `trusted:false`)
 * plugins. A third-party plugin's `extract`/`parse`
 * output is checked against these before the engine assembles it; structurally-broken facts are
 * dropped with a warning instead of corrupting the graph. Built-in (`trusted:true`) plugins skip
 * this — they are covered by the producer law-suite instead.
 *
 * The schemas enforce the REQUIRED shape (so garbage is rejected) but stay `.passthrough()` on
 * nested detail and accept open strings for enums (kind/provider): the goal is to reject malformed
 * output, not to freeze every field — which would re-introduce the schema-coupling the fact boundary
 * exists to avoid. The conformance kit reuses these as its fact gate.
 */

const zLineRange = z.object({ start: z.number(), end: z.number() }).passthrough();

const zImportInfo = z
  .object({
    moduleSpecifier: z.string(),
    resolvedModuleId: z.string().optional(),
    importedNames: z.array(z.string()),
    isTypeOnly: z.boolean(),
    isExternal: z.boolean(),
  })
  .passthrough();

const zReExportInfo = z
  .object({
    moduleSpecifier: z.string(),
    resolvedModuleId: z.string().optional(),
    names: z.array(z.string()).optional(),
    isStar: z.boolean(),
    isExternal: z.boolean(),
  })
  .passthrough();

const zExportInfo = z
  .object({
    name: z.string(),
    // SymbolKind is a closed union internally, but an external plugin may legitimately emit a kind
    // core does not type yet — accept any string and let downstream layers ignore unknowns.
    kind: z.string(),
    lineRange: zLineRange,
    isDefault: z.boolean(),
  })
  .passthrough();

/** One source plugin's per-module semantic output (the engine stamps all mechanical metadata). */
export const zSemanticModuleDelta = z
  .object({
    moduleId: z.string(),
    imports: z.array(zImportInfo),
    exports: z.array(zExportInfo),
    reExports: z.array(zReExportInfo).optional(),
    calls: z.array(z.string()).optional(),
    callsTotal: z.number().optional(),
    semanticHints: zSemanticHints.optional(),
    transient: z.boolean().optional(),
  })
  .passthrough();

/**
 * Resource identity as it arrives from an untrusted parser.
 *
 * Checked with the same predicate the minter uses, so a delta that passes validation is a delta the
 * host can mint an id from — the two cannot drift into a state where a resource validates here and
 * throws there.
 */
const zResourceIdentity = z
  .object({ namespace: z.string(), localKey: z.string() })
  .superRefine((identity, ctx) => {
    const problem = resourceIdentityProblem(identity);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

const zInfraResource = z
  .object({
    id: z.string(),
    kind: z.string(),
    provider: z.string(),
    identity: zResourceIdentity,
    contentHash: z.string(),
    attributes: z.record(z.string(), z.string()),
    envVars: z.array(z.string()).optional(),
    links: z.array(z.string()).optional(),
    triggers: z.array(z.object({}).passthrough()).optional(),
    envRefs: z.array(z.object({}).passthrough()).optional(),
  })
  .passthrough();

/** One IaC parser's semantic output for a document (the engine stamps id/paths/module hash). */
export const zSemanticInfraDelta = z
  .object({
    kind: z.string(),
    resources: z.array(zInfraResource),
  })
  .passthrough();

export type FactValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function joinIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 4)
    .map(i => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
}

/** Validate one untrusted source-plugin module delta. Returns the parsed value or a short reason. */
export function validateSemanticModuleDelta(value: unknown): FactValidationResult<SemanticModuleDelta> {
  const result = zSemanticModuleDelta.safeParse(value);
  if (result.success) return { ok: true, value: result.data as SemanticModuleDelta };
  return { ok: false, error: joinIssues(result.error) };
}

/** Validate one untrusted IaC-parser infra delta. Returns the parsed value or a short reason. */
export function validateSemanticInfraDelta(value: unknown): FactValidationResult<SemanticInfraDelta> {
  const result = zSemanticInfraDelta.safeParse(value);
  if (result.success) return { ok: true, value: result.data as SemanticInfraDelta };
  return { ok: false, error: joinIssues(result.error) };
}
