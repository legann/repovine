/**
 * Delivery Protocol projection helpers.
 *
 * The Delivery Protocol (src/agents/*) is canonical. Generated client assets are
 * PROJECTIONS of it. This module renders the protocol-governed pieces that get
 * embedded into onboarding assets:
 *   - a stable marker comment stamping the protocol and projection versions;
 *   - conditional client guidance for explicit Delivery Protocol runs;
 *   - the structured AgentRunResult block harness workers must return.
 *
 * It depends only on the protocol + manifests, never on onboarding-assets, so
 * onboarding-assets can import it without a cycle.
 */
import { PROTOCOL_VERSION, type AgentManifest } from '../agents/protocol.js';
import { getManifest } from '../agents/manifests.js';

/**
 * Projection format version: an opaque cache-busting token embedded in the
 * marker comment every protocol-governed asset carries. `doctor`,
 * `agent-render`, `run-brief`, and `plugin-render` echo it as
 * `projectionVersion` in their results; the plugin renderer also stamps it into
 * the generated note and README. The token is never parsed: doctor compares a
 * managed file against its template byte for byte and reports
 * `stale-managed-content` on any difference, marker included. It guards a purely
 * post-release scenario: a consumer generated assets with one engine version,
 * then upgraded the engine.
 *
 * Pre-release policy: PINNED at '1' and intentionally NOT bumped. Before the
 * first public release there are no external consumers carrying stale generated
 * assets, so every bump only churns this repo's own assets for no benefit. Start
 * versioning this for real at the first release, when upgrade/drift becomes
 * possible. When the embedded contract section changes pre-release, just
 * re-render all assets — do not bump this.
 */
export const PROJECTION_VERSION = '1' as const;

/** Stable marker embedded in every protocol-governed asset, carrying both versions. */
export const DELIVERY_PROTOCOL_MARKER =
  `<!-- repovine:delivery-protocol protocolVersion=${PROTOCOL_VERSION} projection=${PROJECTION_VERSION} -->`;

/** Path of the Delivery Protocol integration guide, relative to the repovine package. */
export const DELIVERY_PROTOCOL_GUIDE_PATH = 'docs/delivery-protocol.md';

/** Canonical example AgentRunResult, matching the harness projection block. */
const EXAMPLE_RUN_RESULT = {
  protocolVersion: PROTOCOL_VERSION,
  runId: '<provided-run-id>',
  status: 'complete',
  summary: '...',
  scope: [],
  filesChanged: [],
  graphNodesTouched: [],
  contractsChanged: [],
  testsRun: [],
  annotationsWritten: [],
  compliance: {
    refreshContextRun: true,
    annotationsClean: true,
    dependencyImpactChecked: true,
    configSurfaceChecked: false,
    flowChecked: false,
    architectureChecked: false,
  },
  blockers: [],
} as const;

/**
 * Role-required result artifacts that the base skeleton does not carry.
 *
 * A field named as required but absent from the example is a trap: the agent copies the
 * skeleton it was shown, and compliance then rejects the result for the field it never saw.
 * Every entry here is a schema-valid placeholder for the shape the role must fill.
 */
const REQUIRED_FIELD_EXAMPLES: Record<string, unknown> = {
  review: {
    verdict: 'approve',
    reviewedFiles: [],
    reviewedDiffBase: '<git ref or prior-sub-agent handoff>',
    criteriaChecked: [],
    testReview: {
      claimedTestsRun: [],
      reviewerTestsRun: [],
      coverageAssessment: 'unclear',
      // One example item pins the object shape — the fields are `behavior`,
      // `suggestedTest`, `severity`; a bare string or `{description}` fails schema
      // validation and the whole result is rejected. Replace or empty this array.
      missingTests: [
        { behavior: '<behavior with no test>', suggestedTest: '<test to add>', severity: 'minor' },
      ],
    },
    // One example finding pins the object shape: `severity`, `summary`, `evidence`,
    // `recommendation` (optional `file`/`line`/`graphNodeId`). Replace or empty this array.
    findings: [
      { severity: 'nit', summary: '<one-line issue>', evidence: '<file:line or graph evidence>', recommendation: '<fix>' },
    ],
    residualRisks: [],
  },
  architectureAudit: {
    auditScope: [],
    categories: [],
    findings: [],
  },
};

