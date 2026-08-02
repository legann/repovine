---
name: repovine-review
description: "Review or audit a change with repovine context: code review, architecture, tests, and residual risk"
---

# Review and Audit

Use this skill when the user asks for a review, merge-readiness check, implementation validation, architecture audit, refactoring triage, or security-sensitive boundary audit. This is a read-only workflow: do not edit files, update snapshots, write annotations, or change the workspace.

Use the managed `repovine-code-reviewer` agent for read-only implementation/diff reviews. Use the managed `repovine-architecture-auditor` agent for architecture smells, boundaries, frontend state/effect problems, event-driven boundaries, and security-sensitive risks. The main agent uses this skill to gather the packet, choose the repovine checks, delegate when useful, and format the verdict.

## Inputs to gather

- Assignment/task, acceptance criteria, and contracts.
- Diff base, changed files, and touched graph nodes.
- Implementation result if available: `AgentRunResult`, tests run, compliance flags, contextPack/contextSessionId.
- Any known baseline failures, flaky tests, unavailable env/resources, or CI evidence.

If the diff base or task is missing and cannot be inferred safely, ask a short clarification before reviewing.

## Choose the Review Path

| User asks for | Use |
|---|---|
| Code review, diff review, merge readiness, acceptance validation | `repovine-code-reviewer` or local read-only review |
| Architecture smells, duplication, low cohesion, god modules | `repovine-architecture-auditor` with `analyze_architecture` |
| Package/domain boundaries or service wrappers | `analyze_architecture` + `analyze_dependencies` |
| Frontend state, effects, routes, design-system leakage, client policy | `analyze_architecture` with frontend categories and `includeComponentEntrypoints: true` when needed |
| Event-driven or runtime/resource boundaries | `trace_flow` + `analyze_architecture` |
| Security-sensitive boundaries | `analyze_architecture` security categories + `get_config_surface` |
| Missing annotation memory or unclear ownership | `get_annotation_status` + `analyze_architecture({ "categories": ["unclear-architecture", "annotation-risk"] })` |

## Diff Review Workflow

1. Establish the review packet:

```bash
git status --short
git diff --name-only
git diff --stat
```

Use a requested base when supplied, for example `git diff --name-only main...HEAD`. For staged-only reviews, use `git diff --cached --name-only`.

2. Refresh/read repository context without modifying project files:

```json
refresh_context({})
search_context({ "query": "<changed feature, route, package, symbol, or resource>" })
inspect_node({ "nodeId": "mod:<changed-node>" })
validate_annotations({})
```

For changed nodes with annotations, derive annotation obligations from `invariants`, `risks`, `dataFlow` / `flowDescription`, `integrationPoints`, and `sideEffects`, then compare the diff against them.

- Read `annotationMeta.fresh` on each of those nodes first: a note with `staleReason: "propagation"` still describes this node, but its `integrationPoints`/`dataFlow` claims about upstream modules are unverified and are leads to check against the upstream, not evidence; `content` means the node text moved under the note, and `no-baseline` that the note was written with no hash to compare against, so nothing was ever compared, so no field of it is evidence for the current code — except on a domain roll-up, which has no text: there `content` means a member moved, and what needs re-checking is the note's account of the member set.
- A violated must-preserve invariant is a review finding.
- A must-verify flow, integration, or parity obligation without evidence is a review finding.
- A known risk in the same behavior class as the requested fix is not a residual risk unless the user explicitly accepted it.
- Execution-order changes must be checked against annotated data flow and protected side effects.
- Missing tests for a touched invariant/risk belong in the test review.

3. Add targeted checks by risk axis:

```json
analyze_dependencies({ "scope": "mod:<changed-node>", "mode": "impact", "depth": 2 })
get_config_surface({ "scope": "<changed-scope>" })
trace_flow({ "scope": "<changed-scope>", "include": ["entrypoints", "services", "resources", "flows"] })
analyze_architecture({ "scope": "<changed-scope>", "mode": "report", "limit": 8 })
```

Flow and architecture narrow to different scope kinds. `trace_flow` takes `all`, `resource:`, `mod:`, `pkg:`, `domain:` and `query:`. `analyze_architecture` takes `all`, `pkg:`, `domain:`, `mod:` and `resource:`. Both refuse `export:`, `template:` and `infra:` by name; `query:` is refused by architecture alone. A `mod:` or `resource:` scope holds one node, so per-node signals are reported and `gaps` names the comparisons that granularity rules out.

Use only relevant checks. Shared exports/types need dependency impact; env/resources need config surface; API/webhook/queue/worker changes need runtime flow; structural/boundary changes may need architecture candidates.

4. Evaluate tests:

- Compare implementation tests to acceptance criteria and changed behavior.
- Rerun relevant tests only when practical and read-only.
- Do not update snapshots/golden outputs during review.
- If rerun is skipped, record why in residual risks.
- Treat missing behavior coverage as a review finding.

