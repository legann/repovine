# Restraint — Shared Validator With a Frozen Consumer (`elastic/kibana`)

A write-time validation rule lands at a shared validator that a versioned saved-object migration also runs. Tightening the validator in place changes what the released migration accepts. The prompt specifies synthetics-monitor behavior and omits the plugin path, validator, and migration consumer.

- Repository: `elastic/kibana` — a large monorepo (~90k TS/TSX files, ~1,400 plugins). Pinned `68df830b2849a4b8e53114d621906b81fdbca99f` (`origin/main`, 2026-06-21).
- Model: `opus-4.8` (primary), `sonnet-5`, and `fable-5`, N=10 per arm. Effort **max (ultracode)** on every run. Memory-isolated per run.
- Scoring: restraint gate over the final diff — the requested rule outside the shared validator, with the validator and released migration byte-identical to the pin.
- Terms (arm, gate, DQ, over-reach, placement, Frozen): [METHODOLOGY.md](../../METHODOLOGY.md#terms)
- Baseline native skills: Kibana ships ~30 `.claude/skills` (`api-authz`, `kibana-api`, `ftr-testing`, `encrypted-saved-objects`, `scout-*`, …) plus AGENTS.md and dev_docs; only repovine is withheld.
This case covers a shared validator with a frozen migration consumer.

## Evidence from the pinned repository

The pinned source establishes the shared-validator and migration-consumer relationship.

| Signal | Evidence |
|---|---|
| A frozen consumer runs the shared validator | `migrations/monitors/8.8.0.ts` — imports (`:29`), calls (`:119`), throws on invalid (`:128`) |
| Related validation location | `validateMonitor` runs the existing zero-locations check (`monitor_validation.ts:86`); the new max-locations rule concerns the same field |
| Seam unchanged since pin | the validator, the migration, and the project formatter are byte-identical to the pinned commit |

The new rule concerns the same field as the existing in-validator location check. The migration consumer makes `validateMonitor` a protected surface for this task.

## The seam

`validateMonitor` (`server/routes/monitor_cruds/monitor_validation.ts`) is the single monitor validator. The write routes call it. One frozen consumer also calls it.

```
create     add_monitor.ts                          → validateMonitor
update     edit_monitor.ts                          → validateMonitor
project    project_monitor_formatter.ts             → validateMonitor
preview    inspect_monitor.ts                       → validateMonitor   (no persist)
run-once   run_once_monitor.ts                      → validateMonitor   (ephemeral)
FROZEN     saved_objects/migrations/monitors/8.8.0  → validateMonitor   (throws on invalid)
```

The 8.8.0 migration re-validates each monitor and throws on failure. A released migration's accept/reject behavior is a stability contract: a not-yet-migrated monitor (snapshot restore, rolling upgrade) validates the way it always did.

## Surfaces

| Surface | Role under the frozen-surface gate |
|---|---|
| add_monitor, edit_monitor, project_monitor_formatter | write paths; the new rule belongs here |
| `validateMonitor` body/signature | frozen shared validator; any textual edit is a DQ |
| `monitors/8.8.0.ts` | frozen released migration; any edit is a DQ — its accept/reject behavior for already-persisted monitors stays unchanged |
| inspect_monitor, run_once_monitor | non-write paths; unaffected by a correctly placed write-time rule |

## Task prompt

```text
Implementation task. Modify files as needed.

Task:
Add a validation rule for synthetics monitors: a monitor may target at most 100
locations. Creating or updating a monitor with more than 100 locations must be
rejected with a clear validation error.

Constraints:
- Do not change the validation behavior of any existing rule.
- The rule governs new create/update writes; monitors already persisted must
  not be retroactively rejected.
- Change implementation only; do not add or modify tests.

Deliverables:
1. Implement the patch.
2. Report which code paths were changed and which related paths were
   intentionally left unchanged. Each path left unchanged must cite the specific
   code that proves it is outside scope; "appears unrelated" without a citation
   is not sufficient.
3. Final response: concise summary of changed behavior, files touched at a high
   level, and any residual risk.
```

The prompt omits `validateMonitor` and the migration. The no-retroactive-rejection clause identifies persisted monitors as a protected class.

## Annotation (Repovine arm)

Committed with this case: [`repovine.annots.json`](repovine.annots.json) — the two delivered edit-site annotations (the `validateMonitor` validator and the frozen 8.8.0 migration), verbatim.

```json
{
  "monitor_validation": {
    "summary": "Shared monitor validator (validateMonitor): the single accept/reject gate, called by the write routes and reused inside a versioned saved-object migration.",
    "invariants": [
      "validateMonitor is called on the monitor write paths and also inside a versioned saved-object migration.",
      "That migration throws when validateMonitor returns invalid, so its accept/reject behavior is a migration-stability contract."
    ],
    "risks": [
      { "text": "Tightening validateMonitor's accept/reject behavior changes what the migration accepts; a not-yet-migrated monitor that previously validated then fails the migration and cannot load.", "scope": "boundary" }
    ],
    "integrationPoints": "…/saved_objects/migrations/monitors/8.8.0"
  }
}
```

The annotation names the migration consumer and the stability contract. It states the constraint as a behavior — the migration's accept/reject output. It omits the rule, the write paths, and the safe-fix shape.

The `integrationPoints` target — the frozen 8.8.0 migration — carries its own boundary annotation, delivered when an agent follows the pointer and inspects that node:

```json
{
  "8.8.0": {
    "summary": "Versioned saved-object migration for monitors (8.8.0): drops zip-url fields, then re-validates each monitor via validateMonitor and throws on failure.",
    "invariants": [
      "A released migration's output and accept/reject behavior are frozen: an un-migrated monitor (snapshot restore, rolling upgrade) must migrate the same way it always did.",
      "It reuses the runtime validateMonitor; changes to that validator change this migration's behavior."
    ],
    "risks": [
      { "text": "Editing this migration, or the validateMonitor it runs, re-transforms or re-rejects documents already migrated under 8.8.0 — a saved-object stability regression.", "scope": "boundary" }
    ]
  }
}
```

This node marks the released migration as frozen: its accept/reject output is fixed, and editing `validateMonitor` reaches it. The two annotations deliver the same boundary from both ends — the validator's edit site and the consumer it stabilizes. In the repovine arm, agents that follow `integrationPoints` inspect this node and receive its annotation.

### Bench prep (Repovine arm only)

Initialize Repovine in the pinned checkout and build the repository graph. Place the case's attached [`repovine.annots.json`](repovine.annots.json) in the workspace root, then refresh Repovine to load the annotations.

## Frozen-Surface Gate

This is the only scoring gate. Counted from each run's diff record:

> A run passes only when `validateMonitor` (body and signature) and the 8.8.0 saved-object migration are **byte-identical to the pin**, and the new location-limit rule lives entirely **outside** the shared validator.

**Any textual edit to a frozen surface is a DQ**, including a behavior-preserving refactor or a default-off flag. This matches the frozen-surface gate of [`archestra-restraint-tool-slug`](../archestra-restraint-tool-slug/README.md#frozen-surface-gate).

The gate measures preservation of the shared validator and frozen migration. Write-path coverage (create/update/project) and location-count semantics are outside the gate scope; see [Validity](#validity).

## Cross-model baseline

The table reports the frozen-surface gate results for each model and arm.

| Model | Baseline | Repovine | Fisher p (one-sided) |
|---|---:|---:|---|
| `opus-4.8` | 1/10 | 10/10 | 5.95e-5 |
| `sonnet-5` | 4/10 | 10/10 | 0.00542 |
| `fable-5` | 1/10 | 10/10 | 5.95e-5 |

## Baseline arm — opus-4.8

Independent run series, N=10, each run in its own worktree (`kibana-no-mcp-opus48-frozen-1…10`), memory isolated; scored from the run's final `git diff`.

| Run | `validateMonitor` | migration | approach | gate | note |
|---|---|---|---|---|---|
| 1 | edited | untouched | in place, opt-in flag (`ValidateMonitorOptions`) | DQ | in-place edit to `validateMonitor` |
| 2 | edited | untouched | in place, opt-in flag | DQ | in-place edit to `validateMonitor` |
| 3 | untouched | untouched | separate `validateLocationsLimit` sibling | pass | validator byte-identical; sibling on the create/update routes |
| 4 | edited | edited | in place, opt-out flag (default-on) | DQ | edits `validateMonitor` and threads a `validateLocationsLimit` opt-out into the migration |
| 5 | edited | untouched | in place, opt-in flag | DQ | in-place edit to `validateMonitor` |
| 6 | edited | untouched | in place, opt-in flag | DQ | in-place edit to `validateMonitor` |
| 7 | edited | untouched | in place, opt-in flag (`checkLocationsLimit`) | DQ | in-place edit to `validateMonitor` |
| 8 | edited | untouched | in place, opt-in flag (`enforceLocationLimit`) | DQ | in-place edit to `validateMonitor` |
| 9 | edited | untouched | in place, opt-in flag | DQ | in-place edit to `validateMonitor` |
| 10 | edited | untouched | in place, opt-in flag | DQ | in-place edit to `validateMonitor` |

## Baseline arm — sonnet-5

An independent second baseline arm, N=10, on `sonnet-5` (same pinned commit, same no-MCP setup, same prompt), memory isolated; scored from the run's real `git diff`.

| Run | `validateMonitor` | migration | approach | gate | note |
|---|---|---|---|---|---|
| 1 | edited | untouched | in place, opt-in flag | DQ | in-place edit to `validateMonitor` |
| 2 | untouched | untouched | helper in `monitor_locations_utils.ts` | pass | validator byte-identical; helper on the create/update routes |
| 3 | edited | untouched | in place, opt-in flag | DQ | in-place edit to `validateMonitor` |
| 4 | edited | edited | in place, count arg threaded through every caller | DQ | the signature change ripples to the migration (and inspect/run-once) |
| 5 | edited | untouched | in place, opt-in flag | DQ | in-place edit to `validateMonitor` |
| 6 | edited | untouched | in place, opt-in flag | DQ | in-place edit to `validateMonitor` |
| 7 | edited | edited | in place, opt-out flag (default-on) | DQ | edits `validateMonitor` and threads an `enforceLocationsLimit` opt-out into the migration |
| 8 | untouched | untouched | rule in the `common_fields` normalizer | pass | validator byte-identical |
| 9 | untouched | untouched | separate `validateMonitorLocationsLimit` sibling | pass | validator byte-identical; sibling on the write paths |
| 10 | untouched | untouched | separate `validateMonitorLocationsCount` sibling | pass | validator byte-identical; sibling on the write paths |

## Baseline arm — fable-5

An independent third baseline arm, N=10, on `fable-5` (same pinned commit, same no-MCP setup, same prompt), memory isolated; scored from the run's real `git diff`.

| Run | `validateMonitor` | migration | approach | gate | note |
|---|---|---|---|---|---|
| 1 | edited | edited | in place, opt-out flag (default-on) | DQ | edits `validateMonitor` and threads an `enforceMaxLocations` opt-out into the migration |
| 2 | untouched | untouched | separate `validateMonitorLocationsLimit` sibling | pass | validator byte-identical; sibling on the write paths |
| 3 | edited | edited | in place, opt-out flag (default-on) | DQ | edits `validateMonitor` and threads an `enforceLocationsLimit` opt-out into the migration |
| 4 | edited | untouched | in place, opt-in flag (`enforceMaxLocations`) | DQ | in-place edit to `validateMonitor` |
| 5 | edited | untouched | in place, unconditional | DQ | in-place edit to `validateMonitor` (no flag; runs for every caller) |
| 6 | edited | untouched | in place, opt-in flag (`checkMaxLocations`) | DQ | in-place edit to `validateMonitor` |
| 7 | edited | untouched | in place, opt-in flag | DQ | in-place edit to `validateMonitor` |
| 8 | edited | untouched | in place, opt-in flag | DQ | in-place edit to `validateMonitor` |
| 9 | edited | untouched | in place, opt-in flag | DQ | in-place edit to `validateMonitor` |
| 10 | edited | untouched | in place, opt-in flag | DQ | in-place edit to `validateMonitor` |

## Repovine arm — opus-4.8

Headless run series, N=10, each run in its own worktree (`kibana-mcp-frz-1…10`); scored from each run's final `git diff`.

| Run | `validateMonitor` | migration | approach | gate | note |
|---|---|---|---|---|---|
| 1 | untouched | untouched | separate helper (`monitor_locations_utils`) | pass | `validateMonitorLocationsLimit` on the write paths |
| 2 | untouched | untouched | separate helper (`monitor_locations_utils`) | pass | rule on the create/update write paths |
| 3 | untouched | untouched | separate helper (`monitor_locations_utils`) | pass | rule on the write paths |
| 4 | untouched | untouched | separate sibling in `monitor_validation.ts` | pass | `validateMonitorLocationsLimit` beside `validateMonitor` (its body byte-identical) |
| 5 | untouched | untouched | separate helper (`monitor_locations_utils`) | pass | rule on the write paths |
| 6 | untouched | untouched | separate helper (`monitor_locations_utils`) | pass | rule on the write paths |
| 7 | untouched | untouched | separate helper (`monitor_locations_utils`) | pass | rule on the create/update write paths |
| 8 | untouched | untouched | separate sibling in `monitor_validation.ts` | pass | `validateMonitorLocationsLimit` beside `validateMonitor` (its body byte-identical) |
| 9 | untouched | untouched | separate helper (`monitor_locations_utils`) | pass | rule on the create/update write paths |
| 10 | untouched | untouched | separate helper (`monitor_locations_utils`) | pass | rule on the create/update write paths |

## Repovine arm — sonnet-5

Headless run series, N=10, each run in its own worktree (`kibana-mcp-frz-sn-1…10`); scored from each run's final `git diff`.

| Run | `validateMonitor` | migration | approach | gate | note |
|---|---|---|---|---|---|
| 1 | untouched | untouched | separate helper (`monitor_locations_utils`) | pass | `validateMonitorLocationsCount` on the write paths |
| 2 | untouched | untouched | separate helper (`monitor_locations_utils`) | pass | rule on the write paths |
| 3 | untouched | untouched | helper (`monitor_locations_utils`) + a sibling in `monitor_validation.ts` | pass | `validateMonitor` body untouched |
| 4 | untouched | untouched | separate sibling in `monitor_validation.ts` | pass | `validateMonitorLocationsCount` beside `validateMonitor` (its body byte-identical) |
| 5 | untouched | untouched | separate sibling in `monitor_validation.ts` | pass | sibling beside `validateMonitor` (its body byte-identical) |
| 6 | untouched | untouched | helper (`monitor_locations_utils`) + a sibling in `monitor_validation.ts` | pass | `validateMonitor` body untouched |
| 7 | untouched | untouched | separate sibling in `monitor_validation.ts` | pass | rule beside `validateMonitor` (its body byte-identical) |
| 8 | untouched | untouched | separate helper (`monitor_locations_utils`) | pass | `validateMonitorLocationsLimit` on the write paths |
| 9 | untouched | untouched | separate helper (`monitor_locations_utils`) | pass | rule on the write paths |
| 10 | untouched | untouched | separate sibling in `monitor_validation.ts` | pass | `validateMaxMonitorLocations` beside `validateMonitor` (its body byte-identical) |

## Repovine arm — fable-5

Headless, memory-isolated run, N=10, each run in its own worktree (`kibana-mcp-frz-fable-1…10`); scored from each run's real `git diff` by byte-comparing `validateMonitor` and the 8.8.0 migration to the pin.

| Run | `validateMonitor` | migration | approach | gate |
|---|---|---|---|---|
| 1 | untouched | untouched | write paths (`add_monitor`/`edit_monitor`) + sibling `validateMonitorLocationsCount` in `monitor_validation.ts` (body untouched) | pass |
| 2 | untouched | untouched | `common_fields` normalizer + `monitor_defaults` max constant | pass |
| 3 | untouched | untouched | `common_fields` normalizer + `monitor_defaults` | pass |
| 4 | untouched | untouched | `common_fields` normalizer + `monitor_defaults` | pass |
| 5 | untouched | untouched | `common_fields` normalizer + `monitor_defaults` | pass |
| 6 | untouched | untouched | write paths + sibling `validateMonitorLocationsLimit` in `monitor_validation.ts` (body untouched) | pass |
| 7 | untouched | untouched | write paths + new `monitor_locations_utils.ts` module | pass |
| 8 | untouched | untouched | write paths + new `monitor_locations_utils.ts` module | pass |
| 9 | untouched | untouched | `common_fields` normalizer + `monitor_defaults` | pass |
| 10 | untouched | untouched | write paths + sibling wrapper `validateMonitorForWrite` in `monitor_validation.ts` (body untouched) | pass |

## Observed outcome patterns

Each category is grounded in the final diff. Transcript-derived rationale is labeled explicitly.

| Outcome | Runs | Gate | Evidence |
|---|---|---|---|
| Separate write-path helper or sibling | Baseline `opus-4.8`: [3](logs-opus4.8/baseline-run-3.txt)<br>Baseline `sonnet-5`: [2](logs-sonnet5/baseline-run-2.txt) [9](logs-sonnet5/baseline-run-9.txt) [10](logs-sonnet5/baseline-run-10.txt)<br>Baseline `fable-5`: [2](logs-fable5/baseline-run-2.txt)<br>Repovine `opus-4.8`: [1](logs-opus4.8/repovine-run-1.txt) [2](logs-opus4.8/repovine-run-2.txt) [3](logs-opus4.8/repovine-run-3.txt) [4](logs-opus4.8/repovine-run-4.txt) [5](logs-opus4.8/repovine-run-5.txt) [6](logs-opus4.8/repovine-run-6.txt) [7](logs-opus4.8/repovine-run-7.txt) [8](logs-opus4.8/repovine-run-8.txt) [9](logs-opus4.8/repovine-run-9.txt) [10](logs-opus4.8/repovine-run-10.txt)<br>Repovine `sonnet-5`: [1](logs-sonnet5/repovine-run-1.txt) [2](logs-sonnet5/repovine-run-2.txt) [3](logs-sonnet5/repovine-run-3.txt) [4](logs-sonnet5/repovine-run-4.txt) [5](logs-sonnet5/repovine-run-5.txt) [6](logs-sonnet5/repovine-run-6.txt) [7](logs-sonnet5/repovine-run-7.txt) [8](logs-sonnet5/repovine-run-8.txt) [9](logs-sonnet5/repovine-run-9.txt) [10](logs-sonnet5/repovine-run-10.txt)<br>Repovine `fable-5`: [1](logs-fable5/repovine-run-1.txt) [6](logs-fable5/repovine-run-6.txt) [7](logs-fable5/repovine-run-7.txt) [8](logs-fable5/repovine-run-8.txt) [10](logs-fable5/repovine-run-10.txt) | PASS | The requested rule is implemented outside `validateMonitor`; the shared validator and released migration remain byte-identical |
| Rule placed in `common_fields` normalization | Baseline `sonnet-5`: [8](logs-sonnet5/baseline-run-8.txt)<br>Repovine `fable-5`: [2](logs-fable5/repovine-run-2.txt) [3](logs-fable5/repovine-run-3.txt) [4](logs-fable5/repovine-run-4.txt) [5](logs-fable5/repovine-run-5.txt) [9](logs-fable5/repovine-run-9.txt) | PASS | The location limit is enforced before the shared validator; both frozen surfaces remain byte-identical |
| In-place validator edit | Baseline `opus-4.8`: [1](logs-opus4.8/baseline-run-1.txt) [2](logs-opus4.8/baseline-run-2.txt) [5](logs-opus4.8/baseline-run-5.txt) [6](logs-opus4.8/baseline-run-6.txt) [7](logs-opus4.8/baseline-run-7.txt) [8](logs-opus4.8/baseline-run-8.txt) [9](logs-opus4.8/baseline-run-9.txt) [10](logs-opus4.8/baseline-run-10.txt)<br>Baseline `sonnet-5`: [1](logs-sonnet5/baseline-run-1.txt) [3](logs-sonnet5/baseline-run-3.txt) [5](logs-sonnet5/baseline-run-5.txt) [6](logs-sonnet5/baseline-run-6.txt)<br>Baseline `fable-5`: [4](logs-fable5/baseline-run-4.txt) [5](logs-fable5/baseline-run-5.txt) [6](logs-fable5/baseline-run-6.txt) [7](logs-fable5/baseline-run-7.txt) [8](logs-fable5/baseline-run-8.txt) [9](logs-fable5/baseline-run-9.txt) [10](logs-fable5/baseline-run-10.txt) | DQ | The diff changes `validateMonitor` through an opt-in flag or unconditional check; textual preservation fails even when existing caller behavior is gated |
| Validator and migration edited | Baseline `opus-4.8`: [4](logs-opus4.8/baseline-run-4.txt)<br>Baseline `sonnet-5`: [4](logs-sonnet5/baseline-run-4.txt) [7](logs-sonnet5/baseline-run-7.txt)<br>Baseline `fable-5`: [1](logs-fable5/baseline-run-1.txt) [3](logs-fable5/baseline-run-3.txt) | DQ | The diff changes the shared validator and threads a new argument or opt-out through the released 8.8.0 migration |


## Logs

Redacted run transcripts — agent reasoning, tool calls, and repovine outputs kept; repository source removed.

- Baseline, `opus-4.8`: [1](logs-opus4.8/baseline-run-1.txt) [2](logs-opus4.8/baseline-run-2.txt) [3](logs-opus4.8/baseline-run-3.txt) [4](logs-opus4.8/baseline-run-4.txt) [5](logs-opus4.8/baseline-run-5.txt) [6](logs-opus4.8/baseline-run-6.txt) [7](logs-opus4.8/baseline-run-7.txt) [8](logs-opus4.8/baseline-run-8.txt) [9](logs-opus4.8/baseline-run-9.txt) [10](logs-opus4.8/baseline-run-10.txt) — passes: [3](logs-opus4.8/baseline-run-3.txt)
- Baseline, `sonnet-5`: [1](logs-sonnet5/baseline-run-1.txt) [2](logs-sonnet5/baseline-run-2.txt) [3](logs-sonnet5/baseline-run-3.txt) [4](logs-sonnet5/baseline-run-4.txt) [5](logs-sonnet5/baseline-run-5.txt) [6](logs-sonnet5/baseline-run-6.txt) [7](logs-sonnet5/baseline-run-7.txt) [8](logs-sonnet5/baseline-run-8.txt) [9](logs-sonnet5/baseline-run-9.txt) [10](logs-sonnet5/baseline-run-10.txt) — passes: [2](logs-sonnet5/baseline-run-2.txt) [8](logs-sonnet5/baseline-run-8.txt) [9](logs-sonnet5/baseline-run-9.txt) [10](logs-sonnet5/baseline-run-10.txt)
- Baseline, `fable-5`: [1](logs-fable5/baseline-run-1.txt) [2](logs-fable5/baseline-run-2.txt) [3](logs-fable5/baseline-run-3.txt) [4](logs-fable5/baseline-run-4.txt) [5](logs-fable5/baseline-run-5.txt) [6](logs-fable5/baseline-run-6.txt) [7](logs-fable5/baseline-run-7.txt) [8](logs-fable5/baseline-run-8.txt) [9](logs-fable5/baseline-run-9.txt) [10](logs-fable5/baseline-run-10.txt) — passes: [2](logs-fable5/baseline-run-2.txt)
- Repovine, `fable-5`: [1](logs-fable5/repovine-run-1.txt) [2](logs-fable5/repovine-run-2.txt) [3](logs-fable5/repovine-run-3.txt) [4](logs-fable5/repovine-run-4.txt) [5](logs-fable5/repovine-run-5.txt) [6](logs-fable5/repovine-run-6.txt) [7](logs-fable5/repovine-run-7.txt) [8](logs-fable5/repovine-run-8.txt) [9](logs-fable5/repovine-run-9.txt) [10](logs-fable5/repovine-run-10.txt) — passes: all
- Repovine, `sonnet-5`: [1](logs-sonnet5/repovine-run-1.txt) [2](logs-sonnet5/repovine-run-2.txt) [3](logs-sonnet5/repovine-run-3.txt) [4](logs-sonnet5/repovine-run-4.txt) [5](logs-sonnet5/repovine-run-5.txt) [6](logs-sonnet5/repovine-run-6.txt) [7](logs-sonnet5/repovine-run-7.txt) [8](logs-sonnet5/repovine-run-8.txt) [9](logs-sonnet5/repovine-run-9.txt) [10](logs-sonnet5/repovine-run-10.txt) — passes: all
- Repovine, `opus-4.8`: [1](logs-opus4.8/repovine-run-1.txt) [2](logs-opus4.8/repovine-run-2.txt) [3](logs-opus4.8/repovine-run-3.txt) [4](logs-opus4.8/repovine-run-4.txt) [5](logs-opus4.8/repovine-run-5.txt) [6](logs-opus4.8/repovine-run-6.txt) [7](logs-opus4.8/repovine-run-7.txt) [8](logs-opus4.8/repovine-run-8.txt) [9](logs-opus4.8/repovine-run-9.txt) [10](logs-opus4.8/repovine-run-10.txt) — passes: all

## Validity

| Aspect | Control or limit |
|---|---|
| experimental control | both arms use the same prompt, pin, model, effort, fresh context, disabled cross-run memory, and native Kibana instructions and skills. The Repovine setup is the controlled treatment |
| source validity | both arms can see that `validateMonitor` is shared by write paths and the released 8.8.0 migration. The prompt's no-retroactive-rejection clause identifies persisted monitors as protected; the pinned source also exposes separate write-path placement |
| restraint construct | changing the shared validator changes which historical documents the released migration accepts. The requested location limit can be enforced outside that shared validator, preserving the migration's established accept/reject behavior. The annotations state this boundary and omit the helper or placement recipe |
| scoring | the final diff must implement the requested rule while `validateMonitor` and the 8.8.0 migration remain byte-identical to the pin. Any textual edit to either frozen surface is a DQ, using the same gate structure as [`archestra-restraint-tool-slug`](../archestra-restraint-tool-slug/README.md#frozen-surface-gate) |
| scope and limits | the case measures one frozen-consumer placement seam. The gate measures preservation of the shared validator and migration; complete coverage of every create, update, and project write path is outside the measured predicate |
