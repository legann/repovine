---
name: repovine-annotations
description: "Maintain repovine annotations: targeted updates, merge fixes, and reviewed batches"
---

# repovine-annotations

Maintain the annotation layer through targeted updates, merge/conflict repair, or reviewed batch onboarding.

## Skill inputs

The user may ask for:

- default: targeted annotation maintenance for changed/stale nodes
- init or onboard: coverage + estimate + prompt for a first batch
- continue: next batch in the last scope
- domain <name>: scope to one domain
- limit <n>: override the default batch size

## Targeted annotation flow

Use this path after concrete code changes, stale annotation signals, or annotation-file conflicts.

1. Refresh first if files changed since the syntax index was built:

~~~json
refresh_context({})
~~~

2. Check annotation health and merge state:

~~~json
get_annotation_merge_status({})
validate_annotations({})
get_annotation_status({ "view": "coverage" })
get_annotation_status({ "view": "queue", "limit": 10 })
~~~

If `repovine.annots.json` contains conflict markers, call `merge_annotations({})` and then `validate_annotations({})` before writing notes.

Risk-scope candidate advisory: `validate_annotations` may report plain/local risks that look like `scope:"consumer"` or `scope:"boundary"` candidates, and `get_annotation_status({ "view": "risk-scope-candidates" })` pages the review list. A candidate is not proof; inspect the node/source before rewriting. If accepted, rewrite only through `write_annotation`, preserving the risk text and adding `scope`. If rejected, leave it local; v1 has no suppression state.

After git merge/rebase: resolve code conflicts first, then `merge_annotations({})`, `git add repovine.annots.json`, `refresh_context({})`, and `validate_annotations({})`. If merge-review markers remain, compare the ours/theirs assumptions and rewrite the final field via `write_annotation`.

`view: "queue"` is one backlog (modules, templates, services, infra, domain roll-ups), not separate queues. **Drain order (engine-sorted):** (1) content-stale (`staleKind: "content"`), (2) then propagation-stale (`staleKind: "propagation"`), (3) then unannotated; within each tier modules and templates before runtime resources, infra and domain roll-ups, and only then bottom-up by dependency depth. Take the top page of `view: "queue"` — do **not** run a separate propagation-first pass via `derived-review` unless the orchestrator explicitly requests propagation-only review. Propagation items: `refreshImportBaseline: true` unless upstream contract changed. Content-stale: full rewrite. Finish when `needsWork: 0`. Offsets shift as notes are written.

3. Inspect each changed or stale target:

~~~json
inspect_node({ "nodeId": "mod:pkg/path/module" })
~~~

4. Write or update only the relevant note fields. Mark a risk `scope: "consumer"` when an importer must verify it locally; mark `scope: "boundary"` for an off-limits surface importers must not edit in place (published contract, frozen migration, id-resolved structural slot). Leave risks local by default — standing risks are normal; consumer and boundary scopes are the selective exceptions that keep the edge flag meaningful. The `risks` field accepts plain strings (treated as local) or `{ "text": "...", "scope": "consumer" | "boundary" }` objects — use consumer/boundary scope sparingly so `inspect_node` edge flags stay meaningful. A `scope: "consumer"` risk text should state the importer obligation (what the caller must verify locally), not just the standing fact, and withhold the mechanism: name what the caller must verify, not the fix, the ordering, or the recipe; the reader derives those. Over-specifying converts to acknowledgement-without-action. A `scope: "boundary"` risk states the contract/compat/wire status that makes an in-place edit wrong (what breaks downstream), not how to migrate. Name the frozen surface and the consumer that depends on its shape; withhold the migration steps. An understated flag beats a complete one that hands over the answer. `sideEffects` is a structured array of `{ kind, subtype?, description? }`; detectors read `kind` directly, a closed enum: `io-read`, `io-write`, `state-local`, `state-global`, `process`, `concurrency`, `time`, `subscribe`, `external`, `resource`, `pure`. A `[{ "kind": "pure" }]` module is dropped from `client-business-logic`; `io-write` (except `stdout`/`stderr`), `external`, `state-global`, or `resource` mark a client/UI module as a `privileged-client-side-effect` candidate. Never write `sideEffects: []` (rejected) — omit the field or declare `[{ "kind": "pure" }]`. Carrier-link authoring: when a facade/importer delegates to a consumer-risk SSOT that is more than one import hop away, write the pair explicitly. The SSOT/deep delegate carries `risks: [{ "text": "... importer/caller must verify ...", "scope": "consumer" }]`; each facade/importer that agents inspect instead names that dependency in `integrationPoints` with a `mod:` or `export:` id. Do this for 2-4 hop dependency chains or misleading facades; do not duplicate it for a direct 1-hop import because `links` already carries the investigate flag. Run `validate_annotations({})`: the `missing-carrier-link` advisory nudges only runtime 2-hop delegation candidates — naming a deeper (3-4 hop) delegate stays valid authoring and still delivers through `investigatePointers`, it is just not nudged. The advisory never asks to remove an existing `integrationPoints` entry; consumer/backward refs kept for implementer closure stay valid. Close a flagged pair by naming the SSOT where the importer delegates to it, or record reviewed-not-a-gap via `decline_advisory({ "kind": "carrier-link-gaps" })` after reviewing `get_annotation_status({ "view": "carrier-gaps" })` — suppression is workspace-local and re-surfaces when the SSOT's consumer risks change. On `resource:` annotations, use `integrationPoints` to name the `mod:handler` that owns editable code; optional deeper logic refs belong in prose. Keep resource risks local to structural/runtime facts (trigger, env binding). Do not duplicate consumer-risk from the logic module: resource-to-module refs are runtime handoff prose, not carrier validate Type B.