## Architecture Audit Workflow

1. Narrow the scope before reporting:

```json
search_context({ "query": "feature, package, domain, route, component, service, resource, or config name" })
map_context({ "scope": "chosen-scope", "view": "summary", "limit": 10 })
```

2. Add the axis context that makes findings interpretable:

```json
get_entrypoints({ "scope": "chosen-scope" })
trace_flow({ "scope": "chosen-scope", "include": ["entrypoints", "services", "resources", "flows"] })
analyze_dependencies({ "scope": "chosen-scope", "mode": "package-boundaries" })
get_config_surface({ "scope": "chosen-scope" })
```

Use only the calls that match the question. Runtime/resource findings need flow; shared API findings need dependency impact; env/resource findings need config surface.

3. Run a scoped architecture report:

```json
analyze_architecture({
  "scope": "pkg:package-name",
  "mode": "report",
  "categories": ["boundary", "god-module"],
  "annotationReasoning": "on",
  "limit": 12
})
```

Omitting `categories` runs the default set. `duplicate-like`, `god-module` and `authorization-policy-drift` fired on clean-code counterexamples and run only when named — ask for them by name when duplication, god modules or authorization drift is the question. Use `includeComponentEntrypoints: true` only when investigating deep frontend flow convergence.

4. Expand one finding before recommending code movement:

```json
analyze_architecture({
  "scope": "pkg:package-name",
  "detailFindingId": "category:exact-finding-id",
  "maxNodes": 30
})
```

Follow returned `navigation.deeper`, `sideways`, `crossLayer`, and `validate` suggestions before reading broadly when present.

All MCP tools accept `responseFormat: "concise" | "debug"`. Prefer concise; use debug only for full payloads. Concise navigation may return refs like `"$3x9a1"`. The server keeps the 500 most recently issued and drops the oldest beyond that, so reuse a ref while it is recent, or expand it from `refs` — a dropped ref is passed through as the literal `$…` and fails to resolve. For context-quality runs, pass the provided `contextSessionId` on repovine calls and inspect with `get_context_session_quality`.

5. Validate with focused context before reporting:

```json
inspect_node({ "nodeId": "mod:pkg/path/module" })
analyze_dependencies({ "scope": "mod:pkg/path/module", "mode": "impact", "depth": 3 })
trace_flow({ "scope": "domain-or-service", "include": ["entrypoints", "services", "resources", "flows"] })
get_config_surface({ "scope": "domain-or-package" })
```

## Delegation

If using `repovine-code-reviewer`, pass an explicit review packet:

```text
Use repovine-code-reviewer for a read-only review.
assignment: <task / acceptance criteria / contracts>
priorContext: <contextPack if available>
implementationResult: <AgentRunResult if available>
diffBase: <base ref or working tree>
changedFiles: <files>
graphNodesTouched: <node ids if known>
requested checks: dependencies/config/runtime-flow/architecture/tests as relevant
```

The reviewer should return a `review` object. If you review locally, produce the same structure in prose or in `AgentRunResult.review` when a Delivery Protocol result is required.

If using `repovine-architecture-auditor`, pass an explicit audit packet:

```text
Use repovine-architecture-auditor for a read-only architecture audit.
question: <architecture, boundary, security, frontend state/effect, or refactoring question>
scope: <domain/package/module/service/query>
categories: <optional analyze_architecture categories>
priorContext: <contextPack if available>
must verify with: dependencies/config/runtime-flow/entrypoints/tests as relevant
```

The auditor should return an `architectureAudit` object. If you audit locally, produce the same structure in prose or in `AgentRunResult.architectureAudit` when a Delivery Protocol result is required.

## Verdict guidance

- `approve`: no blocker/major findings, claimed/rerun tests are credible, and coverage is adequate.
- `changes-requested`: defect, regression, failed relevant test, broken contract, or material missing test.
- `needs-developer`: baseline/flaky/environmental uncertainty prevents a trustworthy automated verdict.
- `blocked`: missing diff, assignment, context, or test setup prevents review. When the assignment requested `code-review`, compliance still requires a non-empty `review.reviewedFiles`, so name what you did read.

## Report format

Lead with findings, ordered by severity, with file/line or graph node references when possible. Then include:

- verdict
- files reviewed
- annotation constraints checked
- tests claimed/rerun/skipped
- repovine checks run
- residual risks
- whether the review was delegated to `repovine-code-reviewer`
- whether an architecture audit was delegated to `repovine-architecture-auditor`

Never claim review completeness; report what was checked and what remains uncertain. Do not present `analyze_architecture` findings as proof; say what was verified and what remains a hypothesis. Detector behavior is configured by `analyze_architecture.strictness` and `analyze_architecture.thresholds.*` in `repovine.config.json`.
