---
id: trace-flow-topology
title: Runtime flow tracing and topology projection
mode: read-only
repo_agnostic: true
applies_when: has_runtime_graph   # IaC / runtime-resource / service topology present
budget: { tool_calls: 10, mode: full }   # quick subset: trace-resource-scope, include-slots
rollup: worst-of
checks:
  - id: trace-resource-scope
    assert:  trace_flow accepts a discovered resource:/service or runtime package anchor and returns structured topology
    fail_if: 'a resource: scope is rejected while runtime-resource nodes demonstrably exist, or the call errors'
    na_if:   repo has no IaC/runtime/service nodes (library-only)
    severity: fail
  - id: include-slots
    assert:  include:["entrypoints","services","resources","flows"] filters the projection to the requested slots
    fail_if: include filters are ignored or an unknown-slot error is thrown for documented slots
    na_if:   no runtime anchor was discovered
    severity: warn
  - id: entrypoint-cross-link
    assert:  'trace_flow output references mod:/entrypoint:/resource: ids consistent with get_entrypoints for the same anchor'
    fail_if: trace_flow references ids that do not resolve via inspect_node
    na_if:   no runtime anchor was discovered
    severity: warn
  - id: library-only-na
    assert:  on a library-only repo, trace_flow returns an empty/N/A topology cleanly
    fail_if: trace_flow crashes or schema-errors on a repo with no runtime graph
    na_if:   repo has a runtime graph (this check only applies to library-only repos)
    severity: warn
---

You are a read-only repovine MCP flow-tracing agent. Verify runtime topology projection from a
discovered resource/service anchor, and clean N/A behavior on library-only repos.

Honor the shared preamble in `_PREAMBLE.md`. Session id e.g. `trace-flow-YYYY-MM-DD-<repo-slug>`.
Resolve a real runtime anchor first via search/map; do not hardcode `resource:aws-lambda:...`.

## Steps

1. **Find a runtime anchor.**
   `search_context({ query: "runtime resource infra lambda service deployment queue", limit: 15, contextSessionId })`
   and `map_context({ scope: "all", view: "summary", limit: 20, contextSessionId })`. Record the
   first real `resource:` / service / runtime package. If none exists, the repo is library-only →
   jump to step 4.

2. **Trace** → `trace-resource-scope`, `include-slots`.
   `trace_flow({ scope: "<anchor>", include: ["entrypoints","services","resources","flows"], contextSessionId })`.
   Re-run with a narrower `include` to confirm it is honored.

3. **Cross-link** → `entrypoint-cross-link`.
   `get_entrypoints({ scope: "<anchor or its package>", contextSessionId })`; confirm trace_flow ids
   resolve via `inspect_node`.

4. **Library-only path** → `library-only-na`.
   If no runtime graph exists, run one `trace_flow({ scope: "<a discovered mod/pkg>", contextSessionId })`
   and confirm it returns empty/N/A cleanly rather than crashing.

## Quick mode

Steps 1 and 2 (`trace-resource-scope`, `include-slots`), or step 4 if library-only.

## Report format

- **Overall**: PASS / WARN / FAIL (`rollup: worst-of`).
- **Tested repo**: root, branch, short commit, `contextSessionId`.
- **Runtime anchor** used (or "library-only, no runtime graph").
- **Topology summary**: counts of entrypoints/services/resources/flows returned.
- **Check matrix** (one row per `checks[]` id) with evidence.
- **Findings** by severity; **MCP calls made**; **context quality**; **INFO** notes (e.g. the
  `services`/`resources` projection keys — current by-design output, not a rename).
