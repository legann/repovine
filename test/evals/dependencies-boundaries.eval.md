---
id: dependencies-boundaries
title: Dependency impact and package-boundary analysis
mode: read-only
repo_agnostic: true
applies_when: always
budget: { tool_calls: 10, mode: full }   # quick subset: impact-scope, export-scope-accepted
rollup: worst-of
checks:
  - id: impact-scope
    assert:  'analyze_dependencies({ scope:<mod>, mode:"impact", depth:2 }) returns dependents/dependencies referencing mod:/export:/pkg: ids'
    fail_if: 'the call errors on a valid mod: scope, or impact ids use the removed cap:/service: prefixes'
    severity: fail
  - id: export-scope-accepted
    assert:  'analyze_dependencies accepts an export: scope and returns impact for that symbol'
    fail_if: 'an export: scope is rejected while export-symbol nodes exist'
    na_if:   repo has no indexed export symbols
    severity: fail
  - id: package-boundaries
    assert:  mode:"package-boundaries" returns a boundary graph or a valid empty result with emptyDiagnostic
    fail_if: the call crashes or schema-errors
    na_if:   repo has a single package (no cross-package boundaries)
    severity: warn
  - id: depth-respected
    assert:  the depth argument changes the impact traversal radius
    fail_if: depth has no effect on a multi-hop dependency graph
    na_if:   dependency graph is single-hop around the chosen scope
    severity: warn
  - id: shared-type-contracts
    assert:  impact/boundary output surfaces shared types / imports crossing package edges
    fail_if: never FAIL — note as a coverage gap if cross-package shared types are clearly present but absent from output
    na_if:   no shared types cross package boundaries
    severity: warn
---

You are a read-only repovine MCP dependency-analysis agent. Verify impact analysis on mod:/export:
scopes and package-boundary projection, with post-refactor id prefixes.

Honor the shared preamble in `_PREAMBLE.md`. Session id e.g. `deps-YYYY-MM-DD-<repo-slug>`. Discover
a representative shared module and (if present) an export symbol; do not hardcode ids.

## Steps

1. **Discover anchors.**
   `search_context({ query: "shared util types index export", limit: 15, contextSessionId })` and
   `map_context({ scope: "all", view: "summary", limit: 20, contextSessionId })`. Record a `mod:`
   used by several importers and, when present, an `export:`.

2. **Impact** → `impact-scope`, `export-scope-accepted`, `depth-respected`.
   `analyze_dependencies({ scope: "<mod>", mode: "impact", depth: 2, contextSessionId })`, then
   `analyze_dependencies({ scope: "<export>", mode: "impact", contextSessionId })` when an export
   exists. Re-run impact with a different `depth` to confirm the radius changes. Verify ids are
   `mod:`/`export:`/`pkg:`, never `cap:`.

3. **Boundaries** → `package-boundaries`, `shared-type-contracts`.
   `analyze_dependencies({ scope: "all", mode: "package-boundaries", contextSessionId })`. A valid
   empty result with `emptyDiagnostic` is PASS for a single-package repo. Note shared types crossing
   package edges if present.

## Quick mode

Steps 1 and 2 (`impact-scope`, `export-scope-accepted`).

## Report format

- **Overall**: PASS / WARN / FAIL (`rollup: worst-of`).
- **Tested repo**: root, branch, short commit, `contextSessionId`.
- **Anchors**: the mod/export/pkg ids used.
- **Check matrix** (one row per `checks[]` id) with evidence (scope, sample ids, counts).
- **Findings** by severity; **MCP calls made**; **context quality**; **INFO** notes.
