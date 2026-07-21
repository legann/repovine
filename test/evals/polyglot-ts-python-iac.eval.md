---
id: polyglot-ts-python-iac
title: Polyglot coherence — TS frontend + Python backend + IaC (one graph)
mode: read-only
repo_agnostic: true
applies_when: has_polyglot_ts_python   # repo has BOTH a first-party TS surface AND a first-party Python surface; if either is absent the whole card is N/A
budget: { tool_calls: 16, mode: full }   # quick subset: both-ecosystems-in-one-graph, one of frontend/backend typed, cross-language-boundary-sound
rollup: worst-of
checks:
  - id: both-ecosystems-in-one-graph
    assert:  the single graph contains first-party modules from BOTH the TS surface and the Python surface, each discovered on its own marker (package.json/tsconfig vs pyproject.toml/setup.py) with no cross-language anchor required
    fail_if: one of the two on-disk first-party surfaces (TS or Python) is entirely absent from the graph
    na_if:   the repo does not contain both a first-party TS surface and a first-party Python surface (whole card N/A)
    severity: fail
  - id: frontend-surface-typed
    assert:  the TS frontend's routes/pages/components are extracted and reported in the framework's own terms (React Router / Next.js / Vue / SvelteKit / Angular / …)
    fail_if: TS frontend route/page/component modules exist but yield no typed frontend entrypoints or UI surface at all
    na_if:   no TS frontend framework is present (e.g. the TS surface is backend/CLI/library only)
    severity: warn
  - id: backend-surface-typed
    assert:  the Python backend's routes are extracted as typed backend entrypoints in the framework's own terms (Django urlpatterns / DRF / FastAPI / Flask / …)
    fail_if: Python route modules carry route facts (semanticHints.routes) but the typed backend query returns total 0
    na_if:   no Python web framework is present (e.g. the Python surface is library/CLI/data only)
    severity: warn
  - id: iac-surface-and-link
    assert:  IaC files present (Terraform / SAM / Helm / K8s manifests / docker-compose) yield runtime-resource nodes; backend code is linked to runtime (infra / binds_to) where the IaC makes it ast-provable
    fail_if: IaC resource files exist on disk but produce zero runtime-resource nodes
    na_if:   no IaC is present (the runtime-link sub-claim is INFO when an IaC exists but the link is not statically provable)
    severity: warn
  - id: cross-language-boundary-sound
    assert:  the frontend↔backend relationship is represented via runtime-resource / domain / package-boundary, NOT via a fabricated cross-language code edge
    fail_if: an `imports` or `implements` edge is asserted directly between a TS module and a Python module
    severity: fail
  - id: framework-agnostic-na-discipline
    assert:  every coverage expectation is derived from the frameworks actually present; absent specific frameworks are N/A, not failures
    fail_if: a coverage failure is asserted for a specific framework the repo does not use (e.g. "missing Next.js pages" against a React Router app, "missing FastAPI" against a Django app), OR a Python module is flagged for lacking TS-only frontend/JSX surfaces
    severity: warn
---

You are a read-only repovine MCP polyglot-coherence agent. Verify that a repo combining a **TS
frontend (any framework)**, a **Python backend (any framework)**, and **IaC (any provisioner)** is
represented as **one coherent graph** — both ecosystems discovered, each surface typed in its own
framework's terms, IaC linked where provable, and **no fabricated cross-language code edges**.

This card is the agnosticism contract **one level down**: not "any repo", but "any repo of the
shape *TS-front + Py-back + IaC*". Stay framework-agnostic *within* that shape — never require React
specifically, Django specifically, or Terraform specifically. The specific frameworks are discovered,
never assumed.

Honor the shared preamble in `_PREAMBLE.md` (read-only contract, one `contextSessionId`, build
readiness, discovery-not-assumption, evidence gate, concise-first, verdict taxonomy, rollup). Session
id e.g. `polyglot-YYYY-MM-DD-<repo-slug>`.

**Applicability gate.** This card applies only when the repo has **both** a first-party TS surface
**and** a first-party Python surface. If either is absent, the entire card is **N/A** (this is the
common case — most repos are single-ecosystem; that is normal, not a failure). IaC is a *sub-surface*:
its checks are N/A when no IaC exists, but the card still applies on the TS+Python pair alone.