/** Enum vocabularies for the artifacts above — a wrong value fails schema validation. */
const REQUIRED_FIELD_ENUM_HINTS: Record<string, string> = {
  review:
    '`review.verdict`: approve | changes-requested | needs-developer | blocked. '
    + '`review.testReview.coverageAssessment`: adequate | insufficient | not-run | unclear. '
    + '`review.findings[].severity`: blocker | major | minor | nit. '
    + 'Merge-blocking findings ALSO belong in top-level `blockers`.',
  architectureAudit:
    '`architectureAudit.findings[].status`: confirmed | suppressed | needs-inspection | accepted-risk. '
    + '`severity`: low | medium | high. `confidence`: 0–1.',
};

/** The structured result block, rendered as a JSON code fence body. */
export function renderStructuredResultBlock(manifest?: AgentManifest): string {
  const artifacts: Record<string, unknown> = {};
  for (const field of manifest?.requiredRunResultFields ?? []) {
    if (field in REQUIRED_FIELD_EXAMPLES) artifacts[field] = REQUIRED_FIELD_EXAMPLES[field];
  }
  return JSON.stringify({ ...EXAMPLE_RUN_RESULT, ...artifacts }, null, 2);
}

/** Enum guidance for the role's required artifacts; empty when the role requires none. */
export function renderRequiredArtifactHints(manifest: AgentManifest): string {
  return manifest.requiredRunResultFields
    .map(field => REQUIRED_FIELD_ENUM_HINTS[field])
    .filter(Boolean)
    .join(' ');
}

/** What repovine re-checks a result against. Shared by the client section and the harness brief. */
const OBSERVABLE_CLAIMS_VALIDATION =
  'repovine validates observable claims: declared graph nodes must exist after `refresh_context`; '
  + 'declared annotations must be fresh after `write_annotation`; `refreshContextRun` must be true when files changed; '
  + 'requested checks must appear in `compliance` / `testsRun`, or as `review` when `code-review` is requested. '
  + 'If the assignment supplies `contextSession.sessionId`, pass it on repovine MCP calls and include it as '
  + '`contextSessionId` in the result. Large explorations may include `contextPack`; architecture audits use '
  + '`architectureAudit`; code reviews use `review`. Never hand-edit `repovine.annots.json`.';

/** H2 heading of the governed result-block section in the harness demo agent briefs. */
export const RESULT_BLOCK_HEADING = 'Delivery Protocol result block';

/**
 * Result-block section for a harness agent brief: the marker, the skeleton the sub-agent must
 * emit — already carrying the role's required artifacts — and the rules repovine re-checks.
 *
 * Governed rather than hand-written, because a copied skeleton drifts from the manifest that
 * grades it: the demo code-reviewer brief shipped a block with no `review` key directly above
 * the line demanding one, and every review run duly omitted the field it was never shown.
 */
export function renderResultBlockSection(manifest: AgentManifest): string {
  const required = manifest.requiredRunResultFields.length > 0
    ? manifest.requiredRunResultFields.map(f => `\`${f}\``).join(', ')
    : '`summary`';
  const artifactHints = renderRequiredArtifactHints(manifest);
  return `${DELIVERY_PROTOCOL_MARKER}

When the run finishes, return a **Delivery Protocol v${PROTOCOL_VERSION} \`AgentRunResult\`** block so the harness (or repovine) can validate it. Prose may surround it, but the structured block is the contract — emit it verbatim and fill the values:

\`\`\`json
${renderStructuredResultBlock(manifest)}
\`\`\`

Required for the \`${manifest.role}\` role: ${required} must be present and non-empty. The block above carries every one of them — keep the keys and fill them with your real work.

Every list field is a flat array of strings. One \`testsRun\` entry is one string ("backend store suite — 14 passed"); an object there fails schema validation and the whole result is rejected before compliance runs.${artifactHints ? `\n\n${artifactHints}` : ''}

${OBSERVABLE_CLAIMS_VALIDATION}

Field reference: \`repovine delivery --schemas\`, or \`${DELIVERY_PROTOCOL_GUIDE_PATH}\` in the repovine source repository.`;
}

