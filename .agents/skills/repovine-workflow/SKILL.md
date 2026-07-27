---
name: repovine-workflow
description: "Main-agent implementation playbook: scope repo changes with repovine, choose the risk axis, verify after edits; delegation policy lives in the client-native orchestration policy"
---

# Development Workflow

Use this skill when implementing a change and the project-specific conventions are not encoded in a local skill yet.

repovine does not decide how this repository should build backend, frontend, or infrastructure code. It gives the agent a repeatable way to understand the repository before changing it, then verify the result after editing.

## Relationship to Subagent Orchestration

This workflow scopes a repo change and verifies it after edits.

You are the **main agent**. Use the active client's native agent surface for delegation.

The default implementer after `repovine setup` is **project-subagent-sample**. Specialist agents are repo-owned copies of `_TEMPLATE.project-subagent.*`. Agent identity comes from frontmatter/TOML `name`, not filename.

Delegation policy:

- Non-trivial implementation: delegate to **project-subagent-sample** unless the user named project subagents or explicitly asked the main chat to implement.
- One named subagent: use only that agent.
- Two or more named subagents: use exactly the named set; do not add the default unless named.
- Parallel runs only for disjoint scopes; leaf subagents never call each other. Exception: never parallelize annotation writes — `repovine-annotation-writer` and any agent calling `write_annotation` run **one at a time**, even across disjoint module scopes, because every write goes through one debounced annotation store (parallel writers gain no throughput and can lose annotations).
- Main chat stays direct for trivial edits and questions; route utility work to `repovine-repo-explorer`, `repovine-annotation-writer`, `repovine-architecture-auditor`, or `repovine-code-reviewer` when that specialist fits.
- Architecture audits use `repovine-architecture-auditor`; read-only implementation/diff reviews use `repovine-code-reviewer`.

Handoffs must include scope, acceptance criteria, contracts, prior handoff context, files/nodes touched, tests, and blockers. Run `refresh_context` between dependent phases after graph-relevant edits. After feature work, use `repovine-workflow` for post-edit verification or `repovine-review` for read-only review, then `repovine-annotations` in touched scope — Drain the annotation queue in batches until `needsWork: 0` (includes propagation-stale with `staleKind: "propagation"`).

## Before Editing

1. Orient and map the area:

```json
search_context({ "query": "feature, route, service, component, resource, or config name", "match": "auto", "limit": 15 })
map_context({ "scope": "chosen-scope", "view": "summary", "limit": 10 })
```

Before `inspect_node`, read `result.matches.strategy` (`relaxedFrom`, `weakTokenOnlySuppressed`, `strongTokens`), `gaps`, `summary`, `confidence`, and `topResults[].matchedTokenCount`. OR-relax hits omit `emptyDiagnostic`; `confidence: "low"` or `matchedTokenCount: 1` on a multi-token query is a weak signal — narrow the query or retry `match: "and"`.

`search_context` omits annotation fields when `topResults[].annotationMatched` is true — the response `gaps` line and `navigation.deeper` point to `inspect_node`; do not treat the hit as fully understood from search alone.

Then inspect a likely node:

```json
inspect_node({ "nodeId": "mod:pkg/path/likely-file" })
```

2. Convert annotations into implementation constraints:

Annotations hint and constrain; they do not bound inspect scope. Locality: `annotation` on nodeId X is evidence about X only — not about other nodeIds, including mod: refs in `integrationPoints`, `links`, or `drillDown`. Absence: no annotation and no `inspect_node` on a nodeId means no conclusion about that node. Unchanged: stating a nodeId is unchanged, verified, or already-correct requires `inspect_node` on that nodeId in this session. Closure: before leaving related nodes unedited, follow `links`, `navigation.*`, and task-relevant `integrationPoints` mod: refs. Boundary or discovery tasks (find every surface exposing an affordance class) inspect the affordance-class consumers/importers before treating them unchanged — breadth is the task. Refactor or architecture tasks bound closure with one `analyze_dependencies` impact pass and need not inspect every ref. Investigate channel: a `links`/`drillDown`/`investigatePointers` ref returned with `investigate` is must-inspect; inspect that node and close the flag as fixed or scoped-out with a code citation before reporting this node unchanged. Tags: `risk` (consumer-scoped risk on the target), `boundary` (off-limits surface — published contract, frozen migration, or structural slot — not edited in place), `effect` (target declares a persistent side effect), `wiring` (deployed runtime topology dispatches into or binds from the target), `co-change` (implements relation — contract and implementations move together), `hub` (target has many importers; impact-check before editing). Same-node citation: that code citation must be on the affordance path of the flagged node itself; gating by a sibling control, a parent or badge, or a different mount does not close the flag unless this affordance is shown to route through that gate. Enumerate-before-unchanged: reviewing a node means listing each mutation affordance, exported action, and protected side effect on it (mutation = anything that creates, changes, or removes state — including but not limited to writes, deletes, dispatches, and lifecycle callbacks) with its capability gate; a single gated affordance does not close a multi-affordance node — `affordanceCount` reports how many to enumerate. These are floors, not ceilings: the `investigate` tags and `affordanceCount` are minimums to check, their absence is not absence of work, and closing every delivered flag or enumerating one node is per-node completeness, never task completeness. Derived flags: a capability, permission, or feature flag is consumed at mount and render predicates and at importers, not only the hook that derives it — boundary tasks inspect those consumers. Weak context: while `confidence` is low, `gaps` is non-empty, or `emptyDiagnostic` is present, the scope is not complete.

