# Correctness — A Migration Mutates a Field With a Stored Search Projection (`elastic/kibana`)

A migration normalizes a rule's `params.severity` value. The same value is stored in the searchable `mapped_params` projection used by the rule-find route. A transform that updates only `params.severity` leaves `mapped_params.severity` stale. Find, sort, and filter operations then use the stale value.

- Repository: `elastic/kibana` — a large monorepo (~90k TS/TSX files, ~1,400 plugins). Pinned `68df830b2849a4b8e53114d621906b81fdbca99f` (`origin/main`, 2026-06-21).
- Model: `opus-4.8` (primary), `sonnet-5`, and `fable-5`, N=10 per arm. Effort **max** on every run. Memory-isolated per run (`autoMemoryEnabled: false`).
- Scoring: correctness gate over the final diff — severity normalization (C1) and recomputation of the stored projection (G1).
- Terms (arm, gate, DQ, C1, G1, Frozen): [METHODOLOGY.md](../../METHODOLOGY.md#terms)
- Baseline native skills: kibana's own `.claude/skills/*` — ~30 skills (`encrypted-saved-objects`, `task-manager-registration`, `api-authz`, `scout-*`, …) plus AGENTS.md/CLAUDE.md; only repovine is withheld. No native skill documents the `mapped_params` projection.

This case covers a stored search projection that must be updated with its source field. The migration edit site omits the relation between the field and the projection.

## Evidence from the pinned repository

The pinned source establishes the projection write, storage, read, and migration paths.

| Signal | Evidence |
|---|---|
| Specific rule params are duplicated into a stored projection | `rules_client/common/mapped_params_utils.ts:14` — `MAPPED_PARAMS_PROPERTIES` (risk_score, severity) |
| `severity` is stored as a transformed, sortable value | `mapped_params_utils.ts:19` — `SEVERITY_MAP` (maps severity to a sortable prefix); applied by `getModifiedValue` (`:104`) |
| The projection is written on every rule save | `application/rule/transforms/transform_rule_domain_to_rule_attributes.ts:30` computes `getMappedParams(params)`, `:42` stores it as the top-level `mapped_params` attribute |
| The projection is persisted in the saved object | `saved_objects/schemas/raw_rule/v1.ts:271`, `v3.ts:289` — `mapped_params` is a stored SO field |
| The rule-find route queries the stored projection | `application/rule/methods/find/find_rules.ts:87` rewrites the sort field to `mapped_params.*`, `:96` the search fields, `:106` the filter AST (`getModifiedFilter` maps `.params.` → `.mapped_params.`, `mapped_params_utils.ts:53`) |
| A migration touching these params is expected to recompute the projection | `saved_objects/migrations/8.2/index.ts:21` — an existing migration calls `getMappedParams(params)` when it changes params |
| Rule model versions register plain | `saved_objects/model_versions/` has no `getMappedParams` and no `createModelVersion` call |

The `mapped_params` projection is defined in `rules_client/common`, written by the write-path transform, stored in the saved-object schema, and read by the find route. The migration edit site contains no projection reference. The seam files are byte-identical to the pinned checkout.

## The seam

```
edit site   ruleModelVersions (add v14)   saved_objects/model_versions/rule_model_versions.ts   the severity-normalize migration goes here
truth       MAPPED_PARAMS_PROPERTIES      rules_client/common/mapped_params_utils.ts:14   risk_score, severity
transform   SEVERITY_MAP / getModifiedValue  mapped_params_utils.ts:19 / :104   severity → sortable prefix
write       getMappedParams               transforms/transform_rule_domain_to_rule_attributes.ts:30   projection recomputed on every save
store       mapped_params (SO attribute)  saved_objects/schemas/raw_rule/v1.ts:271   persisted alongside params
read        find_rules                    application/rule/methods/find/find_rules.ts:87   sort/search/filter rewritten to mapped_params.*
exemplar    migrations/8.2                 saved_objects/migrations/8.2/index.ts:21   a prior migration recomputes the projection
```

`params.severity` is duplicated into `mapped_params.severity` as `SEVERITY_MAP[value]` at write time. The find route rewrites sort, search, and filter operations from `params.severity` to `mapped_params.severity`. The migration therefore has two writes: normalize `params.severity` and recompute `mapped_params.severity`. A params-only migration leaves the old projection (`''`) beside the canonical source value. The migration edit site (`rule_model_versions.ts`) contains a plain `data_backfill`/`unsafe_transform` pattern and no projection reference.

## Surfaces

| Surface | Type | Rule |
|---|---|---|
| the severity-normalize model version | Target | the migration belongs here |
| recompute of `mapped_params` when a projected param changes | Scoring gate (G1) | the migration must recompute the stored projection (`getMappedParams` or equivalent) |
| `MAPPED_PARAMS_PROPERTIES` / `getMappedParams` / the find rewrite | Frozen | the projection contract; not the edit site |
| `find_rules`, `transform_rule_domain_to_rule_attributes` | Read/write owners | queried/written, not edited |
| legacy `migrations/*`, `mappings.ts`, rule create/update write paths, `alerting_v2` | Out of scope | different mechanism / different SO type; the task is a model-version migration on the `alert` type |

The score is the projection-consistency gate above, counted from the diff. C1 records whether the severity-normalize migration is implemented; G1 records whether the `params.severity` mutation recomputes the stored `mapped_params` projection.

### Co-located coupling (cross-reference)

`params` and `mapped_params` are both listed in `RuleAttributesIncludedInAAD` (`saved_objects/index.ts:67-68`). A migration mutating `params.severity` also changes the encryption AAD and requires re-encryption through `createModelVersion`. The native `encrypted-saved-objects` skill covers the AAD coupling. **G1 scores the `mapped_params` recompute.** An AAD-correct run receives a G1 DQ when `mapped_params` remains stale. Native skill coverage for the projection coupling is absent.

## Task prompt (identical for both arms)

```text
Implementation task. Modify files as needed.

Task:
Kibana alerting rules can carry a `severity` param: a string label whose
canonical values are `low`, `medium`, `high`, and `critical`. Over time some
rules have stored this value with inconsistent letter casing (for example
`High`, `MEDIUM`, or `Critical`) instead of the canonical lowercase form. Add a
saved-object migration (model version) that normalizes each existing rule's
`severity` param to lowercase. Rules whose `severity` is already lowercase, or
that have no `severity` param, are left unchanged. Every existing rule must
continue to load and function normally after the upgrade.

Constraints:
- Do not change the persisted storage shape beyond the case normalization.
- Do not change behavior for rules whose severity is already lowercase.
- Change implementation only; do not add or modify tests.

Deliverables:
1. Implement the patch.
2. Report where you localized the migration and which files you changed. Note any
   related code paths you deliberately left unchanged, each with the specific
   source that proves it is out of scope.
3. Final response: concise summary of changed behavior, files touched at a high
   level, and any residual risk.
```

The prompt names `severity` and a migration. The projection, search, sort, and find-route details are absent. "Must continue to load and function normally" establishes the correctness requirement in both arms.

## Annotation (Repovine arm)

Committed with this case: [`repovine.annots.json`](repovine.annots.json) — the delivered edit-site annotation, verbatim.

Delivered at the migration edit-site node `mod:…/saved_objects/model_versions/rule_model_versions`. It states the projection-membership fact and the recompute constraint as architecture. It names no transform code, model-version scaffold, disambiguation strategy, or fix recipe.

```json
{
  "rule_model_versions": {
    "summary": "Append-only registry of rule saved-object model versions; released versions are frozen. Rule params in MAPPED_PARAMS_PROPERTIES (risk_score, severity) are also persisted, at write time, in the top-level mapped_params projection (severity as a sortable value via SEVERITY_MAP, e.g. '60-high').",
    "invariants": [
      "The find path rewrites every sort field, search field, and KQL filter on params.risk_score / params.severity to mapped_params.* (find_rules.ts via mapped_params_utils.ts); for find/sort/filter the stored projection is the value read, not params.",
      "mapped_params is (re)computed only by the rule create/update write paths (transform_rule_domain_to_rule_attributes). A migration transform rewrites the document without running them, and no path re-saves rules after an upgrade.",
      "Every writer persists mapped_params == getMappedParams(params). A severity value absent from SEVERITY_MAP (any non-canonical case) projects to ''.",
      "mapped_params is an existing attribute of the raw-rule saved-object schema (raw_rule/v1.ts), stored alongside params."
    ],
    "risks": [
      { "text": "A model version added here that mutates a MAPPED_PARAMS_PROPERTIES param (risk_score, severity) changes a value that is also held in the stored mapped_params projection, which find/sort/filter reads in place of params; the write paths that keep the two consistent do not run during migration. Released versions are frozen — new behavior is appended as a new version.", "scope": "boundary" }
    ]
  }
}
```

The stored form adds `sideEffects: [{ "kind": "pure" }]`. Two channels deliver it.

| Channel | Mechanism | Carries |
|---|---|---|
| pull | `inspect_node` returns the annotation body verbatim | summary, invariants, risk |
| push | `scope:"boundary"` risk → `.repovine/boundary-index.json` → PreToolUse hook fires on Edit of `rule_model_versions.ts` | the risk text at the decision point |

The invariants specify four facts relevant to the migration.

| Invariant | Observed DQ rationale addressed |
|---|---|
| find/sort/filter reads `mapped_params.*` | "derived / internal / cosmetic" |
| projection recomputation occurs on create/update; the migration has zero re-save step | "self-heals on the next write" |
| every writer holds `mapped_params == getMappedParams(params)`; non-canonical → `''` | "no regression — it was `''` already" |
| `mapped_params` is an existing schema attribute | "out of scope / a second persisted change" |

`integrationPoints` is omitted. The edit-site node imports only the `raw_rule` schemas, so the projection nodes lie outside its forward-import closure and the `investigatePointers` carrier is inert for them; the invariants name the seam by file and symbol. Delivery uses the pull body and the boundary push.

### Bench prep (Repovine arm only)

Initialize Repovine in the pinned checkout and build the repository graph. Place the case's attached [`repovine.annots.json`](repovine.annots.json) in the workspace root, then refresh Repovine to load the annotations.

## Gate

A correctness case separates C1 (the required rule both arms implement) from G1 (the discriminating gate).

| Label | Predicate | DQ |
|---|---|---|
| C1 | the run adds a model version that normalizes `params.severity` to lowercase (keep non-string/absent unchanged) | migration not implemented |
| G1 | the migration recomputes the stored `mapped_params` projection for the mutated rows (calls `getMappedParams`, or recomputes `mapped_params.severity` via the projection map `SEVERITY_MAP`) | `params.severity` mutated + `mapped_params` unchanged → stale projection |

**G1 is scored from the diff.** Gate evidence is a `mapped_params` write, directly or through `getMappedParams`, in the migration that mutates `params.severity`. A params-only migration leaves `mapped_params.severity` at the old projection (`''`). Find, sort, and filter operations continue reading that value.

## Per-run facts

The severity-normalize migration (C1) is expected in every run, both arms. G1 passes when the run recomputes `mapped_params` for the rows it mutates.

| Model | Baseline C1 | Baseline G1 | Repovine C1 | Repovine G1 |
|---|---:|---:|---:|---:|
| `sonnet-5` | 10/10 | 0/10 | 10/10 | 7/10 |
| `opus-4.8` | 10/10 | 0/10 | 10/10 | 7/10 |
| `fable-5` | 10/10 | 0/10 | 10/10 | 10/10 |

The tables below record the scored facts and implementation path for each run. Statistical comparisons appear in [Result](#result).

### Baseline arm — opus-4.8

Memory-isolated run series, N=10, each run in its own worktree (`kibana-no-mcp-opus48-mpm-1…10`); scored from each run's real `git diff`.

| Run | migration (C1) | mapped_params recomputed | gate (G1) | path |
|---|---|---|---|---|
| 1–10 | ✓ (×10) | ✗ (×10) | DQ (×10) | normalize `params.severity` via `unsafe_transform`; read the projection and declined the recompute ("out of scope" / "derived, self-heals on next write" / "strict improvement, not a regression") |

### Baseline arm — sonnet-5

Memory-isolated run series (`autoMemoryEnabled: false`), N=10, each run in its own worktree (`kibana-no-mcp-sonnet5-mpm-1…10`); scored from each run's real `git diff`.

| Run | migration (C1) | mapped_params recomputed | gate (G1) | path |
|---|---|---|---|---|
| 1 | ✓ | ✗ | DQ | ships the migration without touching `mapped_params` |
| 2 | ✓ | ✗ | DQ | read the projection, declined — "stays stale … out of scope per task wording" |
| 3 | ✓ | ✗ | DQ | read the projection, declined — "derived, write-time-only … out of scope" |
| 4 | ✓ | ✗ | DQ | ships the migration without touching `mapped_params` |
| 5 | ✓ | ✗ | DQ | read the projection, declined — "self-heals … beyond case normalization" |
| 6 | ✓ | ✗ | DQ | read the projection, declined — "cosmetic … recomputed next save" |
| 7 | ✓ | ✗ | DQ | ships the migration without touching `mapped_params` |
| 8 | ✓ | ✗ | DQ | read the projection, declined — "pre-existing bug … out of scope" |
| 9 | ✓ | ✗ | DQ | ships the migration without touching `mapped_params` |
| 10 | ✓ | ✗ | DQ | ships the migration without touching `mapped_params` |

### Baseline arm — fable-5

Memory-isolated run series, N=10, each run in its own worktree (`kibana-no-mcp-fable5-mpm-1…10`); scored from each run's real `git diff`.

| Run | migration (C1) | mapped_params recomputed | gate (G1) | path |
|---|---|---|---|---|
| 1–10 | ✓ (×10) | ✗ (×10) | DQ (×10) | normalize `params.severity` via `unsafe_transform`; read the projection and declined the recompute ("derived, recomputed on next write" / "out of scope" / "not recomputed … no regression") |

### Repovine arm — opus-4.8

Memory-isolated run series, N=10, each run in its own worktree (`kibana-mcp-mpm2-1…10`); scored from each run's final `git diff`.

| Run | migration (C1) | mapped_params recomputed | gate (G1) | how (from the diff) |
|---|---|---|---|---|
| 1 | ✓ | ✓ | pass | recompute `mapped_params` via `getMappedParams` in the returned document |
| 2 | ✓ | ✓ | pass | recompute `mapped_params.severity` via `getModifiedValue` |
| 3 | ✓ | ✗ | DQ | shipped C1 with no `mapped_params` write or comment — dropped after the trace |
| 4 | ✓ | ✗ | DQ | shipped C1 with no `mapped_params` write or comment — dropped after the trace |
| 5 | ✓ | ✓ | pass | local copy of the projection map via `SEVERITY_SORT_VALUE` → `mapped_params.severity` (values match the source) |
| 6 | ✓ | ✓ | pass | recompute `mapped_params.severity` via `getModifiedValue` |
| 7 | ✓ | ✓ | pass | recompute via `getMappedParams` written into `attributes.mapped_params` |
| 8 | ✓ | ✗ | DQ | read the coupling, declined in a code comment |
| 9 | ✓ | ✓ | pass | recompute via `getMappedParams` written into the returned document |
| 10 | ✓ | ✓ | pass | recompute `mapped_params` via `getMappedParams` in the returned document |

### Repovine arm — sonnet-5

Memory-isolated run series, N=10, each run in its own worktree (`kibana-mcp-mpm-sn-1…10`); scored from each run's final `git diff`.

| Run | migration (C1) | mapped_params recomputed | gate (G1) | how (from the diff) |
|---|---|---|---|---|
| 1 | ✓ | ✓ | pass | recompute `mapped_params.severity` from a local copy of `SEVERITY_MAP` (values match the source) |
| 2 | ✓ | ✓ | pass | recompute `mapped_params.severity` via `getModifiedValue` |
| 3 | ✓ | ✓ | pass | recompute `mapped_params.severity` via `getModifiedValue` |
| 4 | ✓ | ✓ | pass | recompute `mapped_params.severity` via `getModifiedValue` (registered as a `data_backfill` change) |
| 5 | ✓ | ✓ | pass | recompute `mapped_params.severity` via `getModifiedValue` |
| 6 | ✓ | ✓ | pass | recompute `mapped_params.severity` via `getModifiedValue` |
| 7 | ✓ | ✗ | DQ | declined in a code comment — "case-only fix; the `mapped_params.severity` sortable projection is intentionally left as-is" |
| 8 | ✓ | ✓ | pass | recompute `mapped_params.severity` via `getModifiedValue` |
| 9 | ✓ | ✗ | DQ | declined in a code comment — "`mapped_params.severity` … deliberately left as-is: it's recomputed only [on the next write]" |
| 10 | ✓ | ✗ | DQ | reasoned about the projection in the trace (read `mapped_params_utils.ts`), shipped C1 with no `mapped_params` write or comment |

### Repovine arm — fable-5

Memory-isolated run series, N=10, each run in its own worktree (`kibana-mcp-mpm-fb-1…10`); scored from each run's final `git diff`.

| Run | migration (C1) | mapped_params recomputed | gate (G1) | how (from the diff) |
|---|---|---|---|---|
| 1 | ✓ | ✓ | pass | recompute `mapped_params.severity` via `getModifiedValue` |
| 2 | ✓ | ✓ | pass | recompute `mapped_params.severity` via `getModifiedValue` |
| 3 | ✓ | ✓ | pass | recompute `mapped_params.severity` via `getModifiedValue` |
| 4 | ✓ | ✓ | pass | recompute `mapped_params.severity` via `getModifiedValue` |
| 5 | ✓ | ✓ | pass | recompute `mapped_params.severity` via `getModifiedValue` |
| 6 | ✓ | ✓ | pass | local copy of `SEVERITY_MAP` (values match the source) → `mapped_params.severity` |
| 7 | ✓ | ✓ | pass | recompute `mapped_params.severity` via `getModifiedValue` |
| 8 | ✓ | ✓ | pass | local copy of `SEVERITY_MAP` (values match the source) → `mapped_params.severity` |
| 9 | ✓ | ✓ | pass | recompute `mapped_params` via `getMappedParams` — full recompute |
| 10 | ✓ | ✓ | pass | recompute `mapped_params` via `getMappedParams` — full recompute |

## Result

The table reports the gate results for each model and arm.

| Arm / model | mapped_params recomputed (G1) | Migration (C1) | Fisher p (one-sided) |
|---|---|---|---|
| Baseline, `opus-4.8` | 0/10 | 10/10 | |
| Repovine, `opus-4.8` | 7/10 | 10/10 | p=0.00155 (vs baseline 0/10) |
| Baseline, `sonnet-5` | 0/10 | 10/10 | |
| Repovine, `sonnet-5` | 7/10 | 10/10 | p=0.00155 (vs baseline 0/10) |
| Baseline, `fable-5` | 0/10 | 10/10 | |
| Repovine, `fable-5` | 10/10 | 10/10 | p=5.41e-6 (vs baseline 0/10) |

## Observed outcome patterns

Each category is grounded in the final diff. Transcript-derived rationale is labeled explicitly.

| Outcome | Runs | Gate | Evidence |
|---|---|---|---|
| Baseline params-only migration | Baseline `opus-4.8`: [1](logs-opus4.8/baseline-run-1.txt) [2](logs-opus4.8/baseline-run-2.txt) [3](logs-opus4.8/baseline-run-3.txt) [4](logs-opus4.8/baseline-run-4.txt) [5](logs-opus4.8/baseline-run-5.txt) [6](logs-opus4.8/baseline-run-6.txt) [7](logs-opus4.8/baseline-run-7.txt) [8](logs-opus4.8/baseline-run-8.txt) [9](logs-opus4.8/baseline-run-9.txt) [10](logs-opus4.8/baseline-run-10.txt)<br>Baseline `sonnet-5`: [1](logs-sonnet5/baseline-run-1.txt) [2](logs-sonnet5/baseline-run-2.txt) [3](logs-sonnet5/baseline-run-3.txt) [4](logs-sonnet5/baseline-run-4.txt) [5](logs-sonnet5/baseline-run-5.txt) [6](logs-sonnet5/baseline-run-6.txt) [7](logs-sonnet5/baseline-run-7.txt) [8](logs-sonnet5/baseline-run-8.txt) [9](logs-sonnet5/baseline-run-9.txt) [10](logs-sonnet5/baseline-run-10.txt)<br>Baseline `fable-5`: [1](logs-fable5/baseline-run-1.txt) [2](logs-fable5/baseline-run-2.txt) [3](logs-fable5/baseline-run-3.txt) [4](logs-fable5/baseline-run-4.txt) [5](logs-fable5/baseline-run-5.txt) [6](logs-fable5/baseline-run-6.txt) [7](logs-fable5/baseline-run-7.txt) [8](logs-fable5/baseline-run-8.txt) [9](logs-fable5/baseline-run-9.txt) [10](logs-fable5/baseline-run-10.txt) | DQ | The diff lowercases `params.severity` and leaves the stored `mapped_params` projection unchanged |
| Full projection recompute | Repovine `opus-4.8`: [1](logs-opus4.8/repovine-run-1.txt) [7](logs-opus4.8/repovine-run-7.txt) [9](logs-opus4.8/repovine-run-9.txt) [10](logs-opus4.8/repovine-run-10.txt)<br>Repovine `fable-5`: [9](logs-fable5/repovine-run-9.txt) [10](logs-fable5/repovine-run-10.txt) | PASS | The transform calls `getMappedParams` and writes the complete projection |
| Severity projection recompute through repository mapping | Repovine `opus-4.8`: [2](logs-opus4.8/repovine-run-2.txt) [6](logs-opus4.8/repovine-run-6.txt)<br>Repovine `sonnet-5`: [2](logs-sonnet5/repovine-run-2.txt) [3](logs-sonnet5/repovine-run-3.txt) [4](logs-sonnet5/repovine-run-4.txt) [5](logs-sonnet5/repovine-run-5.txt) [6](logs-sonnet5/repovine-run-6.txt) [8](logs-sonnet5/repovine-run-8.txt)<br>Repovine `fable-5`: [1](logs-fable5/repovine-run-1.txt) [2](logs-fable5/repovine-run-2.txt) [3](logs-fable5/repovine-run-3.txt) [4](logs-fable5/repovine-run-4.txt) [5](logs-fable5/repovine-run-5.txt) [7](logs-fable5/repovine-run-7.txt) | PASS | The transform writes `mapped_params.severity` through `getModifiedValue`, which uses the repository projection map |
| Local projection-map copy | Repovine `opus-4.8`: [5](logs-opus4.8/repovine-run-5.txt)<br>Repovine `sonnet-5`: [1](logs-sonnet5/repovine-run-1.txt)<br>Repovine `fable-5`: [6](logs-fable5/repovine-run-6.txt) [8](logs-fable5/repovine-run-8.txt) | PASS | The transform copies the repository severity map and writes the matching projected value; the copied map carries drift risk |
| Projection discussed, then omitted | Repovine `opus-4.8`: [3](logs-opus4.8/repovine-run-3.txt) [4](logs-opus4.8/repovine-run-4.txt)<br>Repovine `sonnet-5`: [10](logs-sonnet5/repovine-run-10.txt) | DQ | Final diff: no projection write. Transcript rationale reaches the coupling and drops it before the final diff |
| Projection explicitly left stale | Repovine `opus-4.8`: [8](logs-opus4.8/repovine-run-8.txt)<br>Repovine `sonnet-5`: [7](logs-sonnet5/repovine-run-7.txt) [9](logs-sonnet5/repovine-run-9.txt) | DQ | The final diff contains a code comment that classifies projection recomputation as outside scope or deferred until a later write |



## Logs

Redacted run transcripts — agent reasoning, tool calls, and repovine outputs kept; repository source removed.

- Baseline, `sonnet-5`: [1](logs-sonnet5/baseline-run-1.txt) [2](logs-sonnet5/baseline-run-2.txt) [3](logs-sonnet5/baseline-run-3.txt) [4](logs-sonnet5/baseline-run-4.txt) [5](logs-sonnet5/baseline-run-5.txt) [6](logs-sonnet5/baseline-run-6.txt) [7](logs-sonnet5/baseline-run-7.txt) [8](logs-sonnet5/baseline-run-8.txt) [9](logs-sonnet5/baseline-run-9.txt) [10](logs-sonnet5/baseline-run-10.txt) — passes: none
- Baseline, `opus-4.8`: [1](logs-opus4.8/baseline-run-1.txt) [2](logs-opus4.8/baseline-run-2.txt) [3](logs-opus4.8/baseline-run-3.txt) [4](logs-opus4.8/baseline-run-4.txt) [5](logs-opus4.8/baseline-run-5.txt) [6](logs-opus4.8/baseline-run-6.txt) [7](logs-opus4.8/baseline-run-7.txt) [8](logs-opus4.8/baseline-run-8.txt) [9](logs-opus4.8/baseline-run-9.txt) [10](logs-opus4.8/baseline-run-10.txt) — passes: none
- Baseline, `fable-5`: [1](logs-fable5/baseline-run-1.txt) [2](logs-fable5/baseline-run-2.txt) [3](logs-fable5/baseline-run-3.txt) [4](logs-fable5/baseline-run-4.txt) [5](logs-fable5/baseline-run-5.txt) [6](logs-fable5/baseline-run-6.txt) [7](logs-fable5/baseline-run-7.txt) [8](logs-fable5/baseline-run-8.txt) [9](logs-fable5/baseline-run-9.txt) [10](logs-fable5/baseline-run-10.txt) — passes: none
- Repovine, `opus-4.8`: [1](logs-opus4.8/repovine-run-1.txt) [2](logs-opus4.8/repovine-run-2.txt) [3](logs-opus4.8/repovine-run-3.txt) [4](logs-opus4.8/repovine-run-4.txt) [5](logs-opus4.8/repovine-run-5.txt) [6](logs-opus4.8/repovine-run-6.txt) [7](logs-opus4.8/repovine-run-7.txt) [8](logs-opus4.8/repovine-run-8.txt) [9](logs-opus4.8/repovine-run-9.txt) [10](logs-opus4.8/repovine-run-10.txt) — passes: [1](logs-opus4.8/repovine-run-1.txt) [2](logs-opus4.8/repovine-run-2.txt) [5](logs-opus4.8/repovine-run-5.txt) [6](logs-opus4.8/repovine-run-6.txt) [7](logs-opus4.8/repovine-run-7.txt) [9](logs-opus4.8/repovine-run-9.txt) [10](logs-opus4.8/repovine-run-10.txt)
- Repovine, `sonnet-5`: [1](logs-sonnet5/repovine-run-1.txt) [2](logs-sonnet5/repovine-run-2.txt) [3](logs-sonnet5/repovine-run-3.txt) [4](logs-sonnet5/repovine-run-4.txt) [5](logs-sonnet5/repovine-run-5.txt) [6](logs-sonnet5/repovine-run-6.txt) [7](logs-sonnet5/repovine-run-7.txt) [8](logs-sonnet5/repovine-run-8.txt) [9](logs-sonnet5/repovine-run-9.txt) [10](logs-sonnet5/repovine-run-10.txt) — passes: [1](logs-sonnet5/repovine-run-1.txt) [2](logs-sonnet5/repovine-run-2.txt) [3](logs-sonnet5/repovine-run-3.txt) [4](logs-sonnet5/repovine-run-4.txt) [5](logs-sonnet5/repovine-run-5.txt) [6](logs-sonnet5/repovine-run-6.txt) [8](logs-sonnet5/repovine-run-8.txt)
- Repovine, `fable-5`: [1](logs-fable5/repovine-run-1.txt) [2](logs-fable5/repovine-run-2.txt) [3](logs-fable5/repovine-run-3.txt) [4](logs-fable5/repovine-run-4.txt) [5](logs-fable5/repovine-run-5.txt) [6](logs-fable5/repovine-run-6.txt) [7](logs-fable5/repovine-run-7.txt) [8](logs-fable5/repovine-run-8.txt) [9](logs-fable5/repovine-run-9.txt) [10](logs-fable5/repovine-run-10.txt) — passes: all

## Validity

| Aspect | Control or limit |
|---|---|
| experimental control | both arms use the same prompt, pin, model, effort, fresh context, disabled cross-run memory, and native Kibana instructions and skills. The Repovine setup is the controlled treatment |
| source validity | both arms can derive the full change from `getMappedParams`, `mapped_params_utils.ts`, the prior 8.2 migration, and the projection tests. The native encrypted-saved-objects guidance covers the co-located AAD coupling; no native skill states the mapped-params recomputation requirement |
| correctness construct | normalizing `params.severity` without recomputing its stored `mapped_params.severity` projection leaves find, sort, and filter behavior on the previous value. Repository tests establish that those readers use the projection. The annotation states the consistency requirement and omits the transform recipe |
| scoring | the final model-version transform must contain C1 and write the recomputed projection directly or through `getMappedParams` or the repository projection map. The verdict is derived from the final diff and does not depend on model narration |
| scope and limits | the case measures one alerting mapped-params seam. G1 scores projection recomputation only; the sibling AAD re-encryption coupling and broader migration quality are outside this gate |
