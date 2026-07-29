import { z } from 'zod';
import type { SemanticHints } from '../types.js';

/**
 * semanticHints v1 — versioned schema for the `SemanticHints` slot of `ModuleInfo`.
 *
 * Why this exists: `semanticHints` is the real coupling surface between source plugins (which write
 * it) and core/interpreter consumers (which read it). The Zod schema documents that shape and
 * catches producer bugs (`validateSemanticHints`).
 *
 * Versioning decision: a SINGLE schema version, exposed as the module-level constant
 * `SEMANTIC_HINTS_VERSION` rather than a per-slot namespace and rather than a field embedded in every
 * emitted object. The version is a property of the schema, not of each instance — keeping it out of
 * the data means adding it changes no graph/MCP output (the migration invariant). Bump it when this
 * schema changes incompatibly; a per-slot namespace stays available for the future if a single slot
 * needs to evolve independently.
 *
 * Strictness decision: the object is `.passthrough()`. Unknown top-level slots survive validation so
 * a source plugin can feed a slot an interpreter reads (e.g. `semanticHints.graphql`) before core
 * knows about it — this is what keeps interpreters framework-general. Known slots still have their
 * shape validated, so a structurally-broken known slot (e.g. `routes: "x"`) is caught.
 */
export const SEMANTIC_HINTS_VERSION = '1' as const;
export type SemanticHintsVersion = typeof SEMANTIC_HINTS_VERSION;

const zLineRange = z.object({ start: z.number(), end: z.number() });

const zRouteInfo = z
  .object({
    path: z.string(),
    component: z.string(),
    declaredIn: z.enum(['code', 'layout']).optional(),
    syntax: z.enum(['markup', 'table', 'decorator', 'call']).optional(),
    kind: z.enum(['frontend', 'api']).optional(),
    method: z.string().optional(),
    framework: z.string().optional(),
    fileType: z.string().optional(),
  })
  .passthrough();

const zConditionalRender = z
  .object({
    component: z.string(),
    condition: z.string(),
    renderedIn: z.string(),
    lineRange: zLineRange,
  })
  .passthrough();

const zRuntimeAction = z
  .object({
    action: z.enum(['sqs.sendMessage', 'sns.publish', 'eventbridge.putEvents', 'lambda.invoke']),
    envVar: z.string().optional(),
    lineRange: zLineRange.optional(),
  })
  .passthrough();

const zSecuritySignal = z
  .object({
    kind: z.enum([
      'secret-env',
      'public-env',
      'browser-storage',
      'browser-storage-sensitive',
      'cookie-access',
      'validation',
      'authz',
      'source-disclosure',
    ]),
    name: z.string().optional(),
    callee: z.string().optional(),
    target: z.string().optional(),
    lineRange: zLineRange.optional(),
  })
  .passthrough();

const zSsrMarkers = z
  .object({
    // Load-bearing JS directives — read across module-kind/refactoring. Must stay boolean.
    useServer: z.boolean().optional(),
    useClient: z.boolean().optional(),
    getServerSideProps: z.boolean().optional(),
    getStaticProps: z.boolean().optional(),
    getInitialProps: z.boolean().optional(),
    loader: z.boolean().optional(),
    action: z.boolean().optional(),
    qwikServer: z.boolean().optional(),
    // v1 framework-general runtime markers (additive; see SsrMarkers in types.ts).
    runsOn: z.enum(['server', 'client']).optional(),
    dataLoader: z.boolean().optional(),
  })
  .passthrough();

const zEffectImport = z.object({ kind: z.string(), source: z.string() }).passthrough();

/**
 * `ui` is the JavaScript detail slot (component trees, lifecycle effects, …). It is validated
 * loosely on purpose: only that it is an object. The `Ui*` types describe what a producer may emit,
 * not what this schema checks — over-constraining the rich UI shape would add brittleness without
 * protecting any interpreter consumer. The slots that carry values across ecosystems are `envVars`,
 * `effectImports` and `webFramework`; `docs/plugin-authoring.md` holds the per-slot reach.
 */
const zUiHints = z.object({}).passthrough();

export const zSemanticHints = z
  .object({
    hasRoutes: z.boolean().optional(),
    routes: z.array(zRouteInfo).optional(),
    conditionalRenders: z.array(zConditionalRender).optional(),
    envVars: z.array(z.string()).optional(),
    runtimeActions: z.array(zRuntimeAction).optional(),
    ui: zUiHints.optional(),
    security: z.array(zSecuritySignal).optional(),
    ssr: zSsrMarkers.optional(),
    effectImports: z.array(zEffectImport).optional(),
    // Open string: any framework value is accepted (Spring, ASP.NET, …) without a core-type change.
    webFramework: z.string().optional(),
  })
  .passthrough();

export type ZSemanticHints = z.infer<typeof zSemanticHints>;

export type SemanticHintsValidationResult =
  | { ok: true; value: SemanticHints }
  | { ok: false; error: string };

/**
 * Validate a `semanticHints` value against the v1 schema: returns the parsed value on success, or a
 * short joined issue string on failure. Catches source-plugin producer bugs.
 */
export function validateSemanticHints(value: unknown): SemanticHintsValidationResult {
  const result = zSemanticHints.safeParse(value);
  if (result.success) return { ok: true, value: result.data as SemanticHints };
  const issues = result.error.issues
    .slice(0, 3)
    .map(i => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
  return { ok: false, error: issues };
}
