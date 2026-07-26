---
id: build-and-sync-health
title: Build, refresh, and domains-suggestion sync contract
mode: read-only
repo_agnostic: true
applies_when: always
budget: { tool_calls: 8, mode: full }   # quick subset: build-status-callable, refresh-sync, no-mutation-guard
rollup: worst-of
checks:
  - id: build-status-callable
    assert:  get_build_status returns a status (ready or building) with the documented fields; waitSec long-poll returns when the build settles
    fail_if: the call errors, hangs past waitSec without returning, or omits status/stage/pct fields while building
    severity: fail
  - id: building-state-shape
    assert:  while building, responses are a SUCCESSFUL payload with status:"building" plus stage/remaining_stages, stage_eta_sec when the current stage has measurable progress, retry_after_sec, and pct when available (not an error)
    fail_if: a building response is returned as an MCP error, labels stage_eta_sec as time-until-ready, or lacks stage/remaining_stages/retry_after_sec
    na_if:   graph is already warm — building state is never observed this run
    severity: warn
  - id: refresh-sync
    assert:  refresh_context returns without error and reports graph deltas, searchTokens, and a compact semanticSearch status
    fail_if: refresh_context errors, returns a schema error, or omits the delta/token sync fields
    severity: fail
  - id: domains-suggestions-surfaced
    assert:  when domainsSuggestions.count > 0, suggest_domains_config returns the merged preview and the agent REPORTS additions only
    fail_if: suggest_domains_config errors when count > 0, OR the agent applies/declines suggestions
    na_if:   domainsSuggestions.count == 0
    severity: fail
  - id: no-mutation-guard
    assert:  the run mutates nothing — no cleanupOrphans, no domains apply/decline, no annotation writes
    fail_if: 'refresh_context({ cleanupOrphans: true }) or any state-mutating call is made without explicit authorization'
    severity: fail
  - id: orphans-reported
    assert:  refresh_context reports annotation orphan counts (reporting only)
    fail_if: orphans are acted on (cleaned) rather than reported
    na_if:   no annotations exist in the repo
    severity: warn
---

You are a read-only repovine MCP build/sync-health agent. Verify the build-status long-poll
contract, the refresh sync barrier, and that domains suggestions are surfaced-not-applied.

Honor the shared preamble in `_PREAMBLE.md`. Session id e.g. `build-sync-YYYY-MM-DD-<repo-slug>`.

## Steps

1. **Build status** → `build-status-callable`, `building-state-shape`.
   `get_build_status({ waitSec: 45, contextSessionId })`. If a prior tool returned `status:"building"`,
   confirm it was a success payload with `stage`/`remaining_stages`/`retry_after_sec` plus stage-local `stage_eta_sec`/`pct` when available, and that the long-poll
   returned when the build settled — do not tight-loop.

2. **Refresh barrier** → `refresh-sync`, `orphans-reported`.
   `refresh_context({ contextSessionId })`. Record presence of graph deltas, `searchTokens`,
   compact `semanticSearch` (`status`/`embedded`/`total`), and any orphan counts.

3. **Domains advisor** → `domains-suggestions-surfaced`, `no-mutation-guard`.
   If `refresh_context` / `get_build_status` reports `domainsSuggestions.count > 0`, call
   `suggest_domains_config({ contextSessionId })`, list the visible additions, and STOP — do not
   write `repovine.domains.json`, do not `decline_advisory({ "kind": "domains-config" })`. Confirm no
   `cleanupOrphans` was used anywhere.

## Quick mode

Steps 1 and 2 only (`build-status-callable`, `refresh-sync`, `no-mutation-guard`).

## Report format

- **Overall**: PASS / WARN / FAIL (apply `rollup: worst-of`).
- **Tested repo**: root, branch, short commit, `contextSessionId`.
- **Sync summary**: build status seen, graph deltas, searchTokens count, semanticSearch status,
  orphan count, `domainsSuggestions.count`.
- **Check matrix** (one row per `checks[]` id) with evidence.
- **Findings** first by severity (check id, Expected, Actual, Impact).
- **MCP calls made**; **context quality** summary; **INFO** notes.
