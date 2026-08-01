# repovine Agent Protocol v1 — Integration Guide

repovine is the **contract + validation + projection** layer for verifiable
software development with coding agents. The Engine builds deterministic repo
facts; MCP exposes them during a session; Agent Protocol defines how a completed
run is scoped, reported, and validated.

repovine has three surfaces — one product with three interfaces:

| Surface | Role |
|---|---|
| **Engine** | Deterministic repo facts (syntax, graph, config/runtime surface) plus checked annotation memory. |
| **MCP** | The repo API an agent uses during a session, in an IDE or inside a harness sandbox. |
| **Agent Protocol** | The contract for a completed run: assignment → structured result → compliance report. |

**Agent Protocol** is the harness-facing integration contract inside repovine.
It defines how a development run is assigned, how the agent reports the completed
run, and how repovine validates that report against observable repository state.
The Engine supplies the graph and annotation facts to validate against.

The division of responsibility is:

```text
repovine  Engine + MCP + Agent Protocol (schemas, validators, projections)
Harness   execution + scheduling + enforcement
Agent     reasoning / editing / reviewing during the run
```

The canonical protocol schemas live in `src/agents/protocol.ts`; the validators
that compare returned claims with observable repository state live in
`src/agents/validation.ts`. Example harnesses under `examples/` demonstrate
integration; they consume the protocol schemas and validators shipped with the
package. **No canonical harness implementation ships** — the canonical product
boundary is Agent Protocol over repovine state. `examples/agent-harness-demo` is
one non-canonical integration proof; its LangGraph topology, retries, worktree
isolation, deferred annotation sync, and same-session provider resume are that
demo's own decisions, not protocol requirements.

`explore`, `implement`, and `annotate` are context phases carrying per-phase
honesty and result-shape rules. They do not prescribe scheduler topology: a
harness chooses which phase a leaf runs and whether annotation sync is deferred
to a later `annotate` leaf. repovine re-checks only the claims a result makes
(`annotationsWritten`, `compliance.annotationsClean`) against observable state.

repovine owns repository structure, graph nodes, annotations, config surfaces,
dependency impact, runtime flow, and architecture findings. The harness owns
agent launch, retry, scheduling, isolation, and permissions.

### Client and harness use

MCP is the repository API while an agent works in either an IDE client or a
harness sandbox. Agent Protocol is activated only for an explicit protocol run:
a harness/CI assignment, a protocol validation command, or a direct request for
an `AgentRunResult`. Ordinary client conversations use the host client's normal
summary and do not emit an `AgentRunResult`.