## Steps

1. **Inventory the polyglot shape** → applicability gate, `framework-agnostic-na-discipline`.
   From repo files + graph facts, identify: the TS surface (which frontend framework, if any) and its
   package marker; the Python surface (which web framework, if any) and its marker; any IaC files and
   their provisioner. Exclude vendor/build/cache dirs (`node_modules`, `dist`/`build`, `.repovine`,
   dependency caches). If both TS and Python first-party surfaces are not present, stop and report the
   whole card **N/A**. State the discovered frameworks; every later expectation must be derived from
   this inventory — do not import expectations for frameworks the repo does not use.

2. **Both ecosystems in one graph** → `both-ecosystems-in-one-graph`.
   Via `map_context` / `search_context`, record at least one first-party `mod:`/`pkg:` from the **TS**
   surface and at least one from the **Python** surface, with their distinct package markers. Evidence
   gate: cite the exact node ids and the package each belongs to. A FAIL is only when an on-disk
   first-party surface is wholly missing from the graph (not a sparse-coverage WARN).

3. **Frontend surface** → `frontend-surface-typed`, `framework-agnostic-na-discipline`.
   If a TS frontend framework is present, query its routes/pages/components
   (`get_entrypoints({ kinds:["page","route"], layer:"frontend", contextSessionId })` and/or inspect a
   representative UI module). Report in the framework's own terms (React Router coverage, SvelteKit
   routes, …). Do not penalize a non-Next frontend for "missing Next.js".

4. **Backend surface** → `backend-surface-typed`, `framework-agnostic-na-discipline`.
   If a Python web framework is present,
   `get_entrypoints({ kind:"api", layer:"backend", contextSessionId })`. Django `urlpatterns` / DRF
   routers / FastAPI decorators / Flask routes → typed backend entries is PASS. If a route module has
   `semanticHints.routes` but typed entries are 0 → layer/projection gap (WARN, repovine-gap); if the
   route facts are missing entirely → source-plugin extraction gap (WARN). Record `result.total` + 2–5
   `result.items` for every query.

5. **IaC surface and runtime link** → `iac-surface-and-link`.
   If IaC is present, confirm `runtime-resource` nodes exist (`map_context` for `resource:`/`infra:`,
   or `get_config_surface`). Where the IaC makes a backend↔runtime mapping ast-provable, verify the
   `infra` / `binds_to` edge from the backend module to the resource; where it is not provable, note
   it INFO. If IaC files exist on disk but zero runtime-resource nodes are produced → WARN
   (repovine-gap). No IaC → N/A.

6. **Cross-language boundary soundness** → `cross-language-boundary-sound`.
   Inspect the boundary between the TS and Python packages (`analyze_dependencies` on a TS package,
   then on the Python package). Confirm the frontend↔backend relationship is expressed via
   runtime-resource / domain / package boundary — **not** a direct `imports` or `implements` edge from
   a TS module to a Python module. Any such fabricated cross-language code edge is a **FAIL**
   (soundness / language-identity leak). As an INFO positive signal, note whether any `domain` tags
   modules from **both** languages (genuine cross-language grouping).

## Quick mode

Steps 1, 2, the one of 3/4 matching the repo's primary surface, and 6
(`both-ecosystems-in-one-graph`, one typed surface, `cross-language-boundary-sound`). Still
discovery-driven; still N/A for absent surfaces.

## Report format

- **Overall**: PASS / WARN / FAIL (`rollup: worst-of`).
- **Tested repo**: root, branch, short commit, `contextSessionId`.
- **Polyglot inventory**: TS frontend framework (+ marker), Python backend framework (+ marker), IaC
  provisioner; excluded vendor/build dirs. State the applicability verdict (applies vs whole-card N/A).
- **Check matrix** (one row per `checks[]` id) with evidence — for every entrypoint/resource query
  include the exact `result.total` and one representative item when `total > 0`.
- **Findings** by severity, each tagged repovine-gap / target-repo-limitation / N/A.
- **Cross-language signal**: whether any domain or runtime-resource genuinely spans both languages
  (the polyglot-value observation), reported as INFO.
- **MCP calls made**; **context quality** summary for the shared `contextSessionId`; **INFO** notes.