Read relevant annotation fields before editing inspected nodes and derive annotation obligations from the existing fields:

- `invariants`: implementation constraints that must still hold after the change.
- `risks`: failure modes to mitigate, test, or explicitly ask the user to accept. Mark a risk `scope: "consumer"` when an importer must verify it locally; mark `scope: "boundary"` for an off-limits surface importers must not edit in place (published contract, frozen migration, id-resolved structural slot). Leave risks local by default — standing risks are normal; consumer and boundary scopes are the selective exceptions that keep the edge flag meaningful.
- `dataFlow` / `flowDescription`: execution order to preserve, or intentionally change with tests.
- `integrationPoints`: mod: refs to inspect for closure before leaving a related node unchanged — required for affordance-class consumers on boundary/discovery tasks, bounded by one impact pass for refactor/architecture. Implementers consume carrier pointers; annotators maintain the carrier pair (deep consumer-risk SSOT plus facade `integrationPoints` reference).
- `sideEffects`: protected effects (persistence writes, lifecycle callbacks, external I/O, privileged runtime dispatches) that validation, authorization, safety, or policy gates may need to precede.

Classify each relevant claim as one of:

- must preserve: behavior, contracts, or invariants that must remain true.
- must verify: flow, integration, or parity checks that need evidence.
- known risk: failure modes to mitigate, test, explicitly accept, or report as blockers.
- surface to check: entrypoints, dependencies, config, side effects, or integrations that must be inspected before changing behavior.

Before editing, make a short checklist of these obligations. Do not collapse distinct obligations just because they point to the same file. After editing, close every relevant obligation as satisfied by code, covered by a focused test, scoped out with a code citation that proves it is a different behavior class, or blocker/unresolved. A risk or invariant in the same behavior class as the requested fix is not closeable as verified, already-correct, intentionally-unchanged, or routine residual risk — change the code, or cite the line that proves it is out of class. "Explicitly accepted" requires the user to accept the tradeoff in this session; it is not a self-served default.

3. Follow the task axis:

| Change touches | Use |
|---|---|
| Runtime behavior, APIs, webhooks, queues, schedules, workers | `get_entrypoints`, then `trace_flow` |
| UI routes, pages, components, client state, effects | `get_entrypoints({ "layer": "frontend" })`, `search_context`, `inspect_node`; use `analyze_architecture` only for review candidates |
| Infra, resources, env vars, secrets, public config | `get_config_surface`, `trace_flow`, and targeted `inspect_node` |
| Shared types, exports, interfaces, package APIs | `analyze_dependencies({ "mode": "impact" })` and package-boundary checks |
| Architecture/refactoring questions | `analyze_architecture`, then inspect and validate before recommending movement |

Infra/runtime tasks: after trace_flow or inspect_node on a resource:, follow runtimeHandoff (or integrationPoints mod: refs on the resource annotation) to the **handler module** before editing code or declaring a node unchanged. Consumer/boundary obligations live on code nodes; resource listings are topology index only.

4. Read only after narrowing:

```json
inspect_node({ "nodeId": "mod:pkg/path/module", "exportLimit": 20, "exportOffset": 20 })
inspect_node({ "nodeId": "mod:pkg/path/module", "grepBody": "specificPattern" })
inspect_node({ "nodeId": "export:pkg/path/module/ExportName", "includeBody": true, "bodyLimit": 12000 })
```

Small files under 50 lines can be read directly. Large modules should page exports first; large files over 200 lines should use `grepBody` or bounded `includeBody` before reading source.

5. Check shared-contract impact before editing shared surfaces:

```json
analyze_dependencies({ "scope": "mod:pkg/path/module", "mode": "impact", "depth": 3 })
analyze_dependencies({ "scope": "mod:pkg/path/module", "mode": "impact", "exportName": "SpecificExport" })
analyze_dependencies({ "scope": "pkg:package-name", "mode": "package-boundaries", "direction": "exports" })
analyze_dependencies({ "mode": "interface-implementations", "interfaceName": "MyInterface" })
```

Enumerate callers of an export (who-calls X) with impact scoped to the export-symbol — `analyze_dependencies({ "scope": "export:pkg/path/module/Name", "mode": "impact" })`, or a module scope plus `exportName`. This is grep-parity for caller lookup and spans re-export barrels, so prefer it over `grep`. Callers reached over a graph edge carry `uses` and no `provenance`; callers with `provenance.basis: "inferred"` are name-matched impact candidates, not proven edges. Inspect them or explicitly code-cite why they are out of scope before treating the caller set as complete.

