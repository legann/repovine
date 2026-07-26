import { z } from 'zod';
import { CONTEXT_ENFORCEMENT_MODES, CONTEXT_PHASES } from '../agents/protocol.js';
import { ANNOTATION_CONSUMER_RISK_AUTHORING, ANNOTATION_INVESTIGATE_CLOSURE } from '../cli/onboarding-assets.js';
import { REFACTORING_CATEGORIES, type RefactoringCategory } from '../analysis/architecture/types.js';

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodObject<Record<string, z.ZodType>>;
}

const ScopeSchema = z
  .string()
  .optional()
  .describe(
    'Scope to inspect. Supports all, domain:<name>, pkg:<name>, mod:<id>, export:<id>, resource:<id>, template:<path>, query:<text>, short aliases like "auth", package suffixes like pkg:client-ui, and path-like module aliases. '
    + 'Mechanical name noise is forgiven when the match is unambiguous: pkg: ignores a leading npm "@"; for python-discovered packages -/_/. are interchangeable (PEP 503; npm/TS names never cross-match by separators); resource:/infra: accept the bare resource name or label without the provider infix (resource:MyFunction).',
  );

const LimitSchema = z
  .number()
  .int()
  .min(1)
  .max(200)
  .optional()
  .describe('Max items to return. Default depends on the tool, usually 10-20.');

const OffsetSchema = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('Pagination offset. Default 0.');

const DepthSchema = z
  .number()
  .int()
  .min(0)
  .max(10)
  .optional()
  .describe('Graph traversal depth. Default depends on the tool, usually 1-2.');

const IncludeSchema = z
  .array(z.string())
  .optional()
  .describe('Optional sections to include. Tools ignore unknown include values.');

const ResponseFormatSchema = z
  .enum(['concise', 'debug'])
  .optional()
  .describe('Response shape override: concise = compact output, debug = full envelope.');

const ContextSessionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/)
  .optional()
  .describe('Context-quality session id from the harness; pass on every call to score returned context.');

const RequiredSessionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/)
  .describe('Context quality session id created by the main agent/harness.');

const NodeTypeSchema = z.enum(['domain', 'package', 'module', 'export-symbol', 'runtime-resource', 'template', 'entrypoint', 'config']);
const SearchMatchSchema = z.enum(['auto', 'and', 'or']);

const EntryKindSchema = z.enum([
  'page',
  'route',
  'api',
  'webhook',
  'queue-consumer',
  'schedule',
  'websocket',
  'cli',
  'worker',
  'test',
  'unknown',
  'all',
]);

const LayerSchema = z.enum(['frontend', 'backend', 'infra', 'all']);

const DependencyModeSchema = z.enum([
  'impact',
  'package-boundaries',
  'import-map',
  'interface-implementations',
  'callgraph',
]);

const DependencyDirectionSchema = z.enum(['imports', 'exports', 'both']);

const ConfigKindSchema = z.enum([
  'env',
  'secret',
  'resource',
  'resource-binding',
  'public-config',
  'iac-param',
  'all',
]);

const ConfigGroupBySchema = z.enum(['name', 'module', 'service', 'resource']);

// Derived from the engine's single source of truth so the tool's advertised category filter can
// never drift from the detectors' RefactoringCategory union — adding a category in one place is
// enough. (Previously a hand-maintained duplicate list with no guard.)
const RefactoringReportCategorySchema = z.enum(
  REFACTORING_CATEGORIES as [RefactoringCategory, ...RefactoringCategory[]],
);

const AnnotationStatusViewSchema = z.enum(['coverage', 'queue', 'derived-review', 'propagation-preview', 'orphans', 'risk-scope-candidates', 'carrier-gaps', 'all']);