/**
 * Client-facing Delivery Protocol guidance embedded into generated agent assets.
 * Normal IDE/client conversations should not emit AgentRunResult JSON; this
 * section describes when the protocol is explicitly active and which fields
 * become required in that mode.
 */
export function renderClientProtocolGuidanceSection(manifest: AgentManifest): string {
  const required = manifest.requiredRunResultFields.length > 0
    ? manifest.requiredRunResultFields.map(f => `\`${f}\``).join(', ')
    : '`summary`';
  return `## Delivery Protocol (explicit use only)

${DELIVERY_PROTOCOL_MARKER}

Normal client conversations are not Delivery Protocol runs. Finish ordinary client work with the host client's normal concise summary, tests, and blockers; do not append an \`AgentRunResult\` JSON block as a session summary.

Only return a **Delivery Protocol v${PROTOCOL_VERSION} \`AgentRunResult\`** when the current task explicitly uses Delivery Protocol: a harness/CI provides an \`AgentAssignment\` or \`runId\`, a command asks for \`validate-result\` / \`compliance\` output, or the user explicitly requests an \`AgentRunResult\`.

When explicit protocol mode is active for the \`${manifest.role}\` role, these fields must be present and non-empty: ${required}.

In explicit protocol mode, ${OBSERVABLE_CLAIMS_VALIDATION}

Annotation quality has three orthogonal axes, so the \`quality.score\` (0–10) means **completeness only — not correctness or trust**. repovine separately validates \`quality.consistency\` (filled fields must not contradict graph facts — e.g. keyExports/env names that do not exist, or declared-\`pure\` while the graph detects side effects) and, as an observable signal over \`annotationsWritten\`, **provenance**: an annotated code module counts as grounded when the SAME \`contextSessionId\` carries an \`inspect_node\`, \`map_context\`, or \`analyze_dependencies\` call that resolved to it (an \`export:\` of it counts; a \`pkg:\`/\`domain:\` does not), when you edited its file, or when you list it in \`graphNodesTouched\`. Those last two channels are your own report; \`write_annotation\` warns whenever the session anchored no call on the node. So inspect the node you annotate in the same session, and never fill a field you cannot back from \`inspect_node\` or source — an empty field beats a fabricated one.

Schema and field reference: \`repovine delivery --schemas\`, or \`${DELIVERY_PROTOCOL_GUIDE_PATH}\` in the repovine source repository.`;
}

/**
 * Main-agent Delivery Protocol section for AGENTS.md. Frames the harness/CI boundary and
 * embeds conditional client guidance for the `main` role.
 */
