---
id: entrypoint-coverage
title: Entrypoint extraction and layer projection coverage
mode: read-only
repo_agnostic: true
applies_when: has_entrypoints   # backend API / frontend routes / CLI / scheduler surfaces
budget: { tool_calls: 14, mode: full }   # quick subset: entrypoints-callable, backend-api-typed OR frontend-page-typed, projection-vs-extraction-gap
rollup: worst-of
checks:
  - id: entrypoints-callable
    assert:  get_entrypoints({ kind:"all" }) returns a numeric result.total and structured result.items
    fail_if: the call errors, returns a schema error, or omits result.total
    severity: fail
  - id: backend-api-typed
    assert:  where a backend web framework exists, get_entrypoints({ kind:"api", layer:"backend" }) returns typed entries (e.g. source:"fastify-route", webFramework set)
    fail_if: backend route modules exist with route facts but the typed query returns total 0
    na_if:   no backend web framework (Fastify/Nest/FastAPI/Flask/Django) is present
    severity: warn
  - id: frontend-page-typed
    assert:  where a frontend route framework exists, get_entrypoints({ kinds:["page","route"], layer:"frontend" }) returns typed entries (e.g. source:"nextjs-app", fileType:"page")
    fail_if: frontend route/page modules exist but the typed query returns total 0
    na_if:   no frontend route framework (Next.js/React Router/TanStack Router/Angular/SvelteKit) is present
    severity: warn
  - id: cli-entrypoints
    assert:  where a CLI surface exists (argparse/click/Typer/console_scripts/commander), get_entrypoints({ kind:"cli" }) returns entries
    fail_if: a clear CLI command table exists but the CLI query returns total 0
    na_if:   no CLI framework / command table is present
    severity: warn
  - id: scope-filtered
    assert:  get_entrypoints({ scope:"pkg:<name>" }) narrows results to that package
    fail_if: a package scope is rejected or returns unrelated entries
    na_if:   no package scope with known routes was discovered
    severity: warn
  - id: projection-vs-extraction-gap
    assert:  a module with semanticHints.routes yields typed entrypoints; absence is diagnosed correctly
    fail_if: never FAIL here — report a layer/projection gap when routes facts exist but typed entries are 0, or a source-plugin extraction gap when routes facts are missing
    na_if:   no route/ui modules exist
    severity: warn
  - id: framework-native-reporting
    assert:  non-Next frontends are described in framework-native terms (React Router coverage, etc.)
    fail_if: a present non-Next frontend is reported as "missing Next.js pages"
    na_if:   the only frontend present is Next.js, or no frontend exists
    severity: warn
---

You are a read-only repovine MCP entrypoint-coverage agent. Verify that entrypoints are extracted
and projected per the frameworks actually present, with the evidence gate enforced.

Honor the shared preamble in `_PREAMBLE.md`. Session id e.g. `entrypoints-YYYY-MM-DD-<repo-slug>`.
**Stack-derive every expectation** — do not require a backend in a frontend-only repo, or Next.js
in a React Router repo. **Evidence gate is mandatory here**: for every `get_entrypoints` query
record the numeric `result.total` and 2–5 representative `result.items`; never summarize from
memory or from annotations.

## Steps

1. **Inventory frameworks.** From repo files + graph facts, list backend/frontend/CLI/scheduler
   frameworks present. Mark absent surfaces N/A up front.

2. **All entrypoints** → `entrypoints-callable`.
   `get_entrypoints({ kind: "all", contextSessionId })`. Record `result.total` + samples.

3. **Backend** → `backend-api-typed`. If a backend framework is present,
   `get_entrypoints({ kind: "api", layer: "backend", contextSessionId })`. Fastify-style
   `fastify.get/post/...` → entries with `source:"fastify-route"`, `webFramework:"fastify"` is PASS.

4. **Frontend** → `frontend-page-typed`, `framework-native-reporting`. If a frontend route
   framework is present, `get_entrypoints({ kinds: ["page","route"], layer: "frontend", contextSessionId })`.
   Next.js `app/**/page.tsx` → `source:"nextjs-app"`, `fileType:"page"` is PASS. Report non-Next
   frameworks in their own terms.

5. **CLI / scope** → `cli-entrypoints`, `scope-filtered`. If CLI present,
   `get_entrypoints({ kind: "cli", contextSessionId })`. For a package with known routes,
   `get_entrypoints({ scope: "pkg:<name>", contextSessionId })`.

6. **Gap diagnosis** → `projection-vs-extraction-gap`. Inspect one representative route module.
   If it has `semanticHints.routes` but typed entries are 0 → **layer/projection gap** (WARN). If
   `semanticHints.routes` is missing → **source-plugin extraction gap** (WARN). If a standalone
   build was just run outside the MCP server, `refresh_context({ contextSessionId })` first.

## Quick mode

Steps 1, 2, plus the one of 3/4 matching the repo's primary stack, plus 6.

## Report format

- **Overall**: PASS / WARN / FAIL (`rollup: worst-of`).
- **Tested repo**: root, branch, short commit, `contextSessionId`.
- **Framework inventory**: which surfaces present, which N/A.
- **Check matrix** (one row per `checks[]` id). For every entrypoint check include the exact
  `result.total` and one representative item when `total > 0` (a non-zero typed total is evidence
  against a "typed entrypoints do not emit" finding).
- **Findings** by severity, each tagged repovine-gap / target-repo-limitation / N/A.
- **MCP calls made**; **context quality**; **INFO** notes (e.g. the `layer` filter name — a current API choice).
