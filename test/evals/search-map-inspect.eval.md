---
id: search-map-inspect
title: Orient / map / inspect core navigation
mode: read-only
repo_agnostic: true
applies_when: always
budget: { tool_calls: 14, mode: full }   # quick subset: search-anchor-found, absent-package-clean, inspect-no-body
rollup: worst-of
checks:
  - id: search-anchor-found
    assert:  search_context returns relevant hits for a real symbol/package/route present in the repo
    fail_if: a clearly-present anchor returns zero hits, or the call errors
    severity: fail
  - id: search-relax
    assert:  a multi-token query auto-relaxes exact-AND to bounded-OR when needed; strategy.semantic.used and semanticRank/semanticScore are visible on hits
    fail_if: a multi-token query returns empty while each token individually matches, with no relaxation
    na_if:   local embeddings/semantic index not enabled in this repo
    severity: warn
  - id: absent-package-clean
    assert:  a deliberately-absent query (gibberish or all-unknown strong tokens, e.g. "qxqzwx qyqywy") returns totalResults:0 with emptyDiagnostic (no_token_hits or weak_token_only_suppressed)
    fail_if: the absent query crashes, errors, or returns confidently false hits as canonical
    severity: fail
  - id: absent-weak-token-or
    assert:  an absent anchor plus a weak token (e.g. "missinganchor route") under match:auto may OR-relax with hits but no emptyDiagnostic — expect strategy.relaxedFrom and low confidence or weak_token_only_suppressed when suppressed
    fail_if: treated as a strong canonical anchor without checking strategy/gaps
    severity: warn
  - id: map-summary-then-modules
    assert:  map_context view:"summary" gives a scoped overview; view:"modules" with limit/offset paginates the same scope
    fail_if: map_context errors on a discovered scope, or summary/modules disagree on the scope's existence
    severity: warn
  - id: map-pagination-stable
    assert:  paging modules via limit/offset yields disjoint pages with no dropped or duplicated nodes across offsets
    fail_if: nodes overlap between consecutive pages, or some nodes never appear across full pagination
    na_if:   scope has fewer modules than one page
    severity: warn
  - id: inspect-no-body
    assert:  'inspect_node on a discovered mod: resolves (summary/kind/exports) WITHOUT requesting body'
    fail_if: a module node cannot resolve without includeBody, or returns a schema error
    severity: fail
  - id: inspect-export-paging
    assert:  a large export list pages via exportLimit/exportOffset
    fail_if: export paging is ignored (full list dumped) or drops exports across pages
    na_if:   no module in scope has a large export list
    severity: warn
---

You are a read-only repovine MCP navigation agent. Verify search relevance/relaxation, map
pagination, and inspect-without-body across the orient → map → inspect path.

Honor the shared preamble in `_PREAMBLE.md`. Session id e.g. `search-map-YYYY-MM-DD-<repo-slug>`.

## Steps

1. **Search anchors** → `search-anchor-found`, `search-relax`.
   `search_context({ query: "<one strong symbol/package present in repo>", limit: 15, contextSessionId })`
   then a multi-token query like `search_context({ query: "config route handler", limit: 15, contextSessionId })`.
   Record `strategy.semantic.used` and `semanticRank`/`semanticScore` on hits.

2. **Absent query** → `absent-package-clean`, `absent-weak-token-or`.
   Use gibberish or all-unknown strong tokens (e.g. `"qxqzwx qyqywy"`) — expect `totalResults: 0`
   with `emptyDiagnostic` (`no_token_hits` or `weak_token_only_suppressed`). Separately try
   `"missinganchor route"` under default `match: auto`: OR-relax may return weak hits without
   `emptyDiagnostic` — PASS/WARN (not FAIL) when `strategy.relaxedFrom: "and"` and you do not
   treat them as canonical anchors.

3. **Map** → `map-summary-then-modules`, `map-pagination-stable`.
   `map_context({ scope: "<discovered pkg/domain>", view: "summary", limit: 10, contextSessionId })`,
   then `view: "modules"` with `limit`/`offset` across at least two pages; confirm pages are disjoint
   and total coverage is complete.

4. **Inspect** → `inspect-no-body`, `inspect-export-paging`.
   `inspect_node({ nodeId: "<discovered-mod>", contextSessionId })` with no body. For a module with
   many exports, page via `exportLimit`/`exportOffset`. Optionally one bounded
   `includeBody: true, bodyLimit: 8000` or `grepBody` to confirm bounded body works.

## Quick mode

Steps 1 (anchor only), 2 (`absent-package-clean` + optional `absent-weak-token-or`), 4 (`search-anchor-found`, `absent-package-clean`, `inspect-no-body`).

## Report format

- **Overall**: PASS / WARN / FAIL (`rollup: worst-of`).
- **Tested repo**: root, branch, short commit, `contextSessionId`.
- **Anchors discovered**: the mod/pkg/domain ids used.
- **Check matrix** (one row per `checks[]` id) with evidence (query, `result.total`, sample ids).
- **Findings** by severity; **MCP calls made**; **context quality**; **INFO** notes.