export function renderMainDeliveryProtocolSection(): string {
  const main = getManifest('main');
  if (!main) throw new Error('agent-projection: no manifest registered for "main"');
  const required = main.requiredRunResultFields.length > 0
    ? main.requiredRunResultFields.map(f => `\`${f}\``).join(', ')
    : '`summary`';
  return `## Delivery Protocol (explicit use only)

${DELIVERY_PROTOCOL_MARKER}

Normal client conversations are not Delivery Protocol runs. Finish ordinary client work with the host client's normal concise summary, tests, and blockers; do not append an \`AgentRunResult\` JSON block as a session summary.

Only return a **Delivery Protocol v${PROTOCOL_VERSION} \`AgentRunResult\`** when a harness/CI provides an \`AgentAssignment\` or \`runId\`, a command asks for \`validate-result\` / \`compliance\`, or the user explicitly requests an \`AgentRunResult\`. For the \`${main.role}\` role, required fields are: ${required}.

In explicit protocol mode, pass \`contextSessionId\` on repovine MCP calls, run \`refresh_context\` after file changes, and never hand-edit \`repovine.annots.json\`; use \`write_annotation\`, \`merge_annotations\`, and \`validate_annotations\` for annotation state. Schema and field reference: \`repovine delivery --schemas\`, or \`${DELIVERY_PROTOCOL_GUIDE_PATH}\` in the repovine source repository.`;
}

/**
 * Single-source HARNESS implementer brief.
 *
 * This is deliberately NOT a client projection: it is the autonomous, enforced
 * brief consumed only by an automated harness
 * where there is no human-in-the-loop reviewer. Client assets (AGENTS.md, the
 * Cursor/Claude/Codex agent files, project-subagent scaffolds) stay human-review
 * toned — do NOT route this text into {@link renderClientProtocolGuidanceSection} or the
 * onboarding scaffolds. Harnesses fetch it via `repovine delivery run-brief`
 * and overlay it on top of whatever (client-toned) role prose they loaded, so the
 * brief lives in exactly one place and the harness never hand-maintains a copy.
 *
 * The difference from the client tone is phase control. `explore`, `implement`,
 * and `annotate` are CONTEXT PHASES, not a mandatory scheduler sequence: which
 * phase a leaf runs, and whether annotation sync is deferred to a later `annotate`
 * leaf or resumed in the same provider session, is the consuming harness's
 * decision — this brief prescribes neither. It fixes only the per-phase honesty
 * and result-shape rules repovine re-checks in `checkCompliance`. An
 * `annotate`-phase leaf is source-read-only and MUST leave zero hard unannotated /
 * content-stale / propagation-stale / orphaned nodes in scope under harness
 * enforcement. Client agents still use the human-review-toned assets and ask
 * before annotation batches.
 */