~~~json
write_annotation({
  "nodeId": "mod:pkg/path/module",
  "annotation": {
    "summary": "What this module does.",
    "keyExports": { "ExportA": "What ExportA does" },
    "assumptions": ["Input/config assumptions"],
    "sideEffects": [
      { "kind": "io-write", "subtype": "db", "description": "INSERT into TABLE_NAME" },
      { "kind": "external", "subtype": "sdk", "description": "calls ApiName.method" }
    ],
    "risks": [
      "Local-only failure mode",
      { "text": "Importer must verify this at the consumer", "scope": "consumer" }
    ],
    "integrationPoints": "If this module is a facade, name the delegated SSOT: mod:pkg/deep-gate"
  }
})
~~~

Carrier pair example:

~~~json
[
  {
    "nodeId": "mod:pkg/facade",
    "annotation": {
      "summary": "Facade that delegates policy decisions.",
      "integrationPoints": "Authoritative gate lives in mod:pkg/deep-gate"
    }
  },
  {
    "nodeId": "mod:pkg/deep-gate",
    "annotation": {
      "summary": "Authoritative gate for the delegated operation.",
      "risks": [
        { "text": "Importers must verify this gate locally before changing caller behavior.", "scope": "consumer" }
      ]
    }
  }
]
~~~

Runtime/metadata wiring: for module/template annotations connected through registries, metadata, or dynamic mounts, keep the `mod:` reference in `integrationPoints` for implementer closure even when no static import path exists. `validate_annotations({})` may report `named-but-undeliverable`; that means `inspect_node` will not auto-emit investigatePointers, so verify the wiring in source. For `resource:` annotations, naming `mod:handler` is runtime handoff prose; carrier-gap validation does not flag resource-to-module refs in v1.

On `resource:` annotations, use `integrationPoints` to name the `mod:handler` that owns editable code; optional deeper logic refs belong in prose. Keep resource risks local to structural/runtime facts (trigger, env binding). Do not duplicate consumer-risk from the logic module: resource-to-module refs are runtime handoff prose, not carrier validate Type B.

On success, `result.submittedAnnotation` reports approximate submitted size (`chars`, `estimatedTokens` ~chars/4).

### Propagation-stale review (optional filter — not first)

Default drain: `get_annotation_status({ "view": "queue", "limit": 10 })` — content-stale ranks above propagation-stale.

Use `derived-review` or `staleKind: "propagation"` only when:
- content-stale in scope is already cleared (or orchestrator asks for propagation-only).

~~~json
get_annotation_status({ "view": "derived-review", "limit": 10 })
~~~