const baseToolDefs: ToolDef[] = [
  {
    name: 'search_context',
    description:
      'Find likely repository context for a task. Searches domains, packages, modules, exports, templates, services, entrypoints, and config names. ' +
      'Use this when the task is still fuzzy or starts from a keyword/symbol. Combines a deterministic token index with optional local embeddings over graph node cards when semantic_search_embeddings is enabled. ' +
      'Multi-token queries default to match auto: AND (every token on one node) first, then bounded OR per token when AND finds nothing. ' +
      'emptyDiagnostic appears only when totalResults is 0 and there are no config/entrypoint aux matches — not when OR-relax produced hits. ' +
      'When hits exist after OR-relax, read result.matches.strategy (used, relaxedFrom, strongTokens, weakTokenOnlySuppressed), gaps, topResults[].matchedTokenCount/score, and summary/confidence before inspect_node. ' +
      'When topResults[].annotationMatched is true, annotation fields are omitted — use inspect_node on that nodeId before source-only reasoning. ' +
      'Weak/common tokens (package, route, handler, module, …) match at reduced weight; auto may suppress OR noise via weakTokenOnlySuppressed. ' +
      'A semantic-only nearest neighbour has low confidence, no matched tokens, and an advisory suggestedScope reason; it is not evidence that the requested functionality exists. ' +
      'When perTokenLimit truncates an OR posting list before global ranking, strategy.postingLists and gaps expose each affected token and considered/total counts, and confidence is low. ' +
      'Responses include matchedTokens, strategy.semantic.used/attempted, semanticRank/semanticScore on fused hits, suggestedScopes, navigation, and emptyDiagnostic reasons such as no_token_hits, strict_and_no_single_node, weak_token_only_suppressed, type_filter_excluded.',
    schema: z.object({
      query: z.string().describe('Task keyword, feature name, symbol, route, package, config name, or other search text.'),
      types: z.array(NodeTypeSchema).optional().describe('Optional result type filter.'),
      match: SearchMatchSchema.optional().describe(
        'Token matching strategy. auto (default): AND first, then bounded OR — OR hits set strategy.relaxedFrom:"and" and omit emptyDiagnostic; weak-only OR noise may set weakTokenOnlySuppressed with emptyDiagnostic. '
        + 'and: every token must match one node; partial token hits → totalResults:0 and emptyDiagnostic strict_and_no_single_node. '
        + 'or: union capped per-token candidates (may return noise on weak tokens like package/route/handler). Default auto.',
      ),
      perTokenLimit: z.number().int().min(1).max(100).optional().describe('Max OR candidates considered per query token before final ranking. Default scales with limit, capped at 100.'),
      limit: LimitSchema,
      offset: OffsetSchema,
      include: IncludeSchema,
    }),
  },
  {
    name: 'map_context',
    description:
      'Map the architectural area for a scope before reading code. Returns domain/package/module context, top connected modules, subdomains, semantic summary, and navigation. ' +
      'Use this after search_context or when the user names a feature/package/module directly. Empty/unresolved maps include emptyDiagnostic with reason and conditional nextActions.',
    schema: z.object({
      scope: ScopeSchema,
      view: z.enum(['summary', 'modules', 'path']).optional().describe('Map shape to prefer. Default summary.'),
      include: IncludeSchema,
      limit: LimitSchema,
      offset: OffsetSchema,
    }),
  },
  {
    name: 'inspect_node',
    description:
      'Inspect one graph node in detail. For modules it returns exports/signatures/line ranges/annotations; for exports it returns signature/calls and can include source body. ' +
      'Use this only after narrowing context. The response points deeper, sideways, up, cross-layer, and validation paths. ' +
      'Annotations hint and constrain; they do not bound inspect scope — no annotation means no pre-written checklist, not skip. ' +
      'Stating a nodeId is unchanged requires inspect_node on that nodeId in the same session; annotation on another nodeId is not evidence for it. ' +
      'A derived capability, permission, or feature flag is consumed at mount/render predicates and importers, not only the hook that derives it; on boundary tasks inspect those consumers before treating them unchanged. '
      + `${ANNOTATION_INVESTIGATE_CLOSURE} `
      + 'When annotations are returned, treat relevant invariants, risks, dataFlow/flowDescription, integrationPoints, and sideEffects as verification obligations: must preserve, must verify, known risk, or surface to check before editing. '
      + 'References in links or drill_down may carry an investigate tag (risk/boundary/effect/wiring/co-change/hub) — the target holds a consumer-scoped risk, a boundary-scoped risk (off-limits surface), a persistent side effect, runtime wiring (deployed topology dispatches into or binds from it), an implements relation (contract and implementations move together), or many importers; investigatePointers surface the same flags for a deeper dependency named in this node\'s integrationPoints, and are must-inspect under the same closure; affordanceCount reports how many affordances/exports the node has to enumerate. '
      + 'The response may also carry a top-level attention block — the same open obligations hoisted for primacy as data plus the cheapest next call, never a gate.',
    schema: z.object({
      nodeId: z.string().optional().describe('Node id to inspect. Preferred for module/export-symbol/runtime-resource/template/domain inspection.'),
      scope: ScopeSchema,
      includeBody: z.boolean().optional().describe('Include source body for a module or export. Default false.'),
      bodyOffset: z.number().int().min(0).optional().describe('Character offset for body pagination.'),
      bodyLimit: z.number().int().min(1).max(50_000).optional().describe('Max body characters. Default 12000; hard max 50000.'),
      grepBody: z.string().optional().describe('Regex to search inside the node body with context lines.'),
      exportOffset: z.number().int().min(0).optional().describe('Pagination offset for child/export entries. Default 0.'),
      exportLimit: z.number().int().min(1).max(100).optional().describe('Max child/export entries to return. Default 20.'),
      includePrivate: z.boolean().optional().describe('For class exports, include private/protected members.'),
      includeInternals: z.boolean().optional().describe('For large function exports, include internal declarations.'),
      include: IncludeSchema,
    }),
  },
  {
    name: 'get_entrypoints',
    description:
      'List execution entrypoints independent of stack: pages, routes, APIs, webhooks, queue consumers, schedules, websockets, CLI commands, workers, tests, and unknown starts. ' +
      'Routes are just one entrypoint kind; provider/runtime details are returned as metadata instead of being baked into the tool name. Prefer package, module, service, or query scopes for runtime lookup; domain scopes are semantic/path tags and may be empty. Empty results include emptyDiagnostic with reason and conditional nextActions.',
    schema: z.object({
      scope: ScopeSchema,
      kind: EntryKindSchema.optional().describe('Entrypoint kind to filter. Default all.'),
      kinds: z.array(EntryKindSchema).optional().describe('Entrypoint kinds to filter. Overrides kind when provided.'),
      layer: LayerSchema.optional().describe('Optional layer filter. Default all.'),
      limit: LimitSchema,
      offset: OffsetSchema,
      include: IncludeSchema,
    }),
  },
  {
    name: 'trace_flow',
    description:
      'Trace runtime/data flow through modules, services, resources, triggers, and entrypoints. Use this for cross-layer questions: UI to API, API to queue, queue to worker, worker to DB/resource, and request routing (e.g. ingress to backend service, surfaced as routesTo/routedFrom on a service). ' +
      'The tool reports only graph-proven links and lists gaps when a transition cannot be proven. When scope includes annotated runtime resources or secret-linked bindings, runtimeHandoff lists handler modules (mod:) to inspect before editing code - annotations and consumer/boundary obligations live on code nodes, not on resource listings alone. ' +
      'Prefer service or package scopes; domain scopes only work when the domain directly owns runtime services/resources. Empty results include emptyDiagnostic with reason and conditional nextActions.',
    schema: z.object({
      scope: ScopeSchema,
      from: z.string().optional().describe('Optional starting node/entrypoint/service id.'),
      include: z.array(z.enum(['services', 'resources', 'flows', 'entrypoints'])).optional().describe('Runtime sections to include. Default services/resources/flows.'),
      limit: LimitSchema,
      offset: OffsetSchema,
    }),
  },
  {
    name: 'analyze_dependencies',
    description:
      'Analyze import/export contracts and dependency risk. Replaces impact, cross-package dependencies, interface implementations, and import-map style queries. ' +
      'Use before changing exported APIs, types, package boundaries, interfaces, or shared modules. Empty or mode/scope-mismatch results include emptyDiagnostic with reason and conditional nextActions. ' +
      'impact on an export-symbol scope (or a module scope plus exportName) resolves reverse callers: precise resolved-import callers carry uses; callers matched by call name carry unresolved:true (spans re-export barrels), reported via nameMatchedCallers. The name index is capped per declaration at extraction, so it is a completeness backstop, not grep parity — the response reports the cap in nameMatchLimits. ' +
      'impact, interface-implementations, and package-boundaries cap every returned list and paginate with total/nextOffset; page the rest with offset/limit. Oversized results are withheld behind a responseTruncated marker with narrowing guidance.',
    schema: z.object({
      scope: ScopeSchema,
      mode: DependencyModeSchema.optional().describe('Dependency analysis mode. Default impact for module/export-symbol scopes, package-boundaries otherwise. mode callgraph requires an export-symbol scope, or a module scope plus exportName.'),
      direction: DependencyDirectionSchema.optional().describe('imports, exports, or both. Default both.'),
      exportName: z.string().optional().describe('Filter impact to consumers of a specific export. Required when mode is callgraph and scope is a module.'),
      interfaceName: z.string().optional().describe('Required for mode interface-implementations unless scope names an interface.'),
      depth: DepthSchema,
      limit: LimitSchema,
      offset: OffsetSchema,
    }),
  },
  {
    name: 'get_config_surface',
    description:
      'Inspect configuration and resource-binding surface: env vars, secrets, public config, IaC params, and code-to-resource bindings. ' +
      'Use before adding config, changing resource names, or debugging hidden runtime coupling. Empty results include emptyDiagnostic with reason and conditional nextActions.',
    schema: z.object({
      scope: ScopeSchema,
      kind: ConfigKindSchema.optional().describe('Config kind to filter. Default all.'),
      kinds: z.array(ConfigKindSchema).optional().describe('Config kinds to filter. Overrides kind when provided.'),
      namePattern: z.string().optional().describe('Case-insensitive regex for config/resource names.'),
      groupBy: ConfigGroupBySchema.optional().describe('How to group the result. Default name.'),
      limit: LimitSchema,
      offset: OffsetSchema,
      include: IncludeSchema,
    }),
  },
  {
    name: 'analyze_architecture',
    description:
      'Run architecture analysis for a scope or expand one finding. This is read-only and heuristic: treat findings as review candidates. ' +
      'Use after context mapping or when the user asks for smells, risks, duplicated responsibilities, security-sensitive boundaries, frontend state/effect issues, or event boundaries. Empty reports or missing finding detail include emptyDiagnostic with reason and conditional nextActions. ' +
      'Report mode previews each finding\'s nodes (nodeCount/truncatedNodes when capped); pass detailFindingId for the full maxNodes-bounded node set.',
    schema: z.object({
      scope: ScopeSchema,
      mode: z.enum(['report', 'detail']).optional().describe('report returns findings; detail expands a findingId. Default report.'),
      findingId: z.string().optional().describe('Finding id to expand when mode is detail.'),
      detailFindingId: z.string().optional().describe('Alias that expands a finding without also passing mode: detail.'),
      categories: z.array(RefactoringReportCategorySchema).optional().describe('Optional category filter for report mode. duplicate-like, god-module and authorization-policy-drift each fired on a clean-code counterexample, so they run only when named here.'),
      annotationReasoning: z.enum(['off', 'on']).optional().describe('Attach annotation context packets for the agent to judge as verification obligations, not background prose. Default off.'),
      includeComponentEntrypoints: z.boolean().optional().describe('For deep frontend flow-convergence analysis. Default false.'),
      limit: z.number().int().min(1).max(30).optional().describe('Maximum report findings. Default 12, hard maximum 30; narrow scope/categories for more.'),
      maxNodes: z.number().int().min(1).max(100).optional().describe('Max affected node summaries in detail mode. Default 30.'),
    }),
  },
  {
    name: 'get_annotation_status',
    description:
      'Report annotation build health: coverage, stale/missing annotation queue, and orphaned annotations. Use before annotation work or when trusting graph notes. '
      + 'The default queue is ONE unified, bottom-up backlog spanning annotatable node types — code modules, templates, services, infra (IaC), and domain roll-ups. '
      + 'Queue sort order: content-stale (staleKind:content) before propagation-stale (staleKind:propagation), then unannotated; within each tier, modules/templates before domain roll-ups and lower dependency depth first. '
      + 'Drain via view:"queue" top pages — do not run propagation-first via derived-review unless content-stale is cleared or orchestrator requests propagation-only. '
      + 'view:"risk-scope-candidates" pages advisory plain/local risk entries that look like scope:"consumer" or scope:"boundary" authoring candidates; they are not stale items and do not affect needsWork. '
      + 'view:"carrier-gaps" pages missing-carrier-link candidates grouped by consumer-risk SSOT target, with per-target riskHash and reviewed/suppression state from .repovine/carrier-review.json; reviewed targets stay visible, never filtered. '
      + 'Propagation-stale is in needsWork as stale+staleKind:"propagation". '
      + 'Annotation work is complete when needsWork is 0 for every type.',
    schema: z.object({
      scope: ScopeSchema,
      view: AnnotationStatusViewSchema.optional().describe('coverage; queue (default drain — content-stale before propagation-stale); derived-review (propagation-only filter, not first pass); propagation-preview (requires from); orphans; risk-scope-candidates (advisory plain/local risk scope candidates); carrier-gaps (missing-carrier-link candidates grouped by SSOT target with reviewed state); or all. Default coverage.'),
      staleKind: z.enum(['content', 'propagation']).optional().describe('For queue view: filter to one staleKind. Default queue already ranks content before propagation.'),
      from: z.string().optional().describe('For propagation-preview: module node id of the changed upstream module.'),
      includeDomains: z.boolean().optional().describe('For propagation-preview: include path-domain ids affected. Default false.'),
      includeAllDomains: z.boolean().optional().describe('For coverage view, include paged per-domain breakdown. Default false.'),
      includeLightweight: z.boolean().optional().describe('Include lightweight domains in anomalies. Default false.'),
      limit: LimitSchema,
      offset: OffsetSchema,
    }),
  },
  {
    name: 'get_annotation_merge_status',
    description:
      'Check whether repovine.annots.json exists, is parseable, contains conflict markers, or has an unmerged git index entry. ' +
      'Use before annotation work and after pull/merge/rebase. indexUnmerged marks a file-level conflict (or a hand-resolved file) that carries no markers.',
    schema: z.object({}),
  },
  {
    name: 'merge_annotations',
    description:
      'Resolve conflict markers in repovine.annots.json using annotation merge rules. ' +
      'Different node IDs are combined, compatible annotation fields are merged, and ambiguous scalar fields are reported for review. ' +
      'Scalar conflicts add patterns such as merge-review:summary plus [merge-review:…:ours/theirs] assumptions for a later write_annotation rewrite. ' +
      'This only writes repovine.annots.json unless dryRun is true.',
    schema: z.object({
      dryRun: z.boolean().optional().describe('Preview the annotation merge without writing repovine.annots.json. Default false.'),
      fromIndex: z.boolean().optional().describe(
        'Merge the git index stages when the index is unmerged but the file carries no conflict markers '
        + '(file-level conflict such as a binary/-merge attribute, modify/delete, or an already hand-resolved file). '
        + 'The replaced worktree file is backed up first. Default false.',
      ),
    }),
  },
  {
    name: 'validate_annotations',
    description:
      'Validate repovine.annots.json against the current graph after annotation-file merge, especially after pull/merge/rebase, or before handoff. Reports conflict markers, parse problems, orphaned notes, content-stale and propagation-stale notes, riskScopeCandidates advisory counts, carrierLinkGaps candidates (runtime 2-hop delegation, minus targets suppressed via decline_advisory kind "carrier-link-gaps"), and annotation queue next actions.',
    schema: z.object({
      limit: LimitSchema,
      scope: z.union([z.string(), z.array(z.string())]).optional().describe(
        'Optional sub-agent scope (e.g. backend, frontend, infra). When set, validation also reports needsWorkInScope and scopedClean for that scope only.',
      ),
    }),
  },
  {
    name: 'write_annotation',
    description:
      'Write or update an annotation for a module, export, template, domain, or service. Shared memory write path after understanding or changing code. ' +
      'Existing fields are merged; send only fields that changed. New notes require annotation.summary; empty updates and obvious secret values are rejected. ' +
      'For code modules, every write snapshots importBaseline (direct import contentHashes) for propagation-stale detection. ' +
      'To clear propagation-stale without changing prose, pass refreshImportBaseline: true (optional annotation fields for audit trail in assumptions). ' +
      'On success, result.submittedAnnotation reports submitted text size (chars, estimatedTokens ~chars/4; heuristic, not LLM billing). ' +
      'result.quality.score is COMPLETENESS only (how many fields), not correctness or trust; result.quality.consistency reports filled fields that contradict graph facts (keyExports/env names absent from the module, declared-pure while the graph detects effects). ' +
      'Do not fill a field you cannot back from inspect_node or source — an empty field beats a fabricated one; inspect the node in the same contextSessionId before writing (the harness checks that provenance over annotationsWritten).',
    schema: z.object({
      nodeId: z.string().describe('Node id to annotate.'),
      annotation: z.record(z.string(), z.unknown()).optional().describe(`Annotation object. New notes must include summary; updates may include only changed fields. Optional: assumptions, sideEffects, risks (string or { text, scope?: "local"|"consumer"|"boundary" }), invariants, dataFlow, keyExports, etc. ${ANNOTATION_CONSUMER_RISK_AUTHORING} Omit when using refreshImportBaseline alone on an existing module note.`),
      refreshImportBaseline: z.boolean().optional().describe('When true on an existing code-module annotation, re-snapshot direct import contentHashes to clear propagation-stale. Blocked when hard consistency issues exist.'),
      durable: z.boolean().optional().describe('When true, wait for the annotation to be flushed to disk before responding (result.persistence.persisted). Default false: the write is stored in memory and persisted by an 800ms debounced save. Use on the final write of a session.'),
      propagationSlice: z.object({
        anchor: z.string(),
        path: z.array(z.string()),
        entrypointId: z.string().optional(),
        reviewedAt: z.string(),
      }).optional().describe('Optional audit trail for entrypoint-bounded derived review (anchor module, path to entrypoint, reviewedAt ISO timestamp).'),
    }),
  },
  {
    name: 'refresh_context',
    description:
      'Build or refresh the repository syntax index after code changes. Acts as a synchronization barrier. '
      + 'The response reports graph deltas, annotation orphan status, searchTokens (token+annotation index size), '
      + 'semanticSearch ({ status: disabled|up_to_date|updated|failed, embedded?, total?, error? }) when semantic_search_embeddings is enabled, '
      + 'and domainsSuggestions ({ count, axes, declinedHidden }) for first-run domains advisor follow-up. '
      + 'annotationMergeKeeps ({ readded, reverted, sample, warning }) appears when the reload kept in-memory notes the '
      + 'file disagreed with — the shape a reverted repovine.annots.json produces, which is otherwise undone silently. '
      + 'outsideRepo ({ count, sample, warning }) appears when the build refused files that name an in-repo path but '
      + 'resolve outside the repository through a symlink; those files are absent from the graph. get_build_status '
      + 'reports the same block for the first build. '
      + 'Pass reloadConfig: true after editing repovine.config.json to re-read config and rebuild with a fresh runtime; '
      + 'pass cleanupOrphans: true to remove orphaned annotations after rebuild. '
      + 'After get_build_status({ cancel: true }) left the server in status:"cancelled" (no graph), refresh_context re-triggers a fresh background build and returns the building status.',
    schema: z.object({
      reloadConfig: z
        .boolean()
        .optional()
        .describe('If true, re-read repovine.config.json, replace the MCP runtime, and rebuild using the new config.'),
      cleanupOrphans: z
        .boolean()
        .optional()
        .describe('If true, remove orphaned annotations after rebuilding. Default false; refresh only reports cleanup navigation.'),
      orphanNodeType: z
        .enum(['all', 'domain', 'module', 'runtime-resource', 'template', 'export-symbol'])
        .optional()
        .describe('Optional orphan cleanup/report filter. Default all.'),
    }),
  },
  {
    name: 'suggest_domains_config',
    description:
      'Return additive graph-derived suggestions for repovine.domains.json. This tool is read-only: it reports additions, counts, merge strategy, declined-hidden count, a mergedConfig preview (accept = exclude), and, when an infra-noise suggestion is keepable, a keepConfig preview (keep = a committed infra.keep marker that keeps the resource visible and stops the suggestion). '
      + 'Agents should show the diff to the user and only write repovine.domains.json after approval (mergedConfig to accept, keepConfig to keep), then call refresh_context. To skip without committing, call decline_advisory({ "kind": "domains-config" }) instead.',
    schema: z.object({}),
  },
  {
    name: 'decline_advisory',
    description:
      'Record declined advisory items in workspace-local state so they stop resurfacing; the advisory producers stay read-only. '
      + 'kind "domains-config": hide suggestion ids from suggest_domains_config in .repovine/onboarding-state.json; never writes the committed repovine.domains.json. '
      + 'kind "carrier-link-gaps": record reviewed-not-a-gap decisions per consumer-risk SSOT target in .repovine/carrier-review.json; each decision stores a riskHash of the target\'s consumer-scoped risks — a changed risk set re-surfaces the target; validate_annotations reports suppressedTargets and view:"carrier-gaps" keeps reviewed targets visible; never writes repovine.annots.json. '
      + 'Declines are workspace-local (not committed) — triage does not travel with clones. Pass ids from the kind\'s advisory surface, or all: true to decline every currently visible item. reason is stored per target for carrier-link-gaps and ignored for domains-config.',
    schema: z.object({
      kind: z.enum(['domains-config', 'carrier-link-gaps']).describe('Which advisory to decline: domains-config suggestions or carrier-link gap targets.'),
      ids: z.array(z.string()).optional().describe('Ids to decline: suggestion ids from suggest_domains_config (domains-config), or consumer-risk SSOT target node ids from the carrier-gaps view (carrier-link-gaps).'),
      all: z.boolean().optional().describe('If true, decline every currently visible item of this kind.'),
      reason: z.string().optional().describe('Optional review note; persisted per target for carrier-link-gaps, ignored for domains-config.'),
    }),
  },
  {
    name: 'get_context_session_quality',
    description:
      'Return the deterministic Context Session Quality report for a contextSessionId/sessionId recorded from repovine MCP tool responses. '
      + 'The report is computed from returned tool JSON and shaped response byte volume, not from agent prose. Use before accepting a subagent handoff. '
      + 'overall is an observation, not a graded assessment: shipped weights reduce it to 1 when the session called inspect_node and 0 otherwise, because the former 14-weight score failed its outcome-labelled falsification. '
      + 'acceptHandoff and rejectReasons are advisory in every mode, including harness — they emit warnings and requiredFollowups and never fail compliance. docs/context-quality.md states the return bar a hard gate must clear first.',
    schema: z.object({
      sessionId: RequiredSessionIdSchema,
      phase: z.enum(CONTEXT_PHASES).optional().describe('Policy phase override. Default explore.'),
      mode: z.enum(CONTEXT_ENFORCEMENT_MODES).optional().describe('Enforcement mode override. Selects warning wording and followups; both modes are advisory until the documented return bar is met.'),
      qualityThreshold: z.number().min(0).max(1).optional().describe('Override minimum overall score for acceptHandoff.'),
      warningThreshold: z.number().min(0).max(1).optional().describe('Override soft score threshold for advisory warnings.'),
      minAnchors: z.number().int().min(0).optional().describe('Override minimum stable anchors required for acceptHandoff.'),
      byteBudget: z.number().int().min(1).optional().describe('Override shaped-response byte budget for acceptHandoff.'),
      maxRecoveryAttempts: z.number().int().min(0).max(10).optional().describe('Harness-owned retry budget to echo in the policy report; repovine does not count retry attempts across assignments.'),
      assignmentScope: z.array(z.string()).optional().describe('Assignment scope for audit/report context.'),
      includeEvents: z.boolean().optional().describe('Include full per-call metrics/events. Default false.'),
      consume: z.boolean().optional().describe('Delete the stored session after returning the report, unless retained. Default false.'),
      retainSession: z.boolean().optional().describe('Keep the stored session even when consume=true. Useful for debug.'),
    }),
  },
  {
    name: 'get_build_status',
    description:
      'Report the current build status of the repository graph. Use when other tools return a `result.status:"building"` payload to discover the current stage, remaining stage count, progress, and recommended retry delay. stageEtaSec estimates only the current stage, not time until ready. Stage 1 reports package/module counts; stage 3 reports semantic search embed card counts when `semantic_search_embeddings` is enabled. Always callable; returns immediately by default. Pass waitSec to long-poll: the call holds server-side and returns the moment the build settles (ready or failed) or the wait expires — one waiting call instead of a polling loop. Pass cancel:true to stop an in-flight startup build (mutating): Stage 1 worker threads terminate at the next package boundary and the response is the post-cancel status — `cancelled` (bare tree, no graph; tools then return a cancelled payload, not an error) when no prior graph exists, or `ready` when a prior graph keeps serving. cancel ignores waitSec and is a no-op returning the current status when no build is running.',
    schema: z.object({
      waitSec: z
        .number()
        .int()
        .min(1)
        .max(120)
        .optional()
        .describe('Long-poll: hold the request up to this many seconds, returning early as soon as the build settles. Prefer one waitSec call over repeated polling. Capped at 55s server-side (below the MCP SDK client 60s default request timeout, so the wait cannot outlive the request and get auto-cancelled).'),
      cancel: z
        .boolean()
        .optional()
        .describe('Mutating: stop the in-flight startup build. Stage 1 worker threads terminate at the next package boundary; the response is the resulting status (`cancelled` with no graph, or `ready` when a prior graph keeps serving). Ignores waitSec; no-op when no build is running.'),
    }),
  },
];

export const toolDefs: ToolDef[] = baseToolDefs.map(def => ({
  ...def,
  schema: def.schema.extend({
    responseFormat: ResponseFormatSchema,
    contextSessionId: ContextSessionIdSchema,
  }) as ToolDef['schema'],
}));

const toolDefsByName = new Map(toolDefs.map(d => [d.name, d]));

export function getToolDef(name: string): ToolDef | undefined {
  return toolDefsByName.get(name);
}

/** Extract required argument names from a Zod schema. */
export function getRequiredArgs(def: ToolDef): string[] {
  const shape = def.schema.shape;
  const required: string[] = [];
  for (const [key, fieldSchema] of Object.entries(shape)) {
    if (!fieldSchema.isOptional()) {
      required.push(key);
    }
  }
  return required;
}
