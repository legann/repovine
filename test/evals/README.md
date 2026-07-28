# repovine MCP eval cards

Repo-agnostic, **agent-driven** regression/audit prompts for the repovine MCP server.

These are **evals, not Jest tests.** Each card is run by a real LLM agent that has the
repovine MCP connected, against an **arbitrary target repository** (not a fixture). The agent
reads the card body, drives the MCP tools itself, and produces a PASS / WARN / FAIL report
scored against the card's header rubric.

> Deterministic, hermetic, fixture-based contract checks live in `test/unit/mcp/`,
> `test/integration/`, and the parity goldens — those run under `npm test`.
> Cards here are the complementary layer: *does an agent + this MCP behave correctly on a
> repo we have never seen?* They cost tokens and are non-deterministic, so they are **not**
> picked up by `npm test` (`.md`, not `.test.ts`).

## Anatomy of a card

```markdown
---
id: <kebab-id>                # stable, machine-readable
title: <human title>
mode: read-only               # read-only | mutating  (read-only must not change source/config/annots)
repo_agnostic: true
applies_when: always          # always | has_typescript | has_iac | has_web_frontend | has_annotations | is_repovine | ...
budget: { tool_calls: 12, mode: full }   # rough ceiling; cards may define a `quick` subset
rollup: worst-of              # overall = worst severity among non-N/A checks
checks:
  - id: <kebab-check-id>      # stable; lets a check be tracked across edits
    assert:  <what a PASS observes, in one line>
    fail_if: <the observable that makes it FAIL>
    na_if:   <when this surface is absent → N/A, never FAIL>   # optional
    severity: fail            # fail | warn  (worst non-N/A outcome a failing check yields)
---

<prompt body: discovery-driven steps, evidence gates, report format>
```

**Header = the rubric** (edit criteria in one place; every check has an `id`).
**Body = the prompt** the agent executes. Keep the body discovery-driven — derive every node
id/scope/package from MCP responses in the *target* repo; never hardcode vendor-specific/lambda/golden ids.

## Shared preamble

The read-only contract, session/build-readiness rules, discovery discipline, evidence gate,
verdict taxonomy, and rollup all live in **[`_PREAMBLE.md`](./_PREAMBLE.md)**. Cards reference it
instead of repeating it. `make-pasteable.sh` prepends it for cross-repo runs (see below).

## Severity taxonomy

| Verdict | Meaning |
|---------|---------|
| **PASS** | Observed behavior matches the check. |
| **WARN** | Coverage gap / sparse graph / audit-hygiene issue; not a broken contract. |
| **FAIL** | Broken core MCP behavior, a violated naming/contract invariant, tool crash/schema error, or a `fail_if` condition observed. |
| **N/A**  | The surface this check needs does not exist in the target repo (absence is normal). |
| **INFO** | A deferred rename / known-by-design behavior observed but explicitly not a failure. |

## Rollup

`rollup: worst-of` — the card's overall verdict is the worst severity among checks that resolved
to a real outcome. N/A and INFO never raise the verdict. A check that hit its `fail_if` yields its
declared `severity` (FAIL or WARN).

## Running a card (today)

**One card = one fresh agent session.** Each card owns a `contextSessionId` and its own
`get_context_session_quality` signal — never run two cards in the same chat (it pollutes both the
score and the context window).

- **In this repo** (auditing repovine / this monorepo): tell the agent
  *"Execute `test/evals/<id>.eval.md` against this repo, following `test/evals/_PREAMBLE.md`; output
  the report by the header matrix."* The agent opens the card + preamble itself (DRY).
- **Cross-repo** (auditing an external project that has no cards): produce a self-contained,
  pasteable prompt and paste it into a fresh agent that has repovine MCP connected there:

  ```bash
  ./test/evals/make-pasteable.sh entrypoint-coverage | pbcopy   # or | xclip -selection clipboard
  ```

  This concatenates `_PREAMBLE.md` + the card (header rubric + body) into one blob.

Score the returned report against the header `checks`. There is no automated runner yet — see below.

`manifest.json` lists every card (`id`, `title`, `applies_when`, `mode`, plus the machine-readable
`axis` and `profiles[]` — see below) — the index for picking a card or, later, for a runner.

## Two axes: build signals vs annotation quality

The cards separate **what the engine extracts** (build signals) from **how good the annotation
memory is** (annotation quality) — two independent things that the suite deliberately does not let
bleed into each other:

- **Build-signal cards** (the structural majority — `search-map-inspect`, `entrypoint-coverage`,
  `dependencies-boundaries`, `trace-flow-topology`, `config-surface`, `naming-regression`,
  `polyglot-ts-python-iac`, `stack-applicability`, `build-and-sync-health`). These verify parsing,
  indexing, extraction, projection, and navigation. Their verdicts rest on **extracted structure**:
  the preamble's evidence gate forbids summarizing a PASS *from annotations alone*. Annotation text
  is part of the search index, so `search-map-inspect` sees more hits and different ranking at 99%
  coverage than at 0%.
- **Annotation-quality cards** (`annotation-health` for the mechanics; `annotation-quality` for the
  content — secrets/vocabulary/provenance/grounding). `annotation-quality` is gated
  `applies_when: has_annotations` and reports whole-card N/A when `coveragePct` is 0.
- **Annotation *consumers*** stay with their tool: `architecture-detectors`
  (`annotation-reasoning`, `annotation-gated-findings`) checks that `analyze_architecture` reads the
  annotation memory correctly — `annotationReasoning:"on"` attaches a field-scoped `annotationContext`
  with graceful null slices, AND annotation content gates the finding set itself (a module annotated
  `pure` is suppressed from the `client-business-logic` finding), so the same scope yields a
  different candidate set before vs after onboarding. The *data* those paths read is graded by
  `annotation-quality`.

**Run profiles.** The same cards can be run against two target states to isolate the axes:

| Profile | Target state | Best for |
|---------|--------------|----------|
| **cold-graph** | freshly built graph, **before annotation onboarding** (`coveragePct` 0) | Truest build-signal regression: modules indexed/parsed, entrypoints/edges/config extracted, with no annotations able to mask a broken extractor. `annotation-quality` is whole-card N/A here. |
| **annotated** | graph after annotation onboarding (`coveragePct` > 0) | Annotation coverage/queue/merge **and** content quality, plus the `annotation-reasoning` consumer path. Build-signal cards pass on the same extracted structure; annotation text adds search hits and shifts ranking. |

Running the build-signal cards cold turns the preamble's "do not lean on annotations" *instruction*
into an *enforced invariant* (there are no annotations to lean on), so a green build-signal card on a
cold graph is the strongest evidence the extractor itself is sound.

**Both axes are machine-readable in `manifest.json`** (v2), so selection is deterministic rather than
prose. Each card carries `axis` (`build-signal` | `annotation-quality` | `meta`) and `profiles[]`
(subset of `cold-graph` / `annotated`); the top-level `axes` and `profiles` objects describe each and
give the `select` rule. A runner picks a profile by filtering `profiles[]`:

```bash
# cold-graph set = build-signal regression with no annotations to mask a broken extractor
jq -r '.cards[] | select(.profiles | index("cold-graph")) | .id' manifest.json
# annotated set = adds annotation-quality + the annotation-driven analyze_architecture paths
jq -r '.cards[] | select(.profiles | index("annotated")) | .id' manifest.json
# everything on one axis
jq -r '.cards[] | select(.axis == "annotation-quality") | .id' manifest.json
```

Only `annotation-quality` is excluded from `cold-graph` (whole-card N/A at 0%); `architecture-detectors`
additionally carries `consumes_annotations: true` because its `annotation-reasoning` /
`annotation-gated-findings` checks read the annotation memory (they go N/A cold).

## Optional future: `repovine evals run`

A thin runner can parse the frontmatter, bring up the MCP (in-process `toolHandlers` registry or
stdio JSON-RPC — both already exist), hand body+rubric to an agent via the Claude API, collect the
PASS/WARN/FAIL report, and diff it against `checks`. Build it only once ~5–6 cards have settled.
`promptfoo` (MCP-aware, rubric `assert`) is the fallback if a generic runner is ever wanted.

## Adding a card

1. Copy `_TEMPLATE.eval.md` to `<id>.eval.md`.
2. Fill the header rubric: one `checks[]` entry per observable invariant, each with a stable `id`.
3. Write a discovery-driven body; reference the shared preamble instead of repeating it.
4. Register it in `manifest.json` with `axis` and `profiles[]` (exclude `cold-graph` only when the
   whole card is N/A without annotations; set `consumes_annotations: true` if some checks read the
   annotation memory but the card still runs cold).
5. Keep one capability per card. Prefer several small cards over one monolith so the rubric stays
   editable and subsets are runnable.
