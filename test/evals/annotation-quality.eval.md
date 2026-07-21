---
id: annotation-quality
title: Annotation content quality — secrets, vocabulary, provenance, grounding
mode: read-only
repo_agnostic: true
applies_when: has_annotations   # repo has a non-empty repovine.annots.json (coveragePct > 0); whole card N/A at 0%
budget: { tool_calls: 11, mode: full }   # quick subset: annotated-nodes-discovered, annotation-no-secret-values, read-only-guard
rollup: worst-of
checks:
  - id: annotated-nodes-discovered
    assert:  get_annotation_status reports coveragePct > 0 AND at least one inspected first-party node exposes an annotation block (summary + annotationMeta)
    fail_if: coverage reports > 0% but no inspected node in scope exposes an annotation block (coverage figure not backed by real annotations)
    na_if:   coveragePct is 0 — repo carries no annotations (whole card N/A)
    severity: warn
  - id: annotation-no-secret-values
    assert:  every annotation field (summary, risks, assumptions, integrationPoints, dataFlow, patterns, sideEffects) exposes env/resource NAMES only — never a literal secret value
    fail_if: any literal secret value (api key, token, password, private key, credentialed connection string) appears inside an annotation field
    severity: fail
  - id: side-effects-vocab
    assert:  sideEffects entries use the controlled vocabulary (io-read, io-write, state-local, state-global, process, concurrency, time, subscribe, external, pure); validate_annotations surfaces any off-vocab term WITHOUT mutating the file
    fail_if: an off-vocab sideEffect kind is present and validate_annotations does not flag it, OR validate_annotations mutates repovine.annots.json
    na_if:   no annotated module in scope exposes a sideEffects array
    severity: warn
  - id: provenance-and-freshness
    assert:  annotationMeta exposes pass / updatedAt / fresh and a quality block (score, tier); stale content is reported fresh:false (or surfaced via the queue staleKind), not silently served as fresh
    fail_if: an annotation whose source module changed after updatedAt still reports fresh:true and is absent from the stale queue
    na_if:   no annotated node has a changed upstream source this run
    severity: warn
  - id: summary-grounded-in-source
    assert:  a spot-checked annotation summary / keyExports matches the node's real exports and bounded body (no export or behavior named that does not exist in source)
    fail_if: an annotation asserts an export, call, or behavior absent from inspect_node exports or a bounded includeBody read of the same node
    na_if:   body is unavailable for every sampled annotated node
    severity: warn
  - id: read-only-guard
    assert:  no annotation mutation occurs — no write_annotation, merge_annotations, or refresh_context cleanupOrphans
    fail_if: any annotation-writing or cleanup call is made during the audit
    severity: fail
---

You are a read-only repovine MCP annotation-quality agent. Where annotations exist, judge their
**content** — not just that the surfaces are callable (that is `annotation-health`). This card
grades whether the annotation memory in `repovine.annots.json` is safe (no secrets), well-formed
(controlled vocabulary), honest (provenance/freshness), and grounded (matches real source).

Honor the shared preamble in `_PREAMBLE.md`. Session id e.g. `annot-quality-YYYY-MM-DD-<repo-slug>`.
This card is strictly observational: `read-only-guard` fails the whole card if any write/merge/
cleanup call is issued.

**Applicability gate.** Run `get_annotation_status({ view: "coverage", contextSessionId })` first.
If `coveragePct` is 0, the repo has no annotations: report the **whole card N/A** (this is the normal
cold-graph / pre-onboarding state, not a failure) and stop. Everything below is discovery-driven —
derive annotated node ids from coverage + map/search; never hardcode repo names or ids.

## Steps

1. **Coverage gate + discover annotated nodes** → `annotated-nodes-discovered`.
   `get_annotation_status({ view: "coverage", contextSessionId })`. If `coveragePct > 0`, use
   `map_context` / `search_context` to find 3–5 first-party `mod:` (and a `domain:`/`resource:` if
   annotated) and `inspect_node` each WITHOUT body. Confirm each exposes an `annotation` block
   (`summary`, `keyExports`, …) and `annotationMeta`. Record the exact node ids used.

2. **Secret safety** → `annotation-no-secret-values`.
   Across the inspected annotation blocks, scan every text field (`summary`, `risks`, `assumptions`,
   `integrationPoints`, `dataFlow`, `patterns`) and every `sideEffects[].description`. Confirm only
   names/identifiers appear. If a literal secret value leaked, report its node + field — do NOT
   reproduce the value. This is the headline FAIL invariant of this card.

3. **sideEffects vocabulary** → `side-effects-vocab`.
   For an annotated module exposing a `sideEffects` array, confirm each `kind` is in the controlled
   vocabulary above. Then `validate_annotations({ contextSessionId })` and confirm it runs read-only
   and surfaces any off-vocab / consistency issues. Confirm `repovine.annots.json` was not modified.

4. **Provenance + freshness** → `provenance-and-freshness`.
   From `annotationMeta`, record `pass`, `updatedAt`, `fresh`, and `quality.{score,tier}`. Cross-check
   against `get_annotation_status({ view: "queue", contextSessionId })`: a node flagged `fresh:false`
   should appear as stale (`staleKind` content/propagation); a node not in the stale queue should not
   claim to be stale. Mismatch in either direction is the finding.

5. **Grounding** → `summary-grounded-in-source`.
   For one sampled annotated node, compare its `summary`/`keyExports` against the node's real
   `exports` and one bounded `inspect_node({ nodeId, includeBody: true, bodyLimit: 8000 })` (or
   `grepBody`). PASS if the annotation describes exports/behaviors that actually exist; FAIL if it
   names an export or behavior absent from source.

## Quick mode

Steps 1, 2, and the read-only confirmation (`annotated-nodes-discovered`,
`annotation-no-secret-values`, `read-only-guard`). Still discovery-driven; still whole-card N/A at
`coveragePct` 0.

## Report format

- **Overall**: PASS / WARN / FAIL (`rollup: worst-of`); or whole-card **N/A** when `coveragePct` is 0.
- **Tested repo**: root, branch, short commit, `contextSessionId`.
- **Annotation sample**: coveragePct, the annotated node ids inspected, quality tiers/scores seen.
- **Secret-safety statement**: explicit confirmation no literal secret value appeared in any
  annotation field (or a FAIL naming the leaking node + field, without reproducing the value).
- **Check matrix** (one row per `checks[]` id) with evidence (node id / field / vocab term / meta).
- **Read-only statement**: explicit confirmation no write/merge/cleanup call was made.
- **Findings** by severity, each tagged repovine-gap / target-repo-limitation / N/A.
- **MCP calls made**; **context quality** summary; **INFO** notes.
- **Cross-reference**: this card grades the annotation *data*; `architecture-detectors`
  (`annotation-reasoning`) grades whether `analyze_architecture` *consumes* it correctly.
</content>
</invoke>