For each item: `inspect_node` the module and `context.upstreamTriggers`. Update `integrationPoints`/`dataFlow` only if upstream contract changed; otherwise ack:

~~~json
write_annotation({
  "nodeId": "mod:pkg/importer",
  "refreshImportBaseline": true,
  "annotation": { "assumptions": ["Propagation review: verified upstream; integrationPoints still accurate."] }
})
~~~

## Optional conversion verification

Use this only when the user asks to harden high-value `scope:"consumer"` or `scope:"boundary"` annotations. Do not run it as part of batch onboarding, and do not put it in the cheap-model annotation loop.

1. Pick a small task that should trip the scoped surface: an edit attempt on a frozen boundary node, or a consumer-side change that depends on the obligation.
2. Observe whether the agent gates/declines before editing, or merely edits after acknowledging the risk.
3. If the result is edit-with-acknowledgement (acknowledged-but-ungated) or trace-then-drop, the annotation's altitude or placement is off. Tighten the risk text so it names the obligation/status and withholds the mechanism, then re-run the check.

## Batch onboarding flow

1. Call `get_annotation_status({ "view": "coverage" })`.
2. Call `get_annotation_status({ "view": "queue", "limit": 20 })` to sample stale or unannotated module kinds.
3. Estimate cost from the queue's `moduleKind` distribution.
4. Explain that annotation time and context cost depend on repo size; recommend small batches and a less expensive model for bulk onboarding.
5. Ask the user before each batch (including the first).

Suggested tokens / annotation:

- `types` 1,000; `infra`/`generic` 2,000; `domain` 2,500; `ui` 2,800
- `adapter`/`template` 3,200; `api-handler`/`service-mgr`/`runtime-resource` 4,500

### Batch execution

> **One writer at a time — never parallelize annotation writes.** Delegate a single `repovine-annotation-writer` subagent, wait for it to return, then delegate the next. Do NOT fan out multiple annotation writers (or multiple agents calling `write_annotation`) concurrently. Every write goes through the one MCP server and a debounced, in-memory annotation store: parallel writers gain no throughput (the server serializes them) and can race the store's save/merge or lose writes if the run is interrupted. After any bulk pass, verify before trusting it — compare annotation count before/after and run `validate_annotations` (expect `0` inconsistent, no unexpected drop).

Delegate one batch to the `repovine-annotation-writer` subagent:

~~~
Run repovine-annotation-writer subagent:
  domain: <if domain was requested>
  limit:  <default 10>
~~~

The subagent processes one batch and returns. After each batch: report progress, ask before the next batch, and do not auto-continue without user approval. Repeat until the annotation queue reaches `needsWork: 0` in scope (repo-wide after first `init` onboarding; touched scope after feature work). Resume with continue when the user approves.

### After each batch

Print progress and stop:

~~~
Done: 10 / 398 (~12.4k est. submitted tokens).
Remaining by domain:
  api      (77)
  monday   (62)
  auth     (51)

Next:
  ask to use repovine-annotations with continue
  ask to use repovine-annotations for domain <name>
  done
~~~

Sum `result.submittedAnnotation.estimatedTokens` from successful writes (heuristic chars/4 on submitted fields).

## Notes