export function renderImplementerBrief(manifest: AgentManifest): string {
  const required = manifest.requiredRunResultFields.length > 0
    ? manifest.requiredRunResultFields.map(f => `\`${f}\``).join(', ')
    : '`summary`';
  const artifactHints = renderRequiredArtifactHints(manifest);
  return `You are a repovine harness subagent (role: ${manifest.role}). This is an AUTONOMOUS harness run. Follow the assignment phase exactly.

Workflow:
1. ORIENT FIRST via the repovine MCP tools — search_context / map_context / inspect_node — before reading or editing files. If a tool returns result.status:"building", check get_build_status and retry. If a tool returns result.status:"cancelled" (no graph), call refresh_context once to re-trigger a build, then retry; if it stays cancelled, report a blocker.
2. Treat the task as a delta over the current repovine graph. Preserve existing graph-observed behavior, contracts, routes, data shapes, UI flows, docs, and config unless the latest user task explicitly asks to remove or replace them. Message history is intent memory; the graph is product truth. If assignment contracts or prior handoffs conflict with the graph, preserve the graph and report the conflict/blocker instead of silently narrowing the product. Annotations hint and constrain; they do not bound inspect scope. Locality: annotation on nodeId X is evidence about X only — not other nodeIds, including mod: refs in integrationPoints, links, or drillDown. Absence: no annotation and no inspect_node on a nodeId means no conclusion about that node. Unchanged: stating a nodeId is unchanged, verified, or already-correct requires inspect_node on that nodeId in this session. Closure: before leaving related nodes unedited, follow links, navigation, and task-relevant integrationPoints mod: refs. Boundary or discovery tasks inspect the affordance-class consumers/importers before treating them unchanged — breadth is the task; refactor or architecture tasks bound closure with one analyze_dependencies impact pass and need not inspect every ref. Investigate channel: a reference returned with investigate (tags risk/boundary/effect/wiring/co-change/hub — consumer-scoped risk, off-limits boundary surface, persistent side effect, runtime wiring, an implements relation, or many importers) is must-inspect — inspect that node and close each delivered flag as fixed or scoped-out with a code citation before reporting this node unchanged. Enumerate-before-unchanged: reviewing an in-scope node means listing each mutation affordance, exported action, and protected side effect on it with its capability gate (affordanceCount reports how many); a single gated affordance does not close a multi-affordance node. The investigate flags and affordanceCount are floors, not ceilings — their absence is not absence of work, and closing every delivered flag or enumerating one node is per-node completeness, not task completeness. A derived capability, permission, or feature flag is consumed at mount and render predicates and importers, not only the hook that derives it — boundary tasks inspect those consumers. Weak context: while confidence is low, gaps is non-empty, or emptyDiagnostic is present, the scope is not complete. When inspected nodes have annotations, derive annotation obligations from relevant \`invariants\`, \`risks\`, \`dataFlow\` / \`flowDescription\`, \`integrationPoints\`, and \`sideEffects\` before editing: must preserve required behavior/contracts, must verify flow/integration/parity checks, mitigate/test/accept known risks, and inspect surfaces such as entrypoints, dependencies, config, protected side effects, external I/O, or privileged runtime dispatches before changing behavior. After editing, close each relevant obligation as satisfied by code, covered by tests, scoped out with a code citation for a different behavior class, or blocker/unresolved. A risk in the same behavior class as the requested fix is not closeable as verified or already-correct; accepted requires explicit user sign-off in this session. When reporting which nodeIds were left unchanged, verified, or already-correct, each such nodeId must have inspect evidence in this session; on boundary/discovery tasks an integrationPoints mod: ref that consumes the affordance needs inspect before you report it unchanged. Unclosed relevant obligations belong in blockers or partial compliance, not routine residual risk.
3. If assignment.contextSession.phase is "annotate": do NOT edit code. Use the existing provider conversation context plus the current graph to finish repovine annotation sync only:
   a. refresh_context — rebuild the graph for already-reviewed edits.
   b. get_annotation_status({ "view": "queue", "scope": "<your scope>" }) — drain unannotated/content-stale/propagation-stale nodes in scope (propagation-stale is in needsWork).
   c. inspect_node EACH node before you annotate it, threading the SAME contextSessionId. This is mandatory, not optional: a write_annotation on a node you did not inspect (or edit) in this session is REJECTED as ungrounded — score measures completeness, not that you read the code. An export: of the module grounds it; a pkg:/domain: does not.
   d. write_annotation on EVERY new or significantly changed node, to the \`detailed\` tier (summary + the kind's recommendedFields + any high-signal sideEffects/risks/invariants). Declare zero side effects with [{ "kind": "pure" }] — never an empty array. After each write, read the returned quality.consistency.issues and FIX any contradiction (keyExports/sideEffects names that do not match the graph) before moving on — never fabricate a field to fill it.
   e. refresh_context({ "cleanupOrphans": true }) — drop annotations whose nodes were deleted/renamed.
   f. validate_annotations — confirm checks are clean (no content-stale, propagation-stale, orphaned, or conflict markers). If it reports riskScopeCandidates, treat them as advisory authoring candidates, not proof: inspect the node/source before rewriting; if accepted, use write_annotation to preserve the risk text and add scope, and if rejected leave it local (no suppression state in v1).
   Set compliance.annotationsClean=true ONLY when needsWork is 0 for your scope and validate_annotations passes.
4. Otherwise this is an implementation/review phase:
   a. Edit files under the current working directory to satisfy the task, staying inside scope.
   b. After any edit, run refresh_context so the graph reflects your files.
   c. Report annotation state honestly for the phase you were given. Whether annotation sync runs in this phase or is deferred to a separate annotate-phase leaf is the harness's scheduling decision, not a protocol rule — this brief neither requires nor forbids write_annotation in an implement phase. Whatever you report is re-checked against the graph: annotationsWritten lists ONLY node ids you actually wrote (they must exist and be fresh after write_annotation), and compliance.annotationsClean=true only when annotation checks are clean for your scope. If your harness defers annotation sync to a later phase, set annotationsClean=false and leave annotationsWritten empty (\`[]\`).
5. FINALLY, output exactly ONE fenced \`\`\`json code block — with nothing after it — containing a Delivery Protocol v1 AgentRunResult:

\`\`\`json
${renderStructuredResultBlock(manifest)}
\`\`\`

Required for the \`${manifest.role}\` role: ${required} must be present and non-empty. The block above shows every one of them — fill each with your real work, and keep the keys.

Every list field is a flat array of strings: \`scope\`, \`filesChanged\`, \`graphNodesTouched\`, \`contractsChanged\`, \`testsRun\`, \`annotationsWritten\`, \`blockers\`. One \`testsRun\` entry is one string ("backend store suite — 14 passed"). An object there fails schema validation and the whole result is rejected.${artifactHints ? `\n\n${artifactHints}` : ''}

Context session (when the assignment provides contextSession.sessionId): pass that id as \`contextSessionId\` on EVERY repovine MCP call so repovine can score how well you used the EXISTING graph, and set \`contextSessionId\` to the same value in your AgentRunResult. repovine automatically does not penalize a greenfield first pass (a repo with no prior annotated context), so on later iterations this is where using the accumulated graph pays off.

Honesty rules. repovine re-checks the first four against the graph and the annotation store; the rest it takes from your report, so they hold only because you keep them:
- refreshContextRun MUST be true if you changed any file.
- annotationsWritten MUST list the node ids you actually wrote (they must exist and be fresh after write_annotation).
- annotationsClean=true is honest only when annotation checks are clean for your scope; when your harness defers annotation sync to a later phase, annotationsClean=false with an empty annotationsWritten is the honest value.
- In annotate phase, filesChanged MUST be [] and annotationsWritten must list the nodes you wrote. graphNodesTouched MUST list those same annotated node ids (you inspect_node each before writing) — this grounds the annotations; a written node absent from graphNodesTouched reads as ungrounded.
- contractsChanged MUST describe your delta, not a replacement product spec. Mark removals/narrowing clearly and only when the user explicitly requested them; otherwise preserve existing graph-observed contracts. Nothing reads this field back, so its accuracy is yours alone.
- Set dependencyImpactChecked / configSurfaceChecked / flowChecked / architectureChecked true ONLY for checks the assignment requested AND you actually performed. Compliance checks that a requested check carries its flag; a flag set for a check nobody asked for is not caught.
- Report ONLY files and node ids you truly touched. An invented node id is rejected against the graph; a file path is not — nothing opens the filesystem to confirm it.
- graphNodesTouched carries canonical ids COPIED from a tool response (refresh_context / map_context / inspect_node). Never compose an id by hand from a file path. The bundled source plugins exclude their conventional test/spec files and test directories by default, but filtering is plugin-specific, so verify absence in a tool response. Package identity also comes from plugin markers, not package.json alone: a workspace root with tsconfig.json or pyproject.toml may have a pkg: node. A file the graph does not return belongs in filesChanged only.`;
}

/** Context Session Quality guidance embedded in AGENTS.md. */
export function renderContextQualityGuidance(): string {
  return `Context Session Quality scores repovine MCP responses, not agent prose. Pass \`contextSessionId\` on MCP calls and inspect with \`get_context_session_quality\`; harnesses recompute via \`repovine delivery compliance\`. The score and its thresholds are advisory until the labelled-corpus return bar in \`docs/context-quality.md\` is met; evidence-backed annotation checks remain enforceable.`;
}
