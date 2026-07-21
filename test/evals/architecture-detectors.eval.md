---
id: architecture-detectors
title: Architecture detector smoke and security categories
mode: read-only
repo_agnostic: true
applies_when: always
budget: { tool_calls: 13, mode: full }   # quick subset: arch-callable, empty-diagnostic
rollup: worst-of
checks:
  - id: arch-callable
    assert:  analyze_architecture({ scope:<pkg>, categories:["boundary","god-module"] }) returns findings or a valid empty result
    fail_if: the call crashes or returns a schema error on a valid package scope
    severity: fail
  - id: empty-diagnostic
    assert:  an empty result carries an emptyDiagnostic explaining why (too small / no matches), not silent emptiness or a crash
    fail_if: an empty result is indistinguishable from an error, or crashes
    severity: warn
  - id: detail-expansion
    assert:  passing a finding's detailFindingId back expands that one candidate
    fail_if: detailFindingId is rejected or returns an unrelated finding
    na_if:   no findings were produced to expand
    severity: warn
  - id: security-categories
    assert:  security categories (secret-config-boundary, authorization-policy-drift, trust-boundary-validation, privileged-client-side-effect, sensitive-browser-storage, server-client-boundary, source-disclosure-surface, annotation-secret-hygiene, annotation-risk) are accepted
    fail_if: a documented security category is rejected as unknown or schema-errors
    severity: warn
  - id: strictness-thresholds
    assert:  strictness:"strict" and analyze_architecture.thresholds knobs are accepted and reduce noisy findings
    fail_if: strictness/thresholds args are rejected as unknown
    na_if:   repo is too small to produce any findings to tune
    severity: warn
  - id: annotation-reasoning
    assert:  analyze_architecture({ annotationReasoning:"on" }) attaches an annotationContext to findings — question + relevantFields + nodes[].annotation carrying ONLY picked relevant fields (not full annotation blobs) + annotationFresh; nodes lacking annotations yield null slices, not a crash
    fail_if: annotationReasoning:"on" is rejected as unknown, returns full annotation blobs instead of the picked relevantFields, or crashes when implicated nodes are unannotated
    na_if:   repo has no annotations (coveragePct 0) OR analyze_architecture produces zero findings to enrich
    severity: warn
  - id: annotation-gated-findings
    assert:  annotation CONTENT shapes WHICH findings are produced, not only their enrichment — a module annotated sideEffects:[{kind:"pure"}] is suppressed from client-business-logic / effect-spaghetti candidates (un-annotated modules are treated as not-pure and stay eligible), so the same scope can yield a different candidate set before vs after annotation onboarding
    fail_if: a module whose annotation declares it pure is still reported as a client-side-effect smell (effect detector ignores annotation content)
    na_if:   repo has no annotations (coveragePct 0), or no pure-annotated module falls in the effect-detector candidate set this run
    severity: warn
  - id: category-names-current
    assert:  every documented detector category slug (structural, frontend, security, annotation) is a CURRENT canonical name accepted by analyze_architecture — v1 has no legacy/deferred category aliases
    fail_if: a documented category slug is rejected as unknown, or a current slug (e.g. client-business-logic) is treated as a legacy/deferred name
    severity: warn
---

You are a read-only repovine MCP architecture-detector agent. Smoke-test analyze_architecture:
findings vs valid-empty, detail expansion, security categories + strictness knobs, and the two
annotation-driven paths — `annotationReasoning:"on"` enrichment and annotation-content gating of the
finding set. This is a smoke test, not a category-rename audit and not an auto-edit pass.

Honor the shared preamble in `_PREAMBLE.md`. Session id e.g. `arch-YYYY-MM-DD-<repo-slug>`.

## Steps

1. **Pick a scope.** From search/map, choose one representative `pkg:` or `domain:`.

2. **Baseline detectors** → `arch-callable`, `empty-diagnostic`, `detail-expansion`.
   `analyze_architecture({ scope: "<pkg>", categories: ["boundary","god-module"], limit: 8, contextSessionId })`.
   If findings exist, expand one:
   `analyze_architecture({ scope: "<pkg>", detailFindingId: "<category:finding-id>", contextSessionId })`.
   If empty, confirm an `emptyDiagnostic` explains why.

3. **Security categories** → `security-categories`, `strictness-thresholds`.
   `analyze_architecture({ scope: "<pkg>", categories: ["secret-config-boundary","authorization-policy-drift","trust-boundary-validation","privileged-client-side-effect","sensitive-browser-storage","server-client-boundary","source-disclosure-surface","annotation-secret-hygiene","annotation-risk"], minConfidence: 0.6, contextSessionId })`.
   Re-run one with `strictness: "strict"` and confirm the args are accepted.

4. **Annotation reasoning** → `annotation-reasoning`.
   `analyze_architecture({ scope: "<pkg>", annotationReasoning: "on", limit: 8, contextSessionId })`.
   This is the annotation-driven path: each finding the agent should judge against
   `repovine.annots.json` carries an `annotationContext` with a `question`, `relevantFields`, and
   `nodes[].annotation` exposing ONLY the picked relevant fields (never the full annotation blob)
   plus `annotationFresh`. Confirm: (a) the arg is accepted; (b) where findings exist on annotated
   nodes, `annotationContext` is attached and field-scoped; (c) implicated nodes without annotations
   yield null `annotation` slices rather than crashing. N/A when `coveragePct` is 0 (nothing to
   reason over) or no findings are produced. The *content quality* of those annotations is graded by
   the `annotation-quality` card — here only the consumer contract is checked.

5. **Annotation-gated finding set** → `annotation-gated-findings`.
   Annotation content also changes which findings fire, independent of `annotationReasoning`. Run the
   effect/client-business-logic detectors
   (`analyze_architecture({ scope: "<pkg>", categories: ["client-business-logic","effect-spaghetti"], contextSessionId })`)
   and cross-check the candidate modules against their annotations: a module whose annotation declares
   `sideEffects:[{kind:"pure"}]` must NOT appear as a client-side-effect smell (un-annotated modules
   are treated as not-pure and stay eligible). As INFO, note where annotation sensitivity/privilege
   (`hasSensitiveAnnotationData` / privileged side effects) raises a finding's `impact`. This is the
   cold-graph-vs-annotated differential: report it, do not try to mutate annotations to force it.
   N/A when `coveragePct` is 0 or no pure-annotated module is a candidate.

6. **Current category names** → `category-names-current`.
   Confirm the category slugs are the current canonical set (v1): client-business-logic,
   effect-spaghetti, god-module, etc. are LIVE detector names, not legacy/deferred renames. There is
   no legacy category alias to defer — the only failure here is a documented slug being rejected.

## Quick mode

Steps 1 and 2 (`arch-callable`, `empty-diagnostic`).

## Report format

- **Overall**: PASS / WARN / FAIL (`rollup: worst-of`).
- **Tested repo**: root, branch, short commit, `contextSessionId`.
- **Scope** used; finding counts by category.
- **Check matrix** (one row per `checks[]` id) with evidence (one expanded finding id if any).
- **Findings** by severity, each tagged repovine-gap / target-repo-limitation / N/A.
- **MCP calls made**; **context quality**; **INFO** notes (annotation sensitivity/privilege raising
  a finding's impact; the cold-graph-vs-annotated candidate-set delta).