This guide focuses on the harness integration path. The full responsibility
matrix is defined in [DESIGN.md](../DESIGN.md#two-consumption-modes); generated
client guidance is covered in [Projections](#projections).

The public integration shape is:

```text
External Harness
  -> AgentAssignment
  <- AgentRunResult
  -> repovine validates the result + observable repository state
  <- AgentComplianceReport
```

Internal subagent handoffs are an implementation detail behind the aggregated
`AgentRunResult`.

## Protocol objects

| Object | Direction | Purpose |
|---|---|---|
| `AgentProtocol` | repovine → harness | Protocol version, schema ids, CLI commands (`mcpTools` is empty — protocol is CLI-only). |
| `AgentManifest` | repovine → harness | A role repovine can project or validate (tools, expected inputs, required result fields). |
| `ContextPack` | agent → harness / harness → agent | First-class exploration artifact: resolved graph anchors, entrypoints, contracts, notes, assumptions, open questions, and recommended next actions. |
| `ArchitectureAuditResult` | agent → harness/repovine | Triaged architecture findings with status, evidence, affected nodes, and optional proposed implementation assignments. |
| `CodeReviewResult` | agent → harness/repovine | Structured read-only review verdict for a diff, including reviewed files, test coverage assessment, findings, and residual risks. |
| `DeliveryVerificationResult` | agent → harness/repovine | Read-only intent verification: per-criterion status (covered/gap/needs-developer) with graph-grounded repository evidence and a verdict (`intentVerified`, `deliveryAccepted`). |
| `ReviewInput` | harness → code-reviewer | Standalone review payload: the original **implementation** assignment, prior context, implementation result, diff base, changed files, and touched graph nodes. Not a field of `AgentAssignment`. |
| `AgentAssignment` | harness → agent | The scoped request: task, scope, acceptance criteria, constraints, contracts, requested checks, optional context-session policy, optional verification policy (`verificationPolicy`, version matched to `assignment.version`), and optional prior context. |
| `AgentRunResult` | agent → harness/repovine | The aggregated public result: status, files/nodes/contracts touched, tests, annotations, compliance flags, optional context-session id, optional capability artifacts, optional delivery verification (`deliveryVerification`), blockers. |
| `AgentComplianceReport` | repovine → harness | Validation output: errors, warnings, missing fields, stale/orphaned/missing annotations, unresolved nodes, scope collisions, optional context quality report, required follow-ups. |

Internal schema types (`SubagentAssignment`, `SubagentHandoff`) support
subagent coordination behind the aggregated `AgentRunResult`.

Fetch the canonical JSON Schema for every object:

```bash
repovine agents protocol --schemas
```

## Integration steps

1. **Read the protocol and manifests.**
   `repovine agents protocol` / `repovine agents manifests` (CLI).
2. **Build an `AgentAssignment`** for the chosen role. Validate it with
   `repovine agents validate-assignment` before dispatch.
3. **Run the chosen main agent or harness flow.** repovine does not execute it.
4. **Collect the aggregated `AgentRunResult`.** Explicit protocol assignments
   instruct the agent to emit it as a structured block (see "Projections").
5. **Validate the result and compliance.**
   `repovine agents compliance` (schema + compliance gate).
   `repovine agents validate-result` is a schema-only structural check; it never
   builds a graph or runs compliance.
6. **Use `requiredFollowups`** before accepting the run. A run is acceptable
   when the compliance report is `valid: true` and you are satisfied with the
   warnings.

The repository test suite keeps this flow executable without treating a packaged
or canonical harness as the contract: `test/integration/agent-protocol-cli-blackbox.test.ts`
builds repovine and drives `node dist/mcp/index.js agents ...` against the
harness fixtures in `test/fixtures/agent-protocol-harness/`.

## MCP surface (worker)

Worker MCP exposes **context tools only** (search/map/inspect, annotations,
`refresh_context`, `get_context_session_quality`, `get_build_status`, …).
Agent Protocol validation is **not** on `tools/list` — harnesses use the CLI
below. During a run, pass `contextSessionId` on repovine MCP calls; inspect quality
with `get_context_session_quality` or let `repovine agents compliance` recompute it.

## Protocol CLI surface

```bash
repovine agents protocol [--schemas]
repovine agents manifests [--role <role>] [--name <name>]
repovine agents run-brief [--role <role>] [--name <name>]
repovine agents roles [--at <tree-ish>]
repovine agents validate-assignment assignment.json
repovine agents validate-result result.json
repovine agents validate-review-input review-input.json
repovine agents compliance result.json [--assignment a.json] [--manifest <name>] [--greenfield-run]
repovine agents session-quality <sessionId> [--phase explore|implement|annotate] [--mode harness|client] [--threshold n] [--warning-threshold n] [--min-anchors n] [--byte-budget n] [--max-recovery-attempts n] [--events] [--consume] [--retain]
```

`run-brief` returns JSON with `protocolVersion`, `projectionVersion`, `role`,
`name`, and `brief` (the manifest-derived autonomous protocol prompt text; pair
with `compliance` as the post-run gate). Inter-sub-agent handoff policy is a
harness concern and is not part of the protocol surface.

`compliance` takes `--greenfield-run` to mark a run that started with no
annotated context. Under that flag context-session enforcement downgrades to a
warning, so a sibling sub-agent's annotations do not read as prior context.

`roles` returns the repository role source — the `agents.roles` section of
`repovine.config.json` plus each referenced brief, served byte-for-byte with a
sha-256 hash. An absent section is `{"configured": false}`; a malformed section,
an unsafe path, or a brief carrying protocol markers is a structured error (the
loader validates, never transforms). `--at <tree-ish>` reads the config and
briefs from a committed tree via the workspace git — a pinned-revision read for
harnesses that must not consume working-tree edits.

The protocol commands above print JSON on stdout and exit **0** on pass / **1**
on failure so CI and non-MCP harnesses can gate on the exit code.
`session-quality` is the exception: it exits **0** whenever it produced a report,
and reserves **1** for an unknown session id or an invalid `--phase` / `--mode`.
A rejected session is visible in its JSON — `acceptHandoff: false` with
`rejectReasons` — while the score stays advisory. General CLI and non-protocol
`repovine agents` utilities are listed in [scripts.md](scripts.md).

**Client projections and drift** live outside `repovine agents`:

- **Write / refresh:** `repovine setup <client>` — `cursor`, `claude`, `codex`,
  or `all`; without a client, `setup` writes workspace config only.
- **Check drift:** `repovine doctor` (interactive) or `repovine doctor --json` (CI).


## Validation semantics

Validation has two layers.

**Schema validation** — is the artifact shaped correctly? Required fields
present, enum values known, arrays are arrays, `protocolVersion` supported.
Each artifact is parsed on its own; cross-artifact checks belong to compliance.

**Compliance validation** — do the claims hold against observable repovine
state?

- result `runId` matches the assignment `runId` (checked only when an assignment
  is supplied, e.g. `compliance --assignment`);
- declared `graphNodesTouched` resolve to real graph nodes;
- declared `annotationsWritten` exist and are not content/schema stale;
- orphaned annotations are absent or reported;
- `compliance.refreshContextRun` is `true` when `filesChanged` is non-empty;
- requested checks are reflected in `compliance` / `testsRun`;
- when `requestedChecks` contains `code-review`, `AgentRunResult.review`
  must be present with a verdict and reviewed files;
- result `scope` stays within the assignment scope;
- `compliance.annotationsClean` is not claimed while annotation hard checks are
  dirty. Parse/conflict markers, orphaned notes, content/schema-stale work, and
  propagation-stale (`staleKind: propagation`) each block `annotationsClean`.
  `needsWork` counts the backlog rows — unannotated plus stale; conflict markers
  and orphans are counted beside it. Stale work clears via `write_annotation`
  (often `refreshImportBaseline: true` when upstream contract is unchanged),
  conflict markers via `merge_annotations`, orphans via
  `refresh_context({ "cleanupOrphans": true })`.
- declared `annotationsWritten` for code modules are **grounded**: each was
  `inspect_node`-ed or edited (in `filesChanged` / `graphNodesTouched`) in the
  same `contextSessionId` before it was written. A `export:` anchor of the module
  grounds it; coarse `pkg:` / `domain:` anchors deliberately do not (inspecting a
  whole package must not "ground" every module in it). This is an observable
  signal over the run's writes — the same family as "declared nodes must exist
  after `refresh_context`" — and is judged only over the current run's
  `annotationsWritten`, never over pre-existing annotations (which can never
  appear in a future run's `annotationsWritten`, so enabling the gate cannot
  retroactively fail an existing repo). Hard error under harness annotate
  enforcement (`harnessStrict && annotationPhase`); advisory warning in client
  mode;
- annotation **consistency**: filled fields must not contradict hard graph facts —
  for example `keyExports` names absent from the module or declared-`pure`
  `sideEffects` while the graph detects real effects. Recomputed from
  `annotation × current graph`, so drift (e.g. `keyExports` after a refactor)
  surfaces on pre-existing notes too. `quality.score` stays completeness only and
  is unaffected. Hard error under harness annotate enforcement; advisory warning
  otherwise. `envDependencies` mismatches are always advisory because env
  detection can under-capture;
- `ContextPack.resolvedAnchors[].nodeId`, architecture audit nodes, and review
  finding `graphNodeId` values resolve against the graph;
- `priorContext.scope` drift produces a warning so harnesses can decide whether
  a new exploration pass is required;
- declared read-only capability is enforced: when the selected `--manifest`
  declares `canEditFiles=false`, or `assignment.contextSession.phase="annotate"`,
  a non-empty `filesChanged` is an error. Annotation-writer effects are reported
  through `annotationsWritten`, never leaf `filesChanged`;
- code review results are read-only: if `review` is present, `filesChanged`
  must be empty;
- `review.verdict="approve"` is invalid when blocker/major findings exist, when
  test coverage is not `adequate`, or when `testReview.missingTests` contains a
  blocker/major entry;
- when `result.deliveryVerification` is present, its criteria registry is
  re-checked against the assignment `acceptanceCriteria`: each required criterion
  carries exactly one result, `verdict.intentVerified` / `deliveryAccepted` stay
  consistent with the registry, and `filesChanged` is empty (verify is read-only);
- each `covered` criterion cites a `repository` evidence anchor whose `graphNodeId`
  resolves in the built graph; cited evidence kinds stay within the frozen
  `verificationPolicy`, and `assignment.version` matches
  `verificationPolicy.version`. Repository evidence is re-resolved against the
  graph, the diff is the change footprint;
- when `assignment.contextSession.required=true`, repovine recomputes the
  recorded `ContextQualityReport` instead of trusting self-report. Missing,
  unreadable, and rejected sessions currently emit warnings and
  `requiredFollowups` in both modes: the original weighted score failed its
  outcome-labelled falsification, so context quality cannot fail compliance
  until the return bar in `repovine/docs/context-quality.md` is met.
  Evidence-backed annotation and protocol checks remain enforceable;
- `warningThreshold` and `qualityThreshold` / phase `threshold` still shape the
  reported advisory verdict — see `repovine/docs/context-quality.md`;
- `assignment.contextSession.maxRecoveryAttempts` is harness-owned retry
  metadata: repovine validates/echoes it, but the harness counts attempts and
  stops retry loops;
- checked context sessions are consumed after a compliance run with no errors
  unless `assignment.contextSession.retain=true` or global debug retention is
  enabled; a failed report keeps the session retryable.

repovine never reads conversational transcripts. It validates structured claims
plus observable repository state.
Context quality is computed from repovine MCP tool responses and shaped response
byte volume, not from the agent's final prose.

That is the determinism boundary: the model may produce prose while working, but
the acceptance surface is a structured `AgentRunResult` plus optional capability
artifacts. repovine checks schema, graph/annotation/context claims, and
deterministic policy signals; harnesses, tests, CI, and developers decide whether
the actual change is good enough.

## Context session lifecycle

Harnesses may provide the exact id under `assignment.contextSession.sessionId`.
Agents pass it as `contextSessionId` on repovine MCP calls and copy it to
`AgentRunResult.contextSessionId`. Compliance recomputes the recorded report,
consumes a passing session unless retention is enabled, and keeps a failed
session available for retry.

Storage, cleanup triggers, thresholds, scoring, and retention are defined in
[context-quality.md](context-quality.md).

## Capabilities

repovine exposes five capability concepts on both local client and external
harness surfaces.

| Capability | Result artifact | Meaning |
|---|---|---|
| Explore / Context | `contextPack` | What the agent actually learned, suitable as prior context for implementation, architecture audit, or review. |
| Implementation | normal `AgentRunResult` fields | Software change attempted, tests/checks reported, graph/annotations refreshed when needed. Implementation complete does not mean reviewed or merge-ready. |
| Architecture Audit | `architectureAudit` | Read-only triage of architecture candidates into confirmed/suppressed/needs-inspection/accepted-risk findings. |
| Code Review | `review` | Read-only diff review with a structured verdict. repovine validates structure and observable claims, not subjective completeness. |
| Delivery Verification | `deliveryVerification` | Read-only re-check of acceptance criteria into covered/gap/needs-developer with graph-grounded repository evidence and an intent verdict. Covered marks structural completeness; behavioral correctness stays with review. |

If an assignment is provided but fails schema validation, compliance is skipped:
there is no `AgentComplianceReport` to accept, because assignment linkage,
requested checks, and scope cannot be trusted. Harnesses should accept a run only
when `schemaValid === true`, `assignmentSchemaValid !== false`, and
`report.valid === true`.

## Example

`assignment.json`:

```json
{
  "protocolVersion": "1",
  "runId": "run-2026-05-31-001",
  "role": "implementer",
  "task": "Add an audit-log writer to the orders service",
  "scope": ["packages/orders/src"],
  "version": 1,
  "acceptanceCriteria": [
    { "id": "c-audit-row", "statement": "writes one row per order transition", "required": true },
    { "id": "c-tests-pass", "statement": "unit tests pass", "required": true }
  ],
  "constraints": ["no new env vars"],
  "contracts": ["POST /internal/audit"],
  "requestedChecks": ["dependencies", "tests", "annotations"],
  "contextSession": {
    "sessionId": "sess-run-2026-06-01-001",
    "required": true,
    "mode": "harness",
    "phase": "implement",
    "qualityThreshold": 0.55,
    "warningThreshold": 0.7,
    "minAnchors": 1,
    "byteBudget": 120000,
    "maxRecoveryAttempts": 2,
    "retain": false
  }
}
```

`result.json` (what the agent returns and the harness collects):

```json
{
  "protocolVersion": "1",
  "runId": "run-2026-05-31-001",
  "status": "complete",
  "summary": "Added AuditLogWriter and wired it into order transitions.",
  "scope": ["packages/orders/src"],
  "filesChanged": ["packages/orders/src/audit-log-writer.ts", "packages/orders/src/order-service.ts"],
  "graphNodesTouched": ["mod:orders/src/audit-log-writer", "mod:orders/src/order-service"],
  "contractsChanged": ["POST /internal/audit"],
  "testsRun": ["packages/orders: jest audit-log-writer.test.ts"],
  "annotationsWritten": ["mod:orders/src/audit-log-writer"],
  "contextSessionId": "sess-run-2026-06-01-001",
  "contextPack": {
    "scope": ["packages/orders/src"],
    "resolvedAnchors": [
      {
        "nodeId": "mod:orders/src/audit-log-writer",
        "role": "primary",
        "reason": "new writer module"
      }
    ],
    "entrypoints": [],
    "contracts": ["POST /internal/audit"],
    "dependencyNotes": ["order-service imports AuditLogWriter"],
    "configNotes": [],
    "flowNotes": [],
    "architectureSignals": [],
    "assumptions": [],
    "openQuestions": [],
    "recommendedNextActions": ["optional code-review assignment"]
  },
  "compliance": {
    "refreshContextRun": true,
    "annotationsClean": true,
    "dependencyImpactChecked": true,
    "configSurfaceChecked": false,
    "flowChecked": false,
    "architectureChecked": false
  },
  "blockers": []
}
```

Validate:

```bash
repovine agents compliance result.json --assignment assignment.json
```

A clean run returns an `AgentComplianceReport` with `valid: true` and an empty
`errors` array; `requiredFollowups` lists anything to address before acceptance.

## Projections

In **client mode**, the same protocol is projected into IDE-facing assets instead
of a harness round trip. **First time and refresh:** `repovine setup <client>` —
`cursor`, `claude`, `codex`, or `all` (MCP config, hooks, rules, skills, managed
agents, `AGENTS.md` block). Without a client, `setup` writes workspace config only.
Re-run after repovine upgrades or when `repovine doctor` reports projection drift.

Generated client assets (`AGENTS.md`, repovine-managed Cursor / Codex / Claude
utility agents, `sample.project-subagent.*`, and `_TEMPLATE.project-subagent.*`)
are projections of the canonical manifests in `src/agents/manifests.ts`. They
also project the explicit-use rule: an `AgentRunResult` is emitted only when a
harness/CI assignment, validation command, or direct user request activates
Agent Protocol.

- Regenerate projections: `repovine setup <client> --force` (or `repovine setup all --force`).
- Check drift: `repovine doctor` or `repovine doctor --json` (includes `agentAssets` in JSON).

`setup` overwrites only repovine-managed generated agent files. Local specialist
agents copied from the template are repo-owned and are not rewritten.

`setup` writes `AGENTS.md` on one of three branches:

| On-disk file | Result |
|---|---|
| Carries the repovine markers | Marked section replaced, everything outside it kept |
| No markers, opens with the repovine heading | Replaced whole |
| No markers, any other content | Content kept, managed block appended |

`repovine setup <client> --force` bypasses the last branch and overwrites the file.

`repovine doctor` checks governed generated assets for projection drift and scans
local agents for stale or unknown tool names without treating those local files
as governed projections. The scan collects names written in backticks or directly
before an opening parenthesis. A collected name carrying a live or retired
repovine verb family and no registry entry raises a warning.

Markdown prose may surround the structured block, but the block is the contract.

## Code review chain

A harness that wants a merge gate runs implementation and code review as
separate assignments carrying a standalone `ReviewInput`:

```text
implementation assignment
-> AgentRunResult + compliance
-> ReviewInput  (validate-review-input)
-> code-review assignment  (its own runId)
-> AgentRunResult.review
-> harness gates on review.verdict
```

`ReviewInput` is a standalone object, not a field of `AgentAssignment`. Its
`assignment` is the original **implementation** assignment; the code-review
assignment is a separate dispatch envelope with its own `runId`. `implementationResult`
is the implementation aggregate under review.

`repovine agents validate-review-input` enforces schema plus linkage:

| Check | Rule |
|---|---|
| runId linkage | `implementationResult.runId === assignment.runId` |
| changed files | `changedFiles` set-equals `implementationResult.filesChanged` |
| graph nodes | `graphNodesTouched` set-equals `implementationResult.graphNodesTouched` |
| path shape | file entries are repository-relative POSIX — absolute and `..` paths reject |

Path comparison normalizes `\\`→`/`, strips leading `./`, collapses duplicate
separators, then compares stable-sorted unique sets. Graph node ids are
trimmed/deduplicated/sorted; their graph existence is left to result/compliance
validation. The reviewer remains read-only.
