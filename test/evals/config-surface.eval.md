---
id: config-surface
title: Config surface exposure and secret-value safety
mode: read-only
repo_agnostic: true
applies_when: always
budget: { tool_calls: 8, mode: full }   # quick subset: config-callable, no-secret-values
rollup: worst-of
checks:
  - id: config-callable
    assert:  get_config_surface({ kind:"all" }) returns config items grouped by kind (env / secret / public-config / resource-binding)
    fail_if: the call errors or returns a schema error
    severity: fail
  - id: no-secret-values
    assert:  output exposes env/secret NAMES only — never concrete secret values
    fail_if: any literal secret value (key, token, password, connection string with credentials) appears in the response
    severity: fail
  - id: kinds-filter
    assert:  get_config_surface({ kinds:["secret","resource","resource-binding","public-config"] }) honors the filter
    fail_if: the kinds filter is ignored or an unknown-kind error is thrown for documented kinds
    severity: warn
  - id: public-vs-secret-classification
    assert:  public-config is classified separately from secret (a secret is not mislabeled public, and vice versa)
    fail_if: a clearly-secret env name is classified as public-config (or the reverse) in a way that would leak intent
    na_if:   repo declares no public-config or no secrets
    severity: warn
  - id: resource-binding
    assert:  resource-binding entries appear where infra/runtime resources exist
    fail_if: never FAIL — note a coverage gap if bindings are clearly present in IaC but absent from output
    na_if:   repo has no IaC/runtime resources
    severity: warn
---

You are a read-only repovine MCP config-surface agent. Verify the config surface is enumerated and
that **secret values are never exposed** — names only.

Honor the shared preamble in `_PREAMBLE.md`. Session id e.g. `config-YYYY-MM-DD-<repo-slug>`.
`no-secret-values` is the headline security invariant: any literal secret value in MCP output is a
hard FAIL. The engine records env var NAMES, not values, by design.

## Steps

1. **All config** → `config-callable`, `no-secret-values`.
   `get_config_surface({ kind: "all", contextSessionId })`. Scan every returned item: confirm only
   names/identifiers and resource metadata appear, with no literal secret values. Quote the field
   shape (name-only) as evidence; do NOT quote any actual secret value even if one leaked — report
   its presence and location instead.

2. **Kind filters** → `kinds-filter`, `public-vs-secret-classification`, `resource-binding`.
   `get_config_surface({ kinds: ["secret","resource","resource-binding","public-config"], contextSessionId })`.
   Confirm the filter narrows results, that public vs secret classification is sane, and that
   resource bindings appear where IaC exists.

## Quick mode

Step 1 only (`config-callable`, `no-secret-values`).

## Report format

- **Overall**: PASS / WARN / FAIL (`rollup: worst-of`).
- **Tested repo**: root, branch, short commit, `contextSessionId`.
- **Config summary**: counts by kind (env/secret/public-config/resource-binding).
- **Secret-safety statement**: explicit confirmation that no literal secret values were returned
  (or a FAIL finding naming the leaking field — without reproducing the value).
- **Check matrix** (one row per `checks[]` id) with evidence.
- **Findings** by severity; **MCP calls made**; **context quality**; **INFO** notes.