- Queue order is bottom-up within each tier: content-stale before propagation-stale before unannotated, then modules before services/infra/domains, lower dependency depth before importers.
- A domain roll-up goes stale when a member the author placed there changes — a member an import cluster or a package name pulled in does not move it. A domain whose members all come from package names hashes every member, as does any domain under `domainStalePolicy: "all-tags"`. Annotate members first: a roll-up rewritten before its members is stale again by the end of the batch.
- Derived-stale: `importBaseline` vs direct imports (`upstreamTriggers`); clear via rewrite or `refreshImportBaseline: true`.
- The `repovine-annotation-writer` subagent must `inspect_node` each node before `write_annotation` (the harness checks this provenance over `annotationsWritten`) and fix any `quality.consistency.issues`; `quality.score` is completeness only — an empty field beats a fabricated one.
- Drain hard-work batches until `needsWork: 0` in scope. Keep batches small. Annotating modules and reading source to summarize them is summary-class work. Use the cheapest, fastest model for exploration/annotation; reserve stronger models for implementation and hard reasoning.
- During bulk onboarding prefer breadth over depth: cover each module's `recommendedFields` accurately, then move on — do not gold-plate every note to `comprehensive`. Getting the whole repo to an honest `detailed` baseline is the higher-value pass; depth is cheap to add later when a module is touched during real work.
- Only ever change `repovine.annots.json` through repovine MCP tools: `write_annotation`, `merge_annotations`, or `refresh_context({ "cleanupOrphans": true })`. Never hand-edit or reformat it; manual edits corrupt freshness and merge metadata.
- After pull/merge/rebase, if `repovine.annots.json` contains conflict markers, call `merge_annotations({})` and `validate_annotations({})` before continuing.
- Use the `repovine-refresh` skill first if files changed since the last MCP refresh.
- Use the `repovine-status` skill for stats only.
- Do not fabricate fields you cannot infer from `inspect_node` or source — an empty field beats a fabricated one. `quality.score` is completeness only, not correctness.
- After each write, check `result.quality.consistency.issues` and fix any field that contradicts the graph.
- Mark a risk `scope: "consumer"` when an importer must verify it locally; mark `scope: "boundary"` for an off-limits surface importers must not edit in place (published contract, frozen migration, id-resolved structural slot). Leave risks local by default — standing risks are normal; consumer and boundary scopes are the selective exceptions that keep the edge flag meaningful. The `risks` field accepts plain strings (treated as local) or `{ "text": "...", "scope": "consumer" | "boundary" }` objects — use consumer/boundary scope sparingly so `inspect_node` edge flags stay meaningful. A `scope: "consumer"` risk text should state the importer obligation (what the caller must verify locally), not just the standing fact, and withhold the mechanism: name what the caller must verify, not the fix, the ordering, or the recipe; the reader derives those. Over-specifying converts to acknowledgement-without-action. A `scope: "boundary"` risk states the contract/compat/wire status that makes an in-place edit wrong (what breaks downstream), not how to migrate. Name the frozen surface and the consumer that depends on its shape; withhold the migration steps. An understated flag beats a complete one that hands over the answer.
- Risk-scope candidate advisory: `validate_annotations` may report plain/local risks that look like `scope:"consumer"` or `scope:"boundary"` candidates, and `get_annotation_status({ "view": "risk-scope-candidates" })` pages the review list. A candidate is not proof; inspect the node/source before rewriting. If accepted, rewrite only through `write_annotation`, preserving the risk text and adding `scope`. If rejected, leave it local; v1 has no suppression state.
- Carrier-link authoring: when a facade/importer delegates to a consumer-risk SSOT that is more than one import hop away, write the pair explicitly. The SSOT/deep delegate carries `risks: [{ "text": "... importer/caller must verify ...", "scope": "consumer" }]`; each facade/importer that agents inspect instead names that dependency in `integrationPoints` with a `mod:` or `export:` id. Do this for 2-4 hop dependency chains or misleading facades; do not duplicate it for a direct 1-hop import because `links` already carries the investigate flag. Run `validate_annotations({})`: the `missing-carrier-link` advisory nudges only runtime 2-hop delegation candidates — naming a deeper (3-4 hop) delegate stays valid authoring and still delivers through `investigatePointers`, it is just not nudged. The advisory never asks to remove an existing `integrationPoints` entry; consumer/backward refs kept for implementer closure stay valid. Close a flagged pair by naming the SSOT where the importer delegates to it, or record reviewed-not-a-gap via `decline_advisory({ "kind": "carrier-link-gaps" })` after reviewing `get_annotation_status({ "view": "carrier-gaps" })` — suppression is workspace-local and re-surfaces when the SSOT's consumer risks change.
- Runtime/metadata wiring: for module/template annotations connected through registries, metadata, or dynamic mounts, keep the `mod:` reference in `integrationPoints` for implementer closure even when no static import path exists. `validate_annotations({})` may report `named-but-undeliverable`; that means `inspect_node` will not auto-emit investigatePointers, so verify the wiring in source. For `resource:` annotations, naming `mod:handler` is runtime handoff prose; carrier-gap validation does not flag resource-to-module refs in v1.