Use `get_config_surface` for env/config changes and `trace_flow` for runtime dispatch/resource questions.

6. Treat architecture reports as review candidates:

```json
analyze_architecture({ "scope": "pkg:package-name", "mode": "report", "categories": ["boundary", "god-module"], "annotationReasoning": "on", "limit": 12 })
analyze_architecture({ "scope": "pkg:package-name", "categories": ["secret-config-boundary", "trust-boundary-validation", "server-client-boundary"] })
analyze_architecture({ "scope": "pkg:package-name", "detailFindingId": "category:exact-finding-id", "maxNodes": 30 })
```

Use a narrow `scope`, pick relevant `categories`, then inspect affected nodes and dependency impact before proposing code movement. A `mod:`/`resource:` scope holds one node: it reports per-node signals only, and `gaps` says which comparisons that granularity rules out. For security-sensitive reports, remember that `analyze_architecture.strictness` and `analyze_architecture.thresholds.*` in `repovine.config.json` tune detector noise (apply with `refresh_context({ "reloadConfig": true })`).

7. Prefer local project skills when present:

Project-specific skills usually belong in `.cursor/skills/<project>-*`, `.claude/skills/<project>-*`, `.agents/skills/<project>-*`, or client-native equivalents. Those skills should encode repository conventions such as auth policy, folder ownership, design-system usage, deploy rules, naming, and testing habits.

## After Editing

```json
refresh_context({})
```

Then verify the axis you touched:

```json
validate_annotations({})
get_annotation_status({ "view": "queue", "limit": 20 })
analyze_dependencies({ "scope": "mod:pkg/path/changed-module", "mode": "impact", "depth": 3 })
analyze_dependencies({ "scope": "pkg:package-name", "mode": "package-boundaries" })
get_entrypoints({ "scope": "feature-or-package" })
get_config_surface({ "scope": "feature-or-package" })
trace_flow({ "scope": "feature-or-service", "include": ["entrypoints", "services", "resources", "flows"] })
```

When reporting or handing off implementation work, include the relevant annotation obligations you found and close each one as satisfied by code, covered by tests, scoped out with a code citation for a different behavior class, or blocker/unresolved. A same-class risk reported as accepted requires explicit user sign-off in this session, not a self-served default. An unresolved relevant invariant or untested relevant risk is a blocker or partial implementation, not a routine residual risk. When reporting which nodeIds were left unchanged, verified, or already-correct, each such nodeId must have inspect evidence in this session; on boundary/discovery tasks an `integrationPoints` mod: ref that consumes the affordance needs inspect before you report it unchanged.

For new or significantly changed modules, write a concise annotation:

```json
write_annotation({
  "nodeId": "mod:pkg/path/changed-module",
  "annotation": {
    "summary": "What changed module does.",
    "assumptions": ["Input/config/runtime assumptions"],
    "sideEffects": [
      { "kind": "io-write", "subtype": "http", "description": "POST /api/x" },
      { "kind": "state-global", "description": "mutates AuthStore on success" }
    ],
    "risks": [
      "Local-only failure mode",
      { "text": "Importer must verify this at the consumer", "scope": "consumer" }
    ]
  }
})
```

When annotation work remains in the touched scope, drain the queue until `needsWork: 0` (content-stale before propagation-stale).

For notes written this session, confirm both non-completeness axes: each annotated node was `inspect_node`-ed or edited in the same session (provenance), and `write_annotation` returned no `quality.consistency.issues` (no field contradicts the graph). Fix and re-write any that fail.

## Guardrails

- repovine tool output is strict JSON; rely on `navigation` suggestions when present before guessing the next call.
- All MCP tools accept `responseFormat: "concise" | "debug"`. Prefer concise; use debug only for full payloads. Concise navigation may return refs like `"$3x9a1"`; reuse them in the same MCP session or expand from `refs`. For context-quality runs, pass the provided `contextSessionId` on repovine calls and inspect with `get_context_session_quality`.
- A capped answer carries a `truncation` block beside what it bounded, keyed by the bounded field: `shown`/`total` on the scale named by `unit`, and `more` saying how to reach the rest — `page` (pass the named offset arg), `arg` (pass the named argument), `narrow` (ask a narrower question), `inline` (the rest is elsewhere in this same response), `unavailable` (no call returns it). Absence of the block means nothing was dropped. Treating a bounded list as the whole set is the failure this block exists to prevent; `unavailable` is the one case where paging cannot fix it.
- Do not treat `analyze_architecture` findings as proof. They are review candidates.
- Do not store secrets in annotations. repovine records env var names, not secret values.
- Only ever change `repovine.annots.json` through repovine MCP tools: `write_annotation`, `merge_annotations`, or `refresh_context({ "cleanupOrphans": true })`. Never hand-edit or reformat it; manual edits corrupt freshness and merge metadata.
- Annotating modules and reading source to summarize them is summary-class work. Use the cheapest, fastest model for exploration/annotation; reserve stronger models for implementation and hard reasoning.
- Commit `repovine.annots.json` when annotation work changes shared annotation memory.
