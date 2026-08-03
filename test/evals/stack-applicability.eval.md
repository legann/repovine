---
id: stack-applicability
title: Stack inventory and N/A discipline (meta)
mode: read-only
repo_agnostic: true
applies_when: always
budget: { tool_calls: 10, mode: full }   # quick subset: inventory-first, absent-surface-na, vendor-excluded
rollup: worst-of
checks:
  - id: inventory-first
    assert:  the agent inventories languages/frameworks/source roots before judging any coverage
    fail_if: a coverage expectation is asserted for a stack the repo does not contain (e.g. requiring a TS/web surface in a Python-only repo)
    severity: fail
  - id: absent-surface-na
    assert:  surfaces absent from the repo's stack are marked N/A, not WARN/FAIL
    fail_if: an absent language/framework/surface is reported as a failure
    severity: warn
  - id: multi-language-sampled
    assert:  for each present language (TS/JS, Python, Rust, Java), at least one representative module is inspected; absent languages are N/A
    fail_if: a present first-party language is entirely unrepresented in the graph with no finding, OR an absent language is asserted as missing coverage
    severity: warn
  - id: vendor-excluded
    assert:  vendor/build/cache dirs (.git, .repovine, node_modules, dist/build, dependency caches) are excluded from "missing coverage" findings
    fail_if: a vendored/generated/ignored dir is flagged as a first-party coverage gap
    severity: warn
  - id: first-party-gap-qualified
    assert:  a present-on-disk but absent-from-graph source root is reported as a coverage finding only after verifying it is first-party source
    fail_if: never FAIL — note when a source root is unverified (could be vendored/generated/example)
    na_if:   no present-on-disk source root is missing from the graph
    severity: warn
---

You are a read-only repovine MCP stack-applicability agent. Verify the inventory-first / N/A
discipline: every coverage expectation must be stack-derived, and absent surfaces are N/A, not
failures. This meta-card guards the audit methodology itself across mixed-language repos.

Honor the shared preamble in `_PREAMBLE.md`. Session id e.g. `stack-YYYY-MM-DD-<repo-slug>`.

## Steps

1. **Inventory** → `inventory-first`, `vendor-excluded`.
   From repo files + graph facts, count source files by language and identify major frameworks and
   first-party source roots. Exclude `.git`, `.repovine`, `node_modules`, `dist`/`build` outputs,
   and dependency caches. State the inventory before any coverage judgment.

2. **Per-language sampling** → `multi-language-sampled`, `absent-surface-na`.
   For each present language, `inspect_node` at least one representative module
   (TS/JS, Python, Rust, Java). Mark absent languages N/A. Do not require a TS/web surface in
   a Python-only repo, or Python/FastAPI in a TS-only repo.

3. **First-party gap qualification** → `first-party-gap-qualified`.
   If a source root is on disk but absent from the graph, verify it is first-party (not vendored,
   generated, or an example) before reporting it as a coverage gap; otherwise note it as
   unverified.

## Quick mode

Steps 1 and 2 (`inventory-first`, `absent-surface-na`, `vendor-excluded`).

## Report format

- **Overall**: PASS / WARN / FAIL (`rollup: worst-of`).
- **Tested repo**: root, branch, short commit, `contextSessionId`.
- **Stack inventory**: languages + file counts, frameworks, first-party source roots, excluded
  vendor/build dirs.
- **Check matrix** (one row per `checks[]` id) with evidence.
- **N/A list**: every surface marked N/A and why.
- **Findings** by severity, each tagged repovine-gap / target-repo-limitation / N/A.
- **MCP calls made**; **context quality**; **INFO** notes.
